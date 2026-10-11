import type { ModelPrice, PricingCatalog } from './types.js';

/**
 * Default list-price catalog.
 *
 * Every number below was read on the official provider pricing page named in `source`
 * on 2026-10-11 (standard / global tier, text tokens). Models whose price could not be
 * read on an official page are deliberately absent: they resolve to "Pricing unavailable".
 *
 * Units: integer micro-USD per 1M tokens ($2.50/MTok = 2_500_000).
 *
 * Provider conventions:
 *  - Anthropic: cacheWritePerMTok = 5-minute write, cacheWrite1hPerMTok = 1-hour write,
 *    cacheReadPerMTok = "hits and refreshes".
 *  - OpenAI: cacheReadPerMTok = "cached input"; cacheWritePerMTok only where the page lists a
 *    "cache writes" column value (GPT-5.6 and later), otherwise null (= cache writes are billed at
 *    the normal input rate). Long-context column applies above 272K input tokens.
 *  - Gemini: cacheReadPerMTok = "context caching price" (text/image/video rate);
 *    cacheWritePerMTok null. Context-cache STORAGE (per 1M tokens per hour) is a separate
 *    charge that cannot be derived from a single request's usage and is out of scope here.
 *    Audio input is priced differently on some models and is not modelled.
 */

const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI = 'https://developers.openai.com/api/docs/pricing';
const GEMINI = 'https://ai.google.dev/gemini-api/docs/pricing';
const DATE = '2026-10-11';

/** $ → micro-USD, written out as integers to avoid floating point. */
const anthropic = (
  model: string,
  input: number,
  write5m: number,
  write1h: number,
  read: number,
  output: number,
  aliases: string[] = [],
): ModelPrice => ({
  provider: 'anthropic',
  model,
  aliases,
  effectiveDate: DATE,
  source: ANTHROPIC,
  inputPerMTok: input,
  cacheReadPerMTok: read,
  cacheWritePerMTok: write5m,
  cacheWrite1hPerMTok: write1h,
  outputPerMTok: output,
  origin: 'catalog',
});

const openai = (
  model: string,
  input: number,
  cachedInput: number | null,
  cacheWrite: number | null,
  output: number,
  long?: { input: number; cachedInput: number | null; cacheWrite: number | null; output: number },
): ModelPrice => ({
  provider: 'openai',
  model,
  aliases: [],
  effectiveDate: DATE,
  source: OPENAI,
  inputPerMTok: input,
  cacheReadPerMTok: cachedInput,
  cacheWritePerMTok: cacheWrite,
  outputPerMTok: output,
  ...(long
    ? {
        longContext: {
          thresholdTokens: 272_000,
          inputPerMTok: long.input,
          cacheReadPerMTok: long.cachedInput,
          cacheWritePerMTok: long.cacheWrite,
          outputPerMTok: long.output,
        },
      }
    : {}),
  origin: 'catalog',
});

const gemini = (
  model: string,
  input: number,
  cacheRead: number | null,
  output: number,
  long?: { input: number; cacheRead: number | null; output: number },
): ModelPrice => ({
  provider: 'gemini',
  model,
  aliases: [],
  effectiveDate: DATE,
  source: GEMINI,
  inputPerMTok: input,
  cacheReadPerMTok: cacheRead,
  cacheWritePerMTok: null,
  outputPerMTok: output,
  ...(long
    ? {
        longContext: {
          thresholdTokens: 200_000,
          inputPerMTok: long.input,
          cacheReadPerMTok: long.cacheRead,
          cacheWritePerMTok: null,
          outputPerMTok: long.output,
        },
      }
    : {}),
  origin: 'catalog',
});

const ANTHROPIC_MODELS: ModelPrice[] = [
  // Current generation (pricing page "Model pricing" table).
  anthropic('claude-fable-5-1', 10_000_000, 12_500_000, 20_000_000, 250_000, 50_000_000),
  anthropic('claude-opus-5-5', 4_000_000, 5_000_000, 8_000_000, 200_000, 20_000_000),
  anthropic('claude-sonnet-5-5', 2_000_000, 2_500_000, 4_000_000, 100_000, 10_000_000),
  {
    // Priced by prompt length: prompts over 100,000 input tokens (incl. cache reads/writes) pay more.
    ...anthropic('claude-haiku-5-5', 100_000, 125_000, 200_000, 10_000, 500_000),
    longContext: {
      thresholdTokens: 100_000,
      inputPerMTok: 500_000,
      cacheReadPerMTok: 50_000,
      cacheWritePerMTok: 625_000,
      cacheWrite1hPerMTok: 1_000_000,
      outputPerMTok: 2_500_000,
    },
  },
  // "Additional models" table. Ids follow the documented claude-<family>-<major>-<minor> scheme.
  anthropic('claude-mythos-5-1', 10_000_000, 12_500_000, 20_000_000, 250_000, 50_000_000),
  anthropic('claude-fable-5', 10_000_000, 12_500_000, 20_000_000, 1_000_000, 50_000_000),
  anthropic('claude-mythos-5', 10_000_000, 12_500_000, 20_000_000, 1_000_000, 50_000_000),
  anthropic('claude-opus-5', 5_000_000, 6_250_000, 10_000_000, 500_000, 25_000_000),
  anthropic('claude-opus-4-8', 5_000_000, 6_250_000, 10_000_000, 500_000, 25_000_000),
  anthropic('claude-opus-4-7', 5_000_000, 6_250_000, 10_000_000, 500_000, 25_000_000),
  anthropic('claude-opus-4-6', 5_000_000, 6_250_000, 10_000_000, 500_000, 25_000_000),
  anthropic('claude-opus-4-5', 5_000_000, 6_250_000, 10_000_000, 500_000, 25_000_000),
  anthropic('claude-opus-4-1', 15_000_000, 18_750_000, 30_000_000, 1_500_000, 75_000_000),
  anthropic('claude-opus-4', 15_000_000, 18_750_000, 30_000_000, 1_500_000, 75_000_000, ['claude-opus-4-0']),
  anthropic('claude-sonnet-5', 2_000_000, 2_500_000, 4_000_000, 200_000, 10_000_000),
  anthropic('claude-sonnet-4-6', 3_000_000, 3_750_000, 6_000_000, 300_000, 15_000_000),
  anthropic('claude-sonnet-4-5', 3_000_000, 3_750_000, 6_000_000, 300_000, 15_000_000),
  anthropic('claude-sonnet-4', 3_000_000, 3_750_000, 6_000_000, 300_000, 15_000_000, ['claude-sonnet-4-0']),
  anthropic('claude-haiku-4-5', 1_000_000, 1_250_000, 2_000_000, 100_000, 5_000_000),
  anthropic('claude-3-5-haiku', 800_000, 1_000_000, 1_600_000, 80_000, 4_000_000, ['claude-haiku-3-5']),
];

const OPENAI_MODELS: ModelPrice[] = [
  openai('gpt-6-astra', 10_000_000, 1_000_000, 12_500_000, 50_000_000, {
    input: 20_000_000,
    cachedInput: 2_000_000,
    cacheWrite: 25_000_000,
    output: 75_000_000,
  }),
  openai('gpt-6.1-sol', 2_000_000, 100_000, 2_500_000, 10_000_000, {
    input: 4_000_000,
    cachedInput: 200_000,
    cacheWrite: 5_000_000,
    output: 15_000_000,
  }),
  openai('gpt-6-sol', 2_000_000, 200_000, 2_500_000, 10_000_000, {
    input: 4_000_000,
    cachedInput: 400_000,
    cacheWrite: 5_000_000,
    output: 15_000_000,
  }),
  openai('gpt-6-luna', 100_000, 10_000, 125_000, 500_000, {
    input: 200_000,
    cachedInput: 20_000,
    cacheWrite: 250_000,
    output: 750_000,
  }),
  openai('gpt-5.6-sol', 4_000_000, 400_000, 5_000_000, 20_000_000, {
    input: 8_000_000,
    cachedInput: 800_000,
    cacheWrite: 10_000_000,
    output: 30_000_000,
  }),
  openai('gpt-5.6-terra', 2_000_000, 200_000, 2_500_000, 12_000_000, {
    input: 4_000_000,
    cachedInput: 400_000,
    cacheWrite: 5_000_000,
    output: 18_000_000,
  }),
  openai('gpt-5.6-luna', 200_000, 20_000, 250_000, 1_200_000, {
    input: 400_000,
    cachedInput: 40_000,
    cacheWrite: 500_000,
    output: 1_800_000,
  }),
  openai('gpt-5.6-cyber', 12_500_000, 1_250_000, 15_625_000, 75_000_000),
  openai('gpt-5.5', 5_000_000, 500_000, null, 30_000_000, {
    input: 10_000_000,
    cachedInput: 1_000_000,
    cacheWrite: null,
    output: 45_000_000,
  }),
  openai('gpt-5.4', 2_500_000, 250_000, null, 15_000_000, {
    input: 5_000_000,
    cachedInput: 500_000,
    cacheWrite: null,
    output: 22_500_000,
  }),
  openai('gpt-5.4-mini', 750_000, 75_000, null, 4_500_000),
  openai('gpt-5.4-nano', 200_000, 20_000, null, 1_250_000),
  openai('gpt-5.2', 1_750_000, 175_000, null, 14_000_000),
  openai('gpt-5.1', 1_250_000, 125_000, null, 10_000_000),
  openai('gpt-5', 1_250_000, 125_000, null, 10_000_000),
  openai('gpt-5-mini', 250_000, 25_000, null, 2_000_000),
  openai('gpt-5-nano', 50_000, 5_000, null, 400_000),
  openai('gpt-4.1', 2_000_000, 500_000, null, 8_000_000),
  openai('gpt-4.1-mini', 400_000, 100_000, null, 1_600_000),
  openai('gpt-4.1-nano', 100_000, 25_000, null, 400_000),
  openai('gpt-4o', 2_500_000, 1_250_000, null, 10_000_000),
  // Listed separately with its own price: must win over snapshot stripping to gpt-4o.
  openai('gpt-4o-2024-05-13', 5_000_000, null, null, 15_000_000),
  openai('gpt-4o-mini', 150_000, 75_000, null, 600_000),
  openai('o3', 2_000_000, 500_000, null, 8_000_000),
  openai('o4-mini', 1_100_000, 275_000, null, 4_400_000),
  openai('o3-mini', 1_100_000, 550_000, null, 4_400_000),
  openai('o1', 15_000_000, 7_500_000, null, 60_000_000),
];

const GEMINI_MODELS: ModelPrice[] = [
  // Gemini 3.8 / 3.6 Flash: introductory price "through December 31, 2026" (doubles on 2027-01-01).
  gemini('gemini-3.8-flash', 750_000, 75_000, 3_750_000),
  gemini('gemini-3.6-flash', 750_000, 75_000, 3_750_000),
  gemini('gemini-3.5-flash-lite', 300_000, 30_000, 2_500_000),
  gemini('gemini-3.1-flash-lite', 250_000, 25_000, 1_500_000),
  {
    ...gemini('gemini-3.1-pro-preview', 2_000_000, 200_000, 12_000_000, {
      input: 4_000_000,
      cacheRead: 400_000,
      output: 18_000_000,
    }),
    aliases: ['gemini-3.1-pro-preview-customtools'],
  },
  gemini('gemini-3-flash-preview', 500_000, 50_000, 3_000_000),
  gemini('gemini-2.5-pro', 1_250_000, 125_000, 10_000_000, {
    input: 2_500_000,
    cacheRead: 250_000,
    output: 15_000_000,
  }),
  gemini('gemini-2.5-flash', 300_000, 30_000, 2_500_000),
  gemini('gemini-2.5-flash-lite', 100_000, 10_000, 400_000),
];

export const DEFAULT_CATALOG: PricingCatalog = {
  version: '2026-10-11',
  effectiveDate: DATE,
  source: [ANTHROPIC, OPENAI, GEMINI].join(' '),
  models: [...ANTHROPIC_MODELS, ...OPENAI_MODELS, ...GEMINI_MODELS],
};
