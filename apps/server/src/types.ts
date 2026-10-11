/**
 * Internal contracts between the server's parts. Three areas, each owned separately:
 *
 *   proxy/     transport: routing, forwarding, streaming, timing → emits CapturedExchange
 *   pipeline/  CapturedExchange | ImportedTrace → TraceRecord (adapters, segments, pricing,
 *              analyzer) → Store; bounded persistence queue; import; demo seeding; retention
 *   api/       Fastify routes /api/* (read side over Store) + LiveHub SSE (/api/events)
 *
 * app.ts (wiring) builds them in this order: openDatabase → Store → LiveHub → Pipeline → proxy + api.
 */
import type { EndpointMatch, ParsedResponse, ProviderAdapter } from '@contextscope/core';
import type { Pricing } from '@contextscope/pricing';
import type { AnalyzableRequest, Analyzer } from '@contextscope/analyzer';
import type {
  CaptureMode,
  ContextScopeConfig,
  Finding,
  ImportResult,
  LiveEvent,
  ProviderId,
  TraceRecord,
} from '@contextscope/shared';
import type { Logger } from 'pino';
import type { Db } from './db/migrate.js';
import type Database from 'better-sqlite3';

/** A resolved proxy route. Built once at startup from validated config; never from request input. */
export interface Route {
  /** URL prefix, e.g. "/openai". */
  prefix: string;
  /** Route name: "openai" | "anthropic" | "gemini" | custom provider name. */
  name: string;
  /** Protocol/adapter used to interpret traffic. */
  protocol: ProviderId;
  adapter: ProviderAdapter;
  /** Upstream origin, e.g. "https://api.openai.com" (no trailing slash). */
  upstream: string;
  custom: boolean;
}

/**
 * Everything the proxy observed about one exchange, handed to the pipeline AFTER the
 * client response finished (or failed). Bodies are bounded copies for analysis only:
 * `requestBody` is null when larger than limits.maxInspectBytes; response chunks are
 * kept only up to limits.maxResponseInspectBytes (`responseTruncated` then true).
 * Secret headers/query params are ALREADY removed (see core/redact) — the pipeline
 * never sees credentials.
 */
export interface CapturedExchange {
  id: string;
  route: Route;
  /** null when the path is not a recognised endpoint (still proxied; metadata only). */
  match: EndpointMatch | null;
  method: string;
  /** Path after the route prefix with REDACTED query string, e.g. "/v1beta/models/x:generateContent?alt=sse". */
  redactedPath: string;
  sessionId: string | null;
  projectId: string;
  traceId: string | null;
  startedAtMs: number;
  /** Monotonic offsets from start (ms, may be fractional). null = not measured / not reached. */
  connectMs: number | null;
  ttfbMs: number | null;
  ttftMs: number | null;
  durationMs: number | null;
  httpStatus: number | null;
  responseContentType: string | null;
  /** Response headers without secrets (for provider request id). */
  responseHeaders: Record<string, string>;
  requestBytes: number;
  responseBytes: number;
  requestBody: Buffer | null;
  requestBodyTruncated: boolean;
  /** Response bytes as received (bounded). */
  responseBody: Buffer | null;
  responseTruncated: boolean;
  /**
   * Streaming observation done in the proxy side-channel (so TTFT can be measured live):
   * when the response was SSE / JSON-array stream, the proxy fed an accumulator and
   * gives its final result here; otherwise null and the pipeline parses responseBody.
   */
  streamResult: ParsedResponse | null;
  isStream: boolean;
  /** Proxy-level outcome. */
  state: 'completed' | 'client_aborted' | 'upstream_error' | 'rejected';
  errorMessage: string | null;
  streamCompleted: boolean | null;
}

/** Write + read access to SQLite. All analytics queries aggregate in SQL. */
export interface Store {
  readonly db: Db;
  readonly sqlite: Database.Database;
  /** Insert a full record (request + usage + cost + segments) in ONE transaction. */
  insertRecord(record: TraceRecord, extra: StoreExtra): void;
  /** Upsert findings by dedup id. Returns number changed. */
  upsertFindings(findings: Finding[], demo: boolean): number;
  /** Bounded history window for the analyzer (same session, or same provider+model). */
  recentForAnalysis(opts: {
    sessionId: string | null;
    provider: ProviderId;
    model: string | null;
    limit: number;
  }): AnalysisRow[];
  /** Count of earlier requests containing each exact fingerprint. */
  seenCounts(fingerprints: string[], beforeMs: number): Map<string, number>;
  getSetting<T>(key: string): T | null;
  setSetting(key: string, value: unknown): void;
  /** Deep-capture content (already redacted) encrypted at rest. */
  putContent(requestId: string, payload: unknown, expiresMs: number): void;
  getContent(requestId: string): { payload: unknown; expiresMs: number } | null;
  /** Retention cleanup: expired content and metadata older than N days (0 = keep). */
  cleanup(nowMs: number, metadataRetentionDays: number): { content: number; requests: number };
  countRequests(): number;
  dbBytes(): number | null;
}

export interface StoreExtra {
  operation: string | null;
  previousRequestId: string | null;
  firstChangedSegment: number | null;
  sharedPrefixSegments: number | null;
  segmentsTruncated: boolean;
}

/** Row shape returned for analysis history (segments loaded from context_segments). */
export type AnalysisRow = AnalyzableRequest;

/** Fan-out of LiveEvents to SSE subscribers; bounded per-subscriber buffers. */
export interface LiveHub {
  publish(event: LiveEvent): void;
  /** Returns an unsubscribe fn. `send` must not throw. */
  subscribe(send: (event: LiveEvent) => void): () => void;
  readonly subscribers: number;
  close(): void;
}

export interface PipelineStats {
  queueDepth: number;
  capacity: number;
  dropped: number;
  processed: number;
  failed: number;
}

export interface Pipeline {
  /** Non-blocking: enqueue for analysis+persistence. Never throws; drops (and counts) when full. */
  submit(exchange: CapturedExchange): void;
  /** Called by the proxy when a request starts (for the live feed only). */
  notifyStarted(info: { id: string; provider: ProviderId; model: string | null; at: number }): void;
  /** Synchronously analyse + persist imported traces (offline mode, demo seeding). */
  importTraces(traces: unknown[], opts: { demo: boolean; origin: 'import' | 'demo' }): ImportResult;
  stats(): PipelineStats;
  /** Wait until the queue is empty (tests, shutdown). */
  drain(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
  /** Current capture mode (settings can change it at runtime). */
  captureMode(): CaptureMode;
  setCaptureMode(mode: CaptureMode): void;
  /** In-memory deep-capture ring buffer lookup (deep_memory mode). */
  memoryContent(requestId: string): { payload: unknown; expiresMs: number } | null;
}

export interface ServerContext {
  config: ContextScopeConfig;
  logger: Logger;
  store: Store;
  live: LiveHub;
  pipeline: Pipeline;
  pricing: Pricing;
  analyzer: Analyzer;
  routes: Route[];
  startedAtMs: number;
}
