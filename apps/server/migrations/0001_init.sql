-- ContextScope schema v1. Applied by apps/server/src/db/migrate.ts inside a transaction.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  label TEXT,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_last_seen ON sessions(last_seen_ms);

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  trace_id TEXT,
  provider_request_id TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  endpoint TEXT NOT NULL,
  operation TEXT,
  method TEXT NOT NULL,
  http_status INTEGER,
  state TEXT NOT NULL,
  error_message TEXT,
  started_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  ttfb_ms INTEGER,
  ttft_ms INTEGER,
  connect_ms INTEGER,
  request_bytes INTEGER,
  response_bytes INTEGER,
  stream INTEGER NOT NULL,
  stream_completed INTEGER,
  features_json TEXT NOT NULL,
  segment_count INTEGER NOT NULL DEFAULT 0,
  segments_truncated INTEGER NOT NULL DEFAULT 0,
  first_changed_segment INTEGER,
  shared_prefix_segments INTEGER,
  previous_request_id TEXT,
  origin TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX requests_started ON requests(started_ms);
CREATE INDEX requests_session ON requests(session_id, started_ms);
CREATE INDEX requests_provider_model ON requests(provider, model, started_ms);
CREATE INDEX requests_state ON requests(state, started_ms);

CREATE TABLE request_usage (
  request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  total_input_tokens INTEGER,
  uncached_input_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  provider_total_tokens INTEGER,
  other_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  complete INTEGER NOT NULL,
  raw_json TEXT
);

CREATE TABLE request_costs (
  request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  uncached_input_nano INTEGER,
  cache_read_nano INTEGER,
  cache_write_nano INTEGER,
  output_nano INTEGER,
  total_nano INTEGER,
  savings_nano INTEGER,
  pricing_model_key TEXT,
  pricing_source TEXT,
  pricing_version TEXT,
  confidence TEXT,
  notes_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE context_segments (
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  role TEXT,
  path TEXT NOT NULL,
  label TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  estimated_tokens INTEGER,
  token_source TEXT NOT NULL,
  exact_fp TEXT NOT NULL,
  normalized_fp TEXT NOT NULL,
  prefix_fp TEXT NOT NULL,
  cache_control TEXT,
  message_index INTEGER,
  multimodal INTEGER NOT NULL,
  duplicate_in_request INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (request_id, idx)
);
CREATE INDEX segments_exact_fp ON context_segments(exact_fp);
CREATE INDEX segments_normalized_fp ON context_segments(normalized_fp);

CREATE TABLE captured_content (
  request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  expires_ms INTEGER NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  ciphertext TEXT NOT NULL
);
CREATE INDEX captured_content_expires ON captured_content(expires_ms);

CREATE TABLE optimization_findings (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  tradeoff TEXT NOT NULL,
  affects TEXT NOT NULL,
  request_ids_json TEXT NOT NULL,
  segment_indexes_json TEXT NOT NULL,
  estimated_token_reduction INTEGER,
  docs_url TEXT,
  session_id TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX findings_updated ON optimization_findings(updated_ms);
CREATE INDEX findings_session ON optimization_findings(session_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
