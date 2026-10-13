#!/usr/bin/env node
/**
 * One-time, idempotent import of GitHub state.json -> Neon Postgres tables.
 *
 * READ-ONLY against GitHub: fetches state.json via the contents metadata +
 * blob API (same path api/_exam-lib.js used for the bank) and NEVER writes
 * to the state repo. The GitHub state repo stays intact as a backup.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS + INSERT ... ON CONFLICT DO UPDATE,
 * so re-running converges to the same tables. Safe to re-run after a
 * failed/interrupted run.
 *
 * Usage (from the repo root):
 *   GH_EXAM_TOKEN=<token> DATABASE_URL=<neon pooled URL> node scripts/migrate-github-to-neon.mjs
 *
 * Env:
 *   GH_EXAM_TOKEN   — GitHub token with contents:read on the state repo
 *   EXAM_STATE_REPO — "owner/repo" of the private state repo (default Yametech12/sase-exam-state)
 *   DATABASE_URL    — Neon pooled connection string (target tables)
 *
 * NEVER commit or print secrets. This script prints row counts only.
 */
import { neon } from "@neondatabase/serverless";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_REPO = process.env.EXAM_STATE_REPO || "Yametech12/sase-exam-state";

function mustEnv(name) {
  const v = process.env[name] || "";
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// GitHub read-only fetch of state.json (contents metadata -> blob).
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
  if (!metaRes.ok) throw new Error(`GitHub contents state.json: ${metaRes.status}`);
  const meta = await metaRes.json();
  const blobRes = await fetch(
    `https://api.github.com/repos/${STATE_REPO}/git/blobs/${meta.sha}`,
    { headers },
  );
  if (!blobRes.ok) throw new Error(`GitHub blob ${meta.sha}: ${blobRes.status}`);
  const blob = await blobRes.json();
  return JSON.parse(Buffer.from(blob.content, "base64").toString("utf8"));
}

// Normalize a legacy binding record to its device list (same rule as
// bindingDevices() in api/_exam-lib.js).
function normalizeDevices(b) {
  if (!b) return [];
  if (Array.isArray(b.devices)) return b.devices;
  if (b.device_hash) {
    return [{ device_hash: b.device_hash, bound_at: b.bound_at || "", ip_hash: b.ip_hash || "" }];
  }
  return [];
}

const ghToken = mustEnv("GH_EXAM_TOKEN");
const databaseUrl = mustEnv("DATABASE_URL");
const sql = neon(databaseUrl);

const state = await fetchStateJson(ghToken);
const bindings = state.bindings || {};
const exams = state.exams || {};
const used = state.used_submissions || {};
const attempts = state.attempts || {};
const inProgress = state.in_progress || {};
console.log(
  `state.json: ${Object.keys(bindings).length} bindings, ` +
    `${Object.values(exams).reduce((n, o) => n + Object.keys(o).length, 0)} exam rows, ` +
    `${Object.keys(used).length} used_submissions, ` +
    `${Object.keys(attempts).length} attempts (dropped), ` +
    `${Object.keys(inProgress).length} in_progress (dropped)`,
);
if (Object.keys(attempts).length || Object.keys(inProgress).length) {
  console.log(
    "NOTE: `attempts` / `in_progress` are legacy keys no handler reads — they are NOT migrated.",
  );
}

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");
// Split into single statements: the Neon HTTP driver rejects multi-statement
// strings ("cannot insert multiple commands into a prepared statement").
// Strip -- line comments, split on ';', drop empties. The pinned v0.10
// driver has NO sql.query() method (that is a v1 API — calling it throws
// "sql.query is not a function", the Oct 2026 migration outage). Call sql()
// directly with the raw string + empty params array — the documented v0.10
// direct-call form. Same fix in api/exam-migrate.js.
const schemaStmts = schema
  .replace(/--[^\n]*\n/g, "\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const queries = schemaStmts.map((stmt) => sql(stmt, []));
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
console.log(`Migrated in one Serializable transaction (${schemaStmts.length} schema statements + upserts).`);
console.log("Done. Verify with: SELECT (SELECT count(*) FROM bindings) bindings, (SELECT count(*) FROM exams) exams, (SELECT count(*) FROM used_submissions) subs;");
