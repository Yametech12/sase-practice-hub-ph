// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Read-only: returns
// the 6 guard counts in ONE query (same CTE/snapshot) + snapshot byte
// sizes, so the failing clause is identified without ambiguity.
import { neon } from "@neondatabase/serverless";
import { loadState } from "./_exam-lib.js";

export default async function handler(req, res) {
  const out = {};
  try {
    const { state } = await loadState();
    const b0 = JSON.stringify(state.bindings || {});
    const e0 = JSON.stringify(state.exams || {});
    const s0 = JSON.stringify(state.used_submissions || {});
    out.sizes = { b0: b0.length, e0: e0.length, s0: s0.length };
    const sql = neon(process.env.DATABASE_URL || "");
    try {
      const rows = await sql`WITH p AS (SELECT ${b0}::jsonb AS b, ${e0}::jsonb AS e, ${s0}::jsonb AS s)
      SELECT
        (SELECT count(*) FROM bindings b, p WHERE (p.b -> b.order_id -> 'devices') IS NULL OR b.devices IS DISTINCT FROM (p.b -> b.order_id -> 'devices')::jsonb) AS c1,
        (SELECT count(*) FROM p, jsonb_each(p.b) e WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.order_id = e.key)) AS c2,
        (SELECT count(*) FROM exams x, p WHERE (p.e -> x.order_id -> x.exam_n::text) IS NULL OR x.data IS DISTINCT FROM (p.e -> x.order_id -> x.exam_n::text)::jsonb) AS c3,
        (SELECT count(*) FROM p, jsonb_each(p.e) o, jsonb_each(o.value) e WHERE NOT EXISTS (SELECT 1 FROM exams x WHERE x.order_id = o.key AND x.exam_n = e.key::int)) AS c4,
        (SELECT count(*) FROM used_submissions u, p WHERE (p.s -> u.key) IS NULL OR u.result IS DISTINCT FROM (p.s -> u.key)::jsonb) AS c5,
        (SELECT count(*) FROM p, jsonb_each(p.s) e WHERE NOT EXISTS (SELECT 1 FROM used_submissions u WHERE u.key = e.key)) AS c6`;
      out.counts = rows?.[0] || null;
    } catch (e) {
      out.counts_error = String(e?.message || e || "").slice(0, 120);
    }
  } catch (e) {
    out.fatal = String(e?.message || e || "").slice(0, 80);
  }
  return res.status(200).json(out);
}
