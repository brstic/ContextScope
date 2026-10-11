import { createWriteStream, readFileSync } from 'node:fs';
import { once } from 'node:events';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import pino, { type Logger } from 'pino';
import { createAnalyzer } from '@contextscope/analyzer';
import { createFingerprinter } from '@contextscope/core';
import { createPricing, loadPricingOverrides, type ModelPrice, type Pricing } from '@contextscope/pricing';
import {
  CONTEXTSCOPE_VERSION,
  configSchema,
  isLoopbackHost,
  type ContextScopeConfig,
  type ImportResult,
} from '@contextscope/shared';
import { openDatabase } from './db/migrate.js';
import { createStore } from './db/store.js';
import { loadOrCreateKeys } from './keys.js';
import { createLiveHub, registerEvents } from './api/live.js';
import { registerApi } from './api/routes.js';
import { registerSecurity } from './api/security.js';
import { registerDashboard } from './api/static.js';
import { createPipeline } from './pipeline/pipeline.js';
import { seedDemo } from './pipeline/demo.js';
import { startRetention } from './pipeline/retention.js';
import { buildRoutes } from './proxy/routes.js';
import { registerProxy } from './proxy/proxy.js';
import type { Pipeline, ServerContext, Store } from './types.js';

export interface RunningServer {
  url: string;
  port: number;
  ctx: ServerContext;
  app: FastifyInstance;
  close(): Promise<void>;
}

/** A Pricing whose underlying table can be swapped at runtime (settings → pricing overrides). */
const swappablePricing = (initial: Pricing): Pricing & { swap(p: Pricing): void } => {
  let current = initial;
  return {
    get catalog() {
      return current.catalog;
    },
    lookup: (provider, model) => current.lookup(provider, model),
    cost: (provider, model, usage) => current.cost(provider, model, usage),
    swap: (p) => {
      current = p;
    },
  };
};

const readOverrides = (config: ContextScopeConfig, store: Store, logger: Logger): ModelPrice[] => {
  const out: ModelPrice[] = [];
  if (config.pricingFile) {
    out.push(...loadPricingOverrides(JSON.parse(readFileSync(config.pricingFile, 'utf8')) as unknown));
  }
  const saved = store.getSetting<unknown[]>('pricingOverrides');
  if (saved && saved.length > 0) {
    try {
      out.push(...loadPricingOverrides(saved));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'ignoring invalid saved pricing overrides');
    }
  }
  return out;
};

export interface BuiltServer {
  app: FastifyInstance;
  ctx: ServerContext;
  shutdown(): Promise<void>;
}

/**
 * Build the whole application (no listening): DB, keys, store, pipeline, proxy, API, dashboard.
 * Tests use this with `app.listen({ port: 0 })` or `app.inject()`.
 */
export const buildServer = async (
  input: ContextScopeConfig,
  opts: { logger?: Logger; quiet?: boolean } = {},
): Promise<BuiltServer> => {
  const config = configSchema.parse(input);
  if (!isLoopbackHost(config.host) && !config.authToken) {
    throw new Error(
      `Refusing to listen on ${config.host} without an auth token. Set --auth-token / CONTEXTSCOPE_AUTH_TOKEN (min 16 chars) and terminate TLS in front of ContextScope.`,
    );
  }
  const logger =
    opts.logger ??
    pino({
      level: opts.quiet ? 'warn' : config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers["x-goog-api-key"]',
          'req.headers.cookie',
        ],
        censor: '<redacted>',
      },
    });

  const keys = loadOrCreateKeys(config.dataDir);
  const opened = openDatabase(config.dbPath);
  const store = createStore(opened, { contentKey: keys.contentKey });
  const pricing = swappablePricing(createPricing());
  pricing.swap(createPricing(readOverrides(config, store, logger)));
  const analyzer = createAnalyzer({ maxSegments: config.limits.maxSegments }, pricing);
  const live = createLiveHub();
  const pipeline: Pipeline = createPipeline({
    store,
    live,
    pricing,
    analyzer,
    fingerprinter: createFingerprinter(keys.fingerprintKey),
    config,
    logger,
  });
  const routes = buildRoutes(config);
  for (const r of routes.filter((x) => x.custom)) {
    logger.warn(
      { route: r.prefix, upstream: r.upstream },
      'custom upstream enabled by configuration (trusted)',
    );
  }

  const ctx: ServerContext = {
    config,
    logger,
    store,
    live,
    pipeline,
    pricing,
    analyzer,
    routes,
    startedAtMs: Date.now(),
  };

  const app: FastifyInstance = Fastify({
    loggerInstance: logger.child({ component: 'http' }) as unknown as FastifyBaseLogger,
    disableRequestLogging: true,
    bodyLimit: 50 * 1024 * 1024,
    // Long generations: never time out the client side here; idle timeouts are on the upstream.
    connectionTimeout: 0,
    keepAliveTimeout: 72_000,
    return503OnClosing: false,
  });

  registerSecurity(app, { config });
  registerProxy(app, { routes, pipeline, config, logger });
  registerEvents(app, { live });
  registerApi(app, {
    ...ctx,
    onPricingOverrides: (overrides) => pricing.swap(createPricing(overrides)),
  });
  registerDashboard(
    app,
    config.webDir,
    routes.map((r) => r.prefix),
  );

  if (config.demo) {
    const result = seedDemo(pipeline, store);
    if (result) logger.info({ imported: result.imported, skipped: result.skipped }, 'demo data seeded');
  }
  const stopRetention = startRetention(store, config);

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopRetention();
    live.close();
    await app.close();
    await pipeline.drain(5_000).catch(() => undefined);
    await pipeline.close();
    opened.close();
  };
  return { app, ctx, shutdown };
};

/** Start proxy + API + dashboard on config.host:config.port. */
export const startServer = async (
  config: ContextScopeConfig,
  opts: { logger?: Logger; quiet?: boolean } = {},
): Promise<RunningServer> => {
  const built = await buildServer(config, opts);
  try {
    await built.app.listen({ host: built.ctx.config.host, port: built.ctx.config.port });
  } catch (err) {
    await built.shutdown();
    throw err;
  }
  const addr = built.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : built.ctx.config.port;
  const host = built.ctx.config.host.includes(':') ? `[${built.ctx.config.host}]` : built.ctx.config.host;
  return { url: `http://${host}:${port}`, port, ctx: built.ctx, app: built.app, close: built.shutdown };
};

/** Parse a JSON trace file or JSONL, without a running server. */
export const parseTraceFileText = (text: string): unknown[] => {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    const parsed = JSON.parse(trimmed) as { format?: unknown; traces?: unknown };
    if (parsed.format !== 'contextscope.trace' || !Array.isArray(parsed.traces)) {
      throw new Error(
        'Not a ContextScope trace file: expected {"format":"contextscope.trace","version":1,"traces":[...]}',
      );
    }
    return parsed.traces as unknown[];
  }
  if (trimmed.startsWith('{')) {
    // Could still be a pretty-printed single JSON document.
    try {
      const parsed = JSON.parse(trimmed) as { format?: unknown; traces?: unknown };
      if (parsed.format === 'contextscope.trace' && Array.isArray(parsed.traces))
        return parsed.traces as unknown[];
    } catch {
      /* fall through to JSONL */
    }
  }
  return trimmed.split('\n').filter((l) => l.trim().length > 0);
};

/** Offline import into the configured database (no network, no listening). */
export const importTraceFile = async (
  filePath: string,
  config: ContextScopeConfig,
): Promise<ImportResult> => {
  const built = await buildServer({ ...config, demo: false }, { quiet: true });
  try {
    const traces = parseTraceFileText(readFileSync(filePath, 'utf8'));
    return built.ctx.pipeline.importTraces(traces, { demo: false, origin: 'import' });
  } finally {
    await built.shutdown();
  }
};

/** Export metadata-only records (no prompt content) as ExportFile JSON. Returns the record count. */
export const exportRecords = async (
  config: ContextScopeConfig,
  opts: { out: string; from?: string; to?: string },
): Promise<number> => {
  const built = await buildServer({ ...config, demo: false }, { quiet: true });
  try {
    const qs = new URLSearchParams();
    if (opts.from) qs.set('from', opts.from);
    if (opts.to) qs.set('to', opts.to);
    const res = await built.app.inject({
      method: 'GET',
      url: `/api/export${qs.size ? `?${qs.toString()}` : ''}`,
      headers: config.authToken ? { authorization: `Bearer ${config.authToken}` } : {},
    });
    if (res.statusCode !== 200)
      throw new Error(`export failed: HTTP ${res.statusCode} ${res.body.slice(0, 200)}`);
    const out = createWriteStream(opts.out);
    out.end(res.rawPayload);
    await once(out, 'finish');
    const parsed = JSON.parse(res.body) as { records?: unknown[] };
    return parsed.records?.length ?? 0;
  } finally {
    await built.shutdown();
  }
};

export { CONTEXTSCOPE_VERSION };
