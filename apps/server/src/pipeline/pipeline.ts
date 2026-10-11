import { randomUUID } from 'node:crypto';
import type { AnalyzableRequest, Analyzer, PrefixResult } from '@contextscope/analyzer';
import { redactText, type Fingerprinter } from '@contextscope/core';
import type { Pricing } from '@contextscope/pricing';
import { getAdapter } from '@contextscope/providers';
import {
  captureModeSchema,
  importedTraceSchema,
  type CaptureMode,
  type ContextScopeConfig,
  type Finding,
  type ImportedTrace,
  type ImportResult,
  type LiveEvent,
  type ProviderId,
  type RequestSummary,
  type TraceRecord,
} from '@contextscope/shared';
import type { Logger } from 'pino';
import type { CapturedExchange, LiveHub, Pipeline, PipelineStats, Store } from '../types.js';
import {
  buildRecord,
  exchangeToInput,
  type DeepContent,
  type RecordInput,
  type ResponseInput,
} from './record.js';

export const CAPTURE_MODE_SETTING = 'captureMode';
/** History window (requests) handed to the analyzer per new request. */
export const DEFAULT_ANALYSIS_WINDOW = 50;
/** Max items processed per event-loop turn before yielding (setImmediate). */
export const BATCH_PER_TICK = 50;
/** Max milliseconds of analysis per event-loop turn, so proxied traffic is never starved. */
export const TICK_BUDGET_MS = 8;
/** Analysis history windows kept in memory (one per session or provider+model group). */
export const HISTORY_CACHE_GROUPS = 256;
const DEFAULT_PROJECT = 'default';
const HOUR_MS = 3_600_000;
const STATS_EVENT_INTERVAL_MS = 1000;

export interface PipelineDeps {
  store: Store;
  live: LiveHub;
  pricing: Pricing;
  analyzer: Analyzer;
  fingerprinter: Fingerprinter;
  config: ContextScopeConfig;
  logger: Logger;
  /** Optional: requests per analysis history window (default 50). */
  analysisWindow?: number;
  /** Optional clock (tests). */
  now?: () => number;
}

interface MemoryEntry {
  payload: DeepContent;
  expiresMs: number;
}

const errMessage = (err: unknown): string =>
  redactText(err instanceof Error ? err.message : String(err)).slice(0, 300);

const summarize = (r: TraceRecord, findingCount: number): RequestSummary => ({
  id: r.id,
  startedAt: r.timing.startedAt,
  provider: r.provider,
  model: r.model,
  endpoint: r.endpoint,
  sessionId: r.sessionId,
  state: r.state,
  httpStatus: r.httpStatus,
  stream: r.stream,
  totalInputTokens: r.usage.totalInputTokens,
  outputTokens: r.usage.outputTokens,
  cacheReadTokens: r.usage.cacheReadTokens,
  cacheWriteTokens: r.usage.cacheWriteTokens,
  totalNanoUsd: r.cost?.totalNanoUsd ?? null,
  durationMs: r.timing.durationMs,
  ttftMs: r.timing.ttftMs,
  findingCount,
  demo: r.demo,
});

/** Validation issues as short messages; never echoes trace content. */
const issuesMessage = (issues: readonly { path: readonly PropertyKey[]; message: string }[]): string =>
  issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? `${i.path.map(String).join('.')}: ` : ''}${i.message}`)
    .join('; ')
    .slice(0, 500);

/** Map an imported trace onto the same RecordInput the proxy produces. */
const traceToInput = (
  t: ImportedTrace,
  id: string,
  opts: { demo: boolean; origin: 'import' | 'demo' },
): RecordInput => {
  const adapter = getAdapter(t.provider);
  const q = t.endpoint.indexOf('?');
  const path = q >= 0 ? t.endpoint.slice(0, q) : t.endpoint;
  const query = new URLSearchParams(q >= 0 ? t.endpoint.slice(q + 1) : '');
  const method = (t.method ?? 'POST').toUpperCase();
  const match = adapter.matchEndpoint(method, path, query);
  let response: ResponseInput = { kind: 'none' };
  if (t.responseSse !== undefined) response = { kind: 'sse', text: t.responseSse };
  else if (typeof t.response === 'string' && match?.streamFromPath && !match.sse)
    response = { kind: 'jsonArray', text: t.response };
  else if (t.response !== undefined) response = { kind: 'json', body: t.response };
  const state = t.state ?? 'completed';
  const isStream = t.responseSse !== undefined || (match?.streamFromPath ?? false);
  return {
    id,
    provider: t.provider,
    adapter,
    match,
    method,
    endpoint: t.endpoint,
    sessionId: t.sessionId ?? null,
    projectId: t.projectId ?? DEFAULT_PROJECT,
    traceId: t.traceId ?? null,
    startedAtMs: Date.parse(t.startedAt),
    connectMs: null,
    ttfbMs: t.ttfbMs ?? null,
    ttftMs: t.ttftMs ?? null,
    durationMs: t.durationMs ?? null,
    httpStatus: t.httpStatus ?? null,
    responseHeaders: {},
    requestBytes: null,
    responseBytes: null,
    requestBody: t.request ?? undefined,
    response,
    isStream,
    state,
    errorMessage: null,
    streamCompleted: isStream ? state === 'completed' : null,
    responseComplete: state === 'completed',
    demo: opts.demo,
    origin: opts.origin,
  };
};

/**
 * Analysis + persistence pipeline. Live exchanges go through a bounded FIFO drained in
 * small batches on setImmediate; imports run synchronously through the same steps:
 *
 *   buildRecord → seenCounts → previous request (history window) → comparePrefix
 *   → insertRecord → analyzeRequest + analyzeHistory → upsertFindings → live events
 *
 * Nothing here throws to the proxy: failures are counted (stats.failed) and logged redacted.
 */
export const createPipeline = (deps: PipelineDeps): Pipeline => {
  const { store, live, pricing, analyzer, fingerprinter, config, logger } = deps;
  const now = deps.now ?? Date.now;
  const capacity = config.limits.queueCapacity;
  const window = Math.max(1, deps.analysisWindow ?? DEFAULT_ANALYSIS_WINDOW);

  // --- queue (array + head index, compacted occasionally) ----------------------------------
  let queue: CapturedExchange[] = [];
  let head = 0;
  const depth = (): number => queue.length - head;
  let scheduled = false;
  let processing = false;
  let closed = false;
  let dropped = 0;
  let processed = 0;
  let failed = 0;
  let lastStatsEvent = 0;
  let waiters: (() => void)[] = [];

  // --- capture mode -------------------------------------------------------------------------
  let mode: CaptureMode = config.capture.mode;
  try {
    const stored = captureModeSchema.safeParse(store.getSetting<unknown>(CAPTURE_MODE_SETTING));
    if (stored.success) mode = stored.data;
  } catch (err) {
    logger.warn({ err: errMessage(err) }, 'pipeline: could not read capture mode setting');
  }

  // --- deep_memory ring buffer (Map keeps insertion order) ----------------------------------
  const memory = new Map<string, MemoryEntry>();
  const memoryLimit = config.capture.memoryBufferEntries;
  const retentionMs = config.capture.contentRetentionHours * HOUR_MS;
  const remember = (id: string, payload: DeepContent): void => {
    memory.delete(id);
    memory.set(id, { payload, expiresMs: now() + retentionMs });
    while (memory.size > memoryLimit) {
      const oldest = memory.keys().next();
      if (oldest.done) break;
      memory.delete(oldest.value);
    }
  };

  // --- in-memory analysis history (avoids re-reading the window from SQLite per request) -----
  const histories = new Map<string, AnalyzableRequest[]>();
  const groupOf = (sessionId: string | null, provider: string, model: string | null): string =>
    sessionId !== null ? `s:${sessionId}` : `m:${provider}:${model ?? ''}`;
  const historyFor = (sessionId: string | null, provider: ProviderId, model: string | null): AnalyzableRequest[] => {
    const key = groupOf(sessionId, provider, model);
    let h = histories.get(key);
    if (h) {
      histories.delete(key); // LRU: move to the end
    } else {
      h = store.recentForAnalysis({ sessionId, provider, model, limit: window });
    }
    histories.set(key, h);
    while (histories.size > HISTORY_CACHE_GROUPS) {
      const oldest = histories.keys().next();
      if (oldest.done) break;
      histories.delete(oldest.value);
    }
    return h;
  };
  const rememberHistory = (
    sessionId: string | null,
    provider: ProviderId,
    model: string | null,
    req: AnalyzableRequest,
  ): void => {
    const h = histories.get(groupOf(sessionId, provider, model));
    if (!h) return;
    // Keep content out of the long-lived cache; keep chronological order for out-of-order imports.
    const { segmentText: _drop, ...meta } = req;
    h.push(meta);
    if (h.length > 1 && (h[h.length - 2] as AnalyzableRequest).startedMs > meta.startedMs) {
      h.sort((a, b) => a.startedMs - b.startedMs);
    }
    if (h.length > window) h.splice(0, h.length - window);
  };

  const publish = (event: LiveEvent): void => {
    try {
      live.publish(event);
    } catch (err) {
      logger.debug({ err: errMessage(err) }, 'pipeline: live publish failed');
    }
  };

  /** The shared per-record path. Throws on failure; callers count. Returns findings changed. */
  const processInput = (input: RecordInput, publishLive: boolean): number => {
    const currentMode = mode;
    const built = buildRecord(input, {
      pricing,
      fingerprinter,
      maxSegments: config.limits.maxSegments,
      includeContent: currentMode !== 'metadata',
    });
    const { record } = built;
    const startedMs = Date.parse(record.timing.startedAt);

    if (record.segments.length > 0) {
      const seen = store.seenCounts(
        record.segments.map((s) => s.exactFingerprint),
        startedMs,
      );
      for (const s of record.segments) s.seenInRequests = seen.get(s.exactFingerprint) ?? 0;
    }

    const history = historyFor(record.sessionId, record.provider, record.model).filter(
      (h) => h.startedMs <= startedMs && h.id !== record.id,
    );
    const prev = history[history.length - 1];
    const prefix: PrefixResult | null = prev ? analyzer.comparePrefix(prev.segments, record.segments) : null;

    store.insertRecord(record, {
      operation: built.operation,
      previousRequestId: prev?.id ?? null,
      firstChangedSegment: prefix?.firstChangedSegmentIndex ?? null,
      sharedPrefixSegments: prefix?.sharedSegments ?? null,
      segmentsTruncated: built.segmentsTruncated,
    });

    if (built.content) {
      if (currentMode === 'deep_memory') remember(record.id, built.content);
      else if (currentMode === 'deep_persistent')
        store.putContent(record.id, built.content, now() + retentionMs);
    }

    const current: AnalyzableRequest = {
      id: record.id,
      provider: record.provider,
      model: record.model,
      sessionId: record.sessionId,
      startedMs,
      durationMs: record.timing.durationMs,
      ttftMs: record.timing.ttftMs,
      state: record.state,
      usage: record.usage,
      cost: record.cost,
      features: record.features,
      segments: record.segments,
      ...(built.content ? { segmentText: built.content.segments } : {}),
    };
    rememberHistory(record.sessionId, record.provider, record.model, current);
    const t = now();
    const findings: Finding[] = [
      ...analyzer.analyzeRequest(current, t),
      ...analyzer.analyzeHistory([...history, current], t),
    ];
    const changed = store.upsertFindings(findings, record.demo);

    if (publishLive) {
      const touching = findings.filter((f) => f.requestIds.includes(record.id)).length;
      publish({ type: 'request.completed', request: summarize(record, touching) });
      if (changed > 0) publish({ type: 'findings.updated', count: changed });
    }
    return changed;
  };

  const settle = (): void => {
    if (depth() === 0 && !processing) {
      const w = waiters;
      waiters = [];
      for (const fn of w) fn();
    }
  };

  const runBatch = (): void => {
    const started = performance.now();
    let n = 0;
    while (n < BATCH_PER_TICK && depth() > 0 && (n === 0 || performance.now() - started < TICK_BUDGET_MS)) {
      const ex = queue[head] as CapturedExchange;
      queue[head] = undefined as unknown as CapturedExchange;
      head++;
      n++;
      try {
        processInput(exchangeToInput(ex), true);
        processed++;
      } catch (err) {
        failed++;
        logger.warn(
          { err: errMessage(err), requestId: ex.id },
          'pipeline: failed to analyse/persist exchange',
        );
      }
    }
  };

  const tick = (): void => {
    scheduled = false;
    processing = true;
    // One outer transaction per batch (each record still commits atomically as a savepoint),
    // so a burst of requests costs one commit instead of one per request.
    try {
      store.sqlite.transaction(runBatch)();
    } catch (err) {
      logger.warn({ err: errMessage(err) }, 'pipeline: batch commit failed');
    }
    if (head > 1024 && head * 2 > queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
    processing = false;
    if (depth() > 0) schedule();
    else settle();
  };

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    setImmediate(tick);
  }

  const importTraces: Pipeline['importTraces'] = (traces, opts) => {
    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
    const valid: { index: number; trace: ImportedTrace }[] = [];
    traces.forEach((raw, index) => {
      let value: unknown = raw;
      if (typeof raw === 'string') {
        try {
          value = JSON.parse(raw) as unknown;
        } catch {
          result.errors.push({ index, message: 'invalid JSON' });
          return;
        }
      }
      const parsed = importedTraceSchema.safeParse(value);
      if (parsed.success) valid.push({ index, trace: parsed.data });
      else result.errors.push({ index, message: issuesMessage(parsed.error.issues) });
    });
    valid.sort((a, b) => Date.parse(a.trace.startedAt) - Date.parse(b.trace.startedAt) || a.index - b.index);

    const exists = store.sqlite.prepare('SELECT 1 FROM requests WHERE id = ?');
    const prefix = opts.origin === 'demo' ? 'demo_' : 'imp_';
    let changed = 0;
    for (const { index, trace } of valid) {
      const id = trace.id !== undefined ? `${prefix}${trace.id}` : `${prefix}${randomUUID()}`;
      try {
        if (exists.get(id) !== undefined) {
          result.skipped++;
          continue;
        }
        changed += processInput(traceToInput(trace, id, opts), false);
        result.imported++;
      } catch (err) {
        result.errors.push({ index, message: errMessage(err) });
      }
    }
    result.errors.sort((a, b) => a.index - b.index);
    if (changed > 0) publish({ type: 'findings.updated', count: changed });
    return result;
  };

  return {
    submit(exchange) {
      try {
        if (closed || depth() >= capacity) {
          dropped++;
          const t = now();
          if (t - lastStatsEvent >= STATS_EVENT_INTERVAL_MS) {
            lastStatsEvent = t;
            publish({ type: 'stats', queueDepth: depth(), dropped });
          }
          return;
        }
        queue.push(exchange);
        schedule();
      } catch (err) {
        dropped++;
        logger.warn({ err: errMessage(err) }, 'pipeline: submit failed');
      }
    },

    notifyStarted(info) {
      publish({
        type: 'request.started',
        id: info.id,
        provider: info.provider,
        model: info.model,
        at: new Date(info.at).toISOString(),
      });
    },

    importTraces,

    stats(): PipelineStats {
      return { queueDepth: depth(), capacity, dropped, processed, failed };
    },

    drain(timeoutMs = 10_000) {
      if (depth() === 0 && !processing) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        timer.unref?.();
        function done(): void {
          clearTimeout(timer);
          waiters = waiters.filter((w) => w !== done);
          resolve();
        }
        waiters.push(done);
      });
    },

    async close() {
      closed = true;
      await this.drain(5_000);
      memory.clear();
    },

    captureMode: () => mode,

    setCaptureMode(next) {
      const m = captureModeSchema.parse(next);
      store.setSetting(CAPTURE_MODE_SETTING, m);
      mode = m;
      if (m !== 'deep_memory') memory.clear();
    },

    memoryContent(requestId) {
      const e = memory.get(requestId);
      if (!e) return null;
      if (e.expiresMs <= now()) {
        memory.delete(requestId);
        return null;
      }
      return { payload: e.payload, expiresMs: e.expiresMs };
    },
  };
};
