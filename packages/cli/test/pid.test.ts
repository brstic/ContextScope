import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStatus, isAlive, pidFilePath, readPidFile, stopServer, writePidFile } from '../src/pid.js';
import { runCli } from '../src/commands.js';
import type { CliIO } from '../src/output.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cs-cli-pid-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pid that certainly does not exist: spawn a process and wait for it to exit. */
const deadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => child.once('exit', r));
  return child.pid as number;
};

const io = (): CliIO & { out: () => string } => {
  let o = '';
  return {
    stdout: (t) => {
      o += t;
    },
    stderr: () => undefined,
    env: { CONTEXTSCOPE_DATA_DIR: join(dir, 'data') },
    cwd: dir,
    out: () => o,
  };
};

describe('pid file', () => {
  it('round-trips and rejects corrupt content', () => {
    writePidFile(dir, { pid: 123, port: 3377, host: '127.0.0.1', startedAt: '2026-10-11T00:00:00.000Z' });
    expect(readPidFile(dir)).toEqual({ pid: 123, port: 3377, host: '127.0.0.1', startedAt: '2026-10-11T00:00:00.000Z' });
    writeFileSync(pidFilePath(dir), 'not json');
    expect(readPidFile(dir)).toBeNull();
  });

  it('status cleans a stale pid file (dead process)', async () => {
    const pid = await deadPid();
    expect(isAlive(pid)).toBe(false);
    writePidFile(dir, { pid, port: 1, host: '127.0.0.1', startedAt: new Date().toISOString() });
    const s = await getStatus(dir, null);
    expect(s.state).toBe('stopped');
    expect(s.staleCleaned).toBe(true);
    expect(existsSync(pidFilePath(dir))).toBe(false);
  });

  it('status cleans a corrupt pid file', async () => {
    writeFileSync(pidFilePath(dir), '{"pid":"x"}');
    const s = await getStatus(dir, null);
    expect(s).toMatchObject({ state: 'stopped', staleCleaned: true });
    expect(existsSync(pidFilePath(dir))).toBe(false);
  });

  it('status reports running when the process is alive and /api/health answers (with token)', async () => {
    let auth: string | undefined;
    const srv = createServer((req, res) => {
      auth = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, version: '1.0.0', demo: false }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    try {
      writePidFile(dir, { pid: process.pid, port, host: '127.0.0.1', startedAt: new Date().toISOString() });
      const s = await getStatus(dir, 'tok-tok-tok-tok-tok');
      expect(s.state).toBe('running');
      expect(s.health?.version).toBe('1.0.0');
      expect(auth).toBe('Bearer tok-tok-tok-tok-tok');
    } finally {
      srv.close();
    }
  });

  it('status reports unresponsive when alive but health fails', async () => {
    writePidFile(dir, { pid: process.pid, port: 1, host: '127.0.0.1', startedAt: new Date().toISOString() });
    const s = await getStatus(dir, null);
    expect(s.state).toBe('unresponsive');
    expect(existsSync(pidFilePath(dir))).toBe(true);
  });

  it('stop SIGTERMs the process and removes the pid file', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid as number;
    writePidFile(dir, { pid, port: 1, host: '127.0.0.1', startedAt: new Date().toISOString() });
    const r = await stopServer(dir, 5000);
    expect(r).toEqual({ result: 'stopped', pid });
    expect(existsSync(pidFilePath(dir))).toBe(false);
  });

  it('stop on a stale pid file reports not running', async () => {
    writePidFile(dir, { pid: await deadPid(), port: 1, host: '127.0.0.1', startedAt: new Date().toISOString() });
    expect(await stopServer(dir)).toEqual({ result: 'not_running', staleCleaned: true });
  });

  it('CLI status exits 3 and mentions the stale file', async () => {
    const data = join(dir, 'data');
    mkdirSync(data);
    writePidFile(data, { pid: await deadPid(), port: 1, host: '127.0.0.1', startedAt: new Date().toISOString() });
    const c = io();
    expect(await runCli(['status'], { io: c })).toBe(3);
    expect(c.out()).toMatch(/not running.*stale/);
  });
});

describe('foreground start lifecycle (mock server)', () => {
  it('writes the pid file, prints the banner and removes the file on shutdown', async () => {
    const c = io();
    let release: (s: string) => void = () => undefined;
    let closed = false;
    const done = runCli(['start', '--port', '4555'], {
      io: c,
      shutdownSignal: () => new Promise((r) => (release = r)),
      server: () =>
        Promise.resolve({
          startServer: (cfg) =>
            Promise.resolve({
              url: `http://127.0.0.1:${cfg.port}`,
              port: cfg.port,
              ctx: {} as never,
              close: () => {
                closed = true;
                return Promise.resolve();
              },
            }),
          importTraceFile: () => Promise.reject(new Error('unused')),
          exportRecords: () => Promise.reject(new Error('unused')),
        }),
    });
    const data = join(dir, 'data');
    for (let i = 0; i < 50 && readPidFile(data) === null; i++) await new Promise((r) => setTimeout(r, 20));
    expect(readPidFile(data)).toMatchObject({ pid: process.pid, port: 4555, host: '127.0.0.1' });
    expect(c.out()).toContain('http://127.0.0.1:4555/openai/v1');
    expect(c.out()).toContain('http://127.0.0.1:4555/anthropic');
    expect(c.out()).toContain('/gemini/v1beta/models/gemini-2.5-flash:generateContent');
    release('SIGTERM');
    expect(await done).toBe(0);
    expect(closed).toBe(true);
    expect(readPidFile(data)).toBeNull();
  });

  it('import exits 1 when every trace failed', async () => {
    const c = io();
    const f = join(dir, 't.json');
    writeFileSync(f, '{}');
    const code = await runCli(['import', f], {
      io: c,
      server: () =>
        Promise.resolve({
          startServer: () => Promise.reject(new Error('unused')),
          importTraceFile: () => Promise.resolve({ imported: 0, skipped: 0, errors: [{ index: 0, message: 'bad' }] }),
          exportRecords: () => Promise.reject(new Error('unused')),
        }),
    });
    expect(code).toBe(1);
    expect(c.out()).toMatch(/Imported 0/);
  });
});
