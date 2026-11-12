/**
 * Latency fix regression test (Nov 12, 2026).
 *
 * The read-only portal endpoints (list, lessons, result), repeat logins
 * from an already-bound device, and idempotent grade replays used to pay
 * for a FULL loadState: every buyer's bindings, every completed attempt's
 * review JSONB, every used submission, plus a whole-state hash. They now
 * use loadOrderScope (order-filtered reads). This suite proves:
 *   1. list / lessons / result issue ONLY scoped queries, never the
 *      full-table NEON:read-* queries;
 *   2. a repeat login from a bound device performs NO writes and still
 *      succeeds, while a first login still binds through the write path;
 *   3. loadOrderScope returns only the requested order's rows;
 *   4. an idempotent grade replay returns the stored result with NO
 *      writes and NO full-table reads.
 * Runs the real handlers against the in-memory Neon fake and a throwaway
 * registry entry (backed up and restored). No network.
 * Run:  node tests/perf-scope.test.mjs   (after `npm install`)
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createMockNeon } from "./mock-neon.mjs";

const HMAC_ENV = ["EXAM", "HMAC", "SECRET"].join("_");
process.env[HMAC_ENV] = process.env[HMAC_ENV] || "perf-scope-test-secret";

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "api");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---- throwaway registry entry (restored in finally) ----
const PW = "PerfScopePw123";
const ORDER = "SASE-PERF01";
const saseFile = path.join(API_DIR, "_exam-hashes.json");
const saseBackup = fs.readFileSync(saseFile, "utf8");
const saseReg = JSON.parse(saseBackup || "{}");
saseReg[sha256(PW)] = { order_id: ORDER, created_at: new Date().toISOString() };
fs.writeFileSync(saseFile, JSON.stringify(saseReg, null, 2) + "\n");

const mkItems = (prefix, section, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i + 1}`,
    item_number: i + 1,
    section,
    question: `${prefix} question ${i + 1}?`,
    options: { A: "one", B: "two", C: "three", D: "four" },
    answer: "B",
    explanation: `${prefix} explanation ${i + 1}.`,
    passage: null,
  }));
globalThis.__EXAM_TEST_BANK = { exams: { "1": mkItems("PERFQ", "Mathematics", 4) } };
globalThis.__SASE_TEST_LESSONS = [
  { section: "Mathematics", topic: "Linear equations", title: "Perf lesson", channel: "Test Channel", video_id: "perfVID1234", url: "https://www.youtube.com/watch?v=perfVID1234", why: "Start here." },
];
const mock = createMockNeon();
globalThis.__NEON_SQL_MOCK = mock;

function fakeReq(body) {
  const req = Readable.from([JSON.stringify(body ?? {})]);
  req.method = "POST";
  req.headers = {};
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}
async function call(handler, body) {
  const res = fakeRes();
  await handler(fakeReq(body), res);
  return res;
}

const WRITE_MARKERS = ["NEON:guard", "NEON:lock-bindings", "NEON:lock-exams", "NEON:lock-subs", "NEON:write-bindings", "NEON:write-bindings-del", "NEON:write-exams", "NEON:write-exams-del", "NEON:write-subs", "NEON:write-subs-del"];
const READ_MARKERS = ["NEON:read-bindings", "NEON:read-exams", "NEON:read-subs"];
const SCOPE_MARKERS = ["NEON:scope-bindings", "NEON:scope-exams", "NEON:scope-subs"];

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  PASS ${name}`);
}
function scopedOnly(name) {
  const log = [...mock.queryLog];
  ok(`${name}: used scoped queries`, SCOPE_MARKERS.some((m) => log.includes(m)));
  ok(`${name}: no full-table reads`, !READ_MARKERS.some((m) => log.includes(m)));
}

try {
  const auth = (await import("../api/exam-auth.js")).default;
  const list = (await import("../api/exam-list.js")).default;
  const questions = (await import("../api/exam-questions.js")).default;
  const grade = (await import("../api/exam-grade.js")).default;
  const lessons = (await import("../api/exam-lessons.js")).default;
  const result = (await import("../api/exam-result.js")).default;
  const lib = await import("../api/_exam-lib.js");

  console.log("1. first login binds through the guarded write path");
  mock.queryLog.length = 0;
  const first = await call(auth, { password: PW, device_id: "perf-dev-1" });
  ok("first auth 200", first.statusCode === 200);
  ok("first auth wrote the binding", WRITE_MARKERS.some((m) => mock.queryLog.includes(m)));
  const token = first.body.token;

  console.log("2. repeat login from the bound device: scoped read, zero writes");
  mock.queryLog.length = 0;
  const writesBefore = mock.writeCount;
  const second = await call(auth, { password: PW, device_id: "perf-dev-1" });
  ok("repeat auth 200", second.statusCode === 200);
  ok("repeat auth used the scoped binding read", mock.queryLog.includes("NEON:scope-bindings"));
  ok("repeat auth did no full-table reads", !READ_MARKERS.some((m) => mock.queryLog.includes(m)));
  ok("repeat auth performed no writes", mock.writeCount === writesBefore && !WRITE_MARKERS.some((m) => mock.queryLog.includes(m)));

  console.log("3. exam list reads only this order's scope");
  mock.queryLog.length = 0;
  const lst = await call(list, { token });
  ok("list 200 with 8 exams", lst.statusCode === 200 && (lst.body.exams || []).length === 8);
  scopedOnly("list");

  console.log("4. lessons read only this order's scope");
  mock.queryLog.length = 0;
  const les = await call(lessons, { token });
  ok("lessons 200 with the test lesson", les.statusCode === 200 && (les.body.lessons || []).length === 1 && les.body.lessons[0].video_id === "perfVID1234");
  scopedOnly("lessons");

  console.log("5. grade once, then replay the same submission id");
  const qs = await call(questions, { token, exam: 1 });
  ok("questions 200", qs.statusCode === 200);
  const answers = {};
  (qs.body.questions || []).forEach((q) => { answers[q.qid] = "B"; });
  const g1 = await call(grade, { token, exam: 1, session_id: qs.body.session_id, answers, submission_id: "perf-sub-1" });
  ok("grade 200", g1.statusCode === 200);
  // Options are permuted per session, so assert shape, not an exact score.
  ok("grade returned a full score record", g1.body.total === 4 && typeof g1.body.score === "number");

  mock.queryLog.length = 0;
  const writesBeforeReplay = mock.writeCount;
  const g2 = await call(grade, { token, exam: 1, session_id: qs.body.session_id, answers, submission_id: "perf-sub-1" });
  ok("replay 200", g2.statusCode === 200);
  // The replay contract (pre-existing): resolveSubmission returns the
  // stored result flagged idempotent; its score fields match the first
  // response, whose live-built shape differs slightly. The fast path
  // returns the same resolveSubmission output the write path produced.
  ok("replay returns the stored result, flagged idempotent", g2.body.idempotent === true && g2.body.score === g1.body.score && g2.body.total === g1.body.total && JSON.stringify(g2.body.sections) === JSON.stringify(g1.body.sections));
  ok("replay used scoped queries", SCOPE_MARKERS.some((m) => mock.queryLog.includes(m)));
  ok("replay did no full-table reads", !READ_MARKERS.some((m) => mock.queryLog.includes(m)));
  ok("replay performed no writes", mock.writeCount === writesBeforeReplay && !WRITE_MARKERS.some((m) => mock.queryLog.includes(m)));

  console.log("6. result fetch reads only this order's scope");
  mock.queryLog.length = 0;
  const res1 = await call(result, { token, exam: 1 });
  ok("result 200 with the stored score", res1.statusCode === 200 && res1.body.total === 4 && res1.body.score === g1.body.score);
  scopedOnly("result");

  // Runs last on purpose: these rows are seeded straight into the fake's
  // tables, which the guarded write path (correctly) treats as a foreign
  // change, so no write-path call may follow this section.
  console.log("7. loadOrderScope returns only the requested order's rows");
  mock.db.bindings.set("SASE-OTHER9", { devices: [{ device_hash: "x", bound_at: "t" }] });
  mock.db.exams.set("SASE-OTHER9:1", { status: "completed" });
  mock.db.subs.set("SASE-OTHER9:1:sub-z", { score: 1 });
  mock.db.subs.set(`${ORDER}:1:sub-mine`, { score: 2 });
  const scope = await lib.loadOrderScope(ORDER);
  ok("scope bindings hold only this order", Object.keys(scope.bindings).join(",") === ORDER);
  ok("scope exams exclude the other order", !("SASE-OTHER9" in scope.exams));
  ok("scope subs hold only this order's keys", Object.keys(scope.used_submissions).every((k) => k.startsWith(`${ORDER}:`)) && `${ORDER}:1:sub-mine` in scope.used_submissions && !("SASE-OTHER9:1:sub-z" in scope.used_submissions));
  const other = await lib.loadOrderScope("SASE-OTHER9");
  ok("other scope is symmetric", Object.keys(other.bindings).join(",") === "SASE-OTHER9" && Object.keys(other.used_submissions).join(",") === "SASE-OTHER9:1:sub-z");

  console.log(`\nperf-scope: ${passed} checks passed`);
} finally {
  fs.writeFileSync(saseFile, saseBackup);
  delete globalThis.__EXAM_TEST_BANK;
  delete globalThis.__SASE_TEST_LESSONS;
  delete globalThis.__NEON_SQL_MOCK;
}
