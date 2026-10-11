import { canonicalJson, normalizeText } from '@contextscope/core';
import type { NormalizedUsage, RawSegment, SegmentKind } from '@contextscope/shared';
import { emptyUsage } from '@contextscope/shared';

/** Safe getters: adapters never throw on unexpected shapes, they degrade to null. */

export const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** A finite, non-negative integer, else null (token counters). */
export const num = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) && Number.isInteger(x) && x >= 0 ? x : null;

export const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);

/** Non-empty string or null. */
export const nonEmpty = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? x : null);

export const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

export const rec = (x: unknown): Record<string, unknown> => (isRecord(x) ? x : {});

/** Walk a path of keys / indexes; undefined when any step is missing. */
export const get = (x: unknown, ...keys: (string | number)[]): unknown => {
  let cur: unknown = x;
  for (const k of keys) {
    if (typeof k === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[k];
    } else {
      if (!isRecord(cur)) return undefined;
      cur = cur[k];
    }
  }
  return cur;
};

/** JSON.parse that never throws (undefined on failure). */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** Exact serialized bytes of a request node. */
export const exactOf = (node: unknown): string => {
  try {
    return JSON.stringify(node) ?? 'null';
  } catch {
    return 'null';
  }
};

/** Content-type-aware normalized form: trimmed/collapsed prose for strings, canonical JSON otherwise. */
export const normalizedOf = (node: unknown): string => {
  if (typeof node === 'string') return normalizeText(node);
  try {
    return canonicalJson(node);
  } catch {
    return exactOf(node);
  }
};

export interface SegmentInput {
  kind: SegmentKind;
  role?: string | null;
  path: string;
  label: string;
  node: unknown;
  /** Human-readable text only (never base64 payloads). */
  plainText?: string;
  cacheControl?: string | null;
  messageIndex?: number | null;
  multimodal?: boolean;
}

export const makeSegment = (s: SegmentInput): RawSegment => ({
  kind: s.kind,
  role: s.role ?? null,
  path: s.path,
  label: s.label,
  exactText: exactOf(s.node),
  normalizedText: normalizedOf(s.node),
  plainText: s.plainText ?? (typeof s.node === 'string' ? s.node : ''),
  cacheControl: s.cacheControl ?? null,
  messageIndex: s.messageIndex ?? null,
  multimodal: s.multimodal ?? false,
});

/** Join non-empty text pieces with newlines. */
export const joinText = (parts: (string | null | undefined)[]): string =>
  parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');

/** Canonical JSON of a structured node, as plain text (tool arguments, schemas). */
export const jsonText = (node: unknown): string => (node === undefined ? '' : normalizedOf(node));

/** Clamp a computed counter to >= 0. */
export const nonNeg = (n: number): number => (n < 0 ? 0 : n);

/** Copy numeric counters from `src` into `other` under prefixed names. */
export const collectOther = (
  other: Record<string, number>,
  src: unknown,
  mapping: Record<string, string>,
): void => {
  if (!isRecord(src)) return;
  for (const [from, to] of Object.entries(mapping)) {
    const v = num(src[from]);
    if (v !== null) other[to] = v;
  }
};

/** Usage for a response that delivered no usage object at all. */
export const unavailableUsage = (raw: unknown = null): NormalizedUsage => ({ ...emptyUsage(), raw });

/** Response headers: case-insensitive single value. */
export const headerValue = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null => {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue;
    const val = Array.isArray(v) ? v[0] : v;
    return typeof val === 'string' && val.length > 0 ? val : null;
  }
  return null;
};

/** Extract a short error code from a provider error body: {error:{type|code|status}}. */
export const errorCode = (body: unknown): string | null => {
  const e = get(body, 'error');
  if (isRecord(e))
    return str(e.type) ?? str(e.code) ?? str(e.status) ?? (num(e.code) !== null ? String(e.code) : 'error');
  if (typeof e === 'string') return 'error';
  return null;
};
