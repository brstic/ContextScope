import { afterEach, expect, it } from 'vitest';
import { request } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fixtures } from '../../../packages/test-fixtures/src/fixtures.js';
import { setup, call, delay } from './proxy-helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

for (const fixture of fixtures.filter((f) => f.response.sse || f.response.jsonArray)) {
  it(`split streaming: ${fixture.name}`, async () => {
    const bytes = Buffer.from(fixture.response.sse ?? fixture.response.jsonArray!);
    const ctx = await setup(async (_req, res) => {
      res.writeHead(200, fixture.response.headers);
      for (let i = 0; i < bytes.length; i += 19) {
        res.write(bytes.subarray(i, i + 19));
        await delay(1);
      }
      res.end();
    });
    cleanups.push(ctx.close);
    const result = await call(
      ctx.url,
      `/${fixture.provider}${fixture.path}`,
      Buffer.from(JSON.stringify(fixture.requestBody)),
    );
    expect(result.body).toEqual(bytes);
    const exchange = await ctx.wait();
    expect(exchange.isStream).toBe(true);
    expect(exchange.streamResult?.usage).toMatchObject(fixture.expected.usage);
    if (exchange.ttftMs !== null) expect(exchange.ttftMs).toBeLessThan(exchange.durationMs!);
  });
}

it('heartbeats do not start TTFT; concurrent streams remain intact', async () => {
  const ping = ': ping\n\n';
  const data = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
  const ctx = await setup(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(ping);
    await delay(60);
    res.write(data);
    await delay(30);
    res.end();
  });
  cleanups.push(ctx.close);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => call(ctx.url, '/openai/v1/chat/completions', Buffer.from('{}'))),
  );
  for (const result of results) expect(result.body.toString()).toBe(ping + data);
  await ctx.wait(20);
  for (const exchange of ctx.exchanges) {
    expect(exchange.ttftMs).toBeGreaterThanOrEqual(50);
    expect(exchange.ttftMs).toBeLessThan(exchange.durationMs!);
  }
});

it('client cancellation closes upstream and does not poison subsequent requests', async () => {
  let closed = false;
  const ctx = await setup((req, res) => {
    if (req.url === '/next') {
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ping\n\n');
    const timer = setInterval(() => res.write(': ping\n\n'), 10);
    res.once('close', () => {
      clearInterval(timer);
      closed = true;
    });
  });
  cleanups.push(ctx.close);
  await new Promise<void>((resolve, reject) => {
    const req = request(ctx.url + '/openai/stream', (res) => {
      res.once('data', () => {
        res.destroy();
        resolve();
      });
    });
    req.on('error', reject);
    req.end();
  });
  expect((await ctx.wait()).state).toBe('client_aborted');
  for (let i = 0; i < 50 && !closed; i++) await delay(10);
  expect(closed).toBe(true);
  expect((await call(ctx.url, '/openai/next')).body.toString()).toBe('ok');
  await ctx.wait(2);
  expect(ctx.exchanges).toHaveLength(2);
});

it('upstream death after headers destroys downstream and is not a client abort', async () => {
  const ctx = await setup(async (_req, res) => {
    res.writeHead(200, { 'content-length': '10000' });
    res.write('partial');
    await delay(20);
    res.destroy();
  });
  cleanups.push(ctx.close);
  await expect(call(ctx.url, '/openai/test')).rejects.toThrow();
  expect((await ctx.wait()).state).toBe('upstream_error');
});

it('backpressures 20 MiB to a slow reader with bounded RSS', async () => {
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const count = 320;
  const expectedHash = createHash('sha256');
  for (let i = 0; i < count; i++) expectedHash.update(chunk);
  const ctx = await setup(
    async (_req, res) => {
      res.writeHead(200, { 'content-length': chunk.length * count });
      for (let i = 0; i < count; i++) if (!res.write(chunk)) await once(res, 'drain');
      res.end();
    },
    { limits: { maxResponseInspectBytes: 1024 } },
  );
  cleanups.push(ctx.close);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  const result = await new Promise<{ bytes: number; hash: string }>((resolve, reject) => {
    const req = request(ctx.url + '/openai/big', (res) => {
      let bytes = 0;
      const hash = createHash('sha256');
      res.on('data', (buffer: Buffer) => {
        bytes += buffer.length;
        hash.update(buffer);
        res.pause();
        setTimeout(() => res.resume(), 2);
      });
      res.on('end', () => resolve({ bytes, hash: hash.digest('hex') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  clearInterval(sampler);
  expect(result.bytes).toBe(20 * 1024 * 1024);
  expect(result.hash).toBe(expectedHash.digest('hex'));
  expect(peak - baseline).toBeLessThan(64 * 1024 * 1024);
});
