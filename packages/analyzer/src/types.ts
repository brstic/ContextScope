import type {
  ContextSegment,
  Finding,
  NormalizedUsage,
  ProviderId,
  RequestFeatures,
  RequestState,
  CostBreakdown,
} from '@contextscope/shared';

/**
 * CONTRACT (implemented in this package): deterministic analysis.
 * No network, no LLM calls, no clocks except the `now` passed in.
 */

/** Compact view of a request the analyzer needs. Content is never required. */
export interface AnalyzableRequest {
  id: string;
  provider: ProviderId;
  model: string | null;
  sessionId: string | null;
  startedMs: number;
  durationMs: number | null;
  ttftMs: number | null;
  state: RequestState;
  usage: NormalizedUsage;
  cost: CostBreakdown | null;
  features: RequestFeatures;
  segments: ContextSegment[];
  /** Plain text by segment index, only when deep capture is on (enables repeated-span detection). */
  segmentText?: (string | null)[];
}

export interface PrefixResult {
  sharedSegments: number;
  sharedEstimatedTokens: number | null;
  firstChangedSegmentIndex: number | null;
  firstChangedKind: string | null;
  firstChangedLabel: string | null;
  totalSegments: number;
  /** Plain-language explanation; never claims a provider cache miss. */
  note: string;
}

export interface SegmentAlignment {
  status: 'same' | 'changed' | 'added' | 'removed';
  aIndex: number | null;
  bIndex: number | null;
}

/** Summary of exact-prefix reuse between consecutive requests (see prefixStats). */
export interface PrefixStats {
  /** Number of consecutive request pairs compared (within the same session/group). */
  comparisons: number;
  /** Mean of sharedSegments / segments-of-later-request; null when nothing was compared. */
  avgSharedSegmentRatio: number | null;
  /** How often the first changed segment had a given kind. */
  firstChangeByKind: Record<string, number>;
}

/** One request in a context-growth series (see contextGrowth). */
export interface ContextGrowthPoint {
  requestId: string;
  startedMs: number;
  turn: number;
  /** Sum of segment estimates (labelled estimated), null if any segment has no estimate. */
  estimatedInputTokens: number | null;
  /** Provider-reported total input tokens, null when not reported. */
  reportedInputTokens: number | null;
  /** Change vs the previous point, using the reported value when both have one, else estimated. */
  deltaTokens: number | null;
  deltaSource: 'reported' | 'estimated' | null;
}

/** A repeated text span found by winnowing (deep capture only). */
export interface RepeatedSpan {
  /** Segment indexes (in the request) of the two occurrences. */
  segmentA: number;
  segmentB: number;
  offsetA: number;
  offsetB: number;
  length: number;
}

export interface AnalyzerLimits {
  /** Max segments considered per request. */
  maxSegments: number;
  /** Max characters scanned for repeated spans per request. */
  maxSpanChars: number;
  /** Max requests in a history window. */
  maxHistory: number;
}

export const DEFAULT_ANALYZER_LIMITS: AnalyzerLimits = {
  maxSegments: 2000,
  maxSpanChars: 2_000_000,
  maxHistory: 500,
};

export interface Analyzer {
  /** Exact-prefix comparison of b against the earlier request a. */
  comparePrefix(a: ContextSegment[], b: ContextSegment[]): PrefixResult;
  /** LCS-style alignment by exact fingerprint (bounded; falls back to positional on huge inputs). */
  alignSegments(a: ContextSegment[], b: ContextSegment[]): SegmentAlignment[];
  /** Findings computable from one request alone (duplicates in request, large tool outputs, slow…). */
  analyzeRequest(req: AnalyzableRequest, now: number): Finding[];
  /**
   * Cross-request findings over a bounded history window (chronological, oldest first),
   * e.g. repeated tool schemas, unstable prefixes, low cache reuse, context growth, token spikes.
   * Finding ids must be deterministic for the same input (stable dedup).
   */
  analyzeHistory(history: AnalyzableRequest[], now: number): Finding[];
}
