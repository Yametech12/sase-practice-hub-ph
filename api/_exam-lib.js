/**
 * SASE Online Mock Exam Portal — shared server library (Vercel Node functions)
 *
 * SPEC v2: 5 weekly exams x 180 questions, 1 attempt per exam.
 * Exam N unlocks floor((now - created_at)/7d)+1 >= N (created_at = order date).
 *
 * Server-authoritative state lives in a PRIVATE GitHub repo (EXAM_STATE_REPO):
 *   state.json — { bindings, exams, used_submissions }
 *     bindings: { order_id: { device_hash, bound_at, ip_hash } }   (1 password = 1 device, strict)
 *     exams:    { order_id: { "1": examRec, ... } }
 *       examRec: { status: "in_progress"|"done", session_id, started_at, q_order,
 *                  opt_map, answers, last_sync, bank_blob }  (+ result fields when done:
 *                  score, total, pct, sections, weak_area, improvement, review,
 *                  submitted_at, auto_submitted, forfeited)
 *     used_submissions: { "<order_id>:<n>:<submission_id>": result }  (grade idempotency)
 *   bank.json  — { exams: { "1": [items...], ... "5": [items...] } } (never in the public site repo)
 *
 * Env vars (Vercel):
 *   EXAM_HMAC_SECRET — HMAC signing secret for session tokens
 *   GH_EXAM_TOKEN    — GitHub token with contents:read/write on EXAM_STATE_REPO
 *   EXAM_STATE_REPO  — "owner/repo" of the private state repo
 */
import crypto from "crypto";

export const EXAM_MS = 2 * 60 * 60 * 1000; // 2-hour practice timer (server-authoritative)
export const EXAM_COUNT = 5;
export const WEEK_MS = 7 * 24 * 3600 * 1000;

const GH_TOKEN = process.env.GH_EXAM_TOKEN || "";
const STATE_REPO = process.env.EXAM_STATE_REPO || "Yametech12/sase-exam-state";
const HMAC_SECRET = process.env.EXAM_HMAC_SECRET || "";

export function sha256(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}
export function deviceHash(id) {
  return sha256("device:" + String(id));
}
export function ipHash(req) {
  const fwd = req.headers["x-forwarded-for"] || "";
  const ip = String(fwd).split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  return sha256("ip:" + ip).slice(0, 16);
}
export function newId(prefix) {
  return prefix + crypto.randomBytes(8).toString("hex");
}
// 1-decimal percent, half-up. Clamp to [0,100] — a score must never exceed 100% or go negative.
export function pct1(correct, total) {
  if (!total || total <= 0) return 0;
  const v = Math.round((correct / total) * 1000) / 10;
  return Math.min(100, Math.max(0, v));
}

// ---- per-instance in-memory rate limiter (defense in depth; Vercel may run
//      many instances, so this is a throttle, not a hard guarantee) ----
const _buckets = new Map(); // key -> [timestamps]
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let arr = _buckets.get(key);
  if (!arr) {
    arr = [];
    _buckets.set(key, arr);
  }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= max) return false;
  arr.push(now);
  if (_buckets.size > 5000) _buckets.clear(); // crude memory guard
  return true;
}

// ---- weekly unlock schedule ----
export function parseCreatedAt(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}
// Week N (1-based) unlocks when floor((now-created)/7d)+1 >= N
export function examUnlock(createdAt, n, now = Date.now()) {
  const created = parseCreatedAt(createdAt);
  if (!created) return { unlocked: n === 1, unlocks_in_ms: 0, unlock_at: 0 };
  const unlockAt = created + (n - 1) * WEEK_MS;
  const unlocked = now >= unlockAt;
  return { unlocked, unlocks_in_ms: unlocked ? 0 : unlockAt - now, unlock_at: unlockAt };
}
// First still-locked exam after n (for "next exam unlocks in Y days" copy).
export function nextLockedExam(createdAt, n, now = Date.now()) {
  for (let m = n + 1; m <= EXAM_COUNT; m++) {
    const u = examUnlock(createdAt, m, now);
    if (!u.unlocked) return { n: m, unlocks_in_ms: u.unlocks_in_ms };
  }
  return null;
}

// ---- session tokens (HMAC-signed, no server lookup needed) ----
export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
export function verifyToken(tok) {
  try {
    if (!tok || typeof tok !== "string" || !HMAC_SECRET) return null;
    const parts = tok.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expect = crypto.createHmac("sha256", HMAC_SECRET).update(body).digest("base64url");
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expect, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!p.order_id || !p.device_hash || !p.created_at || !p.exp || Date.now() > p.exp) return null;
    return p;
  } catch {
    return null;
  }
}

// ---- private-repo state backend ----
async function gh(path, method = "GET", body = null) {
  const url =
    `https://api.github.com/repos/${STATE_REPO}/contents/${path}` +
    (method === "GET" ? "?ref=main" : "");
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`gh ${method} ${path}: ${r.status} ${t.slice(0, 120)}`);
  }
  return r.json();
}
// Fetch a file at an exact blob SHA (bank-version pinning: grading must use the
// bank snapshot the attempt started with, even if bank.json was redeployed since).
async function ghBlob(sha) {
  const r = await fetch(`https://api.github.com/repos/${STATE_REPO}/git/blobs/${sha}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) throw new Error(`gh blob ${sha}: ${r.status}`);
  const d = await r.json();
  return JSON.parse(Buffer.from(d.content, "base64").toString("utf8"));
}

export async function loadState() {
  const d = await gh("state.json");
  const state = JSON.parse(Buffer.from(d.content, "base64").toString("utf8"));
  state.bindings ||= {};
  state.exams ||= {};
  state.used_submissions ||= {};
  return { sha: d.sha, state };
}

export async function saveState(state, sha, message) {
  const content = Buffer.from(JSON.stringify(state), "utf8").toString("base64");
  const r = await gh("state.json", "PUT", { message, content, sha, branch: "main" });
  return r.content.sha;
}

// Read-modify-write with retry on SHA conflict. mutator(state) may be async;
// it must be free of externally visible side effects (it may run more than
// once — read-only GETs are fine, writes are not). It returns a result object
// that the caller uses AFTER the save succeeds.
export async function updateState(mutator, message) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    const { sha, state } = await loadState();
    const before = JSON.stringify(state);
    const result = await mutator(state);
    // Skip the write when the mutator changed nothing (e.g. pure resume
    // reads) — saves one slow GitHub round-trip per call. Behavior is
    // identical: a no-op write would have produced the same file content.
    if (JSON.stringify(state) === before) return result;
    try {
      await saveState(state, sha, message);
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Local-test hook: the stub-test harness sets globalThis.__EXAM_TEST_BANK to a
// synthetic bank so handlers can be exercised without touching the real bank.
let bankCache = null;
export async function loadBank() {
  if (globalThis.__EXAM_TEST_BANK) {
    return { sha: "test-bank", bank: globalThis.__EXAM_TEST_BANK };
  }
  if (bankCache && bankCache.bank?.exams && Object.keys(bankCache.bank.exams).length > 0) return bankCache;
  const d = await gh("bank.json");
  bankCache = { sha: d.sha, bank: JSON.parse(Buffer.from(d.content, "base64").toString("utf8")) };
  return bankCache;
}
export async function loadBankAtBlob(sha) {
  if (globalThis.__EXAM_TEST_BANK) return globalThis.__EXAM_TEST_BANK;
  if (sha === bankCache?.sha) return bankCache.bank;
  return ghBlob(sha);
}
export function getExamItems(bank, n) {
  const arr = bank && bank.exams && bank.exams[String(n)];
  return Array.isArray(arr) ? arr : [];
}

// ---- answer validation (G5): only A/B/C/D/E (or null) per known question id.
// Unknown qids are ignored (never inflate the denominator); malformed letters
// are dropped, never thrown.
export function sanitizeAnswers(answers, qOrderSet) {
  const out = {};
  if (!answers || typeof answers !== "object") return out;
  for (const [qid, letter] of Object.entries(answers)) {
    if (typeof qid !== "string" || !qOrderSet.has(qid)) continue;
    if (typeof letter !== "string" || !/^[A-E]$/.test(letter)) continue;
    out[qid] = letter;
  }
  return out;
}

// ---- misc ----
export function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function readBody(req) {
  let raw = "";
  await new Promise((resolve) => {
    req.on("data", (c) => (raw += c));
    req.on("end", resolve);
  });
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function logEvent(evt) {
  try {
    console.log(JSON.stringify({ exam_event: true, ts: new Date().toISOString(), ...evt }));
  } catch {
    /* logging must never break the request */
  }
}

export function validExamN(n) {
  const x = Number(n);
  return Number.isInteger(x) && x >= 1 && x <= EXAM_COUNT ? x : 0;
}

// ---- grading core (shared by exam-grade.js, exam-forfeit.js, and the
//      expiry auto-grade path in exam-questions.js) ----

// "How to improve" per section — actionable + tied to reviewer chapters.
const IMPROVEMENT_GUIDE = {
  "Language Usage": {
    chapters: "Parts I & V of your reviewer (vocabulary, grammar, reading)",
    tips: [
      "Read every explanation for vocabulary items — even ones you got right. The synonyms repeat across exams.",
      "For error-identification, read the sentence aloud in your head; your ear catches what your eye skips.",
      "Do one timed 20-item drill daily. Speed matters as much as accuracy here.",
    ],
  },
  Mathematics: {
    chapters: "Parts II & VI of your reviewer (word problems, algebra, geometry)",
    tips: [
      "Redo every missed word problem from scratch on paper — don't just re-read the solution.",
      "Memorize the 10 most-used formulas (percent, ratio, area, speed) until they're reflex.",
      "Skip-and-return: bank 40 seconds per item, circle the hard ones, finish easy ones first.",
    ],
  },
  Aptitude: {
    chapters: "Parts III & VII of your reviewer (series, patterns, analogies)",
    tips: [
      "This section is pure speed — aim for ~20 seconds per item. Drill series daily until the patterns pop.",
      "For number series, always test differences first, then ratios, then alternating patterns.",
      "Analogies: state the relationship in one sentence before looking at the choices.",
    ],
  },
  Science: {
    chapters: "Parts IV & VIII of your reviewer (biology, earth science, chemistry, physics)",
    tips: [
      "Focus on concepts, not memorization — most items test understanding of processes.",
      "Draw quick diagrams for biology and physics items; visualizing beats re-reading.",
      "Review the scientific-method items — they're free points once the steps are clear.",
    ],
  },
};
// Bank section labels may vary ("English" vs "Language Usage"); normalize for the
// improvement-guide lookup. Unknown sections keep their label (no guide).
const SECTION_ALIASES = {
  english: "Language Usage",
  language: "Language Usage",
  "language usage": "Language Usage",
  math: "Mathematics",
  mathematics: "Mathematics",
  science: "Science",
  aptitude: "Aptitude",
};
export function canonicalSection(s) {
  const k = String(s || "").trim().toLowerCase();
  return SECTION_ALIASES[k] || String(s || "General");
}

// Grade an attempt. `items` = bank items for this exam (pinned version),
// `rec` = attempt record (q_order, opt_map), `finalAnswers` = sanitized
// { qid: displayLetter }. Review shows options in the DISPLAY order the buyer
// saw them; your_answer/correct_answer are display letters.
export function buildResult(items, rec, finalAnswers) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const sections = {};
  const review = [];
  let score = 0;
  let unanswered = 0;
  for (let pos = 0; pos < rec.q_order.length; pos++) {
    const qid = rec.q_order[pos];
    const item = byId.get(qid);
    if (!item) continue;
    const disp = finalAnswers[qid]; // display letter (what the buyer tapped)
    const map = rec.opt_map[qid] || {};
    const orig = disp ? map[disp] : null; // canonical letter
    const correct = orig === item.answer;
    if (correct) score++;
    if (!disp) unanswered++;
    const secName = canonicalSection(item.section);
    const s = (sections[secName] ||= { correct: 0, total: 0 });
    s.total++;
    if (correct) s.correct++;
    // Options in display order (A,B,C,D as the buyer saw them).
    const displayOptions = {};
    let correctDisplay = null;
    for (const L of Object.keys(map).sort()) {
      displayOptions[L] = item.options[map[L]];
      if (map[L] === item.answer) correctDisplay = L;
    }
    review.push({
      id: item.id,
      section: item.section,
      // number = POSITION in this attempt's question order (1-180), the
      // same "Question N" the buyer saw during the exam. NOT item_number:
      // that is a global pool id (1-450, e.g. MAT-001 -> 45), which would
      // show as "Question 251 of 180" and confuse buyers. item_number is
      // still sent for traceability; the client renders `number` only.
      number: pos + 1,
      item_number: item.item_number ?? null,
      question: item.question,
      passage: item.passage || null,
      options: displayOptions,
      your_answer: disp || null,
      correct_answer: correctDisplay,
      explanation: item.explanation || "",
      was_correct: correct,
      skipped: !disp,
    });
  }
  const total = rec.q_order.length;
  const pct = pct1(score, total);
  for (const k of Object.keys(sections)) {
    sections[k].pct = pct1(sections[k].correct, sections[k].total);
  }
  let weakSection = null;
  let weakPct = 101;
  for (const [name, s] of Object.entries(sections)) {
    if (s.pct < weakPct) {
      weakPct = s.pct;
      weakSection = name;
    }
  }
  const guide = weakSection && IMPROVEMENT_GUIDE[weakSection] ? IMPROVEMENT_GUIDE[weakSection] : null;
  return {
    score,
    total,
    pct,
    unanswered,
    sections,
    weak_area: weakSection != null ? `Your weakest section is ${weakSection} (${weakPct}%).` : "",
    improvement: guide ? { section: weakSection, chapters: guide.chapters, tips: guide.tips } : null,
    review,
  };
}

// ---- user-facing copy (exact strings required by the copy audit) ----
export const MAX_DEVICES_PER_PASSWORD = 3;

/** Normalize a binding record to its device list. Handles the legacy
 *  single-device shape {device_hash,...} and the current {devices:[...]}. */
export function bindingDevices(b) {
  if (!b) return [];
  if (Array.isArray(b.devices)) return b.devices;
  if (b.device_hash) return [{ device_hash: b.device_hash, bound_at: b.bound_at || "", ip_hash: b.ip_hash || "" }];
  return [];
}

export function bindingHasDevice(b, dh) {
  return bindingDevices(b).some((x) => x && x.device_hash === dh);
}

export const DEVICE_MISMATCH_MSG =
  "This password is already used on 3 devices — the maximum allowed. If you changed phones, message SASE Practice Hub PH and we'll reset it for you.";
export const EXAM_LOCKED_MSG =
  "This exam is not unlocked yet. New exams release every 7 days from your purchase date.";
// Copy-audit Fix 2: done-exam re-entry message with the buyer's score + next unlock.
export function alreadySubmittedMessage(pct, createdAt, n, now = Date.now()) {
  const next = nextLockedExam(createdAt, n, now);
  const pctStr = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  if (next) {
    const days = Math.max(1, Math.ceil(next.unlocks_in_ms / (24 * 3600 * 1000)));
    return `You've already completed this exam with a score of ${pctStr}%. Your next exam unlocks in ${days} day${days === 1 ? "" : "s"} — use the time to review the weak areas in your results.`;
  }
  return `You've already completed this exam with a score of ${pctStr}%. You've finished all 5 exams — use your results to review the weak areas.`;
}
export const ACTIVE_ATTEMPT_MSG = (m) =>
  `You have Mock Exam ${m} in progress — finish it or give it up before starting another exam.`;
