/**
 * Public API of @contextscope/server (used by the CLI and tests).
 *
 *   startServer(config: ContextScopeConfig, opts?: { logger?: Logger; quiet?: boolean }): Promise<RunningServer>
 *     - validates config, opens/migrates SQLite, creates the fingerprint key (dataDir/fingerprint.key, 0600),
 *       builds routes, pipeline, live hub, Fastify app (proxy + /api + static dashboard), listens on host:port,
 *       seeds demo traces when config.demo (idempotent), starts retention timer.
 *   RunningServer { url: string; port: number; ctx: ServerContext; close(): Promise<void> }  // graceful
 *   buildApp(ctx): Promise<FastifyInstance>  // for tests via app.inject / listen(0)
 *   importTraceFile(filePath: string, config: ContextScopeConfig): Promise<ImportResult>  // offline, no server
 *   exportRecords(config, opts: { out: string; from?: string; to?: string }): Promise<number>
 */
export * from './db/migrate.js';
export * from './types.js';
export * from './app.js';
