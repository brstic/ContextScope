import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { apiErrorHandler, errorBody } from './errors.js';
import type { ContextScopeConfig } from '@contextscope/shared';

export interface SecurityOptions {
  /** Where to report a restart-worthy security misconfiguration (e.g. no token on a public host). */
  onInsecure?: (message: string) => void;
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'";

/** compare without early exit on length mismatch */
const safeEqual = (a: string, b: string): boolean => {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
};

const authOk = (presented: string | undefined, token: string): boolean =>
  typeof presented === 'string' && safeEqual(presented, token);

export const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.');

/** Same-origin check for the CSRF layer: Origin host:port must match the Host header. */
export const sameOrigin = (origin: string, request: { headers: Record<string, unknown> }): boolean => {
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
  try {
    const o = new URL(origin);
    if (
      !['http:', 'https:'].includes(o.protocol) ||
      o.username ||
      o.password ||
      o.pathname !== '/' ||
      o.search ||
      o.hash
    )
      return false;
    const expected = new URL(`${o.protocol}//${hostHeader}`);
    return expected.origin === o.origin;
  } catch {
    return false;
  }
};

/**
 * Security headers on dashboard + API responses (onSend, so error replies get them too).
 * The CSP is added to HTML responses (dashboard) only.
 */
export const applySecurityHeaders = (
  _request: FastifyRequest,
  reply: FastifyReply,
  contentType: string,
): void => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
  if (contentType.startsWith('text/html')) reply.header('content-security-policy', CSP);
};

/**
 * Auth + CSRF + security headers for the dashboard server.
 *
 * - When `config.authToken` is set, every /api/* request needs `authorization: Bearer <token>`
 *   (or `?token=` for /api/events only, because EventSource cannot send headers).
 * - Non-GET /api/* need `x-contextscope-csrf: 1`; an Origin header, when present, must match Host.
 * - No CORS: no Access-Control-* headers are ever emitted.
 * - X-Content-Type-Options / Referrer-Policy / X-Frame-Options on every response,
 *   plus a CSP on HTML (dashboard) responses.
 *
 * Register BEFORE the API routes (hooks apply only to routes registered after them).
 */
export const registerSecurity = (
  app: FastifyInstance,
  opts: { config: ContextScopeConfig } & SecurityOptions,
): void => {
  const { config } = opts;
  const token = config.authToken ?? null;

  if (token === null && !isLoopback(config.host)) {
    opts.onInsecure?.('API/Dashboard bound to a non-loopback host without an auth token: refusing to start');
    throw new Error('authToken is required when host is not loopback');
  }

  app.addHook('onRequest', async (request, reply) => {
    const url = request.raw.url ?? '/';
    if (!url.startsWith('/api/')) return;

    if (token !== null) {
      const header = request.headers.authorization;
      let presented: string | undefined;
      if (typeof header === 'string' && header.startsWith('Bearer ') && header.length > 7) {
        presented = header.slice(7);
      } else if (url.split('?')[0] === '/api/events') {
        const qp = request.query as Record<string, unknown> | undefined;
        const t = qp?.['token'];
        presented = typeof t === 'string' && t.length > 0 ? t : undefined;
      }
      if (!authOk(presented, token)) {
        reply.header('www-authenticate', 'Bearer realm="contextscope"');
        return reply.code(401).type('application/json').send(errorBody('unauthorized', 'Unauthorized'));
      }
    }

    if (request.method !== 'GET') {
      const csrf = request.headers['x-contextscope-csrf'];
      if (csrf !== '1') {
        return reply
          .code(403)
          .type('application/json')
          .send(errorBody('csrf_required', 'Missing CSRF header'));
      }
      const origin = request.headers.origin;
      if (typeof origin === 'string' && !sameOrigin(origin, request)) {
        return reply
          .code(403)
          .type('application/json')
          .send(errorBody('csrf_origin', 'Cross-origin request rejected'));
      }
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    applySecurityHeaders(request, reply, String(reply.getHeader('content-type') ?? ''));
    return payload;
  });

  app.setErrorHandler(apiErrorHandler);
};
