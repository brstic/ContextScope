import type { ContextSegment, Finding, SegmentKind } from '@contextscope/shared';
import type { Pricing } from '@contextscope/pricing';
import {
  ANTHROPIC_DEFAULT_CACHE_TTL_MS,
  CONTEXT_GROWTH_FACTOR,
  CONTEXT_GROWTH_MIN_TURNS,
  CONTEXT_GROWTH_TURN_JUMP_TOKENS,
  EXPENSIVE_MODEL_MAX_INPUT_TOKENS,
  EXPENSIVE_MODEL_MAX_OUTPUT_TOKENS,
  EXPENSIVE_MODEL_MIN_OCCURRENCES,
  EXPENSIVE_MODEL_OUTPUT_PER_MTOK,
  LOW_CACHE_REUSE_MAX_REPORTED_READ_SHARE,
  LOW_CACHE_REUSE_MIN_IDENTICAL_PREFIX,
  LOW_CACHE_REUSE_MIN_REQUESTS,
  PREFIX_SENSITIVE_KINDS,
  REPEATED_LARGE_INPUT_MIN_REQUESTS,
  REPEATED_LARGE_INPUT_TOKENS,
  REPEATED_RETRIEVAL_MIN_REQUESTS,
  REPEATED_TOOL_SCHEMA_MIN_REQUESTS,
  REPEATED_TOOL_SCHEMA_MIN_TOKENS,
  TOKEN_SPIKE_FACTOR,
  TOKEN_SPIKE_MIN_SAMPLES,
  TOKEN_SPIKE_MIN_TOKENS,
} from './constants.js';
import { fmt, makeFinding, pct } from './finding.js';
import { chronological, comparePrefix, contextGrowth, groupRequests, sumEstimated } from './prefix.js';
import type { AnalyzableRequest, AnalyzerLimits } from './types.js';

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const sessionOf = (reqs: readonly AnalyzableRequest[]): string | null => {
  const ids = new Set(reqs.map((r) => r.sessionId));
  return ids.size === 1 ? (reqs[0]?.sessionId ?? null) : null;
};

const providerOf = (reqs: readonly AnalyzableRequest[]): AnalyzableRequest['provider'] | null => {
  const ps = new Set(reqs.map((r) => r.provider));
  return ps.size === 1 ? (reqs[0]?.provider ?? null) : null;
};

interface Occurrence {
  req: AnalyzableRequest;
  seg: ContextSegment;
}

/** exact fingerprint → occurrences, at most one per request, for segments matching `pick`. */
const occurrencesByFingerprint = (
  history: readonly AnalyzableRequest[],
  pick: (s: ContextSegment) => boolean,
): Map<string, Occurrence[]> => {
  const m = new Map<string, Occurrence[]>();
  for (const req of history) {
    const seen = new Set<string>();
    for (const seg of req.segments) {
      if (!pick(seg) || seen.has(seg.exactFingerprint)) continue;
      seen.add(seg.exactFingerprint);
      const list = m.get(seg.exactFingerprint);
      if (list) list.push({ req, seg });
      else m.set(seg.exactFingerprint, [{ req, seg }]);
    }
  }
  return m;
};

const isAutomaticCacheOption = (opts: Record<string, string>): boolean =>
  Object.keys(opts).some((k) => /cache_control|automatic/i.test(k));

/** Cross-request findings over a bounded, chronological history window. */
export const analyzeHistory = (
  input: readonly AnalyzableRequest[],
  now: number,
  limits: AnalyzerLimits,
  pricing: Pricing | null,
): Finding[] => {
  const history = chronological(input)
    .slice(-limits.maxHistory)
    .map((r) => (r.segments.length > limits.maxSegments ? { ...r, segments: r.segments.slice(0, limits.maxSegments) } : r));
  const out: Finding[] = [];

  // --- repeated tool schemas (content-based, whole window) -----------------------------
  for (const [fp, occ] of occurrencesByFingerprint(history, (s) => s.kind === 'tool_definition')) {
    const seg = (occ[0] as Occurrence).seg;
    if (occ.length < REPEATED_TOOL_SCHEMA_MIN_REQUESTS || (seg.estimatedTokens ?? 0) < REPEATED_TOOL_SCHEMA_MIN_TOKENS) continue;
    const reqs = occ.map((o) => o.req);
    out.push(
      makeFinding(
        {
          type: 'oversized_tool_schemas',
          scope: `history:tool:${fp}`,
          title: `Tool "${seg.label}" (~${fmt(seg.estimatedTokens ?? 0)} tokens, estimated) is resent on every request`,
          severity: occ.length >= 20 ? 'medium' : 'low',
          confidence: 'medium',
          description: 'A large tool definition is identical across many captured requests and is billed as input each time unless it is served from the prompt cache.',
          evidence: [
            `The same normalized tool schema appears in ${occ.length} captured requests`,
            `Estimated size: ${fmt(seg.estimatedTokens ?? 0)} tokens per request (estimated)`,
          ],
          recommendation: 'Keep tool definitions first and byte-identical so they form a cacheable prefix, send only tools the step needs, and shorten long descriptions.',
          tradeoff: 'Dropping or shortening tools can reduce tool-calling accuracy or remove capabilities.',
          affects: 'both',
          requestIds: reqs.map((r) => r.id),
          segmentIndexes: occ.map((o) => o.seg.index),
          provider: providerOf(reqs),
          sessionId: sessionOf(reqs),
        },
        now,
      ),
    );
  }

  // --- repeated retrieval payload ---------------------------------------------------------
  for (const [fp, occ] of occurrencesByFingerprint(history, (s) => s.kind === 'document')) {
    if (occ.length < REPEATED_RETRIEVAL_MIN_REQUESTS) continue;
    const seg = (occ[0] as Occurrence).seg;
    const reqs = occ.map((o) => o.req);
    out.push(
      makeFinding(
        {
          type: 'repeated_retrieval_payload',
          scope: `history:document:${fp}`,
          title: `The same document is sent in ${occ.length} requests`,
          severity: (seg.estimatedTokens ?? 0) >= REPEATED_LARGE_INPUT_TOKENS ? 'medium' : 'low',
          confidence: 'high',
          description: 'An identical retrieved document (exact fingerprint) is included in several requests.',
          evidence: [
            `Document "${seg.label}" (fingerprint ${fp.slice(0, 12)}…) appears in ${occ.length} captured requests`,
            `Estimated size: ${seg.estimatedTokens === null ? 'unavailable' : `${fmt(seg.estimatedTokens)} tokens (estimated)`} per request`,
          ],
          recommendation: 'Place stable documents early in the prompt so they can be served from the prompt cache, or skip re-retrieving chunks already in context.',
          tradeoff: 'Removing a document the model still needs lowers answer quality; moving it changes prompt order.',
          affects: 'both',
          requestIds: reqs.map((r) => r.id),
          segmentIndexes: occ.map((o) => o.seg.index),
          provider: providerOf(reqs),
          sessionId: sessionOf(reqs),
        },
        now,
      ),
    );
  }

  // --- repeated large (non-tool, non-document) input --------------------------------------
  const largeKinds = (k: SegmentKind): boolean => !['tool_definition', 'tool_call', 'tool_result', 'document'].includes(k);
  for (const [fp, occ] of occurrencesByFingerprint(
    history,
    (s) => largeKinds(s.kind) && (s.estimatedTokens ?? 0) >= REPEATED_LARGE_INPUT_TOKENS,
  )) {
    if (occ.length < REPEATED_LARGE_INPUT_MIN_REQUESTS) continue;
    const seg = (occ[0] as Occurrence).seg;
    const reqs = occ.map((o) => o.req);
    out.push(
      makeFinding(
        {
          type: 'repeated_large_input',
          scope: `history:large:${fp}`,
          title: `A large ${seg.kind} segment is repeated in ${occ.length} requests`,
          severity: 'low',
          confidence: 'high',
          description: 'The same large input segment (exact fingerprint) is resent across requests.',
          evidence: [
            `${seg.kind} "${seg.label}" (~${fmt(seg.estimatedTokens ?? 0)} tokens, estimated) appears in ${occ.length} captured requests`,
          ],
          recommendation: 'Keep it byte-identical at the start of the prompt so it can be cached, or reference it instead of resending it.',
          tradeoff: 'Restructuring the prompt can change model behaviour; verify quality.',
          affects: 'both',
          requestIds: reqs.map((r) => r.id),
          segmentIndexes: occ.map((o) => o.seg.index),
          provider: providerOf(reqs),
          sessionId: sessionOf(reqs),
        },
        now,
      ),
    );
  }

  // --- per-group rules -------------------------------------------------------------------
  for (const [key, group] of groupRequests(history)) {
    const provider = providerOf(group);
    const sessionId = sessionOf(group);

    // unstable_prefix
    const unstable: { prev: AnalyzableRequest; cur: AnalyzableRequest; idx: number; kind: string; label: string }[] = [];
    const reuse: { cur: AnalyzableRequest; ratio: number; gapMs: number }[] = [];
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1] as AnalyzableRequest;
      const cur = group[i] as AnalyzableRequest;
      const p = comparePrefix(prev.segments, cur.segments);
      const changedNotAppended = p.firstChangedSegmentIndex !== null && p.firstChangedSegmentIndex < prev.segments.length;
      if (changedNotAppended && (PREFIX_SENSITIVE_KINDS as readonly string[]).includes(p.firstChangedKind ?? '')) {
        unstable.push({ prev, cur, idx: p.firstChangedSegmentIndex as number, kind: p.firstChangedKind ?? '', label: p.firstChangedLabel ?? '' });
      }
      const curEst = sumEstimated(cur.segments);
      if (p.sharedEstimatedTokens !== null && curEst) {
        reuse.push({ cur, ratio: p.sharedEstimatedTokens / curEst, gapMs: cur.startedMs - prev.startedMs });
      }
    }
    if (unstable.length) {
      const kinds = [...new Set(unstable.map((u) => u.kind))];
      out.push(
        makeFinding(
          {
            type: 'unstable_prefix',
            scope: `group:${key}`,
            title: `The request prefix changed at ${kinds.join('/')} ${unstable.length} time${unstable.length > 1 ? 's' : ''}`,
            severity: unstable.length >= 3 ? 'medium' : 'low',
            confidence: 'medium',
            description:
              'Between consecutive requests the first difference is in tool definitions, system/developer instructions or a schema. ' +
              'Tool definition changes may reduce reusable prompt-prefix length. This is structural evidence, not proof of a provider cache miss.',
            evidence: unstable
              .slice(0, 5)
              .map((u) => `Request ${u.cur.id}: first changed segment #${u.idx} (${u.kind} "${u.label}") vs previous request ${u.prev.id}`),
            recommendation: 'Keep tools, system prompt and schemas byte-identical and in a fixed order; put changing content (dates, user data) after them.',
            tradeoff: 'Freezing the tool list or instructions may require sending tools that a step does not use.',
            affects: 'caching',
            requestIds: unstable.map((u) => u.cur.id),
            segmentIndexes: unstable.map((u) => u.idx),
            provider,
            sessionId,
          },
          now,
        ),
      );
    }

    // low_cache_reuse (reported usage only)
    const qualifying = reuse.filter(
      (r) =>
        r.ratio >= LOW_CACHE_REUSE_MIN_IDENTICAL_PREFIX &&
        r.cur.usage.source === 'reported' &&
        r.cur.usage.totalInputTokens !== null &&
        r.cur.usage.totalInputTokens > 0 &&
        r.cur.usage.cacheReadTokens !== null,
    );
    if (qualifying.length >= LOW_CACHE_REUSE_MIN_REQUESTS) {
      const totalIn = qualifying.reduce((n, r) => n + (r.cur.usage.totalInputTokens ?? 0), 0);
      const totalRead = qualifying.reduce((n, r) => n + (r.cur.usage.cacheReadTokens ?? 0), 0);
      const readShare = totalRead / totalIn;
      if (readShare < LOW_CACHE_REUSE_MAX_REPORTED_READ_SHARE) {
        const avgRatio = qualifying.reduce((n, r) => n + r.ratio, 0) / qualifying.length;
        const evidence = [
          `Reported cache reuse is low although ${pct(avgRatio)} of the prefix was identical (estimated, average over ${qualifying.length} requests)`,
          `Reported cache read: ${fmt(totalRead)} of ${fmt(totalIn)} input tokens (${pct(readShare)})`,
        ];
        let recommendation = 'Keep the identical prefix byte-stable and send requests within the cache lifetime.';
        if (provider === 'anthropic') {
          const noMarkers = qualifying.every(
            (r) => r.cur.features.cacheControlBlocks === 0 && !isAutomaticCacheOption(r.cur.features.cacheOptions),
          );
          if (noMarkers) {
            evidence.push('No cache_control blocks and no automatic caching option were seen in these requests');
            recommendation = 'Anthropic caches only with cache_control: add automatic caching (top-level cache_control) or a breakpoint after the stable prefix.';
          }
          const longGaps = qualifying.filter((r) => r.gapMs > ANTHROPIC_DEFAULT_CACHE_TTL_MS).length;
          if (longGaps) evidence.push(`${longGaps} of these requests came more than 5 minutes after the previous one (default cache TTL)`);
        } else if (provider === 'openai') {
          recommendation += ' OpenAI caches prefixes automatically from 1,024 tokens; a stable prompt_cache_key can improve routing to the cache.';
        } else if (provider === 'gemini') {
          recommendation += ' Gemini implicit caching is best-effort; use explicit context caching for large stable content.';
        }
        out.push(
          makeFinding(
            {
              type: 'low_cache_reuse',
              scope: `group:${key}`,
              title: 'Low reported cache reuse despite an identical prefix',
              severity: 'medium',
              confidence: 'medium',
              description:
                'Consecutive requests share most of their prompt prefix (by exact fingerprints), but the provider-reported cached input is low.',
              evidence,
              recommendation,
              tradeoff: 'Cache writes can cost more than plain input (e.g. Anthropic 1.25× for 5-minute writes); caching only pays off when the prefix is reused in time.',
              affects: 'caching',
              requestIds: qualifying.map((r) => r.cur.id),
              provider,
              sessionId,
            },
            now,
          ),
        );
      }
    }

    // excessive_context_growth
    const points = contextGrowth(group);
    const useReported = points.every((p) => p.reportedInputTokens !== null);
    const size = (p: (typeof points)[number]): number | null => (useReported ? p.reportedInputTokens : p.estimatedInputTokens);
    const first = points[0];
    const last = points[points.length - 1];
    const growthEv: string[] = [];
    if (first && last && points.length >= CONTEXT_GROWTH_MIN_TURNS) {
      const a = size(first);
      const b = size(last);
      if (a !== null && b !== null && a > 0 && b > CONTEXT_GROWTH_FACTOR * a) {
        growthEv.push(
          `Input grew from ${fmt(a)} to ${fmt(b)} tokens (${(b / a).toFixed(1)}×) over ${points.length} requests (${useReported ? 'reported' : 'estimated'})`,
        );
      }
    }
    const jumps = points.filter((p) => p.deltaTokens !== null && p.deltaTokens > CONTEXT_GROWTH_TURN_JUMP_TOKENS);
    for (const j of jumps.slice(0, 3)) {
      growthEv.push(`Request ${j.requestId} added ${fmt(j.deltaTokens ?? 0)} tokens in one turn (${j.deltaSource})`);
    }
    if (growthEv.length) {
      out.push(
        makeFinding(
          {
            type: 'excessive_context_growth',
            scope: `group:${key}`,
            title: 'Context grows quickly across turns',
            severity: jumps.length ? 'medium' : 'low',
            confidence: useReported ? 'high' : 'medium',
            description: 'The input size of this conversation grows fast; every turn re-sends the accumulated context.',
            evidence: growthEv,
            recommendation: 'Summarize or drop old turns and large tool outputs, or start a new conversation for a new task.',
            tradeoff: 'Trimming history can make the model forget earlier details.',
            affects: 'input_volume',
            requestIds: [...(first ? [first.requestId] : []), ...jumps.map((j) => j.requestId), ...(last ? [last.requestId] : [])],
            provider,
            sessionId,
            docsUrl: null,
          },
          now,
        ),
      );
    }

    // token_spike (reported)
    const reported = group.filter((r) => r.usage.source === 'reported' && r.usage.totalInputTokens !== null);
    if (reported.length >= TOKEN_SPIKE_MIN_SAMPLES) {
      const med = median(reported.map((r) => r.usage.totalInputTokens as number));
      for (const r of reported) {
        const t = r.usage.totalInputTokens as number;
        if (t > TOKEN_SPIKE_FACTOR * med && t > TOKEN_SPIKE_MIN_TOKENS) {
          out.push(
            makeFinding(
              {
                type: 'token_spike',
                scope: `request:${r.id}`,
                title: `Input spike: ${fmt(t)} tokens (${(t / med).toFixed(1)}× the median)`,
                severity: t > 10 * med ? 'medium' : 'low',
                confidence: 'high',
                description: 'This request used far more input than is typical for its session/model.',
                evidence: [`Reported input ${fmt(t)} tokens vs median ${fmt(med)} over ${reported.length} requests`],
                recommendation: 'Inspect the largest segments of this request (tool output, attachments, retrieved documents).',
                tradeoff: 'The large input may be necessary for the task.',
                affects: 'input_volume',
                requestIds: [r.id],
                provider: r.provider,
                sessionId: r.sessionId,
                docsUrl: null,
              },
              now,
            ),
          );
        }
      }
    }
  }

  // --- expensive model for tiny requests (per provider + model) --------------------------
  if (pricing) {
    const byModel = new Map<string, AnalyzableRequest[]>();
    for (const r of history) {
      if (r.model === null) continue;
      const k = `${r.provider}:${r.model}`;
      const g = byModel.get(k);
      if (g) g.push(r);
      else byModel.set(k, [r]);
    }
    for (const [k, reqs] of byModel) {
      const first = reqs[0] as AnalyzableRequest;
      const price = pricing.lookup(first.provider, first.model);
      if (!price || price.outputPerMTok < EXPENSIVE_MODEL_OUTPUT_PER_MTOK) continue;
      const small = reqs.filter(
        (r) =>
          r.usage.source === 'reported' &&
          r.usage.totalInputTokens !== null &&
          r.usage.outputTokens !== null &&
          r.usage.totalInputTokens < EXPENSIVE_MODEL_MAX_INPUT_TOKENS &&
          r.usage.outputTokens < EXPENSIVE_MODEL_MAX_OUTPUT_TOKENS,
      );
      if (small.length < EXPENSIVE_MODEL_MIN_OCCURRENCES) continue;
      out.push(
        makeFinding(
          {
            type: 'expensive_model_usage',
            scope: `model:${k.toLowerCase()}`,
            title: `${small.length} small requests on ${first.model}`,
            severity: 'info',
            confidence: 'low',
            description:
              'Many short requests use a model with a high list output price. A smaller model may be enough for such tasks; this cannot be judged from sizes alone.',
            evidence: [
              `${small.length} requests with reported input < ${EXPENSIVE_MODEL_MAX_INPUT_TOKENS} and output < ${EXPENSIVE_MODEL_MAX_OUTPUT_TOKENS} tokens`,
              `List output price of ${price.model}: $${(price.outputPerMTok / 1_000_000).toFixed(2)} / MTok (${price.source})`,
            ],
            recommendation: 'Evaluate a smaller/cheaper model for these simple calls (routing, classification, extraction).',
            tradeoff: 'Smaller models can be less accurate; evaluate on your own data before switching.',
            affects: 'cost',
            requestIds: small.map((r) => r.id),
            provider: first.provider,
            sessionId: sessionOf(small),
            docsUrl: price.source,
          },
          now,
        ),
      );
    }
  }

  return out;
};
