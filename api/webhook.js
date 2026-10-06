/**
 * SASE Practice Hub PH — Facebook Page Webhook (Vercel Serverless)
 *
 * GET  /api/webhook — Meta verification handshake
 * POST /api/webhook — receive Page feed/comment events, auto-reply with quiz answers
 *
 * Env vars (Vercel):
 *   FB_VERIFY_TOKEN  — must match the Verify Token entered in Meta App Dashboard
 *   FB_APP_SECRET    — Meta App Secret (for X-Hub-Signature-256 verification)
 *   FB_PAGE_TOKEN    — long-lived Page Access Token (pages_manage_engagement)
 *   FB_PAGE_ID       — 1335770806292993
 *
 * quiz-answers.json sits next to this file: { postFbid: { answer, meaning, question } }
 */

import crypto from "crypto";
import answers from "../quiz-answers.json" with { type: "json" };

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const APP_SECRET = process.env.FB_APP_SECRET;
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const PAGE_ID = process.env.FB_PAGE_ID || "1335770806292993";
const SITE_URL = "https://sase-practice-hub-ph.vercel.app";

const replied = new Set();
const userReplyCount = new Map();
const MAX_REPLIES_PER_HOUR = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const userLastText = new Map();

const SPAM_PATTERNS = [
  /https?:\/\//i,
  /www\./i,
  /\.com|\.net|\.org|\.ph/i,
  /free\s*(money|cash|gcash|load)/i,
  /click\s*here/i,
  /pm\s*me/i,
  /dm\s*me/i,
  /whatsapp/i,
  /telegram/i,
  /crypto|bitcoin|forex|trading/i,
  /loan|utang|5-6/i,
  /sex|porn|xxx/i,
  /follow\s*me/i,
  /like\s*for\s*like/i,
];

function isSpam(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length === 0 || t.length > 200) return true;
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(t)) return true;
  }
  const emojiCount = (t.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  if (emojiCount > 5) return true;
  if (t.length > 10) {
    const caps = (t.match(/[A-Z]/g) || []).length;
    const letters = (t.match(/[a-zA-Z]/g) || []).length;
    if (letters > 0 && caps / letters > 0.8) return true;
  }
  if (/(.)\1{5,}/.test(t)) return true;
  return false;
}

function checkRateLimit(userId) {
  const now = Date.now();
  const record = userReplyCount.get(userId);
  if (!record || now - record.windowStart > RATE_WINDOW_MS) {
    userReplyCount.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= MAX_REPLIES_PER_HOUR) return false;
  record.count++;
  return true;
}

function isDuplicate(userId, text) {
  const now = Date.now();
  const last = userLastText.get(userId);
  if (last && last.text === text.trim().toLowerCase() && now - last.timestamp < 5 * 60 * 1000) return true;
  userLastText.set(userId, { text: text.trim().toLowerCase(), timestamp: now });
  return false;
}

function verifySignature(rawBody, signature) {
  if (!APP_SECRET || !signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function findAnswer(postFbid) {
  if (answers[postFbid]) return answers[postFbid];
  const short = String(postFbid).split("_").pop();
  if (answers[short]) return answers[short];
  for (const [k, v] of Object.entries(answers)) {
    if (k.endsWith(short) || short.endsWith(k)) return v;
  }
  return null;
}

function buildReply(entry, commenterName, userAnswer) {
  const name = commenterName ? ` ${commenterName.split(" ")[0]}` : "";
  const correctAnswer = (entry.answer || "").toUpperCase().trim();
  const userLetter = (userAnswer || "").toUpperCase().trim();
  if (userLetter && correctAnswer) {
    if (userLetter === correctAnswer) {
      return `Correct! 🎉 "${entry.meaning}" — great job${name}!\nMore quizzes here: ${SITE_URL}`;
    } else {
      return `Good try${name}! 💪 The correct answer is ${correctAnswer} ("${entry.meaning}"). You're learning — keep going!\nMore quizzes here: ${SITE_URL}`;
    }
  }
  return `Nice attempt${name}! The correct answer is ${correctAnswer} ("${entry.meaning}"). Keep practicing! 🌟\nMore quizzes here: ${SITE_URL}`;
}

function extractAnswerLetter(text, entry) {
  const t = (text || "").trim();
  // M-3 FIX: Early return for empty input (prevents "" matching via meaning check)
  if (!t) return null;
  // Pattern 1: Just the letter (A, B, C, D) with optional punctuation
  let m = t.match(/^([a-dA-D])[\s.)]*$/);
  if (m) return m[1].toUpperCase();

  // Pattern 2: "My answer is C", "Answer: B", "I think the answer is A", etc.
  // C-3 FIX: Removed bare "it's|its" alternative which caused false positives
  // like "its a good question" → "A". Require explicit "answer" keyword.
  m = t.match(/(?:my\s+)?answer\s*(?:is|:)\s*([a-dA-D])\b/i);
  if (m) return m[1].toUpperCase();

  // Pattern 3: Letter in parentheses like "(C)" or "[B]"
  m = t.match(/[\(\[]([a-dA-D])[\)\]]/);
  if (m) return m[1].toUpperCase();

  // Pattern 4: Check if they typed the option text (e.g., "run-down" instead of "D")
  // We need the options - try to match against meaning
  // STRICT: Require exact match or meaning as standalone phrase (min 4 chars)
  // to avoid false positives from short fragments
  if (entry && entry.meaning) {
    const meaningLower = entry.meaning.toLowerCase().trim();
    const textLower = t.toLowerCase().trim();
    if (meaningLower.length >= 4 && textLower.length >= 4) {
      // Exact match or meaning appears as a complete phrase in the text
      const meaningWords = meaningLower.split(/\s+/);
      const textWords = textLower.split(/\s+/);
      const isExact = textLower === meaningLower;
      const containsPhrase = textLower.includes(meaningLower) && meaningWords.length >= 2;
      const allWordsPresent = meaningWords.length >= 2 && meaningWords.every(w => textWords.includes(w));
      if (isExact || containsPhrase || allWordsPresent) {
        return entry.answer ? entry.answer.toUpperCase() : null;
      }
    }
  }

  return null;
}

async function replyToComment(commentId, message) {
  const url = `https://graph.facebook.com/v21.0/${commentId}/comments?message=${encodeURIComponent(message)}&access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  return { ok: !data.error, data };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    // M-4 FIX: Fail closed if VERIFY_TOKEN is not configured
    // (prevents undefined === undefined bypass)
    if (!VERIFY_TOKEN) {
      console.error("FB_VERIFY_TOKEN not configured");
      return res.status(500).send("webhook not configured");
    }
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Verification failed");
  }
  if (req.method === "POST") {
    let raw = "";
    await new Promise((resolve) => { req.on("data", (c) => (raw += c)); req.on("end", resolve); });
    const sig = req.headers["x-hub-signature-256"];
    if (!verifySignature(raw, sig)) { console.warn("Bad signature — ignoring"); return res.status(200).send("ignored"); }
    let body;
    try { body = JSON.parse(raw); } catch { return res.status(200).send("bad json"); }
    if (body.object !== "page") return res.status(200).send("not a page event");
    for (const entry of body.entry || []) {
      if (String(entry.id) !== String(PAGE_ID)) continue;
      for (const change of entry.changes || []) {
        if (change.field !== "feed") continue;
        const v = change.value || {};
        if (v.item !== "comment" || v.verb !== "add") continue;
        if (String(v.from?.id) === String(PAGE_ID)) continue;
        const commentId = v.comment_id;
        const postFbid = v.post_id;
        const userId = String(v.from?.id || "unknown");
        if (!commentId || replied.has(commentId)) continue;
        const text = (v.message || "").trim();
        if (isSpam(text)) { console.log("Spam blocked:", commentId); replied.add(commentId); continue; }
        if (isDuplicate(userId, text)) { console.log("Duplicate blocked:", commentId); replied.add(commentId); continue; }
        const entry_ = findAnswer(postFbid);
        if (!entry_) { console.log("No answer for post", postFbid); continue; }
        // C-1 FIX: Removed overly permissive "text.length < 30" clause.
        // Now requires either a valid extracted letter OR a meaning match.
        // This prevents replying "Good try!" to "hello", "thanks!", "how to avail?", etc.
        const userLetter = extractAnswerLetter(text, entry_);
        const meaningMatch = entry_.meaning && text.toLowerCase().includes(entry_.meaning.toLowerCase()) && entry_.meaning.length >= 4;
        const looksLikeAnswer = userLetter !== null || meaningMatch;
        if (!looksLikeAnswer) continue;
        // M-6 FIX: Rate limiting moved AFTER answer validation,
        // so non-answer comments don't consume the user's quota.
        // M-2 FIX: Skip rate limiting for unknown IDs to avoid shared bucket unfairness.
        if (userId !== "unknown" && !checkRateLimit(userId)) { console.log("Rate limited:", userId); replied.add(commentId); continue; }
        const reply = buildReply(entry_, v.from?.name, userLetter);
        const result = await replyToComment(commentId, reply);
        if (result.ok) { replied.add(commentId); console.log("Replied to", commentId); }
        else { console.error("Reply failed", JSON.stringify(result.data)); }
      }
    }
    return res.status(200).send("EVENT_RECEIVED");
  }
  return res.status(405).send("Method not allowed");
}
