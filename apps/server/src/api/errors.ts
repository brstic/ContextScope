import { randomBytes } from 'node:crypto';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { ApiError } from '@contextscope/shared';
import { redactText } from '@contextscope/core';

/** An error with a safe, client-facing code + message. Thrown by route handlers. */
export class ApiHttpError extends Error {
  override name = 'ApiHttpError';
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const notFound = (what: string): ApiHttpError =>
  new ApiHttpError(404, 'not_found', `${what} not found`);

export const errorBody = (code: string, message: string, ref?: string): ApiError => ({
  error: ref === undefined ? { code, message } : { code, message, ref },
});

/** Validate input with zod; failures become 400 invalid_request with a readable message. */
export const parseInput = <T>(schema: ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  const msg = r.error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  throw new ApiHttpError(400, 'invalid_request', msg || 'Invalid request');
};

const newRef = (): string => randomBytes(6).toString('hex');

/** Maps Fastify's own client errors (bad JSON, body too large…) to stable codes. */
const fastifyCode = (err: FastifyError, status: number): string => {
  switch (err.code) {
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return 'invalid_json';
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return 'payload_too_large';
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return 'unsupported_media_type';
    case 'FST_ERR_VALIDATION':
      return 'invalid_request';
    default:
      return status === 404 ? 'not_found' : status === 413 ? 'payload_too_large' : 'bad_request';
  }
};

/**
 * Error handler for /api: always `{ error: { code, message, ref } }`, never a stack trace.
 * 4xx keep their (safe) message; 5xx get a generic message and a ref id that is logged.
 */
export const apiErrorHandler = (error: unknown, request: FastifyRequest, reply: FastifyReply): void => {
  const ref = newRef();
  if (error instanceof ApiHttpError) {
    void reply
      .code(error.statusCode)
      .type('application/json')
      .send(errorBody(error.code, error.message, ref));
    return;
  }
  const fe = error as Partial<FastifyError> | null;
  const status = typeof fe?.statusCode === 'number' ? fe.statusCode : 500;
  if (status >= 400 && status < 500) {
    const message = typeof fe?.message === 'string' && fe.message ? fe.message.slice(0, 300) : 'Bad request';
    void reply
      .code(status)
      .type('application/json')
      .send(errorBody(fastifyCode(fe as FastifyError, status), redactText(message), ref));
    return;
  }
  request.log.error({ ref }, 'api request failed');
  void reply
    .code(500)
    .type('application/json')
    .send(errorBody('internal_error', 'Internal server error', ref));
};
