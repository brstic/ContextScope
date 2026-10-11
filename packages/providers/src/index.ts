import type {
  EndpointMatch,
  ParsedRequest,
  ParsedResponse,
  ProviderAdapter,
  SseEvent,
} from '@contextscope/core';
import type { ProviderId } from '@contextscope/shared';
import { anthropicAdapter } from './anthropic.js';
import { geminiAdapter } from './gemini.js';
import { JsonArrayStreamParser } from './json-array-stream.js';
import { openaiAdapter } from './openai.js';
import { SseParser } from './sse.js';

export { SseParser } from './sse.js';
export type { SseParserOptions } from './sse.js';
export { JsonArrayStreamParser } from './json-array-stream.js';
export type { JsonArrayStreamParserOptions } from './json-array-stream.js';
export { openaiAdapter, responsesUsage, chatUsage } from './openai.js';
export { anthropicAdapter, anthropicUsage } from './anthropic.js';
export { geminiAdapter, geminiUsage } from './gemini.js';

export const adapters: Record<ProviderId, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
};

export const getAdapter = (id: ProviderId): ProviderAdapter => adapters[id];

export interface CompleteResponseInput {
  /** Provider-native JSON body (or, for Gemini, an array of chunks). */
  json?: unknown;
  /** Raw SSE text. */
  sse?: string;
  /** Raw Gemini JSON-array stream text (streamGenerateContent without alt=sse). */
  jsonArray?: string;
}

export interface CompleteExchangeAnalysis {
  request: ParsedRequest;
  response: ParsedResponse;
  /** Index (0-based, among dispatched events/chunks) of the first event carrying output; null if none. */
  firstMeaningfulEventIndex: number | null;
}

/**
 * Run the same parsing the proxy does on a fully captured exchange (used by import and demo).
 * Streams go through SseParser / JsonArrayStreamParser and the adapter's stream accumulator.
 */
export const analyzeCompleteExchange = (
  adapter: ProviderAdapter,
  match: EndpointMatch,
  requestBody: unknown,
  response: CompleteResponseInput,
  completed: boolean,
): CompleteExchangeAnalysis => {
  const request = adapter.parseRequest(requestBody, match);
  let firstMeaningfulEventIndex: number | null = null;

  if (response.sse !== undefined || response.jsonArray !== undefined) {
    const acc = adapter.createStreamAccumulator(match);
    let index = 0;
    const feed = (e: SseEvent): void => {
      const r = acc.onEvent(e);
      if (r.meaningfulOutput && firstMeaningfulEventIndex === null) firstMeaningfulEventIndex = index;
      index++;
    };
    const bytes = new TextEncoder().encode(response.sse ?? response.jsonArray ?? '');
    if (response.sse !== undefined) {
      const p = new SseParser(feed);
      p.push(bytes);
      p.end();
    } else {
      const p = new JsonArrayStreamParser((o) =>
        feed({ event: null, data: JSON.stringify(o), id: null, retry: null }),
      );
      p.push(bytes);
      p.end();
    }
    return { request, response: acc.finish(completed), firstMeaningfulEventIndex };
  }

  const parsed = adapter.parseResponse(response.json ?? null, match);
  if (!completed && parsed.usage.source !== 'reported') parsed.usage.complete = false;
  return { request, response: parsed, firstMeaningfulEventIndex };
};
