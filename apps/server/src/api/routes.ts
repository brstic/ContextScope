import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { captureModeSchema, CONTEXTSCOPE_VERSION, traceFileSchema } from '@contextscope/shared';
import type { ContentResponse, RequestDetail, TraceRecord } from '@contextscope/shared';
import { COST_DISCLAIMER, loadPricingOverrides } from '@contextscope/pricing';
import type { ModelPrice } from '@contextscope/pricing';
import type { ServerContext } from '../types.js';
import { ApiHttpError, notFound, parseInput } from './errors.js';
import { mapDetail, mapFinding, mapSegment, mapSummary, value } from './mappers.js';
import {
  buckets,
  JOIN,
  models,
  one,
  providers,
  query,
  rows,
  SELECT,
  sessionRows,
  totals,
  where,
} from './queries.js';
import { openapi } from './openapi.js';

export type ApiDependencies = ServerContext & { onPricingOverrides?: (overrides: ModelPrice[]) => void };
const idSchema = z.object({ id: z.string().min(1).max(512) });
const settingsSchema = z
  .object({
    captureMode: captureModeSchema.optional(),
    contentRetentionHours: z.number().positive().max(8760).optional(),
    metadataRetentionDays: z.number().int().nonnegative().optional(),
    pricingOverrides: z.array(z.unknown()).optional(),
  })
  .strict();
const severityOrder =
  "CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, updated_ms DESC";

export const registerApi = (app: FastifyInstance, ctx: ApiDependencies): void => {
  const { store, pipeline } = ctx;
  const getRow = (id: string) => {
    const r = one(store, `SELECT ${SELECT} ${JOIN} WHERE r.id=?`, [id]);
    if (!r['id']) throw notFound('Request');
    return r;
  };
  const segments = (id: string) =>
    rows(store, 'SELECT * FROM context_segments WHERE request_id=? ORDER BY idx', [id]).map(mapSegment);
  const content = (id: string): ContentResponse | null => {
    const mem = pipeline.memoryContent(id);
    const kept = mem ?? store.getContent(id);
    if (!kept || kept.expiresMs <= Date.now()) return null;
    const p = kept.payload as { request?: unknown; response?: unknown; segments?: (string | null)[] };
    return {
      requestId: id,
      request: p.request ?? null,
      response: p.response ?? null,
      segments: p.segments ?? [],
      expiresAt: new Date(kept.expiresMs).toISOString(),
      storage: mem ? 'memory' : 'encrypted_db',
    };
  };
  const detail = (id: string): RequestDetail => {
    const d = mapDetail(getRow(id));
    d.contentAvailable = content(id) !== null;
    if (d.previousRequestId)
      d.prefix = {
        againstRequestId: d.previousRequestId,
        ...ctx.analyzer.comparePrefix(segments(d.previousRequestId), segments(id)),
      };
    return d;
  };
  const findings = (clause = '', params: (string | number)[] = []) =>
    rows(
      store,
      `SELECT * FROM optimization_findings ${clause} ORDER BY ${severityOrder} LIMIT 1000`,
      params,
    ).map(mapFinding);
  const settings = () => {
    const stats = pipeline.stats();
    return {
      captureMode: pipeline.captureMode(),
      contentRetentionHours:
        store.getSetting<number>('contentRetentionHours') ?? ctx.config.capture.contentRetentionHours,
      metadataRetentionDays:
        store.getSetting<number>('metadataRetentionDays') ?? ctx.config.capture.metadataRetentionDays,
      pricingOverrides: store.getSetting<unknown[]>('pricingOverrides') ?? [],
      pricingVersion: ctx.pricing.catalog.version,
      host: ctx.config.host,
      port: ctx.config.port,
      demo: ctx.config.demo,
      stats: {
        droppedEvents: stats.dropped,
        queueDepth: stats.queueDepth,
        dbBytes: store.dbBytes(),
        storedRequests: store.countRequests(),
      },
    };
  };
  app.get('/api/health', () => {
    const s = pipeline.stats();
    return {
      ok: true,
      version: CONTEXTSCOPE_VERSION,
      uptimeS: Math.max(0, (Date.now() - ctx.startedAtMs) / 1000),
      demo: ctx.config.demo,
      queue: { depth: s.queueDepth, dropped: s.dropped, capacity: s.capacity },
    };
  });
  app.get('/api/filters', () => ({
    providers: rows(store, 'SELECT DISTINCT provider FROM requests ORDER BY provider').map(
      (r) => r['provider'],
    ),
    models: rows(
      store,
      'SELECT DISTINCT provider, model FROM requests WHERE model IS NOT NULL ORDER BY provider,model',
    ),
    sessions: one(store, 'SELECT count(*) AS n FROM sessions')['n'],
    states: rows(store, 'SELECT DISTINCT state FROM requests ORDER BY state').map((r) => r['state']),
  }));
  app.get('/api/requests', (req) => {
    const q = query(req.query);
    const w = where(q);
    const sort = {
      startedAt: 'r.started_ms',
      cost: 'c.total_nano',
      duration: 'r.duration_ms',
      inputTokens: 'u.total_input_tokens',
    }[q.sort];
    return {
      items: rows(
        store,
        `SELECT ${SELECT} ${JOIN} ${w.sql} ORDER BY ${sort} ${q.dir},r.id LIMIT ? OFFSET ?`,
        [...w.params, q.pageSize, (q.page - 1) * q.pageSize],
      ).map(mapSummary),
      total: one(store, `SELECT count(*) AS n ${JOIN} ${w.sql}`, w.params)['n'],
      page: q.page,
      pageSize: q.pageSize,
    };
  });
  app.get('/api/requests/:id', (req) => detail(parseInput(idSchema, req.params).id));
  app.get('/api/requests/:id/context', (req) => {
    const { id } = parseInput(idSchema, req.params);
    const r = getRow(id);
    const ss = segments(id);
    const c = content(id);
    const seen = store.seenCounts(
      ss.map((s) => s.exactFingerprint),
      value<number>(r, 'started_ms'),
    );
    return {
      requestId: id,
      segments: ss.map((s) => ({
        ...s,
        seenInRequests: seen.get(s.exactFingerprint) ?? 0,
        ...(c ? { content: c.segments[s.index] ?? null } : {}),
      })),
      contentAvailable: c !== null,
      captureMode: pipeline.captureMode(),
    };
  });
  app.get('/api/requests/:id/content', (req) => {
    const { id } = parseInput(idSchema, req.params);
    getRow(id);
    const c = content(id);
    if (!c) throw new ApiHttpError(404, 'content_unavailable', 'Content is not available for this request');
    return c;
  });
  app.get('/api/requests/:id/findings', (req) => {
    const { id } = parseInput(idSchema, req.params);
    getRow(id);
    return findings('WHERE EXISTS (SELECT 1 FROM json_each(request_ids_json) WHERE value=?)', [id]);
  });
  app.get('/api/sessions', (req) => {
    const q = query(req.query);
    return {
      items: sessionRows(store, where(q), q.pageSize, (q.page - 1) * q.pageSize),
      total: one(store, `SELECT count(DISTINCT r.session_id) AS n ${JOIN} ${where(q).sql}`, where(q).params)[
        'n'
      ],
      page: q.page,
      pageSize: q.pageSize,
    };
  });
  app.get('/api/sessions/:id', (req) => {
    const { id } = parseInput(idSchema, req.params);
    const s = sessionRows(store, where(query({ session: id })), 1)[0];
    if (!s) throw notFound('Session');
    return {
      ...s,
      turns: rows(store, `SELECT ${SELECT} ${JOIN} WHERE r.session_id=? ORDER BY r.started_ms,r.id`, [
        id,
      ]).map((r) => ({
        requestId: r['id'],
        startedAt: r['started_at'],
        model: r['model'],
        totalInputTokens: r['total_input_tokens'] ?? null,
        uncachedInputTokens: r['uncached_input_tokens'] ?? null,
        cacheReadTokens: r['cache_read_tokens'] ?? null,
        cacheWriteTokens: r['cache_write_tokens'] ?? null,
        outputTokens: r['output_tokens'] ?? null,
        totalNanoUsd: r['total_nano'] ?? null,
        durationMs: r['duration_ms'],
        segmentCount: r['segment_count'],
        firstChangedSegmentIndex: r['first_changed_segment'],
      })),
      findings: findings('WHERE session_id=?', [id]),
    };
  });
  app.get('/api/overview', (req) => {
    const q = query(req.query);
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.parse(to) - 30 * 86400000).toISOString();
    const w = where(query({ ...q, from, to }));
    const t = totals(store, w);
    const durations = one(store, `SELECT count(r.duration_ms) AS n ${JOIN} ${w.sql}`, w.params)[
      'n'
    ] as number;
    const p95 = durations
      ? one(
          store,
          `SELECT r.duration_ms ${JOIN} ${w.sql} AND r.duration_ms IS NOT NULL ORDER BY r.duration_ms LIMIT 1 OFFSET ?`,
          [...w.params, Math.ceil(durations * 0.95) - 1],
        )['duration_ms']
      : null;
    return {
      range: { from, to },
      totals: {
        ...t,
        p95DurationMs: p95,
        openFindings: one(store, 'SELECT count(*) AS n FROM optimization_findings')['n'],
      },
      series: buckets(store, w, Date.parse(to) - Date.parse(from) <= 48 * 3600000 ? 'hour' : 'day'),
      byModel: models(store, w),
      byProvider: providers(store, w),
      topSessions: sessionRows(store, w, 10),
      topRequests: rows(
        store,
        `SELECT ${SELECT} ${JOIN} ${w.sql} ORDER BY c.total_nano DESC LIMIT 10`,
        w.params,
      ).map(mapSummary),
      recentFindings: rows(
        store,
        'SELECT * FROM optimization_findings ORDER BY updated_ms DESC LIMIT 10',
      ).map(mapFinding),
      demo: t['demo'] === 1,
    };
  });
  app.get('/api/cache/summary', (req) => {
    const w = where(query(req.query));
    return {
      totals: totals(store, w),
      byProvider: providers(store, w),
      byModel: models(store, w),
      prefixStability: {
        ...one(
          store,
          `SELECT count(*) AS comparisons, AVG(CAST(r.shared_prefix_segments AS REAL)/NULLIF(r.segment_count,0)) AS avgSharedSegmentRatio FROM requests r ${w.sql ? w.sql + ' AND' : 'WHERE'} r.shared_prefix_segments IS NOT NULL`,
          w.params,
        ),
        firstChangeByKind: rows(
          store,
          `SELECT s.kind, count(*) AS count FROM requests r JOIN context_segments s ON s.request_id=r.id AND s.idx=r.first_changed_segment ${w.sql} GROUP BY s.kind ORDER BY count DESC`,
          w.params,
        ),
      },
      findings: findings("WHERE affects IN ('caching','both')"),
    };
  });
  app.get('/api/costs/summary', (req) => {
    const w = where(query(req.query));
    const { version, source, effectiveDate } = ctx.pricing.catalog;
    return {
      totals: totals(store, w),
      byProvider: providers(store, w),
      byModel: models(store, w),
      bySession: sessionRows(store, w, 20),
      topRequests: rows(
        store,
        `SELECT ${SELECT} ${JOIN} ${w.sql} ORDER BY c.total_nano DESC LIMIT 20`,
        w.params,
      ).map(mapSummary),
      pricing: { version, source, effectiveDate },
      disclaimer: COST_DISCLAIMER,
    };
  });
  for (const path of ['/api/cache/trends', '/api/costs/trends'])
    app.get(path, (req) => {
      const q = query(req.query);
      return buckets(store, where(q), q.bucket ?? 'day');
    });
  app.get('/api/optimizations', (req) => {
    const q = parseInput(
      z.object({
        severity: z.enum(['high', 'medium', 'low', 'info']).optional(),
        type: z.string().max(128).optional(),
      }),
      req.query,
    );
    const clauses: string[] = [];
    const params: string[] = [];
    if (q.severity) {
      clauses.push('severity=?');
      params.push(q.severity);
    }
    if (q.type) {
      clauses.push('type=?');
      params.push(q.type);
    }
    return findings(clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params);
  });
  app.get('/api/compare', (req) => {
    const { a, b } = parseInput(z.object({ a: z.string().min(1), b: z.string().min(1) }), req.query);
    const da = detail(a);
    const db = detail(b);
    const sa = segments(a);
    const sb = segments(b);
    const p = ctx.analyzer.comparePrefix(sa, sb);
    return {
      a: da,
      b: db,
      segmentsA: sa,
      segmentsB: sb,
      alignment: ctx.analyzer.alignSegments(sa, sb),
      firstCacheRelevantDifference: {
        segmentIndex: p.firstChangedSegmentIndex,
        kind: p.firstChangedKind,
        label: p.firstChangedLabel,
        explanation: `Structural evidence, not proof of a provider cache miss. ${p.note}`,
      },
      contentAvailable: da.contentAvailable && db.contentAvailable,
    };
  });
  app.get('/api/providers', () =>
    ctx.routes.map((r) => ({
      id: r.name,
      protocol: r.protocol,
      upstream: r.upstream,
      routePrefix: r.prefix,
      endpoints: [...r.adapter.endpoints],
      custom: r.custom,
    })),
  );
  app.get('/api/settings', settings);
  app.put('/api/settings', (req) => {
    const b = parseInput(settingsSchema, req.body);
    let overrides: ModelPrice[] | undefined;
    if (b.pricingOverrides !== undefined) {
      try {
        overrides = loadPricingOverrides(b.pricingOverrides);
      } catch (e) {
        throw new ApiHttpError(
          400,
          'invalid_request',
          e instanceof Error ? e.message : 'Invalid pricing overrides',
        );
      }
    }
    if (overrides) {
      ctx.onPricingOverrides?.(overrides);
      store.setSetting('pricingOverrides', overrides);
    }
    if (b.captureMode) {
      pipeline.setCaptureMode(b.captureMode);
      store.setSetting('captureMode', b.captureMode);
    }
    if (b.contentRetentionHours !== undefined)
      store.setSetting('contentRetentionHours', b.contentRetentionHours);
    if (b.metadataRetentionDays !== undefined)
      store.setSetting('metadataRetentionDays', b.metadataRetentionDays);
    return settings();
  });
  app.get('/api/export', (req, reply) => {
    const w = where(query(req.query));
    function* exportJson(): Generator<string> {
      yield `{"format":"contextscope.export","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"records":[`;
      let offset = 0;
      let first = true;
      while (true) {
        const batch = rows(
          store,
          `SELECT ${SELECT} ${JOIN} ${w.sql} ORDER BY r.started_ms,r.id LIMIT 100 OFFSET ?`,
          [...w.params, offset],
        );
        if (!batch.length) break;
        for (const r of batch) {
          const { previousRequestId: _p, prefix: _x, contentAvailable: _c, ...d } = mapDetail(r);
          const record: TraceRecord = { ...d, segments: segments(d.id) };
          yield `${first ? '' : ','}${JSON.stringify(record)}`;
          first = false;
        }
        offset += batch.length;
      }
      yield ']}';
    }
    return reply
      .header('content-disposition', 'attachment; filename="contextscope-export.json"')
      .type('application/json')
      .send(Readable.from(exportJson()));
  });
  app.addContentTypeParser(
    ['application/x-ndjson', 'application/jsonl'],
    { parseAs: 'string', bodyLimit: 50 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.post('/api/import', { bodyLimit: 50 * 1024 * 1024 }, (req) => {
    let traces: unknown[];
    if (typeof req.body === 'string') {
      try {
        traces = req.body
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as unknown);
      } catch {
        throw new ApiHttpError(400, 'invalid_request', 'Invalid JSONL');
      }
    } else traces = parseInput(traceFileSchema, req.body).traces;
    return pipeline.importTraces(traces, { demo: false, origin: 'import' });
  });
  app.get('/api/openapi.json', () => openapi);
};
