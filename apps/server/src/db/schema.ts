import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema. Compact, metadata-only by default. Nullable columns mean "unknown";
 * absent metadata is never stored as 0.
 *
 * Money: integer nano-USD. Times: ISO-8601 text (UTC, ms precision) + epoch ms for indexes.
 * The migration SQL in ../../migrations is the source of truth applied at startup;
 * this file mirrors it for typed Drizzle queries.
 */

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    firstSeenMs: integer('first_seen_ms').notNull(),
    lastSeenMs: integer('last_seen_ms').notNull(),
    label: text('label'),
    demo: integer('demo', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('sessions_last_seen').on(t.lastSeenMs)],
);

export const requests = sqliteTable(
  'requests',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    traceId: text('trace_id'),
    providerRequestId: text('provider_request_id'),
    provider: text('provider').notNull(),
    model: text('model'),
    endpoint: text('endpoint').notNull(), // redacted path (+ redacted query)
    operation: text('operation'),
    method: text('method').notNull(),
    httpStatus: integer('http_status'),
    state: text('state').notNull(),
    errorMessage: text('error_message'), // redacted
    startedMs: integer('started_ms').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    durationMs: integer('duration_ms'),
    ttfbMs: integer('ttfb_ms'),
    ttftMs: integer('ttft_ms'),
    connectMs: integer('connect_ms'),
    requestBytes: integer('request_bytes'),
    responseBytes: integer('response_bytes'),
    stream: integer('stream', { mode: 'boolean' }).notNull(),
    streamCompleted: integer('stream_completed', { mode: 'boolean' }),
    featuresJson: text('features_json').notNull(),
    segmentCount: integer('segment_count').notNull().default(0),
    segmentsTruncated: integer('segments_truncated', { mode: 'boolean' }).notNull().default(false),
    firstChangedSegment: integer('first_changed_segment'),
    sharedPrefixSegments: integer('shared_prefix_segments'),
    previousRequestId: text('previous_request_id'),
    origin: text('origin').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('requests_started').on(t.startedMs),
    index('requests_session').on(t.sessionId, t.startedMs),
    index('requests_provider_model').on(t.provider, t.model, t.startedMs),
    index('requests_state').on(t.state, t.startedMs),
  ],
);

export const requestUsage = sqliteTable('request_usage', {
  requestId: text('request_id')
    .primaryKey()
    .references(() => requests.id, { onDelete: 'cascade' }),
  totalInputTokens: integer('total_input_tokens'),
  uncachedInputTokens: integer('uncached_input_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  cacheWrite5mTokens: integer('cache_write_5m_tokens'),
  cacheWrite1hTokens: integer('cache_write_1h_tokens'),
  outputTokens: integer('output_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  providerTotalTokens: integer('provider_total_tokens'),
  otherJson: text('other_json').notNull().default('{}'),
  source: text('source').notNull(),
  complete: integer('complete', { mode: 'boolean' }).notNull(),
  rawJson: text('raw_json'), // provider usage object (numbers only, no content)
});

export const requestCosts = sqliteTable('request_costs', {
  requestId: text('request_id')
    .primaryKey()
    .references(() => requests.id, { onDelete: 'cascade' }),
  uncachedInputNano: integer('uncached_input_nano'),
  cacheReadNano: integer('cache_read_nano'),
  cacheWriteNano: integer('cache_write_nano'),
  outputNano: integer('output_nano'),
  totalNano: integer('total_nano'),
  savingsNano: integer('savings_nano'),
  pricingModelKey: text('pricing_model_key'),
  pricingSource: text('pricing_source'),
  pricingVersion: text('pricing_version'),
  confidence: text('confidence'),
  notesJson: text('notes_json').notNull().default('[]'),
});

export const contextSegments = sqliteTable(
  'context_segments',
  {
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    kind: text('kind').notNull(),
    role: text('role'),
    path: text('path').notNull(),
    label: text('label').notNull(),
    byteLength: integer('byte_length').notNull(),
    estimatedTokens: integer('estimated_tokens'),
    tokenSource: text('token_source').notNull(),
    exactFp: text('exact_fp').notNull(),
    normalizedFp: text('normalized_fp').notNull(),
    prefixFp: text('prefix_fp').notNull(),
    cacheControl: text('cache_control'),
    messageIndex: integer('message_index'),
    multimodal: integer('multimodal', { mode: 'boolean' }).notNull(),
    duplicateInRequest: integer('duplicate_in_request').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.idx] }),
    index('segments_exact_fp').on(t.exactFp),
    index('segments_normalized_fp').on(t.normalizedFp),
  ],
);

/** Deep-capture content, encrypted at rest (AES-256-GCM), expires automatically. */
export const capturedContent = sqliteTable(
  'captured_content',
  {
    requestId: text('request_id')
      .primaryKey()
      .references(() => requests.id, { onDelete: 'cascade' }),
    expiresMs: integer('expires_ms').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    ciphertext: text('ciphertext').notNull(), // base64 of JSON {request, response, segments[]}
  },
  (t) => [index('captured_content_expires').on(t.expiresMs)],
);

export const optimizationFindings = sqliteTable(
  'optimization_findings',
  {
    id: text('id').primaryKey(),
    /** Dedup key: same type + scope updates the row instead of adding a new one. */
    dedupKey: text('dedup_key').notNull().unique(),
    type: text('type').notNull(),
    severity: text('severity').notNull(),
    confidence: text('confidence').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    evidenceJson: text('evidence_json').notNull(),
    recommendation: text('recommendation').notNull(),
    tradeoff: text('tradeoff').notNull(),
    affects: text('affects').notNull(),
    requestIdsJson: text('request_ids_json').notNull(),
    segmentIndexesJson: text('segment_indexes_json').notNull(),
    estimatedTokenReduction: integer('estimated_token_reduction'),
    docsUrl: text('docs_url'),
    sessionId: text('session_id'),
    createdMs: integer('created_ms').notNull(),
    updatedMs: integer('updated_ms').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('findings_updated').on(t.updatedMs), index('findings_session').on(t.sessionId)],
);

/** Key/value settings (capture mode, pricing overrides, fingerprint key id…). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedMs: integer('updated_ms').notNull(),
});

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: text('applied_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});
