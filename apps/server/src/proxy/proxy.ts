import { randomUUID } from 'node:crypto';
import { pipeline as pump } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';
import { Agent, request as upstreamRequest } from 'undici';
import type { Dispatcher } from 'undici';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ContextScopeConfig } from '@contextscope/shared';
import { redactHeaders, redactUrl } from '@contextscope/core';
import type { Logger } from 'pino';
import type { CapturedExchange, Pipeline, Route } from '../types.js';
import { resolveRoute } from './routes.js';
import { ResponseObserver } from './observer.js';

export interface ProxyDeps {
  routes: Route[];
  pipeline: Pipeline;
  config: ContextScopeConfig;
  logger: Logger;
}

const hop = new Set(['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
/** Also strip headers nominated by Connection, including nonstandard extensions. */
export function forwardHeaders(headers: IncomingHttpHeaders, requestSide = true): IncomingHttpHeaders {
  const nominated = new Set(
    String(headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim()),
  );
  const out: IncomingHttpHeaders = Object.create(null) as IncomingHttpHeaders;
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (hop.has(key) || nominated.has(key) || key.startsWith('proxy-')) continue;
    if (
      requestSide &&
      ['x-contextscope-session', 'x-contextscope-project', 'x-contextscope-trace'].includes(key)
    )
      continue;
    out[key] = value;
  }
  return out;
}

const integration = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\x20-\x7e]+$/.test(value)
    ? value
    : null;

/** Register BEFORE ready/listen. Encapsulated parser changes cannot affect /api. */
export function registerProxy(app: FastifyInstance, deps: ProxyDeps): void {
  const { config, routes, pipeline, logger } = deps;
  const { limits } = config;
  const agent = new Agent({
    connect: { timeout: limits.connectTimeoutMs },
    headersTimeout: limits.idleTimeoutMs,
    bodyTimeout: limits.idleTimeoutMs,
  });
  const warn = (): void => {
    try {
      logger.warn('Proxy observation failed; transport unaffected');
    } catch {
      /* logging is optional */
    }
  };
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      warn();
    }
  };
  // Runs before Fastify's handler/parser; raw absolute-form targets must never influence routing.
  app.addHook('onRequest', async (req, reply) => {
    const target = req.raw.url ?? '';
    try {
      resolveRoute(routes, target);
    } catch {
      await reply
        .code(400)
        .send({ error: { type: 'contextscope_invalid_path', message: 'Invalid proxy request target' } });
    }
  });
  app.addHook('onClose', async () => {
    await agent.destroy();
  });
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    const handle = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const resolved = resolveRoute(routes, req.raw.url ?? '');
      if (!resolved) {
        await reply.code(404).send();
        return;
      }
      const { route, restPath, query } = resolved;
      const start = performance.now();
      const elapsed = (): number => performance.now() - start;
      const exchange: CapturedExchange = {
        id: randomUUID(),
        route,
        match: null,
        method: req.method,
        redactedPath: redactUrl(restPath + query),
        sessionId: integration(req.headers['x-contextscope-session']),
        projectId: integration(req.headers['x-contextscope-project']) ?? 'default',
        traceId: integration(req.headers['x-contextscope-trace']),
        startedAtMs: Date.now(),
        connectMs: null,
        ttfbMs: null,
        ttftMs: null,
        durationMs: null,
        httpStatus: null,
        responseContentType: null,
        responseHeaders: {},
        requestBytes: 0,
        responseBytes: 0,
        requestBody: null,
        requestBodyTruncated: false,
        responseBody: null,
        responseTruncated: false,
        streamResult: null,
        isStream: false,
        state: 'completed',
        errorMessage: null,
        streamCompleted: null,
      };
      safe(() => {
        exchange.match = route.adapter.matchEndpoint(req.method, restPath, new URLSearchParams(query));
      });
      safe(() =>
        pipeline.notifyStarted({
          id: exchange.id,
          provider: route.protocol,
          model: null,
          at: exchange.startedAtMs,
        }),
      );
      const controller = new AbortController();
      let observer: ResponseObserver | null = null;
      let requestChunks: Buffer[] = [];
      let ended = false;
      let tooLarge = false;
      let responseStarted = false;
      const abort = (): void => {
        if (ended || reply.raw.writableFinished || exchange.state !== 'completed') return;
        exchange.state = 'client_aborted';
        controller.abort();
      };
      req.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      reply.hijack();
      const sendError = (status: number, message: string): void => {
        exchange.httpStatus = status;
        exchange.errorMessage = message;
        if (reply.raw.destroyed) return;
        reply.raw.writeHead(status, { 'content-type': 'application/json', 'x-contextscope-error': '1' });
        reply.raw.end(JSON.stringify({ error: { type: 'contextscope_upstream_error', message } }));
      };
      // Async iteration is a backpressured tee: no request pre-buffering and no flowing-mode race.
      const body = async function* (): AsyncGenerator<Buffer> {
        for await (const chunk of req.raw) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          exchange.requestBytes += bytes.length;
          if (exchange.requestBytes > limits.maxRequestBytes) {
            tooLarge = true;
            exchange.state = 'rejected';
            sendError(413, 'Request body exceeds configured limit');
            controller.abort();
            return;
          }
          if (exchange.match && !exchange.requestBodyTruncated) {
            if (exchange.requestBytes > limits.maxInspectBytes) {
              requestChunks = [];
              exchange.requestBodyTruncated = true;
            } else requestChunks.push(Buffer.from(bytes));
          }
          yield bytes;
        }
      };
      try {
        if (Number(req.headers['content-length']) > limits.maxRequestBytes) {
          tooLarge = true;
          exchange.state = 'rejected';
          exchange.requestBodyTruncated = true;
          sendError(413, 'Request body exceeds configured limit');
          req.raw.resume();
          return;
        }
        const headers = forwardHeaders(req.headers);
        headers.host = new URL(route.upstream).host;
        const hasBody =
          req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
        const response = await upstreamRequest(route.upstream + restPath + query, {
          dispatcher: agent,
          method: req.method as Dispatcher.HttpMethod,
          headers,
          // Readable.from keeps the generator's pull-based backpressure.
          body: hasBody ? Readable.from(body(), { objectMode: false }) : undefined,
          signal: controller.signal,
          headersTimeout: limits.idleTimeoutMs,
          bodyTimeout: limits.idleTimeoutMs,
        });
        exchange.ttfbMs = elapsed();
        exchange.httpStatus = response.statusCode;
        exchange.responseHeaders = redactHeaders(response.headers);
        exchange.responseContentType =
          typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null;
        observer = new ResponseObserver(
          exchange,
          limits.maxResponseInspectBytes,
          String(response.headers['content-encoding'] ?? ''),
          elapsed,
          warn,
        );
        reply.raw.writeHead(response.statusCode, forwardHeaders(response.headers, false));
        reply.raw.flushHeaders();
        responseStarted = true;
        const tee = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            exchange.responseBytes += chunk.length;
            observer?.push(chunk);
            done(null, chunk);
          },
        });
        // Mark upstream failures before pipeline destroys the downstream (whose close is not a client abort).
        response.body.once('error', () => {
          if (exchange.state === 'completed') exchange.state = 'upstream_error';
        });
        await pump(response.body, tee, reply.raw);
      } catch (error) {
        if (exchange.state !== 'client_aborted' && !tooLarge) {
          exchange.state = 'upstream_error';
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          const timeout = code.includes('TIMEOUT');
          const message = timeout ? 'Upstream request timed out' : 'Upstream connection failed';
          exchange.errorMessage = message; // Never expose upstream errors containing targets or credentials.
          if (!responseStarted && !reply.raw.headersSent) sendError(timeout ? 504 : 502, message);
          else reply.raw.destroy();
        }
      } finally {
        ended = true;
        exchange.durationMs = elapsed();
        req.raw.off('aborted', abort);
        reply.raw.off('close', abort);
        if (
          exchange.match &&
          !exchange.requestBodyTruncated &&
          exchange.requestBytes <= limits.maxInspectBytes
        ) {
          exchange.requestBody = Buffer.concat(requestChunks);
        }
        requestChunks = [];
        // Decoding completion is off the response path: client has already finished/closed.
        try {
          await observer?.finish(exchange.state === 'completed');
        } catch {
          warn();
        }
        safe(() => pipeline.submit(exchange));
      }
    };
    for (const route of routes) {
      scope.all(route.prefix, handle);
      scope.all(`${route.prefix}/*`, handle);
    }
  });
}
