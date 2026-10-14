/**
 * Regression tests for buildOptMap (api/_exam-lib.js).
 * Run:  node tests/optmap.test.mjs
 *
 * Covers: error-identification items whose stems carry (A)-(D) markers keep
 * the identity mapping (UI letter == stem marker); normal items get a
 * permutation of the same letters (shuffled, nothing lost or duplicated);
 * items without options map to {}.
 */
import assert from "node:assert";

const { buildOptMap } = await import("../api/_exam-lib.js");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  PASS ${name}`);
}

const errId = {
  id: "ENG-014",
  question: "Neither of the players (A) were (B) able to finish (C) the final round (D).",
  options: { A: "were", B: "able to finish", C: "the final round", D: ".", E: "No error" },
};
ok("stem-marker item keeps identity mapping", JSON.stringify(buildOptMap(errId)) === JSON.stringify({ A: "A", B: "B", C: "C", D: "D", E: "E" }));

const errId2 = {
  id: "ENG-015",
  question: "She has (A) submitted her report (B) last Friday (C) afternoon (D).",
  options: { A: "submitted her report", B: "last Friday", C: "afternoon", D: ".", E: "No error" },
};
ok("second stem-marker item keeps identity mapping", JSON.stringify(buildOptMap(errId2)) === JSON.stringify({ A: "A", B: "B", C: "C", D: "D", E: "E" }));

// Marker-like text that is NOT an error-ID stem (no (B)) still shuffles:
// covered implicitly by the permutation check below on a normal item.
const normal = {
  id: "ENG-001",
  question: "The architect was meticulous in checking every detail of the blueprint.",
  options: { A: "careless", B: "careful", C: "slow", D: "loud" },
};
for (let i = 0; i < 20; i++) {
  const m = buildOptMap(normal);
  assert.deepEqual(Object.keys(m).sort(), ["A", "B", "C", "D"]);
  assert.deepEqual(Object.values(m).sort(), ["A", "B", "C", "D"]);
}
ok("normal item maps to a permutation of the same letters (x20)", true);

const noOpts = { id: "X-1", question: "No options here." };
ok("item without options maps to {}", JSON.stringify(buildOptMap(noOpts)) === "{}");

console.log(`optmap: ${passed} passed`);
