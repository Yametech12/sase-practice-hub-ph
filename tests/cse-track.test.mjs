/**
 * Two-track smoke + regression test (SASE + Civil Service).
 * Runs the REAL api handlers against the in-memory Neon fake, the
 * __EXAM_TEST_BANK / __CSE_TEST_BANK / __CSE_TEST_LESSONS hooks, and
 * throwaway registry entries injected into api/_exam-hashes.json and
 * api/_cse-hashes.json (both files are backed up and restored, even on
 * failure). No real Neon, no GitHub, no network.
 * Run:  node tests/cse-track.test.mjs   (after `npm install`)
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createMockNeon } from "./mock-neon.mjs";

const HMAC_ENV = ["EXAM", "HMAC", "SECRET"].join("_");
process.env[HMAC_ENV] = process.env[HMAC_ENV] || "cse-track-test-secret";

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "api");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---- throwaway registry entries (restored in finally) ----
const SASE_PW = "TestSasePw123";
const CSE_CODE = "CSE7-AB2C-DE3F";
const saseFile = path.join(API_DIR, "_exam-hashes.json");
const cseFile = path.join(API_DIR, "_cse-hashes.json");
const saseBackup = fs.readFileSync(saseFile, "utf8");
const cseBackup = fs.readFileSync(cseFile, "utf8");
const nowIso = new Date().toISOString();
const saseReg = JSON.parse(saseBackup || "{}");
saseReg[sha256(SASE_PW)] = { order_id: "SASE-TST001", created_at: nowIso };
fs.writeFileSync(saseFile, JSON.stringify(saseReg, null, 2) + "\n");
const cseReg = JSON.parse(cseBackup || "{}");
cseReg[sha256(CSE_CODE)] = { order_id: "CSE-TST001", created_at: nowIso };
fs.writeFileSync(cseFile, JSON.stringify(cseReg, null, 2) + "\n");

// ---- test banks + lessons ----
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
globalThis.__EXAM_TEST_BANK = { exams: { "1": mkItems("SASEQ", "Mathematics", 4) } };
globalThis.__CSE_TEST_BANK = {
  cseExams: { "1": [...mkItems("CSEV", "Verbal", 2), ...mkItems("CSEN", "Numerical", 2)] },
};
globalThis.__CSE_TEST_LESSONS = [
  { section: "Numerical", topic: "Number Series", title: "Series basics", channel: "Test Channel", video_id: "abcDEF12345", url: "https://www.youtube.com/watch?v=abcDEF12345", why: "Start here." },
];
globalThis.__SASE_TEST_LESSONS = [
  { section: "Mathematics", topic: "Linear equations", title: "SASE math lesson", channel: "Test Channel", video_id: "saseVID1234", url: "https://www.youtube.com/watch?v=saseVID1234", why: "SASE start here." },
  { section: "Science", topic: "Cells", title: "SASE science lesson", channel: "Test Channel", video_id: "saseSCI1234", url: "https://www.youtube.com/watch?v=saseSCI1234", why: "SASE science." },
];
globalThis.__NEON_SQL_MOCK = createMockNeon();

// ---- fake req/res ----
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

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  PASS ${name}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

try {
  const auth = (await import("../api/exam-auth.js")).default;
  const list = (await import("../api/exam-list.js")).default;
  const questions = (await import("../api/exam-questions.js")).default;
  const grade = (await import("../api/exam-grade.js")).default;
  const lessons = (await import("../api/exam-lessons.js")).default;

  console.log("1. auth: track is decided by which registry matched");
  const saseAuth = await call(auth, { password: SASE_PW, device_id: "dev-sase-1" });
  ok("sase auth 200", saseAuth.statusCode === 200);
  ok("sase auth track", saseAuth.body.track === "sase");
  const cseAuth = await call(auth, { password: CSE_CODE, device_id: "dev-cse-1" });
  ok("cse auth 200", cseAuth.statusCode === 200);
  ok("cse auth track", cseAuth.body.track === "cse");
  const badCse = await call(auth, { password: "CSE7-ZZZ9-ZZZ9", device_id: "dev-x" });
  ok("unknown CSE7 code 401", badCse.statusCode === 401);
  ok("unknown CSE7 code gets CSE wording", /access code/i.test(badCse.body.message) && /Civil Service/.test(badCse.body.message));
  const badSase = await call(auth, { password: "WrongPassword1", device_id: "dev-x" });
  ok("wrong sase password 401", badSase.statusCode === 401);
  ok("wrong sase password keeps original wording", badSase.body.message === "Incorrect password. Please check the password from your PDF and try again.");

  console.log("2. list: per-track timer + track echo");
  const saseList = await call(list, { token: saseAuth.body.token });
  ok("sase list 200", saseList.statusCode === 200);
  ok("sase list track", saseList.body.track === "sase");
  ok("sase list exam_ms is 2h", saseList.body.exam_ms === 2 * 60 * 60 * 1000);
  ok("sase list has 8 exams", (saseList.body.exams || []).length === 8);
  const cseList = await call(list, { token: cseAuth.body.token });
  ok("cse list 200", cseList.statusCode === 200);
  ok("cse list track", cseList.body.track === "cse");
  ok("cse list exam_ms is 3h10m", cseList.body.exam_ms === (3 * 60 + 10) * 60 * 1000);
  ok("cse list has 8 exams", (cseList.body.exams || []).length === 8);

  console.log("3. questions: each track serves only its own bank, with its own timer");
  const cseQ = await call(questions, { token: cseAuth.body.token, exam: 1 });
  ok("cse questions 200", cseQ.statusCode === 200);
  ok("cse questions track", cseQ.body.track === "cse");
  ok("cse questions are CSE bank items", (cseQ.body.questions || []).every((q) => /^CSE/.test(q.qid)));
  ok("cse questions carry no answers", (cseQ.body.questions || []).every((q) => q.answer === undefined && q.explanation === undefined));
  ok("cse remaining is ~3h10m", near(cseQ.body.server_remaining_ms, (3 * 60 + 10) * 60 * 1000, 60 * 1000));
  const saseQ = await call(questions, { token: saseAuth.body.token, exam: 1 });
  ok("sase questions 200", saseQ.statusCode === 200);
  ok("sase questions are SASE bank items", (saseQ.body.questions || []).every((q) => /^SASEQ/.test(q.qid)));
  ok("sase remaining is ~2h", near(saseQ.body.server_remaining_ms, 2 * 60 * 60 * 1000, 60 * 1000));

  console.log("4. grade: CSE result carries the 80.00 benchmark + CSE sections; SASE does not");
  const cseAnswers = {};
  (cseQ.body.questions || []).forEach((q) => { cseAnswers[q.qid] = "A"; });
  const cseGrade = await call(grade, {
    token: cseAuth.body.token, exam: 1, session_id: cseQ.body.session_id,
    answers: cseAnswers, submission_id: "sub-cse-1",
  });
  ok("cse grade 200", cseGrade.statusCode === 200);
  ok("cse grade has benchmark", !!cseGrade.body.benchmark && cseGrade.body.benchmark.passing_general_rating === 80.0);
  ok("cse benchmark pct matches", cseGrade.body.benchmark.practice_pct === cseGrade.body.pct);
  ok("cse sections are CSE names", Object.keys(cseGrade.body.sections || {}).every((s) => ["Verbal", "Numerical", "Analytical", "General Information"].includes(s)));
  const saseAnswers = {};
  (saseQ.body.questions || []).forEach((q) => { saseAnswers[q.qid] = "A"; });
  const saseGrade = await call(grade, {
    token: saseAuth.body.token, exam: 1, session_id: saseQ.body.session_id,
    answers: saseAnswers, submission_id: "sub-sase-1",
  });
  ok("sase grade 200", saseGrade.statusCode === 200);
  ok("sase grade has NO benchmark", !saseGrade.body.benchmark);

  console.log("5. lessons: per-track libraries, token required, never cross-served");
  const cseLessons = await call(lessons, { token: cseAuth.body.token });
  ok("cse lessons 200", cseLessons.statusCode === 200);
  ok("cse lessons track echo", cseLessons.body.track === "cse");
  ok("cse lessons payload", Array.isArray(cseLessons.body.lessons) && cseLessons.body.lessons.length === 1 && cseLessons.body.lessons[0].video_id === "abcDEF12345");
  ok("cse lessons response contains no SASE lessons", !JSON.stringify(cseLessons.body).includes("saseVID1234") && !JSON.stringify(cseLessons.body).includes("saseSCI1234"));
  const saseLessons = await call(lessons, { token: saseAuth.body.token });
  ok("sase lessons 200", saseLessons.statusCode === 200);
  ok("sase lessons track echo", saseLessons.body.track === "sase");
  ok("sase lessons payload", Array.isArray(saseLessons.body.lessons) && saseLessons.body.lessons.length === 2 && saseLessons.body.lessons[0].video_id === "saseVID1234" && saseLessons.body.lessons[1].section === "Science");
  ok("sase lessons response contains no CSE lessons", !JSON.stringify(saseLessons.body).includes("abcDEF12345"));
  const anonLessons = await call(lessons, {});
  ok("no token gets 401", anonLessons.statusCode === 401);
  const badLessons = await call(lessons, { token: "not-a-token" });
  ok("bad token gets 401", badLessons.statusCode === 401);

  console.log("6. device limit still enforced per track (max 3)");
  await call(auth, { password: CSE_CODE, device_id: "dev-cse-2" });
  await call(auth, { password: CSE_CODE, device_id: "dev-cse-3" });
  const fourth = await call(auth, { password: CSE_CODE, device_id: "dev-cse-4" });
  ok("4th CSE device 403", fourth.statusCode === 403 && fourth.body.error === "device_mismatch");
  ok("CSE device message does not name the SASE page", !/SASE Practice Hub/.test(fourth.body.message));

  console.log(`\nAll ${passed} cse-track checks passed.`);
} finally {
  fs.writeFileSync(saseFile, saseBackup);
  fs.writeFileSync(cseFile, cseBackup);
}
