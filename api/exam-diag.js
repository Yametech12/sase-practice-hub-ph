// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Read-only: isolates
// WHY the guard fails inside a transaction but passes standalone.
// Three variants: (A) guard alone in Serializable tx, (B) locks + trivial
// SELECT in Serializable tx, (C) locks + guard in default (ReadCommitted) tx.
import { neon } from "@neondatabase/serverless";
import { loadState } from "./_exam-lib.js";

function kindOf(e) {
  const s = String(e?.message || e || "");
  if (/division by zero/i.test(s)) return "guard_mismatch";
  if (/could not serialize|40001/i.test(s)) return "serialization";
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(s)) return "timeout";
  return "other:" + s.slice(0, 60);
}

// Guard as a TAGGED template, exactly as writeState builds it.
const guardTagged = (sql, b0, e0, s0) => sql`WITH p AS (SELECT ${b0}::jsonb AS b, ${e0}::jsonb AS e, ${s0}::jsonb AS s)
      SELECT CASE WHEN (
        (SELECT count(*) FROM bindings b, p WHERE (p.b -> b.order_id -> 'devices') IS NULL OR b.devices IS DISTINCT FROM (p.b -> b.order_id -> 'devices')::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.b) e WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.order_id = e.key)) = 0
        AND (SELECT count(*) FROM exams x, p WHERE (p.e -> x.order_id -> x.exam_n::text) IS NULL OR x.data IS DISTINCT FROM (p.e -> x.order_id -> x.exam_n::text)::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.e) o, jsonb_each(o.value) e WHERE NOT EXISTS (SELECT 1 FROM exams x WHERE x.order_id = o.key AND x.exam_n = e.key::int)) = 0
        AND (SELECT count(*) FROM used_submissions u, p WHERE (p.s -> u.key) IS NULL OR u.result IS DISTINCT FROM (p.s -> u.key)::jsonb) = 0
        AND (SELECT count(*) FROM p, jsonb_each(p.s) e WHERE NOT EXISTS (SELECT 1 FROM used_submissions u WHERE u.key = e.key)) = 0
      ) THEN 1 ELSE 1/0 END`;

export default async function handler(req, res) {
  const out = {};
  try {
    const { state } = await loadState();
    const b0 = JSON.stringify(state.bindings || {});
    const e0 = JSON.stringify(state.exams || {});
    const s0 = JSON.stringify(state.used_submissions || {});
    const sql = neon(process.env.DATABASE_URL || "");
    // Variant A: full guard alone, standalone (direct-call form).
    try {
      const q = `WITH p AS (SELECT $1::jsonb AS b, $2::jsonb AS e, $3::jsonb AS s) SELECT CASE WHEN ((SELECT count(*) FROM bindings b, p WHERE (p.b -> b.order_id -> 'devices') IS NULL OR b.devices IS DISTINCT FROM (p.b -> b.order_id -> 'devices')::jsonb) = 0 AND (SELECT count(*) FROM p, jsonb_each(p.b) e WHERE NOT EXISTS (SELECT 1 FROM bindings b WHERE b.order_id = e.key)) = 0 AND (SELECT count(*) FROM exams x, p WHERE (p.e -> x.order_id -> x.exam_n::text) IS NULL OR x.data IS DISTINCT FROM (p.e -> x.order_id -> x.exam_n::text)::jsonb) = 0 AND (SELECT count(*) FROM p, jsonb_each(p.e) o, jsonb_each(o.value) e WHERE NOT EXISTS (SELECT 1 FROM exams x WHERE x.order_id = o.key AND x.exam_n = e.key::int)) = 0 AND (SELECT count(*) FROM used_submissions u, p WHERE (p.s -> u.key) IS NULL OR u.result IS DISTINCT FROM (p.s -> u.key)::jsonb) = 0 AND (SELECT count(*) FROM p, jsonb_each(p.s) e WHERE NOT EXISTS (SELECT 1 FROM used_submissions u WHERE u.key = e.key)) = 0) THEN 1 ELSE 1/0 END`;
      const rows = await sql(q, [b0, e0, s0]);
      out.A_guard_alone_standalone = Array.isArray(rows) ? "pass" : "unexpected";
    } catch (e) {
      out.A_guard_alone_standalone = kindOf(e);
    }
    // Variant B: guard alone inside sql.transaction, Serializable.
    try {
      const rows = await sql.transaction(
        [guardTagged(sql, b0, e0, s0)],
        { isolationLevel: "Serializable" },
      );
      out.B_guard_alone_in_tx_serializable = Array.isArray(rows) ? "pass" : "unexpected";
    } catch (e) {
      out.B_guard_alone_in_tx_serializable = kindOf(e);
    }
    // Variant C: locks + guard inside sql.transaction, DEFAULT isolation.
    try {
      const rows = await sql.transaction([
        sql`SELECT order_id FROM bindings FOR UPDATE`,
        sql`SELECT order_id, exam_n FROM exams FOR UPDATE`,
        sql`SELECT key FROM used_submissions FOR UPDATE`,
        guardTagged(sql, b0, e0, s0),
      ]);
      out.C_locks_guard_default_tx = Array.isArray(rows) ? "pass" : "unexpected";
    } catch (e) {
      out.C_locks_guard_default_tx = kindOf(e);
    }
    // Variant D: locks + guard inside sql.transaction, Serializable
    // (exact replica of writeState) — expected to fail, confirms repro.
    try {
      const rows = await sql.transaction(
        [
          sql`SELECT order_id FROM bindings FOR UPDATE`,
          sql`SELECT order_id, exam_n FROM exams FOR UPDATE`,
          sql`SELECT key FROM used_submissions FOR UPDATE`,
          guardTagged(sql, b0, e0, s0),
        ],
        { isolationLevel: "Serializable" },
      );
      out.D_locks_guard_serializable_tx = Array.isArray(rows) ? "pass" : "unexpected";
    } catch (e) {
      out.D_locks_guard_serializable_tx = kindOf(e);
    }
  } catch (e) {
    out.fatal = kindOf(e);
  }
  return res.status(200).json(out);
}
