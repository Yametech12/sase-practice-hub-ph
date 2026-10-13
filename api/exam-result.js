/**
 * POST /api/exam-result
 * Body: { token, exam }
 *
 * READ-ONLY: returns the stored grade result for a completed exam so the
 * buyer can re-open and review their score, per-section breakdown, advice
 * (improvement guide) and answer review at any time. Only works for exams
 * whose status is "done". Never reveals other buyers' data: the token binds
 * the request to one order_id, and the device must be bound to that order.
 */
import {
  verifyToken,
  loadState,
  readBody,
  validExamN,
  bindingHasDevice,
  DEVICE_MISMATCH_MSG,
} from "./_exam-lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const { token, exam } = await readBody(req);
    const p = verifyToken(token);
    if (!p) return res.status(401).json({ error: "bad_token", message: "Session expired. Please log in again." });
    const n = validExamN(exam);
    if (!n) {
      return res.status(400).json({ error: "bad_request", message: "Invalid exam number." });
    }

    const { state } = await loadState();
    const b = state.bindings[p.order_id];
    if (!bindingHasDevice(b, p.device_hash)) {
      return res.status(403).json({ error: "device_mismatch", message: DEVICE_MISMATCH_MSG });
    }
    const rec = (state.exams[p.order_id] || {})[String(n)];
    if (!rec || rec.status !== "done") {
      return res.status(404).json({ error: "no_result", message: "No completed result for this exam yet." });
    }
    // Same shape as a fresh grade response, so results.html renders unchanged.
    return res.status(200).json({
      score: rec.score,
      total: rec.total,
      pct: rec.pct,
      sections: rec.sections,
      weak_area: rec.weak_area,
      improvement: rec.improvement,
      review: rec.review,
      submitted_at: rec.submitted_at,
      auto_submitted: !!rec.auto_submitted,
      forfeited: !!rec.forfeited,
    });
  } catch (e) {
    console.error("exam-result error:", e.message);
    return res.status(500).json({ error: "server_error", message: "Please try again in a moment." });
  }
}
