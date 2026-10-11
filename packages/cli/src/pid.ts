import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PID_FILE_NAME = 'contextscope.pid';
export const LOG_FILE_NAME = 'contextscope.log';

export interface PidInfo {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
}

export const pidFilePath = (dataDir: string): string => join(dataDir, PID_FILE_NAME);
export const logFilePath = (dataDir: string): string => join(dataDir, LOG_FILE_NAME);

const isPidInfo = (v: unknown): v is PidInfo => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.pid === 'number' &&
    Number.isInteger(o.pid) &&
    o.pid > 0 &&
    typeof o.port === 'number' &&
    typeof o.host === 'string' &&
    typeof o.startedAt === 'string'
  );
};

/** The pid file's content, or null when it is missing or unreadable/corrupt. */
export const readPidFile = (dataDir: string): PidInfo | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pidFilePath(dataDir), 'utf8'));
    return isPidInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writePidFile = (dataDir: string, info: PidInfo): void => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pidFilePath(dataDir), `${JSON.stringify(info)}\n`, { mode: 0o644 });
};

/** Remove the pid file; with `onlyPid`, only when it still belongs to that process. */
export const removePidFile = (dataDir: string, onlyPid?: number): void => {
  if (onlyPid !== undefined) {
    const current = readPidFile(dataDir);
    if (current !== null && current.pid !== onlyPid) return;
  }
  rmSync(pidFilePath(dataDir), { force: true });
};

/** process.kill(pid, 0): true while the process exists (EPERM = exists, owned by someone else). */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Host to dial for a bind address: wildcard binds are reached via loopback. */
export const dialHost = (host: string): string => {
  if (host === '0.0.0.0' || host === '') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
};

export const baseUrl = (host: string, port: number): string => {
  const h = dialHost(host);
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}`;
};

export interface HealthResult {
  ok: boolean;
  status: number | null;
  version: string | null;
  demo: boolean | null;
  error: string | null;
}

/** GET /api/health with the bearer token when configured. Never throws. */
export const checkHealth = async (
  host: string,
  port: number,
  authToken: string | null,
  timeoutMs = 3000,
): Promise<HealthResult> => {
  try {
    const res = await fetch(`${baseUrl(host, port)}/api/health`, {
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return {
      ok: res.ok && body.ok === true,
      status: res.status,
      version: typeof body.version === 'string' ? body.version : null,
      demo: typeof body.demo === 'boolean' ? body.demo : null,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return { ok: false, status: null, version: null, demo: null, error: e.cause?.code ?? e.message };
  }
};

export type ServerState = 'running' | 'unresponsive' | 'stopped';

export interface StatusResult {
  state: ServerState;
  info: PidInfo | null;
  health: HealthResult | null;
  /** True when a pid file pointed at a dead process and was removed. */
  staleCleaned: boolean;
}

/** Read the pid file, check the process and /api/health; a stale pid file is removed. */
export const getStatus = async (dataDir: string, authToken: string | null): Promise<StatusResult> => {
  const info = readPidFile(dataDir);
  if (info === null) {
    // A corrupt pid file is as good as none: clean it up.
    const hadFile = (() => {
      try {
        readFileSync(pidFilePath(dataDir));
        return true;
      } catch {
        return false;
      }
    })();
    if (hadFile) removePidFile(dataDir);
    return { state: 'stopped', info: null, health: null, staleCleaned: hadFile };
  }
  if (!isAlive(info.pid)) {
    removePidFile(dataDir, info.pid);
    return { state: 'stopped', info, health: null, staleCleaned: true };
  }
  const health = await checkHealth(info.host, info.port, authToken);
  return { state: health.ok ? 'running' : 'unresponsive', info, health, staleCleaned: false };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const waitForExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
};

export type StopResult =
  | { result: 'not_running'; staleCleaned: boolean }
  | { result: 'stopped'; pid: number }
  | { result: 'timeout'; pid: number }
  | { result: 'error'; pid: number; message: string };

/** SIGTERM the recorded process and wait up to `timeoutMs` (default 10 s) for it to exit. */
export const stopServer = async (dataDir: string, timeoutMs = 10_000): Promise<StopResult> => {
  const info = readPidFile(dataDir);
  if (info === null || !isAlive(info.pid)) {
    const staleCleaned = info !== null;
    if (info !== null) removePidFile(dataDir, info.pid);
    return { result: 'not_running', staleCleaned };
  }
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (err) {
    return { result: 'error', pid: info.pid, message: (err as Error).message };
  }
  const exited = await waitForExit(info.pid, timeoutMs);
  if (!exited) return { result: 'timeout', pid: info.pid };
  removePidFile(dataDir, info.pid);
  return { result: 'stopped', pid: info.pid };
};

export interface DetachOptions {
  /** Absolute path of the CLI entry (bin.js). */
  bin: string;
  /** Arguments after the bin, e.g. ['start', '--port', '3377']. */
  args: string[];
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Spawn `node <bin> <args>` detached, stdout/stderr appended to <dataDir>/contextscope.log.
 * Writes a provisional pid file (the child rewrites it with the bound port once listening).
 */
export const spawnDetached = (opts: DetachOptions): { pid: number; logFile: string } => {
  mkdirSync(opts.dataDir, { recursive: true });
  const logFile = logFilePath(opts.dataDir);
  const fd = openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [opts.bin, ...opts.args], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: opts.env ?? process.env,
      cwd: opts.cwd ?? process.cwd(),
    });
    if (child.pid === undefined) throw new Error('failed to spawn the background process');
    child.unref();
    return { pid: child.pid, logFile };
  } finally {
    closeSync(fd);
  }
};

/** Wait until the detached child is healthy (true) or has died / timed out (false). */
export const waitForHealthy = async (
  pid: number,
  dataDir: string,
  authToken: string | null,
  timeoutMs = 20_000,
): Promise<PidInfo | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return null;
    const info = readPidFile(dataDir);
    if (info !== null && info.pid === pid) {
      const h = await checkHealth(info.host, info.port, authToken, 1000);
      if (h.ok) return info;
    }
    await sleep(200);
  }
  return null;
};
