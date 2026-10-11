import { afterEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { fixtures } from '../../../packages/test-fixtures/src/fixtures.js';
import { setup, call } from './proxy-helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe('transparent proxy', () => {
  for (const fixture of fixtures.filter((f) => f.response.json)) {
    it(fixture.name, async () => {
      const expected = Buffer.from(JSON.stringify(fixture.response.json, null, 2));
      const input = Buffer.from(JSON.stringify(fixture.requestBody));
      let received = Buffer.alloc(0);
      let auth: string | undefined;
      const ctx = await setup((req, res) => {
        const chunks: Buffer[] = [];
        auth = req.headers.authorization;
        expect(req.headers['x-custom']).toBe('custom');
        expect(req.headers['x-contextscope-session']).toBeUndefined();
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          received = Buffer.concat(chunks);
          res.writeHead(fixture.response.status, {
            ...fixture.response.headers,
            'content-length': expected.length,
          });
          res.end(expected);
        });
      });
      cleanups.push(ctx.close);
      const result = await call(ctx.url, `/${fixture.provider}${fixture.path}`, input, {
        authorization: 'Bearer PRIVATE_CREDENTIAL',
        'x-custom': 'custom',
        'x-contextscope-session': 'session-1',
      });
      expect(result.body).toEqual(expected);
      expect(result.status).toBe(fixture.response.status);
      expect(received).toEqual(input);
      expect(auth).toBe('Bearer PRIVATE_CREDENTIAL');
      const exchange = await ctx.wait();
      expect(exchange.sessionId).toBe('session-1');
      expect(exchange.requestBody).toEqual(input);
      expect(exchange.state).toBe('completed');
      expect(JSON.stringify(exchange)).not.toContain('PRIVATE_CREDENTIAL');
    });
  }

  it('passes gzip bytes and keeps a decoded analysis copy', async () => {
    const plain = Buffer.from('{"usage":{"prompt_tokens":9,"completion_tokens":2}}');
    const zipped = gzipSync(plain);
    const ctx = await setup((req, res) => {
      expect(req.headers['accept-encoding']).toBe('gzip, br');
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': zipped.length,
      });
      res.end(zipped);
    });
    cleanups.push(ctx.close);
    const response = await call(ctx.url, '/openai/v1/chat/completions', Buffer.from('{}'), {
      'accept-encoding': 'gzip, br',
    });
    expect(response.body).toEqual(zipped);
    expect(response.headers['content-encoding']).toBe('gzip');
    const exchange = await ctx.wait();
    expect(exchange.responseBody).toEqual(plain);
    expect(
      exchange.route.adapter.parseResponse(JSON.parse(exchange.responseBody!.toString()), exchange.match!)
        .usage.outputTokens,
    ).toBe(2);
  });

  it('keeps /api JSON parsing and proxies unknown endpoints with metadata only', async () => {
    const ctx = await setup((_req, res) => {
      res.end('models');
    });
    cleanups.push(ctx.close);
    expect((await call(ctx.url, '/openai/v1/models')).body.toString()).toBe('models');
    const exchange = await ctx.wait();
    expect(exchange.match).toBeNull();
    expect(exchange.responseBody).toBeNull();
    expect((await call(ctx.url, '/api/echo', Buffer.from('{}'))).body.toString()).toBe('{"parsed":true}');
    expect((await call(ctx.url, '/outside')).status).toBe(404);
  });

  it('preserves query octets while redacting stored secrets', async () => {
    const target = '/v1beta/models/m:generateContent?alt=sse&key=SECRET&x=%2f+%20&x=2';
    const ctx = await setup((req, res) => {
      expect(req.url).toBe(target);
      res.end('{}');
    });
    cleanups.push(ctx.close);
    await call(ctx.url, `/gemini${target}`, Buffer.from('{}'));
    expect((await ctx.wait()).redactedPath).not.toContain('SECRET');
  });

  it.each([401, 429, 500])('forwards HTTP %i verbatim', async (status) => {
    const bytes = Buffer.from(' { "error": "native" }\n');
    const ctx = await setup((_req, res) => {
      res.writeHead(status, { 'x-upstream': 'yes' });
      res.end(bytes);
    });
    cleanups.push(ctx.close);
    const response = await call(ctx.url, '/openai/test');
    expect(response.status).toBe(status);
    expect(response.body).toEqual(bytes);
    expect(response.headers['x-upstream']).toBe('yes');
    expect((await ctx.wait()).state).toBe('completed');
  });

  it('isolates throwing notifications and submissions', async () => {
    const ctx = await setup((_req, res) => res.end('ok'), {}, true);
    cleanups.push(ctx.close);
    expect((await call(ctx.url, '/openai/test')).body.toString()).toBe('ok');
    expect((await ctx.wait()).state).toBe('completed');
    expect(ctx.exchanges).toHaveLength(1);
  });
});
