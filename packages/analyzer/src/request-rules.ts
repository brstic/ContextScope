import type { ContextSegment, Finding } from '@contextscope/shared';
import {
  DUPLICATE_SEGMENT_MIN_COPIES,
  DUPLICATE_SEGMENT_MIN_TOKENS,
  LARGE_TOOL_OUTPUT_TOKENS,
  OVERSIZED_TOOL_SCHEMA_SHARE,
  OVERSIZED_TOOL_SCHEMA_SHARE_MIN_TOKENS,
  OVERSIZED_TOOL_SCHEMA_TOKENS,
  REPEATED_SPAN_MIN_CHARS,
  SLOW_REQUEST_DURATION_MS,
  SLOW_REQUEST_TTFT_MS,
  STRUCTURED_SCHEMA_TOKENS,
  UNEXPECTED_CACHE_WRITE_MIN_TOKENS,
  UNEXPECTED_CACHE_WRITE_SHARE,
} from './constants.js';
import { fmt, makeFinding, pct } from './finding.js';
import { sumEstimated } from './prefix.js';
import type { AnalyzableRequest, AnalyzerLimits } from './types.js';
import { findRepeatedSpans } from './winnow.js';

const groupBy = <T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const g = m.get(k);
    if (g) g.push(it);
    else m.set(k, [it]);
  }
  return m;
};

/** est × (copies − 1) when every copy has an estimate; otherwise null (no basis). */
const duplicateReduction = (copies: readonly ContextSegment[]): number | null => {
  const first = copies[0];
  if (!first || first.estimatedTokens === null || copies.some((s) => s.estimatedTokens === null)) return null;
  return first.estimatedTokens * (copies.length - 1);
};

const isConversation = (s: ContextSegment): boolean => s.kind === 'user' || s.kind === 'assistant';
const isInstruction = (s: ContextSegment): boolean => s.kind === 'system' || s.kind === 'developer';

/** Same user/assistant exact content at ≥2 different message indexes. */
const historyDuplicateGroups = (segs: readonly ContextSegment[]): ContextSegment[][] =>
  [...groupBy(segs.filter(isConversation), (s) => s.exactFingerprint).values()].filter(
    (g) => new Set(g.map((s) => s.messageIndex)).size >= 2,
  );

/** Findings computable from one request alone. */
export const analyzeRequest = (req: AnalyzableRequest, now: number, limits: AnalyzerLimits): Finding[] => {
  const segs = req.segments.slice(0, limits.maxSegments);
  const out: Finding[] = [];
  const base = { provider: req.provider, sessionId: req.sessionId, requestIds: [req.id] };
  const totalEst = sumEstimated(segs);

  // history_duplication (checked first so duplicate_segment does not double-count it)
  const histDupKeys = new Set<string>();
  for (const g of historyDuplicateGroups(segs)) {
    const first = g[0] as ContextSegment;
    histDupKeys.add(first.normalizedFingerprint);
    const msgs = [...new Set(g.map((s) => s.messageIndex))];
    out.push(
      makeFinding(
        {
          ...base,
          type: 'history_duplication',
          scope: `${req.id}:${first.exactFingerprint}`,
          title: `The same ${first.kind} message appears ${msgs.length} times in the conversation`,
          severity: (first.estimatedTokens ?? 0) >= 1000 ? 'medium' : 'low',
          confidence: 'high',
          description:
            'Identical conversation content (exact fingerprint match) is present at several message positions of one request, ' +
            'which usually means history is appended twice by the client.',
          evidence: [
            `Exact fingerprint ${first.exactFingerprint.slice(0, 12)}… found at message indexes ${msgs.join(', ')}`,
            `Estimated size per copy: ${first.estimatedTokens === null ? 'unavailable' : `${fmt(first.estimatedTokens)} tokens (estimated)`}`,
          ],
          recommendation: 'Check how conversation history is assembled and send each turn once.',
          tradeoff: 'Low: unless the repetition is deliberate (e.g. re-stating a question), removing it does not change meaning.',
          affects: 'input_volume',
          segmentIndexes: g.map((s) => s.index),
          estimatedTokenReduction: duplicateReduction(
            msgs.map((m) => g.find((s) => s.messageIndex === m) as ContextSegment),
          ),
        },
        now,
      ),
    );
  }

  // duplicate_system_instructions / duplicate_segment (normalized fingerprint)
  for (const g of groupBy(segs, (s) => s.normalizedFingerprint).values()) {
    if (g.length < DUPLICATE_SEGMENT_MIN_COPIES) continue;
    const first = g[0] as ContextSegment;
    const reduction = duplicateReduction(g);
    if (g.every(isInstruction)) {
      out.push(
        makeFinding(
          {
            ...base,
            type: 'duplicate_system_instructions',
            scope: `${req.id}:${first.normalizedFingerprint}`,
            title: `System/developer instructions are sent ${g.length} times`,
            severity: (first.estimatedTokens ?? 0) >= DUPLICATE_SEGMENT_MIN_TOKENS ? 'medium' : 'low',
            confidence: 'high',
            description: 'Two or more system/developer segments in this request have the same normalized content.',
            evidence: [
              `${g.length} segments (${g.map((s) => `#${s.index} ${s.label}`).join(', ')}) share normalized fingerprint ${first.normalizedFingerprint.slice(0, 12)}…`,
              `Estimated size per copy: ${first.estimatedTokens === null ? 'unavailable' : `${fmt(first.estimatedTokens)} tokens (estimated)`}`,
            ],
            recommendation: 'Send the instructions once (e.g. only in the system prompt).',
            tradeoff: 'Low. Repetition is sometimes used on purpose to reinforce instructions; verify output quality after removing it.',
            affects: 'input_volume',
            segmentIndexes: g.map((s) => s.index),
            estimatedTokenReduction: reduction,
          },
          now,
        ),
      );
      continue;
    }
    if (histDupKeys.has(first.normalizedFingerprint) && g.every(isConversation)) continue;
    if (first.estimatedTokens === null || first.estimatedTokens < DUPLICATE_SEGMENT_MIN_TOKENS) continue;
    out.push(
      makeFinding(
        {
          ...base,
          type: 'duplicate_segment',
          scope: `${req.id}:${first.normalizedFingerprint}`,
          title: `A ${first.kind} segment is repeated ${g.length} times in one request`,
          severity: reduction !== null && reduction >= 2000 ? 'medium' : 'low',
          confidence: 'high',
          description: 'Several segments of this request have the same normalized content.',
          evidence: [
            `${g.length} segments (${g.map((s) => `#${s.index} ${s.kind} "${s.label}"`).join(', ')}) share normalized fingerprint ${first.normalizedFingerprint.slice(0, 12)}…`,
            `Estimated size per copy: ${fmt(first.estimatedTokens)} tokens (estimated)`,
          ],
          recommendation: 'Include the content once and refer to it, or de-duplicate before building the request.',
          tradeoff: 'Low to medium: if the copies are intentionally placed close to where they are used, removing one may affect answer quality.',
          affects: 'input_volume',
          segmentIndexes: g.map((s) => s.index),
          estimatedTokenReduction: reduction,
        },
        now,
      ),
    );
  }

  // oversized_tool_schemas
  const tools = segs.filter((s) => s.kind === 'tool_definition');
  const toolEst = tools.length ? sumEstimated(tools) : null;
  if (toolEst !== null) {
    const share = totalEst ? toolEst / totalEst : null;
    const byShare =
      share !== null && share >= OVERSIZED_TOOL_SCHEMA_SHARE && toolEst >= OVERSIZED_TOOL_SCHEMA_SHARE_MIN_TOKENS;
    if (toolEst >= OVERSIZED_TOOL_SCHEMA_TOKENS || byShare) {
      const largest = [...tools].sort((a, b) => (b.estimatedTokens ?? 0) - (a.estimatedTokens ?? 0)).slice(0, 3);
      out.push(
        makeFinding(
          {
            ...base,
            type: 'oversized_tool_schemas',
            scope: `${req.id}:tools`,
            title: `Tool definitions take ~${fmt(toolEst)} tokens (estimated)`,
            severity: toolEst >= 10_000 ? 'high' : 'medium',
            confidence: 'medium',
            description: `${tools.length} tool definitions are sent with this request.`,
            evidence: [
              `Tool definitions: ${fmt(toolEst)} estimated tokens in ${tools.length} tools` +
                (share !== null ? ` (${pct(share)} of the request's estimated input)` : ''),
              `Largest: ${largest.map((s) => `${s.label} ~${fmt(s.estimatedTokens ?? 0)}`).join(', ')}`,
            ],
            recommendation:
              'Send only the tools this step can use, shorten descriptions and schemas, and keep the tool list stable and first so it can be prompt-cached.',
            tradeoff: 'Removing or shortening tools can make the model miss a capability or call tools less accurately.',
            affects: 'both',
            segmentIndexes: tools.map((s) => s.index),
          },
          now,
        ),
      );
    }
  }

  // large_tool_output
  const bigResults = segs.filter((s) => s.kind === 'tool_result' && (s.estimatedTokens ?? 0) >= LARGE_TOOL_OUTPUT_TOKENS);
  if (bigResults.length) {
    const est = bigResults.reduce((n, s) => n + (s.estimatedTokens ?? 0), 0);
    out.push(
      makeFinding(
        {
          ...base,
          type: 'large_tool_output',
          scope: `${req.id}:tool_results`,
          title: `${bigResults.length} large tool result${bigResults.length > 1 ? 's' : ''} (~${fmt(est)} tokens, estimated)`,
          severity: est >= 30_000 ? 'high' : 'medium',
          confidence: 'medium',
          description: `Tool results of ${fmt(LARGE_TOOL_OUTPUT_TOKENS)}+ estimated tokens are passed back to the model.`,
          evidence: bigResults.map((s) => `#${s.index} ${s.label}: ~${fmt(s.estimatedTokens ?? 0)} tokens (estimated)`),
          recommendation: 'Trim, paginate or summarize tool output before returning it; return only fields the model needs.',
          tradeoff: 'The model may lose details it needed; keep a way to fetch more on demand.',
          affects: 'input_volume',
          segmentIndexes: bigResults.map((s) => s.index),
        },
        now,
      ),
    );
  }

  // slow_request
  const slowDur = req.durationMs !== null && req.durationMs >= SLOW_REQUEST_DURATION_MS;
  const slowTtft = req.ttftMs !== null && req.ttftMs >= SLOW_REQUEST_TTFT_MS;
  if (slowDur || slowTtft) {
    const ev: string[] = [];
    if (req.durationMs !== null) ev.push(`Duration: ${fmt(req.durationMs)} ms (threshold ${fmt(SLOW_REQUEST_DURATION_MS)} ms)`);
    if (req.ttftMs !== null) ev.push(`Time to first token: ${fmt(req.ttftMs)} ms (threshold ${fmt(SLOW_REQUEST_TTFT_MS)} ms)`);
    if (req.usage.totalInputTokens !== null) ev.push(`Reported input: ${fmt(req.usage.totalInputTokens)} tokens`);
    if (req.usage.outputTokens !== null) ev.push(`Reported output: ${fmt(req.usage.outputTokens)} tokens`);
    out.push(
      makeFinding(
        {
          ...base,
          type: 'slow_request',
          scope: `${req.id}:slow`,
          title: slowTtft ? 'Slow time to first token' : 'Slow request',
          severity: 'low',
          confidence: 'high',
          description: 'Measured latency of this request exceeded the threshold. Causes can be input size, output length, reasoning effort or provider load.',
          evidence: ev,
          recommendation: 'Reduce input size, enable streaming, lower reasoning effort or max output, and keep a stable cacheable prefix.',
          tradeoff: 'Less context or reasoning can reduce answer quality.',
          affects: 'latency',
          docsUrl: null,
        },
        now,
      ),
    );
  }

  // unexpected_cache_writes (reported numbers only)
  const u = req.usage;
  if (
    u.source === 'reported' &&
    u.cacheWriteTokens !== null &&
    u.totalInputTokens !== null &&
    u.totalInputTokens > 0 &&
    u.cacheWriteTokens >= UNEXPECTED_CACHE_WRITE_MIN_TOKENS &&
    u.cacheWriteTokens / u.totalInputTokens >= UNEXPECTED_CACHE_WRITE_SHARE
  ) {
    out.push(
      makeFinding(
        {
          ...base,
          type: 'unexpected_cache_writes',
          scope: `${req.id}:cache_writes`,
          title: `${pct(u.cacheWriteTokens / u.totalInputTokens)} of the input was written to the cache`,
          severity: 'low',
          confidence: 'medium',
          description:
            'The provider reported that most of this request\'s input was written to the prompt cache. That is expected for the first request ' +
            'of a cached prefix, but repeated large writes usually mean the cached prefix changes or expires before it is reused.',
          evidence: [
            `Reported cache write: ${fmt(u.cacheWriteTokens)} of ${fmt(u.totalInputTokens)} input tokens`,
            `Reported cache read: ${u.cacheReadTokens === null ? 'not reported' : `${fmt(u.cacheReadTokens)} tokens`}`,
          ],
          recommendation: 'Place cache breakpoints after stable content only and keep that content byte-identical between requests.',
          tradeoff: 'Cache writes cost more than plain input; if the prefix is not reused within the TTL, caching it costs more than not caching.',
          affects: 'caching',
        },
        now,
      ),
    );
  }

  // repeated_structured_schema
  for (const s of segs) {
    if (s.kind !== 'schema' || s.estimatedTokens === null || s.estimatedTokens < STRUCTURED_SCHEMA_TOKENS) continue;
    out.push(
      makeFinding(
        {
          ...base,
          type: 'repeated_structured_schema',
          scope: `${req.id}:${s.exactFingerprint}`,
          title: `Large structured-output schema (~${fmt(s.estimatedTokens)} tokens, estimated)`,
          severity: 'low',
          confidence: 'medium',
          description: 'A large response schema is sent with this request and is part of the input on every call that uses it.',
          evidence: [`#${s.index} ${s.label}: ~${fmt(s.estimatedTokens)} tokens (estimated)`],
          recommendation: 'Simplify the schema (fewer optional fields, shorter descriptions) and keep it byte-identical so it can be cached.',
          tradeoff: 'A looser schema may yield less precise structured output.',
          affects: 'both',
          segmentIndexes: [s.index],
        },
        now,
      ),
    );
  }

  // repeated spans (deep capture only)
  if (req.segmentText && req.segmentText.length) {
    const texts = req.segmentText.slice(0, segs.length);
    const spans = findRepeatedSpans(texts, { maxChars: limits.maxSpanChars, minLength: REPEATED_SPAN_MIN_CHARS });
    const byPair = groupBy(spans, (s) => `${s.segmentA}:${s.segmentB}`);
    for (const [pair, list] of byPair) {
      const sa = segs[list[0]?.segmentA ?? -1];
      const sb = segs[list[0]?.segmentB ?? -1];
      if (!sa || !sb) continue;
      // Whole-segment duplicates are already reported via fingerprints.
      if (sa.normalizedFingerprint === sb.normalizedFingerprint) continue;
      const text = texts[sa.index] ?? '';
      const chars = list.reduce((n, s) => n + s.length, 0);
      const bytes = list.reduce((n, s) => n + Buffer.byteLength(text.slice(s.offsetA, s.offsetA + s.length), 'utf8'), 0);
      const est = Math.ceil(bytes / 4);
      out.push(
        makeFinding(
          {
            ...base,
            type: 'duplicate_segment',
            scope: `${req.id}:span:${pair}`,
            title: `~${fmt(chars)} characters repeated in two segments`,
            severity: est >= 2000 ? 'medium' : 'low',
            confidence: 'high',
            description: 'A long text span appears verbatim in two different segments of this request (deep capture).',
            evidence: [
              `Segments #${sa.index} (${sa.kind} "${sa.label}") and #${sb.index} (${sb.kind} "${sb.label}") share ${list.length} span(s) totalling ${fmt(chars)} characters`,
              `Estimated size of the repeated text: ~${fmt(est)} tokens (bytes / 4)`,
            ],
            recommendation: 'Include the repeated text once (e.g. de-duplicate retrieved chunks or quoted history).',
            tradeoff: 'If the repetition is intentional (quoting for emphasis), removing it may change model behaviour.',
            affects: 'input_volume',
            segmentIndexes: [sa.index, sb.index],
            estimatedTokenReduction: est,
          },
          now,
        ),
      );
    }
  }

  return out;
};
