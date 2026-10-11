/**
 * Dashboard REST API DTOs (server <-> web). All money is nano-USD integers,
 * all nullable numbers mean "unknown", never zero.
 */
import type {
  ContextSegment,
  CostBreakdown,
  Finding,
  NormalizedUsage,
  ProviderId,
  RequestFeatures,
  RequestState,
  Timing,
  TraceRecord,
} from './domain.js';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RequestSummary {
  id: string;
  startedAt: string;
  provider: ProviderId;
  model: string | null;
  endpoint: string;
  sessionId: string | null;
  state: RequestState;
  httpStatus: number | null;
  stream: boolean;
  totalInputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalNanoUsd: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  findingCount: number;
  demo: boolean;
}

export interface RequestDetail {
  id: string;
  providerRequestId: string | null;
  traceId: string | null;
  sessionId: string | null;
  projectId: string;
  provider: ProviderId;
  model: string | null;
  endpoint: string;
  method: string;
  httpStatus: number | null;
  state: RequestState;
  errorMessage: string | null;
  timing: Timing;
  requestBytes: number | null;
  responseBytes: number | null;
  stream: boolean;
  streamCompleted: boolean | null;
  usage: NormalizedUsage;
  cost: CostBreakdown | null;
  features: RequestFeatures;
  demo: boolean;
  origin: 'proxy' | 'import' | 'demo';
  /** Previous request in the same session (or same provider+model), for prefix comparison. */
  previousRequestId: string | null;
  prefix: PrefixComparison | null;
  /** Whether raw content is available for this request under current capture settings. */
  contentAvailable: boolean;
}

export interface PrefixComparison {
  againstRequestId: string;
  sharedSegments: number;
  sharedEstimatedTokens: number | null;
  firstChangedSegmentIndex: number | null;
  firstChangedKind: string | null;
  firstChangedLabel: string | null;
  totalSegments: number;
  note: string;
}

export interface RequestContext {
  requestId: string;
  segments: ContextSegment[];
  contentAvailable: boolean;
  captureMode: string;
}

export interface OverviewResponse {
  range: { from: string; to: string };
  totals: {
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** cacheRead / totalInput over requests that reported both; null if none. */
    cacheHitRate: number | null;
    totalNanoUsd: number;
    unpricedRequests: number;
    avgDurationMs: number | null;
    p95DurationMs: number | null;
    openFindings: number;
    requestsWithoutUsage: number;
  };
  series: TimeBucket[];
  byModel: ModelBreakdown[];
  byProvider: { provider: ProviderId; requests: number; totalNanoUsd: number; inputTokens: number }[];
  topSessions: SessionSummary[];
  topRequests: RequestSummary[];
  recentFindings: Finding[];
  demo: boolean;
}

export interface TimeBucket {
  t: string; // bucket start ISO
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  totalNanoUsd: number;
  cacheReadNanoUsd: number;
  uncachedInputNanoUsd: number;
  cacheWriteNanoUsd: number;
  outputNanoUsd: number;
  avgDurationMs: number | null;
}

export interface ModelBreakdown {
  provider: ProviderId;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalNanoUsd: number;
  unpriced: number;
  cacheHitRate: number | null;
  avgDurationMs: number | null;
  actualSavingsNanoUsd: number;
}

export interface SessionSummary {
  id: string;
  firstSeen: string;
  lastSeen: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalNanoUsd: number;
  cacheHitRate: number | null;
  avgDurationMs: number | null;
  models: string[];
  findingCount: number;
}

export interface SessionDetail extends SessionSummary {
  turns: {
    requestId: string;
    startedAt: string;
    model: string | null;
    totalInputTokens: number | null;
    uncachedInputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    outputTokens: number | null;
    totalNanoUsd: number | null;
    durationMs: number | null;
    segmentCount: number;
    firstChangedSegmentIndex: number | null;
  }[];
  findings: Finding[];
}

export interface CacheSummary {
  totals: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheHitRate: number | null;
    actualSavingsNanoUsd: number;
    requestsWithCacheRead: number;
    requestsWithCacheWrite: number;
    requestsReportingUsage: number;
  };
  byProvider: {
    provider: ProviderId;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheHitRate: number | null;
    actualSavingsNanoUsd: number;
  }[];
  byModel: ModelBreakdown[];
  prefixStability: {
    comparisons: number;
    avgSharedSegmentRatio: number | null;
    firstChangeByKind: { kind: string; count: number }[];
  };
  findings: Finding[];
}

export interface CostSummary {
  totals: {
    totalNanoUsd: number;
    uncachedInputNanoUsd: number;
    cacheReadNanoUsd: number;
    cacheWriteNanoUsd: number;
    outputNanoUsd: number;
    actualSavingsNanoUsd: number;
    unpricedRequests: number;
  };
  byProvider: { provider: ProviderId; totalNanoUsd: number; requests: number }[];
  byModel: ModelBreakdown[];
  bySession: SessionSummary[];
  topRequests: RequestSummary[];
  pricing: { version: string; source: string; effectiveDate: string };
  disclaimer: string;
}

export interface CompareResponse {
  a: RequestDetail;
  b: RequestDetail;
  segmentsA: ContextSegment[];
  segmentsB: ContextSegment[];
  /** Alignment by exact fingerprint, then position. */
  alignment: {
    status: 'same' | 'changed' | 'added' | 'removed';
    aIndex: number | null;
    bIndex: number | null;
  }[];
  firstCacheRelevantDifference: {
    segmentIndex: number | null;
    kind: string | null;
    label: string | null;
    explanation: string;
  };
  contentAvailable: boolean;
}

export interface ProviderInfo {
  id: string;
  protocol: ProviderId;
  upstream: string;
  routePrefix: string;
  endpoints: string[];
  custom: boolean;
}

export interface SettingsResponse {
  captureMode: string;
  contentRetentionHours: number;
  metadataRetentionDays: number;
  pricingOverrides: unknown[];
  pricingVersion: string;
  host: string;
  port: number;
  demo: boolean;
  stats: { droppedEvents: number; queueDepth: number; dbBytes: number | null; storedRequests: number };
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeS: number;
  demo: boolean;
  queue: { depth: number; dropped: number; capacity: number };
}

export interface FiltersResponse {
  providers: string[];
  models: { provider: string; model: string }[];
  sessions: number;
  states: string[];
}

/** GET /api/requests/:id/content — only when capture settings kept content (else 404 content_unavailable). */
export interface ContentResponse {
  requestId: string;
  request: unknown;
  response: unknown;
  segments: (string | null)[];
  expiresAt: string | null;
  storage: 'memory' | 'encrypted_db';
}

export interface ApiError {
  error: { code: string; message: string; ref?: string };
}

/** GET /api/export — metadata-only records (no content). */
export interface ExportFile {
  format: 'contextscope.export';
  version: 1;
  exportedAt: string;
  records: TraceRecord[];
}

/** Dashboard live events (SSE on /api/events). Not to be confused with proxied provider SSE. */
export type LiveEvent =
  | { type: 'request.started'; id: string; provider: ProviderId; model: string | null; at: string }
  | { type: 'request.completed'; request: RequestSummary }
  | { type: 'findings.updated'; count: number }
  | { type: 'stats'; queueDepth: number; dropped: number }
  | { type: 'heartbeat'; at: string };
