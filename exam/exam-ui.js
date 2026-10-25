/* ============================================================
   SASE Mock Exam Portal, exam-taking UI logic (vanilla JS)
   ------------------------------------------------------------
   BACKEND API (exact field names per contract):
     POST /api/exam-auth      {password, device_id} → 200 {token}
     POST /api/exam-list      {token} → 200 {exams:[...], server_now}
     POST /api/exam-questions {token, exam} → 200 {exam, session_id,
        questions:[{qid, section, question, passage, options:{A,B,C,D}}],
        answers, server_remaining_ms, server_now, expires_at, resumed}
     POST /api/exam-progress  {token, exam, session_id, answers}
        → 200 {ok:true, server_remaining_ms, server_now} · 410 expired
     POST /api/exam-grade     {token, exam, session_id, answers, submission_id}
        → 200 grade result (stored in sessionStorage "sase_exam_result",
          then window.location.href = "/exam/results.html")
     POST /api/exam-forfeit   {token, exam, session_id}
        → 200 same result schema with forfeited:true
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- constants ---------------- */
  var EXAM_DURATION_MS = 2 * 60 * 60 * 1000; // 2-hour practice timer
  var LOW_TIME_MS = 15 * 60 * 1000;          // danger styling under 15 min
  var SYNC_DEBOUNCE_MS = 1500;
  var SYNC_HEARTBEAT_MS = 30000;
  var SESSION_KEY = "sase_exam_session";     // sessionStorage: auth token
  var RESULT_KEY = "sase_exam_result";       // sessionStorage: grade result
  var EXAM_NUM_KEY = "sase_exam_n";          // sessionStorage: exam number for results header
  var DEVICE_KEY = "sase_exam_device";       // localStorage: persistent device id
  var ANNOUNCE_THRESHOLDS = [                 // seconds → spoken announcement (PERF F-1 / A11Y K5)
    { sec: 30 * 60, text: "30 minutes remaining" },
    { sec: 10 * 60, text: "10 minutes remaining" },
    { sec: 5 * 60,  text: "5 minutes remaining" },
    { sec: 60,      text: "1 minute remaining" }
  ];

  /* ---------------- state ---------------- */
  var state = {
    token: null,
    exam: null,            // exam number (n)
    sessionId: null,
    questions: [],
    answers: {},           // qid → 'A'|'B'|'C'|'D'
    flagged: {},           // qid → true
    cellByQid: {},         // qid → grid button element
    currentIndex: 0,
    deadlineMs: 0,
    timerId: null,
    announced: {},
    syncIntervalId: null,  // PERF F-5: stored handle, cleared on submit
    syncDebounceId: null,
    submitting: false,
    submissionId: null,
    examLocked: false,     // set on 410 expired: UI locked, auto-submit in flight
    submitRetries: 0,      // consecutive auto-submit failures (reset on success / new submit)
    submitRetryTimer: null,// pending backoff timeout id
    syncFailures: 0,       // consecutive non-410 sync failures
    syncFailNotified: false,// banner already shown for this streak
    sessionExpiredHandled: false // guard: 401 recovery runs once per expiry
  };

  /* ---------------- dom helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function showScreen(id) {
    var screens = document.querySelectorAll(".screen");
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove("active");
    $(id).classList.add("active");
    window.scrollTo(0, 0);
  }
  function fmtTime(ms) {
    var sec = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  function fmtLong(ms) {
    var sec = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
    return h > 0 ? h + "h " + m + "m remaining" : m + "m remaining";
  }
  function fmtDays(ms) {
    var days = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
    return days === 1 ? "1 day" : days + " days";
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function randomUUID() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /* ---------------- API layer (real fetch, with timeouts) ---------------- */
  var API_TIMEOUT_MS = 15000;       // default for list / questions / progress / forfeit / result
  var API_GRADE_TIMEOUT_MS = 20000; // grade carries the full payload + server grading work
  function api(path, body, timeoutMs) {
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || API_TIMEOUT_MS);
    }
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;
        var err = new Error(data.message || "Something went wrong. Please try again.");
        err.status = res.status;
        err.code = data.error || null;
        err.data = data;
        throw err;
      });
    }, function (fetchErr) {
      if (timer) clearTimeout(timer);
      if (fetchErr && fetchErr.name === "AbortError") {
        var timeoutErr = new Error("The server is taking too long, please check your connection and try again.");
        timeoutErr.status = 0; timeoutErr.code = "timeout";
        throw timeoutErr;
      }
      throw new Error("Could not connect, please check your connection and try again.");
    });
  }

  /* ---------------- shared 401 recovery ---------------- */
  /* Any mid-exam 401 funnels here. Clears the dead token, stops all
     timers/syncs, returns to the gate with an explicit "sign in again to
     resume" message. After re-login the student taps Resume explicitly, exams never auto-start. Idempotent: sync 401, grade
     401, and forfeit 401 can all fire in the same second. */
  function handleSessionExpired() {
    if (state.sessionExpiredHandled) return;
    state.sessionExpiredHandled = true;
    stopTimer();
    clearSync();
    clearSubmitRetry();
    state.submitting = false;
    if ($("screen-exam").classList.contains("active")) {
      state.examLocked = true; // prevent further answer taps writing to a dead session
      lockExamUI();
    }
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    state.token = null;
    if (logoutBtn) logoutBtn.hidden = true; // logout control is only for signed-in students
    var warn = $("sync-warning");
    if (warn) warn.hidden = true;
    showScreen("screen-gate");
    gateForm.style.display = "";
    gateError.textContent = "Your session expired, please sign in again to resume your exam. Your saved answers are safe.";
    gateError.hidden = false;
    $("exam-list-wrap").hidden = true; // hide stale cards under the gate
    gateInput.focus();
  }

  /* ---------------- submit backoff ---------------- */
  var SUBMIT_MAX_AUTO_RETRIES = 5;
  var pendingRetryKind = "grade"; // "grade" | "forfeit", what the shared Retry button redoes
  function submitBackoffMs(attempt) {
    // 2s, 4s, 8s, 16s, 32s, capped, jittered ±20% to avoid thundering herd
    var base = Math.min(32000, 2000 * Math.pow(2, attempt));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }
  function clearSubmitRetry() {
    if (state.submitRetryTimer) { clearTimeout(state.submitRetryTimer); state.submitRetryTimer = null; }
  }

  /* Persistent device id, part of the 1-password-up-to-3-devices rule.
     The server binds the first 3 device_ids it sees for a password. */
  function getDeviceId() {
    var id = null;
    try {
      id = localStorage.getItem(DEVICE_KEY);
      if (!id) {
        id = "dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(DEVICE_KEY, id);
      }
    } catch (e) { id = "dev-" + Math.random().toString(36).slice(2, 10); }
    return id;
  }

  /* ============================================================
     SCREEN 1, gate + exam list
     ============================================================ */
  var gateForm = $("gate-form"), gateInput = $("gate-password"),
      gateError = $("gate-error"), gateSubmit = $("gate-submit");

  gateForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    gateError.hidden = true;
    gateSubmit.disabled = true;
    gateSubmit.textContent = "Checking…";
    api("/api/exam-auth", { password: gateInput.value.trim(), device_id: getDeviceId() })
      .then(function (res) {
        state.token = res.token;
        state.sessionExpiredHandled = false;
        try { sessionStorage.setItem(SESSION_KEY, res.token); } catch (e) {}
        gateInput.value = ""; // never leave the password in the DOM after login
        gateForm.style.display = "none";
        if (logoutBtn) logoutBtn.hidden = false;
        loadExamList();
      })
      .catch(function (err) {
        /* COPY fix 1: device_mismatch shows the exact server message. */
        gateError.textContent = err.message || "Something went wrong. Please try again.";
        gateError.hidden = false;
        gateInput.focus(); /* A11Y K4 */
      })
      .then(function () {
        gateSubmit.disabled = false;
        gateSubmit.textContent = "Unlock";
      });
  });

  /* If a token is already in session storage, skip the gate. */
  (function restoreSession() {
    try {
      var t = sessionStorage.getItem(SESSION_KEY);
      if (t) {
        state.token = t;
        gateForm.style.display = "none";
        if (logoutBtn) logoutBtn.hidden = false;
        loadExamList();
      }
    } catch (e) {}
  })();

  /* ---------- logout control + help link (audit fix) ----------
     exam/index.html is owned by the wiring agent, so both controls are
     injected here instead of hard-coded in the HTML. The logout button
     lives in the brand bar; the help link lives in the page footer. */
  var logoutBtn = document.createElement("button");
  logoutBtn.type = "button";
  logoutBtn.id = "exam-logout";
  logoutBtn.className = "back-link";
  logoutBtn.textContent = "Log out";
  logoutBtn.hidden = true;
  logoutBtn.setAttribute("aria-label", "Log out of the exam portal");
  var brandbarInner = document.querySelector(".brandbar-inner");
  if (brandbarInner) brandbarInner.appendChild(logoutBtn);
  logoutBtn.addEventListener("click", function () {
    stopTimer();
    clearSync();
    clearSubmitRetry();
    state.submitting = false;
    state.token = null;
    state.sessionId = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    $("exam-list-wrap").hidden = true;
    var submitErr = $("submit-error");
    if (submitErr) submitErr.hidden = true;
    gateForm.style.display = "";
    gateError.hidden = true;
    gateInput.value = "";
    logoutBtn.hidden = true;
    showScreen("screen-gate");
    gateInput.focus();
  });

  var helpPara = document.createElement("p");
  helpPara.className = "page-foot-help";
  helpPara.innerHTML = 'Need help? <a href="https://www.facebook.com/profile.php?id=61594997556905" target="_blank" rel="noopener">Message SASE Practice Hub PH on Facebook</a> · <a href="/privacy.html">Privacy Policy</a>';
  var pageFoot = document.querySelector(".page-foot");
  if (pageFoot) pageFoot.appendChild(helpPara);

  function loadExamList() {
    api("/api/exam-list", { token: state.token })
      .then(function (meta) {
        var list = $("exam-list");
        list.innerHTML = "";
        (meta.exams || []).forEach(function (ex) { list.appendChild(examCard(ex)); });
        $("exam-list-wrap").hidden = false;
        /* No auto-start: an in-progress exam waits for an explicit Resume tap
           (audit fix). The Resume button on the card + the resume banner in
           beginExam stay available. */
        if (logoutBtn) logoutBtn.hidden = false;
      })
      .catch(function (err) {
        if (err.status === 401) { /* token expired: back to the gate */
          try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
          state.token = null;
          if (logoutBtn) logoutBtn.hidden = true;
          $("exam-list-wrap").hidden = true; // hide stale cards under the gate
          gateForm.style.display = "";
          gateError.textContent = err.message || "Your session expired. Please sign in again.";
          gateError.hidden = false;
        } else {
          $("exam-list-wrap").hidden = false; // error card lives inside this wrapper
          showListError(err.message || "Could not load your exams. Please try again.");
        }
      });
  }

  function showListError(msg) {
    $("list-error-text").textContent = msg;
    $("list-error").hidden = false;
  }
  $("list-error-dismiss").addEventListener("click", function () {
    $("list-error").hidden = true;
  });

  function examCard(ex) {
    var card = document.createElement("div");
    card.className = "exam-card" +
      (ex.status === "done" ? " is-done" : "") +
      (ex.status === "locked" ? " is-locked" : "");
    var statusLabel =
      ex.status === "available"  ? '<span class="exam-status status-available">Available</span>' :
      ex.status === "in_progress"? '<span class="exam-status status-inprogress">In progress</span>' :
      ex.status === "expired"    ? '<span class="exam-status status-locked">Time expired</span>' :
      ex.status === "done"       ? '<span class="exam-status status-done">Done</span>' :
                                   '<span class="exam-status status-locked">Locked</span>';
    var meta;
    if (ex.status === "done") {
      var pct = (ex.pct != null ? ex.pct : (ex.total ? Math.round(ex.score / ex.total * 1000) / 10 : null));
      meta = '<p class="exam-score">' + (pct != null ? "Done · Your score: " + pct + "%" : "Done") + "</p>";
    } else if (ex.status === "locked") {
      var unlockText = (ex.unlocks_in_ms != null ? fmtDays(ex.unlocks_in_ms) : "a few days");
      var unlockDate = "";
      if (ex.unlock_at) {
        var d = new Date(ex.unlock_at);
        if (!isNaN(d.getTime())) {
          unlockDate = " · opens " + new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric"
          }).format(d);
        }
      }
      meta = '<p class="exam-meta">Unlocks in ' + unlockText + unlockDate + "</p>";
    } else if (ex.status === "in_progress") {
      meta = '<p class="exam-meta">180 questions · 2-hour practice timer · ' +
        (ex.resume_remaining_ms != null ? fmtLong(ex.resume_remaining_ms) : "resume when ready") + "</p>";
    } else if (ex.status === "expired") {
      meta = '<p class="exam-meta">Your time ran out, view your auto-submitted result.</p>';
    } else {
      meta = '<p class="exam-meta">180 questions · 2 hours · 1 attempt</p>';
    }
    card.innerHTML =
      '<div class="exam-num">' + escapeHtml(String(ex.n)) + "</div>" +
      '<div class="exam-body"><h3>Mock Exam ' + escapeHtml(String(ex.n)) + "</h3>" + meta + statusLabel + "</div>";
    if (ex.status === "available" || ex.status === "in_progress") {
      var btn = document.createElement("button");
      btn.className = "btn btn-primary";
      btn.type = "button";
      if (ex.status === "in_progress") {
        var left = ex.resume_remaining_ms != null ? fmtLong(ex.resume_remaining_ms) : null;
        btn.textContent = left ? "Resume · " + left.replace(" remaining", " left") : "Resume";
        btn.setAttribute("aria-label", "Resume Mock Exam " + ex.n + (left ? ", " + left : ""));
      } else {
        btn.textContent = "Start";
        btn.setAttribute("aria-label", "Start Mock Exam " + ex.n); /* A11Y K15 */
      }
      btn.addEventListener("click", function () {
        /* New exams show the instructions first; resuming skips them. */
        if (ex.status === "in_progress") beginExam(ex.n); else showInstructions(ex.n);
      });
      card.appendChild(btn);
    } else if (ex.status === "expired") {
      // Expired attempts auto-grade on the next exam-questions call
      // (beginExam routes the already_submitted result to the results page).
      var ebtn = document.createElement("button");
      ebtn.className = "btn btn-secondary";
      ebtn.type = "button";
      ebtn.textContent = "View result";
      ebtn.setAttribute("aria-label", "View your Mock Exam " + ex.n + " auto-submitted result");
      ebtn.addEventListener("click", function () { beginExam(ex.n); });
      card.appendChild(ebtn);
    } else if (ex.status === "done") {
      var rbtn = document.createElement("button");
      rbtn.className = "btn btn-secondary";
      rbtn.type = "button";
      rbtn.textContent = "Review result";
      rbtn.setAttribute("aria-label", "Review your Mock Exam " + ex.n + " result and advice");
      rbtn.addEventListener("click", function () { reviewExam(ex.n, rbtn); });
      card.appendChild(rbtn);
    }
    return card;
  }

  /* Re-open a completed exam's stored result (score, advice, answer review). */
  function reviewExam(examN, btn) {
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Loading…";
    api("/api/exam-result", { token: state.token, exam: examN }).then(function (data) {
      try {
        sessionStorage.setItem(RESULT_KEY, JSON.stringify(data));
        sessionStorage.setItem(EXAM_NUM_KEY, String(examN));
      } catch (e) {}
      window.location.href = "/exam/results.html";
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = orig;
      showListError(err.message || "Could not load your result. Please try again.");
    });
  }

  /* ============================================================
     SCREEN 1b, instructions (shown before a NEW exam starts)
     ============================================================ */
  var pendingExamN = null;
  function showInstructions(examN) {
    pendingExamN = examN;
    $("instr-kicker").textContent = "Mock Exam " + examN;
    $("instr-agree").checked = false;
    $("instr-start").disabled = true;
    showScreen("screen-instructions");
    var h = $("instr-title");
    if (h) h.focus();
  }
  $("instr-agree").addEventListener("change", function () {
    $("instr-start").disabled = !this.checked;
  });
  $("instr-back").addEventListener("click", function () {
    pendingExamN = null;
    showScreen("screen-gate");
  });
  $("instr-start").addEventListener("click", function () {
    if (pendingExamN == null || !$("instr-agree").checked) return;
    var n = pendingExamN;
    pendingExamN = null;
    beginExam(n);
  });

  /* ============================================================
     SCREEN 2, exam
     ============================================================ */
  function beginExam(examN) {
    state.exam = examN;
    state.submitting = false;
    state.examLocked = false;
    state.sessionExpiredHandled = false;
    state.submitRetries = 0;
    clearSubmitRetry();
    $("submit-error").hidden = true;
    $("submitting-title").textContent = "Loading your exam…";
    showScreen("screen-submitting");
    api("/api/exam-questions", { token: state.token, exam: examN })
      .then(function (data) {
        state.sessionId = data.session_id;
        state.questions = data.questions || [];
        state.answers = data.answers || {};
        state.flagged = loadFlags(data.session_id);
        state.cellByQid = {};
        state.currentIndex = 0;
        state.announced = {};
        state.syncFailures = 0;
        state.syncFailNotified = false;
        var warn = $("sync-warning");
        if (warn) warn.hidden = true;
        /* Re-enable the persistent exam controls (a 401 recovery may have
           locked them via lockExamUI). Option buttons are rebuilt fresh. */
        ["flag-btn", "prev-btn", "next-btn", "submit-btn", "forfeit-btn"].forEach(function (id) {
          var el = $(id);
          if (el) el.disabled = false;
        });
        /* PERF F-1: deadline model, server_now + server_remaining_ms. */
        state.deadlineMs = data.server_now + data.server_remaining_ms;
        showScreen("screen-exam");
        if (data.resumed) {
          /* Explicit resume (student tapped Resume): banner with remaining from server_remaining_ms. */
          $("resume-remaining").textContent = fmtLong(data.server_remaining_ms);
          $("resume-banner").hidden = false; /* role="status" announces it (A11Y K14) */
          setTimeout(function () { $("resume-banner").hidden = true; }, 6000);
        }
        buildGrid();
        renderQuestion(true);
        startTimer();
        clearSync();       /* don't stack heartbeats across exams */
        scheduleSync();
      })
      .catch(function (err) {
        showScreen("screen-gate");
        if (err.status === 401 || err.code === "bad_token") {
          // Token died between list load and Start: reuse the shared 401 recovery.
          handleSessionExpired();
          return;
        }
        gateForm.style.display = "none";
        if (err.code === "locked") {
          var unlockDate = "";
          if (err.data && err.data.unlock_at) {
            var ud = new Date(err.data.unlock_at);
            if (!isNaN(ud.getTime())) {
              unlockDate = " Opens " + new Intl.DateTimeFormat("en-US", {
                timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric"
              }).format(ud) + ".";
            }
          }
          showListError((err.message || "This exam is locked.") +
            (err.data && err.data.unlocks_in_ms != null ? " Unlocks in " + fmtDays(err.data.unlocks_in_ms) + "." : "") + unlockDate);
        } else if (err.code === "already_submitted") {
          if (err.data && err.data.auto && err.data.result) {
            /* Auto-submitted earlier: hand the stored result to the results screen. */
            goToResults(err.data.result, examN);
            return;
          }
          /* COPY fix 2: show the exact server message (score + next-unlock info). */
          showListError(err.message || "You've already completed this exam.");
        } else if (err.code === "active_attempt") {
          showActiveAttempt(err.data, examN);
        } else {
          showListError(err.message || "Could not start the exam. Please try again.");
        }
        $("exam-list-wrap").hidden = false;
      });
  }

  function showActiveAttempt(data, attemptedExam) {
    var wrap = $("list-error");
    var other = data && data.exam;
    var left = data && data.resume_remaining_ms != null ? fmtLong(data.resume_remaining_ms) : null;
    $("list-error-text").textContent =
      (data && data.message ? data.message + " " : "You already have an active attempt. ") +
      (other && other !== attemptedExam ? "Please finish or resume Mock Exam " + other + "." : "");
    wrap.hidden = false;
    if (other) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-primary";
      btn.style.marginTop = "10px";
      btn.textContent = "Resume Mock Exam " + other + (left ? " · " + left.replace(" remaining", " left") : "");
      btn.setAttribute("aria-label", "Resume Mock Exam " + other + (left ? ", " + left : ""));
      btn.addEventListener("click", function () { wrap.hidden = true; beginExam(other); });
      $("list-error-text").appendChild(document.createElement("br"));
      $("list-error-text").appendChild(btn);
    }
  }

  /* ----- timer: deadline model, threshold-only announcements ----- */
  function startTimer() {
    stopTimer();
    tickTimer();
    state.timerId = setInterval(tickTimer, 1000);
  }
  function stopTimer() {
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
  }
  function announce(text) { $("timer-live").textContent = text; }
  function tickTimer() {
    var remaining = Math.max(0, state.deadlineMs - Date.now());
    renderTimer(remaining);
    /* A11Y K5: announce only at thresholds, never per second. */
    ANNOUNCE_THRESHOLDS.forEach(function (t) {
      if (remaining <= t.sec * 1000 && !state.announced[t.sec]) {
        state.announced[t.sec] = true;
        announce(t.text);
      }
    });
    if (remaining <= 0) {
      stopTimer();
      announce("Your time is up. Submitting your exam now.");
      autoSubmit();
    }
  }
  function renderTimer(remaining) {
    var t = $("timer-text"), f = $("timer-fill"), track = f.parentElement;
    t.textContent = fmtTime(remaining);
    var frac = Math.max(0, Math.min(1, remaining / EXAM_DURATION_MS));
    f.style.transform = "scaleX(" + frac + ")"; /* PERF F-4: transform, not width */
    track.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
    var danger = remaining <= LOW_TIME_MS;
    t.classList.toggle("danger", danger);
    f.classList.toggle("danger", danger);
  }

  /* On returning to a visible tab, re-sync with the server and recompute the deadline (PERF F-1). */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (!$("screen-exam").classList.contains("active") || state.submitting || state.examLocked) return;
    syncProgressNow().then(function (res) {
      if (res && res.server_remaining_ms != null && res.server_now != null) {
        state.deadlineMs = res.server_now + res.server_remaining_ms;
        tickTimer();
      }
    });
  });

  /* ----- question rendering (no smooth scroll on answer taps, PERF F-2) ----- */
  function currentQ() { return state.questions[state.currentIndex]; }

  function renderQuestion(scroll) {
    var q = currentQ();
    if (!q) return;
    $("q-section").textContent = q.section || "";
    $("q-number").textContent = "Question " + (q.number != null ? q.number : state.currentIndex + 1);
    var qp = $("q-passage");
    if (q.passage) { qp.textContent = q.passage; qp.hidden = false; }
    else { qp.textContent = ""; qp.hidden = true; }
    $("q-text").textContent = q.question || "";
    renderOptions(q);
    updateProgress();
    updateGridCell(q.qid);
    if (scroll) {
      /* Jump straight to the top of the question: instant and reliable on
         mobile (smooth scrollIntoView proved flaky), then replay the card's
         enter animation so the question change feels alive. */
      window.scrollTo(0, 0);
      var card = document.querySelector(".qcard");
      if (card) {
        card.classList.remove("q-enter");
        void card.offsetWidth;
        card.classList.add("q-enter");
      }
    }
  }

  /* Roving-tabindex radiogroup with arrow-key navigation (A11Y K7). */
  function renderOptions(q) {
    var flagBtn = $("flag-btn");
    flagBtn.setAttribute("aria-pressed", state.flagged[q.qid] ? "true" : "false");

    var box = $("q-options");
    box.innerHTML = "";
    var letters = Object.keys(q.options || {});
    letters.forEach(function (letter, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "option" + (state.answers[q.qid] === letter ? " selected" : "");
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", state.answers[q.qid] === letter ? "true" : "false");
      b.dataset.letter = letter;
      /* Roving tabindex: answered option (or first) is tabbable. */
      var tabbable = state.answers[q.qid]
        ? state.answers[q.qid] === letter
        : i === 0;
      b.tabIndex = tabbable ? 0 : -1;
      b.innerHTML = '<span class="opt-letter" aria-hidden="true">' + escapeHtml(letter) + "</span>" +
                    "<span>" + escapeHtml(q.options[letter]) + "</span>" +
                    '<span class="opt-check" aria-hidden="true">✓</span>';
      b.addEventListener("click", function () { selectAnswer(letter, false); });
      b.addEventListener("keydown", function (ev) {
        var idx = letters.indexOf(letter), target = null;
        if (ev.key === "ArrowDown" || ev.key === "ArrowRight") target = letters[(idx + 1) % letters.length];
        else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") target = letters[(idx - 1 + letters.length) % letters.length];
        else if (ev.key === "Home") target = letters[0];
        else if (ev.key === "End") target = letters[letters.length - 1];
        if (target) { ev.preventDefault(); selectAnswer(target, true); }
      });
      box.appendChild(b);
    });
  }

  function selectAnswer(letter, moveFocus) {
    if (state.examLocked) return;
    var q = currentQ();
    if (!q) return;
    state.answers[q.qid] = letter;
    syncProgressSoon();
    var box = $("q-options");
    var btns = box.querySelectorAll(".option");
    for (var i = 0; i < btns.length; i++) {
      var sel = btns[i].dataset.letter === letter;
      btns[i].classList.toggle("selected", sel);
      btns[i].setAttribute("aria-checked", sel ? "true" : "false");
      btns[i].tabIndex = sel ? 0 : -1;
      if (moveFocus && sel) btns[i].focus();
    }
    updateProgress();
    updateGridCell(q.qid);
  }

  function updateProgress() {
    var answered = Object.keys(state.answers).length;
    var total = state.questions.length;
    $("progress-text").textContent = "Question " + (state.currentIndex + 1) + " of " + total + " · " + answered + " answered";
    $("progress-fill").style.transform = "scaleX(" + (total ? answered / total : 0) + ")";
    $("progress-fill").parentElement.setAttribute("aria-valuenow", String(total ? Math.round(answered / total * 100) : 0));
    var prev = $("prev-btn");
    prev.disabled = state.currentIndex === 0;
    prev.style.opacity = state.currentIndex === 0 ? ".4" : "1";
  }

  $("prev-btn").addEventListener("click", function () {
    if (state.currentIndex > 0) { state.currentIndex--; renderQuestion(true); }
  });
  $("next-btn").addEventListener("click", function () {
    if (state.currentIndex < state.questions.length - 1) { state.currentIndex++; renderQuestion(true); }
  });
  $("flag-btn").addEventListener("click", function () {
    if (state.examLocked) return;
    var q = currentQ();
    if (!q) return;
    if (state.flagged[q.qid]) delete state.flagged[q.qid]; else state.flagged[q.qid] = true;
    saveFlags();
    syncProgressSoon();
    renderQuestion(false); /* no scroll on flag toggle */
  });

  /* Flags are a local study aid (the server only stores answers), so keep
     them in sessionStorage per attempt so a refresh doesn't wipe them. */
  function flagKey(sid) { return "sase_exam_flags_" + sid; }
  function loadFlags(sid) {
    try {
      var raw = sessionStorage.getItem(flagKey(sid));
      var obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === "object") ? obj : {};
    } catch (e) { return {}; }
  }
  function saveFlags() {
    try { sessionStorage.setItem(flagKey(state.sessionId), JSON.stringify(state.flagged)); } catch (e) {}
  }

  /* ----- question grid navigator ----- */
  function buildGrid() {
    var grid = $("grid");
    grid.innerHTML = "";
    state.questions.forEach(function (q, i) {
      var cell = document.createElement("button");
      cell.type = "button";
      cell.className = "grid-cell";
      cell.innerHTML = escapeHtml(String(q.number != null ? q.number : i + 1));
      cell.addEventListener("click", function () {
        state.currentIndex = i;
        closeDialog();
        renderQuestion(true);
      });
      state.cellByQid[q.qid] = cell;
      grid.appendChild(cell);
    });
    state.questions.forEach(function (q) { updateGridCell(q.qid); });
  }

  /* A11Y K8: cell state in the accessible name. */
  function updateGridCell(qid) {
    var cell = state.cellByQid[qid];
    if (!cell) return;
    var idx = -1;
    for (var i = 0; i < state.questions.length; i++) {
      if (state.questions[i].qid === qid) { idx = i; break; }
    }
    cell.classList.toggle("answered", !!state.answers[qid]);
    cell.classList.toggle("current", idx === state.currentIndex);
    var label = "Question " + (idx + 1) +
      (state.answers[qid] ? ", answered" : ", skipped") +
      (state.flagged[qid] ? ", flagged for review" : "") +
      (idx === state.currentIndex ? ", current question" : "");
    cell.setAttribute("aria-label", label);
    var mark = cell.querySelector(".flag-mark");
    if (state.flagged[qid] && !mark) {
      var s = document.createElement("span");
      s.className = "flag-mark";
      s.setAttribute("aria-hidden", "true");
      s.textContent = "⚑";
      cell.appendChild(s);
    } else if (!state.flagged[qid] && mark) { mark.remove(); }
  }

  /* ----- accessible dialogs: aria-modal, focus trap, Escape, focus return (A11Y K2) ----- */
  var FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  var openOverlay = null, dialogTrigger = null;

  function openDialog(overlayId) {
    dialogTrigger = document.activeElement;
    openOverlay = $(overlayId);
    openOverlay.hidden = false;
    var dialog = openOverlay.querySelector('[role="dialog"]');
    var heading = dialog.querySelector("h2, h3");
    if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus(); }
    document.addEventListener("keydown", trapKeys, true);
  }
  function closeDialog() {
    if (!openOverlay) return;
    openOverlay.hidden = true;
    openOverlay = null;
    document.removeEventListener("keydown", trapKeys, true);
    if (dialogTrigger && dialogTrigger.focus) dialogTrigger.focus();
  }
  function trapKeys(e) {
    if (!openOverlay) return;
    if (e.key === "Escape") { e.preventDefault(); closeDialog(); return; }
    if (e.key !== "Tab") return;
    var dialog = openOverlay.querySelector('[role="dialog"]');
    var items = dialog.querySelectorAll(FOCUSABLE);
    var focusables = [];
    for (var i = 0; i < items.length; i++) {
      if (!items[i].disabled && items[i].offsetParent !== null) focusables.push(items[i]);
    }
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    // Focus may sit on the dialog heading (tabindex="-1", not in the
    // focusable list), keep the trap closed from there too.
    if (focusables.indexOf(document.activeElement) === -1) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  $("grid-toggle").addEventListener("click", function () { openDialog("grid-overlay"); });
  $("grid-close").addEventListener("click", closeDialog);
  $("grid-overlay").addEventListener("click", function (e) { if (e.target === this) closeDialog(); });
  $("confirm-cancel").addEventListener("click", closeDialog);
  $("confirm-overlay").addEventListener("click", function (e) { if (e.target === this) closeDialog(); });
  $("forfeit-cancel").addEventListener("click", closeDialog);
  $("forfeit-overlay").addEventListener("click", function (e) { if (e.target === this) closeDialog(); });

  /* ----- progress sync: debounced 1.5s + 30s heartbeat + sendBeacon on pagehide ----- */
  function progressBody() {
    return { token: state.token, exam: state.exam, session_id: state.sessionId, answers: state.answers };
  }
  function syncProgressSoon() {
    clearTimeout(state.syncDebounceId);
    state.syncDebounceId = setTimeout(syncProgressNow, SYNC_DEBOUNCE_MS);
  }
  var SYNC_FAIL_BANNER_AFTER = 2; // show banner after 2 consecutive failures
  function syncProgressNow() {
    if (!state.token || !state.sessionId || state.submitting || state.examLocked) return Promise.resolve(null);
    return api("/api/exam-progress", progressBody()).then(function (res) {
      state.syncFailures = 0;
      state.syncFailNotified = false;
      var warn = $("sync-warning");
      if (warn) warn.hidden = true;
      // Deadline correction from the server clock, free with every sync.
      if (res && res.server_remaining_ms != null && res.server_now != null) {
        var oldDeadline = state.deadlineMs;
        state.deadlineMs = res.server_now + res.server_remaining_ms;
        if (Math.abs(state.deadlineMs - oldDeadline) > 5000) tickTimer(); // >5s jump: repaint now
      }
      return res;
    }, function (err) {
      if (err && err.status === 410) { /* PERF contract: timer expired → lock UI and auto-submit */
        state.examLocked = true;
        lockExamUI();
        autoSubmit();
        return null;
      }
      if (err && err.status === 401) { handleSessionExpired(); return null; }
      state.syncFailures++;
      if (state.syncFailures >= SYNC_FAIL_BANNER_AFTER && !state.syncFailNotified) {
        state.syncFailNotified = true;
        var warnEl = $("sync-warning");
        if (warnEl) {
          $("sync-warning-text").textContent =
            (err && err.status === 403)
              ? "Your session is no longer valid on this device, your latest answers may not be saving. Please reload the page and sign in again to resume."
              : "Connection lost, your latest answers may not be saving. Please check your connection. Your saved answers are safe on the server.";
          warnEl.hidden = false;
        }
      }
      return null; /* heartbeat retries; banner stays until a sync succeeds */
    });
  }
  function scheduleSync() {
    state.syncIntervalId = setInterval(function () { syncProgressNow(); }, SYNC_HEARTBEAT_MS);
  }
  function clearSync() {
    clearTimeout(state.syncDebounceId);
    if (state.syncIntervalId) { clearInterval(state.syncIntervalId); state.syncIntervalId = null; } /* PERF F-5 */
  }
  /* PERF F-3: sendBeacon on pagehide, fetch is not guaranteed to complete. */
  window.addEventListener("pagehide", function () {
    if (!state.token || !state.sessionId || state.submitting) return;
    try { navigator.sendBeacon("/api/exam-progress", JSON.stringify(progressBody())); } catch (e) {}
  });

  function lockExamUI() {
    var opts = $("q-options").querySelectorAll(".option");
    for (var i = 0; i < opts.length; i++) opts[i].disabled = true;
    $("flag-btn").disabled = true;
    $("prev-btn").disabled = true;
    $("next-btn").disabled = true;
    $("submit-btn").disabled = true;
    $("forfeit-btn").disabled = true;
  }

  /* ----- submit flow ----- */
  function openConfirm() {
    if (state.examLocked) return;
    pendingRetryKind = "grade";
    var answered = Object.keys(state.answers).length;
    var total = state.questions.length;
    var skipped = total - answered;
    var flagged = Object.keys(state.flagged).length;
    $("confirm-text").textContent =
      "You have answered " + answered + " of " + total + " questions" +
      (skipped ? " (" + skipped + " skipped)" : "") + /* COPY fix 4: "Skipped" everywhere */
      (flagged ? ", " + flagged + " flagged for review." : ".");
    openDialog("confirm-overlay");
  }
  $("submit-btn").addEventListener("click", openConfirm);
  $("grid-submit").addEventListener("click", function () { closeDialog(); openConfirm(); });
  $("confirm-ok").addEventListener("click", function () {
    closeDialog();
    state.submissionId = randomUUID(); /* per submit click; reused on retry (idempotent) */
    doSubmit(false);
  });

  function autoSubmit() {
    stopTimer();
    if (!state.submitting) {
      if (!state.submissionId) state.submissionId = randomUUID();
      doSubmit(true);
    }
  }

  function doSubmit(auto) {
    if (state.submitting) return;
    stopTimer();
    closeDialog();
    $("submitting-title").textContent = "Grading your exam…";
    showScreen("screen-submitting");
    /* Final sync BEFORE the submitting guard goes up: syncProgressNow()
       early-returns while state.submitting is true, so the sync must run
       first. This is the only sync that can still save answers tapped
       in the last debounce window before expiry. */
    syncProgressNow().then(function () {
      state.submitting = true;
      clearSync(); /* PERF F-5, now safe: final sync already flushed */
      return api("/api/exam-grade", {
        token: state.token, exam: state.exam, session_id: state.sessionId,
        answers: state.answers, submission_id: state.submissionId
      }, API_GRADE_TIMEOUT_MS);
    }).then(function (result) {
      state.submitRetries = 0;
      goToResults(result, state.exam);
    }).catch(function (err) {
      handleSubmitError(err, auto);
    });
  }

  function handleSubmitError(err, auto) {
    state.submitting = false;
    clearSubmitRetry();
    if (err && err.status === 401) { handleSessionExpired(); return; } // see 401 recovery
    pendingRetryKind = "grade";
    if (auto && state.submitRetries < SUBMIT_MAX_AUTO_RETRIES) {
      // AUTO path: STAY on the submitting screen. Never re-open the exam,
      // never restart the timer. Backoff, then retry the SAME submission_id.
      var delay = submitBackoffMs(state.submitRetries);
      state.submitRetries++;
      $("submitting-title").textContent = "Grading your exam…";
      showScreen("screen-submitting");
      $("submit-error-text").textContent =
        "Could not reach the server, retrying in " + Math.round(delay / 1000) +
        "s (attempt " + state.submitRetries + " of " + SUBMIT_MAX_AUTO_RETRIES + "). " +
        "Your answers are safe on this screen. Your time has expired.";
      $("submit-error").hidden = false;
      state.submitRetryTimer = setTimeout(function () {
        state.submitRetryTimer = null;
        if (!state.submissionId) state.submissionId = randomUUID();
        doSubmit(true);
      }, delay);
      return;
    }
    if (auto) {
      // Cap exhausted: stay on submitting screen with a MANUAL retry button.
      $("submitting-title").textContent = "Grading your exam…";
      showScreen("screen-submitting");
      $("submit-error-text").textContent =
        "The server is still unreachable after several tries. Tap Try again to retry, " +
        "your answers are safe. Your time has expired.";
      $("submit-error").hidden = false;
      return;
    }
    // MANUAL path: unchanged behaviour, back to exam + inline error + retry.
    showScreen("screen-exam");
    $("submit-error-text").textContent =
      (err.message || "Could not submit, please check your connection and try again.");
    $("submit-error").hidden = false;
    startTimer();   // doSubmit() stopped the countdown; without this the clock froze on screen
    clearSync();    // never stack a second heartbeat
    scheduleSync(); // restore heartbeat lost by clearSync()
  }
  $("submit-retry").addEventListener("click", function () {
    $("submit-error").hidden = true;
    clearSubmitRetry();
    if (pendingRetryKind === "forfeit") { retryForfeit(); } // forfeit-specific retry
    else { state.submitRetries = 0; doSubmit(false); }
  });

  function goToResults(result, examN) {
    try {
      sessionStorage.setItem(RESULT_KEY, JSON.stringify(result));
      sessionStorage.setItem(EXAM_NUM_KEY, String(examN));
    } catch (e) {}
    window.location.href = "/exam/results.html";
  }

  /* ----- forfeit flow ----- */
  $("forfeit-btn").addEventListener("click", function () {
    if (state.examLocked) return;
    var answered = Object.keys(state.answers).length;
    var total = state.questions.length;
    var skipped = total - answered;
    var flagged = Object.keys(state.flagged).length;
    $("forfeit-text").textContent =
      "Giving up counts as your one attempt for this exam. Your saved answers will be graded.";
    $("forfeit-counts").textContent =
      "You have answered " + answered + " of " + total + " questions" +
      (skipped ? " (" + skipped + " skipped)" : "") +
      (flagged ? ", " + flagged + " flagged for review." : ".") +
      " Answers from the last moment will be saved before grading.";
    openDialog("forfeit-overlay");
  });
  $("forfeit-ok").addEventListener("click", function () {
    closeDialog();
    if (state.submitting) return;
    stopTimer();
    $("submitting-title").textContent = "Grading your exam…";
    showScreen("screen-submitting");
    /* Flush pending answers BEFORE forfeit: forfeit grades saved answers
       only, so an unflushed debounce would silently drop the last answer(s).
       The forfeit body also carries current answers (server merges them when
       the timer has not expired) as belt-and-braces. */
    syncProgressNow().then(function () {
      state.submitting = true;
      clearSync();
      return api("/api/exam-forfeit", {
        token: state.token, exam: state.exam, session_id: state.sessionId,
        answers: state.answers
      });
    }).then(function (result) { goToResults(result, state.exam); })
      .catch(function (err) { handleForfeitError(err); });
  });

  function handleForfeitError(err) {
    state.submitting = false;
    clearSubmitRetry();
    if (err && err.status === 401) { handleSessionExpired(); return; }
    pendingRetryKind = "forfeit"; // the shared Retry button must redo FORFEIT, not grade
    showScreen("screen-exam");
    // Restore the exam's live machinery: timer + heartbeat were killed at forfeit start.
    startTimer();
    clearSync();
    scheduleSync();
    $("submit-error-text").textContent =
      (err.message || "Could not give up, please check your connection and try again.") +
      " Your attempt is still active. Tap Try again to retry giving up, or keep answering.";
    $("submit-error").hidden = false;
  }

  function retryForfeit() {
    if (state.submitting) return;
    stopTimer();
    $("submitting-title").textContent = "Grading your exam…";
    showScreen("screen-submitting");
    // No re-sync needed on retry: the first attempt already flushed,
    // and any answers tapped since are flushed by the restored heartbeat/debounce.
    state.submitting = true;
    clearSync();
    api("/api/exam-forfeit", {
      token: state.token, exam: state.exam, session_id: state.sessionId,
      answers: state.answers
    })
      .then(function (result) { goToResults(result, state.exam); })
      .catch(function (err) { handleForfeitError(err); });
  }

  /* Warn before accidental navigation mid-exam (does not stop the server timer) */
  window.addEventListener("beforeunload", function (e) {
    if ($("screen-exam").classList.contains("active") && !state.submitting) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  /* Anti-copy: during the exam, questions & choices can't be selected, right-clicked, or Ctrl/C-copied. */
  (function antiCopy() {
    var card = document.querySelector(".qcard");
    if (!card) return;
    card.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    card.addEventListener("copy", function (e) { e.preventDefault(); });
    card.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey;
      var k = (e.key || "").toLowerCase();
      if (mod && (k === "c" || k === "x")) { e.preventDefault(); }
    });
  })();

})();
