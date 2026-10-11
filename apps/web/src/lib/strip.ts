import type { ContextSegment, NormalizedUsage } from '@contextscope/shared';

/**
 * Pure layout math for the context strip (the signature element).
 * Segments keep their cache order; widths are proportional to estimated tokens.
 * Segments with unknown tokens get a fallback weight derived from bytes (~4 bytes/token),
 * so they stay visible but are flagged as estimated.
 */

export interface StripPart {
  index: number;
  kind: string;
  label: string;
  tokens: number | null;
  weight: number;
  /** Percent of strip width, 0..100. */
  pct: number;
  /** Left offset percent. */
  left: number;
  estimated: boolean;
  cacheControl: string | null;
}

export interface StripLayout {
  parts: StripPart[];
  totalWeight: number;
  /** Percent position of the shared-prefix boundary, or null when unknown / nothing shared. */
  boundaryPct: number | null;
}

/** Minimum visible width so tiny segments remain hoverable. Applied only when it does not break the sum. */
export const MIN_PART_PCT = 0.4;

export const segmentWeight = (s: Pick<ContextSegment, 'estimatedTokens' | 'byteLength'>): number => {
  if (s.estimatedTokens !== null && s.estimatedTokens > 0) return s.estimatedTokens;
  if (s.byteLength > 0) return Math.max(1, Math.round(s.byteLength / 4));
  return 0;
};

export const layoutStrip = (
  segments: Pick<
    ContextSegment,
    'index' | 'kind' | 'label' | 'estimatedTokens' | 'tokenSource' | 'byteLength' | 'cacheControl'
  >[],
  sharedSegments: number | null = null,
): StripLayout => {
  const weights = segments.map(segmentWeight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let left = 0;
  const parts: StripPart[] = segments.map((s, i) => {
    const w = weights[i] ?? 0;
    const pct = totalWeight > 0 ? (w / totalWeight) * 100 : segments.length ? 100 / segments.length : 0;
    const part: StripPart = {
      index: s.index,
      kind: s.kind,
      label: s.label,
      tokens: s.estimatedTokens,
      weight: w,
      pct,
      left,
      estimated: s.tokenSource !== 'reported' && s.tokenSource !== 'exact_local',
      cacheControl: s.cacheControl,
    };
    left += pct;
    return part;
  });
  let boundaryPct: number | null = null;
  if (sharedSegments !== null && sharedSegments > 0 && parts.length > 0) {
    const n = Math.min(sharedSegments, parts.length);
    const last = parts[n - 1];
    boundaryPct = last ? Math.min(100, last.left + last.pct) : null;
  }
  return { parts, totalWeight, boundaryPct };
};

export interface UsagePart {
  key: 'uncached' | 'cacheRead' | 'cacheWrite' | 'output';
  label: string;
  tokens: number;
  pct: number;
}

/**
 * Provider-reported usage bar: uncached input / cache read / cache write / output.
 * Returns null when the provider reported no usage at all (render "not reported", never zeros).
 */
export const layoutUsage = (
  u: Pick<
    NormalizedUsage,
    'uncachedInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'totalInputTokens'
  >,
): { parts: UsagePart[]; total: number } | null => {
  const read = u.cacheReadTokens;
  const write = u.cacheWriteTokens;
  let uncached = u.uncachedInputTokens;
  if (uncached === null && u.totalInputTokens !== null) {
    uncached = Math.max(0, u.totalInputTokens - (read ?? 0) - (write ?? 0));
  }
  const raw: [UsagePart['key'], string, number | null][] = [
    ['uncached', 'Uncached input', uncached],
    ['cacheRead', 'Cache read', read],
    ['cacheWrite', 'Cache write', write],
    ['output', 'Output', u.outputTokens],
  ];
  if (raw.every(([, , v]) => v === null)) return null;
  const total = raw.reduce((a, [, , v]) => a + (v ?? 0), 0);
  const parts = raw
    .filter(([, , v]) => v !== null && v > 0)
    .map(([key, label, v]) => ({ key, label, tokens: v ?? 0, pct: total > 0 ? ((v ?? 0) / total) * 100 : 0 }));
  return { parts, total };
};

/** Kind → CSS variable for the strip fill (muted structural tones, not signal colours). */
export const kindColor = (kind: string): string => {
  switch (kind) {
    case 'tool_definition':
    case 'schema':
      return 'var(--k-tool)';
    case 'system':
    case 'config':
      return 'var(--k-system)';
    case 'developer':
      return 'var(--k-developer)';
    case 'user':
      return 'var(--k-user)';
    case 'assistant':
      return 'var(--k-assistant)';
    case 'tool_call':
      return 'var(--k-toolcall)';
    case 'tool_result':
      return 'var(--k-toolresult)';
    case 'document':
    case 'file':
    case 'cached_content_ref':
      return 'var(--k-document)';
    case 'image':
    case 'audio':
      return 'var(--k-media)';
    default:
      return 'var(--k-other)';
  }
};

export const usageColor: Record<UsagePart['key'], string> = {
  uncached: 'var(--uncached)',
  cacheRead: 'var(--cache-read)',
  cacheWrite: 'var(--cache-write)',
  output: 'var(--output)',
};

/** Context Explorer grouping. The last user segment is "Latest user message". */
export const EXPLORER_GROUPS = [
  'System instructions',
  'Developer',
  'Tool definitions',
  'Conversation history',
  'Tool results',
  'Documents',
  'Latest user message',
] as const;
export type ExplorerGroup = (typeof EXPLORER_GROUPS)[number];

export const groupSegments = <T extends Pick<ContextSegment, 'kind' | 'index'>>(
  segments: T[],
): Map<ExplorerGroup, T[]> => {
  const lastUser = [...segments].reverse().find((s) => s.kind === 'user');
  const map = new Map<ExplorerGroup, T[]>(EXPLORER_GROUPS.map((g) => [g, [] as T[]]));
  for (const s of segments) {
    let g: ExplorerGroup;
    if (lastUser && s.index === lastUser.index) g = 'Latest user message';
    else if (s.kind === 'system' || s.kind === 'config') g = 'System instructions';
    else if (s.kind === 'developer') g = 'Developer';
    else if (s.kind === 'tool_definition' || s.kind === 'schema') g = 'Tool definitions';
    else if (s.kind === 'tool_result') g = 'Tool results';
    else if (['document', 'file', 'image', 'audio', 'cached_content_ref'].includes(s.kind)) g = 'Documents';
    else g = 'Conversation history';
    map.get(g)?.push(s);
  }
  return map;
};
