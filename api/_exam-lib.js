/**
 * SASE Online Mock Exam Portal — shared server library (Vercel Node functions)
 *
 * SPEC v2: 5 weekly exams x 180 questions, 1 attempt per exam.
 * Exam N unlocks floor((now - created_at)/7d)+1 >= N (created_at = order date).
 *
 * Server-authoritative state lives in a PRIVATE GitHub repo (EXAM_STATE_REPO):
 *   state.json — { bindings, exams, used_submissions }
 *     bindings: { order_id: { devices: [{ device_hash, bound_at, ip_hash }] } } (1 password = up to 3 devices)
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
  // Trust order: Vercel's x-real-ip (set by the platform, not the client) >
  // LAST X-Forwarded-For entry (closest trusted proxy) > socket address.
  // NEVER the first XFF entry: it is attacker-controlled (client can prepend
  // arbitrary values; Vercel appends the real IP after them).
  const real = String(req.headers["x-real-ip"] || "").trim();
  const fwd = String(req.headers["x-forwarded-for"] || "");
  const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
  const ip = real || parts[parts.length - 1] || req.socket?.remoteAddress || "unknown";
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
    // Evict only buckets fully idle for >1h — beyond every window in use
    // (max 10 min), so no caller's live entries are ever touched.
    // If the map is still full, REFUSE the new bucket (429) rather than
    // evicting a live one: a flood must never unblock an existing limit.
    for (const [k, v] of _buckets) {
      if (v.length === 0 || v[v.length - 1] <= now - 3600000) _buckets.delete(k);
    }
    if (_buckets.size >= 5000) return false;
    arr = [];
    _buckets.set(key, arr);
  }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= max) return false;
  arr.push(now);
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
  if (!created) return { unlocked: n === 1, unlocks_in_ms: null, unlock_at: null };
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
  // GitHub's contents API returns EMPTY content for files > 1MB, and
  // state.json is ~1.17MB — JSON.parse("") throws, so every login that
  // reaches device binding 500s with "Please try again in a moment."
  // The contents response still carries the blob sha, so fetch metadata
  // here and the full content via the blob API (no 1MB content limit).
  const meta = await gh("state.json");
  const state = await ghBlob(meta.sha);
  state.bindings ||= {};
  state.exams ||= {};
  state.used_submissions ||= {};
  return { sha: meta.sha, state };
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
    try {
      const { sha, state } = await loadState(); // load retries now, like saves
      const before = JSON.stringify(state);
      const result = await mutator(state);
      if (JSON.stringify(state) === before) return result;
      await saveState(state, sha, message);
      return result;
    } catch (e) {
      lastErr = e;
      // Small backoff before retry (load blip or SHA conflict). Mutators must
      // stay side-effect-free (read-only GETs only) because they may re-run.
      if (i < 2) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw lastErr;
}

// Local-test hook: the stub-test harness sets globalThis.__EXAM_TEST_BANK to a
// synthetic bank so handlers can be exercised without touching the real bank.
let bankCache = null;
const BANK_CACHE_TTL_MS = 60_000;
export async function loadBank() {
  if (globalThis.__EXAM_TEST_BANK) {
    return { sha: "test-bank", bank: globalThis.__EXAM_TEST_BANK };
  }
  const fresh = bankCache && bankCache.bank?.exams && Object.keys(bankCache.bank.exams).length > 0
    && Date.now() - (bankCache.cachedAt || 0) < BANK_CACHE_TTL_MS;
  if (fresh) return bankCache;
  // Same 1MB contents-API trap as loadState: bank.json is ~0.49MB today
  // but will cross 1MB as questions are added. Read via the blob API now.
  const meta = await gh("bank.json");
  const bank = await ghBlob(meta.sha);
  bankCache = { sha: meta.sha, bank, cachedAt: Date.now() };
  return bankCache;
}
export async function loadBankAtBlob(sha) {
  if (globalThis.__EXAM_TEST_BANK) return globalThis.__EXAM_TEST_BANK;
  if (!sha) {
    // Legacy attempt without a pinned blob: fall back to the current bank
    // rather than 500ing.
    const { bank } = await loadBank();
    return bank;
  }
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

const MAX_BODY_BYTES = 256 * 1024; // largest legit body is a 180-answer sync, ~2 KB
const BODY_TIMEOUT_MS = 15_000;
export async function readBody(req, { maxBytes = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS } = {}) {
  let raw = "";
  let bytes = 0;
  let settled = false;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* already closed */ }
      resolve(); // fail-closed: downstream JSON.parse("{}") -> validation 400s
    }, timeoutMs);
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    req.on("data", (c) => {
      const chunk = typeof c === "string" ? Buffer.byteLength(c) : c.length;
      bytes += chunk;
      if (bytes > maxBytes) {
        try { req.destroy(); } catch { /* already closed */ }
        raw = ""; // discard oversize body -> fail-closed to {}
        done();
        return;
      }
      raw += c;
    });
    req.on("end", done);
    req.on("error", done); // stream error must resolve, never hang
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
  if (typeof n === "boolean" || n === null || typeof n === "object") return 0;
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
  const total = review.length;
  const pct = pct1(score, total);
  for (const k of Object.keys(sections)) {
    sections[k].pct = pct1(sections[k].correct, sections[k].total);
  }
  // Fixed tie-break order: identical section scores always pick the same section.
  const SECTION_ORDER = ["Language Usage", "Mathematics", "Aptitude", "Science"];
  const orderedNames = [
    ...SECTION_ORDER.filter((n) => sections[n]),
    ...Object.keys(sections).filter((n) => !SECTION_ORDER.includes(n)),
  ];
  let weakSection = null;
  let weakPct = 101;
  for (const name of orderedNames) {
    const s = sections[name];
    if (s.pct < weakPct) {
      weakPct = s.pct;
      weakSection = name;
    }
  }
  // No "weakest section" when every section clears the bar: a 100% paper has
  // no weak area, and a >=70% paper gets the all-clear message client-side.
  const hasWeak = weakSection != null && weakPct < 70;
  const guide = hasWeak && IMPROVEMENT_GUIDE[weakSection] ? IMPROVEMENT_GUIDE[weakSection] : null;
  return {
    score,
    total,
    pct,
    unanswered,
    sections,
    weak_area: hasWeak ? `Your weakest section is ${weakSection} (${weakPct}%).` : "",
    improvement: guide ? { section: weakSection, chapters: guide.chapters, tips: guide.tips } : null,
    review,
  };
}

// ---- user-facing copy (exact strings required by the copy audit) ----
export const MAX_DEVICES_PER_PASSWORD = 3;

/** Normalize a binding record to its device list. Handles the legacy
 *  single-device shape {device_hash,...} and the current {devices:[...]}. */
// ---- idempotent grade replies ----

// Idempotent-reply resolver: used_submissions stores a POINTER, not a second
// copy of the 180-item review. Old entries (with an embedded review) keep
// working: if entry.review exists, use it; otherwise resolve via the exams rec.
export function resolveSubmission(state, idemKey) {
  const entry = state.used_submissions?.[idemKey];
  if (!entry) return null;
  if (entry.review) return { ...entry, idempotent: true };
  const [orderId, nStr] = idemKey.split(":");
  const rec = state.exams?.[orderId]?.[nStr];
  if (!rec || rec.status !== "done") return null;
  return {
    score: rec.score, total: rec.total, pct: rec.pct,
    sections: rec.sections, weak_area: rec.weak_area,
    improvement: rec.improvement, review: rec.review || [],
    submitted_at: rec.submitted_at ?? entry.submitted_at,
    auto_submitted: !!rec.auto_submitted, forfeited: !!rec.forfeited,
    server_now: entry.server_now ?? null,
    idempotent: true,
  };
}

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
    if (next.unlocks_in_ms == null) {
      return `You've already completed this exam with a score of ${pctStr}%. Your next exam unlocks soon — use the time to review the weak areas in your results.`;
    }
    const days = Math.max(1, Math.ceil(next.unlocks_in_ms / (24 * 3600 * 1000)));
    return `You've already completed this exam with a score of ${pctStr}%. Your next exam unlocks in ${days} day${days === 1 ? "" : "s"} — use the time to review the weak areas in your results.`;
  }
  return `You've already completed this exam with a score of ${pctStr}%. You've finished all 5 exams — use your results to review the weak areas.`;
}
export const ACTIVE_ATTEMPT_MSG = (m) =>
  `You have Mock Exam ${m} in progress — finish it or give it up before starting another exam.`;
