import { describe, expect, it } from 'vitest';
import { emptyUsage, type NormalizedUsage } from '@contextscope/shared';
import {
  COST_DISCLAIMER,
  DEFAULT_CATALOG,
  createPricing,
  loadPricingOverrides,
  netCacheEffectNanoUsd,
  tokensCostNano,
  type ModelPrice,
} from './index.js';

const usage = (u: Partial<NormalizedUsage>): NormalizedUsage => ({
  ...emptyUsage(),
  source: 'reported',
  complete: true,
  ...u,
});

const override = (p: Partial<ModelPrice> & { model: string; provider: string }): ModelPrice => ({
  effectiveDate: '2026-10-11',
  source: 'test',
  inputPerMTok: 2_500_000,
  cacheReadPerMTok: null,
  cacheWritePerMTok: null,
  outputPerMTok: 10_000_000,
  ...p,
});

describe('catalog', () => {
  it('has integer prices, a source URL and effective date for every model', () => {
    expect(DEFAULT_CATALOG.version).toBe('2026-10-11');
    for (const m of DEFAULT_CATALOG.models) {
      expect(m.source).toMatch(/^https:\/\//);
      expect(m.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const v of [m.inputPerMTok, m.outputPerMTok, m.cacheReadPerMTok, m.cacheWritePerMTok]) {
        if (v !== null) expect(Number.isSafeInteger(v)).toBe(true);
      }
    }
    const keys = DEFAULT_CATALOG.models.map((m) => `${m.provider}|${m.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('exports the disclaimer', () => {
    expect(COST_DISCLAIMER).toMatch(/list prices/);
  });
});

describe('cost math', () => {
  it('is exact integer nano-USD (1,234,567 tokens at $2.50/MTok)', () => {
    // 1_234_567 × 2_500_000 / 1000 = 3_086_417_500 exactly.
    expect(tokensCostNano(1_234_567, 2_500_000)).toBe(3_086_417_500n);
    const p = createPricing([override({ provider: 'openai', model: 'test-model', outputPerMTok: 0 })]);
    const c = p.cost('openai', 'test-model', usage({ totalInputTokens: 1_234_567, uncachedInputTokens: 1_234_567, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }));
    expect(c.uncachedInputNanoUsd).toBe(3_086_417_500);
    expect(c.totalNanoUsd).toBe(3_086_417_500);
    expect(c.confidence).toBe('high');
  });

  it('rounds half up', () => {
    expect(tokensCostNano(1, 1_500)).toBe(2n); // 1.5 nano → 2
    expect(tokensCostNano(1, 1_499)).toBe(1n);
    expect(tokensCostNano(3, 100_000)).toBe(300n);
  });

  it('prices OpenAI cached input and GPT-5.6 cache writes from the catalog', () => {
    const p = createPricing();
    const c = p.cost('openai', 'gpt-5.6-terra', usage({ totalInputTokens: 10_000, uncachedInputTokens: 4_000, cacheReadTokens: 5_000, cacheWriteTokens: 1_000, outputTokens: 500 }));
    // input $2.00, cached $0.20, write $2.50, output $12.00
    expect(c.uncachedInputNanoUsd).toBe(8_000_000);
    expect(c.cacheReadNanoUsd).toBe(1_000_000);
    expect(c.cacheWriteNanoUsd).toBe(2_500_000);
    expect(c.outputNanoUsd).toBe(6_000_000);
    expect(c.totalNanoUsd).toBe(17_500_000);
    expect(c.actualCacheSavingsNanoUsd).toBe(9_000_000);
  });

  it('bills OpenAI writes at the input rate when no write rate is listed', () => {
    const c = createPricing().cost('openai', 'gpt-4.1-mini', usage({ totalInputTokens: 1_000, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000, outputTokens: 0 }));
    expect(c.cacheWriteNanoUsd).toBe(400_000);
    expect(c.notes.join(' ')).toMatch(/input rate/);
  });
});

describe('Anthropic cache writes', () => {
  const p = createPricing();
  it('prices 5m and 1h writes separately', () => {
    const c = p.cost('anthropic', 'claude-sonnet-4-5', usage({ totalInputTokens: 3_000, uncachedInputTokens: 0, cacheReadTokens: 1_000, cacheWriteTokens: 2_000, cacheWrite5mTokens: 1_000, cacheWrite1hTokens: 1_000, outputTokens: 100 }));
    // 5m $3.75, 1h $6.00, read $0.30, output $15
    expect(c.cacheWriteNanoUsd).toBe(3_750_000 + 6_000_000);
    expect(c.cacheReadNanoUsd).toBe(300_000);
    expect(c.outputNanoUsd).toBe(1_500_000);
    expect(c.totalNanoUsd).toBe(9_750_000 + 300_000 + 1_500_000);
    expect(c.actualCacheSavingsNanoUsd).toBe(3_000_000 - 300_000);
  });

  it('uses the default (5m) write rate when the TTL split is unknown', () => {
    const c = p.cost('anthropic', 'claude-sonnet-4-5', usage({ totalInputTokens: 2_000, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 2_000, outputTokens: 0 }));
    expect(c.cacheWriteNanoUsd).toBe(7_500_000);
    expect(c.notes.some((n) => n.includes('split'))).toBe(true);
  });

  it('netCacheEffect = savings − write premium', () => {
    const price = p.lookup('anthropic', 'claude-sonnet-4-5') as ModelPrice;
    // read 1000: saves 3_000_000 − 300_000 = 2_700_000; write 1000 (5m): premium 3_750_000 − 3_000_000 = 750_000
    const net = netCacheEffectNanoUsd(price, usage({ totalInputTokens: 2_000, uncachedInputTokens: 0, cacheReadTokens: 1_000, cacheWriteTokens: 1_000, cacheWrite5mTokens: 1_000, cacheWrite1hTokens: 0, outputTokens: 0 }));
    expect(net).toBe(1_950_000);
    expect(netCacheEffectNanoUsd(price, emptyUsage())).toBeNull();
  });
});

describe('long-context tier', () => {
  it('applies the Gemini 2.5 Pro >200k tier', () => {
    const p = createPricing();
    const small = p.cost('gemini', 'gemini-2.5-pro', usage({ totalInputTokens: 200_000, uncachedInputTokens: 200_000, cacheReadTokens: 0, outputTokens: 1_000 }));
    expect(small.uncachedInputNanoUsd).toBe(250_000_000); // $1.25
    expect(small.outputNanoUsd).toBe(10_000_000);
    expect(small.cacheWriteNanoUsd).toBe(0); // Gemini reports no cache writes
    const big = p.cost('gemini', 'gemini-2.5-pro', usage({ totalInputTokens: 200_001, uncachedInputTokens: 100_001, cacheReadTokens: 100_000, outputTokens: 1_000 }));
    expect(big.uncachedInputNanoUsd).toBe(250_002_500); // 100_001 × $2.50/MTok (long tier)
    expect(big.cacheReadNanoUsd).toBe(25_000_000);
    expect(big.outputNanoUsd).toBe(15_000_000);
    expect(big.notes).toContain('Long-context tier applied');
  });
});

describe('unknown and missing', () => {
  const p = createPricing();
  it('unknown model → all null and Pricing unavailable', () => {
    const c = p.cost('openai', 'my-custom-model', usage({ totalInputTokens: 10, uncachedInputTokens: 10, cacheReadTokens: 0, outputTokens: 1 }));
    expect(c.totalNanoUsd).toBeNull();
    expect(c.uncachedInputNanoUsd).toBeNull();
    expect(c.pricingModelKey).toBeNull();
    expect(c.confidence).toBeNull();
    expect(c.notes).toEqual(['Pricing unavailable']);
    expect(p.cost('openai', null, usage({})).notes).toEqual(['Pricing unavailable']);
  });

  it('missing usage → nulls, not zero', () => {
    const c = p.cost('openai', 'gpt-4o', emptyUsage());
    expect(c.totalNanoUsd).toBeNull();
    expect(c.outputNanoUsd).toBeNull();
    expect(c.actualCacheSavingsNanoUsd).toBeNull();
    expect(c.pricingModelKey).toBe('gpt-4o');
    expect(c.notes).toContain('Usage unavailable');
  });

  it('a missing component nulls that component and the total only', () => {
    const c = p.cost('openai', 'gpt-4o', usage({ totalInputTokens: 1_000, uncachedInputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: null }));
    expect(c.uncachedInputNanoUsd).toBe(2_500_000);
    expect(c.outputNanoUsd).toBeNull();
    expect(c.totalNanoUsd).toBeNull();
    expect(c.notes).toContain('Usage unavailable');
  });

  it('never falls back to another model', () => {
    expect(p.lookup('openai', 'gpt-5.6-turbo-x')).toBeNull();
    expect(p.lookup('openai', 'gpt-4o-mini-x')).toBeNull();
    expect(p.lookup('anthropic', 'gpt-4o')).toBeNull();
    expect(p.lookup('openai', 'claude-sonnet-4-5')).toBeNull();
    expect(p.lookup('openai', 'gpt-4o-2024')).toBeNull();
  });
});

describe('lookup', () => {
  const p = createPricing();
  it('strips dated snapshots with medium confidence', () => {
    expect(p.lookup('anthropic', 'claude-sonnet-4-5-20250929')?.model).toBe('claude-sonnet-4-5');
    expect(p.lookup('openai', 'gpt-4o-2024-08-06')?.model).toBe('gpt-4o');
    expect(p.lookup('openai', 'GPT-4O')?.model).toBe('gpt-4o');
    const c = p.cost('openai', 'gpt-4o-2024-08-06', usage({ totalInputTokens: 1, uncachedInputTokens: 1, cacheReadTokens: 0, outputTokens: 0 }));
    expect(c.confidence).toBe('medium');
  });

  it('prefers a separately listed snapshot over stripping', () => {
    expect(p.lookup('openai', 'gpt-4o-2024-05-13')?.inputPerMTok).toBe(5_000_000);
  });

  it('strips models/ for Gemini', () => {
    expect(p.lookup('gemini', 'models/gemini-2.5-flash')?.model).toBe('gemini-2.5-flash');
  });
});

describe('overrides', () => {
  it('win over the catalog and are marked', () => {
    const p = createPricing([override({ provider: 'openai', model: 'gpt-4o', inputPerMTok: 1_000_000 })]);
    expect(p.lookup('openai', 'gpt-4o')?.inputPerMTok).toBe(1_000_000);
    expect(p.lookup('openai', 'gpt-4o')?.origin).toBe('override');
    const c = p.cost('openai', 'gpt-4o', usage({ totalInputTokens: 1_000_000, uncachedInputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }));
    expect(c.uncachedInputNanoUsd).toBe(1_000_000_000);
    expect(c.pricingSource).toMatch(/override/);
  });

  it('loadPricingOverrides validates', () => {
    const ok = loadPricingOverrides({ models: [{ provider: 'openai', model: 'x', inputPerMTok: 1, outputPerMTok: 2 }] });
    expect(ok[0]?.cacheReadPerMTok).toBeNull();
    expect(ok[0]?.origin).toBe('override');
    expect(() => loadPricingOverrides({})).toThrow(/expected an array/);
    expect(() => loadPricingOverrides([{ provider: 'openai', model: 'x', inputPerMTok: 2.5, outputPerMTok: 1 }])).toThrow(/inputPerMTok.*integer/);
    expect(() => loadPricingOverrides([{ provider: 'openai', inputPerMTok: 1, outputPerMTok: 1 }])).toThrow(/model/);
  });
});
