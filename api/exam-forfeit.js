/**
 * POST /api/exam-forfeit
 * Body: { token, exam, session_id }
 *
 * Explicit forfeit: the buyer gives up an in-progress attempt. The attempt is
 * CONSUMED (1 attempt per exam) and the SAVED answers are graded — the buyer
 * still gets their results screen + improvement guide. Idempotent: forfeiting
 * an already-done exam returns the stored summary.
 */
import {
  verifyToken,
  ipHash,
  updateState,
  loadBankAtBlob,
  getExamItems,
  readBody,
  logEvent,
  buildResult,
  sanitizeAnswers,
  validExamN,
  examUnlock,
  DEVICE_MISMATCH_MSG,
  bindingHasDevice,
  EXAM_LOCKED_MSG,
} from "./_exam-lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const { token, exam, session_id } = await readBody(req);
    const p = verifyToken(token);
    if (!p) return res.status(401).json({ error: "bad_token", message: "Session expired. Please log in again." });
    const n = validExamN(exam);
    if (!n || typeof session_id !== "string" || !session_id) {
      return res.status(400).json({ error: "bad_request" });
    }

    const now = Date.now();
    const u = examUnlock(p.created_at, n, now);
    if (!u.unlocked) {
      return res.status(403).json({ error: "locked", message: EXAM_LOCKED_MSG });
    }

    let pendingLog = null;
    const outcome = await updateState(async (state) => {
      const b = state.bindings[p.order_id];
      if (!bindingHasDevice(b, p.device_hash)) {
        return { status: 403, body: { error: "device_mismatch", message: DEVICE_MISMATCH_MSG } };
      }
      const orderExams = (state.exams[p.order_id] ||= {});
      const rec = orderExams[String(n)];
      if (!rec) {
        return { status: 400, body: { error: "no_active_attempt", message: "No active exam attempt found." } };
      }
      if (rec.status === "done") {
        return {
          status: 200,
          body: {
            score: rec.score, total: rec.total, pct: rec.pct,
            sections: rec.sections, weak_area: rec.weak_area,
            improvement: rec.improvement, submitted_at: rec.submitted_at,
            auto_submitted: !!rec.auto_submitted, forfeited: !!rec.forfeited,
            already_submitted: true,
          },
        };
      }
      if (rec.session_id !== session_id) {
        return { status: 400, body: { error: "no_active_attempt", message: "Session mismatch. Reload the exam." } };
      }

      const bank = await loadBankAtBlob(rec.bank_blob);
      const items = getExamItems(bank, n);
      if (items.length === 0) {
        return { status: 503, body: { error: "bank_not_ready", message: "This exam is being prepared. Please try again shortly." } };
      }
      const saved = sanitizeAnswers(rec.answers, new Set(rec.q_order));
      const result = buildResult(items, rec, saved);
      const submittedAt = new Date(now).toISOString();
      orderExams[String(n)] = {
        status: "done",
        score: result.score,
        total: result.total,
        pct: result.pct,
        sections: result.sections,
        weak_area: result.weak_area,
        improvement: result.improvement,
        review: result.review,
        submitted_at: submittedAt,
        auto_submitted: false,
        forfeited: true,
      };
      pendingLog = {
        type: "attempt",
        order_id: p.order_id,
        exam: n,
        auto: false,
        forfeited: true,
        score: result.score,
        total: result.total,
        pct: result.pct,
        ip_hash: ipHash(req),
      };
      return { status: 200, body: { ...result, submitted_at: submittedAt, auto_submitted: false, forfeited: true } };
    }, `exam: forfeit ${p.order_id} exam${n}`);

    if (pendingLog) logEvent(pendingLog);
    return res.status(outcome.status).json(outcome.body);
  } catch (e) {
    console.error("exam-forfeit error:", e.message);
    return res.status(500).json({ error: "server_error", message: "Please try again in a moment." });
  }
}
