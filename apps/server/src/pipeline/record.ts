import {
  buildSegments,
  redactJson,
  redactText,
  redactUrl,
  type EndpointMatch,
  type Fingerprinter,
  type ParsedRequest,
  type ParsedResponse,
  type ProviderAdapter,
} from '@contextscope/core';
import { analyzeCompleteExchange, type CompleteResponseInput } from '@contextscope/providers';
import type { Pricing } from '@contextscope/pricing';
import {
  emptyUsage,
  type ProviderId,
  type RequestFeatures,
  type RequestState,
  type TraceRecord,
} from '@contextscope/shared';
import type { CapturedExchange } from '../types.js';

export const MAX_ERROR_MESSAGE_CHARS = 500;

/** How the response is handed to buildRecord. */
export type ResponseInput =
  /** Already parsed (proxy stream side-channel). */
  | { kind: 'parsed'; parsed: ParsedResponse }
  /** Provider-native JSON body (or Gemini array of chunks). */
  | { kind: 'json'; body: unknown }
  /** Raw SSE text. */
  | { kind: 'sse'; text: string }
  /** Raw Gemini JSON-array stream text. */
  | { kind: 'jsonArray'; text: string }
  /** Nothing usable (no body, not JSON, too large). */
  | { kind: 'none' };

/** Transport-neutral input: built from a CapturedExchange (proxy) or an ImportedTrace. */
export interface RecordInput {
  id: string;
  provider: ProviderId;
  adapter: ProviderAdapter;
  match: EndpointMatch | null;
  method: string;
  /** Path (+ query) after the provider prefix; redacted again here. */
  endpoint: string;
  sessionId: string | null;
  projectId: string;
  traceId: string | null;
  startedAtMs: number;
  connectMs: number | null;
  ttfbMs: number | null;
  ttftMs: number | null;
  durationMs: number | null;
  httpStatus: number | null;
  responseHeaders: Record<string, string>;
  requestBytes: number | null;
  responseBytes: number | null;
  /** Parsed JSON request body; `undefined` when unavailable (too large / not JSON). */
  requestBody: unknown;
  response: ResponseInput;
  isStream: boolean;
  state: Exclude<RequestState, 'pending'>;
  /** Transport-level error message (redacted again here). */
  errorMessage: string | null;
  streamCompleted: boolean | null;
  /** The full response was observed (not truncated, transport finished normally). */
  responseComplete: boolean;
  demo: boolean;
  origin: TraceRecord['origin'];
}

export interface BuildRecordDeps {
  pricing: Pricing;
  fingerprinter: Fingerprinter;
  maxSegments: number;
  /** Deep capture: keep (redacted) content for the in-memory buffer / encrypted store. */
  includeContent: boolean;
}

export interface DeepContent {
  request: unknown;
  response: unknown;
  segments: (string | null)[];
}

export interface BuiltRecord {
  /** Metadata-only record (segments carry no content). */
  record: TraceRecord;
  operation: string | null;
  segmentsTruncated: boolean;
  /** Redacted content, only when includeContent. */
  content: DeepContent | null;
}

export const EMPTY_FEATURES = (stream = false): RequestFeatures => ({
  stream,
  toolCount: 0,
  toolChoice: null,
  structuredOutput: false,
  reasoning: null,
  cacheControlBlocks: 0,
  attachments: 0,
  messageCount: 0,
  systemBlocks: 0,
  cacheOptions: {},
});

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** Redact credential-looking strings and cap the length. */
export const cleanMessage = (text: string | null | undefined): string | null => {
  if (text === null || text === undefined) return null;
  const t = redactText(String(text)).trim();
  if (t.length === 0) return null;
  return t.length > MAX_ERROR_MESSAGE_CHARS ? `${t.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…` : t;
};

/**
 * Provider error message from an error body:
 *  OpenAI / Anthropic: {error:{message}} (Anthropic also {type:"error", error:{…}}),
 *  Gemini: {error:{message,status}} or [{error:{…}}]. Redacted and truncated.
 */
export const extractErrorMessage = (body: unknown): string | null => {
  const b = Array.isArray(body) ? body[0] : body;
  if (!isRecord(b)) return null;
  const e = b.error;
  if (isRecord(e)) {
    if (typeof e.message === 'string') return cleanMessage(e.message);
    if (typeof e.type === 'string') return cleanMessage(e.type);
    if (typeof e.status === 'string') return cleanMessage(e.status);
    return null;
  }
  if (typeof e === 'string') return cleanMessage(e);
  if (typeof b.message === 'string') return cleanMessage(b.message);
  return null;
};

/** Error message from an SSE text: last `error` event (Anthropic) or a data payload with {error}. */
const sseErrorMessage = (text: string): string | null => {
  const re = /^data:\s?(.*)$/gm;
  let msg: string | null = null;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null && n++ < 100_000) {
    const line = m[1] ?? '';
    if (!line.includes('"error"')) continue;
    try {
      const found = extractErrorMessage(JSON.parse(line));
      if (found !== null) msg = found;
    } catch {
      // not JSON
    }
  }
  return msg;
};

const tryJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

/** Classify a captured response body for buildRecord. */
export const responseInputFromExchange = (ex: CapturedExchange): ResponseInput => {
  if (ex.streamResult) return { kind: 'parsed', parsed: ex.streamResult };
  if (!ex.responseBody || ex.responseBody.length === 0) return { kind: 'none' };
  // ResponseObserver already stores the DECODED bytes (bounded) in responseBody; the
  // content-encoding header describes the wire bytes, so decoding again would fail.
  const text = ex.responseBody.toString('utf8');
  const ct = (ex.responseContentType ?? ex.responseHeaders['content-type'] ?? '').toLowerCase();
  const ok = ex.httpStatus === null || ex.httpStatus < 400;
  if (ct.includes('text/event-stream')) return { kind: 'sse', text };
  if (ok && ex.match?.streamFromPath && !ex.match.sse) return { kind: 'jsonArray', text };
  const trimmed = text.trimStart();
  if (ex.isStream && /^(data|event|id|retry)?:/.test(trimmed)) return { kind: 'sse', text };
  const parsed = tryJson(text);
  return parsed.ok ? { kind: 'json', body: parsed.value } : { kind: 'none' };
};

/** CapturedExchange (proxy) → RecordInput. */
export const exchangeToInput = (ex: CapturedExchange): RecordInput => {
  let requestBody: unknown = undefined;
  if (ex.requestBody && !ex.requestBodyTruncated && ex.requestBody.length > 0) {
    const r = tryJson(ex.requestBody.toString('utf8'));
    if (r.ok) requestBody = r.value;
  }
  const finishedNormally = ex.state === 'completed' && ex.streamCompleted !== false;
  return {
    id: ex.id,
    provider: ex.route.protocol,
    adapter: ex.route.adapter,
    match: ex.match,
    method: ex.method,
    endpoint: ex.redactedPath,
    sessionId: ex.sessionId,
    projectId: ex.projectId,
    traceId: ex.traceId,
    startedAtMs: ex.startedAtMs,
    connectMs: ex.connectMs,
    ttfbMs: ex.ttfbMs,
    ttftMs: ex.ttftMs,
    durationMs: ex.durationMs,
    httpStatus: ex.httpStatus,
    responseHeaders: ex.responseHeaders,
    requestBytes: ex.requestBytes,
    responseBytes: ex.responseBytes,
    requestBody,
    response: responseInputFromExchange(ex),
    isStream: ex.isStream,
    state: ex.state,
    errorMessage: ex.errorMessage,
    streamCompleted: ex.streamCompleted,
    responseComplete: finishedNormally && !ex.responseTruncated,
    demo: false,
    origin: 'proxy',
  };
};

const toCompleteInput = (r: ResponseInput): CompleteResponseInput | null => {
  if (r.kind === 'sse') return { sse: r.text };
  if (r.kind === 'jsonArray') return { jsonArray: r.text };
  return null;
};

const emptyResponse = (): ParsedResponse => ({
  model: null,
  providerRequestId: null,
  usage: emptyUsage(),
  finishReason: null,
  outputChars: null,
});

const contentOfResponse = (r: ResponseInput): unknown => {
  switch (r.kind) {
    case 'json':
      return redactJson(r.body);
    case 'sse':
    case 'jsonArray':
      return redactText(r.text);
    default:
      return null;
  }
};

/**
 * Build a metadata TraceRecord from one exchange. Pure (no I/O, no clock): the same code
 * path for proxied traffic, imports and demo data. Never throws on odd provider shapes:
 * adapters degrade, and anything unparseable yields empty features / no segments / null usage.
 */
export const buildRecord = (input: RecordInput, deps: BuildRecordDeps): BuiltRecord => {
  const { adapter, match } = input;
  const hasBody = input.requestBody !== undefined && input.requestBody !== null;

  let request: ParsedRequest | null = null;
  let response: ParsedResponse = emptyResponse();
  if (match) {
    const stream = toCompleteInput(input.response);
    if (stream && hasBody) {
      const a = analyzeCompleteExchange(adapter, match, input.requestBody, stream, input.responseComplete);
      request = a.request;
      response = a.response;
    } else {
      if (hasBody) request = adapter.parseRequest(input.requestBody, match);
      if (stream) {
        response = analyzeCompleteExchange(adapter, match, null, stream, input.responseComplete).response;
      } else if (input.response.kind === 'parsed') {
        response = input.response.parsed;
      } else if (input.response.kind === 'json') {
        response = adapter.parseResponse(input.response.body, match);
      }
    }
  }

  const status = input.httpStatus;
  const failed = status !== null && status >= 400;
  // Usage is complete only when the provider reported it and the whole response was observed.
  const usage = { ...response.usage, other: { ...response.usage.other } };
  if (!input.responseComplete || input.streamCompleted === false || input.state !== 'completed')
    usage.complete = false;
  if (usage.source !== 'reported') usage.complete = false;

  const rawSegments = request?.segments ?? [];
  const segments = buildSegments(rawSegments, deps.fingerprinter, {
    includeContent: deps.includeContent,
    maxSegments: deps.maxSegments,
  });
  const segmentText = deps.includeContent
    ? segments.map((s) => (s.content == null ? null : redactText(s.content)))
    : null;
  for (const s of segments) delete s.content;

  const model = request?.model ?? response.model ?? match?.modelFromPath ?? null;
  const stream = (request?.stream ?? false) || (match?.streamFromPath ?? false) || input.isStream;

  let errorMessage: string | null = null;
  if (input.state !== 'completed') errorMessage = cleanMessage(input.errorMessage);
  if (errorMessage === null && failed) {
    if (input.response.kind === 'json') errorMessage = extractErrorMessage(input.response.body);
    else if (input.response.kind === 'sse') errorMessage = sseErrorMessage(input.response.text);
  }
  if (errorMessage === null && input.response.kind === 'sse' && response.finishReason === null) {
    // streams that end in an error event (e.g. Anthropic overloaded_error) with HTTP 200
    const m = sseErrorMessage(input.response.text);
    if (m !== null) errorMessage = m;
  }

  const providerRequestId = response.providerRequestId ?? adapter.requestIdFromHeaders(input.responseHeaders);

  const startedAt = new Date(input.startedAtMs).toISOString();
  const endedAt =
    input.durationMs !== null ? new Date(input.startedAtMs + input.durationMs).toISOString() : null;

  const record: TraceRecord = {
    id: input.id,
    providerRequestId: providerRequestId === null ? null : redactText(providerRequestId).slice(0, 256),
    traceId: input.traceId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    provider: input.provider,
    model,
    endpoint: redactText(redactUrl(input.endpoint)),
    method: input.method.toUpperCase(),
    httpStatus: status,
    state: input.state,
    errorMessage,
    timing: {
      startedAt,
      endedAt,
      durationMs: input.durationMs,
      ttfbMs: input.ttfbMs,
      ttftMs: input.ttftMs,
      connectMs: input.connectMs,
    },
    requestBytes: input.requestBytes,
    responseBytes: input.responseBytes,
    stream,
    streamCompleted: input.streamCompleted,
    usage,
    cost: deps.pricing.cost(input.provider, model, usage),
    features: request?.features ?? EMPTY_FEATURES(stream),
    segments,
    demo: input.demo,
    origin: input.origin,
  };

  return {
    record,
    operation: match?.operation ?? null,
    segmentsTruncated: rawSegments.length > segments.length,
    content: segmentText
      ? {
          request: hasBody ? redactJson(input.requestBody) : null,
          response: contentOfResponse(input.response),
          segments: segmentText,
        }
      : null,
  };
};
