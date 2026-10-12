/**
 * POST /api/exam-progress
 * Body: { token, exam, session_id, answers }
 *
 * Syncs the buyer's current answers to the server so progress survives a
 * browser exit. Called on every answer (debounced), every 30s, and on
 * pagehide (via sendBeacon). The server is the source of truth for both
 * answers and time.
 *
 * Lazy expiry: writes arriving after expires_at are REJECTED (410) — the
 * timer kept running while the buyer was away, and late answers don't count.
 * Only A/B/C/D per known question id are accepted; anything else is dropped.
 */
import {
  verifyToken,
  updateState,
  readBody,
  sanitizeAnswers,
  validExamN,
  EXAM_MS,
  DEVICE_MISMATCH_MSG,
} from "./_exam-lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const { token, exam, session_id, answers } = await readBody(req);
    const p = verifyToken(token);
    if (!p) return res.status(401).json({ error: "bad_token", message: "Session expired. Please log in again." });
    const n = validExamN(exam);
    if (!n || typeof session_id !== "string" || !session_id) {
      return res.status(400).json({ error: "bad_request" });
    }

    const now = Date.now();
    const outcome = await updateState((state) => {
      const b = state.bindings[p.order_id];
      if (!b || b.device_hash !== p.device_hash) {
        return { status: 403, body: { error: "device_mismatch", message: DEVICE_MISMATCH_MSG } };
      }
      const rec = (state.exams[p.order_id] || {})[String(n)];
      if (!rec || rec.status !== "in_progress" || rec.session_id !== session_id) {
        return { status: 400, body: { error: "no_active_attempt", message: "No active exam attempt." } };
      }
      const remaining = rec.started_at + EXAM_MS - now;
      if (remaining <= 0) {
        return { status: 410, body: { error: "expired", expired: true, server_remaining_ms: 0 } };
      }
      Object.assign(rec.answers, sanitizeAnswers(answers, new Set(rec.q_order)));
      rec.last_sync = now;
      return { status: 200, body: { ok: true, server_remaining_ms: remaining, server_now: now } };
    }, `exam: progress ${p.order_id} exam${n}`);

    return res.status(outcome.status).json(outcome.body);
  } catch (e) {
    console.error("exam-progress error:", e.message);
    return res.status(500).json({ error: "server_error", message: "Please try again in a moment." });
  }
}
