import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { configSchema, isLoopbackHost } from '@contextscope/shared';
import type { ContextScopeConfig } from '@contextscope/shared';

/** Where an effective configuration value came from. */
export type ConfigSource = 'flag' | 'env' | 'file' | 'default';

/** CLI flags that map onto configuration (all optional; absent = not given). */
export interface ConfigFlags {
  host?: string;
  port?: string | number;
  db?: string;
  dataDir?: string;
  capture?: string;
  logLevel?: string;
  authToken?: string;
  config?: string;
  webDir?: string;
  demo?: boolean;
}

export interface LoadConfigOptions {
  flags?: ConfigFlags;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface LoadedConfig {
  config: ContextScopeConfig;
  /** Source per leaf path, e.g. `capture.mode` → 'env'. */
  sources: Record<string, ConfigSource>;
  /** Absolute path of the config file used, or null. */
  file: string | null;
}

export const CONFIG_FILE_NAME = 'contextscope.config.json';
export const DB_FILE_NAME = 'contextscope.db';
export const DEMO_DATA_DIR = '.contextscope-demo';
export const MIN_AUTH_TOKEN_LENGTH = 16;

/** A configuration problem the CLI reports and exits on (exit code 2). */
export class ConfigError extends Error {
  readonly exitCode = 2;
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }

  /** Human-readable multi-line report. */
  format(): string {
    return [this.message, ...this.details.map((d) => `  - ${d}`)].join('\n');
  }
}

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

const deepMerge = (base: Plain, over: Plain): Plain => {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isPlain(prev) && isPlain(v) ? deepMerge(prev, v) : v;
  }
  return out;
};

/** Dotted leaf paths of an input object (arrays and primitives are leaves). */
const leafPaths = (obj: Plain, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) => {
    if (v === undefined) return [];
    const path = prefix ? `${prefix}.${k}` : k;
    return isPlain(v) && Object.keys(v).length > 0 ? leafPaths(v, path) : [path];
  });

const setPath = (obj: Plain, path: string, value: unknown): void => {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    if (!isPlain(next)) cur[p] = {};
    cur = cur[p] as Plain;
  }
  cur[parts[parts.length - 1] as string] = value;
};

/** Numbers stay strings when they don't parse, so the schema reports a clear error. */
const num = (v: string): number | string => {
  const t = v.trim();
  if (t === '') return v;
  const n = Number(t);
  return Number.isFinite(n) ? n : v;
};

const ENV_MAP: Record<string, { path: string; type: 'string' | 'number' }> = {
  CONTEXTSCOPE_HOST: { path: 'host', type: 'string' },
  CONTEXTSCOPE_PORT: { path: 'port', type: 'number' },
  CONTEXTSCOPE_DB: { path: 'dbPath', type: 'string' },
  CONTEXTSCOPE_DATA_DIR: { path: 'dataDir', type: 'string' },
  CONTEXTSCOPE_CAPTURE_MODE: { path: 'capture.mode', type: 'string' },
  CONTEXTSCOPE_CONTENT_RETENTION_HOURS: { path: 'capture.contentRetentionHours', type: 'number' },
  CONTEXTSCOPE_METADATA_RETENTION_DAYS: { path: 'capture.metadataRetentionDays', type: 'number' },
  CONTEXTSCOPE_LOG_LEVEL: { path: 'logLevel', type: 'string' },
  CONTEXTSCOPE_AUTH_TOKEN: { path: 'authToken', type: 'string' },
  CONTEXTSCOPE_PRICING_FILE: { path: 'pricingFile', type: 'string' },
  CONTEXTSCOPE_OPENAI_UPSTREAM: { path: 'upstreams.openai', type: 'string' },
  CONTEXTSCOPE_ANTHROPIC_UPSTREAM: { path: 'upstreams.anthropic', type: 'string' },
  CONTEXTSCOPE_GEMINI_UPSTREAM: { path: 'upstreams.gemini', type: 'string' },
  CONTEXTSCOPE_MAX_INSPECT_BYTES: { path: 'limits.maxInspectBytes', type: 'number' },
  CONTEXTSCOPE_REQUEST_TIMEOUT_MS: { path: 'limits.idleTimeoutMs', type: 'number' },
  CONTEXTSCOPE_WEB_DIR: { path: 'webDir', type: 'string' },
};

/** Environment variables understood by the CLI (for docs and `doctor`). */
export const ENV_VARS: readonly string[] = [...Object.keys(ENV_MAP), 'CONTEXTSCOPE_CONFIG'];

const fromEnv = (env: NodeJS.ProcessEnv): Plain => {
  const out: Plain = {};
  for (const [name, { path, type }] of Object.entries(ENV_MAP)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    setPath(out, path, type === 'number' ? num(raw) : raw);
  }
  return out;
};

const fromFlags = (flags: ConfigFlags): Plain => {
  const out: Plain = {};
  if (flags.host !== undefined) out.host = flags.host;
  if (flags.port !== undefined) out.port = typeof flags.port === 'number' ? flags.port : num(flags.port);
  if (flags.db !== undefined) out.dbPath = flags.db;
  if (flags.dataDir !== undefined) out.dataDir = flags.dataDir;
  if (flags.capture !== undefined) setPath(out, 'capture.mode', flags.capture);
  if (flags.logLevel !== undefined) out.logLevel = flags.logLevel;
  if (flags.authToken !== undefined) out.authToken = flags.authToken;
  if (flags.webDir !== undefined) out.webDir = flags.webDir;
  if (flags.demo === true) out.demo = true;
  return out;
};

const PATH_KEYS = ['dataDir', 'dbPath', 'pricingFile', 'webDir'] as const;

/** Relative paths resolve against `base` (cwd for flags/env, the file's folder for the file). */
const resolvePaths = (layer: Plain, base: string): Plain => {
  const out = { ...layer };
  for (const key of PATH_KEYS) {
    const v = out[key];
    if (typeof v === 'string' && v !== '' && v !== ':memory:' && !isAbsolute(v)) out[key] = resolve(base, v);
  }
  return out;
};

const readConfigFile = (file: string): Plain => {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isPlain(parsed)) throw new ConfigError(`Config file ${file} must contain a JSON object`);
  return parsed;
};

const locateConfigFile = (flags: ConfigFlags, env: NodeJS.ProcessEnv, cwd: string): string | null => {
  const explicit = flags.config ?? (env.CONTEXTSCOPE_CONFIG || undefined);
  if (explicit !== undefined) {
    const file = resolve(cwd, explicit);
    if (!existsSync(file)) throw new ConfigError(`Config file not found: ${file}`);
    return file;
  }
  const implicit = join(cwd, CONFIG_FILE_NAME);
  return existsSync(implicit) ? implicit : null;
};

/**
 * Effective configuration. Precedence (highest first): flags > env (CONTEXTSCOPE_*) > config file > defaults.
 * `dbPath` defaults to `<dataDir>/contextscope.db`. In demo mode the data dir defaults to `.contextscope-demo`
 * (a data dir from env/file becomes `<dir>/demo`; flags are used as given) so demo data never mixes with real data.
 * Throws ConfigError on invalid input or an unsafe (non-loopback, no token) setup.
 */
export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const flags = opts.flags ?? {};
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const file = locateConfigFile(flags, env, cwd);
  const layers: [ConfigSource, Plain][] = [];
  if (file !== null) layers.push(['file', resolvePaths(readConfigFile(file), dirname(file))]);
  layers.push(['env', resolvePaths(fromEnv(env), cwd)]);
  layers.push(['flag', resolvePaths(fromFlags(flags), cwd)]);

  if (flags.demo === true) {
    // Demo data lives apart from real data: a data dir from env/file gets a `demo` subfolder,
    // a database path from env/file is ignored. Only explicit flags are used as given.
    for (const [source, layer] of layers) {
      if (source === 'flag') continue;
      if (typeof layer.dataDir === 'string') layer.dataDir = join(layer.dataDir, 'demo');
      delete layer.dbPath;
    }
  }

  const sources: Record<string, ConfigSource> = {};
  let merged: Plain = {};
  for (const [source, layer] of layers) {
    merged = deepMerge(merged, layer);
    for (const p of leafPaths(layer)) sources[p] = source;
  }

  if (merged.dataDir === undefined) {
    merged.dataDir = resolve(cwd, flags.demo === true ? DEMO_DATA_DIR : '.contextscope');
  }
  if (merged.dbPath === undefined && typeof merged.dataDir === 'string') {
    merged.dbPath = join(merged.dataDir, DB_FILE_NAME);
  }

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const details = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.map(String).join('.') : '(root)';
      const src = sources[path] ?? sourceOfPrefix(sources, path);
      return `${path}: ${i.message}${src ? ` (from ${src})` : ''}`;
    });
    throw new ConfigError('Invalid configuration:', details);
  }
  const config = result.data;

  if (config.authToken !== null && config.authToken.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new ConfigError(`Auth token is too short: use at least ${MIN_AUTH_TOKEN_LENGTH} characters.`);
  }
  if (!isLoopbackHost(config.host) && config.authToken === null) {
    throw new ConfigError(
      `Refusing to listen on non-loopback host "${config.host}" without an auth token.`,
      [
        `Set one with --auth-token <token> or CONTEXTSCOPE_AUTH_TOKEN (at least ${MIN_AUTH_TOKEN_LENGTH} characters, e.g. \`openssl rand -hex 32\`).`,
        'ContextScope speaks plain HTTP: put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front of it for any remote access.',
        'For local use keep the default host 127.0.0.1.',
      ],
    );
  }

  const leaves = leafPaths(config as unknown as Plain);
  const fullSources: Record<string, ConfigSource> = {};
  for (const p of leaves) fullSources[p] = sources[p] ?? sourceOfPrefix(sources, p) ?? 'default';
  return { config, sources: fullSources, file };
}

/** Source of a value given as a whole object/array higher up (e.g. `customProviders`). */
const sourceOfPrefix = (sources: Record<string, ConfigSource>, path: string): ConfigSource | undefined => {
  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const s = sources[parts.slice(0, i).join('.')];
    if (s) return s;
  }
  return undefined;
};

const SECRET_KEYS = new Set(['authToken']);

/** Copy of the config with secrets replaced by a mask (for printing). */
export const maskConfig = (config: ContextScopeConfig): Plain => {
  const walk = (v: unknown, key: string): unknown => {
    if (SECRET_KEYS.has(key)) return v === null || v === undefined ? v : '********';
    if (Array.isArray(v)) return v.map((x) => walk(x, ''));
    if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(config, '') as Plain;
};
