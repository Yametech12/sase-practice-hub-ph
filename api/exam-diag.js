// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Read-only: tests
// whether Postgres/Neon constant-folds `1/0` even when the CASE ELSE
// branch is not taken. If CASE-WHEN-true still raises, the guard's
// raise-via-1/0 technique is fundamentally broken on this backend.
import { neon } from "@neondatabase/serverless";

export default async function handler(req, res) {
  const out = {};
  const sql = neon(process.env.DATABASE_URL || "");
  const t = async (name, q, params = []) => {
    try {
      const rows = await sql(q, params);
      out[name] = "ok:" + JSON.stringify(rows);
    } catch (e) {
      out[name] = "error:" + String(e?.message || e || "").slice(0, 80);
    }
  };
  await t("case_when_true_else_div0", `SELECT CASE WHEN true THEN 1 ELSE 1/0 END AS v`);
  await t("case_when_false_else_2", `SELECT CASE WHEN false THEN 1 ELSE 2 END AS v`);
  await t("plain_div0", `SELECT 1/0 AS v`);
  await t("case_when_true_subquery_else_div0", `SELECT CASE WHEN (SELECT count(*) FROM bindings) >= 0 THEN 1 ELSE 1/0 END AS v`);
  return res.status(200).json(out);
}
