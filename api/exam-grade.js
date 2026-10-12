/**
 * POST /api/exam-grade
 * Body: { token, exam, session_id, answers, submission_id }
 *
 * Grades a submitted attempt server-side against the real bank and marks the
 * exam DONE. 1 attempt per exam — after grading (including timer
 * auto-submits) the exam cannot be retaken.
 *
 * Grading rules (audit requirements):
 *  - Server-side only; shuffle mapping comes from the attempt record, never
 *    from the client. Bank version is pinned at issuance (bank_blob).
 *  - Lazy expiry: if the server clock is past expires_at, any answers in the
 *    request body are IGNORED — only pre-expiry persisted answers are graded.
 *  - Input validation: only A/B/C/D per known question id; unknown qids and
 *    malformed letters are dropped, never 500.
 *  - Idempotent: re-sending the same submission_id returns the stored result.
 *  - Weekly unlock is re-checked server-side before grading.
 *
 * Returns: score, per-section breakdown, full answer review (options in the
 * display order the buyer saw), weak-area line and a per-section improvement
 * guide pointing to reviewer chapters.
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
  EXAM_MS,
  DEVICE_MISMATCH_MSG,
  EXAM_LOCKED_MSG,
} from "./_exam-lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const { token, exam, session_id, answers, submission_id } = await readBody(req);
    const p = verifyToken(token);
    if (!p) return res.status(401).json({ error: "bad_token", message: "Session expired. Please log in again." });
    const n = validExamN(exam);
    if (!n || typeof session_id !== "string" || !session_id || typeof submission_id !== "string" || !submission_id) {
      return res.status(400).json({ error: "bad_request" });
    }

    const now = Date.now();
    // Defense in depth: grading re-checks the weekly unlock server-side.
    const u = examUnlock(p.created_at, n, now);
    if (!u.unlocked) {
      return res.status(403).json({ error: "locked", message: EXAM_LOCKED_MSG, unlocks_in_ms: u.unlocks_in_ms });
    }

    const idemKey = `${p.order_id}:${n}:${submission_id}`;
    let pendingLog = null;

    const outcome = await updateState(async (state) => {
      // Idempotency first: already-graded submission returns the stored result.
      if (state.used_submissions[idemKey]) {
        return { status: 200, body: { ...state.used_submissions[idemKey], idempotent: true } };
      }
      const b = state.bindings[p.order_id];
      if (!b || b.device_hash !== p.device_hash) {
        return { status: 403, body: { error: "device_mismatch", message: DEVICE_MISMATCH_MSG } };
      }
      const orderExams = (state.exams[p.order_id] ||= {});
      const rec = orderExams[String(n)];
      if (!rec) {
        return { status: 400, body: { error: "no_active_attempt", message: "No active exam attempt found." } };
      }
      if (rec.status === "done") {
        // Already submitted via another path (expiry auto-grade / forfeit):
        // return the stored summary, never double-consume.
        return {
          status: 200,
          body: {
            score: rec.score,
            total: rec.total,
            pct: rec.pct,
            sections: rec.sections,
            weak_area: rec.weak_area,
            improvement: rec.improvement,
            submitted_at: rec.submitted_at,
            auto_submitted: !!rec.auto_submitted,
            forfeited: !!rec.forfeited,
            already_submitted: true,
          },
        };
      }
      if (rec.session_id !== session_id) {
        return { status: 400, body: { error: "no_active_attempt", message: "Session mismatch. Reload the exam." } };
      }

      const qSet = new Set(rec.q_order);
      const expired = now >= rec.started_at + EXAM_MS;
      // Pre-expiry persisted answers are the base. Answers arriving in the
      // request body are merged ONLY if the timer has not expired — after
      // expiry the server grades what was saved, never late arrivals.
      const finalAnswers = sanitizeAnswers(rec.answers, qSet);
      if (!expired) {
        Object.assign(finalAnswers, sanitizeAnswers(answers, qSet));
      }

      // Grade against the bank version pinned at question issuance.
      const bank = await loadBankAtBlob(rec.bank_blob);
      const items = getExamItems(bank, n);
      if (items.length === 0) {
        return { status: 503, body: { error: "bank_not_ready", message: "This exam is being prepared. Please try again shortly." } };
      }
      const result = buildResult(items, rec, finalAnswers);
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
        auto_submitted: expired,
        forfeited: false,
      };
      const stored = { ...result, submitted_at: submittedAt, auto_submitted: expired, forfeited: false, server_now: now };
      state.used_submissions[idemKey] = stored;
      pendingLog = {
        type: "attempt",
        order_id: p.order_id,
        exam: n,
        auto: expired,
        score: result.score,
        total: result.total,
        pct: result.pct,
        ip_hash: ipHash(req),
      };
      return { status: 200, body: stored };
    }, `exam: grade ${p.order_id} exam${n}`);

    if (pendingLog) logEvent(pendingLog);
    return res.status(outcome.status).json(outcome.body);
  } catch (e) {
    console.error("exam-grade error:", e.message);
    return res.status(500).json({ error: "server_error", message: "Please try again in a moment." });
  }
}
