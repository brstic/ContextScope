import type { ContextSegment, MeasurementSource, RawSegment } from '@contextscope/shared';
import type { Fingerprinter } from './fingerprint.js';

/**
 * Token estimation. ContextScope does not ship model tokenizers, so per-segment sizes
 * are ESTIMATES (UTF-8 bytes / 4, the commonly documented rule of thumb for English
 * text on BPE tokenizers). They are always labelled 'estimated' and never mixed with
 * provider-reported totals. Multimodal segments get null ('unavailable').
 */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

export const estimateTokens = (
  text: string,
  multimodal: boolean,
): { tokens: number | null; source: MeasurementSource } => {
  if (multimodal) return { tokens: null, source: 'unavailable' };
  const bytes = Buffer.byteLength(text, 'utf8');
  return { tokens: Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE), source: 'estimated' };
};

export interface BuildSegmentsOptions {
  /** Keep segment text on the result (deep capture). Default false. */
  includeContent?: boolean;
  /** Analyse at most this many segments; the rest are dropped and flagged by the caller. */
  maxSegments?: number;
}

/**
 * Turn adapter-extracted raw segments into fingerprinted, sized ContextSegments.
 * The exact fingerprint covers the exact serialized bytes, the normalized fingerprint
 * the content-type-aware canonical form, and the prefix fingerprint the whole ordered
 * prefix up to and including the segment (exact evidence for cache-prefix analysis).
 */
export const buildSegments = (
  raw: RawSegment[],
  fingerprinter: Fingerprinter,
  opts: BuildSegmentsOptions = {},
): ContextSegment[] => {
  const limit = opts.maxSegments ?? raw.length;
  const slice = raw.slice(0, limit);
  const normalizedFps = slice.map((s) => fingerprinter.fp(`${s.kind}\u0000${s.normalizedText}`));
  const counts = new Map<string, number>();
  for (const f of normalizedFps) counts.set(f, (counts.get(f) ?? 0) + 1);

  let prefix: string | null = null;
  return slice.map((s, index) => {
    const exactFingerprint = fingerprinter.fp(s.exactText);
    prefix = fingerprinter.chain(prefix, exactFingerprint);
    const normalizedFingerprint = normalizedFps[index] as string;
    const est = estimateTokens(s.exactText, s.multimodal);
    const seg: ContextSegment = {
      index,
      kind: s.kind,
      role: s.role,
      path: s.path,
      label: s.label,
      byteLength: Buffer.byteLength(s.exactText, 'utf8'),
      charLength: s.exactText.length,
      estimatedTokens: est.tokens,
      tokenSource: est.source,
      exactFingerprint,
      normalizedFingerprint,
      prefixFingerprint: prefix,
      cacheControl: s.cacheControl,
      messageIndex: s.messageIndex,
      multimodal: s.multimodal,
      duplicateCountInRequest: (counts.get(normalizedFingerprint) ?? 1) - 1,
      seenInRequests: null,
    };
    if (opts.includeContent) seg.content = s.plainText || s.exactText;
    return seg;
  });
};

/** Length of the shared exact prefix (in segments) between two segment lists. */
export const sharedPrefixLength = (a: ContextSegment[], b: ContextSegment[]): number => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i]?.prefixFingerprint === b[i]?.prefixFingerprint) i++;
  return i;
};
