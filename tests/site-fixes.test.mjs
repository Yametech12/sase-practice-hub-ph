/**
 * Static regression checks for the Nov 12, 2026 QA-roam site fixes.
 * Content/config assertions only (no browser): extensionless rewrites,
 * gate first-paint track branding, toggle URL sync, switch pill target,
 * brand aria-label, results lesson links carrying the track, the sample
 * page badge dedupe, anchor scroll margin, and the JS cache-bust bump.
 * Run:  node tests/site-fixes.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name); }
}

/* Fix 1: extensionless rewrites exist and the header rules survive. */
const vercel = JSON.parse(read("vercel.json"));
const rw = Object.fromEntries((vercel.rewrites || []).map((r) => [r.source, r.destination]));
check("rewrite /civil-service -> /civil-service.html", rw["/civil-service"] === "/civil-service.html");
check("rewrite /privacy -> /privacy.html", rw["/privacy"] === "/privacy.html");
check("vercel.json still carries the 4 header groups", Array.isArray(vercel.headers) && vercel.headers.length === 4);

const examUi = read("exam/exam-ui.js");

/* Fix 2: the gate help line is born track-aware and the gate init
   applies the full track profile after the injected chrome exists. */
check("help line initial content follows state.track",
  examUi.includes('helpPara.innerHTML = state.track === "cse" ? HELP_CSE : HELP_SASE;'));
const helpAppendIdx = examUi.indexOf("pageFoot.appendChild(helpPara)");
check("gate init calls applyTrackChrome after the help line is appended",
  helpAppendIdx !== -1 && examUi.indexOf("applyTrackChrome();", helpAppendIdx) > helpAppendIdx &&
  examUi.indexOf("Gate init:", helpAppendIdx) > helpAppendIdx);

/* Fix 3: the gate toggle rewrites ?track= via replaceState. */
check("gate toggle syncs the URL track param",
  examUi.includes("function chooseGateTrack(track) {\n    syncTrackInUrl(track);") &&
  examUi.includes('url.searchParams.set("track", track === "cse" ? "cse" : "sase");') &&
  examUi.includes("history.replaceState(null, \"\", url.pathname + url.search + url.hash);"));

/* Fix 4: the switch pill is created pointing at the OTHER portal. */
check("switch pill initial href/label derive from the active track",
  examUi.includes('switchLink.href = "/exam?track=" + initialOther;') &&
  !examUi.includes('switchLink.href = "/exam?track=cse";'));

/* Fix 5: the brand accessible name follows the track profile. */
check("applyTrackChrome sets the brand aria-label from the profile",
  examUi.includes('brandEl.setAttribute("aria-label", pr.brand);'));

/* Fix 6: results lesson links carry the track explicitly. */
const resultsUi = read("exam/results-ui.js");
check("results lesson link includes ?track= and &lessons=",
  resultsUi.includes('"/exam?track=" + resultTrack') || resultsUi.includes("/exam?track=' + resultTrack + '&lessons='"));

/* Fix 7: exactly one FREE SAMPLE badge remains on /sample (the card). */
const sample = read("sample/index.html");
check("sample page keeps only the in-card FREE SAMPLE kicker",
  (sample.match(/FREE SAMPLE/g) || []).length === 1 && sample.includes('<p class="instr-kicker">FREE SAMPLE</p>'));

/* Fix 8: anchor targets clear the sticky header. */
check("site.css gives id targets a 96px scroll margin",
  read("site.css").includes("scroll-margin-top: 96px"));

/* Cache-bust bumped on both exam pages. */
check("exam page loads exam-ui.js?v=20261112a", read("exam/index.html").includes("/exam/exam-ui.js?v=20261112a"));
check("results page loads results-ui.js?v=20261112a", read("exam/results.html").includes("/exam/results-ui.js?v=20261112a"));

console.log("\nsite-fixes: " + passed + " passed" + (failed ? ", " + failed + " FAILED" : ""));
process.exit(failed ? 1 : 0);
