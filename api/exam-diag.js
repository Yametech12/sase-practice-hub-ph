// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Read-only: runs the
// EXACT guard CASE as a single standalone query (no transaction) with
// the real snapshot params. Discriminates CASE-form vs transaction-batch.
import { neon } from "@neondatabase/serverless";
import { loadState } from "./_exam-lib.js";

export default async function handler(req, res) {
  const out = {};
  try {
    const { state } = await loadState();
    const b0 = JSON.stringify(state.bindings || {});
    const e0 = JSON.stringify(state.exams || {});
    const s0 = JSON.stringify(state.used_submissions || {});
    const sql = neon(process.env.DATABASE_URL || "");
    try {
      const rows = await sql`WITH p AS (SELECT ${b0}::jsonb AS b, ${e0}::jsonb AS e, ${s0}::jsonb AS s)
      SELECT CASE WHEN (
        (SELECT count(*) FROM bindings b, p WHERE (p.b -> b.order_id -> 'devices') IS NULL OR b.devices IS DISTINCT FROM (p.b -> b.order_id -> 'devices')::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.b) e WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.order_id = e.key)) = 0
        AND (SELECT count(*) FROM exams x, p WHERE (p.e -> x.order_id -> x.exam_n::text) IS NULL OR x.data IS DISTINCT FROM (p.e -> x.order_id -> x.exam_n::text)::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.e) o, jsonb_each(o.value) e WHERE NOT EXISTS (SELECT 1 FROM exams x WHERE x.order_id = o.key AND x.exam_n = e.key::int)) = 0
        AND (SELECT count(*) FROM used_submissions u, p WHERE (p.s -> u.key) IS NULL OR u.result IS DISTINCT FROM (p.s -> u.key)::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.s) e WHERE NOT EXISTS (SELECT 1 FROM used_submissions u WHERE u.key = e.key)) = 0
      ) THEN 1 ELSE 1/0 END`;
      out.case_standalone = Array.isArray(rows) ? "pass" : "unexpected";
    } catch (e) {
      out.case_standalone = "error:" + String(e?.message || e || "").slice(0, 100);
    }
    // Same CASE inside sql.transaction as the ONLY query (Serializable).
    try {
      const rows = await sql.transaction(
        [
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
      out.case_in_tx_only = Array.isArray(rows) ? "pass" : "unexpected";
    } catch (e) {
      out.case_in_tx_only = "error:" + String(e?.message || e || "").slice(0, 100);
    }
  } catch (e) {
    out.fatal = String(e?.message || e || "").slice(0, 80);
  }
  return res.status(200).json(out);
}
