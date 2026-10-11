import { z } from 'zod';

/**
 * Runtime configuration. Precedence (highest first):
 *   CLI flags  >  environment variables (CONTEXTSCOPE_*)  >  config file  >  defaults.
 */
export const DEFAULT_PORT = 3377;
export const DEFAULT_HOST = '127.0.0.1';

export const DEFAULT_UPSTREAMS = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
} as const;

export const captureModeSchema = z.enum(['metadata', 'deep_memory', 'deep_persistent']);
export type CaptureMode = z.infer<typeof captureModeSchema>;

const upstreamUrl = z
  .url({ protocol: /^https?$/ })
  .refine((u) => {
    const p = new URL(u);
    return p.pathname === '/' && !p.search && !p.hash && !p.username && !p.password;
  }, 'upstream must be an origin like https://api.example.com (no path, query or credentials)');

export const customProviderSchema = z.object({
  /** Route prefix: requests to /<name>/... go to this upstream. */
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,31}$/)
    .refine((n) => !['openai', 'anthropic', 'gemini', 'api', 'assets'].includes(n), 'reserved name'),
  /** Protocol the upstream speaks; only verified protocols are accepted. */
  protocol: z.literal('openai'),
  upstream: upstreamUrl,
  /** Explicit acknowledgement shown at startup. */
  trusted: z.literal(true),
});

export const configSchema = z.object({
  host: z.string().default(DEFAULT_HOST),
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  dbPath: z.string().default('.contextscope/contextscope.db'),
  dataDir: z.string().default('.contextscope'),
  upstreams: z
    .object({
      openai: upstreamUrl.default(DEFAULT_UPSTREAMS.openai),
      anthropic: upstreamUrl.default(DEFAULT_UPSTREAMS.anthropic),
      gemini: upstreamUrl.default(DEFAULT_UPSTREAMS.gemini),
    })
    .prefault({}),
  customProviders: z.array(customProviderSchema).default([]),
  capture: z
    .object({
      mode: captureModeSchema.default('metadata'),
      /** Retention for deep-captured content, hours. */
      contentRetentionHours: z.number().positive().max(24 * 365).default(24),
      /** Retention for metadata records, days. 0 = keep forever. */
      metadataRetentionDays: z.number().int().nonnegative().default(90),
      /** Bounded in-memory content buffer (deep_memory), entries. */
      memoryBufferEntries: z.number().int().positive().max(10_000).default(200),
    })
    .prefault({}),
  limits: z
    .object({
      /** Max request body bytes the observer inspects (proxying is never limited by this). */
      maxInspectBytes: z.number().int().positive().default(8 * 1024 * 1024),
      /** Max response bytes the observer inspects for usage (stream keeps flowing beyond). */
      maxResponseInspectBytes: z.number().int().positive().default(16 * 1024 * 1024),
      /** Max request body the proxy accepts at all. */
      maxRequestBytes: z.number().int().positive().default(64 * 1024 * 1024),
      /** Upstream connect timeout ms. */
      connectTimeoutMs: z.number().int().positive().default(15_000),
      /** Max time without upstream bytes before aborting, ms. */
      idleTimeoutMs: z.number().int().positive().default(600_000),
      /** Persistence queue capacity (events). */
      queueCapacity: z.number().int().positive().default(5_000),
      /** Max segments analysed per request. */
      maxSegments: z.number().int().positive().default(2_000),
    })
    .prefault({}),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Optional pricing override file (JSON array of ModelPrice). */
  pricingFile: z.string().nullable().default(null),
  /** Token required for the dashboard/API when bound to a non-loopback host. */
  authToken: z.string().min(16).nullable().default(null),
  /** Demo mode: seeds deterministic synthetic traces, labels everything as demo. */
  demo: z.boolean().default(false),
  /** Serve the built dashboard from this dir (default: bundled apps/web/dist). */
  webDir: z.string().nullable().default(null),
});

export type ContextScopeConfig = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

export const isLoopbackHost = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.');
