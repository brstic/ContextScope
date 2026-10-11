import Fastify from 'fastify';
import { createServer, request } from 'node:http';
import type { RequestListener, IncomingHttpHeaders } from 'node:http';
import { configSchema } from '@contextscope/shared';
import type { ConfigInput } from '@contextscope/shared';
import type { CapturedExchange, Pipeline } from '../src/types.js';
import { buildRoutes } from '../src/proxy/routes.js';
import { registerProxy } from '../src/proxy/proxy.js';

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export async function setup(handler: RequestListener, overrides: ConfigInput = {}, throwing = false) {
  const upstream = createServer(handler);
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = configSchema.parse({
    upstreams: { openai: origin, anthropic: origin, gemini: origin },
    ...overrides,
  });
  const exchanges: CapturedExchange[] = [];
  const pipeline = {
    notifyStarted: () => {
      if (throwing) throw new Error('SECRET');
    },
    submit: (exchange: CapturedExchange) => {
      exchanges.push(exchange);
      if (throwing) throw new Error('SECRET');
    },
  } as unknown as Pipeline;
  const app = Fastify({ logger: false });
  registerProxy(app, { config, routes: buildRoutes(config), pipeline, logger: app.log });
  app.post('/api/echo', async (req) => ({ parsed: typeof req.body === 'object' }));
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    app,
    url,
    exchanges,
    upstream,
    config,
    async wait(count = 1) {
      for (let i = 0; i < 200 && exchanges.length < count; i++) await delay(10);
      if (exchanges.length < count) throw new Error('Missing captured exchange');
      return exchanges[count - 1]!;
    },
    async close() {
      await app.close();
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
    },
  };
}

export function call(
  url: string,
  path: string,
  body?: Buffer,
  headers: IncomingHttpHeaders = {},
  slow = false,
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request(
      url,
      {
        path,
        method: body ? 'POST' : 'GET',
        headers: {
          ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          if (slow) {
            res.pause();
            setTimeout(() => res.resume(), 2);
          }
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
