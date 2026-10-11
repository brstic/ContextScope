import { describe, expect, it } from 'vitest';
import { emptyUsage, type TraceRecord } from '@contextscope/shared';
import { createStore } from '../src/db/store.js';
import { openDatabase } from '../src/db/migrate.js';
import { CONTENT_KEY } from './pipeline-helpers.js';

const extra = {
  operation: 'x',
  previousRequestId: null,
  firstChangedSegment: null,
  sharedPrefixSegments: null,
  segmentsTruncated: false,
};

const rec = (id: string, startedMs: number, over: Partial<TraceRecord> = {}): TraceRecord => ({
  id,
  providerRequestId: null,
  traceId: null,
  sessionId: 's1',
  projectId: 'default',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  endpoint: '/v1/messages',
  method: 'POST',
  httpStatus: 200,
  state: 'completed',
  errorMessage: null,
  timing: {
    startedAt: new Date(startedMs).toISOString(),
    endedAt: null,
    durationMs: null,
    ttfbMs: null,
    ttftMs: null,
    connectMs: null,
  },
  requestBytes: null,
  responseBytes: null,
  stream: false,
  streamCompleted: null,
  usage: {
    ...emptyUsage(),
    totalInputTokens: 100,
    cacheReadTokens: 0,
    outputTokens: 7,
    source: 'reported',
    complete: true,
  },
  cost: null,
  features: {
    stream: false,
    toolCount: 0,
    toolChoice: null,
    structuredOutput: false,
    reasoning: null,
    cacheControlBlocks: 0,
    attachments: 0,
    messageCount: 1,
    systemBlocks: 0,
    cacheOptions: {},
  },
  segments: [
    {
      index: 0,
      kind: 'user',
      role: 'user',
      path: '/messages/0',
      label: 'm0',
      byteLength: 10,
      charLength: 10,
      estimatedTokens: 3,
      tokenSource: 'estimated',
      exactFingerprint: 'fpA',
      normalizedFingerprint: 'nA',
      prefixFingerprint: 'pA',
      cacheControl: null,
      messageIndex: 0,
      multimodal: false,
      duplicateCountInRequest: 0,
      seenInRequests: null,
    },
  ],
  demo: false,
  origin: 'proxy',
  ...over,
});

const mk = (now?: () => number) =>
  createStore(openDatabase(':memory:'), { contentKey: CONTENT_KEY, ...(now ? { now } : {}) });

describe('store', () => {
  it('round-trips a record; nulls stay null, zero stays zero', () => {
    const s = mk();
    s.insertRecord(rec('r1', 1000), extra);
    const [row] = s.recentForAnalysis({ sessionId: 's1', provider: 'anthropic', model: null, limit: 10 });
    expect(row?.usage.totalInputTokens).toBe(100);
    expect(row?.usage.cacheReadTokens).toBe(0);
    expect(row?.usage.cacheWriteTokens).toBeNull();
    expect(row?.durationMs).toBeNull();
    expect(row?.cost).toBeNull();
    expect(row?.segments[0]?.exactFingerprint).toBe('fpA');
    expect(s.countRequests()).toBe(1);
    expect(s.seenCounts(['fpA', 'zz'], 2000)).toEqual(
      new Map([
        ['fpA', 1],
        ['zz', 0],
      ]),
    );
    expect(s.seenCounts(['fpA'], 1000).get('fpA')).toBe(0);
    expect(s.dbBytes()).toBeGreaterThan(0);
  });

  it('rolls back the whole insert on failure', () => {
    const s = mk();
    const bad = rec('r2', 1000);
    bad.segments.push({ ...(bad.segments[0] as TraceRecord['segments'][number]) }); // duplicate PK (r2, 0)
    expect(() => s.insertRecord(bad, extra)).toThrow();
    expect(s.countRequests()).toBe(0);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM request_usage').get()).toEqual({ n: 0 });
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('encrypts content, rejects a wrong key, honours expiry', () => {
    let t = 1000;
    const opened = openDatabase(':memory:');
    const s = createStore(opened, { contentKey: CONTENT_KEY, now: () => t });
    s.insertRecord(rec('r3', 1000), extra);
    s.putContent('r3', { secret: 'PLAINTEXT-MARKER' }, 5000);
    const raw = JSON.stringify(s.sqlite.prepare('SELECT * FROM captured_content').all());
    expect(raw).not.toContain('PLAINTEXT-MARKER');
    expect(s.getContent('r3')?.payload).toEqual({ secret: 'PLAINTEXT-MARKER' });
    const other = createStore(opened, { contentKey: Buffer.alloc(32, 9) });
    expect(other.getContent('r3')).toBeNull();
    t = 6000;
    expect(s.getContent('r3')).toBeNull();
  });

  it('cleanup removes expired content, old requests and orphan sessions', () => {
    const s = mk();
    const day = 86_400_000;
    s.insertRecord(rec('old', 1000), extra);
    s.insertRecord(rec('new', 100 * day, { sessionId: 's2' }), extra);
    s.putContent('new', { a: 1 }, 50 * day);
    const r = s.cleanup(100 * day, 30);
    expect(r).toEqual({ content: 1, requests: 1 });
    expect(s.countRequests()).toBe(1);
    expect(s.sqlite.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 's2' }]);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM context_segments').get()).toEqual({ n: 1 });
    expect(s.seenCounts(['fpA'], 200 * day).get('fpA')).toBe(1); // counters rebuilt after expiry
  });

  it('seenCounts uses running counters and stays exact for out-of-order requests', () => {
    const s = mk();
    const twice = rec('t1', 1000);
    twice.segments.push({ ...(twice.segments[0] as TraceRecord['segments'][number]), index: 1 }); // same fp twice
    s.insertRecord(twice, extra);
    s.insertRecord(rec('t2', 3000), extra);
    s.insertRecord(rec('t3', 2000), extra); // arrives late
    // a request counts once even if the fingerprint repeats inside it
    expect(s.seenCounts(['fpA'], 10_000).get('fpA')).toBe(3);
    expect(s.seenCounts(['fpA'], 2500).get('fpA')).toBe(2); // straddling → exact fallback
    expect(s.seenCounts(['fpA'], 1000).get('fpA')).toBe(0);
    expect(s.sqlite.prepare('SELECT request_count n FROM context_fingerprints').get()).toEqual({ n: 3 });
  });

  it('a failed insert does not bump fingerprint counters', () => {
    const s = mk();
    const bad = rec('b1', 1000);
    bad.segments.push({ ...(bad.segments[0] as TraceRecord['segments'][number]) });
    expect(() => s.insertRecord(bad, extra)).toThrow();
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM context_fingerprints').get()).toEqual({ n: 0 });
  });

  it('settings round trip as JSON', () => {
    const s = mk();
    expect(s.getSetting('x')).toBeNull();
    s.setSetting('x', { a: [1, 2] });
    expect(s.getSetting('x')).toEqual({ a: [1, 2] });
  });
});
