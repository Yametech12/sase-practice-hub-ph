// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Read-only: runs the
// counts query AND the CASE query in the SAME request with the SAME
// snapshot params. If counts are 0 but CASE fails, drift is ruled out.
import { neon } from "@neondatabase/serverless";
import { loadState } from "./_exam-lib.js";

const CLAUSES = [
  `(SELECT count(*) FROM bindings b, p WHERE (p.b -> b.order_id -> 'devices') IS NULL OR b.devices IS DISTINCT FROM (p.b -> b.order_id -> 'devices')::jsonb)`,
  `(SELECT count(*) FROM p, jsonb_each(p.b) e WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.order_id = e.key))`,
  `(SELECT count(*) FROM exams x, p WHERE (p.e -> x.order_id -> x.exam_n::text) IS NULL OR x.data IS DISTINCT FROM (p.e -> x.order_id -> x.exam_n::text)::jsonb)`,
  `(SELECT count(*) FROM p, jsonb_each(p.e) o, jsonb_each(o.value) e WHERE NOT EXISTS (SELECT 1 FROM exams x WHERE x.order_id = o.key AND x.exam_n = e.key::int))`,
  `(SELECT count(*) FROM used_submissions u, p WHERE (p.s -> u.key) IS NULL OR u.result IS DISTINCT FROM (p.s -> u.key)::jsonb)`,
  `(SELECT count(*) FROM p, jsonb_each(p.s) e WHERE NOT EXISTS (SELECT 1 FROM used_submissions u WHERE u.key = e.key))`,
];

export default async function handler(req, res) {
  const out = {};
  try {
    const { state } = await loadState();
    const b0 = JSON.stringify(state.bindings || {});
    const e0 = JSON.stringify(state.exams || {});
    const s0 = JSON.stringify(state.used_submissions || {});
    const sql = neon(process.env.DATABASE_URL || "");
    // Counts query (same CTE + same params). Built as a plain string so
    // the clause text is SQL, not bound params (direct-call form).
    const cte = `WITH p AS (SELECT $1::jsonb AS b, $2::jsonb AS e, $3::jsonb AS s) `;
    try {
      const rows = await sql(cte + `SELECT ${CLAUSES[0]} AS c1, ${CLAUSES[1]} AS c2, ${CLAUSES[2]} AS c3, ${CLAUSES[3]} AS c4, ${CLAUSES[4]} AS c5, ${CLAUSES[5]} AS c6`, [b0, e0, s0]);
      out.counts = rows?.[0] || null;
    } catch (e) {
      out.counts_error = String(e?.message || e || "").slice(0, 100);
    }
    // CASE query (same CTE + same params, same request).
    try {
      const rows = await sql(cte + `SELECT CASE WHEN (${CLAUSES[0]} = 0 AND ${CLAUSES[1]} = 0 AND ${CLAUSES[2]} = 0 AND ${CLAUSES[3]} = 0 AND ${CLAUSES[4]} = 0 AND ${CLAUSES[5]} = 0) THEN 1 ELSE 1/0 END`, [b0, e0, s0]);
      out.case_result = Array.isArray(rows) ? "pass" : "unexpected";
    } catch (e) {
      out.case_result = "error:" + String(e?.message || e || "").slice(0, 100);
    }
  } catch (e) {
    out.fatal = String(e?.message || e || "").slice(0, 80);
  }
  return res.status(200).json(out);
}
