// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Read-only: tests each
// of the 6 guard clauses separately against the live snapshot (no writes).
// Returns only counts + mismatching KEYS (no row data, no env values).
import { neon } from "@neondatabase/serverless";
import { loadState } from "./_exam-lib.js";

export default async function handler(req, res) {
  const out = { clauses: {}, keys: {} };
  try {
    const { state } = await loadState();
    const b0 = JSON.stringify(state.bindings || {});
    const e0 = JSON.stringify(state.exams || {});
    const s0 = JSON.stringify(state.used_submissions || {});
    const sql = neon(process.env.DATABASE_URL || "");
    const tests = {
      c1_bindings_cmp: `SELECT b.order_id AS k FROM bindings b, p WHERE b.devices IS DISTINCT FROM (p.b -> b.order_id -> 'devices')::jsonb`,
      c2_bindings_keys: `SELECT e.key AS k FROM p, jsonb_each(p.b) e WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.order_id = e.key)`,
      c3_exams_cmp: `SELECT (x.order_id || ':' || x.exam_n::text) AS k FROM exams x, p WHERE x.data IS DISTINCT FROM (p.e -> x.order_id -> x.exam_n::text)::jsonb`,
      c4_exams_keys: `SELECT (o.key || ':' || e.key) AS k FROM p, jsonb_each(p.e) o, jsonb_each(o.value) e WHERE NOT EXISTS (SELECT 1 FROM exams x WHERE x.order_id = o.key AND x.exam_n = e.key::int)`,
      c5_subs_cmp: `SELECT u.key AS k FROM used_submissions u, p WHERE u.result IS DISTINCT FROM (p.s -> u.key)::jsonb`,
      c6_subs_keys: `SELECT e.key AS k FROM p, jsonb_each(p.s) e WHERE NOT EXISTS (SELECT 1 FROM used_submissions u WHERE u.key = e.key)`,
    };
    // Direct per-clause queries (CTE inlined, direct-call form).
    const run = async (name, q) => {
      try {
        const full = `WITH p AS (SELECT $1::jsonb AS b, $2::jsonb AS e, $3::jsonb AS s) ${q}`;
        const rows = await sql(full, [b0, e0, s0]);
        out.clauses[name] = rows.length;
        out.keys[name] = rows.map((r) => r.k).slice(0, 10);
      } catch (e) {
        out.clauses[name] = "error";
        out.keys[name] = String(e?.message || e || "").slice(0, 80);
      }
    };
    await run("c1_bindings_cmp", tests.c1_bindings_cmp);
    await run("c2_bindings_keys", tests.c2_bindings_keys);
    await run("c3_exams_cmp", tests.c3_exams_cmp);
    await run("c4_exams_keys", tests.c4_exams_keys);
    await run("c5_subs_cmp", tests.c5_subs_cmp);
    await run("c6_subs_keys", tests.c6_subs_keys);
  } catch (e) {
    out.fatal = String(e?.message || e || "").slice(0, 80);
  }
  return res.status(200).json(out);
}
