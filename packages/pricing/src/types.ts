import type { CostBreakdown, NormalizedUsage, ProviderId } from '@contextscope/shared';

/**
 * CONTRACT (implemented in this package): versioned model price table.
 * Prices are integer micro-USD per 1M tokens (e.g. $2.50/MTok = 2_500_000).
 * Costs are integer nano-USD. No floating point in accounting.
 */
export interface ModelPrice {
  provider: ProviderId | string;
  /** Canonical model id, e.g. "gpt-5.6", "claude-sonnet-4-5", "gemini-2.5-flash". */
  model: string;
  /**
   * Model ids that resolve to this price. Exact match first, then the longest matching
   * prefix ending at a dated-snapshot boundary (e.g. "claude-sonnet-4-5-20250929").
   */
  aliases?: string[];
  effectiveDate: string; // YYYY-MM-DD
  source: string; // URL of the official pricing page
  inputPerMTok: number;
  /** null = provider does not offer/report cached reads for this model. */
  cacheReadPerMTok: number | null;
  /** Default cache write rate (Anthropic 5m, OpenAI GPT-5.6+ write). null = no write charge category. */
  cacheWritePerMTok: number | null;
  /** Anthropic 1h TTL writes. */
  cacheWrite1hPerMTok?: number | null;
  outputPerMTok: number;
  /** Prompt-length tier (e.g. Gemini > 200k): when total input exceeds threshold, use these. */
  longContext?: {
    thresholdTokens: number;
    inputPerMTok: number;
    cacheReadPerMTok: number | null;
    cacheWritePerMTok: number | null;
    cacheWrite1hPerMTok?: number | null;
    outputPerMTok: number;
  };
  /** 'catalog' | 'override' */
  origin?: 'catalog' | 'override';
}

export interface PricingCatalog {
  version: string;
  effectiveDate: string;
  source: string;
  models: ModelPrice[];
}

export interface Pricing {
  readonly catalog: PricingCatalog;
  /** Resolve a price; null when unknown (never guessed from another model). */
  lookup(provider: ProviderId | string, model: string | null): ModelPrice | null;
  /**
   * Compute a cost breakdown. Unknown model or missing usage → total null with
   * note "Pricing unavailable" / "Usage unavailable"; never 0.
   */
  cost(provider: ProviderId | string, model: string | null, usage: NormalizedUsage): CostBreakdown;
}

export const COST_DISCLAIMER =
  'Estimated from public list prices. Final provider billing can differ due to discounts, credits, service tiers, batch pricing, data residency, taxes and other factors.';
