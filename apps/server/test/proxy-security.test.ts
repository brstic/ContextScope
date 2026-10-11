import { afterEach, expect, it } from 'vitest';
import { request } from 'node:http';
import { configSchema } from '@contextscope/shared';
import { buildRoutes, resolveRoute } from '../src/proxy/routes.js';
import { forwardHeaders } from '../src/proxy/proxy.js';
import { setup, call } from './proxy-helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

it.each([
  '/openai/../admin',
  '/openai/%2e%2e/x',
  '/openai/%252e%252e/x',
  '/openai//evil',
  '/openai/\\evil',
  '/openai/%2f%2fevil',
])('rejects traversal %s without upstream traffic', async (path) => {
  let hits = 0;
  const ctx = await setup((_req, res) => {
    hits++;
    res.end('bad');
  });
  cleanups.push(ctx.close);
  expect((await call(ctx.url, path)).status).toBe(400);
  expect(hits).toBe(0);
});

it('rejects absolute form; Host and forwarding headers cannot select upstream', async () => {
  const ctx = await setup((req, res) => {
    expect(req.headers.host).not.toBe('attacker.test');
    res.end('trusted');
  });
  cleanups.push(ctx.close);
  expect((await call(ctx.url, 'http://attacker.test/openai/x')).status).toBe(400);
  expect(
    (
      await call(ctx.url, '/openai/x', undefined, {
        host: 'attacker.test',
        'x-forwarded-host': 'attacker.test',
      })
    ).body.toString(),
  ).toBe('trusted');
});

it('filters connection-nominated headers and integration headers, but not authorization', () => {
  expect(
    forwardHeaders({
      connection: 'x-remove',
      'x-remove': 'no',
      host: 'evil',
      authorization: 'keep',
      'proxy-authenticate': 'no',
      'x-contextscope-trace': 'no',
      'accept-encoding': 'gzip',
    }),
  ).toEqual({ authorization: 'keep', 'accept-encoding': 'gzip' });
});

it('builds custom routes with an OpenAI adapter and preserves query bytes', () => {
  const routes = buildRoutes(
    configSchema.parse({
      customProviders: [
        { name: 'local', protocol: 'openai', upstream: 'http://localhost:1234', trusted: true },
      ],
    }),
  );
  const found = resolveRoute(routes, '/local/v1/chat/completions?x=%2f+x');
  expect(found?.route.protocol).toBe('openai');
  expect(found?.route.custom).toBe(true);
  expect(found?.restPath).toBe('/v1/chat/completions');
  expect(found?.query).toBe('?x=%2f+x');
  expect(resolveRoute(routes, '/openai-evil/x')).toBeNull();
});

it('rejects declared oversized requests with 413', async () => {
  const ctx = await setup((_req, res) => res.end('ok'), { limits: { maxRequestBytes: 8 } });
  cleanups.push(ctx.close);
  expect((await call(ctx.url, '/openai/v1/chat/completions', Buffer.alloc(32))).status).toBe(413);
  expect((await ctx.wait()).state).toBe('rejected');
});

it('counts chunked upload bytes and returns 413 while streaming', async () => {
  const ctx = await setup(
    (req, res) => {
      req.resume();
      req.on('end', () => res.end('ok'));
    },
    { limits: { maxRequestBytes: 8 } },
  );
  cleanups.push(ctx.close);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      ctx.url + '/openai/v1/chat/completions',
      { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on('error', reject);
    req.write('1234');
    req.end('567890123');
  });
  expect(status).toBe(413);
  const exchange = await ctx.wait();
  expect(exchange.state).toBe('rejected');
  expect(exchange.requestBytes).toBeGreaterThan(8);
});

it('connect failure returns a redacted 502 envelope', async () => {
  const ctx = await setup((_req, res) => res.end(), { upstreams: { openai: 'http://127.0.0.1:1' } });
  cleanups.push(ctx.close);
  const response = await call(ctx.url, '/openai/x?key=SECRET');
  expect(response.status).toBe(502);
  expect(response.headers['x-contextscope-error']).toBe('1');
  expect(JSON.parse(response.body.toString()).error.type).toBe('contextscope_upstream_error');
  expect(response.body.toString()).not.toContain('SECRET');
  expect((await ctx.wait()).state).toBe('upstream_error');
});

it('timeout before headers returns 504', async () => {
  const ctx = await setup(() => {}, { limits: { idleTimeoutMs: 30 } });
  cleanups.push(ctx.close);
  expect((await call(ctx.url, '/openai/x')).status).toBe(504);
  expect((await ctx.wait()).state).toBe('upstream_error');
});

it('bounded request and response inspection never truncates forwarding', async () => {
  const bytes = Buffer.from('{"large":"' + 'x'.repeat(200) + '"}');
  const ctx = await setup(
    (req, res) => {
      req.pipe(res);
    },
    { limits: { maxInspectBytes: 8, maxResponseInspectBytes: 8 } },
  );
  cleanups.push(ctx.close);
  expect((await call(ctx.url, '/openai/v1/chat/completions', bytes)).body).toEqual(bytes);
  const exchange = await ctx.wait();
  expect(exchange.requestBody).toBeNull();
  expect(exchange.requestBodyTruncated).toBe(true);
  expect(exchange.responseTruncated).toBe(true);
});
