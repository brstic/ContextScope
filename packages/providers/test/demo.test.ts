import { createAnalyzer, type AnalyzableRequest } from '@contextscope/analyzer';
import { buildSegments, createFingerprinter } from '@contextscope/core';
import { createPricing } from '@contextscope/pricing';
import { importedTraceSchema } from '@contextscope/shared';
import { demoTraces } from '@contextscope/test-fixtures';
import { describe, expect, it } from 'vitest';
import { analyzeCompleteExchange, getAdapter } from '../src/index.js';

const traces = demoTraces();
const fp = createFingerprinter(Buffer.from('deterministic-demo-test-key'));
const requests: AnalyzableRequest[] = traces.map((t) => {
  const url = new URL(t.endpoint, 'https://example.invalid');
  const adapter = getAdapter(t.provider);
  const match = adapter.matchEndpoint(t.method, url.pathname, url.searchParams);
  if (!match) throw new Error(t.endpoint);
  const { request, response } = analyzeCompleteExchange(
    adapter,
    match,
    t.request,
    { json: t.response, sse: t.responseSse },
    t.state === 'completed',
  );
  return {
    id: t.id ?? '',
    provider: t.provider,
    model: request.model,
    sessionId: t.sessionId ?? null,
    startedMs: Date.parse(t.startedAt),
    durationMs: t.durationMs ?? null,
    ttftMs: t.ttftMs ?? null,
    state: t.state ?? 'completed',
    usage: response.usage,
    cost: null,
    features: request.features,
    segments: buildSegments(request.segments, fp),
    segmentText: request.segments.map((s) => s.plainText),
  };
});

describe('demoTraces', () => {
  it('is deterministic and returns independent data', () => {
    expect(demoTraces()).toEqual(traces);
    const a = demoTraces();
    a[0]!.id = 'changed';
    expect(demoTraces()[0]!.id).not.toBe('changed');
  });
  it('provides 120 chronological traces, 40 per provider, five eight-turn sessions each', () => {
    expect(traces).toHaveLength(120);
    expect(new Set(traces.map((t) => t.id)).size).toBe(120);
    for (const provider of ['openai', 'anthropic', 'gemini']) {
      const subset = traces.filter((t) => t.provider === provider);
      expect(subset).toHaveLength(40);
      expect(new Set(subset.map((t) => t.sessionId)).size).toBe(5);
      for (const id of new Set(subset.map((t) => t.sessionId)))
        expect(subset.filter((t) => t.sessionId === id)).toHaveLength(8);
    }
    expect(traces[0]!.startedAt).toBe('2026-10-01T09:00:00.000Z');
    expect(Date.parse(traces.at(-1)!.startedAt) - Date.parse(traces[0]!.startedAt)).toBeGreaterThan(
      9 * 86400000,
    );
    expect(traces.map((t) => t.startedAt)).toEqual(traces.map((t) => t.startedAt).sort());
  });
  it('validates every trace and parses every request and successful response through its adapter', () => {
    traces.forEach((t, i) => {
      expect(importedTraceSchema.safeParse(t).success, t.id).toBe(true);
      const r = requests[i]!;
      expect(r.model).toBeTruthy();
      expect(r.segments.length).toBeGreaterThan(0);
      if (t.state === 'completed') {
        expect(r.usage.complete, t.id).toBe(true);
        expect(r.usage.source).toBe('reported');
        const estimate = Math.ceil(Buffer.byteLength(JSON.stringify(t.request)) / 4);
        expect(r.usage.totalInputTokens).toBe(estimate);
      }
    });
  });
  it('has exactly one unpriced model request', () => {
    const pricing = createPricing();
    expect(requests.filter((r) => !pricing.lookup(r.provider, r.model)).map((r) => r.model)).toEqual([
      'gpt-5.6-custom-ft',
    ]);
  });
  it('includes 429/500 errors, slow responses and complete/truncated streams', () => {
    expect(traces.some((t) => t.httpStatus === 429)).toBe(true);
    expect(traces.some((t) => t.httpStatus === 500)).toBe(true);
    expect(traces.some((t) => (t.durationMs ?? 0) >= 30000)).toBe(true);
    expect(traces.filter((t) => t.responseSse).length).toBeGreaterThan(15);
    const cut = traces.findIndex((t) => t.state === 'client_aborted');
    expect(requests[cut]!.usage.complete).toBe(false);
    expect(requests[cut]!.usage.totalInputTokens).toBeNull();
  });
  it('actually triggers the required analyzer rules', () => {
    const analyzer = createAnalyzer();
    const now = Date.parse('2026-10-11T09:00:00Z');
    const findings = [
      ...requests.flatMap((r) => analyzer.analyzeRequest(r, now)),
      ...analyzer.analyzeHistory(requests, now),
    ];
    const types = new Set(findings.map((f) => f.type));
    // Repeated tool definitions use the same finding type as single-request oversize.
    expect(analyzer.analyzeHistory(requests, now).some((f) => f.type === 'oversized_tool_schemas')).toBe(true);
    for (const rule of [
      'duplicate_segment',
      'oversized_tool_schemas',
      'unstable_prefix',
      'excessive_context_growth',
      'low_cache_reuse',
      'expensive_model_usage',
      'token_spike',
      'slow_request',
      'unexpected_cache_writes',
    ]) {
      expect(types.has(rule), rule).toBe(true);
    }
    // The Anthropic session without cache_control must be explained as such.
    const lowReuse = findings.filter((f) => f.type === 'low_cache_reuse');
    expect(
      lowReuse.some((f) =>
        [f.description, f.recommendation, ...f.evidence].some((t) => t.includes('cache_control')),
      ),
      JSON.stringify(lowReuse.map((f) => [f.title, f.description, f.evidence])),
    ).toBe(true);
  });
});
