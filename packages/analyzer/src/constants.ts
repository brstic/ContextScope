import type { ProviderId } from '@contextscope/shared';

/**
 * Rule thresholds. Token numbers are ESTIMATED segment sizes (bytes / 4) unless the name says
 * REPORTED; reported numbers come only from provider usage.
 */

// --- single-request rules -------------------------------------------------------------
export const DUPLICATE_SEGMENT_MIN_TOKENS = 200;
export const DUPLICATE_SEGMENT_MIN_COPIES = 2;
export const OVERSIZED_TOOL_SCHEMA_TOKENS = 4000;
export const OVERSIZED_TOOL_SCHEMA_SHARE = 0.4;
/** The 40 % share branch only applies when tool schemas are at least this large (avoids noise on tiny requests). */
export const OVERSIZED_TOOL_SCHEMA_SHARE_MIN_TOKENS = 1000;
export const LARGE_TOOL_OUTPUT_TOKENS = 8000;
export const SLOW_REQUEST_DURATION_MS = 30_000;
export const SLOW_REQUEST_TTFT_MS = 10_000;
export const UNEXPECTED_CACHE_WRITE_SHARE = 0.5;
export const UNEXPECTED_CACHE_WRITE_MIN_TOKENS = 10_000;
export const STRUCTURED_SCHEMA_TOKENS = 1500;

// --- repeated-span detection (winnowing) ----------------------------------------------
export const WINNOW_K = 50;
export const WINNOW_WINDOW = 30;
export const REPEATED_SPAN_MIN_CHARS = 1000;

// --- history rules --------------------------------------------------------------------
export const REPEATED_TOOL_SCHEMA_MIN_REQUESTS = 5;
export const REPEATED_TOOL_SCHEMA_MIN_TOKENS = 1000;
export const LOW_CACHE_REUSE_MIN_REQUESTS = 5;
export const LOW_CACHE_REUSE_MIN_IDENTICAL_PREFIX = 0.5;
export const LOW_CACHE_REUSE_MAX_REPORTED_READ_SHARE = 0.1;
export const CONTEXT_GROWTH_FACTOR = 3;
export const CONTEXT_GROWTH_MIN_TURNS = 6;
export const CONTEXT_GROWTH_TURN_JUMP_TOKENS = 20_000;
export const REPEATED_RETRIEVAL_MIN_REQUESTS = 3;
export const REPEATED_LARGE_INPUT_TOKENS = 2000;
export const REPEATED_LARGE_INPUT_MIN_REQUESTS = 5;
export const EXPENSIVE_MODEL_OUTPUT_PER_MTOK = 10_000_000; // $10 / MTok, micro-USD
export const EXPENSIVE_MODEL_MAX_INPUT_TOKENS = 500;
export const EXPENSIVE_MODEL_MAX_OUTPUT_TOKENS = 200;
export const EXPENSIVE_MODEL_MIN_OCCURRENCES = 5;
export const TOKEN_SPIKE_FACTOR = 3;
export const TOKEN_SPIKE_MIN_TOKENS = 5000;
/** Minimum reported samples in a group before a median is meaningful. */
export const TOKEN_SPIKE_MIN_SAMPLES = 5;
/** Anthropic default cache TTL; longer gaps between requests let a 5-minute cache expire. */
export const ANTHROPIC_DEFAULT_CACHE_TTL_MS = 5 * 60_000;

// --- alignment -------------------------------------------------------------------------
/** Above a.length × b.length cells, alignment falls back to a linear greedy matcher. */
export const ALIGN_MAX_CELLS = 4_000_000;

/** Segment kinds whose change near the start of a request breaks prefix reuse. */
export const PREFIX_SENSITIVE_KINDS = ['tool_definition', 'system', 'developer', 'schema'] as const;

/** Official provider prompt-caching documentation. */
export const CACHING_DOCS: Record<ProviderId, string> = {
  openai: 'https://developers.openai.com/api/docs/guides/prompt-caching',
  anthropic: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
  gemini: 'https://ai.google.dev/gemini-api/docs/caching',
};
