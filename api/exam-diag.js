// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Read-only: verifies
// the data-dependent-division guard replacement: match -> 1, mismatch
// (empty snapshot) -> division-by-zero error. No literal 1/0 anywhere.
import { neon } from "@neondatabase/serverless";
import { loadState } from "./_exam-lib.js";

const TOTAL = `
  (
    (SELECT count(*) FROM bindings b, p WHERE (p.b -> b.order_id -> 'devices') IS NULL OR b.devices IS DISTINCT FROM (p.b -> b.order_id -> 'devices')::jsonb)
    + (SELECT count(*) FROM p, jsonb_each(p.b) e WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.order_id = e.key))
    + (SELECT count(*) FROM exams x, p WHERE (p.e -> x.order_id -> x.exam_n::text) IS NULL OR x.data IS DISTINCT FROM (p.e -> x.order_id -> x.exam_n::text)::jsonb)
    + (SELECT count(*) FROM p, jsonb_each(p.e) o, jsonb_each(o.value) e WHERE NOT EXISTS (SELECT 1 FROM exams x WHERE x.order_id = o.key AND x.exam_n = e.key::int))
    + (SELECT count(*) FROM used_submissions u, p WHERE (p.s -> u.key) IS NULL OR u.result IS DISTINCT FROM (p.s -> u.key)::jsonb)
    + (SELECT count(*) FROM p, jsonb_each(p.s) e WHERE NOT EXISTS (SELECT 1 FROM used_submissions u WHERE u.key = e.key))
  )`;

export default async function handler(req, res) {
  const out = {};
  const sql = neon(process.env.DATABASE_URL || "");
  try {
    const { state } = await loadState();
    const b0 = JSON.stringify(state.bindings || {});
    const e0 = JSON.stringify(state.exams || {});
    const s0 = JSON.stringify(state.used_submissions || {});
    const q = `WITH p AS (SELECT $1::jsonb AS b, $2::jsonb AS e, $3::jsonb AS s) SELECT 1 / (1 - LEAST(${TOTAL}, 1)) AS v`;
    try {
      const rows = await sql(q, [b0, e0, s0]);
      out.matching_snapshot = "ok:" + JSON.stringify(rows);
    } catch (e) {
      out.matching_snapshot = "error:" + String(e?.message || e || "").slice(0, 80);
    }
    // Deliberately wrong snapshot (empty) must raise.
    try {
      const rows = await sql(q, ["{}", "{}", "{}"]);
      out.empty_snapshot = "UNEXPECTED-OK:" + JSON.stringify(rows);
    } catch (e) {
      out.empty_snapshot = "error:" + String(e?.message || e || "").slice(0, 80);
    }
  } catch (e) {
    out.fatal = String(e?.message || e || "").slice(0, 80);
  }
  return res.status(200).json(out);
}
