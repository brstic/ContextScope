import type {
  NormalizedUsage,
  ProviderId,
  RawSegment,
  RequestFeatures,
} from '@contextscope/shared';

/**
 * The provider adapter contract. Everything provider-specific lives behind it;
 * shared analysis code only ever sees the normalized output.
 *
 * Adapters are pure and synchronous: no I/O, no clocks, no globals. The server
 * owns transport; adapters only interpret bytes that the server hands them.
 */

/** A recognised, supported endpoint. */
export interface EndpointMatch {
  provider: ProviderId;
  /** Stable operation id, e.g. "openai.chat.completions", "gemini.streamGenerateContent". */
  operation: string;
  /** Path after the provider route prefix, without query, e.g. "/v1/chat/completions". */
  path: string;
  /** Model taken from the URL (Gemini), else null. */
  modelFromPath: string | null;
  /** True when the URL itself requests streaming (Gemini streamGenerateContent). */
  streamFromPath: boolean;
  /** Gemini: alt=sse present. */
  sse: boolean;
}

export interface ParsedRequest {
  model: string | null;
  stream: boolean;
  features: RequestFeatures;
  /** Ordered as the provider renders them for prompt caching (tools, system, messages…). */
  segments: RawSegment[];
}

export interface ParsedResponse {
  model: string | null;
  providerRequestId: string | null;
  usage: NormalizedUsage;
  /** Finish/stop reason if reported. */
  finishReason: string | null;
  /** Approximate generated output text length (chars), when available. */
  outputChars: number | null;
}

/** One SSE event as parsed by the SSE parser (spec: https://html.spec.whatwg.org/multipage/server-sent-events.html). */
export interface SseEvent {
  /** `event:` field, or null when absent (default "message"). */
  event: string | null;
  /** Joined `data:` lines (joined with "\n"). */
  data: string;
  id: string | null;
  retry: number | null;
}

/** Result of feeding one SSE event to a stream accumulator. */
export interface StreamEventResult {
  /** True if this event carried generated output (text delta, tool-call delta, reasoning summary delta…). */
  meaningfulOutput: boolean;
  /** True if this event is the documented terminal event ([DONE], message_stop, response.completed…). */
  terminal: boolean;
}

/** Incremental state for a streamed response. One instance per request. */
export interface StreamAccumulator {
  onEvent(event: SseEvent): StreamEventResult;
  /**
   * Build the final parsed response. `completed` tells whether the transport finished
   * normally. If the final usage event never arrived, usage.complete must be false and
   * missing counters must be null (never 0).
   */
  finish(completed: boolean): ParsedResponse;
}

export interface ProviderCapabilities {
  streaming: boolean;
  reportsCacheRead: boolean;
  reportsCacheWrite: boolean;
  reportsCacheTtlBreakdown: boolean;
  reportsReasoningTokens: boolean;
  /** "explicit" (cache_control / cachedContent), "implicit" (automatic prefix), or both. */
  cachingModel: ('explicit' | 'implicit')[];
  /** Query parameters that carry credentials and must be redacted (e.g. Gemini `key`). */
  secretQueryParams: string[];
  /** Request headers that carry credentials (stripped from anything persisted/logged). */
  secretHeaders: string[];
  docs: { caching: string; usage: string };
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** Documented endpoint patterns, for the dashboard and docs. */
  readonly endpoints: readonly string[];

  /**
   * Recognise a supported endpoint. `path` is after the route prefix and without query string,
   * e.g. "/v1/responses". `query` is the parsed query (for Gemini alt=sse).
   * Return null for anything not explicitly supported (the proxy still forwards it, but
   * only records transport metadata).
   */
  matchEndpoint(method: string, path: string, query: URLSearchParams): EndpointMatch | null;

  /** Parse a JSON request body. Must never throw on unexpected shapes: degrade gracefully. */
  parseRequest(body: unknown, match: EndpointMatch): ParsedRequest;

  /** Parse a complete non-streamed JSON response (or Gemini's JSON-array stream). */
  parseResponse(body: unknown, match: EndpointMatch): ParsedResponse;

  /** Create an accumulator for an SSE response. */
  createStreamAccumulator(match: EndpointMatch): StreamAccumulator;

  /** Extract a provider request id from response headers (x-request-id, request-id…). */
  requestIdFromHeaders(headers: Record<string, string | string[] | undefined>): string | null;
}

/** Thrown nowhere in the hot path; adapters return degraded results instead. */
export class AdapterParseError extends Error {
  override name = 'AdapterParseError';
}
