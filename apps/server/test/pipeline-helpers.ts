import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyzer } from '@contextscope/analyzer';
import { createFingerprinter } from '@contextscope/core';
import { createPricing } from '@contextscope/pricing';
import { getAdapter } from '@contextscope/providers';
import { configSchema, type ConfigInput, type LiveEvent } from '@contextscope/shared';
import type { ProviderFixture } from '@contextscope/test-fixtures';
import pino from 'pino';
import { openDatabase, type OpenedDb } from '../src/db/migrate.js';
import { createStore } from '../src/db/store.js';
import { createPipeline } from '../src/pipeline/pipeline.js';
import type { CapturedExchange, LiveHub, Pipeline, Route, Store } from '../src/types.js';

export const CONTENT_KEY = Buffer.alloc(32, 7);

export interface TestEnv {
  dir: string;
  dbPath: string;
  opened: OpenedDb;
  store: Store;
  pipeline: Pipeline;
  events: LiveEvent[];
}

export const collectingHub = (events: LiveEvent[]): LiveHub => ({
  publish: (e) => void events.push(e),
  subscribe: () => () => {},
  subscribers: 0,
  close: () => {},
});

export const makeEnv = (cfg: ConfigInput = {}, wrapStore?: (s: Store) => Store): TestEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-pipe-'));
  const dbPath = join(dir, 'cs.db');
  const opened = openDatabase(dbPath);
  const base = createStore(opened, { contentKey: CONTENT_KEY });
  const store = wrapStore ? wrapStore(base) : base;
  const config = configSchema.parse({ dataDir: dir, dbPath, ...cfg });
  const events: LiveEvent[] = [];
  const pricing = createPricing();
  const pipeline = createPipeline({
    store,
    live: collectingHub(events),
    pricing,
    analyzer: createAnalyzer({}, pricing),
    fingerprinter: createFingerprinter(Buffer.alloc(32, 1)),
    config,
    logger: pino({ level: 'silent' }),
  });
  return { dir, dbPath, opened, store, pipeline, events };
};

let seq = 0;

/** CapturedExchange from a provider fixture (raw bodies, streamResult null). */
export const exchangeFromFixture = (
  f: ProviderFixture,
  over: Partial<CapturedExchange> = {},
): CapturedExchange => {
  const adapter = getAdapter(f.provider);
  const q = f.path.indexOf('?');
  const path = q >= 0 ? f.path.slice(0, q) : f.path;
  const query = new URLSearchParams(q >= 0 ? f.path.slice(q + 1) : '');
  const route: Route = {
    prefix: `/${f.provider}`,
    name: f.provider,
    protocol: f.provider,
    adapter,
    upstream: 'https://example.invalid',
    custom: false,
  };
  const text = f.response.sse ?? f.response.jsonArray ?? JSON.stringify(f.response.json ?? null);
  const isStream = f.response.sse !== undefined || f.response.jsonArray !== undefined;
  const req = Buffer.from(JSON.stringify(f.requestBody));
  const res = Buffer.from(text);
  return {
    id: `ex_${++seq}`,
    route,
    match: adapter.matchEndpoint('POST', path, query),
    method: 'POST',
    redactedPath: f.path,
    sessionId: null,
    projectId: 'default',
    traceId: null,
    startedAtMs: Date.UTC(2026, 9, 1, 12, 0, 0) + seq * 1000,
    connectMs: 5,
    ttfbMs: 50,
    ttftMs: isStream ? 60 : null,
    durationMs: 200,
    httpStatus: f.response.status,
    responseContentType: f.response.headers['content-type'] ?? null,
    responseHeaders: f.response.headers,
    requestBytes: req.length,
    responseBytes: res.length,
    requestBody: req,
    requestBodyTruncated: false,
    responseBody: res,
    responseTruncated: false,
    streamResult: null,
    isStream,
    state: 'completed',
    errorMessage: null,
    streamCompleted: isStream ? true : null,
    ...over,
  };
};
