import type { Confidence, CostBreakdown, NormalizedUsage, ProviderId } from '@contextscope/shared';
import { DEFAULT_CATALOG } from './catalog.js';
import type { ModelPrice, Pricing, PricingCatalog } from './types.js';

/** How a model id was matched to a price. */
export type PriceMatch = 'exact' | 'alias' | 'snapshot';

export interface PriceResolution {
  price: ModelPrice;
  match: PriceMatch;
}

/** Rates in effect for one request (base or long-context tier). */
interface Rates {
  input: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheWrite1h: number | null;
  output: number;
  longContext: boolean;
}

export const NOTE_PRICING_UNAVAILABLE = 'Pricing unavailable';
export const NOTE_USAGE_UNAVAILABLE = 'Usage unavailable';
export const NOTE_LONG_CONTEXT = 'Long-context tier applied';
export const NOTE_USAGE_INCOMPLETE = 'Usage incomplete (stream ended before the final usage event)';
export const NOTE_CACHE_READ_AT_INPUT = 'No cached-input rate listed for this model: cache reads priced at the input rate';
export const NOTE_CACHE_WRITE_AT_INPUT =
  'No separate cache-write rate listed for this model: cache writes priced at the input rate';
export const NOTE_CACHE_WRITE_SPLIT_UNKNOWN = 'Cache-write TTL split not reported: default (5-minute) write rate applied';
export const NOTE_ALIAS = 'Price resolved from a model alias or dated snapshot';

const SNAPSHOT_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Exact integer cost: tokens × micro-USD-per-MTok / 1000 = nano-USD, rounded half-up.
 * (1 token at 1 micro-USD per 1M tokens = 1e-6 micro-USD = 1e-3 nano-USD.)
 */
export const tokensCostNano = (tokens: number, microPerMTok: number): bigint => {
  const prod = BigInt(Math.trunc(tokens)) * BigInt(Math.trunc(microPerMTok));
  if (prod >= 0n) return (prod + 500n) / 1000n;
  return -((-prod + 500n) / 1000n);
};

const toNum = (v: bigint): number => Number(v);

const ratesFor = (price: ModelPrice, totalInput: number | null): Rates => {
  const lc = price.longContext;
  if (lc && totalInput !== null && totalInput > lc.thresholdTokens) {
    return {
      input: lc.inputPerMTok,
      cacheRead: lc.cacheReadPerMTok,
      cacheWrite: lc.cacheWritePerMTok,
      cacheWrite1h: lc.cacheWrite1hPerMTok ?? null,
      output: lc.outputPerMTok,
      longContext: true,
    };
  }
  return {
    input: price.inputPerMTok,
    cacheRead: price.cacheReadPerMTok,
    cacheWrite: price.cacheWritePerMTok,
    cacheWrite1h: price.cacheWrite1hPerMTok ?? null,
    output: price.outputPerMTok,
    longContext: false,
  };
};

/** Usage counts after filling gaps that the NormalizedUsage invariant determines exactly. */
interface InputCounts {
  total: number | null;
  uncached: number | null;
  read: number | null;
  write: number | null;
  write5m: number | null;
  write1h: number | null;
}

/**
 * Fill unknown input counts only where the invariant
 * total = uncached + cacheRead + cacheWrite determines them exactly. Gemini reports no cache
 * writes at all (explicit caches are created by a separate API), so a null write there is 0.
 * Nothing is ever guessed: ambiguous gaps stay null.
 */
const inputCounts = (provider: string, u: NormalizedUsage): InputCounts => {
  let { totalInputTokens: total, uncachedInputTokens: uncached, cacheReadTokens: read, cacheWriteTokens: write } = u;
  const write5m = u.cacheWrite5mTokens;
  const write1h = u.cacheWrite1hTokens;
  if (write === null && write5m !== null && write1h !== null) write = write5m + write1h;
  if (write === null && norm(provider) === 'gemini') write = 0;
  const unknowns = [uncached, read, write].filter((v) => v === null).length;
  if (total !== null && unknowns === 1) {
    const rest = total - (uncached ?? 0) - (read ?? 0) - (write ?? 0);
    if (rest >= 0) {
      if (uncached === null) uncached = rest;
      else if (read === null) read = rest;
      else write = rest;
    }
  } else if (total !== null && uncached !== null && unknowns === 2 && total === uncached) {
    read = read ?? 0;
    write = write ?? 0;
  }
  if (total === null && uncached !== null && read !== null && write !== null) total = uncached + read + write;
  return { total, uncached, read, write, write5m, write1h };
};

const writeCost = (c: InputCounts, r: Rates, notes: Set<string>): bigint | null => {
  if (c.write === null) return null;
  if (c.write === 0) return 0n;
  if (r.cacheWrite === null) {
    notes.add(NOTE_CACHE_WRITE_AT_INPUT);
    return tokensCostNano(c.write, r.input);
  }
  if (c.write5m !== null && c.write1h !== null && r.cacheWrite1h !== null && c.write5m + c.write1h === c.write) {
    return tokensCostNano(c.write5m, r.cacheWrite) + tokensCostNano(c.write1h, r.cacheWrite1h);
  }
  if (r.cacheWrite1h !== null) notes.add(NOTE_CACHE_WRITE_SPLIT_UNKNOWN);
  return tokensCostNano(c.write, r.cacheWrite);
};

/** What writing to the cache cost ABOVE the uncached input rate (≥ 0 for every listed write rate). */
const writePremium = (c: InputCounts, r: Rates): bigint | null => {
  if (c.write === null) return null;
  if (c.write === 0 || r.cacheWrite === null) return 0n;
  const atInput = tokensCostNano(c.write, r.input);
  const notes = new Set<string>();
  const cost = writeCost(c, r, notes);
  return cost === null ? null : cost - atInput;
};

const unavailableCost = (notes: string[]): CostBreakdown => ({
  currency: 'USD',
  uncachedInputNanoUsd: null,
  cacheReadNanoUsd: null,
  cacheWriteNanoUsd: null,
  outputNanoUsd: null,
  totalNanoUsd: null,
  actualCacheSavingsNanoUsd: null,
  pricingModelKey: null,
  pricingSource: null,
  pricingVersion: null,
  confidence: null,
  notes,
});

/**
 * Actual cache savings (what CostBreakdown.actualCacheSavingsNanoUsd holds):
 *   cacheReadTokens × (input rate − cache-read rate)
 * i.e. what the cache hits would have cost uncached minus what they cost. It ignores the
 * premium paid to WRITE the cache; see netCacheEffectNanoUsd for that.
 * null when cache-read tokens are unknown.
 */
export const cacheSavingsNanoUsd = (price: ModelPrice, usage: NormalizedUsage): number | null => {
  if (usage.source === 'unavailable') return null;
  const c = inputCounts(String(price.provider), usage);
  if (c.read === null) return null;
  const r = ratesFor(price, c.total);
  const readRate = r.cacheRead ?? r.input;
  return toNum(tokensCostNano(c.read, r.input) - tokensCostNano(c.read, readRate));
};

/**
 * Net cache effect of ONE request:
 *   actual cache savings − cache-write premium
 * where the write premium is what cache writes cost above the uncached input rate
 * (Anthropic 5m: 0.25× input, 1h: 1× input; OpenAI GPT-5.6+: 0.25× input; 0 where no write
 * rate is listed). Negative = this request paid more for caching than it saved; the
 * benefit of a write usually shows up in LATER requests' reads. null when the needed
 * counts are unknown.
 */
export const netCacheEffectNanoUsd = (price: ModelPrice, usage: NormalizedUsage): number | null => {
  if (usage.source === 'unavailable') return null;
  const savings = cacheSavingsNanoUsd(price, usage);
  if (savings === null) return null;
  const c = inputCounts(String(price.provider), usage);
  const premium = writePremium(c, ratesFor(price, c.total));
  return premium === null ? null : savings - toNum(premium);
};

const buildIndex = (catalog: PricingCatalog, overrides: ModelPrice[]) => {
  /** key: provider|model-or-alias → resolution (overrides first, so they win). */
  const index = new Map<string, { price: ModelPrice; alias: boolean }>();
  const add = (p: ModelPrice, force: boolean): void => {
    const prov = norm(String(p.provider));
    const main = `${prov}|${norm(p.model)}`;
    if (force || !index.has(main)) index.set(main, { price: p, alias: false });
    for (const a of p.aliases ?? []) {
      const k = `${prov}|${norm(a)}`;
      if (force || !index.has(k)) index.set(k, { price: p, alias: true });
    }
  };
  for (const p of overrides) add({ ...p, origin: 'override' }, true);
  for (const p of catalog.models) add({ ...p, origin: p.origin ?? 'catalog' }, false);
  return index;
};

/**
 * Create a pricing instance. Overrides (e.g. from loadPricingOverrides) take precedence over
 * the default catalog for the same provider + model id or alias.
 */
export const createPricing = (overrides: ModelPrice[] = [], catalog: PricingCatalog = DEFAULT_CATALOG): Pricing & {
  resolve(provider: ProviderId | string, model: string | null): PriceResolution | null;
} => {
  const index = buildIndex(catalog, overrides);

  const find = (prov: string, id: string): PriceResolution | null => {
    const hit = index.get(`${prov}|${id}`);
    return hit ? { price: hit.price, match: hit.alias ? 'alias' : 'exact' } : null;
  };

  /**
   * Resolution order (case-insensitive, same provider only):
   *  1. exact model id or alias;
   *  2. dated snapshot suffix stripped (-YYYY-MM-DD or -YYYYMMDD only);
   *  3. for Gemini, a leading "models/" is ignored first.
   * Never falls back to a "similar" model: "gpt-5.6-turbo-x" is unknown.
   */
  const resolve = (provider: ProviderId | string, model: string | null): PriceResolution | null => {
    if (model === null) return null;
    const prov = norm(String(provider));
    let id = norm(model);
    if (!id) return null;
    if (prov === 'gemini' && id.startsWith('models/')) id = id.slice('models/'.length);
    const direct = find(prov, id);
    if (direct) return direct;
    const m = SNAPSHOT_SUFFIX.exec(id);
    if (m) {
      const base = find(prov, id.slice(0, m.index));
      if (base) return { price: base.price, match: 'snapshot' };
    }
    return null;
  };

  const cost = (provider: ProviderId | string, model: string | null, usage: NormalizedUsage): CostBreakdown => {
    const res = resolve(provider, model);
    if (!res) return unavailableCost([NOTE_PRICING_UNAVAILABLE]);
    const { price, match } = res;
    const confidence: Confidence = match === 'exact' ? 'high' : 'medium';
    const base: CostBreakdown = {
      ...unavailableCost([]),
      pricingModelKey: price.model,
      pricingSource: price.origin === 'override' ? `override: ${price.source}` : price.source,
      pricingVersion: price.origin === 'override' ? `override:${price.effectiveDate}` : catalog.version,
      confidence,
    };
    const notes = new Set<string>();
    if (match !== 'exact') notes.add(NOTE_ALIAS);
    if (usage.source === 'unavailable') {
      notes.add(NOTE_USAGE_UNAVAILABLE);
      return { ...base, notes: [...notes] };
    }
    if (!usage.complete) notes.add(NOTE_USAGE_INCOMPLETE);

    const c = inputCounts(String(price.provider), usage);
    const r = ratesFor(price, c.total);
    if (r.longContext) notes.add(NOTE_LONG_CONTEXT);

    const uncached = c.uncached === null ? null : tokensCostNano(c.uncached, r.input);
    let read: bigint | null = null;
    if (c.read !== null) {
      if (r.cacheRead === null && c.read > 0) notes.add(NOTE_CACHE_READ_AT_INPUT);
      read = tokensCostNano(c.read, r.cacheRead ?? r.input);
    }
    const write = writeCost(c, r, notes);
    const output = usage.outputTokens === null ? null : tokensCostNano(usage.outputTokens, r.output);

    const parts = [uncached, read, write, output];
    if (parts.some((p) => p === null)) notes.add(NOTE_USAGE_UNAVAILABLE);
    const total = parts.every((p) => p !== null) ? parts.reduce<bigint>((s, p) => s + (p ?? 0n), 0n) : null;
    const savings =
      c.read === null ? null : tokensCostNano(c.read, r.input) - tokensCostNano(c.read, r.cacheRead ?? r.input);

    return {
      ...base,
      uncachedInputNanoUsd: uncached === null ? null : toNum(uncached),
      cacheReadNanoUsd: read === null ? null : toNum(read),
      cacheWriteNanoUsd: write === null ? null : toNum(write),
      outputNanoUsd: output === null ? null : toNum(output),
      totalNanoUsd: total === null ? null : toNum(total),
      actualCacheSavingsNanoUsd: savings === null ? null : toNum(savings),
      notes: [...notes],
    };
  };

  return {
    catalog,
    lookup: (provider, model) => resolve(provider, model)?.price ?? null,
    resolve,
    cost,
  };
};

// ---------------------------------------------------------------------------------------
// Overrides file validation (manual: this package has no schema-library dependency).

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const fail = (where: string, msg: string): never => {
  throw new Error(`Invalid pricing override ${where}: ${msg}`);
};

const rate = (where: string, v: unknown, nullable: boolean): number | null => {
  if (v === null || v === undefined) {
    if (nullable) return null;
    return fail(where, 'is required (integer micro-USD per 1M tokens, e.g. 2500000 for $2.50/MTok)');
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    return fail(where, `must be a non-negative integer (micro-USD per 1M tokens), got ${JSON.stringify(v)}`);
  }
  return v;
};

const str = (where: string, v: unknown, fallback?: string): string => {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'string' || v.trim() === '') return fail(where, 'must be a non-empty string');
  return v;
};

/**
 * Parse user-supplied price overrides. Accepts an array of ModelPrice-like objects or
 * `{ "models": [...] }`. Throws an Error naming the offending entry and field.
 */
export const loadPricingOverrides = (json: unknown): ModelPrice[] => {
  const list = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json['models']) ? json['models'] : null;
  if (!list) throw new Error('Invalid pricing overrides: expected an array of model prices or { "models": [...] }');
  return list.map((item: unknown, i): ModelPrice => {
    const at = `[${i}]`;
    if (!isRecord(item)) return fail(at, 'must be an object');
    const model = str(`${at}.model`, item['model']);
    const w = `${at} (${model})`;
    const aliasesRaw = item['aliases'];
    if (aliasesRaw !== undefined && (!Array.isArray(aliasesRaw) || !aliasesRaw.every((a) => typeof a === 'string'))) {
      fail(`${w}.aliases`, 'must be an array of strings');
    }
    const effectiveDate = str(`${w}.effectiveDate`, item['effectiveDate'], 'unknown');
    if (effectiveDate !== 'unknown' && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
      fail(`${w}.effectiveDate`, 'must be YYYY-MM-DD');
    }
    const out: ModelPrice = {
      provider: str(`${w}.provider`, item['provider']),
      model,
      aliases: (aliasesRaw as string[] | undefined) ?? [],
      effectiveDate,
      source: str(`${w}.source`, item['source'], 'user override'),
      inputPerMTok: rate(`${w}.inputPerMTok`, item['inputPerMTok'], false) as number,
      cacheReadPerMTok: rate(`${w}.cacheReadPerMTok`, item['cacheReadPerMTok'], true),
      cacheWritePerMTok: rate(`${w}.cacheWritePerMTok`, item['cacheWritePerMTok'], true),
      cacheWrite1hPerMTok: rate(`${w}.cacheWrite1hPerMTok`, item['cacheWrite1hPerMTok'], true),
      outputPerMTok: rate(`${w}.outputPerMTok`, item['outputPerMTok'], false) as number,
      origin: 'override',
    };
    const lc = item['longContext'];
    if (lc !== undefined && lc !== null) {
      if (!isRecord(lc)) return fail(`${w}.longContext`, 'must be an object');
      const t = lc['thresholdTokens'];
      if (typeof t !== 'number' || !Number.isSafeInteger(t) || t <= 0) {
        fail(`${w}.longContext.thresholdTokens`, 'must be a positive integer');
      }
      out.longContext = {
        thresholdTokens: t as number,
        inputPerMTok: rate(`${w}.longContext.inputPerMTok`, lc['inputPerMTok'], false) as number,
        cacheReadPerMTok: rate(`${w}.longContext.cacheReadPerMTok`, lc['cacheReadPerMTok'], true),
        cacheWritePerMTok: rate(`${w}.longContext.cacheWritePerMTok`, lc['cacheWritePerMTok'], true),
        cacheWrite1hPerMTok: rate(`${w}.longContext.cacheWrite1hPerMTok`, lc['cacheWrite1hPerMTok'], true),
        outputPerMTok: rate(`${w}.longContext.outputPerMTok`, lc['outputPerMTok'], false) as number,
      };
    }
    return out;
  });
};
