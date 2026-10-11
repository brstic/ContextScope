import type {
  ContextSegment,
  CostBreakdown,
  Finding,
  NormalizedUsage,
  RequestDetail,
  RequestSummary,
} from '@contextscope/shared';

/** SQL read boundary: nullable SQLite columns stay nullable in the public DTOs. */
export type Row = Record<string, unknown>;
export const value = <T>(r: Row, key: string): T => (r[key] ?? null) as T;
export const json = <T>(r: Row, key: string, fallback: T): T =>
  typeof r[key] === 'string' ? (JSON.parse(r[key]) as T) : fallback;
const num = (r: Row, k: string): number | null => value(r, k);
const str = (r: Row, k: string): string | null => value(r, k);

export const mapUsage = (r: Row): NormalizedUsage => ({
  totalInputTokens: num(r, 'total_input_tokens'),
  uncachedInputTokens: num(r, 'uncached_input_tokens'),
  cacheReadTokens: num(r, 'cache_read_tokens'),
  cacheWriteTokens: num(r, 'cache_write_tokens'),
  cacheWrite5mTokens: num(r, 'cache_write_5m_tokens'),
  cacheWrite1hTokens: num(r, 'cache_write_1h_tokens'),
  outputTokens: num(r, 'output_tokens'),
  reasoningTokens: num(r, 'reasoning_tokens'),
  providerTotalTokens: num(r, 'provider_total_tokens'),
  other: json(r, 'other_json', {}),
  source: value(r, 'source') ?? 'unavailable',
  complete: r['complete'] === 1,
  raw: json(r, 'raw_json', null),
});
export const mapCost = (r: Row): CostBreakdown | null =>
  r['cost_request_id'] == null
    ? null
    : {
        currency: 'USD',
        uncachedInputNanoUsd: num(r, 'uncached_input_nano'),
        cacheReadNanoUsd: num(r, 'cache_read_nano'),
        cacheWriteNanoUsd: num(r, 'cache_write_nano'),
        outputNanoUsd: num(r, 'output_nano'),
        totalNanoUsd: num(r, 'total_nano'),
        actualCacheSavingsNanoUsd: num(r, 'savings_nano'),
        pricingModelKey: str(r, 'pricing_model_key'),
        pricingSource: str(r, 'pricing_source'),
        pricingVersion: str(r, 'pricing_version'),
        confidence: value(r, 'confidence'),
        notes: json(r, 'notes_json', []),
      };
export const mapSummary = (r: Row): RequestSummary => ({
  id: value(r, 'id'),
  startedAt: value(r, 'started_at'),
  provider: value(r, 'provider'),
  model: str(r, 'model'),
  endpoint: value(r, 'endpoint'),
  sessionId: str(r, 'session_id'),
  state: value(r, 'state'),
  httpStatus: num(r, 'http_status'),
  stream: r['stream'] === 1,
  totalInputTokens: num(r, 'total_input_tokens'),
  outputTokens: num(r, 'output_tokens'),
  cacheReadTokens: num(r, 'cache_read_tokens'),
  cacheWriteTokens: num(r, 'cache_write_tokens'),
  totalNanoUsd: num(r, 'total_nano'),
  durationMs: num(r, 'duration_ms'),
  ttftMs: num(r, 'ttft_ms'),
  findingCount: num(r, 'finding_count') ?? 0,
  demo: r['demo'] === 1,
});
export const mapDetail = (r: Row): RequestDetail => ({
  id: value(r, 'id'),
  providerRequestId: str(r, 'provider_request_id'),
  traceId: str(r, 'trace_id'),
  sessionId: str(r, 'session_id'),
  projectId: value(r, 'project_id'),
  provider: value(r, 'provider'),
  model: str(r, 'model'),
  endpoint: value(r, 'endpoint'),
  method: value(r, 'method'),
  httpStatus: num(r, 'http_status'),
  state: value(r, 'state'),
  errorMessage: str(r, 'error_message'),
  timing: {
    startedAt: value(r, 'started_at'),
    endedAt: str(r, 'ended_at'),
    durationMs: num(r, 'duration_ms'),
    ttfbMs: num(r, 'ttfb_ms'),
    ttftMs: num(r, 'ttft_ms'),
    connectMs: num(r, 'connect_ms'),
  },
  requestBytes: num(r, 'request_bytes'),
  responseBytes: num(r, 'response_bytes'),
  stream: r['stream'] === 1,
  streamCompleted: r['stream_completed'] == null ? null : r['stream_completed'] === 1,
  usage: mapUsage(r),
  cost: mapCost(r),
  features: json(r, 'features_json', {} as RequestDetail['features']),
  demo: r['demo'] === 1,
  origin: value(r, 'origin'),
  previousRequestId: str(r, 'previous_request_id'),
  prefix: null,
  contentAvailable: false,
});
export const mapSegment = (r: Row): ContextSegment => ({
  index: value(r, 'idx'),
  kind: value(r, 'kind'),
  role: str(r, 'role'),
  path: value(r, 'path'),
  label: value(r, 'label'),
  byteLength: value(r, 'byte_length'),
  // Schema v1 has no char_length. Byte length is the only available size (not a Unicode character count).
  charLength: value(r, 'char_length') ?? value(r, 'byte_length'),
  estimatedTokens: num(r, 'estimated_tokens'),
  tokenSource: value(r, 'token_source'),
  exactFingerprint: value(r, 'exact_fp'),
  normalizedFingerprint: value(r, 'normalized_fp'),
  prefixFingerprint: value(r, 'prefix_fp'),
  cacheControl: str(r, 'cache_control'),
  messageIndex: num(r, 'message_index'),
  multimodal: r['multimodal'] === 1,
  duplicateCountInRequest: value(r, 'duplicate_in_request'),
  seenInRequests: null,
});
export const mapFinding = (r: Row): Finding => ({
  id: value(r, 'id'),
  type: value(r, 'type'),
  title: value(r, 'title'),
  severity: value(r, 'severity'),
  confidence: value(r, 'confidence'),
  description: value(r, 'description'),
  evidence: json(r, 'evidence_json', []),
  recommendation: value(r, 'recommendation'),
  tradeoff: value(r, 'tradeoff'),
  affects: value(r, 'affects'),
  requestIds: json(r, 'request_ids_json', []),
  segmentIndexes: json(r, 'segment_indexes_json', []),
  estimatedTokenReduction: num(r, 'estimated_token_reduction'),
  docsUrl: str(r, 'docs_url'),
  createdAt: new Date(value<number>(r, 'created_ms')).toISOString(),
  sessionId: str(r, 'session_id'),
});
