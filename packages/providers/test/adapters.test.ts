import type { EndpointMatch, ParsedResponse, ProviderAdapter, SseEvent } from '@contextscope/core';
import type { NormalizedUsage } from '@contextscope/shared';
import { fixtures, type ProviderFixture } from '@contextscope/test-fixtures';
import { describe, expect, it } from 'vitest';
import {
  adapters,
  analyzeCompleteExchange,
  anthropicAdapter,
  anthropicUsage,
  chatUsage,
  geminiAdapter,
  geminiUsage,
  getAdapter,
  JsonArrayStreamParser,
  openaiAdapter,
  responsesUsage,
  SseParser,
} from '../src/index.js';

/** Deterministic PRNG (mulberry32) so random chunking is reproducible. */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randomChunks = (bytes: Uint8Array, rnd: () => number, max = 17): Uint8Array[] => {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    const n = 1 + Math.floor(rnd() * max);
    out.push(bytes.slice(i, i + n));
    i += n;
  }
  return out;
};

const splitPath = (p: string): { path: string; query: URLSearchParams } => {
  const q = p.indexOf('?');
  return q === -1
    ? { path: p, query: new URLSearchParams() }
    : { path: p.slice(0, q), query: new URLSearchParams(p.slice(q + 1)) };
};

const matchOf = (f: ProviderFixture): EndpointMatch => {
  const { path, query } = splitPath(f.path);
  const m = getAdapter(f.provider).matchEndpoint(f.method, path, query);
  if (!m) throw new Error(`no match for ${f.name}`);
  return m;
};

/** Stream a fixture response through the real parsers in random-size chunks. */
const streamFixture = (
  adapter: ProviderAdapter,
  match: EndpointMatch,
  f: ProviderFixture,
  seed: number,
  completed = true,
): ParsedResponse => {
  const acc = adapter.createStreamAccumulator(match);
  const rnd = prng(seed);
  if (f.response.sse !== undefined) {
    const p = new SseParser((e) => acc.onEvent(e));
    for (const c of randomChunks(new TextEncoder().encode(f.response.sse), rnd)) p.push(c);
    p.end();
  } else {
    const p = new JsonArrayStreamParser((o) =>
      acc.onEvent({ event: null, data: JSON.stringify(o), id: null, retry: null }),
    );
    for (const c of randomChunks(new TextEncoder().encode(f.response.jsonArray ?? ''), rnd)) p.push(c);
    p.end();
  }
  return acc.finish(completed);
};

const expectUsage = (actual: NormalizedUsage, expected: Partial<NormalizedUsage>): void => {
  for (const [k, v] of Object.entries(expected)) {
    expect(actual[k as keyof NormalizedUsage], k).toEqual(v);
  }
};

const invariant = (u: NormalizedUsage): void => {
  if (u.totalInputTokens !== null && u.uncachedInputTokens !== null) {
    expect(u.totalInputTokens).toBe(
      u.uncachedInputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
    );
  }
  if (u.reasoningTokens !== null && u.outputTokens !== null)
    expect(u.reasoningTokens).toBeLessThanOrEqual(u.outputTokens);
};

describe('fixture-driven adapter contract', () => {
  it('has fixtures for every provider', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(18);
    expect(new Set(fixtures.map((f) => f.provider))).toEqual(new Set(['openai', 'anthropic', 'gemini']));
  });

  for (const f of fixtures) {
    describe(f.name, () => {
      const adapter = getAdapter(f.provider);
      const match = matchOf(f);
      const streamed = f.response.sse !== undefined || f.response.jsonArray !== undefined;

      it('parses the request', () => {
        const req = adapter.parseRequest(f.requestBody, match);
        expect(req.model).toBe(f.expected.model);
        expect(req.stream).toBe(f.expected.stream);
        if (f.expected.segmentKinds) expect(req.segments.map((s) => s.kind)).toEqual(f.expected.segmentKinds);
        for (const s of req.segments) {
          expect(typeof s.exactText).toBe('string');
          expect(typeof s.normalizedText).toBe('string');
        }
      });

      it('parses the response (complete exchange)', () => {
        const out = analyzeCompleteExchange(
          adapter,
          match,
          f.requestBody,
          { json: f.response.json, sse: f.response.sse, jsonArray: f.response.jsonArray },
          true,
        );
        expectUsage(out.response.usage, f.expected.usage);
        invariant(out.response.usage);
        if (f.expected.providerRequestId !== undefined) {
          const id = out.response.providerRequestId ?? adapter.requestIdFromHeaders(f.response.headers);
          if (f.expected.providerRequestId === null) expect(out.response.providerRequestId).toBeNull();
          else expect(id).toBe(f.expected.providerRequestId);
        }
        if (streamed && f.response.status === 200 && f.expected.usage.complete !== false) {
          expect(out.firstMeaningfulEventIndex).not.toBeNull();
        }
      });

      if (streamed) {
        it('stream accumulator gives the expected usage for random-size chunks', () => {
          for (let seed = 1; seed <= 25; seed++) {
            const r = streamFixture(adapter, match, f, seed);
            expectUsage(r.usage, f.expected.usage);
          }
        });
      }
    });
  }
});

describe('accounting', () => {
  const byName = (part: string): ProviderFixture => {
    const f = fixtures.find((x) => x.name.includes(part));
    if (!f) throw new Error(part);
    return f;
  };

  it('Anthropic total input includes cache read and cache write', () => {
    const u = anthropicUsage({
      input_tokens: 10,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 3000,
      output_tokens: 5,
    });
    expect(u.totalInputTokens).toBe(3210);
    expect(u.uncachedInputTokens).toBe(10);
    expect(u.cacheReadTokens).toBe(3000);
    expect(u.cacheWriteTokens).toBe(200);
  });

  it('Anthropic: absent cache fields count as 0 when input_tokens is present', () => {
    const u = anthropicUsage({ input_tokens: 42, output_tokens: 7 });
    expect(u.totalInputTokens).toBe(42);
    expect(u.cacheReadTokens).toBe(0);
    expect(u.cacheWriteTokens).toBe(0);
  });

  it('Gemini thoughts are not double counted', () => {
    const u = geminiUsage({
      promptTokenCount: 1000,
      cachedContentTokenCount: 600,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 70,
      totalTokenCount: 1120,
      toolUsePromptTokenCount: 9,
    });
    expect(u.totalInputTokens).toBe(1000);
    expect(u.uncachedInputTokens).toBe(400);
    expect(u.cacheReadTokens).toBe(600);
    expect(u.cacheWriteTokens).toBeNull();
    expect(u.outputTokens).toBe(120);
    expect(u.reasoningTokens).toBe(70);
    expect(u.providerTotalTokens).toBe(1120);
    expect(u.other.toolUsePromptTokens).toBe(9);
  });

  it('OpenAI reasoning tokens are a subset of output tokens (chat and responses)', () => {
    const c = chatUsage({
      prompt_tokens: 100,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 60 },
    });
    expect(c.outputTokens).toBe(80);
    expect(c.reasoningTokens).toBe(60);
    const r = responsesUsage({
      input_tokens: 100,
      output_tokens: 80,
      output_tokens_details: { reasoning_tokens: 60 },
    });
    expect(r.outputTokens).toBe(80);
    expect(r.reasoningTokens).toBe(60);
    expect(r.totalInputTokens).toBe(100);
  });

  it('missing usage gives nulls, never 0', () => {
    for (const u of [
      chatUsage(undefined),
      responsesUsage(null),
      anthropicUsage(undefined),
      geminiUsage(undefined),
    ]) {
      expect(u.totalInputTokens).toBeNull();
      expect(u.uncachedInputTokens).toBeNull();
      expect(u.cacheReadTokens).toBeNull();
      expect(u.outputTokens).toBeNull();
      expect(u.reasoningTokens).toBeNull();
      expect(u.source).toBe('unavailable');
    }
    const f = byName('without include_usage');
    const r = streamFixture(openaiAdapter, matchOf(f), f, 3);
    expect(r.usage.totalInputTokens).toBeNull();
    expect(r.usage.outputTokens).toBeNull();
    expect(r.usage.source).toBe('unavailable');
  });

  it('a truncated stream is incomplete with null counters', () => {
    const f = byName('truncated');
    const r = streamFixture(openaiAdapter, matchOf(f), f, 9, false);
    expect(r.usage.complete).toBe(false);
    expect(r.usage.totalInputTokens).toBeNull();
    expect(r.usage.outputTokens).toBeNull();
  });

  it('an anthropic stream cut after message_start is incomplete', () => {
    const f = byName('anthropic SSE');
    const sseText = f.response.sse ?? '';
    const cut = sseText.slice(0, sseText.indexOf('event: ping'));
    const acc = anthropicAdapter.createStreamAccumulator(matchOf(f));
    const p = new SseParser((e: SseEvent) => acc.onEvent(e));
    p.push(new TextEncoder().encode(cut));
    p.end();
    const r = acc.finish(false);
    expect(r.usage.complete).toBe(false);
    expect(r.usage.totalInputTokens).toBe(3550);
  });

  it('a gemini stream cut in the middle of the JSON array is incomplete', () => {
    const f = byName('JSON-array');
    const text = f.response.jsonArray ?? '';
    const out = analyzeCompleteExchange(
      geminiAdapter,
      matchOf(f),
      f.requestBody,
      { jsonArray: text.slice(0, Math.floor(text.length / 2)) },
      false,
    );
    expect(out.response.usage.complete).toBe(false);
  });

  it('never throws on unexpected shapes', () => {
    const odd: unknown[] = [
      null,
      undefined,
      42,
      'x',
      [],
      { messages: 'nope', tools: {}, contents: [null, 3], input: [1, null] },
      { model: 7 },
    ];
    for (const a of Object.values(adapters)) {
      for (const ep of a.endpoints) void ep;
      const m = fixtures.find((f) => f.provider === a.id);
      if (!m) continue;
      const match = matchOf(m);
      for (const body of odd) {
        expect(() => a.parseRequest(body, match)).not.toThrow();
        expect(() => a.parseResponse(body, match)).not.toThrow();
        const acc = a.createStreamAccumulator(match);
        expect(() =>
          acc.onEvent({
            event: 'message_delta',
            data: typeof body === 'string' ? body : '{bad json',
            id: null,
            retry: null,
          }),
        ).not.toThrow();
        expect(() => acc.finish(true)).not.toThrow();
      }
    }
  });
});

describe('endpoint matching', () => {
  const q = new URLSearchParams();
  it('rejects unsupported paths and methods', () => {
    expect(openaiAdapter.matchEndpoint('POST', '/v1/embeddings', q)).toBeNull();
    expect(openaiAdapter.matchEndpoint('GET', '/v1/responses', q)).toBeNull();
    expect(openaiAdapter.matchEndpoint('POST', '/v1/models', q)).toBeNull();
    expect(anthropicAdapter.matchEndpoint('POST', '/v1/messages/count_tokens', q)).toBeNull();
    expect(anthropicAdapter.matchEndpoint('POST', '/v1/complete', q)).toBeNull();
    expect(geminiAdapter.matchEndpoint('POST', '/v1beta/models/gemini-2.5-flash:countTokens', q)).toBeNull();
    expect(geminiAdapter.matchEndpoint('POST', '/v1beta/models/gemini-2.5-flash:embedContent', q)).toBeNull();
    expect(geminiAdapter.matchEndpoint('GET', '/v1beta/models', q)).toBeNull();
  });

  it('recognises supported endpoints', () => {
    expect(openaiAdapter.matchEndpoint('POST', '/v1/responses', q)?.operation).toBeTruthy();
    expect(openaiAdapter.matchEndpoint('POST', '/v1/chat/completions', q)?.operation).toBeTruthy();
    expect(anthropicAdapter.matchEndpoint('POST', '/v1/messages', q)?.provider).toBe('anthropic');
    const g = geminiAdapter.matchEndpoint(
      'POST',
      '/v1/models/gemini-2.5-flash-lite-preview-09.2025:streamGenerateContent',
      new URLSearchParams('alt=sse&key=x'),
    );
    expect(g?.modelFromPath).toBe('gemini-2.5-flash-lite-preview-09.2025');
    expect(g?.streamFromPath).toBe(true);
    expect(g?.sse).toBe(true);
    const g2 = geminiAdapter.matchEndpoint('POST', '/v1alpha/models/gemini-2.5-pro:generateContent', q);
    expect(g2?.streamFromPath).toBe(false);
    expect(g2?.modelFromPath).toBe('gemini-2.5-pro');
  });

  it('declares secret headers and query params', () => {
    expect(openaiAdapter.capabilities.secretHeaders).toContain('authorization');
    expect(anthropicAdapter.capabilities.secretHeaders).toContain('x-api-key');
    expect(geminiAdapter.capabilities.secretQueryParams).toContain('key');
    expect(geminiAdapter.capabilities.secretHeaders).toContain('x-goog-api-key');
  });
});
