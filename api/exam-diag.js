// TEMPORARY diagnostic endpoint — DELETE AFTER USE (same pattern as the
// removed exam-migrate endpoint). Returns ONLY booleans/timings/coarse
// labels: never env values, never user data, never error messages
// (messages could contain hostnames). Purpose: prove whether Production
// can reach Neon at all, after correct-password logins kept 500ing with
// an ~11s Neon-path delay even after the bindings-guard fix.
import { neon } from "@neondatabase/serverless";

function kindOf(e) {
  const s = String(e?.message || e || "");
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(s)) return "timeout";
  if (/not set/i.test(s)) return "config";
  return "other";
}

export default async function handler(req, res) {
  const t0 = Date.now();
  const out = {
    database_url_set: Boolean(process.env.DATABASE_URL),
    neon_select1_ok: false,
    neon_select1_ms: null,
    bindings_count: null,
    error_kind: null,
  };
  try {
    const url = process.env.DATABASE_URL || "";
    if (!url) throw new Error("DATABASE_URL is not set");
    const sql = neon(url);
    const t1 = Date.now();
    await sql`SELECT 1`;
    out.neon_select1_ms = Date.now() - t1;
    out.neon_select1_ok = true;
    const rows = await sql`SELECT count(*)::int AS n FROM bindings`;
    out.bindings_count = rows?.[0]?.n ?? null;
  } catch (e) {
    out.error_kind = kindOf(e);
    out.neon_select1_ms = Date.now() - t0;
  }
  return res.status(200).json(out);
}
