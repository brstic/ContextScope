import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AnalyzableRequest } from '@contextscope/analyzer';
import { redactJson } from '@contextscope/core';
import type {
  Confidence,
  ContextSegment,
  CostBreakdown,
  Finding,
  MeasurementSource,
  NormalizedUsage,
  ProviderId,
  RequestFeatures,
  RequestState,
  SegmentKind,
  TraceRecord,
} from '@contextscope/shared';
import type { OpenedDb } from './migrate.js';
import type { AnalysisRow, Store, StoreExtra } from '../types.js';

/** SQLite allows 999+ host parameters; stay well below for portability. */
const MAX_PARAMS = 500;
const DAY_MS = 86_400_000;

export interface StoreOptions {
  /** 32-byte AES-256-GCM key for deep-capture content at rest (see keys.ts). */
  contentKey: Buffer;
  /** Clock for settings/finding timestamps and content expiry checks (tests). */
  now?: () => number;
}

/** Integer column or null (fractional ms are rounded; NaN/Infinity become null). */
const int = (n: number | null | undefined): number | null =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n);
const bool = (b: boolean | null | undefined): number | null =>
  b === null || b === undefined ? null : b ? 1 : 0;
const parseJson = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

interface UsageCostRow {
  id: string;
  provider: string;
  model: string | null;
  session_id: string | null;
  started_ms: number;
  duration_ms: number | null;
  ttft_ms: number | null;
  state: string;
  features_json: string;
  u_total: number | null;
  u_uncached: number | null;
  u_read: number | null;
  u_write: number | null;
  u_write5m: number | null;
  u_write1h: number | null;
  u_output: number | null;
  u_reasoning: number | null;
  u_provider_total: number | null;
  u_other: string | null;
  u_source: string | null;
  u_complete: number | null;
  u_raw: string | null;
  c_request_id: string | null;
  c_uncached: number | null;
  c_read: number | null;
  c_write: number | null;
  c_output: number | null;
  c_total: number | null;
  c_savings: number | null;
  c_model_key: string | null;
  c_source: string | null;
  c_version: string | null;
  c_confidence: string | null;
  c_notes: string | null;
}

interface SegmentRow {
  request_id: string;
  idx: number;
  kind: string;
  role: string | null;
  path: string;
  label: string;
  byte_length: number;
  estimated_tokens: number | null;
  token_source: string;
  exact_fp: string;
  normalized_fp: string;
  prefix_fp: string;
  cache_control: string | null;
  message_index: number | null;
  multimodal: number;
  duplicate_in_request: number;
}

const EMPTY_FEATURES: RequestFeatures = {
  stream: false,
  toolCount: 0,
  toolChoice: null,
  structuredOutput: false,
  reasoning: null,
  cacheControlBlocks: 0,
  attachments: 0,
  messageCount: 0,
  systemBlocks: 0,
  cacheOptions: {},
};

const rowToUsage = (r: UsageCostRow): NormalizedUsage => ({
  totalInputTokens: r.u_total,
  uncachedInputTokens: r.u_uncached,
  cacheReadTokens: r.u_read,
  cacheWriteTokens: r.u_write,
  cacheWrite5mTokens: r.u_write5m,
  cacheWrite1hTokens: r.u_write1h,
  outputTokens: r.u_output,
  reasoningTokens: r.u_reasoning,
  providerTotalTokens: r.u_provider_total,
  other: parseJson<Record<string, number>>(r.u_other, {}),
  source: (r.u_source as MeasurementSource | null) ?? 'unavailable',
  complete: r.u_complete === 1,
  raw: parseJson<unknown>(r.u_raw, null),
});

const rowToCost = (r: UsageCostRow): CostBreakdown | null =>
  r.c_request_id === null
    ? null
    : {
        currency: 'USD',
        uncachedInputNanoUsd: r.c_uncached,
        cacheReadNanoUsd: r.c_read,
        cacheWriteNanoUsd: r.c_write,
        outputNanoUsd: r.c_output,
        totalNanoUsd: r.c_total,
        actualCacheSavingsNanoUsd: r.c_savings,
        pricingModelKey: r.c_model_key,
        pricingSource: r.c_source,
        pricingVersion: r.c_version,
        confidence: r.c_confidence as Confidence | null,
        notes: parseJson<string[]>(r.c_notes, []),
      };

const rowToSegment = (s: SegmentRow): ContextSegment => ({
  index: s.idx,
  kind: s.kind as SegmentKind,
  role: s.role,
  path: s.path,
  label: s.label,
  byteLength: s.byte_length,
  // char length is not persisted; byte length is the closest stored measure.
  charLength: s.byte_length,
  estimatedTokens: s.estimated_tokens,
  tokenSource: s.token_source as MeasurementSource,
  exactFingerprint: s.exact_fp,
  normalizedFingerprint: s.normalized_fp,
  prefixFingerprint: s.prefix_fp,
  cacheControl: s.cache_control,
  messageIndex: s.message_index,
  multimodal: s.multimodal === 1,
  duplicateCountInRequest: s.duplicate_in_request,
  seenInRequests: null,
});

const ANALYSIS_SELECT = `
  SELECT r.id, r.provider, r.model, r.session_id, r.started_ms, r.duration_ms, r.ttft_ms, r.state, r.features_json,
    u.total_input_tokens AS u_total, u.uncached_input_tokens AS u_uncached, u.cache_read_tokens AS u_read,
    u.cache_write_tokens AS u_write, u.cache_write_5m_tokens AS u_write5m, u.cache_write_1h_tokens AS u_write1h,
    u.output_tokens AS u_output, u.reasoning_tokens AS u_reasoning, u.provider_total_tokens AS u_provider_total,
    u.other_json AS u_other, u.source AS u_source, u.complete AS u_complete, u.raw_json AS u_raw,
    c.request_id AS c_request_id, c.uncached_input_nano AS c_uncached, c.cache_read_nano AS c_read,
    c.cache_write_nano AS c_write, c.output_nano AS c_output, c.total_nano AS c_total, c.savings_nano AS c_savings,
    c.pricing_model_key AS c_model_key, c.pricing_source AS c_source, c.pricing_version AS c_version,
    c.confidence AS c_confidence, c.notes_json AS c_notes
  FROM requests r
  LEFT JOIN request_usage u ON u.request_id = r.id
  LEFT JOIN request_costs c ON c.request_id = r.id`;

/**
 * SQLite-backed Store. All statements are prepared once (variable-arity ones are cached
 * per arity). Writes throw to the caller on failure (SQLITE_BUSY after busy_timeout,
 * constraint violations…); the pipeline counts them and never crashes.
 */
export const createStore = (opened: OpenedDb, opts: StoreOptions): Store => {
  const { sqlite, db } = opened;
  if (opts.contentKey.length !== 32) throw new Error('content key must be 32 bytes (AES-256)');
  const contentKey = Buffer.from(opts.contentKey);
  const now = opts.now ?? Date.now;

  const st = {
    project: sqlite.prepare(
      'INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING',
    ),
    session: sqlite.prepare(`INSERT INTO sessions (id, project_id, first_seen_ms, last_seen_ms, label, demo)
      VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        first_seen_ms = MIN(first_seen_ms, excluded.first_seen_ms),
        last_seen_ms = MAX(last_seen_ms, excluded.last_seen_ms)`),
    request: sqlite.prepare(`INSERT INTO requests (
        id, project_id, session_id, trace_id, provider_request_id, provider, model, endpoint, operation, method,
        http_status, state, error_message, started_ms, started_at, ended_at, duration_ms, ttfb_ms, ttft_ms, connect_ms,
        request_bytes, response_bytes, stream, stream_completed, features_json, segment_count, segments_truncated,
        first_changed_segment, shared_prefix_segments, previous_request_id, origin, demo)
      VALUES (@id, @projectId, @sessionId, @traceId, @providerRequestId, @provider, @model, @endpoint, @operation, @method,
        @httpStatus, @state, @errorMessage, @startedMs, @startedAt, @endedAt, @durationMs, @ttfbMs, @ttftMs, @connectMs,
        @requestBytes, @responseBytes, @stream, @streamCompleted, @featuresJson, @segmentCount, @segmentsTruncated,
        @firstChangedSegment, @sharedPrefixSegments, @previousRequestId, @origin, @demo)`),
    usage: sqlite.prepare(`INSERT INTO request_usage (
        request_id, total_input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens, output_tokens, reasoning_tokens, provider_total_tokens,
        other_json, source, complete, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    cost: sqlite.prepare(`INSERT INTO request_costs (
        request_id, uncached_input_nano, cache_read_nano, cache_write_nano, output_nano, total_nano, savings_nano,
        pricing_model_key, pricing_source, pricing_version, confidence, notes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    segment: sqlite.prepare(`INSERT INTO context_segments (
        request_id, idx, kind, role, path, label, byte_length, estimated_tokens, token_source, exact_fp, normalized_fp,
        prefix_fp, cache_control, message_index, multimodal, duplicate_in_request)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    findingGet: sqlite.prepare('SELECT * FROM optimization_findings WHERE dedup_key = ?'),
    findingInsert: sqlite.prepare(`INSERT INTO optimization_findings (
        id, dedup_key, type, severity, confidence, title, description, evidence_json, recommendation, tradeoff, affects,
        request_ids_json, segment_indexes_json, estimated_token_reduction, docs_url, session_id, created_ms, updated_ms, demo)
      VALUES (@id, @dedupKey, @type, @severity, @confidence, @title, @description, @evidenceJson, @recommendation, @tradeoff,
        @affects, @requestIdsJson, @segmentIndexesJson, @estimatedTokenReduction, @docsUrl, @sessionId, @createdMs, @updatedMs, @demo)`),
    findingUpdate: sqlite.prepare(`UPDATE optimization_findings SET
        severity = @severity, confidence = @confidence, title = @title, description = @description,
        evidence_json = @evidenceJson, recommendation = @recommendation, tradeoff = @tradeoff, affects = @affects,
        request_ids_json = @requestIdsJson, segment_indexes_json = @segmentIndexesJson,
        estimated_token_reduction = @estimatedTokenReduction, docs_url = @docsUrl, session_id = @sessionId,
        updated_ms = @updatedMs, demo = @demo
      WHERE dedup_key = @dedupKey`),
    recentBySession: sqlite.prepare(
      `${ANALYSIS_SELECT} WHERE r.session_id = ? ORDER BY r.started_ms DESC, r.rowid DESC LIMIT ?`,
    ),
    recentByModel: sqlite.prepare(
      `${ANALYSIS_SELECT} WHERE r.session_id IS NULL AND r.provider = ? AND r.model IS ? ORDER BY r.started_ms DESC, r.rowid DESC LIMIT ?`,
    ),
    settingGet: sqlite.prepare('SELECT value_json FROM settings WHERE key = ?'),
    settingSet: sqlite.prepare(`INSERT INTO settings (key, value_json, updated_ms) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_ms = excluded.updated_ms`),
    contentPut:
      sqlite.prepare(`INSERT INTO captured_content (request_id, expires_ms, iv, tag, ciphertext) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET expires_ms = excluded.expires_ms, iv = excluded.iv, tag = excluded.tag,
        ciphertext = excluded.ciphertext`),
    contentGet: sqlite.prepare(
      'SELECT expires_ms, iv, tag, ciphertext FROM captured_content WHERE request_id = ?',
    ),
    contentExpire: sqlite.prepare('DELETE FROM captured_content WHERE expires_ms <= ?'),
    requestsExpire: sqlite.prepare('DELETE FROM requests WHERE started_ms < ?'),
    findingsExpire: sqlite.prepare('DELETE FROM optimization_findings WHERE updated_ms < ?'),
    sessionsOrphan: sqlite.prepare(
      'DELETE FROM sessions WHERE NOT EXISTS (SELECT 1 FROM requests r WHERE r.session_id = sessions.id)',
    ),
    count: sqlite.prepare('SELECT COUNT(*) AS n FROM requests'),
    fpBump: sqlite.prepare(`INSERT INTO context_fingerprints (exact_fp, request_count, first_seen_ms, last_seen_ms)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(exact_fp) DO UPDATE SET request_count = request_count + 1,
        first_seen_ms = MIN(first_seen_ms, excluded.first_seen_ms),
        last_seen_ms = MAX(last_seen_ms, excluded.last_seen_ms)`),
    fpClear: sqlite.prepare('DELETE FROM context_fingerprints'),
    fpRebuild: sqlite.prepare(`INSERT INTO context_fingerprints (exact_fp, request_count, first_seen_ms, last_seen_ms)
      SELECT s.exact_fp, COUNT(DISTINCT s.request_id), MIN(r.started_ms), MAX(r.started_ms)
      FROM context_segments s JOIN requests r ON r.id = s.request_id
      GROUP BY s.exact_fp`),
  };

  const varStmts = new Map<string, Database.Statement>();
  const varStmt = (key: string, build: () => string): Database.Statement => {
    let s = varStmts.get(key);
    if (!s) {
      s = sqlite.prepare(build());
      varStmts.set(key, s);
    }
    return s;
  };
  const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

  const insertTx = sqlite.transaction((record: TraceRecord, extra: StoreExtra) => {
    const startedMs = Math.round(Date.parse(record.timing.startedAt));
    if (!Number.isFinite(startedMs)) throw new Error('record has an invalid startedAt');
    st.project.run(record.projectId, record.projectId, new Date(now()).toISOString());
    if (record.sessionId !== null) {
      st.session.run(record.sessionId, record.projectId, startedMs, startedMs, record.demo ? 1 : 0);
    }
    st.request.run({
      id: record.id,
      projectId: record.projectId,
      sessionId: record.sessionId,
      traceId: record.traceId,
      providerRequestId: record.providerRequestId,
      provider: record.provider,
      model: record.model,
      endpoint: record.endpoint,
      operation: extra.operation,
      method: record.method,
      httpStatus: int(record.httpStatus),
      state: record.state,
      errorMessage: record.errorMessage,
      startedMs,
      startedAt: record.timing.startedAt,
      endedAt: record.timing.endedAt,
      durationMs: int(record.timing.durationMs),
      ttfbMs: int(record.timing.ttfbMs),
      ttftMs: int(record.timing.ttftMs),
      connectMs: int(record.timing.connectMs),
      requestBytes: int(record.requestBytes),
      responseBytes: int(record.responseBytes),
      stream: record.stream ? 1 : 0,
      streamCompleted: bool(record.streamCompleted),
      featuresJson: JSON.stringify(record.features),
      segmentCount: record.segments.length,
      segmentsTruncated: extra.segmentsTruncated ? 1 : 0,
      firstChangedSegment: extra.firstChangedSegment,
      sharedPrefixSegments: extra.sharedPrefixSegments,
      previousRequestId: extra.previousRequestId,
      origin: record.origin,
      demo: record.demo ? 1 : 0,
    });
    const u = record.usage;
    st.usage.run(
      record.id,
      int(u.totalInputTokens),
      int(u.uncachedInputTokens),
      int(u.cacheReadTokens),
      int(u.cacheWriteTokens),
      int(u.cacheWrite5mTokens),
      int(u.cacheWrite1hTokens),
      int(u.outputTokens),
      int(u.reasoningTokens),
      int(u.providerTotalTokens),
      JSON.stringify(u.other ?? {}),
      u.source,
      u.complete ? 1 : 0,
      u.raw === null || u.raw === undefined ? null : JSON.stringify(redactJson(u.raw)),
    );
    const c = record.cost;
    if (c !== null) {
      st.cost.run(
        record.id,
        int(c.uncachedInputNanoUsd),
        int(c.cacheReadNanoUsd),
        int(c.cacheWriteNanoUsd),
        int(c.outputNanoUsd),
        int(c.totalNanoUsd),
        int(c.actualCacheSavingsNanoUsd),
        c.pricingModelKey,
        c.pricingSource,
        c.pricingVersion,
        c.confidence,
        JSON.stringify(c.notes),
      );
    }
    for (const s of record.segments) {
      st.segment.run(
        record.id,
        s.index,
        s.kind,
        s.role,
        s.path,
        s.label,
        s.byteLength,
        int(s.estimatedTokens),
        s.tokenSource,
        s.exactFingerprint,
        s.normalizedFingerprint,
        s.prefixFingerprint,
        s.cacheControl,
        s.messageIndex,
        s.multimodal ? 1 : 0,
        s.duplicateCountInRequest,
      );
    }
    for (const fp of new Set(record.segments.map((s) => s.exactFingerprint))) {
      st.fpBump.run(fp, startedMs, startedMs);
    }
  });

  const findingParams = (f: Finding, demo: boolean, ts: number): Record<string, unknown> => ({
    id: f.id,
    dedupKey: f.id,
    type: f.type,
    severity: f.severity,
    confidence: f.confidence,
    title: f.title,
    description: f.description,
    evidenceJson: JSON.stringify(f.evidence),
    recommendation: f.recommendation,
    tradeoff: f.tradeoff,
    affects: f.affects,
    requestIdsJson: JSON.stringify(f.requestIds),
    segmentIndexesJson: JSON.stringify(f.segmentIndexes),
    estimatedTokenReduction: int(f.estimatedTokenReduction),
    docsUrl: f.docsUrl,
    sessionId: f.sessionId,
    createdMs: Number.isFinite(Date.parse(f.createdAt)) ? Date.parse(f.createdAt) : ts,
    updatedMs: ts,
    demo: demo ? 1 : 0,
  });
  const COMPARED = [
    'severity',
    'confidence',
    'title',
    'description',
    'evidence_json',
    'recommendation',
    'tradeoff',
    'affects',
    'request_ids_json',
    'segment_indexes_json',
    'estimated_token_reduction',
    'docs_url',
    'session_id',
    'demo',
  ] as const;
  const CAMEL: Record<(typeof COMPARED)[number], string> = {
    severity: 'severity',
    confidence: 'confidence',
    title: 'title',
    description: 'description',
    evidence_json: 'evidenceJson',
    recommendation: 'recommendation',
    tradeoff: 'tradeoff',
    affects: 'affects',
    request_ids_json: 'requestIdsJson',
    segment_indexes_json: 'segmentIndexesJson',
    estimated_token_reduction: 'estimatedTokenReduction',
    docs_url: 'docsUrl',
    session_id: 'sessionId',
    demo: 'demo',
  };

  const upsertFindingsTx = sqlite.transaction((findings: Finding[], demo: boolean): number => {
    const ts = now();
    let changed = 0;
    for (const f of findings) {
      const p = findingParams(f, demo, ts);
      const existing = st.findingGet.get(f.id) as Record<string, unknown> | undefined;
      if (!existing) {
        st.findingInsert.run(p);
        changed++;
      } else if (COMPARED.some((col) => existing[col] !== p[CAMEL[col]])) {
        st.findingUpdate.run(p);
        changed++;
      }
    }
    return changed;
  });

  const encrypt = (payload: unknown): { iv: string; tag: string; ciphertext: string } => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload) ?? 'null', 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ct.toString('base64'),
    };
  };
  const decrypt = (iv: string, tag: string, ciphertext: string): unknown => {
    const d = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    const pt = Buffer.concat([d.update(Buffer.from(ciphertext, 'base64')), d.final()]);
    return JSON.parse(pt.toString('utf8')) as unknown;
  };

  const loadSegments = (ids: string[]): Map<string, ContextSegment[]> => {
    const out = new Map<string, ContextSegment[]>();
    for (let i = 0; i < ids.length; i += MAX_PARAMS) {
      const chunk = ids.slice(i, i + MAX_PARAMS);
      const rows = varStmt(
        `seg:${chunk.length}`,
        () =>
          `SELECT * FROM context_segments WHERE request_id IN (${placeholders(chunk.length)}) ORDER BY request_id, idx`,
      ).all(...chunk) as SegmentRow[];
      for (const r of rows) {
        const list = out.get(r.request_id);
        if (list) list.push(rowToSegment(r));
        else out.set(r.request_id, [rowToSegment(r)]);
      }
    }
    return out;
  };

  return {
    db,
    sqlite,

    insertRecord(record, extra) {
      insertTx(record, extra);
    },

    upsertFindings(findings, demo) {
      if (findings.length === 0) return 0;
      return upsertFindingsTx(findings, demo);
    },

    recentForAnalysis({ sessionId, provider, model, limit }): AnalysisRow[] {
      const n = Math.max(0, Math.floor(limit));
      if (n === 0) return [];
      const rows = (
        sessionId !== null ? st.recentBySession.all(sessionId, n) : st.recentByModel.all(provider, model, n)
      ) as UsageCostRow[];
      rows.reverse(); // chronological, oldest first
      const segs = loadSegments(rows.map((r) => r.id));
      return rows.map((r): AnalyzableRequest => ({
        id: r.id,
        provider: r.provider as ProviderId,
        model: r.model,
        sessionId: r.session_id,
        startedMs: r.started_ms,
        durationMs: r.duration_ms,
        ttftMs: r.ttft_ms,
        state: r.state as RequestState,
        usage: rowToUsage(r),
        cost: rowToCost(r),
        features: parseJson<RequestFeatures>(r.features_json, EMPTY_FEATURES),
        segments: segs.get(r.id) ?? [],
      }));
    },

    seenCounts(fingerprints, beforeMs) {
      const out = new Map<string, number>();
      const unique = [...new Set(fingerprints)];
      for (const fp of unique) out.set(fp, 0);
      const before = Math.floor(beforeMs);
      // Fast path: running counters. Exact whenever every earlier sighting is before `before`
      // (last_seen < before) or none is (first_seen >= before); only fingerprints whose sightings
      // straddle `before` (concurrent/out-of-order arrivals, viewing an old request) need more work:
      // total minus the requests at/after `before`, found from the (few) newest requests outward.
      const straddling: string[] = [];
      const totals = new Map<string, number>();
      for (let i = 0; i < unique.length; i += MAX_PARAMS) {
        const chunk = unique.slice(i, i + MAX_PARAMS);
        const rows = varStmt(
          `fp:${chunk.length}`,
          () =>
            `SELECT exact_fp AS fp, request_count AS n, first_seen_ms AS f, last_seen_ms AS l
           FROM context_fingerprints WHERE exact_fp IN (${placeholders(chunk.length)})`,
        ).all(...chunk) as { fp: string; n: number; f: number; l: number }[];
        for (const r of rows) {
          if (r.l < before) out.set(r.fp, r.n);
          else if (r.f < before) {
            straddling.push(r.fp);
            totals.set(r.fp, r.n);
          }
        }
      }
      for (const fp of straddling) out.set(fp, totals.get(fp) ?? 0);
      const per = MAX_PARAMS - 1; // one parameter for beforeMs
      for (let i = 0; i < straddling.length; i += per) {
        const chunk = straddling.slice(i, i + per);
        // CROSS JOIN keeps requests (via requests_started) as the outer loop; the unary + stops SQLite
        // from probing segments_exact_fp (O(all sightings)) instead of the (request_id, idx) primary key.
        const rows = varStmt(
          `late:${chunk.length}`,
          () =>
            `SELECT s.exact_fp AS fp, COUNT(DISTINCT s.request_id) AS n
           FROM requests r CROSS JOIN context_segments s ON s.request_id = r.id
           WHERE r.started_ms >= ? AND +s.exact_fp IN (${placeholders(chunk.length)})
           GROUP BY s.exact_fp`,
        ).all(before, ...chunk) as { fp: string; n: number }[];
        for (const r of rows) out.set(r.fp, Math.max(0, (totals.get(r.fp) ?? 0) - r.n));
      }
      return out;
    },

    getSetting<T>(key: string): T | null {
      const row = st.settingGet.get(key) as { value_json: string } | undefined;
      return row ? parseJson<T | null>(row.value_json, null) : null;
    },

    setSetting(key, value) {
      st.settingSet.run(key, JSON.stringify(value ?? null), now());
    },

    putContent(requestId, payload, expiresMs) {
      const e = encrypt(payload);
      st.contentPut.run(requestId, Math.round(expiresMs), e.iv, e.tag, e.ciphertext);
    },

    getContent(requestId) {
      const row = st.contentGet.get(requestId) as
        { expires_ms: number; iv: string; tag: string; ciphertext: string } | undefined;
      if (!row || row.expires_ms <= now()) return null;
      try {
        return { payload: decrypt(row.iv, row.tag, row.ciphertext), expiresMs: row.expires_ms };
      } catch {
        // wrong/deleted content.key (crypto-shredded) or corrupted row: content is unavailable
        return null;
      }
    },

    cleanup(nowMs, metadataRetentionDays) {
      const run = sqlite.transaction(() => {
        const content = st.contentExpire.run(nowMs).changes;
        let requests = 0;
        if (metadataRetentionDays > 0) {
          const cutoff = nowMs - metadataRetentionDays * DAY_MS;
          requests = st.requestsExpire.run(cutoff).changes;
          if (requests > 0) {
            // counters can't be decremented per fingerprint cheaply; rebuild them (cleanup is periodic)
            st.fpClear.run();
            st.fpRebuild.run();
          }
          st.findingsExpire.run(cutoff);
          st.sessionsOrphan.run();
        }
        return { content, requests };
      });
      const result = run();
      try {
        sqlite.pragma('wal_checkpoint(PASSIVE)');
      } catch {
        // checkpoint is best effort (busy readers)
      }
      return result;
    },

    countRequests() {
      return (st.count.get() as { n: number }).n;
    },

    dbBytes() {
      try {
        const pc = sqlite.pragma('page_count', { simple: true }) as number;
        const ps = sqlite.pragma('page_size', { simple: true }) as number;
        return Number.isFinite(pc * ps) ? pc * ps : null;
      } catch {
        return null;
      }
    },
  };
};
