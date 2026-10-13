/**
 * POST /api/exam-migrate — ONE-TIME migration: GitHub state.json -> Neon tables.
 *
 * TEMPORARY. Delete this file + redeploy immediately after a successful
 * migration. It exists only to run the import server-side inside Vercel,
 * where DATABASE_URL + GH_EXAM_TOKEN already live as env vars — the
 * connection string never leaves Vercel and never appears in any report.
 *
 * Guards (all must pass or nothing runs):
 *  - POST only.
 *  - Header `x-migrate-secret` must equal process.env.MIGRATION_SECRET
 *    (timing-safe compare). Fail closed: if MIGRATION_SECRET is unset,
 *    the endpoint refuses with 503.
 *  - Single-use: if ANY of the three tables already has rows, refuse with
 *    409 already_migrated (no upserts). Re-running after go-live would
 *    overwrite newer Neon rows with stale GitHub values — never do that.
 *  - In-memory rate limit: max 5 attempts per 10 minutes per warm instance.
 *  - READ-ONLY against GitHub: fetches state.json via contents -> blob and
 *    NEVER writes to the state repo.
 *  - One Serializable transaction (all-or-nothing): schema + upserts.
 *  - Returns COUNTS ONLY. Never logs or returns secrets, tokens, or row
 *    contents. Errors return a generic message.
 *
 * Mirrors scripts/migrate-github-to-neon.mjs (same fetch path, same
 * normalizeDevices rule, same upserts). Legacy `attempts` / `in_progress`
 * keys are NOT migrated (no handler reads them).
 */
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const STATE_REPO = process.env.EXAM_STATE_REPO || "Yametech12/sase-exam-state";

const SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS bindings (
    order_id TEXT PRIMARY KEY,
    devices JSONB NOT NULL DEFAULT '[]'::jsonb
  )`,
  `CREATE TABLE IF NOT EXISTS exams (
    order_id TEXT NOT NULL,
    exam_n INT NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (order_id, exam_n)
  )`,
  `CREATE TABLE IF NOT EXISTS used_submissions (
    key TEXT PRIMARY KEY,
    result JSONB NOT NULL
  )`,
];

const attempts = [];
function rateLimited() {
  const now = Date.now();
  while (attempts.length && attempts[0] <= now - 600000) attempts.shift();
  if (attempts.length >= 5) return true;
  attempts.push(now);
  return false;
}

function secretOk(provided) {
  const expected = process.env.MIGRATION_SECRET || "";
  if (!expected) return false;
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function fetchStateJson(ghToken) {
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const metaRes = await fetch(
    `https://api.github.com/repos/${STATE_REPO}/contents/state.json?ref=main`,
    { headers },
  );
  if (!metaRes.ok) throw new Error("github_contents_failed");
  const meta = await metaRes.json();
  const blobRes = await fetch(
    `https://api.github.com/repos/${STATE_REPO}/git/blobs/${meta.sha}`,
    { headers },
  );
  if (!blobRes.ok) throw new Error("github_blob_failed");
  const blob = await blobRes.json();
  return JSON.parse(Buffer.from(blob.content, "base64").toString("utf8"));
}

function normalizeDevices(b) {
  if (!b) return [];
  if (Array.isArray(b.devices)) return b.devices;
  if (b.device_hash) {
    return [{ device_hash: b.device_hash, bound_at: b.bound_at || "", ip_hash: b.ip_hash || "" }];
  }
  return [];
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (!process.env.MIGRATION_SECRET) {
      return res.status(503).json({ error: "migration_not_configured" });
    }
    if (!secretOk(req.headers["x-migrate-secret"])) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (rateLimited()) return res.status(429).json({ error: "rate_limited" });
    if (!process.env.DATABASE_URL || !process.env.GH_EXAM_TOKEN) {
      return res.status(503).json({ error: "migration_not_configured" });
    }

    const sql = neon(process.env.DATABASE_URL);
    const state = await fetchStateJson(process.env.GH_EXAM_TOKEN);
    const bindings = state.bindings || {};
    const exams = state.exams || {};
    const used = state.used_submissions || {};
    const source = {
      bindings: Object.keys(bindings).length,
      exams: Object.values(exams).reduce((n, o) => n + Object.keys(o || {}).length, 0),
      used_submissions: Object.keys(used).length,
    };

    for (const stmt of SCHEMA_STMTS) await sql.query(stmt);
    const existing = await sql`
      SELECT (SELECT count(*) FROM bindings) AS bindings,
             (SELECT count(*) FROM exams) AS exams,
             (SELECT count(*) FROM used_submissions) AS used_submissions`;
    const counts = {
      bindings: Number(existing[0].bindings),
      exams: Number(existing[0].exams),
      used_submissions: Number(existing[0].used_submissions),
    };
    if (counts.bindings > 0 || counts.exams > 0 || counts.used_submissions > 0) {
      return res.status(409).json({ error: "already_migrated", counts });
    }

    const queries = [];
    for (const [orderId, b] of Object.entries(bindings)) {
      const devices = normalizeDevices(b);
      queries.push(
        sql`INSERT INTO bindings (order_id, devices) VALUES (${orderId}, ${JSON.stringify(devices)}::jsonb)
            ON CONFLICT (order_id) DO UPDATE SET devices = EXCLUDED.devices`,
      );
    }
    for (const [orderId, orderExams] of Object.entries(exams)) {
      for (const [nStr, rec] of Object.entries(orderExams || {})) {
        const n = Number(nStr);
        if (!Number.isInteger(n)) continue;
        queries.push(
          sql`INSERT INTO exams (order_id, exam_n, data) VALUES (${orderId}, ${n}, ${JSON.stringify(rec)}::jsonb)
              ON CONFLICT (order_id, exam_n) DO UPDATE SET data = EXCLUDED.data`,
        );
      }
    }
    for (const [key, entry] of Object.entries(used)) {
      queries.push(
        sql`INSERT INTO used_submissions (key, result) VALUES (${key}, ${JSON.stringify(entry)}::jsonb)
            ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result`,
      );
    }
    await sql.transaction(queries, { isolationLevel: "Serializable" });

    const after = await sql`
      SELECT (SELECT count(*) FROM bindings) AS bindings,
             (SELECT count(*) FROM exams) AS exams,
             (SELECT count(*) FROM used_submissions) AS used_submissions`;
    const migrated = {
      bindings: Number(after[0].bindings),
      exams: Number(after[0].exams),
      used_submissions: Number(after[0].used_submissions),
    };
    return res.status(200).json({ ok: true, source, migrated });
  } catch {
    // Generic message only — never leak details that could carry secrets.
    console.error("exam-migrate failed");
    return res.status(500).json({ error: "migration_failed" });
  }
}
