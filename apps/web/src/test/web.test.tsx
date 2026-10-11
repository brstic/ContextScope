import type { Page, RequestSummary } from '@contextscope/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Num } from '../components/Num';
import { TooltipProvider } from '../components/ui/tooltip';
import { formatDelta, formatInt, formatUsd, formatTokens, formatMs, formatPct, UNKNOWN } from '../lib/format';
import { layoutStrip, layoutUsage } from '../lib/strip';
import { useBatchedEvents } from '../lib/useBatchedEvents';
import RequestsPage from '../pages/Requests';

describe('unknown formatting', () => {
  it('renders null/undefined as an em dash, never 0', () => {
    for (const f of [formatUsd, formatTokens, formatMs, formatPct, formatInt]) {
      expect(f(null)).toBe(UNKNOWN);
      expect(f(undefined)).toBe(UNKNOWN);
    }
    expect(formatDelta(null, 5)).toBe(UNKNOWN);
    expect(formatTokens(0)).toBe('0');
  });
  it('Num shows — with an explanation', () => {
    render(<TooltipProvider><Num value={null} /></TooltipProvider>);
    const el = screen.getByLabelText('Not reported by the provider');
    expect(el.textContent).toBe('—');
  });
});

const seg = (index: number, estimatedTokens: number | null, byteLength = 400) => ({
  index, kind: 'user' as const, label: `s${index}`, estimatedTokens, tokenSource: 'estimated' as const, byteLength, cacheControl: null,
});

describe('context strip math', () => {
  it('widths are proportional to estimated tokens and sum to 100', () => {
    const l = layoutStrip([seg(0, 100), seg(1, 300), seg(2, 600)], 2);
    expect(l.parts.map((p) => Math.round(p.pct))).toEqual([10, 30, 60]);
    expect(l.parts[2]?.left).toBeCloseTo(40);
    expect(l.parts.reduce((a, p) => a + p.pct, 0)).toBeCloseTo(100);
    expect(l.boundaryPct).toBeCloseTo(40);
    expect(l.parts[0]?.estimated).toBe(true);
  });
  it('unknown tokens fall back to bytes/4; no boundary without shared segments', () => {
    const l = layoutStrip([seg(0, null, 400), seg(1, 100)], 0);
    expect(l.parts[0]?.weight).toBe(100);
    expect(l.parts[0]?.pct).toBeCloseTo(50);
    expect(l.boundaryPct).toBeNull();
  });
  it('usage bar is null when nothing reported', () => {
    expect(layoutUsage({ uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, totalInputTokens: null })).toBeNull();
    const u = layoutUsage({ uncachedInputTokens: null, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 200, totalInputTokens: 800 });
    expect(u?.parts.map((p) => [p.key, Math.round(p.pct)])).toEqual([['uncached', 20], ['cacheRead', 60], ['output', 20]]);
  });
});

class MockES {
  static last: MockES | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { MockES.last = this; }
  addEventListener(t: string, l: (e: MessageEvent) => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]); }
  removeEventListener() {}
  close() { this.closed = true; }
  emit(type: string, data: unknown) { this.listeners.get(type)?.forEach((l) => l(new MessageEvent(type, { data: JSON.stringify(data) }))); }
}

describe('useBatchedEvents', () => {
  afterEach(() => vi.useRealTimers());
  it('flushes many events as one batch after the interval', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn();
    const { result, unmount } = renderHook(() => useBatchedEvents({ url: '/api/events', onBatch, intervalMs: 250, EventSourceImpl: MockES as unknown as typeof EventSource }));
    const es = MockES.last!;
    act(() => es.onopen?.());
    expect(result.current).toBe('connected');
    act(() => { for (let i = 0; i < 50; i++) es.emit('heartbeat', { type: 'heartbeat', at: String(i) }); });
    expect(onBatch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(260));
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0]?.[0]).toHaveLength(50);
    act(() => es.emit('stats', { type: 'stats', queueDepth: 1, dropped: 0 }));
    act(() => vi.advanceTimersByTime(260));
    expect(onBatch).toHaveBeenCalledTimes(2);
    unmount();
    expect(es.closed).toBe(true);
  });
  it('does not connect while paused', () => {
    MockES.last = null;
    const { result } = renderHook(() => useBatchedEvents({ url: 'x', onBatch: () => {}, paused: true, EventSourceImpl: MockES as unknown as typeof EventSource }));
    expect(result.current).toBe('paused');
    expect(MockES.last).toBeNull();
  });
});

const row = (id: string): RequestSummary => ({
  id, startedAt: '2026-10-11T10:00:00Z', provider: 'anthropic', model: 'claude-sonnet-4-5', endpoint: '/v1/messages', sessionId: 'sess-1', state: 'completed', httpStatus: 200, stream: true,
  totalInputTokens: 12000, outputTokens: 300, cacheReadTokens: 10000, cacheWriteTokens: null, totalNanoUsd: null, durationMs: 1500, ttftMs: 400, findingCount: 0, demo: false,
});

const renderRequests = (page: Page<RequestSummary>) => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith('/api/filters') ? { providers: ['anthropic'], models: [], sessions: 0, states: ['completed'] } : page;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TooltipProvider><MemoryRouter initialEntries={['/requests']}><RequestsPage /></MemoryRouter></TooltipProvider></QueryClientProvider>);
};

describe('Live Requests page', () => {
  it('shows the getting-started state when empty', async () => {
    renderRequests({ items: [], total: 0, page: 1, pageSize: 50 });
    expect(await screen.findByText('No requests captured yet')).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:3377/openai/v1')).toBeTruthy();
    expect(screen.getByText('contextscope demo')).toBeTruthy();
  });
  it('renders rows with unknown cost as —', async () => {
    renderRequests({ items: [row('r1'), row('r2')], total: 2, page: 1, pageSize: 50 });
    const models = await screen.findAllByText('claude-sonnet-4-5');
    expect(models).toHaveLength(2);
    expect(screen.getAllByText('12.0k')).toHaveLength(2);
    const unknownCost = screen.getAllByLabelText(/Not priced/);
    expect(unknownCost[0]?.textContent).toBe('—');
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])).toContain('/api/requests?page=1&pageSize=50&sort=startedAt&dir=desc');
  });
});
