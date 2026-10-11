import { describe, expect, it } from 'vitest';
import { buildSegments, createFingerprinter } from '@contextscope/core';
import { emptyUsage, type ContextSegment, type NormalizedUsage, type RawSegment } from '@contextscope/shared';
import {
  alignSegments,
  comparePrefix,
  contextGrowth,
  createAnalyzer,
  findRepeatedSpans,
  prefixStats,
  type AnalyzableRequest,
} from './index.js';

const f = createFingerprinter(Buffer.alloc(32, 3));
const raw = (kind: RawSegment['kind'], text: string, extra: Partial<RawSegment> = {}): RawSegment => ({
  kind,
  role: null,
  path: '/x',
  label: extra.label ?? kind,
  exactText: text,
  normalizedText: text.replace(/\s+/g, ' ').trim(),
  plainText: text,
  cacheControl: null,
  messageIndex: null,
  multimodal: false,
  ...extra,
});
const segs = (r: RawSegment[]): ContextSegment[] => buildSegments(r, f);
const big = (ch: string, tokens: number): string => ch.repeat(tokens * 4);

const usage = (u: Partial<NormalizedUsage> = {}): NormalizedUsage => ({ ...emptyUsage(), source: 'reported', complete: true, ...u });
let seq = 0;
const req = (s: ContextSegment[], extra: Partial<AnalyzableRequest> = {}): AnalyzableRequest => ({
  id: `r${++seq}`,
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  sessionId: 's1',
  startedMs: seq * 1000,
  durationMs: 1000,
  ttftMs: 200,
  state: 'completed',
  usage: emptyUsage(),
  cost: null,
  features: { stream: false, toolCount: 0, toolChoice: null, structuredOutput: false, reasoning: null, cacheControlBlocks: 0, attachments: 0, messageCount: 1, systemBlocks: 1, cacheOptions: {} },
  segments: s,
  ...extra,
});
const NOW = Date.UTC(2026, 9, 11);
const an = createAnalyzer();
const types = (fs: { type: string }[]): string[] => fs.map((x) => x.type);

describe('prefix and alignment', () => {
  const base = [raw('tool_definition', '{"name":"a"}', { label: 'a' }), raw('tool_definition', '{"name":"b"}', { label: 'b' }), raw('system', 'sys'), raw('user', 'hi', { messageIndex: 0 })];
  it('finds the first changed segment (tool change)', () => {
    const a = segs(base);
    const b = segs([base[0] as RawSegment, raw('tool_definition', '{"name":"b","x":1}', { label: 'b' }), ...base.slice(2)]);
    const p = comparePrefix(a, b);
    expect(p.sharedSegments).toBe(1);
    expect(p.firstChangedSegmentIndex).toBe(1);
    expect(p.firstChangedKind).toBe('tool_definition');
    expect(p.firstChangedLabel).toBe('b');
    expect(p.sharedEstimatedTokens).toBe(a[0]?.estimatedTokens);
    expect(p.note).toMatch(/not proof/);
    const al = alignSegments(a, b);
    expect(al.map((x) => x.status)).toEqual(['same', 'changed', 'same', 'same']);
  });

  it('identical requests share everything; multimodal makes shared tokens null', () => {
    const a = segs(base);
    expect(comparePrefix(a, a).firstChangedSegmentIndex).toBeNull();
    const m = segs([raw('image', 'x', { multimodal: true }), ...base]);
    expect(comparePrefix(m, m).sharedEstimatedTokens).toBeNull();
  });

  it('reports added/removed and falls back to greedy for huge inputs', () => {
    const a = segs([raw('user', '1'), raw('user', '2'), raw('user', '3')]);
    const b = segs([raw('user', '1'), raw('assistant', 'x'), raw('user', '3')]);
    expect(alignSegments(a, b).map((x) => x.status)).toEqual(['same', 'removed', 'added', 'same']);
    const n = 2500;
    const A = segs(Array.from({ length: n }, (_, i) => raw('user', `m${i}`)));
    const B = segs(Array.from({ length: n }, (_, i) => raw('user', i % 2 ? `m${i}` : `z${i}`)));
    const t = Date.now();
    const out = alignSegments(A, B);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(out.filter((x) => x.status === 'same').length).toBe(n / 2);
    expect(out.filter((x) => x.bIndex !== null).length).toBe(n);
  });
});

describe('analyzeRequest', () => {
  it('detects a duplicated segment with a defensible reduction and stable ids', () => {
    const s = segs([raw('system', 'sys'), raw('document', big('d', 300)), raw('document', big('d', 300)), raw('user', 'q', { messageIndex: 0 })]);
    const r = req(s);
    const a = an.analyzeRequest(r, NOW);
    const d = a.find((x) => x.type === 'duplicate_segment');
    expect(d?.estimatedTokenReduction).toBe(300);
    expect(d?.segmentIndexes).toEqual([1, 2]);
    expect(an.analyzeRequest(r, NOW + 5).map((x) => x.id)).toEqual(a.map((x) => x.id));
    expect(an.analyzeRequest(req(segs([raw('document', 'small'), raw('document', 'small')])), NOW)).toEqual([]);
  });

  it('duplicate system instructions', () => {
    // Normalized fingerprints include the segment kind, so duplicates are same-kind (e.g. two system blocks).
    expect(types(an.analyzeRequest(req(segs([raw('system', 'Be nice.'), raw('system', 'Be  nice.')])), NOW))).toContain('duplicate_system_instructions');
    expect(types(an.analyzeRequest(req(segs([raw('system', 'A'), raw('system', 'B')])), NOW))).toEqual([]);
  });

  it('oversized tool schemas, large tool output, structured schema', () => {
    const r = req(segs([raw('tool_definition', big('t', 4500)), raw('tool_result', big('r', 9000)), raw('schema', big('s', 1600)), raw('user', big('u', 20000))]));
    const t = types(an.analyzeRequest(r, NOW));
    expect(t).toEqual(expect.arrayContaining(['oversized_tool_schemas', 'large_tool_output', 'repeated_structured_schema']));
    const small = req(segs([raw('tool_definition', big('t', 500)), raw('tool_result', big('r', 100)), raw('schema', big('s', 100)), raw('user', big('u', 5000))]));
    expect(an.analyzeRequest(small, NOW)).toEqual([]);
  });

  it('slow request', () => {
    expect(types(an.analyzeRequest(req([], { durationMs: 31_000 }), NOW))).toEqual(['slow_request']);
    expect(types(an.analyzeRequest(req([], { ttftMs: 11_000 }), NOW))).toEqual(['slow_request']);
    expect(an.analyzeRequest(req([], { durationMs: 5000, ttftMs: 900 }), NOW)).toEqual([]);
  });

  it('unexpected cache writes from reported usage only', () => {
    const hit = req([], { usage: usage({ totalInputTokens: 20_000, cacheWriteTokens: 15_000, cacheReadTokens: 0, uncachedInputTokens: 5_000 }) });
    expect(types(an.analyzeRequest(hit, NOW))).toEqual(['unexpected_cache_writes']);
    const miss = req([], { usage: usage({ totalInputTokens: 20_000, cacheWriteTokens: 5_000 }) });
    expect(an.analyzeRequest(miss, NOW)).toEqual([]);
  });

  it('history duplication', () => {
    const r = req(segs([raw('user', 'hello there', { messageIndex: 0 }), raw('assistant', 'hi', { messageIndex: 1 }), raw('user', 'hello there', { messageIndex: 2 })]));
    expect(types(an.analyzeRequest(r, NOW))).toEqual(['history_duplication']);
    const ok = req(segs([raw('user', 'a', { messageIndex: 0 }), raw('user', 'b', { messageIndex: 1 })]));
    expect(an.analyzeRequest(ok, NOW)).toEqual([]);
  });

  it('winnowing finds a planted 2,000-char span across segments', () => {
    let x = 12345;
    // High bits of the LCG: the low bits cycle quickly and would plant accidental repeats.
    const rnd = (n: number): string =>
      Array.from({ length: n }, () => String.fromCharCode(97 + (((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 16) % 26))).join('');
    const planted = rnd(2000);
    const t1 = rnd(5000) + planted + rnd(3000);
    const t2 = rnd(1000) + planted + rnd(4000);
    const spans = findRepeatedSpans([t1, t2]);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.length).toBeGreaterThanOrEqual(2000);
    expect(spans[0]?.offsetA).toBeLessThanOrEqual(5000);
    const s = segs([raw('document', t1, { label: 'doc1' }), raw('document', t2, { label: 'doc2' })]);
    const fs = an.analyzeRequest(req(s, { segmentText: [t1, t2] }), NOW);
    const d = fs.find((y) => y.type === 'duplicate_segment');
    expect(d?.segmentIndexes).toEqual([0, 1]);
    expect(d?.estimatedTokenReduction).toBeGreaterThanOrEqual(500);
    expect(findRepeatedSpans([rnd(3000), rnd(3000)])).toEqual([]);
  });

  it('winnowing runs on 2M chars in < 2 s', () => {
    let x = 7;
    const rnd = (n: number): string => {
      const a = new Array<string>(n);
      for (let i = 0; i < n; i++) a[i] = String.fromCharCode(97 + ((x = (x * 1103515245 + 12345) >>> 0) % 26));
      return a.join('');
    };
    const texts = [rnd(500_000), rnd(500_000), rnd(500_000), rnd(500_000)];
    const t = Date.now();
    findRepeatedSpans(texts, { maxChars: 2_000_000 });
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('analyzeHistory', () => {
  const tool = raw('tool_definition', big('T', 1200), { label: 'search' });
  const turn = (i: number, extra: Partial<AnalyzableRequest> = {}, toolRaw = tool): AnalyzableRequest =>
    req(segs([toolRaw, raw('system', big('S', 3000)), ...Array.from({ length: i + 1 }, (_, k) => raw('user', `q${k}`, { messageIndex: k }))]), extra);

  it('repeated tool schema, repeated large input, low cache reuse (reported) with cache_control hint', () => {
    const h = Array.from({ length: 6 }, (_, i) => turn(i, { usage: usage({ totalInputTokens: 4300, cacheReadTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 4300, outputTokens: 50 }) }));
    const fs = an.analyzeHistory(h, NOW);
    const t = types(fs);
    expect(t).toEqual(expect.arrayContaining(['oversized_tool_schemas', 'repeated_large_input', 'low_cache_reuse']));
    const low = fs.find((x) => x.type === 'low_cache_reuse');
    expect(low?.evidence.join(' ')).toMatch(/Reported cache reuse is low although \d+% of the prefix was identical/);
    expect(low?.evidence.join(' ')).toMatch(/cache_control/);
    expect(fs.find((x) => x.type === 'oversized_tool_schemas')?.evidence[0]).toBe('The same normalized tool schema appears in 6 captured requests');
    expect(an.analyzeHistory([...h].reverse(), NOW).map((x) => x.id).sort()).toEqual(fs.map((x) => x.id).sort());
    for (const x of fs) if (x.type !== 'duplicate_segment' && x.type !== 'history_duplication') expect(x.estimatedTokenReduction).toBeNull();
  });

  it('low_cache_reuse needs reported usage; good reuse is fine', () => {
    const noUsage = Array.from({ length: 6 }, (_, i) => turn(i));
    expect(types(an.analyzeHistory(noUsage, NOW))).not.toContain('low_cache_reuse');
    const good = Array.from({ length: 6 }, (_, i) => turn(i, { usage: usage({ totalInputTokens: 4300, cacheReadTokens: 4000, cacheWriteTokens: 0, uncachedInputTokens: 300 }) }));
    expect(types(an.analyzeHistory(good, NOW))).not.toContain('low_cache_reuse');
  });

  it('unstable prefix when tool definitions change', () => {
    const h = [turn(0), turn(1, {}, raw('tool_definition', big('U', 1200), { label: 'search' })), turn(2)];
    const fs = an.analyzeHistory(h, NOW);
    const u = fs.find((x) => x.type === 'unstable_prefix');
    expect(u?.description).toMatch(/Tool definition changes may reduce reusable prompt-prefix length/);
    expect(types(an.analyzeHistory([turn(0), turn(1), turn(2)], NOW))).not.toContain('unstable_prefix');
  });

  it('context growth, retrieval payload, token spike', () => {
    const doc = raw('document', 'retrieved chunk', { label: 'chunk' });
    const h = Array.from({ length: 6 }, (_, i) =>
      req(segs([doc, raw('user', big('x', 1000 * (i + 1)), { messageIndex: 0 })]), {
        usage: usage({ totalInputTokens: i === 5 ? 30_000 : 1000 * (i + 1), outputTokens: 10 }),
      }),
    );
    const t = types(an.analyzeHistory(h, NOW));
    expect(t).toEqual(expect.arrayContaining(['excessive_context_growth', 'repeated_retrieval_payload', 'token_spike']));
    const flat = Array.from({ length: 6 }, () => req(segs([raw('user', 'same')]), { usage: usage({ totalInputTokens: 1000 }) }));
    expect(types(an.analyzeHistory(flat, NOW))).toEqual([]);
  });

  it('expensive model usage only for high output price models', () => {
    const mk = (model: string): AnalyzableRequest[] =>
      Array.from({ length: 5 }, () => req([], { provider: 'openai', model, sessionId: null, usage: usage({ totalInputTokens: 100, outputTokens: 20 }) }));
    const e = an.analyzeHistory(mk('gpt-5.5'), NOW).find((x) => x.type === 'expensive_model_usage');
    expect(e?.confidence).toBe('low');
    expect(e?.estimatedTokenReduction).toBeNull();
    expect(types(an.analyzeHistory(mk('gpt-4.1-mini'), NOW))).toEqual([]);
  });

  it('prefixStats and contextGrowth', () => {
    const h = [turn(0), turn(1), turn(2)];
    const st = prefixStats(h);
    expect(st.comparisons).toBe(2);
    expect(st.firstChangeByKind['user']).toBe(2);
    const g = contextGrowth(h);
    expect(g).toHaveLength(3);
    expect(g[1]?.deltaSource).toBe('estimated');
  });
});
