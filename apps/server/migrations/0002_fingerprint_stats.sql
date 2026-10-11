-- Running per-fingerprint counters so "seen in N earlier requests" is an O(1) lookup instead of a
-- COUNT(DISTINCT) over every segment ever captured (which grew linearly with history).
CREATE TABLE context_fingerprints (
  exact_fp TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);

INSERT INTO context_fingerprints (exact_fp, request_count, first_seen_ms, last_seen_ms)
SELECT s.exact_fp, COUNT(DISTINCT s.request_id), MIN(r.started_ms), MAX(r.started_ms)
FROM context_segments s JOIN requests r ON r.id = s.request_id
GROUP BY s.exact_fp;

-- Analysis history by provider+model without a session (the partial match on session_id IS NULL).
CREATE INDEX requests_nosession_provider_model ON requests(provider, model, started_ms) WHERE session_id IS NULL;
