// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Read-only: runs the
// locks + guard inside ONE Serializable transaction, exactly as writeState
// does (no write statements). Returns only booleans/coarse labels.
import { neon } from "@neondatabase/serverless";
import { loadState } from "./_exam-lib.js";

function kindOf(e) {
  const s = String(e?.message || e || "");
  if (/division by zero/i.test(s)) return "guard_mismatch";
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(s)) return "timeout";
  return "other";
}

export default async function handler(req, res) {
  const out = { tx_guard_ok: false, tx_guard_error_kind: null, tx_ms: null };
  try {
    const { state } = await loadState();
    const b0 = JSON.stringify(state.bindings || {});
    const e0 = JSON.stringify(state.exams || {});
    const s0 = JSON.stringify(state.used_submissions || {});
    const sql = neon(process.env.DATABASE_URL || "");
    const t0 = Date.now();
    try {
      const rows = await sql.transaction(
        [
          sql`SELECT order_id FROM bindings FOR UPDATE`,
          sql`SELECT order_id, exam_n FROM exams FOR UPDATE`,
          sql`SELECT key FROM used_submissions FOR UPDATE`,
          sql`WITH p AS (SELECT ${b0}::jsonb AS b, ${e0}::jsonb AS e, ${s0}::jsonb AS s)
      SELECT CASE WHEN (
        (SELECT count(*) FROM bindings b, p WHERE (p.b -> b.order_id -> 'devices') IS NULL OR b.devices IS DISTINCT FROM (p.b -> b.order_id -> 'devices')::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.b) e WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.order_id = e.key)) = 0
        AND (SELECT count(*) FROM exams x, p WHERE (p.e -> x.order_id -> x.exam_n::text) IS NULL OR x.data IS DISTINCT FROM (p.e -> x.order_id -> x.exam_n::text)::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.e) o, jsonb_each(o.value) e WHERE NOT EXISTS (SELECT 1 FROM exams x WHERE x.order_id = o.key AND x.exam_n = e.key::int)) = 0
        AND (SELECT count(*) FROM used_submissions u, p WHERE (p.s -> u.key) IS NULL OR u.result IS DISTINCT FROM (p.s -> u.key)::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.s) e WHERE NOT EXISTS (SELECT 1 FROM used_submissions u WHERE u.key = e.key)) = 0
      ) THEN 1 ELSE 1/0 END`,
        ],
        { isolationLevel: "Serializable" },
      );
      out.tx_ms = Date.now() - t0;
      out.tx_guard_ok = Array.isArray(rows) && rows.length === 4;
    } catch (e) {
      out.tx_ms = Date.now() - t0;
      out.tx_guard_error_kind = kindOf(e);
    }
  } catch (e) {
    out.fatal = kindOf(e);
  }
  return res.status(200).json(out);
}
