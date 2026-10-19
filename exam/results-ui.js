/* ============================================================
   SASE Mock Exam, Results screen logic (vanilla JS)
   ------------------------------------------------------------
   INTEGRATION
   -----------
   The exam page stores the JSON result of POST /api/exam-grade
   (or POST /api/exam-forfeit, or the auto path of a 403
   already_submitted) in sessionStorage under key
   "sase_exam_result", then navigates here. This page reads it
   on load and renders. No demo mode, no mock data.

   Result shape:
   {
     score, total, pct,
     sections: {Name:{correct,total,pct}} or [{name,correct,total,pct}],
     weak_area,                       // string or object
     improvement: { section, chapters, tips },
     review: [{ id, section, number, question,
                options: {A,B,C,D} (display order as seen by the user),
                your_answer, correct_answer, explanation,
                was_correct, skipped }],
     submitted_at, auto_submitted, forfeited, idempotent
   }
   ============================================================ */

(function () {
  "use strict";

  var WEAK_THRESHOLD = 70; // sections below this % get an improve card
  var RESULT_KEY = "sase_exam_result";
  var EXAM_NUM_KEY = "sase_exam_n";
  var TOTAL_EXAMS = 8;

  var els = {};
  ["examStatus", "examStatusText", "resultNotice", "resultNoticeText",
   "noResult", "btnNoResultHub", "resultBody",
   "examTitle", "ringFill", "scorePct", "scoreRaw",
   "headline", "subline", "sectionBars", "improveList", "reviewList",
   "filterChips", "countAll", "countCorrect", "countWrong", "countSkipped",
   "btnScorecard", "btnHub"].forEach(function (id) { els[id] = document.getElementById(id); });

  var currentData = null;
  var currentExamN = null;
  var currentFilter = "all";

  /* ---------- headline tiers ---------- */
  function headlineFor(pct) {
    if (pct >= 85) return ["Outstanding! <EMOJI>🌟</EMOJI>", "You're performing at a very strong level. Keep this momentum into exam week."];
    if (pct >= 70) return ["Great work! <EMOJI>💪</EMOJI>", "A solid practice score. A little targeted review will push you even higher."];
    if (pct >= 50) return ["Good effort! <EMOJI>📘</EMOJI>", "You're building the foundation. Focus on the weak areas below and watch your score climb."];
    return ["Keep going! <EMOJI>🌱</EMOJI>", "Every top scorer started here. Your improvement plan below shows exactly where to focus."];
  }

  /* ---------- main render ---------- */
  function render(data, examN) {
    currentData = data;
    currentExamN = examN || "?";
    var pct = data.pct != null ? data.pct : (data.total ? data.score / data.total * 100 : 0);

    // COPY fix 3: auto-submit / forfeit notices.
    if (data.auto_submitted) {
      els.resultNoticeText.textContent =
        "Your time ran out, so your answers were submitted automatically. Here's how you did, review the weak areas below before your next exam.";
      els.resultNotice.hidden = false;
    } else if (data.forfeited) {
      els.resultNoticeText.textContent =
        "You gave up this attempt, your saved answers were graded. Review the weak areas below before your next exam.";
      els.resultNotice.hidden = false;
    }

    // Status strip
    var n = examN || "?";
    els.examStatusText.textContent = "Mock Exam " + n + " of " + TOTAL_EXAMS + ", completed · Your score: " +
      (data.pct != null ? data.pct.toFixed(1) + "%" : pct.toFixed(1) + "%");
    els.examTitle.textContent = "Mock Exam " + n + ", Practice Result";

    // Score ring (decorative SVG is aria-hidden; values are real text, A11Y K11)
    var C = 326.7; // 2π·52
    els.ringFill.style.strokeDashoffset = String(C - (C * pct / 100));
    els.scorePct.textContent = pct.toFixed(1) + "%";
    els.scoreRaw.textContent = data.score + " / " + data.total + " correct";

    var h = headlineFor(pct);
    els.headline.innerHTML = h[0].replace(/<EMOJI>(.*?)<\/EMOJI>/, '<span aria-hidden="true">$1</span>');
    els.subline.textContent = h[1];

    renderSections(data);
    renderImprove(data);
    renderReview(data);

    els.noResult.hidden = true;
    els.resultBody.hidden = false;
  }

  /* ---------- sections (accept object or array) ---------- */
  function sectionList(data) {
    var out = [];
    if (Array.isArray(data.sections)) {
      data.sections.forEach(function (s) {
        out.push({ name: s.name, correct: s.correct, total: s.total, pct: s.pct != null ? s.pct : pctOf(s) });
      });
    } else if (data.sections) {
      Object.keys(data.sections).forEach(function (name) {
        var s = data.sections[name];
        out.push({ name: name, correct: s.correct, total: s.total, pct: s.pct != null ? s.pct : pctOf(s) });
      });
    }
    return out;
  }
  function pctOf(s) { return s.total ? s.correct / s.total * 100 : 0; }

  function renderSections(data) {
    els.sectionBars.innerHTML = "";
    sectionList(data).forEach(function (sec) {
      var pct = sec.pct;
      var row = document.createElement("div");
      row.className = "sec-row";
      var track = document.createElement("div");
      track.className = "sec-track";
      track.setAttribute("role", "progressbar"); /* A11Y K10 */
      track.setAttribute("aria-label", sec.name + " score");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(Math.round(pct)));
      var fill = document.createElement("div");
      fill.className = "sec-fill " + (pct >= WEAK_THRESHOLD ? "good" : "weak");
      track.appendChild(fill);
      var nameEl = document.createElement("span");
      nameEl.className = "sec-name";
      nameEl.textContent = sec.name;
      var pctEl = document.createElement("span");
      pctEl.className = "sec-pct";
      pctEl.textContent = pct.toFixed(0) + "%";
      row.appendChild(nameEl);
      row.appendChild(track);
      row.appendChild(pctEl);
      els.sectionBars.appendChild(row);
      // animate via transform (PERF F-4)
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { fill.style.transform = "scaleX(" + (pct / 100) + ")"; });
      });
    });
  }

  /* ---------- how to improve ---------- */
  function weakAreaName(data) {
    if (!data.weak_area) return null;
    if (typeof data.weak_area === "object") return data.weak_area.section || null;
    // Server sends a sentence: "Your weakest section is Mathematics (50%)."
    // Extract the bare section name against the known canonical names.
    var sentence = String(data.weak_area);
    var names = ["Language Usage", "Mathematics", "Aptitude", "Science"];
    for (var i = 0; i < names.length; i++) {
      if (sentence.indexOf(names[i]) !== -1) return names[i];
    }
    return sentence; // fallback: return as-is (legacy bare-name payloads still work)
  }
  /* Per-section study guide, mirrors the server IMPROVEMENT_GUIDE in api/_exam-lib.js.
     Used for every weak section; the server payload only carries the single weakest section. */
  var SECTION_GUIDE = {
    "Language Usage": {
      chapters: "Parts I & V of your reviewer (vocabulary, grammar, reading)",
      tip: "Read one passage daily and learn 5 new words with their sentences, vocabulary compounds fast."
    },
    "Mathematics": {
      chapters: "Parts II & VI of your reviewer (word problems, algebra, geometry)",
      tip: "Redo every wrong item without looking at the solution first. Speed comes from method, not memorization."
    },
    "Aptitude": {
      chapters: "Parts III & VII of your reviewer (series, patterns, analogies)",
      tip: "Practice 10 logic items a day under time pressure. Pattern recognition is a trained skill."
    },
    "Science": {
      chapters: "Parts IV & VIII of your reviewer (biology, earth science, chemistry, physics)",
      tip: "Make one-page concept maps per topic, practice science rewards understanding over facts."
    }
  };
  function guideFor(name) {
    if (SECTION_GUIDE[name]) return SECTION_GUIDE[name];
    var k = String(name || "").toLowerCase();
    if (/language|english/.test(k)) return SECTION_GUIDE["Language Usage"];
    if (/math/.test(k)) return SECTION_GUIDE["Mathematics"];
    if (/science/.test(k)) return SECTION_GUIDE["Science"];
    if (/aptitude|logic/.test(k)) return SECTION_GUIDE["Aptitude"];
    return null;
  }
  function improveTips(data) {
    var imp = data.improvement || {};
    return function (name) {
      // Server tips arrive as an ARRAY for the single weakest section.
      if (Array.isArray(imp.tips) && imp.section === name) {
        return imp.tips.join(" ");
      }
      // Object-keyed tips (future server shape) still supported.
      if (imp.tips && imp.tips[name]) return imp.tips[name];
      var g = guideFor(name);
      if (g) return g.tip;
      return "Review this section's lessons and redo your wrong items.";
    };
  }
  function chapterFor(data, name) {
    var imp = data.improvement || {};
    if (imp.chapters && typeof imp.chapters === "object" && imp.chapters[name]) return imp.chapters[name];
    // Server chapters arrive as a STRING for the single weakest section.
    if (typeof imp.chapters === "string" && imp.section === name) return imp.chapters;
    var g = guideFor(name);
    if (g) return g.chapters;
    if (typeof imp.chapters === "string") return imp.chapters;
    return "your reviewer";
  }

  function renderImprove(data) {
    els.improveList.innerHTML = "";
    var weak = sectionList(data)
      .filter(function (x) { return x.pct < WEAK_THRESHOLD; })
      .sort(function (a, b) { return a.pct - b.pct; });
    var weakName = weakAreaName(data);
    if (weakName && !weak.some(function (w) { return w.name === weakName; })) {
      /* Server flagged a section even if it cleared the local threshold, honor it. */
      var match = sectionList(data).filter(function (x) { return x.name === weakName; });
      if (match.length) weak.unshift(match[0]);
    }

    if (!weak.length) {
      var ok = document.createElement("div");
      ok.className = "improve-ok";
      ok.innerHTML = '<span aria-hidden="true">🎉</span> All sections at 70% or higher, maintain with light review before your next exam.';
      els.improveList.appendChild(ok);
      return;
    }

    var tipFor = improveTips(data);
    weak.forEach(function (w) {
      var div = document.createElement("div");
      div.className = "improve-item";
      div.innerHTML =
        "<strong>" + esc(w.name) + ", " + w.pct.toFixed(0) + "%</strong>" +
        "<p>" + esc(tipFor(w.name)) + "</p>" +
        '<span class="chap"><span aria-hidden="true">📖</span> Study: ' + esc(chapterFor(data, w.name)) + "</span>";
      els.improveList.appendChild(div);
    });
  }

  /* ---------- answer review ---------- */
  function statusOf(item) {
    if (item.skipped) return "skipped";
    if (item.your_answer === null || item.your_answer === undefined) return "skipped";
    return item.was_correct ? "correct" : "wrong";
  }

  /* Short section code for the header badge (ENG / SCI / MATH / APT). */
  function sectionCode(section) {
    var s = String(section || "").toLowerCase();
    if (/language|english/.test(s)) return "ENG";
    if (/math/.test(s)) return "MATH";
    if (/science/.test(s)) return "SCI";
    if (/aptitude|logic/.test(s)) return "APT";
    return String(section || "").slice(0, 4).toUpperCase() || ", ";
  }

  function renderReview(data) {
    var counts = { all: 0, correct: 0, wrong: 0, skipped: 0 };
    (data.review || []).forEach(function (it) { counts[statusOf(it)]++; counts.all++; });
    els.countAll.textContent = "(" + counts.all + ")";
    els.countCorrect.textContent = "(" + counts.correct + ")";
    els.countWrong.textContent = "(" + counts.wrong + ")";
    els.countSkipped.textContent = "(" + counts.skipped + ")";
    applyFilter();
  }

  /* Circle shows a SHORT number only (1-3 chars, fits the 30px circle).
     Server sends the exam position (1-180). Legacy stored reviews
     (graded before the fix) have no `number`, fall back to the trailing
     digits of the bank id ("SCI-018" -> "18"), then to the review
     position. NEVER the full 7-char id ("SCI-018" wraps at the hyphen
     and gets clipped by .q-item overflow:hidden). */
  function circleNum(it, idx) {
    if (it.number != null && isFinite(Number(it.number))) {
      var n = String(Math.trunc(Number(it.number)));
      if (n.length <= 3) return n;
    }
    var m = /(\d{1,3})$/.exec(String(it.id || ""));
    if (m) return String(parseInt(m[1], 10));
    return String((idx || 0) + 1);
  }

  function applyFilter() {
    els.reviewList.innerHTML = "";
    var shown = 0;
    (currentData.review || []).forEach(function (it, idx) {
      if (currentFilter !== "all" && statusOf(it) !== currentFilter) return;
      els.reviewList.appendChild(buildItem(it, idx));
      shown++;
    });
    if (shown === 0) {
      var empty = document.createElement("div");
      empty.className = "q-empty";
      empty.textContent = "No questions in this filter.";
      els.reviewList.appendChild(empty);
    }
  }

  function buildItem(it, idx) {
    var st = statusOf(it);
    var num = circleNum(it, idx);
    var div = document.createElement("div");
    div.className = "q-item " + st;

    var srStatus = st === "correct" ? ", correct" : st === "wrong" ? ", wrong" : ", skipped"; /* A11Y K9 */
    var statusLabel = st === "correct" ? "✓ Correct" : st === "wrong" ? "✕ Wrong" : "○ Skipped";

    var head = document.createElement("button");
    head.type = "button";
    head.className = "q-head";
    head.setAttribute("aria-expanded", "false"); /* A11Y K6 */
    /* Stacked header: meta row (number + section-code badge + section +
       status chip + chevron) above the FULL question text, wrapped.
       No truncation, the old truncate(question, 64) cut questions
       mid-sentence ("The badly researched…"). */
    head.innerHTML =
      '<span class="q-head-row">' +
        '<span class="q-num" aria-hidden="true">' + esc(String(num)) + "</span>" +
        '<span class="q-code" aria-hidden="true">' + esc(sectionCode(it.section)) + "</span>" +
        '<span class="q-sec">' + esc(it.section || "") + "</span>" +
        '<span class="q-status" aria-hidden="true">' + statusLabel + "</span>" +
        '<span class="q-chev" aria-hidden="true">▾</span>' +
      "</span>" +
      '<span class="q-head-q">' + esc(it.question) +
      '<span class="sr-only">' + srStatus + "</span></span>" +
      '<span class="q-tap-hint">Tap to see answer &amp; explanation</span>';
    head.addEventListener("click", function () {
      var open = div.classList.toggle("open");
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });

    var body = document.createElement("div");
    body.className = "q-body";

    var opts = Object.keys(it.options || {}).map(function (k) {
      var cls = "";
      if (k === it.correct_answer) cls += " is-correct";
      if (k === it.your_answer) cls += " is-yours";
      return '<li class="' + cls + '"><b>' + esc(k) + ".</b> " + esc(it.options[k]) + "</li>";
    }).join("");

    var check = '<span aria-hidden="true">✅</span>';
    var ansLine;
    if (st === "skipped") {
      ansLine = 'You skipped this. Correct answer: <b class="you-right">' + esc(it.correct_answer) + "</b>";
    } else if (st === "correct") {
      ansLine = 'Your answer <b class="you-right">' + esc(it.your_answer) + "</b>, correct! " + check;
    } else {
      ansLine = 'You answered <b class="you-wrong">' + esc(it.your_answer) + "</b>, correct answer: <b class=\"you-right\">" + esc(it.correct_answer) + "</b>";
    }

    body.innerHTML =
      (it.passage ? '<div class="q-passage">' + esc(it.passage) + "</div>" : "") +
      // No q-text here: the collapsed header already shows the FULL question,
      // so repeating it in the expanded body duplicated the stem on screen.
      '<ul class="q-opts">' + opts + "</ul>" +
      '<p class="ans-line">' + ansLine + "</p>" +
      '<p class="q-expl"><strong>Why:</strong> ' + esc(it.explanation || "See your reviewer for the full explanation.") + "</p>";

    div.appendChild(head);
    div.appendChild(body);
    return div;
  }

  els.filterChips.addEventListener("click", function (e) {
    var btn = e.target.closest(".chip");
    if (!btn) return;
    els.filterChips.querySelectorAll(".chip").forEach(function (c) {
      c.classList.remove("active");
      c.setAttribute("aria-pressed", "false"); /* A11Y K12 */
    });
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    currentFilter = btn.getAttribute("data-filter");
    if (currentData) applyFilter();
  });

  /* ---------- score card download ---------- */
  els.btnScorecard.addEventListener("click", function () {
    if (!currentData) return;
    var d = currentData;
    var pct = d.pct != null ? d.pct : (d.total ? d.score / d.total * 100 : 0);
    var examLabel = "MOCK EXAM " + (currentExamN || "?") + ", PRACTICE RESULT";
    var dateLabel = "";
    if (d.submitted_at) {
      var dt = new Date(d.submitted_at);
      if (!isNaN(dt.getTime())) {
        // Format in Asia/Manila (the product's timezone), not the viewer's local tz.
        var parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric"
        }).formatToParts(dt);
        var mo = "", dy = "", yr = "";
        parts.forEach(function (p) {
          if (p.type === "month") mo = p.value;
          if (p.type === "day") dy = p.value;
          if (p.type === "year") yr = p.value;
        });
        dateLabel = "Taken " + mo + " " + dy + ", " + yr;
      }
    }
    var cv = document.createElement("canvas");
    cv.width = 1080; cv.height = 1350;
    var g = cv.getContext("2d");

    // background
    var grad = g.createLinearGradient(0, 0, 0, 1350);
    grad.addColorStop(0, "#0f2a5c"); grad.addColorStop(1, "#143a7a");
    g.fillStyle = grad; g.fillRect(0, 0, 1080, 1350);

    g.fillStyle = "#ffffff"; g.textAlign = "center";
    g.font = "700 54px Arial"; g.fillText("SASE Practice Hub PH", 540, 140);
    g.font = "600 32px Arial"; g.fillStyle = "#cdd9f2";
    g.fillText(examLabel, 540, 208);
    if (dateLabel) {
      g.font = "600 28px Arial"; g.fillStyle = "#9db4dd";
      g.fillText(dateLabel, 540, 258);
    }

    // score
    g.fillStyle = "#ffffff"; g.font = "800 220px Arial";
    g.fillText(pct.toFixed(1) + "%", 540, 520);
    g.font = "600 44px Arial"; g.fillStyle = "#cdd9f2";
    g.fillText(d.score + " out of " + d.total + " correct", 540, 600);

    // sections (spacing shrinks gracefully if there are ever more than 4)
    var secs = sectionList(d), y = 720;
    var step = secs.length > 4 ? Math.max(72, Math.floor(460 / secs.length)) : 110;
    g.textAlign = "left";
    secs.forEach(function (sec) {
      g.font = "700 38px Arial"; g.fillStyle = "#ffffff";
      g.fillText(sec.name, 140, y);
      g.textAlign = "right"; g.fillText(sec.pct.toFixed(1) + "%", 940, y); g.textAlign = "left";
      g.fillStyle = "rgba(255,255,255,.25)";
      g.fillRect(140, y + 24, 800, 22);
      g.fillStyle = sec.pct >= WEAK_THRESHOLD ? "#4ade80" : "#fbbf24";
      g.fillRect(140, y + 24, 800 * Math.min(100, Math.max(0, sec.pct)) / 100, 22);
      y += step;
    });

    // footer watermark
    g.textAlign = "center"; g.fillStyle = "#9db4dd"; g.font = "600 30px Arial";
    g.fillText("Practice benchmark, not an official SASE result", 540, 1230);
    g.fillStyle = "#ffffff"; g.font = "700 34px Arial";
    g.fillText("SASE Practice Hub PH", 540, 1285);

    var a = document.createElement("a");
    a.download = "sase-mock-exam-" + (currentExamN || "result") + "-practice-score.png";
    a.href = cv.toDataURL("image/png");
    // append to DOM: detached-anchor clicks are ignored by some mobile browsers
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  /* ---------- back to hub ---------- */
  function goHub() { window.location.href = "/exam"; }
  els.btnHub.addEventListener("click", goHub);
  els.btnNoResultHub.addEventListener("click", goHub);

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---------- boot: read the stored grade result (no demo mode) ---------- */
  (function boot() {
    var raw = null, examN = null;
    try {
      raw = sessionStorage.getItem(RESULT_KEY);
      examN = sessionStorage.getItem(EXAM_NUM_KEY);
    } catch (e) {}
    if (!raw) {
      els.noResult.hidden = false;
      els.examStatusText.textContent = "No result loaded";
      return;
    }
    var data;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    if (!data || typeof data.score !== "number") {
      els.noResult.hidden = false;
      els.examStatusText.textContent = "No result loaded";
      return;
    }
    /* The grade/forfeit done-branches used to return a summary WITHOUT review
       (double-submit / retry-after-auto-grade / cross-tab race). The stored
       review may be empty but the server still has it, re-fetch the
       authoritative copy instead of rendering a blank review list. */
    if (!Array.isArray(data.review) || data.review.length === 0) {
      els.examStatusText.textContent = "Loading your full review…";
      refetchReview(data, examN);
      return;
    }
    render(data, examN);
  })();

  function refetchReview(fallbackData, examN) {
    // Minimal fetch, results page has no api() helper; token lives in sessionStorage.
    var token = null;
    try { token = sessionStorage.getItem("sase_exam_session"); } catch (e) {}
    if (!token || !examN) { render(fallbackData, examN); return; } // nothing to fetch with
    fetch("/api/exam-result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token, exam: Number(examN) })
    }).then(function (res) { return res.json().catch(function () { return null; }); })
      .then(function (serverData) {
        if (serverData && Array.isArray(serverData.review) && serverData.review.length) {
          try { sessionStorage.setItem(RESULT_KEY, JSON.stringify(serverData)); } catch (e) {}
          render(serverData, examN);
        } else {
          render(fallbackData, examN); // server has no review either, show score + empty state honestly
        }
      })
      .catch(function () { render(fallbackData, examN); }); // offline → cached copy, never blank-screen
  }

})();
