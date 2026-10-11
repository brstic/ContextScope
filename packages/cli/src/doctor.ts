import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContextScopeConfig } from '@contextscope/shared';
import { checkHealth } from './pid.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export const MIN_NODE = [22, 12, 0] as const;

export const nodeVersionOk = (version: string): boolean => {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = MIN_NODE[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
};

export const checkNode = (version = process.versions.node): CheckResult => ({
  name: 'Node.js version',
  status: nodeVersionOk(version) ? 'ok' : 'fail',
  detail: nodeVersionOk(version) ? `v${version}` : `v${version} is too old; ContextScope needs >= ${MIN_NODE.join('.')}`,
});

export const checkDataDir = (dataDir: string): CheckResult => {
  const probe = join(dataDir, `.doctor-${process.pid}.tmp`);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return { name: 'Data dir writable', status: 'ok', detail: dataDir };
  } catch (err) {
    return { name: 'Data dir writable', status: 'fail', detail: `${dataDir}: ${(err as Error).message}` };
  }
};

/** Opens a throw-away database next to the real one (migrations applied) and checks WAL mode. */
export const checkSqlite = async (dataDir: string): Promise<CheckResult> => {
  const name = 'SQLite opens (WAL)';
  const file = join(dataDir, `.doctor-${process.pid}.db`);
  try {
    const { openDatabase } = await import('@contextscope/server');
    const db = openDatabase(file);
    try {
      const mode = String(db.sqlite.pragma('journal_mode', { simple: true }));
      if (mode.toLowerCase() !== 'wal') return { name, status: 'fail', detail: `journal_mode is ${mode}, expected wal` };
      return { name, status: 'ok', detail: 'better-sqlite3 loaded, migrations applied, journal_mode=wal' };
    } finally {
      db.close();
    }
  } catch (err) {
    return { name, status: 'fail', detail: (err as Error).message };
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  }
};

const tryListen = (host: string, port: number): Promise<NodeJS.ErrnoException | null> =>
  new Promise((done) => {
    const srv = createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => done(err));
    srv.listen({ host, port, exclusive: true }, () => srv.close(() => done(null)));
  });

export const checkPort = async (config: ContextScopeConfig): Promise<CheckResult> => {
  const name = 'Port available';
  const err = await tryListen(config.host, config.port);
  if (err === null) return { name, status: 'ok', detail: `${config.host}:${config.port} is free` };
  if (err.code === 'EADDRINUSE') {
    const h = await checkHealth(config.host, config.port, config.authToken);
    if (h.ok || h.status === 401) {
      return { name, status: 'ok', detail: `ContextScope is already running on ${config.host}:${config.port}` };
    }
    return { name, status: 'fail', detail: `${config.host}:${config.port} is used by another program (use --port)` };
  }
  return { name, status: 'fail', detail: `${config.host}:${config.port}: ${err.code ?? err.message}` };
};

/** Same candidates as the server's static handler: webDir, apps/web/dist next to the server package, cwd. */
export const dashboardCandidates = (config: ContextScopeConfig, cwd: string): string[] => {
  const out: string[] = [];
  if (config.webDir) out.push(config.webDir);
  try {
    const serverEntry = fileURLToPath(import.meta.resolve('@contextscope/server'));
    // apps/server/{dist,src}/index.{js,ts} -> apps/web/dist
    out.push(resolve(dirname(serverEntry), '../../web/dist'));
  } catch {
    /* server package not resolvable */
  }
  out.push(resolve(cwd, 'apps/web/dist'));
  return out;
};

export const checkDashboard = (config: ContextScopeConfig, cwd: string): CheckResult => {
  const candidates = dashboardCandidates(config, cwd);
  const found = candidates.find((d) => existsSync(join(d, 'index.html')));
  if (found) return { name: 'Dashboard build', status: 'ok', detail: found };
  return {
    name: 'Dashboard build',
    status: config.webDir ? 'fail' : 'warn',
    detail: `index.html not found (looked in ${candidates.join(', ')}); run \`pnpm build\`. The API still works.`,
  };
};

export const checkDns = async (label: string, origin: string, timeoutMs = 3000): Promise<CheckResult> => {
  const host = new URL(origin).hostname;
  const name = `DNS ${label}`;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    const addr = await Promise.race([lookup(host), timeout]);
    return { name, status: 'ok', detail: `${host} -> ${addr.address}` };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { name, status: 'warn', detail: `${host}: ${e.code ?? e.message} (offline? proxying to it will fail)` };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const runDoctorChecks = async (config: ContextScopeConfig, cwd: string): Promise<CheckResult[]> => {
  const results: CheckResult[] = [checkNode()];
  const dataDir = checkDataDir(config.dataDir);
  results.push(dataDir);
  if (dataDir.status === 'ok') results.push(await checkSqlite(config.dataDir));
  results.push(await checkPort(config));
  results.push(checkDashboard(config, cwd));
  results.push(
    ...(await Promise.all(
      (['openai', 'anthropic', 'gemini'] as const).map((p) => checkDns(p, config.upstreams[p])),
    )),
  );
  return results;
};
