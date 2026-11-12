/**
 * UI improvement round static checks (Nov 12, 2026).
 *
 * B. Slow-wait notes: the gate, exam-load and grading waits arm a
 *    "server may be waking up" note after about 5s (source-level checks
 *    on exam/exam-ui.js).
 * C. Fade fix: the question enter animation and the exam screen enter
 *    animation no longer animate opacity (source-level checks on
 *    exam/exam-ui.css).
 * D. Lesson thumbnails: the lessons render uses i.ytimg.com thumbnail
 *    facades with a lazy img, the iframe is created only inside the
 *    activation path, the Full screen button is visible whenever a
 *    fullscreen API exists and activates the player first, and the
 *    watched storage keys are unchanged.
 * E. Dark mode: contrast ratios computed FROM the CSS dark tokens for
 *    the sales pages and the portal; every audited normal-text pair
 *    must meet WCAG AA 4.5:1. (Static audit, not a device render.)
 * F. 390px responsiveness: no grid minmax minimum above 44px in the
 *    three stylesheets, images capped at 100% width, the order summary
 *    pre wraps, and exam cards stack on narrow screens. (Static audit.)
 *
 * Run:  node tests/ui-improvements.test.mjs
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const uiJs = read("exam/exam-ui.js");
const uiCss = read("exam/exam-ui.css");
const siteCss = read("site.css");
const resultsCss = read("exam/results-ui.css");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  PASS ${name}`);
}

console.log("B. slow-wait notes");
ok("armSlowNote helper exists", /function armSlowNote\(el, slowText\)/.test(uiJs));
ok("slow note delay is about 5 seconds", /armSlowNote[\s\S]{0,400}?\}, 5000\);/.test(uiJs));
ok("gate arms the still-checking note", uiJs.includes('armSlowNote(gateSubmit, "Still checking, the server may be waking up'));
ok("gate settle clears the note", /\.then\(function \(\) \{\s*clearSlowNote\(\);/.test(uiJs));
ok("exam load uses the submitting-title helper", uiJs.includes('setSubmittingTitle("Loading your exam'));
ok("grading uses the submitting-title helper", uiJs.includes('setSubmittingTitle("Grading your exam'));
ok("grading slow text mentions waking up", uiJs.includes("Still grading, the server may be waking up"));
ok("leaving the submitting screen clears the note", /if \(id !== "screen-submitting"\) clearSlowNote\(\);/.test(uiJs));

console.log("C. fade fix");
const qEnter = (uiCss.match(/@keyframes qEnter \{[^}]*\}/) || [""])[0];
ok("qEnter keyframes found", qEnter.length > 0);
ok("qEnter no longer animates opacity", !/opacity/.test(qEnter));
ok("qEnter still animates transform", /transform: translateY\(10px\)/.test(qEnter));
ok("exam screen enter animation is transform-only", /#screen-exam\.screen\.active \{ animation: screenin/.test(uiCss) && /@keyframes screenin \{ from \{ transform: translateY\(6px\); \}/.test(uiCss));
const reduced = (uiCss.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/) || [])[1] || "";
ok("reduced motion still disables the exam screen animation", /#screen-exam\.screen\.active \{ animation: none; \}/.test(reduced));
ok("other screens keep the fadein animation", /\.screen\.active \{ display: block; animation: fadein/.test(uiCss));

console.log("D. lesson thumbnails and player activation");
ok("thumbnail img comes from i.ytimg.com hqdefault", uiJs.includes("https://i.ytimg.com/vi/") && uiJs.includes("/hqdefault.jpg"));
ok("thumbnail img is lazy-loaded", /<img src="https:\/\/i\.ytimg\.com\/vi\/' \+ escapeHtml\(l\.video_id\) \+ '\/hqdefault\.jpg" alt="" loading="lazy">/.test(uiJs));
ok("player activation is a named closure", /function activatePlayer\(\) \{/.test(uiJs));
ok("iframe is created only inside activatePlayer", (uiJs.match(/createElement\("iframe"\)/g) || []).length === 1 && /function activatePlayer\(\) \{[^}]*createElement\("iframe"\)/.test(uiJs.replace(/\n/g, " ")));
ok("embed autoplays on activation", uiJs.includes("youtube-nocookie.com/embed/") && uiJs.includes("?autoplay=1&rel=0"));
ok("thumbnail click activates the player", /thumb\.addEventListener\("click", activatePlayer\)/.test(uiJs));
ok("Full screen button visibility follows the fullscreen API, not activation", uiJs.includes("expandBtn.hidden = !fullscreenApiExists();"));
ok("Full screen activates the player first when needed", /if \(!currentIfr\) activatePlayer\(\);\s*requestFullscreenOn\(currentIfr/.test(uiJs));
ok("watched storage keys unchanged", uiJs.includes('"cse_lessons_watched"') && uiJs.includes('"sase_lessons_watched"'));
ok("Watch on YouTube link preserved", uiJs.includes('"Watch on YouTube"') || uiJs.includes("Watch on YouTube"));

console.log("E. dark mode contrast, computed from the CSS tokens");
function lum(hex) {
  const c = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function ratio(fg, bg) {
  let [a, b] = [lum(fg), lum(bg)];
  if (a < b) [a, b] = [b, a];
  return (a + 0.05) / (b + 0.05);
}
function darkTokens(css) {
  // For every dark-scheme block, take the :root rule that follows it and
  // collect its hex token declarations (later blocks win, like the cascade).
  const tokens = {};
  const marker = "@media (prefers-color-scheme: dark)";
  let idx = 0;
  while (true) {
    const at = css.indexOf(marker, idx);
    if (at < 0) break;
    const root = css.slice(at).match(/:root \{([^}]*)\}/);
    if (root) {
      for (const m of root[1].matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2];
    }
    idx = at + marker.length;
  }
  return tokens;
}
const site = darkTokens(siteCss);
const portal = darkTokens(uiCss);
const results = darkTokens(resultsCss);
const pairs = [
  ["site muted on bg", site["--muted"], site["--bg"]],
  ["site muted on card", site["--muted"], site["--surface-strong"]],
  ["site primary on bg", site["--primary"], site["--bg"]],
  ["site primary on card", site["--primary"], site["--surface-strong"]],
  ["site green on green-soft", site["--green"], site["--green-soft"]],
  ["site danger on danger-soft", site["--danger"], site["--danger-soft"]],
  ["portal muted on card", portal["--muted"], portal["--card"]],
  ["portal muted on blue-50 surface", portal["--muted"], portal["--blue-50"]],
  ["portal ink on card", portal["--ink"], portal["--card"]],
  ["results muted on card surface", results["--muted"], "#1a2c47"],
];
for (const [name, fg, bg] of pairs) {
  ok(`${name} tokens present`, !!fg && !!bg);
  const r = ratio(fg, bg);
  ok(`${name} meets AA (${r.toFixed(2)}:1)`, r >= 4.5);
}
// Literal dark pairs pinned in the dark blocks (not token-driven).
const literals = [
  ["portal placeholder", "#7d8ea8", "#0f1e35"],
  ["portal section chip", "#9cc3f0", "#22385c"],
  ["portal status available", "#7ed9a8", "#1a2c47"],
  ["portal form error", "#f08ba0", "#1a2c47"],
  ["results status correct", "#7ed9a8", "#14382a"],
  ["results status wrong", "#f08ba0", "#3d1a22"],
  ["lesson meta on pinned white card", "#5b6b8c", "#ffffff"],
];
for (const [name, fg, bg] of literals) {
  const r = ratio(fg, bg);
  ok(`${name} meets AA (${r.toFixed(2)}:1)`, r >= 4.5);
}

console.log("F. 390px responsive statics");
for (const [name, css] of [["site.css", siteCss], ["exam-ui.css", uiCss], ["results-ui.css", resultsCss]]) {
  const mins = [...css.matchAll(/minmax\(\s*(\d+)px/g)].map((m) => Number(m[1]));
  ok(`${name}: no grid minmax minimum above 44px (found: ${mins.join(",") || "none"})`, mins.every((n) => n <= 44));
}
ok("site images capped at container width", /img \{ max-width: 100%;/.test(siteCss));
ok("order summary pre wraps long lines", /\.summary-box pre \{[^}]*white-space: pre-wrap;[^}]*word-break: break-word;/.test(siteCss));
ok("exam cards stack on narrow screens", /@media \(max-width: 420px\) \{\s*\.exam-card \{ flex-direction: column;/.test(uiCss));
ok("lesson cards stack on narrow screens", /@media \(max-width: 560px\) \{\s*\.lesson-card \{ flex-direction: column;/.test(uiCss));
ok("results score row wraps on very narrow screens", /@media \(max-width: 360px\) \{\s*\.score-wrap \{ flex-wrap: wrap;/.test(resultsCss));

console.log(`\nui-improvements: ${passed} checks passed`);
