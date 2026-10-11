import { REPEATED_SPAN_MIN_CHARS, WINNOW_K, WINNOW_WINDOW } from './constants.js';
import type { RepeatedSpan } from './types.js';

export interface WinnowOptions {
  k?: number;
  window?: number;
  minLength?: number;
  /** Total characters scanned across all texts; the rest is ignored. */
  maxChars?: number;
}

const BASE = 0x01000193;

/**
 * Repeated-span detection across DIFFERENT texts with winnowing (Schleimer et al., 2003).
 *
 *  1. Rolling 32-bit polynomial hash of every k-gram of every text: O(n).
 *  2. Winnowing: in each window of `window` consecutive k-gram hashes keep the minimum
 *     (rightmost on ties), via a monotonic deque: O(n). Any shared substring of length
 *     ≥ window + k − 1 is guaranteed to share at least one selected fingerprint.
 *  3. Selected fingerprints are indexed by hash; the first occurrence per text is paired with
 *     the first earlier text that has it, verified char by char (hash collisions are
 *     harmless) and extended left/right to the maximal common span. Spans already found on
 *     the same diagonal are skipped, so each character is extended O(1) times per pair.
 *
 * Overall O(n) expected time and O(n / window) memory; never quadratic in text length.
 */
export const findRepeatedSpans = (texts: readonly (string | null | undefined)[], opts: WinnowOptions = {}): RepeatedSpan[] => {
  const k = opts.k ?? WINNOW_K;
  const w = opts.window ?? WINNOW_WINDOW;
  const minLength = Math.max(opts.minLength ?? REPEATED_SPAN_MIN_CHARS, k);
  let budget = opts.maxChars ?? Number.POSITIVE_INFINITY;

  const scanned: (string | null)[] = texts.map((t) => {
    if (!t || budget <= 0) return null;
    const s = t.length > budget ? t.slice(0, budget) : t;
    budget -= s.length;
    return s.length >= minLength ? s : null;
  });

  let pow = 1;
  for (let i = 0; i < k - 1; i++) pow = Math.imul(pow, BASE);

  /** hash → for each text that has it, the first selected position: [textIndex, pos][] */
  const index = new Map<number, number[]>();

  scanned.forEach((text, ti) => {
    if (text === null) return;
    const n = text.length - k + 1;
    const hashes = new Int32Array(n);
    let h = 0;
    for (let i = 0; i < k; i++) h = (Math.imul(h, BASE) + text.charCodeAt(i)) | 0;
    hashes[0] = h;
    for (let i = 1; i < n; i++) {
      h = (Math.imul((h - Math.imul(text.charCodeAt(i - 1), pow)) | 0, BASE) + text.charCodeAt(i + k - 1)) | 0;
      hashes[i] = h;
    }
    const deque = new Int32Array(n);
    let head = 0;
    let tail = 0;
    let lastPicked = -1;
    const seenHere = new Set<number>();
    for (let i = 0; i < n; i++) {
      const hi = hashes[i] as number;
      while (tail > head && (hashes[deque[tail - 1] as number] as number) >= hi) tail--;
      deque[tail++] = i;
      if ((deque[head] as number) <= i - w) head++;
      if (i >= w - 1 || i === n - 1) {
        const pick = deque[head] as number;
        if (pick !== lastPicked) {
          lastPicked = pick;
          const hv = hashes[pick] as number;
          if (!seenHere.has(hv)) {
            seenHere.add(hv);
            const list = index.get(hv);
            if (list) list.push(ti, pick);
            else index.set(hv, [ti, pick]);
          }
        }
      }
    }
  });

  const spans: RepeatedSpan[] = [];
  /** diagonal key → covered [startA, endA) intervals */
  const covered = new Map<string, number[]>();

  for (const list of index.values()) {
    if (list.length < 4) continue;
    const ta = list[0] as number;
    const pa = list[1] as number;
    const a = scanned[ta] as string;
    for (let x = 2; x < list.length; x += 2) {
      const tb = list[x] as number;
      const pb = list[x + 1] as number;
      const b = scanned[tb] as string;
      const diag = `${ta}:${tb}:${pa - pb}`;
      const cov = covered.get(diag);
      if (cov) {
        let inside = false;
        for (let c = 0; c < cov.length; c += 2) {
          if (pa >= (cov[c] as number) && pa < (cov[c + 1] as number)) {
            inside = true;
            break;
          }
        }
        if (inside) continue;
      }
      if (a.slice(pa, pa + k) !== b.slice(pb, pb + k)) continue; // hash collision
      let s = 0;
      while (pa - s - 1 >= 0 && pb - s - 1 >= 0 && a.charCodeAt(pa - s - 1) === b.charCodeAt(pb - s - 1)) s++;
      let e = k;
      while (pa + e < a.length && pb + e < b.length && a.charCodeAt(pa + e) === b.charCodeAt(pb + e)) e++;
      const startA = pa - s;
      const length = s + e;
      if (cov) cov.push(startA, startA + length);
      else covered.set(diag, [startA, startA + length]);
      if (length >= minLength) spans.push({ segmentA: ta, segmentB: tb, offsetA: startA, offsetB: pb - s, length });
    }
  }
  spans.sort((x, y) => x.segmentA - y.segmentA || x.segmentB - y.segmentB || x.offsetA - y.offsetA);
  return spans;
};
