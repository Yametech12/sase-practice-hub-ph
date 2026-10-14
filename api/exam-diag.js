// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Read-only: tests the
// IS-NULL direction the per-clause tests missed — DB rows whose key is
// absent from the loadState snapshot. Returns counts + keys only.
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
    const run = async (name, q) => {
      try {
        const rows = await sql(q, [b0, e0, s0]);
        out[name] = rows.map((r) => r.k);
      } catch (e) {
        out[name] = "error:" + String(e?.message || e || "").slice(0, 60);
      }
    };
    await run(
      "bindings_rows_missing_from_snapshot",
      `WITH p AS (SELECT $1::jsonb AS b, $2::jsonb AS e, $3::jsonb AS s) SELECT b.order_id AS k FROM bindings b, p WHERE (p.b -> b.order_id) IS NULL`,
    );
    await run(
      "exams_rows_missing_from_snapshot",
      `WITH p AS (SELECT $1::jsonb AS b, $2::jsonb AS e, $3::jsonb AS s) SELECT (x.order_id || ':' || x.exam_n::text) AS k FROM exams x, p WHERE (p.e -> x.order_id -> x.exam_n::text) IS NULL`,
    );
    await run(
      "subs_rows_missing_from_snapshot",
      `WITH p AS (SELECT $1::jsonb AS b, $2::jsonb AS e, $3::jsonb AS s) SELECT u.key AS k FROM used_submissions u, p WHERE (p.s -> u.key) IS NULL`,
    );
    // Also: snapshot keys NOT in DB (the other direction, for completeness).
    await run(
      "snapshot_bindings_keys_missing_from_db",
      `WITH p AS (SELECT $1::jsonb AS b, $2::jsonb AS e, $3::jsonb AS s) SELECT e.key AS k FROM p, jsonb_each(p.b) e WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.order_id = e.key)`,
    );
    out.snapshot_counts = {
      bindings: Object.keys(state.bindings || {}).length,
      exams: Object.keys(state.exams || {}).length,
      subs: Object.keys(state.used_submissions || {}).length,
    };
  } catch (e) {
    out.fatal = String(e?.message || e || "").slice(0, 80);
  }
  return res.status(200).json(out);
}
