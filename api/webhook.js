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

// Track replied comment IDs in-memory (best-effort; Vercel may cold-start).
// The 3-min polling worker remains the dedupe authority until webhooks are proven.
const replied = new Set();

function verifySignature(rawBody, signature) {
  if (!APP_SECRET || !signature) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  // timing-safe compare
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function findAnswer(postFbid) {
  // Direct hit
  if (answers[postFbid]) return answers[postFbid];
  // pfbid vs numeric: try stripping page prefix "PAGEID_"
  const short = String(postFbid).split("_").pop();
  if (answers[short]) return answers[short];
  for (const [k, v] of Object.entries(answers)) {
    if (k.endsWith(short) || short.endsWith(k)) return v;
  }
  return null;
}

function buildReply(entry, commenterName) {
  const name = commenterName ? ` ${commenterName.split(" ")[0]}` : "";
  return (
    `Correct! 🎉 "${entry.meaning}" — great job${name}!\n` +
    `More quizzes here: ${SITE_URL}`
  );
}

async function replyToComment(commentId, message) {
  const url =
    `https://graph.facebook.com/v21.0/${commentId}/comments` +
    `?message=${encodeURIComponent(message)}&access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  return { ok: !data.error, data };
}

export default async function handler(req, res) {
  // --- Verification handshake ---
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
  }

  // --- Event delivery ---
  if (req.method === "POST") {
    // IMPORTANT: verify against the RAW body, not re-serialized JSON.
    // Vercel Node functions: read raw via a manual buffer.
    let raw = "";
    await new Promise((resolve) => {
      req.on("data", (c) => (raw += c));
      req.on("end", resolve);
    });

    const sig = req.headers["x-hub-signature-256"];
    if (!verifySignature(raw, sig)) {
      console.warn("Bad signature — ignoring");
      return res.status(200).send("ignored");
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return res.status(200).send("bad json");
    }

    if (body.object !== "page") return res.status(200).send("not a page event");

    for (const entry of body.entry || []) {
      if (String(entry.id) !== String(PAGE_ID)) continue;
      for (const change of entry.changes || []) {
        if (change.field !== "feed") continue;
        const v = change.value || {};
        // Only handle new top-level comments (not the Page's own, not edits)
        if (v.item !== "comment" || v.verb !== "add") continue;
        if (String(v.from?.id) === String(PAGE_ID)) continue; // our own reply

        const commentId = v.comment_id;
        const postFbid = v.post_id; // "PAGEID_POSTID" or pfbid
        if (!commentId || replied.has(commentId)) continue;

        const entry_ = findAnswer(postFbid);
        if (!entry_) {
          console.log("No answer for post", postFbid);
          continue;
        }

        const text = (v.message || "").trim();
        // Only reply when the comment looks like a quiz answer attempt
        // (single letter A-D, or contains the answer word). Keeps noise down.
        const looksLikeAnswer =
          /^[a-dA-D][.)]?\s*$/.test(text) ||
          text.toLowerCase().includes(entry_.meaning.toLowerCase()) ||
          text.length < 30;
        if (!looksLikeAnswer) continue;

        const reply = buildReply(entry_, v.from?.name);
        const result = await replyToComment(commentId, reply);
        if (result.ok) {
          replied.add(commentId);
          console.log("Replied to", commentId);
        } else {
          console.error("Reply failed", JSON.stringify(result.data));
        }
      }
    }
    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(405).send("Method not allowed");
}
