import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import { configSchema } from '@contextscope/shared';
import type { ContextScopeConfig } from '@contextscope/shared';
import type * as ServerApi from '@contextscope/server';
import { ConfigError, loadConfig, maskConfig } from './config.js';
import type { ConfigFlags, LoadedConfig } from './config.js';
import { runDoctorChecks } from './doctor.js';
import type { CheckResult } from './doctor.js';
import { banner, defaultIO, dim, green, red, yellow } from './output.js';
import type { CliIO } from './output.js';
import {
  baseUrl,
  getStatus,
  isAlive,
  logFilePath,
  readPidFile,
  removePidFile,
  spawnDetached,
  stopServer,
  waitForHealthy,
  writePidFile,
} from './pid.js';

/** Server functions the CLI calls; injectable for tests. Loaded lazily (SQLite etc. only when needed). */
export interface ServerDeps {
  startServer: typeof ServerApi.startServer;
  importTraceFile: typeof ServerApi.importTraceFile;
  exportRecords: typeof ServerApi.exportRecords;
}

const loadServer = async (): Promise<ServerDeps> => {
  const mod = await import('@contextscope/server');
  return { startServer: mod.startServer, importTraceFile: mod.importTraceFile, exportRecords: mod.exportRecords };
};

/** Ends a command with an exit code (and an optional message for stderr). */
export class CliExit extends Error {
  constructor(
    readonly code: number,
    message = '',
  ) {
    super(message);
    this.name = 'CliExit';
  }
}

export const CLI_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const BIN_PATH = fileURLToPath(new URL('./bin.js', import.meta.url));

export interface ProgramOptions {
  io?: CliIO;
  server?: () => Promise<ServerDeps>;
  /** Resolves when a foreground server should shut down (tests); default: SIGINT/SIGTERM. */
  shutdownSignal?: () => Promise<string>;
}

const addLocationOptions = (cmd: Command): Command =>
  cmd
    .option('--config <path>', 'config file (JSON); default ./contextscope.config.json if present')
    .option('--data-dir <dir>', 'data directory (database, keys, pid and log files)')
    .option('--db <path>', 'SQLite database path (default <data-dir>/contextscope.db)');

const addServerOptions = (cmd: Command): Command =>
  addLocationOptions(cmd)
    .option('--host <host>', 'bind address (default 127.0.0.1; non-loopback requires --auth-token)')
    .option('--port <port>', 'port (default 3377)')
    .addOption(
      new Option('--capture <mode>', 'capture mode').choices(['metadata', 'deep_memory', 'deep_persistent']),
    )
    .addOption(
      new Option('--log-level <level>', 'log level').choices(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    )
    .option('--auth-token <token>', 'bearer token for the dashboard/API (min 16 chars; or CONTEXTSCOPE_AUTH_TOKEN)');

const flagsOf = (cmd: Command, extra: Partial<ConfigFlags> = {}): ConfigFlags => {
  const o = cmd.opts<Record<string, unknown>>();
  const str = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const flags: ConfigFlags = { ...extra };
  const map: [keyof ConfigFlags, string][] = [
    ['host', 'host'],
    ['port', 'port'],
    ['db', 'db'],
    ['dataDir', 'dataDir'],
    ['capture', 'capture'],
    ['logLevel', 'logLevel'],
    ['authToken', 'authToken'],
    ['config', 'config'],
  ];
  for (const [key, opt] of map) {
    const v = str(opt);
    if (v !== undefined) (flags as Record<string, unknown>)[key] = v;
  }
  if (o.demo === true) flags.demo = true;
  return flags;
};

/** Original arguments for the detached child: everything except --detach. */
const childArgs = (command: string, cmd: Command): string[] => {
  const args = [command];
  const o = cmd.opts<Record<string, unknown>>();
  const pairs: [string, string][] = [
    ['config', '--config'],
    ['dataDir', '--data-dir'],
    ['db', '--db'],
    ['host', '--host'],
    ['port', '--port'],
    ['capture', '--capture'],
    ['logLevel', '--log-level'],
  ];
  for (const [k, flag] of pairs) if (typeof o[k] === 'string') args.push(flag, resolveIfPath(k, o[k] as string));
  if (o.demo === true) args.push('--demo');
  return args;
};

const resolveIfPath = (key: string, v: string): string =>
  ['config', 'dataDir', 'db'].includes(key) ? resolve(v) : v;

const defaultShutdown = (): Promise<string> =>
  new Promise((done) => {
    const handler = (sig: NodeJS.Signals) => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
      // A second signal while closing forces the exit.
      const force = () => process.exit(130);
      process.once('SIGINT', force);
      process.once('SIGTERM', force);
      done(sig);
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  });

export function buildProgram(opts: ProgramOptions = {}): Command {
  const io = opts.io ?? defaultIO();
  const getServer = opts.server ?? loadServer;
  const shutdownSignal = opts.shutdownSignal ?? defaultShutdown;
  const out = (s = '') => io.stdout(`${s}\n`);
  const err = (s = '') => io.stderr(`${s}\n`);

  const load = (flags: ConfigFlags): LoadedConfig => loadConfig({ flags, env: io.env, cwd: io.cwd });

  const program = new Command('contextscope')
    .description('ContextScope — local LLM proxy, context profiler and prompt cache debugger')
    .version(CLI_VERSION, '-v, --version', 'print the version')
    .showHelpAfterError()
    .configureOutput({ writeOut: (s) => io.stdout(s), writeErr: (s) => io.stderr(s) })
    .exitOverride();

  const runStart = async (command: 'start' | 'demo', cmd: Command): Promise<void> => {
    const o = cmd.opts<Record<string, unknown>>();
    const flags = flagsOf(cmd, command === 'demo' ? { demo: true } : {});
    const { config, file } = load(flags);

    const existing = readPidFile(config.dataDir);
    if (existing !== null && existing.pid !== process.pid && isAlive(existing.pid)) {
      throw new CliExit(
        1,
        `ContextScope is already running (pid ${existing.pid}, ${baseUrl(existing.host, existing.port)}). Use \`contextscope stop\` first.`,
      );
    }
    if (existing !== null && !isAlive(existing.pid)) removePidFile(config.dataDir, existing.pid);

    if (o.detach === true) {
      const env = { ...io.env };
      // The token reaches the child through the environment, never through its argv (visible in `ps`).
      if (config.authToken) env.CONTEXTSCOPE_AUTH_TOKEN = config.authToken;
      const { pid, logFile } = spawnDetached({
        bin: BIN_PATH,
        args: childArgs(command, cmd),
        dataDir: config.dataDir,
        env,
        cwd: io.cwd,
      });
      const info = await waitForHealthy(pid, config.dataDir, config.authToken);
      if (info === null) {
        throw new CliExit(1, `ContextScope did not become healthy. See the log: ${logFile}`);
      }
      out(`${green('✓')} ContextScope ${config.demo ? 'demo ' : ''}started in the background (pid ${pid}).`);
      out(`  Dashboard  ${baseUrl(info.host, info.port)}/`);
      out(`  Log        ${logFile}`);
      out(`  Stop with  contextscope stop${command === 'demo' ? ' --demo' : ''}${flags.dataDir ? ` --data-dir ${resolve(flags.dataDir)}` : ''}`);
      return;
    }

    const { startServer } = await getServer();
    const server = await startServer(config);
    writePidFile(config.dataDir, {
      pid: process.pid,
      port: server.port,
      host: config.host,
      startedAt: new Date().toISOString(),
    });
    const cleanup = () => removePidFile(config.dataDir, process.pid);
    process.once('exit', cleanup);
    out(banner({ version: CLI_VERSION, host: config.host, port: server.port, config, configFile: file }));

    const signal = await shutdownSignal();
    out(`${dim(`Received ${signal}, shutting down…`)}`);
    try {
      await server.close();
    } finally {
      cleanup();
      process.off('exit', cleanup);
    }
    out('ContextScope stopped.');
  };

  addServerOptions(program.command('start'))
    .description('start the proxy and dashboard')
    .option('--demo', 'seed deterministic synthetic demo traces (uses a separate data dir)')
    .option('-d, --detach', 'run in the background (log: <data-dir>/contextscope.log)')
    .action(async (_o: unknown, cmd: Command) => runStart('start', cmd));

  addServerOptions(program.command('demo'))
    .description('start with synthetic demo data in a separate data dir (.contextscope-demo)')
    .option('-d, --detach', 'run in the background')
    .action(async (_o: unknown, cmd: Command) => runStart('demo', cmd));

  addLocationOptions(program.command('import'))
    .description('import a trace file offline (contextscope.trace JSON or JSONL); nothing is sent anywhere')
    .argument('<file>', 'trace file')
    .action(async (fileArg: string, _o: unknown, cmd: Command) => {
      const { config } = load(flagsOf(cmd));
      const path = resolve(io.cwd, fileArg);
      if (!existsSync(path)) throw new CliExit(1, `File not found: ${path}`);
      const { importTraceFile } = await getServer();
      const result = await importTraceFile(path, config);
      out(`Imported ${result.imported}, skipped ${result.skipped}, errors ${result.errors.length}.`);
      for (const e of result.errors.slice(0, 50)) err(`  ${red('✗')} trace #${e.index}: ${e.message}`);
      if (result.errors.length > 50) err(`  … and ${result.errors.length - 50} more`);
      if (result.imported === 0 && (result.errors.length > 0 || result.skipped > 0)) {
        throw new CliExit(1, 'No traces were imported.');
      }
    });

  addLocationOptions(program.command('export'))
    .description('export stored request records (metadata, no secrets) as JSON')
    .requiredOption('-o, --out <file>', 'output file')
    .option('--from <iso>', 'only requests started at or after this ISO date/time')
    .option('--to <iso>', 'only requests started before this ISO date/time')
    .action(async (_o: unknown, cmd: Command) => {
      const o = cmd.opts<{ out: string; from?: string; to?: string }>();
      for (const [k, v] of [['--from', o.from], ['--to', o.to]] as const) {
        if (v !== undefined && Number.isNaN(Date.parse(v))) throw new CliExit(2, `${k}: not a valid date/time: ${v}`);
      }
      const { config } = load(flagsOf(cmd));
      const { exportRecords } = await getServer();
      const outPath = resolve(io.cwd, o.out);
      const n = await exportRecords(config, {
        out: outPath,
        ...(o.from !== undefined ? { from: new Date(o.from).toISOString() } : {}),
        ...(o.to !== undefined ? { to: new Date(o.to).toISOString() } : {}),
      });
      out(`Exported ${n} record${n === 1 ? '' : 's'} to ${outPath}`);
    });

  addLocationOptions(program.command('status'))
    .description('show whether ContextScope is running')
    .option('--demo', 'check the demo instance')
    .option('--auth-token <token>', 'token for /api/health (default from config/env)')
    .action(async (_o: unknown, cmd: Command) => {
      const { config } = load(flagsOf(cmd));
      const s = await getStatus(config.dataDir, config.authToken);
      if (s.state === 'stopped') {
        out(`${dim('●')} ContextScope is not running${s.staleCleaned ? ' (removed a stale pid file)' : ''}.`);
        throw new CliExit(3);
      }
      const info = s.info;
      if (info === null) throw new CliExit(3);
      const url = baseUrl(info.host, info.port);
      if (s.state === 'running') {
        out(`${green('●')} ContextScope is running${s.health?.demo ? ' [demo]' : ''}`);
      } else {
        out(`${yellow('●')} ContextScope process is alive but /api/health fails: ${s.health?.error ?? 'unknown error'}`);
      }
      out(`  pid        ${info.pid}`);
      out(`  url        ${url}/`);
      out(`  started    ${info.startedAt}`);
      if (s.health?.version) out(`  version    ${s.health.version}`);
      out(`  data dir   ${config.dataDir}`);
      if (s.state !== 'running') throw new CliExit(1);
    });

  addLocationOptions(program.command('stop'))
    .description('stop a running ContextScope (SIGTERM, waits up to 10 s)')
    .option('--demo', 'stop the demo instance')
    .action(async (_o: unknown, cmd: Command) => {
      const { config } = load(flagsOf(cmd));
      const r = await stopServer(config.dataDir);
      switch (r.result) {
        case 'not_running':
          out(`ContextScope is not running${r.staleCleaned ? ' (removed a stale pid file)' : ''}.`);
          return;
        case 'stopped':
          out(`${green('✓')} Stopped ContextScope (pid ${r.pid}).`);
          return;
        case 'timeout':
          throw new CliExit(1, `ContextScope (pid ${r.pid}) did not exit within 10 s. Check ${logFilePath(config.dataDir)}.`);
        case 'error':
          throw new CliExit(1, `Could not signal pid ${r.pid}: ${r.message}`);
      }
    });

  addServerOptions(program.command('doctor'))
    .description('check the environment (Node, data dir, SQLite, port, dashboard, DNS, config)')
    .action(async (_o: unknown, cmd: Command) => {
      let config: ContextScopeConfig;
      const results: CheckResult[] = [];
      try {
        const loaded = load(flagsOf(cmd));
        config = loaded.config;
        results.push({ name: 'Config valid', status: 'ok', detail: loaded.file ?? 'no config file (env + defaults)' });
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        results.push({ name: 'Config valid', status: 'fail', detail: e.format().replace(/\n/g, ' ') });
        const dataDir = resolve(io.cwd, '.contextscope');
        config = configSchema.parse({ dataDir, dbPath: resolve(dataDir, 'contextscope.db') });
      }
      results.unshift(...(await runDoctorChecks(config, io.cwd)));
      for (const r of results) {
        const mark = r.status === 'ok' ? green('✓') : r.status === 'warn' ? yellow('!') : red('✗');
        out(`${mark} ${r.name.padEnd(20)} ${dim(r.detail)}`);
      }
      const failed = results.filter((r) => r.status === 'fail').length;
      const warned = results.filter((r) => r.status === 'warn').length;
      out('');
      out(failed > 0 ? red(`${failed} check(s) failed.`) : green(`All checks passed${warned ? ` (${warned} warning(s))` : ''}.`));
      if (failed > 0) throw new CliExit(1);
    });

  addServerOptions(program.command('config'))
    .description('print the effective configuration (secrets masked) with the source of each value')
    .option('--demo', 'show the demo configuration')
    .option('--path', 'only print the config file in use')
    .action((_o: unknown, cmd: Command) => {
      const o = cmd.opts<{ path?: boolean }>();
      const { config, sources, file } = load(flagsOf(cmd));
      if (o.path === true) {
        out(file ?? '(no config file; using environment and defaults)');
        return;
      }
      out(JSON.stringify({ file, config: maskConfig(config), sources }, null, 2));
    });

  program.addHelpText(
    'after',
    `
Examples:
  $ contextscope start                 proxy + dashboard on http://127.0.0.1:3377
  $ contextscope demo                  try it with synthetic data (separate data dir)
  $ contextscope start --detach        run in the background; \`contextscope stop\` to end
  $ contextscope import traces.json    analyse recorded traces offline
  $ contextscope doctor                check the setup

Configuration precedence: flags > CONTEXTSCOPE_* environment > config file > defaults.
Docs: docs/configuration.md`,
  );

  return program;
}

/** Parse and run; returns the process exit code instead of exiting (testable). */
export async function runCli(argv: string[], opts: ProgramOptions = {}): Promise<number> {
  const io = opts.io ?? defaultIO();
  const program = buildProgram({ ...opts, io });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CliExit) {
      if (e.message) io.stderr(`${red('error:')} ${e.message}\n`);
      return e.code;
    }
    if (e instanceof ConfigError) {
      io.stderr(`${red('error:')} ${e.format()}\n`);
      return e.exitCode;
    }
    if (e instanceof CommanderError) {
      // --help / --version exit 0; usage errors (already printed by commander) exit 2.
      return e.exitCode === 0 ? 0 : 2;
    }
    io.stderr(`${red('error:')} ${(e as Error).message ?? String(e)}\n`);
    return 1;
  }
}
