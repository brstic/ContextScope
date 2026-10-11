import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, maskConfig } from '../src/config.js';
import { runCli } from '../src/commands.js';
import type { CliIO } from '../src/output.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cs-cli-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

const capture = (env: NodeJS.ProcessEnv = {}): CliIO & { out: () => string; err: () => string } => {
  let o = '';
  let e = '';
  return {
    stdout: (t) => {
      o += t;
    },
    stderr: (t) => {
      e += t;
    },
    env,
    cwd: dir,
    out: () => o,
    err: () => e,
  };
};

describe('loadConfig precedence', () => {
  it('uses defaults with dbPath under dataDir', () => {
    const { config, sources, file } = loadConfig({ env: {}, cwd: dir });
    expect(file).toBeNull();
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3377);
    expect(config.dataDir).toBe(join(dir, '.contextscope'));
    expect(config.dbPath).toBe(join(dir, '.contextscope', 'contextscope.db'));
    expect(config.capture.mode).toBe('metadata');
    expect(sources.port).toBe('default');
    expect(sources['capture.mode']).toBe('default');
  });

  it('flags > env > file > defaults', () => {
    writeFileSync(
      join(dir, 'contextscope.config.json'),
      JSON.stringify({ port: 4001, logLevel: 'warn', capture: { mode: 'deep_memory' }, dataDir: 'from-file' }),
    );
    const env = { CONTEXTSCOPE_PORT: '4002', CONTEXTSCOPE_LOG_LEVEL: 'debug' };
    const { config, sources, file } = loadConfig({ env, cwd: dir, flags: { port: '4003' } });
    expect(file).toBe(join(dir, 'contextscope.config.json'));
    expect(config.port).toBe(4003);
    expect(sources.port).toBe('flag');
    expect(config.logLevel).toBe('debug');
    expect(sources.logLevel).toBe('env');
    expect(config.capture.mode).toBe('deep_memory');
    expect(sources['capture.mode']).toBe('file');
    // relative paths in the file resolve against the file's folder
    expect(config.dataDir).toBe(join(dir, 'from-file'));
    expect(config.dbPath).toBe(join(dir, 'from-file', 'contextscope.db'));
    expect(sources.host).toBe('default');
  });

  it('maps every documented env var', () => {
    const env = {
      CONTEXTSCOPE_HOST: '127.0.0.2',
      CONTEXTSCOPE_DB: 'x/y.db',
      CONTEXTSCOPE_DATA_DIR: 'data',
      CONTEXTSCOPE_CAPTURE_MODE: 'deep_persistent',
      CONTEXTSCOPE_CONTENT_RETENTION_HOURS: '12',
      CONTEXTSCOPE_METADATA_RETENTION_DAYS: '30',
      CONTEXTSCOPE_AUTH_TOKEN: TOKEN,
      CONTEXTSCOPE_PRICING_FILE: 'prices.json',
      CONTEXTSCOPE_OPENAI_UPSTREAM: 'http://127.0.0.1:9001',
      CONTEXTSCOPE_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:9002',
      CONTEXTSCOPE_GEMINI_UPSTREAM: 'http://127.0.0.1:9003',
      CONTEXTSCOPE_MAX_INSPECT_BYTES: '1024',
      CONTEXTSCOPE_REQUEST_TIMEOUT_MS: '5000',
      CONTEXTSCOPE_WEB_DIR: 'web',
    };
    const { config } = loadConfig({ env, cwd: dir });
    expect(config.host).toBe('127.0.0.2');
    expect(config.dbPath).toBe(join(dir, 'x/y.db'));
    expect(config.dataDir).toBe(join(dir, 'data'));
    expect(config.capture).toMatchObject({ mode: 'deep_persistent', contentRetentionHours: 12, metadataRetentionDays: 30 });
    expect(config.authToken).toBe(TOKEN);
    expect(config.pricingFile).toBe(join(dir, 'prices.json'));
    expect(config.upstreams.anthropic).toBe('http://127.0.0.1:9002');
    expect(config.limits.maxInspectBytes).toBe(1024);
    expect(config.limits.idleTimeoutMs).toBe(5000);
    expect(config.webDir).toBe(join(dir, 'web'));
  });

  it('reads --config and CONTEXTSCOPE_CONFIG', () => {
    const f = join(dir, 'custom.json');
    writeFileSync(f, JSON.stringify({ port: 5000 }));
    expect(loadConfig({ env: {}, cwd: dir, flags: { config: 'custom.json' } }).config.port).toBe(5000);
    expect(loadConfig({ env: { CONTEXTSCOPE_CONFIG: f }, cwd: dir }).file).toBe(f);
    expect(() => loadConfig({ env: {}, cwd: dir, flags: { config: 'missing.json' } })).toThrow(/not found/);
  });

  it('demo uses a separate data dir', () => {
    const { config } = loadConfig({ env: { CONTEXTSCOPE_DATA_DIR: '/srv/data' }, cwd: dir, flags: { demo: true } });
    expect(config.demo).toBe(true);
    expect(config.dataDir).toBe('/srv/data/demo');
    expect(loadConfig({ env: {}, cwd: dir, flags: { demo: true } }).config.dataDir).toBe(join(dir, '.contextscope-demo'));
  });
});

describe('invalid configuration', () => {
  it('throws ConfigError listing zod issue paths', () => {
    try {
      loadConfig({ env: { CONTEXTSCOPE_PORT: 'eighty', CONTEXTSCOPE_CAPTURE_MODE: 'everything' }, cwd: dir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const text = (e as ConfigError).format();
      expect(text).toMatch(/port: /);
      expect(text).toMatch(/capture\.mode: /);
      expect(text).toMatch(/from env/);
    }
  });

  it('rejects a non-JSON config file', () => {
    writeFileSync(join(dir, 'contextscope.config.json'), '{ port: 1 ');
    expect(() => loadConfig({ env: {}, cwd: dir })).toThrow(/not valid JSON/);
  });

  it('CLI exits 2 with the message', async () => {
    const io = capture({ CONTEXTSCOPE_PORT: '99999' });
    const code = await runCli(['config'], { io });
    expect(code).toBe(2);
    expect(io.err()).toMatch(/Invalid configuration/);
    expect(io.err()).toMatch(/port:/);
  });
});

describe('non-loopback host', () => {
  it('is rejected without a token', () => {
    expect(() => loadConfig({ env: { CONTEXTSCOPE_HOST: '0.0.0.0' }, cwd: dir })).toThrow(/--auth-token.*CONTEXTSCOPE_AUTH_TOKEN|non-loopback/s);
    try {
      loadConfig({ env: {}, cwd: dir, flags: { host: '0.0.0.0' } });
    } catch (e) {
      const text = (e as ConfigError).format();
      expect(text).toMatch(/--auth-token/);
      expect(text).toMatch(/CONTEXTSCOPE_AUTH_TOKEN/);
      expect(text).toMatch(/TLS/);
    }
  });

  it('is accepted with a token of 16+ chars, short tokens are rejected', () => {
    expect(loadConfig({ env: { CONTEXTSCOPE_AUTH_TOKEN: TOKEN }, cwd: dir, flags: { host: '0.0.0.0' } }).config.host).toBe(
      '0.0.0.0',
    );
    try {
      loadConfig({ env: {}, cwd: dir, flags: { host: '0.0.0.0', authToken: 'short' } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).format()).toMatch(/authToken/);
    }
  });

  it('start refuses with exit 2 before starting anything', async () => {
    const io = capture({});
    let started = false;
    const code = await runCli(['start', '--host', '0.0.0.0'], {
      io,
      server: () => {
        started = true;
        return Promise.reject(new Error('should not load'));
      },
    });
    expect(code).toBe(2);
    expect(started).toBe(false);
    expect(io.err()).toMatch(/CONTEXTSCOPE_AUTH_TOKEN/);
  });
});

describe('config command', () => {
  it('masks secrets and reports sources', async () => {
    const io = capture({ CONTEXTSCOPE_AUTH_TOKEN: TOKEN });
    const code = await runCli(['config', '--port', '4100'], { io });
    expect(code).toBe(0);
    expect(io.out()).not.toContain(TOKEN);
    const parsed = JSON.parse(io.out()) as { config: { authToken: string; port: number }; sources: Record<string, string> };
    expect(parsed.config.authToken).toBe('********');
    expect(parsed.config.port).toBe(4100);
    expect(parsed.sources.port).toBe('flag');
    expect(parsed.sources.authToken).toBe('env');
  });

  it('--path prints the file used', async () => {
    writeFileSync(join(dir, 'contextscope.config.json'), '{}');
    const io = capture({});
    expect(await runCli(['config', '--path'], { io })).toBe(0);
    expect(io.out().trim()).toBe(join(dir, 'contextscope.config.json'));
  });

  it('maskConfig leaves null tokens alone', () => {
    const { config } = loadConfig({ env: {}, cwd: dir });
    expect(maskConfig(config).authToken).toBeNull();
  });

  it('--version prints the package version', async () => {
    const io = capture({});
    expect(await runCli(['--version'], { io })).toBe(0);
    expect(io.out().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
