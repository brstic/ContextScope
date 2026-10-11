import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtures } from '@contextscope/test-fixtures';
import type { Store } from '../src/types.js';
import { exchangeFromFixture, makeEnv } from './pipeline-helpers.js';

const fixture = (name: string) => {
  const f = fixtures.find((x) => x.name.startsWith(name));
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};

const usageRow = (store: Store, id: string) =>
  store.sqlite.prepare('SELECT * FROM request_usage WHERE request_id = ?').get(id) as Record<string, unknown>;

const COLS: Record<string, string> = {
  totalInputTokens: 'total_input_tokens',
  uncachedInputTokens: 'uncached_input_tokens',
  cacheReadTokens: 'cache_read_tokens',
  cacheWriteTokens: 'cache_write_tokens',
  cacheWrite5mTokens: 'cache_write_5m_tokens',
  cacheWrite1hTokens: 'cache_write_1h_tokens',
  outputTokens: 'output_tokens',
  reasoningTokens: 'reasoning_tokens',
  source: 'source',
};

describe('pipeline: live exchanges', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('persists fixture usage: %s', async (_n, f) => {
    const env = makeEnv();
    const ex = exchangeFromFixture(f);
    env.pipeline.submit(ex);
    await env.pipeline.drain();
    expect(env.pipeline.stats()).toMatchObject({ processed: 1, failed: 0 });
    const row = usageRow(env.store, ex.id);
    for (const [k, col] of Object.entries(COLS)) {
      const want = (f.expected.usage as Record<string, unknown>)[k];
      if (want !== undefined) expect(row[col], `${f.name} ${k}`).toBe(want);
    }
    if (f.expected.usage.complete !== undefined) expect(row.complete).toBe(f.expected.usage.complete ? 1 : 0);
    const req = env.store.sqlite
      .prepare('SELECT model, segment_count FROM requests WHERE id = ?')
      .get(ex.id) as { model: string | null; segment_count: number };
    if (f.expected.segmentKinds) expect(req.segment_count).toBe(f.expected.segmentKinds.length);
    expect(env.events.some((e) => e.type === 'request.completed' && e.request.id === ex.id)).toBe(true);
  });

  it('keeps Anthropic cache totals (read + 5m/1h writes) and prices them', async () => {
    const env = makeEnv();
    const ex = exchangeFromFixture(fixture('anthropic json'));
    env.pipeline.submit(ex);
    await env.pipeline.drain();
    const u = usageRow(env.store, ex.id);
    const e = fixture('anthropic json').expected.usage;
    expect(u.cache_read_tokens).toBe(e.cacheReadTokens);
    expect(u.cache_write_5m_tokens).toBe(e.cacheWrite5mTokens);
    expect(u.cache_write_1h_tokens).toBe(e.cacheWrite1hTokens);
    expect(u.total_input_tokens).toBe(e.totalInputTokens);
    const c = env.store.sqlite
      .prepare('SELECT total_nano FROM request_costs WHERE request_id = ?')
      .get(ex.id) as { total_nano: number | null };
    expect(c.total_nano).toBeGreaterThan(0);
  });

  it('never persists a secret (error message + path query), checked in db and WAL bytes', async () => {
    const SECRET = 'sk-ant-SECRETabcdefghijklmnop0123456789';
    const f = fixture('openai 401');
    const body = Buffer.from(
      JSON.stringify({
        error: {
          message: `Incorrect API key provided: ${SECRET}`,
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      }),
    );
    const env = makeEnv();
    const ex = exchangeFromFixture(f, {
      responseBody: body,
      redactedPath: `/v1/responses?foo=1&key=${SECRET}`,
    });
    env.pipeline.submit(ex);
    await env.pipeline.drain();
    const r = env.store.sqlite
      .prepare('SELECT endpoint, error_message, http_status FROM requests WHERE id = ?')
      .get(ex.id) as Record<string, unknown>;
    expect(r.http_status).toBe(401);
    expect(String(r.error_message)).toContain('Incorrect API key provided');
    for (const p of [env.dbPath, `${env.dbPath}-wal`]) {
      if (existsSync(p)) expect(readFileSync(p).includes(Buffer.from('SECRETabcdef'))).toBe(false);
    }
  });

  it('drops and counts on queue overflow without throwing', async () => {
    const env = makeEnv({ limits: { queueCapacity: 2 } });
    const f = fixture('openai chat json');
    expect(() => {
      for (let i = 0; i < 5; i++) env.pipeline.submit(exchangeFromFixture(f));
    }).not.toThrow();
    expect(env.pipeline.stats()).toMatchObject({ dropped: 3, queueDepth: 2, capacity: 2 });
    expect(env.events.filter((e) => e.type === 'stats')).toHaveLength(1);
    await env.pipeline.drain();
    expect(env.pipeline.stats().processed).toBe(2);
  });

  it('survives a store that throws', async () => {
    const env = makeEnv({}, (s) => ({
      ...s,
      insertRecord: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
    }));
    env.pipeline.submit(exchangeFromFixture(fixture('openai chat json')));
    await env.pipeline.drain();
    expect(env.pipeline.stats()).toMatchObject({ processed: 0, failed: 1 });
  });

  it('prefix: changed tool → firstChangedSegment = tool index', async () => {
    const env = makeEnv();
    const f = fixture('anthropic json');
    const a = exchangeFromFixture(f, { sessionId: 'sess' });
    const body2 = structuredClone(f.requestBody) as { tools: { description: string }[] };
    (body2.tools[0] as { description: string }).description = 'Changed description.';
    const b = exchangeFromFixture(f, { sessionId: 'sess', requestBody: Buffer.from(JSON.stringify(body2)) });
    env.pipeline.submit(a);
    env.pipeline.submit(b);
    await env.pipeline.drain();
    const row = env.store.sqlite
      .prepare(
        'SELECT first_changed_segment, shared_prefix_segments, previous_request_id FROM requests WHERE id = ?',
      )
      .get(b.id);
    expect(row).toEqual({ first_changed_segment: 0, shared_prefix_segments: 0, previous_request_id: a.id });
  });

  it('deep_memory keeps content only in memory; metadata keeps none', async () => {
    const f = fixture('openai chat json');
    const mem = makeEnv({ capture: { mode: 'deep_memory' } });
    const ex = exchangeFromFixture(f);
    mem.pipeline.submit(ex);
    await mem.pipeline.drain();
    expect(mem.pipeline.memoryContent(ex.id)?.payload).toMatchObject({ request: f.requestBody });
    expect(mem.store.sqlite.prepare('SELECT COUNT(*) n FROM captured_content').get()).toEqual({ n: 0 });

    const meta = makeEnv();
    const ex2 = exchangeFromFixture(f);
    meta.pipeline.submit(ex2);
    await meta.pipeline.drain();
    expect(meta.pipeline.memoryContent(ex2.id)).toBeNull();
    expect(meta.store.sqlite.prepare('SELECT COUNT(*) n FROM captured_content').get()).toEqual({ n: 0 });

    const per = makeEnv({ capture: { mode: 'deep_persistent' } });
    const ex3 = exchangeFromFixture(f);
    per.pipeline.submit(ex3);
    await per.pipeline.drain();
    expect(per.store.getContent(ex3.id)?.payload).toMatchObject({ request: f.requestBody });
  });
});

describe('pipeline: import', () => {
  const base = (id: string, i: number) => ({
    id,
    provider: 'openai',
    endpoint: '/v1/chat/completions',
    startedAt: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
    request: fixture('openai chat json').requestBody,
    response: fixture('openai chat json').response.json,
  });

  it('reports invalid entries by index, imports the rest, skips duplicate ids', () => {
    const env = makeEnv();
    const r = env.pipeline.importTraces([base('a', 1), '{broken json', { provider: 'nope' }, base('b', 2)], {
      demo: false,
      origin: 'import',
    });
    expect(r.imported).toBe(2);
    expect(r.errors.map((e) => e.index)).toEqual([1, 2]);
    const again = env.pipeline.importTraces([base('a', 1)], { demo: false, origin: 'import' });
    expect(again).toEqual({ imported: 0, skipped: 1, errors: [] });
    const u = usageRow(env.store, 'imp_a');
    expect(u.total_input_tokens).toBe(fixture('openai chat json').expected.usage.totalInputTokens);
  });

  it('a duplicated segment produces a duplicate_segment finding', () => {
    const env = makeEnv();
    const doc = {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'Retry policy. '.repeat(800) },
      title: 'Policy',
    };
    const trace = {
      id: 'dup',
      provider: 'anthropic',
      endpoint: '/v1/messages',
      startedAt: '2026-10-01T12:00:00Z',
      request: {
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: [doc, doc, { type: 'text', text: 'Summarize.' }] }],
      },
    };
    const r = env.pipeline.importTraces([trace], { demo: false, origin: 'import' });
    expect(r).toEqual({ imported: 1, skipped: 0, errors: [] });
    const types = (
      env.store.sqlite.prepare('SELECT type FROM optimization_findings').all() as { type: string }[]
    ).map((x) => x.type);
    expect(types).toContain('duplicate_segment');
  });
});
