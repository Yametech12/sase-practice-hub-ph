/**
 * Storage-layer tests for the Neon backend (api/_exam-lib.js).
 * Runs against the in-memory fake in ./mock-neon.mjs — no real Neon DB,
 * no GitHub, no secrets. Run:  node tests/neon-storage.test.mjs
 * (after `npm install` so @neondatabase/serverless resolves).
 *
 * Covers: fresh binding, existing-device rebind, device-limit rejection,
 * exam save/load round-trip, used_submissions idempotency, no-change
 * updateState (no writes), concurrent-conflict retry, and clean imports
 * of all 7 caller files.
 */
import assert from "node:assert";
import { createMockNeon } from "./mock-neon.mjs";

const mock = createMockNeon();
globalThis.__NEON_SQL_MOCK = mock;
const lib = await import("../api/_exam-lib.js");
const { loadState, updateState, saveState, resolveSubmission, bindingDevices, bindingHasDevice } = lib;

const ORDER = "ORD-TEST-NEON";
const DEV = (n) => `devhash-${n}`;
let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  PASS ${name}`);
}

// Auth-like mutator (mirrors exam-auth.js binding logic).
async function bindDevice(orderId, dh) {
  return updateState((state) => {
    const list = bindingDevices(state.bindings[orderId]);
    if (list.some((x) => x.device_hash === dh)) return { ok: true, rebound: false };
    if (list.length >= 3) return { ok: false, reason: "device_limit" };
    list.push({ device_hash: dh, bound_at: "2026-10-13T00:00:00.000Z", ip_hash: "ip1" });
    state.bindings[orderId] = { devices: list };
    return { ok: true, rebound: true };
  }, "test: bind device");
}

console.log("1. loadState on empty DB");
{
  const { state } = await loadState();
  ok("empty bindings", Object.keys(state.bindings).length === 0);
  ok("empty exams", Object.keys(state.exams).length === 0);
  ok("empty used_submissions", Object.keys(state.used_submissions).length === 0);
}

console.log("2. fresh binding");
{
  const out = await bindDevice(ORDER, DEV(1));
  ok("bound ok", out.ok === true && out.rebound === true);
  const { state } = await loadState();
  ok("one device stored", state.bindings[ORDER].devices.length === 1);
  ok("device hash matches", state.bindings[ORDER].devices[0].device_hash === DEV(1));
}

console.log("3. existing-device rebind (no duplicate, no writes)");
{
  const before = mock.writeCount;
  const out = await bindDevice(ORDER, DEV(1));
  ok("rebind ok, not rebound", out.ok === true && out.rebound === false);
  const { state } = await loadState();
  ok("still one device", state.bindings[ORDER].devices.length === 1);
  ok("no writes on no-change update", mock.writeCount === before);
}

console.log("4. device-limit rejection (max 3)");
{
  await bindDevice(ORDER, DEV(2));
  await bindDevice(ORDER, DEV(3));
  const out = await bindDevice(ORDER, DEV(4));
  ok("4th device rejected", out.ok === false && out.reason === "device_limit");
  const { state } = await loadState();
  ok("still 3 devices", state.bindings[ORDER].devices.length === 3);
  ok("bindingHasDevice finds bound device", bindingHasDevice(state.bindings[ORDER], DEV(2)) === true);
  ok("bindingHasDevice rejects unbound device", bindingHasDevice(state.bindings[ORDER], DEV(4)) === false);
}

console.log("5. exam save/load round-trip");
{
  const rec = {
    status: "in_progress",
    session_id: "sess-1",
    started_at: Date.now(),
    q_order: ["Q1", "Q2"],
    opt_map: { Q1: { A: "a", B: "b" }, Q2: { A: "a", B: "b" } },
    answers: {},
    last_sync: 0,
    bank_blob: "blob-1",
  };
  await updateState((state) => {
    (state.exams[ORDER] ||= {})["1"] = rec;
    return { ok: true };
  }, "test: start exam");
  let { state } = await loadState();
  ok("rec loaded", state.exams[ORDER]["1"].status === "in_progress");
  ok("q_order intact", JSON.stringify(state.exams[ORDER]["1"].q_order) === '["Q1","Q2"]');
  // Progress-like mutator: sync one answer.
  await updateState((state) => {
    const r = state.exams[ORDER]["1"];
    r.answers.Q1 = "A";
    r.last_sync = 123;
    return { ok: true };
  }, "test: progress");
  ({ state } = await loadState());
  ok("answer synced", state.exams[ORDER]["1"].answers.Q1 === "A");
  ok("last_sync synced", state.exams[ORDER]["1"].last_sync === 123);
}

console.log("6. grade + used_submissions idempotency");
{
  const idemKey = `${ORDER}:1:sub-1`;
  // First grade: no prior submission -> mark done + pointer.
  await updateState((state) => {
    const prior = resolveSubmission(state, idemKey);
    assert.equal(prior, null);
    const r = state.exams[ORDER]["1"];
    r.status = "done";
    r.score = 1;
    r.total = 2;
    r.pct = 50;
    r.submitted_at = "2026-10-13T00:00:00.000Z";
    state.used_submissions[idemKey] = {
      ref: `${ORDER}:1`,
      submitted_at: "2026-10-13T00:00:00.000Z",
      score: 1, total: 2, pct: 50,
      auto_submitted: false, forfeited: false, server_now: 1,
    };
    return { graded: true };
  }, "test: grade");
  // Second grade attempt: prior submission resolves -> no changes -> no writes.
  const before = mock.writeCount;
  await updateState((state) => {
    const prior = resolveSubmission(state, idemKey);
    assert.ok(prior, "prior submission must resolve");
    assert.equal(prior.score, 1);
    assert.equal(prior.idempotent, true);
    return { idempotent: true };
  }, "test: re-grade");
  ok("second grade is idempotent (no writes)", mock.writeCount === before);
  const { state } = await loadState();
  ok("exam still done", state.exams[ORDER]["1"].status === "done");
}

console.log("7. concurrent-conflict retry (guard throws once, updateState re-reads)");
{
  const ORDER2 = "ORD-TEST-NEON-2";
  await bindDevice(ORDER2, DEV(1));
  // Simulate a concurrent writer landing between this call's read and write.
  mock.interfereOnce((db) => {
    db.bindings.set("ORD-CONCURRENT", [{ device_hash: "other", bound_at: "", ip_hash: "" }]);
  });
  const out = await bindDevice(ORDER2, DEV(2));
  ok("retry succeeded after guard conflict", out.ok === true && out.rebound === true);
  const { state } = await loadState();
  ok("concurrent row preserved (no clobber)", state.bindings["ORD-CONCURRENT"]?.devices.length === 1);
  ok("own write applied", state.bindings[ORDER2].devices.length === 2);
}

console.log("8. saveState compat (full-state write + read back)");
{
  const { state } = await loadState();
  state.bindings["ORD-SAVE"] = { devices: [{ device_hash: "x", bound_at: "", ip_hash: "" }] };
  const sha = await saveState(state, "ignored", "test: saveState");
  ok("saveState returns a sha-like token", typeof sha === "string" && sha.length > 0);
  const after = (await loadState()).state;
  ok("saveState row readable", after.bindings["ORD-SAVE"].devices[0].device_hash === "x");
}

console.log("9. all 7 caller files still import cleanly (handlers untouched)");
{
  const callers = [
    "../api/exam-auth.js",
    "../api/exam-progress.js",
    "../api/exam-grade.js",
    "../api/exam-result.js",
    "../api/exam-questions.js",
    "../api/exam-list.js",
    "../api/exam-forfeit.js",
  ];
  for (const f of callers) {
    const m = await import(f);
    ok(`imports ${f.split("/").pop()}`, typeof m.default === "function");
  }
}

console.log(`\nALL ${passed} CHECKS PASSED`);
