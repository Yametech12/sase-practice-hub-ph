// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Read-only: runs the
// EXACT guard SELECT from writeState against the live snapshot (no
// writes). Returns only booleans/timings/coarse labels — never env
// values, user data, or error messages.
import { neon } from "@neondatabase/serverless";
import { loadState } from "./_exam-lib.js";

function kindOf(e) {
  const s = String(e?.message || e || "");
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(s)) return "timeout";
  if (/not set/i.test(s)) return "config";
  if (/division by zero/i.test(s)) return "guard_mismatch";
  return "other";
}

export default async function handler(req, res) {
  const out = {
    database_url_set: Boolean(process.env.DATABASE_URL),
    load_ok: false,
    load_ms: null,
    guard_ok: false,
    guard_ms: null,
    guard_error_kind: null,
    counts: null,
  };
  try {
    const t0 = Date.now();
    const { state } = await loadState();
    out.load_ms = Date.now() - t0;
    out.load_ok = true;
    out.counts = {
      bindings: Object.keys(state.bindings || {}).length,
      exams: Object.keys(state.exams || {}).length,
      subs: Object.keys(state.used_submissions || {}).length,
    };
    const b0 = JSON.stringify(state.bindings || {});
    const e0 = JSON.stringify(state.exams || {});
    const s0 = JSON.stringify(state.used_submissions || {});
    const sql = neon(process.env.DATABASE_URL || "");
    const g0 = Date.now();
    try {
      // Verbatim guard SELECT from writeState in api/_exam-lib.js.
      const rows = await sql`WITH p AS (SELECT ${b0}::jsonb AS b, ${e0}::jsonb AS e, ${s0}::jsonb AS s)
      SELECT CASE WHEN (
        (SELECT count(*) FROM bindings b, p WHERE (p.b -> b.order_id -> 'devices') IS NULL OR b.devices IS DISTINCT FROM (p.b -> b.order_id -> 'devices')::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.b) e WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.order_id = e.key)) = 0
        AND (SELECT count(*) FROM exams x, p WHERE (p.e -> x.order_id -> x.exam_n::text) IS NULL OR x.data IS DISTINCT FROM (p.e -> x.order_id -> x.exam_n::text)::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.e) o, jsonb_each(o.value) e WHERE NOT EXISTS (SELECT 1 FROM exams x WHERE x.order_id = o.key AND x.exam_n = e.key::int)) = 0
        AND (SELECT count(*) FROM used_submissions u, p WHERE (p.s -> u.key) IS NULL OR u.result IS DISTINCT FROM (p.s -> u.key)::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.s) e WHERE NOT EXISTS (SELECT 1 FROM used_submissions u WHERE u.key = e.key)) = 0
      ) THEN 1 ELSE 1/0 END`;
      out.guard_ms = Date.now() - g0;
      out.guard_ok = Array.isArray(rows) && rows.length > 0;
    } catch (e) {
      out.guard_ms = Date.now() - g0;
      out.guard_error_kind = kindOf(e);
    }
  } catch (e) {
    out.load_error_kind = kindOf(e);
  }
  return res.status(200).json(out);
}
