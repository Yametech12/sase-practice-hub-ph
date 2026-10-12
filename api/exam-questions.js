/**
 * POST /api/exam-questions
 * Body: { token, exam }   (exam: 1..5)
 *
 * Starts a NEW attempt for exam N or RESUMES an in-progress one.
 * The attempt is CONSUMED at issuance (not at submit): start → close without
 * submitting does NOT give a free peek — the timer keeps running.
 * The timer is SERVER-AUTHORITATIVE: started_at is recorded server-side;
 * remaining = 2h - (now - started_at). Client never sends timestamps.
 *
 * Rules:
 *   - 403 locked            : exam not yet unlocked (weekly schedule, server-side)
 *   - 403 already_submitted : exam already submitted — 1 attempt per exam, no retakes
 *   - 403 active_attempt    : another exam is in progress — resume or forfeit it first
 *   - expired while away   : auto-grades with saved answers (consumes the
 *                             attempt, full review stored), then reports already_submitted
 *   - per-token/IP rate limit on this endpoint (anti-scrape)
 *
 * Questions are returned WITHOUT answers/explanations. Options are shuffled
 * per attempt; the mapping is kept server-side in the exam record.
 * The bank version (blob SHA) is pinned at issuance so a mid-exam redeploy
 * cannot corrupt grading.
 */
import {
  verifyToken,
  ipHash,
  updateState,
  loadBank,
  getExamItems,
  readBody,
  logEvent,
  shuffleInPlace,
  newId,
  validExamN,
  examUnlock,
  buildResult,
  sanitizeAnswers,
  rateLimit,
  EXAM_MS,
  DEVICE_MISMATCH_MSG,
  EXAM_LOCKED_MSG,
  ACTIVE_ATTEMPT_MSG,
  alreadySubmittedMessage,
} from "./_exam-lib.js";

function publicQuestion(item, optMap) {
  const options = {};
  for (const L of Object.keys(optMap).sort()) options[L] = item.options[optMap[L]];
  return {
    qid: item.id,
    section: item.section,
    number: item.number,
    question: item.question,
    options,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const { token, exam } = await readBody(req);
    const p = verifyToken(token);
    if (!p) return res.status(401).json({ error: "bad_token", message: "Session expired. Please log in again." });
    const n = validExamN(exam);
    if (!n) return res.status(400).json({ error: "bad_request", message: "Exam must be 1–5." });

    if (!rateLimit("q:" + p.order_id, 60, 60 * 1000)) {
      logEvent({ type: "questions_rate_limited", order_id: p.order_id, exam: n });
      return res.status(429).json({
        error: "rate_limited",
        message: "Too many requests. Please wait a moment and try again.",
      });
    }

    const { sha: bankSha, bank } = await loadBank();
    const now = Date.now();

    // Weekly unlock is checked BEFORE the bank (a locked exam must 403 even
    // if its bank isn't deployed yet — never leak existence/timing info).
    const u0 = examUnlock(p.created_at, n, now);
    if (!u0.unlocked) {
      logEvent({ type: "start_refused", reason: "locked", order_id: p.order_id, exam: n, ip_hash: ipHash(req) });
      return res.status(403).json({
        error: "locked",
        message: EXAM_LOCKED_MSG,
        unlocks_in_ms: u0.unlocks_in_ms,
        unlock_at: u0.unlock_at,
      });
    }

    const items = getExamItems(bank, n);
    if (items.length === 0) {
      return res.status(503).json({ error: "bank_not_ready", message: "This exam is being prepared. Please try again shortly." });
    }
    const byId = new Map(items.map((it) => [it.id, it]));
    let pendingLog = null;

    const outcome = await updateState((state) => {
      const b = state.bindings[p.order_id];
      if (!b || b.device_hash !== p.device_hash) {
        return { status: 403, body: { error: "device_mismatch", message: DEVICE_MISMATCH_MSG } };
      }
      // Re-check unlock inside the state transaction (created_at can't change,
      // but this keeps the invariant in one place).
      const u = examUnlock(p.created_at, n, now);
      if (!u.unlocked) {
        pendingLog = { type: "start_refused", reason: "locked", order_id: p.order_id, exam: n };
        return {
          status: 403,
          body: { error: "locked", message: EXAM_LOCKED_MSG, unlocks_in_ms: u.unlocks_in_ms, unlock_at: u.unlock_at },
        };
      }
      const orderExams = (state.exams[p.order_id] ||= {});
      let rec = orderExams[String(n)];

      // Case 1: resume — time remains. Same attempt, same shuffle mapping.
      if (rec && rec.status === "in_progress" && now < rec.started_at + EXAM_MS) {
        const remaining = rec.started_at + EXAM_MS - now;
        pendingLog = { type: "resume", order_id: p.order_id, exam: n, session_id: rec.session_id, remaining_ms: remaining };
        return { status: 200, resumed: true, rec, remaining };
      }

      // Case 2: expired while away — auto-grade with SAVED answers only
      // (consumes the attempt). Full review is stored so the buyer still
      // gets their results screen.
      if (rec && rec.status === "in_progress") {
        const saved = sanitizeAnswers(rec.answers, new Set(rec.q_order));
        const result = buildResult(items, rec, saved);
        orderExams[String(n)] = {
          status: "done",
          score: result.score,
          total: result.total,
          pct: result.pct,
          sections: result.sections,
          weak_area: result.weak_area,
          improvement: result.improvement,
          review: result.review,
          submitted_at: new Date(now).toISOString(),
          auto_submitted: true,
        };
        pendingLog = {
          type: "attempt",
          order_id: p.order_id,
          exam: n,
          auto: true,
          score: result.score,
          total: result.total,
          pct: result.pct,
        };
        return {
          status: 403,
          body: {
            error: "already_submitted",
            auto: true,
            message: "Your time ran out — this attempt was auto-submitted. " +
              alreadySubmittedMessage(result.pct, p.created_at, n, now),
            result: { ...result, auto_submitted: true, submitted_at: new Date(now).toISOString() },
          },
        };
      }

      // Case 3: already submitted — 1 attempt per exam, no retakes.
      if (rec && rec.status === "done") {
        return {
          status: 403,
          body: {
            error: "already_submitted",
            message: alreadySubmittedMessage(rec.pct, p.created_at, n, now),
            score: rec.score,
            total: rec.total,
            pct: rec.pct,
          },
        };
      }

      // Case 4: one active attempt per account — another exam in progress
      // blocks starting this one. The buyer must resume or forfeit it first.
      for (const [key, other] of Object.entries(orderExams)) {
        if (key !== String(n) && other && other.status === "in_progress" &&
            now < other.started_at + EXAM_MS) {
          const m = Number(key);
          pendingLog = { type: "start_refused", reason: "active_attempt", order_id: p.order_id, exam: n, other_exam: m };
          return {
            status: 403,
            body: {
              error: "active_attempt",
              message: ACTIVE_ATTEMPT_MSG(m),
              exam: m,
              resume_remaining_ms: other.started_at + EXAM_MS - now,
            },
          };
        }
      }

      // Case 5: start fresh — the attempt is consumed NOW (at issuance).
      const qOrder = shuffleInPlace(items.map((it) => it.id));
      const optMap = {};
      for (const qid of qOrder) {
        const item = byId.get(qid);
        const origLetters = shuffleInPlace(Object.keys(item.options));
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, origLetters.length).split("");
        const m = {};
        letters.forEach((L, i) => (m[L] = origLetters[i]));
        optMap[qid] = m;
      }
      rec = {
        status: "in_progress",
        session_id: newId("sess-"),
        started_at: now,
        expires_at: now + EXAM_MS,
        bank_blob: bankSha, // pin the bank version for grading
        q_order: qOrder,
        opt_map: optMap,
        answers: {},
        last_sync: now,
      };
      orderExams[String(n)] = rec;
      pendingLog = { type: "start", order_id: p.order_id, exam: n, session_id: rec.session_id };
      return { status: 200, resumed: false, rec, remaining: EXAM_MS };
    }, `exam: questions ${p.order_id} exam${n}`);

    if (pendingLog) logEvent({ ...pendingLog, ip_hash: ipHash(req) });
    if (outcome.body) return res.status(outcome.status).json(outcome.body);

    const { rec, remaining, resumed } = outcome;
    // Resume must replay the SAME attempt record (shuffle mapping pinned at issuance).
    return res.status(200).json({
      exam: n,
      session_id: rec.session_id,
      questions: rec.q_order.map((qid) => publicQuestion(byId.get(qid), rec.opt_map[qid])),
      answers: sanitizeAnswers(rec.answers, new Set(rec.q_order)),
      server_remaining_ms: remaining,
      server_now: Date.now(),
      expires_at: rec.started_at + EXAM_MS,
      resumed: !!resumed,
    });
  } catch (e) {
    console.error("exam-questions error:", e.message);
    return res.status(500).json({ error: "server_error", message: "Please try again in a moment." });
  }
}
