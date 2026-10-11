/**
 * Core domain types shared by every ContextScope package.
 *
 * Rules that apply everywhere:
 *  - Anything that may be unknown is `null`, never 0. Absent metadata is not zero.
 *  - Every significant measurement carries its source (see MeasurementSource).
 *  - Money is integer nano-USD (1 USD = 1e9). Prices are integer micro-USD per 1M tokens.
 */

export const PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** Where a number came from. */
export type MeasurementSource =
  /** Directly returned by the provider. */
  | 'reported'
  /** Computed locally with a verified tokenizer for that model + content type. */
  | 'exact_local'
  /** A documented approximation (e.g. bytes / 4). Never shown as exact. */
  | 'estimated'
  /** Could not be determined reliably. */
  | 'unavailable';

export type Confidence = 'high' | 'medium' | 'low';

/** Lifecycle of a captured request. */
export type RequestState =
  | 'pending' // request forwarded, response not finished
  | 'completed' // upstream finished normally (any HTTP status)
  | 'client_aborted' // client went away before the upstream finished
  | 'upstream_error' // network error / timeout / stream cut by upstream
  | 'rejected'; // ContextScope refused it (unknown route, upstream not allowed, too large)

/**
 * Provider usage normalized to one shape.
 *
 * Invariants (when the numbers are known):
 *   totalInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
 *   cacheWriteTokens = cacheWrite5mTokens + cacheWrite1hTokens (when the TTL split is reported)
 *   reasoningTokens is a SUBSET of outputTokens for OpenAI (output_tokens includes reasoning),
 *   and ADDITIONAL to candidates for Gemini (thoughtsTokenCount is separate) — adapters
 *   normalize so that `outputTokens` is ALWAYS the full billable output including reasoning,
 *   and `reasoningTokens` is the part of it that was reasoning/thinking.
 */
export interface NormalizedUsage {
  totalInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** Total as reported by the provider, if it reports one. */
  providerTotalTokens: number | null;
  /** Other provider-specific counters, e.g. tool_use_prompt_tokens, audio tokens. */
  other: Record<string, number>;
  /** 'reported' when taken from provider usage, 'unavailable' when none was delivered. */
  source: MeasurementSource;
  /** false when the stream ended before the final usage event (usage partial or missing). */
  complete: boolean;
  /** The provider's raw usage object, already free of secrets. */
  raw: unknown;
}

export const emptyUsage = (): NormalizedUsage => ({
  totalInputTokens: null,
  uncachedInputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cacheWrite5mTokens: null,
  cacheWrite1hTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  providerTotalTokens: null,
  other: {},
  source: 'unavailable',
  complete: false,
  raw: null,
});

/** Kinds of context segments, in the order a provider renders them (roughly). */
export const SEGMENT_KINDS = [
  'tool_definition',
  'system',
  'developer',
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'document',
  'schema',
  'image',
  'audio',
  'file',
  'cached_content_ref',
  'config',
  'other',
] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

/**
 * One piece of the request context as extracted by a provider adapter.
 * `text` is the canonical serialization used for fingerprinting and token estimation.
 * It lives in memory only and is never persisted unless deep capture allows it.
 */
export interface RawSegment {
  kind: SegmentKind;
  /** Provider role (system, user, assistant, model, tool, developer…) or null. */
  role: string | null;
  /** JSON-pointer-like path into the request body, e.g. /messages/3/content/0. */
  path: string;
  /** Human label: tool name, message index, "system prompt"… */
  label: string;
  /** Exact serialized bytes of this part of the request (JSON.stringify of the original node). */
  exactText: string;
  /** Content-type-aware normalized text (whitespace-insensitive JSON, trimmed text). */
  normalizedText: string;
  /** Only the human-readable text (for text diffs / duplicate spans). */
  plainText: string;
  /** Provider cache-control marker on this segment, e.g. "ephemeral", "ephemeral:1h", "explicit". */
  cacheControl: string | null;
  /** Message index this segment belongs to (null for tools/system/config). */
  messageIndex: number | null;
  /** True when content is binary/multimodal and token estimates are not meaningful. */
  multimodal: boolean;
}

/** A segment as stored and shown: fingerprints + sizes, no content by default. */
export interface ContextSegment {
  index: number;
  kind: SegmentKind;
  role: string | null;
  path: string;
  label: string;
  byteLength: number;
  charLength: number;
  estimatedTokens: number | null;
  tokenSource: MeasurementSource;
  /** HMAC-SHA256 (keyed, local) of exactText, hex, truncated to 32 chars. */
  exactFingerprint: string;
  /** HMAC of normalizedText. */
  normalizedFingerprint: string;
  /** Cumulative HMAC over exact fingerprints of segments 0..index (prefix identity). */
  prefixFingerprint: string;
  cacheControl: string | null;
  messageIndex: number | null;
  multimodal: boolean;
  /** Number of other segments in the SAME request with the same normalized fingerprint. */
  duplicateCountInRequest: number;
  /** How many earlier captured requests contained this exact fingerprint (filled by server). */
  seenInRequests: number | null;
  /** Present only when capture mode permits content (deep capture). */
  content?: string | null;
}

export interface RequestFeatures {
  stream: boolean;
  toolCount: number;
  toolChoice: string | null;
  structuredOutput: boolean;
  reasoning: string | null;
  cacheControlBlocks: number;
  attachments: number;
  messageCount: number;
  systemBlocks: number;
  /** Provider-specific cache options seen in the request (prompt_cache_key, cachedContent, ttl…). */
  cacheOptions: Record<string, string>;
}

export interface CostBreakdown {
  currency: 'USD';
  uncachedInputNanoUsd: number | null;
  cacheReadNanoUsd: number | null;
  cacheWriteNanoUsd: number | null;
  outputNanoUsd: number | null;
  totalNanoUsd: number | null;
  /** What the cached tokens would have cost at the uncached input rate, minus what they cost. */
  actualCacheSavingsNanoUsd: number | null;
  pricingModelKey: string | null;
  pricingSource: string | null;
  pricingVersion: string | null;
  confidence: Confidence | null;
  /** Human-readable notes: "Pricing unavailable", "long-context tier applied"… */
  notes: string[];
}

export type FindingType =
  | 'duplicate_system_instructions'
  | 'oversized_tool_schemas'
  | 'unstable_prefix'
  | 'repeated_retrieval_payload'
  | 'history_duplication'
  | 'low_cache_reuse'
  | 'excessive_context_growth'
  | 'repeated_large_input'
  | 'expensive_model_usage'
  | 'token_spike'
  | 'unexpected_cache_writes'
  | 'slow_request'
  | 'repeated_structured_schema'
  | 'large_tool_output'
  | 'duplicate_segment';

export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface Finding {
  id: string;
  type: FindingType;
  title: string;
  severity: Severity;
  confidence: Confidence;
  description: string;
  evidence: string[];
  recommendation: string;
  /** Functional trade-off of acting on it (quality risk etc.). */
  tradeoff: string;
  affects: 'input_volume' | 'caching' | 'both' | 'cost' | 'latency';
  requestIds: string[];
  segmentIndexes: number[];
  /** Only when defensible; null otherwise. Always labelled estimated. */
  estimatedTokenReduction: number | null;
  docsUrl: string | null;
  createdAt: string;
  sessionId: string | null;
}

export interface Timing {
  startedAt: string; // ISO
  endedAt: string | null;
  durationMs: number | null;
  /** Time to first upstream response byte. */
  ttfbMs: number | null;
  /** Time to first meaningful generated output (text/tool delta), null when not determinable. */
  ttftMs: number | null;
  /** Upstream connect time if measurable, else null. */
  connectMs: number | null;
}

/**
 * A normalized captured request. This is both what the analysis pipeline produces
 * and (minus server-only fields) the ContextScope offline import format.
 */
export interface TraceRecord {
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
  segments: ContextSegment[];
  /** True for synthetic demo data. */
  demo: boolean;
  /** 'proxy' | 'import' | 'demo' */
  origin: 'proxy' | 'import' | 'demo';
}
