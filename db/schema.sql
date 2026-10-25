-- SASE mock-exam portal state, Neon Postgres (replaces GitHub state.json)
-- Run once per Neon project. The migration script (scripts/migrate-github-to-neon.mjs)
-- runs this file automatically; it is also safe to run by hand (IF NOT EXISTS).
--
-- Payload shapes (must match api/_exam-lib.js, handlers read/write these):
--   bindings.devices : [{ device_hash, bound_at, ip_hash }]  (1 password = up to 3 devices)
--   exams.data       : full examRec, { status, session_id, started_at, q_order,
--                      opt_map, answers, last_sync, bank_blob, + result fields
--                      when done: score, total, pct, sections, weak_area,
--                      improvement, review, submitted_at, auto_submitted, forfeited }
--   used_submissions.result : grade idempotency pointer { ref, submitted_at,
--                      score, total, pct, auto_submitted, forfeited, server_now }
--                      (legacy entries may embed a full review, still honoured)
--
-- Legacy state.json keys `attempts` / `in_progress` are NOT carried over:
-- no handler reads them (verified Oct 2026). The migration script logs
-- their counts and drops them.

CREATE TABLE IF NOT EXISTS bindings (
  order_id TEXT PRIMARY KEY,
  devices JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS exams (
  order_id TEXT NOT NULL,
  exam_n INT NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (order_id, exam_n)
);

CREATE TABLE IF NOT EXISTS used_submissions (
  key TEXT PRIMARY KEY,
  result JSONB NOT NULL
);
