/**
 * POST /api/exam-list
 * Body: { token }
 *
 * READ-ONLY: returns the 5 exams with per-exam status. Never writes state.
 *
 * Statuses:
 *   - "available"   : unlocked, not started
 *   - "in_progress" : started, time remains (includes resume_remaining_ms)
 *   - "done"        : submitted (score, pct, sections, weak_area, submitted_at)
 *   - "locked"      : not yet unlocked (includes unlocks_in_ms countdown)
 *
 * Unlock rule: exam N unlocks when floor((now - created_at)/7d)+1 >= N.
 * An in_progress attempt whose timer has expired is listed as "available" —
 * the next exam-questions call will auto-grade it (consuming the attempt).
 */
import {
  verifyToken,
  loadState,
  readBody,
  examUnlock,
  EXAM_COUNT,
  EXAM_MS,
  DEVICE_MISMATCH_MSG,
} from "./_exam-lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const { token } = await readBody(req);
    const p = verifyToken(token);
    if (!p) return res.status(401).json({ error: "bad_token", message: "Session expired. Please log in again." });

    const now = Date.now();
    const { state } = await loadState();
    const b = state.bindings[p.order_id];
    if (!b || b.device_hash !== p.device_hash) {
      return res.status(403).json({ error: "device_mismatch", message: DEVICE_MISMATCH_MSG });
    }
    const recs = state.exams[p.order_id] || {};
    const exams = [];
    for (let n = 1; n <= EXAM_COUNT; n++) {
      const u = examUnlock(p.created_at, n, now);
      const rec = recs[String(n)];
      if (rec && rec.status === "done") {
        exams.push({
          n,
          status: "done",
          score: rec.score,
          total: rec.total,
          pct: rec.pct,
          sections: rec.sections,
          weak_area: rec.weak_area,
          submitted_at: rec.submitted_at,
        });
        continue;
      }
      if (!u.unlocked) {
        exams.push({ n, status: "locked", unlocks_in_ms: u.unlocks_in_ms, unlock_at: u.unlock_at });
        continue;
      }
      if (rec && rec.status === "in_progress") {
        const remaining = Math.max(0, rec.started_at + EXAM_MS - now);
        if (remaining > 0) {
          exams.push({ n, status: "in_progress", resume_remaining_ms: remaining });
          continue;
        }
        // Expired in_progress is auto-graded on the next exam-questions call;
        // list it as available so the client triggers that path.
      }
      exams.push({ n, status: "available" });
    }
    return res.status(200).json({ exams, server_now: now });
  } catch (e) {
    console.error("exam-list error:", e.message);
    return res.status(500).json({ error: "server_error", message: "Please try again in a moment." });
  }
}
