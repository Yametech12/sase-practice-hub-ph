/**
 * POST /api/exam-test-reset - TEMPORARY one-time maintenance endpoint.
 *
 * Purpose: clear the device bindings of the two TEST orders only
 * (SASE-TST001, CSE-TST001) in the Neon `bindings` table, so fresh-device
 * QA logins can be verified after earlier smoke tests filled all 3 device
 * slots. Mirrors the pattern of the deleted one-time migration endpoint
 * (api/exam-migrate.js): it runs server-side inside Vercel, where
 * DATABASE_URL already lives, so the connection string never leaves Vercel.
 * DELETE this file and redeploy immediately after use.
 *
 * Guards (all must pass or nothing runs):
 *  - POST only.
 *  - Header `x-reset-secret` must equal process.env.TEST_RESET_SECRET
 *    (timing-safe compare). Fail closed: if the env var is unset, 503.
 *  - In-memory rate limit: max 10 attempts per 10 minutes per warm instance.
 *  - Scope is hard-coded: the ONLY order ids this file can read or delete
 *    are SASE-TST001 and CSE-TST001. No other order can be named by the
 *    caller; the request body only selects the action.
 *  - Returns COUNTS ONLY (binding counts before/after). Never returns
 *    device hashes, tokens, or any other order's data.
 */
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const TEST_ORDER_IDS = ["SASE-TST001", "CSE-TST001"];

const attempts = [];
function rateLimited() {
  const now = Date.now();
  while (attempts.length && attempts[0] <= now - 600000) attempts.shift();
  if (attempts.length >= 10) return true;
  attempts.push(now);
  return false;
}

function secretOk(provided) {
  const expected = process.env.TEST_RESET_SECRET || "";
  if (!expected) return false;
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) break;
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function bindingCounts(sql) {
  const rows = await sql`
    SELECT order_id, devices FROM bindings
    WHERE order_id IN (${TEST_ORDER_IDS[0]}, ${TEST_ORDER_IDS[1]})
  `;
  const counts = {};
  for (const id of TEST_ORDER_IDS) counts[id] = 0;
  for (const r of rows) {
    const devices = Array.isArray(r.devices) ? r.devices : [];
    counts[r.order_id] = devices.length;
  }
  return counts;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (rateLimited()) return res.status(429).json({ error: "rate_limited" });
  if (!process.env.TEST_RESET_SECRET) return res.status(503).json({ error: "not_configured" });
  if (!secretOk(req.headers["x-reset-secret"])) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) return res.status(503).json({ error: "not_configured" });
  try {
    const { action } = await readBody(req);
    const sql = neon(databaseUrl);
    if (action === "inspect") {
      const counts = await bindingCounts(sql);
      return res.status(200).json({ ok: true, action, counts });
    }
    if (action === "reset") {
      const before = await bindingCounts(sql);
      await sql`
        DELETE FROM bindings
        WHERE order_id IN (${TEST_ORDER_IDS[0]}, ${TEST_ORDER_IDS[1]})
      `;
      const after = await bindingCounts(sql);
      return res.status(200).json({ ok: true, action, before, after });
    }
    return res.status(400).json({ error: "bad_action" });
  } catch {
    return res.status(500).json({ error: "server_error" });
  }
}
