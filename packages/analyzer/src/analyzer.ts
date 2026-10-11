import { createPricing, type Pricing } from '@contextscope/pricing';
import { analyzeHistory } from './history-rules.js';
import { alignSegments, comparePrefix } from './prefix.js';
import { analyzeRequest } from './request-rules.js';
import { DEFAULT_ANALYZER_LIMITS, type Analyzer, type AnalyzerLimits } from './types.js';

/**
 * Create a deterministic analyzer. `pricing` is only used by the expensive-model rule;
 * the default catalog is used when none is given.
 */
export const createAnalyzer = (limits: Partial<AnalyzerLimits> = {}, pricing?: Pricing): Analyzer => {
  const l: AnalyzerLimits = { ...DEFAULT_ANALYZER_LIMITS, ...limits };
  const p = pricing ?? createPricing();
  return {
    comparePrefix: (a, b) => comparePrefix(a.slice(0, l.maxSegments), b.slice(0, l.maxSegments)),
    alignSegments: (a, b) => alignSegments(a.slice(0, l.maxSegments), b.slice(0, l.maxSegments)),
    analyzeRequest: (req, now) => analyzeRequest(req, now, l),
    analyzeHistory: (history, now) => analyzeHistory(history, now, l, p),
  };
};
