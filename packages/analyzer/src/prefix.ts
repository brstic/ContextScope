import type { ContextSegment } from '@contextscope/shared';
import { sharedPrefixLength } from '@contextscope/core';
import { ALIGN_MAX_CELLS } from './constants.js';
import type { AnalyzableRequest, ContextGrowthPoint, PrefixResult, PrefixStats, SegmentAlignment } from './types.js';

/** Sum of estimates, or null when any of them is unknown (never treat unknown as 0). */
export const sumEstimated = (segs: readonly ContextSegment[]): number | null => {
  let total = 0;
  for (const s of segs) {
    if (s.estimatedTokens === null) return null;
    total += s.estimatedTokens;
  }
  return total;
};

export const PREFIX_NOTE =
  'Structural comparison of the request prefix by exact fingerprints. Identical leading segments are eligible ' +
  'for provider prompt caching; this is evidence about cache eligibility, not proof of a provider cache hit or miss ' +
  '(only the reported usage says what was actually read from cache).';

/** Exact-prefix comparison of b against the earlier request a (prefix fingerprint chain). */
export const comparePrefix = (a: ContextSegment[], b: ContextSegment[]): PrefixResult => {
  const shared = sharedPrefixLength(a, b);
  const changed = shared < b.length ? b[shared] : undefined;
  return {
    sharedSegments: shared,
    sharedEstimatedTokens: sumEstimated(b.slice(0, shared)),
    firstChangedSegmentIndex: changed ? shared : null,
    firstChangedKind: changed?.kind ?? null,
    firstChangedLabel: changed?.label ?? null,
    totalSegments: b.length,
    note: PREFIX_NOTE,
  };
};

type Op = { t: 'same'; a: number; b: number } | { t: 'del'; a: number } | { t: 'ins'; b: number };

/** Classic LCS table on the (already trimmed) middle part. O(n·m) cells, bounded by the caller. */
const lcsOps = (a: string[], b: string[], aOff: number, bOff: number): Op[] => {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'same', a: aOff + i++, b: bOff + j++ });
    } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0)) {
      ops.push({ t: 'del', a: aOff + i++ });
    } else {
      ops.push({ t: 'ins', b: bOff + j++ });
    }
  }
  while (i < n) ops.push({ t: 'del', a: aOff + i++ });
  while (j < m) ops.push({ t: 'ins', b: bOff + j++ });
  return ops;
};

/**
 * Linear greedy fallback for huge inputs: each a-segment matches the next unused occurrence
 * of its fingerprint in b after the last match. O((n + m) · log) and memory O(m).
 */
const greedyOps = (a: string[], b: string[], aOff: number, bOff: number): Op[] => {
  const positions = new Map<string, number[]>();
  b.forEach((fp, j) => {
    const list = positions.get(fp);
    if (list) list.push(j);
    else positions.set(fp, [j]);
  });
  const cursor = new Map<string, number>();
  const ops: Op[] = [];
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    const fp = a[i] as string;
    const list = positions.get(fp);
    let k = cursor.get(fp) ?? 0;
    while (list && k < list.length && (list[k] as number) < j) k++;
    cursor.set(fp, k);
    if (list && k < list.length) {
      const target = list[k] as number;
      while (j < target) ops.push({ t: 'ins', b: bOff + j++ });
      ops.push({ t: 'same', a: aOff + i, b: bOff + j++ });
      cursor.set(fp, k + 1);
    } else {
      ops.push({ t: 'del', a: aOff + i });
    }
  }
  while (j < b.length) ops.push({ t: 'ins', b: bOff + j++ });
  return ops;
};

/**
 * LCS-style alignment by exact fingerprint. Common prefix/suffix are trimmed first; if the
 * remaining a.length × b.length exceeds ALIGN_MAX_CELLS a linear greedy matcher is used.
 * A removed and an added segment at the same position of a gap with the same kind and
 * label are reported as one 'changed' entry.
 */
export const alignSegments = (
  a: ContextSegment[],
  b: ContextSegment[],
  maxCells: number = ALIGN_MAX_CELLS,
): SegmentAlignment[] => {
  const fa = a.map((s) => s.exactFingerprint);
  const fb = b.map((s) => s.exactFingerprint);
  let start = 0;
  while (start < fa.length && start < fb.length && fa[start] === fb[start]) start++;
  let endA = fa.length;
  let endB = fb.length;
  while (endA > start && endB > start && fa[endA - 1] === fb[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = fa.slice(start, endA);
  const midB = fb.slice(start, endB);
  const middle =
    midA.length * midB.length > maxCells ? greedyOps(midA, midB, start, start) : lcsOps(midA, midB, start, start);
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ t: 'same', a: i, b: i });
  ops.push(...middle);
  for (let i = 0; i < fa.length - endA; i++) ops.push({ t: 'same', a: endA + i, b: endB + i });

  const out: SegmentAlignment[] = [];
  let dels: number[] = [];
  let ins: number[] = [];
  const flush = (): void => {
    const n = Math.max(dels.length, ins.length);
    for (let k = 0; k < n; k++) {
      const ai = dels[k];
      const bi = ins[k];
      const sa = ai === undefined ? undefined : a[ai];
      const sb = bi === undefined ? undefined : b[bi];
      if (ai !== undefined && bi !== undefined && sa && sb && sa.kind === sb.kind && sa.label === sb.label) {
        out.push({ status: 'changed', aIndex: ai, bIndex: bi });
        continue;
      }
      if (ai !== undefined) out.push({ status: 'removed', aIndex: ai, bIndex: null });
      if (bi !== undefined) out.push({ status: 'added', aIndex: null, bIndex: bi });
    }
    dels = [];
    ins = [];
  };
  for (const op of ops) {
    if (op.t === 'del') dels.push(op.a);
    else if (op.t === 'ins') ins.push(op.b);
    else {
      flush();
      out.push({ status: 'same', aIndex: op.a, bIndex: op.b });
    }
  }
  flush();
  return out;
};

/** Group key used by history analysis: session id, else provider + model. */
export const groupKey = (r: AnalyzableRequest): string =>
  r.sessionId !== null ? `session:${r.sessionId}` : `model:${r.provider}:${r.model ?? 'unknown'}`;

/** Stable chronological order (oldest first); ties keep input order. */
export const chronological = <T extends AnalyzableRequest>(history: readonly T[]): T[] =>
  history
    .map((r, i) => ({ r, i }))
    .sort((x, y) => x.r.startedMs - y.r.startedMs || x.i - y.i)
    .map((x) => x.r);

export const groupRequests = (history: readonly AnalyzableRequest[]): Map<string, AnalyzableRequest[]> => {
  const groups = new Map<string, AnalyzableRequest[]>();
  for (const r of chronological(history)) {
    const k = groupKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return groups;
};

/** Exact-prefix reuse between consecutive requests of each session/group. */
export const prefixStats = (history: readonly AnalyzableRequest[]): PrefixStats => {
  let comparisons = 0;
  let ratioSum = 0;
  const firstChangeByKind: Record<string, number> = {};
  for (const group of groupRequests(history).values()) {
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1] as AnalyzableRequest;
      const cur = group[i] as AnalyzableRequest;
      const p = comparePrefix(prev.segments, cur.segments);
      comparisons++;
      ratioSum += p.totalSegments === 0 ? 1 : p.sharedSegments / p.totalSegments;
      if (p.firstChangedKind !== null) firstChangeByKind[p.firstChangedKind] = (firstChangeByKind[p.firstChangedKind] ?? 0) + 1;
    }
  }
  return { comparisons, avgSharedSegmentRatio: comparisons ? ratioSum / comparisons : null, firstChangeByKind };
};

/** Per-turn context size of the given (chronologically sorted) requests. */
export const contextGrowth = (history: readonly AnalyzableRequest[]): ContextGrowthPoint[] => {
  const points: ContextGrowthPoint[] = [];
  chronological(history).forEach((r, turn) => {
    const est = sumEstimated(r.segments);
    const rep = r.usage.source === 'reported' ? r.usage.totalInputTokens : null;
    const prev = points[points.length - 1];
    let deltaTokens: number | null = null;
    let deltaSource: ContextGrowthPoint['deltaSource'] = null;
    if (prev) {
      if (rep !== null && prev.reportedInputTokens !== null) {
        deltaTokens = rep - prev.reportedInputTokens;
        deltaSource = 'reported';
      } else if (est !== null && prev.estimatedInputTokens !== null) {
        deltaTokens = est - prev.estimatedInputTokens;
        deltaSource = 'estimated';
      }
    }
    points.push({
      requestId: r.id,
      startedMs: r.startedMs,
      turn,
      estimatedInputTokens: est,
      reportedInputTokens: rep,
      deltaTokens,
      deltaSource,
    });
  });
  return points;
};
