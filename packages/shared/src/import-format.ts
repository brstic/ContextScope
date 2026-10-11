import { z } from 'zod';
import { PROVIDERS } from './domain.js';

/**
 * ContextScope offline trace format, version 1.
 *
 * A file is a JSON object `{ "format": "contextscope.trace", "version": 1, "traces": [...] }`
 * (or JSONL: one trace object per line). Each trace carries the provider-native request
 * body and either the provider-native response body (JSON) or the raw SSE text, so the
 * exact same adapters used by the proxy analyse it. Nothing is sent anywhere.
 */
export const TRACE_FORMAT = 'contextscope.trace';
export const TRACE_FORMAT_VERSION = 1;

const nonNegInt = z.number().int().nonnegative();

export const importedTraceSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    provider: z.enum(PROVIDERS),
    /** Path after the provider prefix, e.g. "/v1/chat/completions" or "/v1beta/models/gemini-2.5-flash:generateContent". */
    endpoint: z.string().min(1).max(512).startsWith('/'),
    method: z.string().default('POST'),
    startedAt: z.iso.datetime({ offset: true }),
    durationMs: nonNegInt.nullable().optional(),
    ttfbMs: nonNegInt.nullable().optional(),
    ttftMs: nonNegInt.nullable().optional(),
    httpStatus: z.number().int().min(100).max(599).nullable().optional(),
    sessionId: z.string().max(256).nullable().optional(),
    traceId: z.string().max(256).nullable().optional(),
    projectId: z.string().max(128).optional(),
    request: z.unknown(),
    /** Provider-native JSON response body. */
    response: z.unknown().optional(),
    /** Raw SSE text for streamed responses (alternative to `response`). */
    responseSse: z.string().max(50_000_000).optional(),
    state: z.enum(['completed', 'client_aborted', 'upstream_error']).optional(),
  })
  .strict();

export type ImportedTrace = z.infer<typeof importedTraceSchema>;

export const traceFileSchema = z
  .object({
    format: z.literal(TRACE_FORMAT),
    version: z.literal(TRACE_FORMAT_VERSION),
    exportedAt: z.string().optional(),
    traces: z.array(importedTraceSchema).max(100_000),
  })
  .strict();

export type TraceFile = z.infer<typeof traceFileSchema>;

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: { index: number; message: string }[];
}
