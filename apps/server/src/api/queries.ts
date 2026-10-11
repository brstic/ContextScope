import { z } from 'zod';
import type { Store } from '../types.js';
import type { ModelBreakdown, SessionSummary, TimeBucket } from '@contextscope/shared';
import { parseInput } from './errors.js';
import { json, type Row } from './mappers.js';

export const querySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    provider: z.string().max(128).optional(),
    model: z.string().max(512).optional(),
    state: z.enum(['pending', 'completed', 'client_aborted', 'upstream_error', 'rejected']).optional(),
    session: z.string().max(256).optional(),
    q: z.string().max(512).optional(),
    sort: z.enum(['startedAt', 'cost', 'duration', 'inputTokens']).default('startedAt'),
    dir: z.enum(['asc', 'desc']).default('desc'),
    bucket: z.enum(['hour', 'day']).optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), {
    message: 'from must not be after to',
  });
export type Query = z.infer<typeof querySchema>;
export const query = (input: unknown): Query => parseInput(querySchema, input);
export type Params = (string | number | null)[];
export interface Where {
  sql: string;
  params: Params;
}
export const where = (q: Query): Where => {
  const parts: string[] = [];
  const params: Params = [];
  const add = (sql: string, v: string | number): void => {
    parts.push(sql);
    params.push(v);
  };
  if (q.from) add('r.started_ms >= ?', Date.parse(q.from));
  if (q.to) add('r.started_ms <= ?', Date.parse(q.to));
  if (q.provider) add('r.provider = ?', q.provider);
  if (q.model) add('r.model = ?', q.model);
  if (q.state) add('r.state = ?', q.state);
  if (q.session) add('r.session_id = ?', q.session);
  if (q.q) {
    const search = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
    parts.push(
      `(${['r.id', 'r.model', 'r.session_id', 'r.endpoint', 'r.provider_request_id'].map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    );
    params.push(...Array<string>(5).fill(search));
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
};
export const JOIN = `FROM requests r LEFT JOIN request_usage u ON u.request_id=r.id LEFT JOIN request_costs c ON c.request_id=r.id`;
export const SELECT = `r.*, u.*, c.*, c.request_id AS cost_request_id,
 (SELECT count(*) FROM optimization_findings f WHERE EXISTS (SELECT 1 FROM json_each(f.request_ids_json) WHERE value=r.id)) AS finding_count`;
export const HIT = `CAST(SUM(CASE WHEN u.cache_read_tokens IS NOT NULL AND u.total_input_tokens IS NOT NULL THEN u.cache_read_tokens END) AS REAL) /
 NULLIF(SUM(CASE WHEN u.cache_read_tokens IS NOT NULL AND u.total_input_tokens IS NOT NULL THEN u.total_input_tokens END),0)`;
const sum = (c: string, alias: string): string => `COALESCE(SUM(${c}),0) AS ${alias}`;
export const TOTALS = [
  'count(*) AS requests',
  `COALESCE(SUM(CASE WHEN r.http_status >= 400 OR r.state IN ('upstream_error','client_aborted','rejected') THEN 1 ELSE 0 END),0) AS errors`,
  sum('u.total_input_tokens', 'inputTokens'),
  sum('u.output_tokens', 'outputTokens'),
  sum('u.cache_read_tokens', 'cacheReadTokens'),
  sum('u.cache_write_tokens', 'cacheWriteTokens'),
  sum('u.uncached_input_tokens', 'uncachedInputTokens'),
  sum('c.total_nano', 'totalNanoUsd'),
  sum('c.uncached_input_nano', 'uncachedInputNanoUsd'),
  sum('c.cache_read_nano', 'cacheReadNanoUsd'),
  sum('c.cache_write_nano', 'cacheWriteNanoUsd'),
  sum('c.output_nano', 'outputNanoUsd'),
  sum('c.savings_nano', 'actualSavingsNanoUsd'),
  `COALESCE(SUM(c.total_nano IS NULL),0) AS unpricedRequests`,
  `COALESCE(SUM(u.total_input_tokens IS NULL),0) AS requestsWithoutUsage`,
  `COALESCE(SUM(u.total_input_tokens IS NOT NULL),0) AS requestsReportingUsage`,
  `COALESCE(SUM(u.cache_read_tokens > 0),0) AS requestsWithCacheRead`,
  `COALESCE(SUM(u.cache_write_tokens > 0),0) AS requestsWithCacheWrite`,
  `AVG(r.duration_ms) AS avgDurationMs`,
  `${HIT} AS cacheHitRate`,
  'COALESCE(MAX(r.demo),0) AS demo',
].join(', ');
export const rows = (store: Store, sql: string, params: Params = []): Row[] =>
  store.sqlite.prepare(sql).all(...params) as Row[];
export const one = (store: Store, sql: string, params: Params = []): Row =>
  (store.sqlite.prepare(sql).get(...params) ?? {}) as Row;
export const totals = (store: Store, w: Where): Row =>
  one(store, `SELECT ${TOTALS} ${JOIN} ${w.sql}`, w.params);
export const models = (store: Store, w: Where): ModelBreakdown[] =>
  rows(
    store,
    `SELECT r.provider, COALESCE(r.model,'Unknown') AS model, ${TOTALS}, COALESCE(SUM(c.total_nano IS NULL),0) AS unpriced ${JOIN} ${w.sql} GROUP BY r.provider,r.model ORDER BY totalNanoUsd DESC`,
    w.params,
  ) as unknown as ModelBreakdown[];
export const providers = (store: Store, w: Where): Row[] =>
  rows(
    store,
    `SELECT r.provider, ${TOTALS} ${JOIN} ${w.sql} GROUP BY r.provider ORDER BY totalNanoUsd DESC`,
    w.params,
  );
export const buckets = (store: Store, w: Where, bucket: 'hour' | 'day'): TimeBucket[] => {
  const format = bucket === 'hour' ? '%Y-%m-%dT%H:00:00.000Z' : '%Y-%m-%dT00:00:00.000Z';
  return rows(
    store,
    `SELECT strftime('${format}',r.started_ms/1000,'unixepoch') AS t, ${TOTALS} ${JOIN} ${w.sql} GROUP BY t ORDER BY t`,
    w.params,
  ) as unknown as TimeBucket[];
};
export const sessionRows = (store: Store, w: Where, limit = 50, offset = 0): SessionSummary[] => {
  const extra = w.sql ? `${w.sql} AND r.session_id IS NOT NULL` : 'WHERE r.session_id IS NOT NULL';
  return rows(
    store,
    `SELECT r.session_id AS id, MIN(r.started_ms) AS first_ms, MAX(r.started_ms) AS last_ms,
    ${TOTALS}, json_group_array(DISTINCT r.model) AS models_json,
    (SELECT count(*) FROM optimization_findings f WHERE f.session_id=r.session_id) AS findingCount
    ${JOIN} ${extra} GROUP BY r.session_id ORDER BY last_ms DESC LIMIT ? OFFSET ?`,
    [...w.params, limit, offset],
  ).map((r) => ({
    ...r,
    firstSeen: new Date(r['first_ms'] as number).toISOString(),
    lastSeen: new Date(r['last_ms'] as number).toISOString(),
    models: json<(string | null)[]>(r, 'models_json', []).filter((m): m is string => m !== null),
  })) as unknown as SessionSummary[];
};
