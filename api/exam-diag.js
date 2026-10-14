// TEMPORARY diagnostic endpoint — DELETE AFTER USE. Tests the REAL
// updateState/writeState code path (no hand-copied SQL): adds a FAKE
// binding row, then deletes it in the same request, so state ends clean.
// Returns only booleans/coarse labels.
import { neon } from "@neondatabase/serverless";
import { loadState, updateState } from "./_exam-lib.js";

function kindOf(e) {
  const s = String(e?.message || e || "");
  if (/division by zero/i.test(s)) return "guard_mismatch";
  if (/could not serialize|40001/i.test(s)) return "serialization";
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(s)) return "timeout";
  return "other:" + s.slice(0, 80);
}

const FAKE = "ORD-DIAG-FAKE-001";

export default async function handler(req, res) {
  const out = { write_ok: false, write_error_kind: null, cleanup_ok: false, before: null, after: null };
  try {
    const { state: s0 } = await loadState();
    out.before = {
      bindings: Object.keys(s0.bindings || {}).length,
      has_fake: Boolean((s0.bindings || {})[FAKE]),
    };
    try {
      await updateState((state) => {
        state.bindings[FAKE] = {
          devices: [{ device_hash: "diag", bound_at: "2026-10-14T00:00:00.000Z", ip_hash: "diag" }],
        };
        return { ok: true };
      }, "diag: fake binding write");
      out.write_ok = true;
    } catch (e) {
      out.write_error_kind = kindOf(e);
    }
    // Cleanup: remove the fake row if the write succeeded.
    try {
      const sql = neon(process.env.DATABASE_URL || "");
      await sql`DELETE FROM bindings WHERE order_id = ${FAKE}`;
      out.cleanup_ok = true;
    } catch (e) {
      out.cleanup_ok = "error:" + kindOf(e);
    }
    const { state: s1 } = await loadState();
    out.after = {
      bindings: Object.keys(s1.bindings || {}).length,
      has_fake: Boolean((s1.bindings || {})[FAKE]),
    };
  } catch (e) {
    out.fatal = kindOf(e);
  }
  return res.status(200).json(out);
}
