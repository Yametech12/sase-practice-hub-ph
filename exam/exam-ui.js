/* ============================================================
   SASE Mock Exam Portal, exam-taking UI logic (vanilla JS)
   ------------------------------------------------------------
   BACKEND API (exact field names per contract):
     POST /api/exam-auth      {password, device_id} → 200 {token, track}
     POST /api/exam-list      {token} → 200 {exams:[...], server_now, track, exam_ms}
     POST /api/exam-lessons   {token} → 200 {track, lessons:[...]}
        (Both tracks; the token's track decides which library is served.
         The lesson list is paid content and is never present in any
         static file.)
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
  var EXAM_DURATION_MS = 2 * 60 * 60 * 1000; // 2-hour practice timer (SASE default)
  var LOW_TIME_MS = 15 * 60 * 1000;          // danger styling under 15 min
  /* localStorage watched check-off key, per track (per device):
     "sase_lessons_watched" / "cse_lessons_watched". */
  function watchedKey() { return state.track === "cse" ? "cse_lessons_watched" : "sase_lessons_watched"; }

  /* Track profiles: the portal serves two products. The token's track
     (returned by exam-auth / exam-list) picks the copy, counts, and timer.
     SASE values below are exactly the copy this page always shipped. */
  var TRACK_PROFILES = {
    sase: {
      title: "SASE Mock Exam Portal",
      docTitle: "SASE Mock Exam, SASE Practice Hub PH",
      brand: "SASE Practice Hub PH",
      subtitle: "Eight full-length mock exams · 180 questions each · 2-hour practice timer.",
      disclaimer: 'This is a <strong>practice exam</strong> for preparation only. It is not the official MSU-SASE and is not affiliated with MSU.',
      fieldLabel: "Enter your reviewer password",
      fieldHint: "Use the same unique password that came with your ₱167 PDF.",
      gateNote: 'One password works on <strong>up to 3 devices</strong>. Lost access? Message SASE Practice Hub PH.',
      listSub: 'All 8 exams are open right away, no waiting. Each exam can be taken <strong>once</strong>.',
      foot: "SASE Practice Hub PH · Practice exams for study purposes only, not the official MSU-SASE.",
      questions: 180,
      durationMs: EXAM_DURATION_MS,
      durationShort: "2 hours",
      durationFact: "2 hrs",
      breakdown: "Language Usage 80, Mathematics 40, Aptitude 30, Science 30",
      sections: [["Language Usage", 80], ["Mathematics", 40], ["Aptitude", 30], ["Science", 30]],
      instrNote: "Find a quiet spot and a stable connection first. Questions can't be copied during the exam. This is practice material, not the official MSU-SASE."
    },
    cse: {
      title: "Civil Service Mock Exams",
      docTitle: "Civil Service Mock Exams, Practice Portal",
      brand: "Civil Service Reviewer",
      subtitle: "Eight full mock exams · 150 questions each · 3 hours 10 minutes, the real exam time limit.",
      disclaimer: 'This is a <strong>practice exam</strong> for preparation only. It is not the official Civil Service Exam and is not affiliated with the Civil Service Commission.',
      fieldLabel: "Enter your CSE7 access code",
      fieldHint: "Use the CSE7 access code sent with your Civil Service reviewer. It is separate from your PDF password.",
      gateNote: 'One access code works on <strong>up to 3 devices</strong>. Lost access? Message us on Facebook.',
      listSub: 'All 8 exams are open right away, no waiting. Each exam can be taken <strong>once</strong>. Results are benchmarked against the real passing general rating of <strong>80.00</strong>.',
      foot: "Civil Service Reviewer · Practice exams for study purposes only, not the official Civil Service Exam.",
      questions: 150,
      durationMs: (3 * 60 + 10) * 60 * 1000,
      durationShort: "3 hours 10 minutes",
      durationFact: "3h 10m",
      breakdown: "Verbal 52, Numerical 38, Analytical 30, General Information 30",
      sections: [["Verbal", 52], ["Numerical", 38], ["Analytical", 30], ["General Information", 30]],
      instrNote: "Find a quiet spot and a stable connection first. Questions can't be copied during the exam. This is practice material, not the official Civil Service Exam."
    }
  };
  function profile() { return TRACK_PROFILES[state.track] || TRACK_PROFILES.sase; }
  var SYNC_DEBOUNCE_MS = 1500;
  var SYNC_HEARTBEAT_MS = 30000;
  /* Track separation (owner order Nov 11, 2026, "E lahi na sila"): each
     product keeps its OWN session slot, so a stored SASE session can never
     swallow a Civil Service entry or the other way around. The pre-split
     single key is migrated into its token's track slot on first load. */
  var LEGACY_SESSION_KEY = "sase_exam_session"; // pre-separation single key
  var SESSION_KEYS = { sase: "portal_session_sase", cse: "portal_session_cse" };
  var LAST_TRACK_KEY = "portal_last_track";  // localStorage: last track used here
  var RESULT_TRACK_KEY = "portal_result_track"; // sessionStorage: track of the stored result
  function sessionKeyFor(track) { return SESSION_KEYS[track === "cse" ? "cse" : "sase"]; }
  function getStoredSession(track) {
    try { return sessionStorage.getItem(sessionKeyFor(track)); } catch (e) { return null; }
  }
  function storeSession(track, tok) {
    try { sessionStorage.setItem(sessionKeyFor(track), tok); } catch (e) {}
    try { localStorage.setItem(LAST_TRACK_KEY, track === "cse" ? "cse" : "sase"); } catch (e) {}
  }
  function clearSession(track) {
    try { sessionStorage.removeItem(sessionKeyFor(track)); } catch (e) {}
  }
  function migrateLegacySession() {
    try {
      var t = sessionStorage.getItem(LEGACY_SESSION_KEY);
      if (t) {
        sessionStorage.setItem(sessionKeyFor(tokenTrack(t)), t);
        sessionStorage.removeItem(LEGACY_SESSION_KEY);
      }
    } catch (e) {}
  }
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
    track: "sase",         // "sase" | "cse", from auth/list responses
    durationMs: EXAM_DURATION_MS, // per-track timer length (list response exam_ms wins)
    lessons: null,         // lessons array from /api/exam-lessons (per track)
    lessonsFilter: "all",  // lessons section filter
    homeTab: "exams",      // home screen section tab: "exams" | "lessons"
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
    clearSession(state.track); // only this track's slot; the other product's session survives
    state.token = null;
    state.lessons = null; // per-track cache must not survive into the next login
    state.lessonsFilter = "all";
    state.lessonsLoading = false;
    if (logoutBtn) logoutBtn.hidden = true; // logout control is only for signed-in students
    var warn = $("sync-warning");
    if (warn) warn.hidden = true;
    var lw = $("lessons-wrap");
    if (lw) lw.hidden = true; // paid lesson content leaves the DOM flow on sign-out
    state.homeTab = "exams";
    var htExp = $("home-tabs");
    if (htExp) htExp.hidden = true;
    applyTrackChrome(); // gate falls back branded for THIS track, switch link hides with no token
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
        state.track = res.track === "cse" ? "cse" : "sase";
        state.durationMs = profile().durationMs;
        state.sessionExpiredHandled = false;
        /* The lessons cache is per track: never let a previous session's
           library render for a new login (audit finding, Nov 11, 2026). */
        state.lessons = null;
        state.lessonsFilter = "all";
        state.lessonsLoading = false;
        storeSession(state.track, res.token); // this track's own slot only
        gateInput.value = ""; // never leave the password in the DOM after login
        gateForm.style.display = "none";
        if (logoutBtn) logoutBtn.hidden = false;
        applyTrackChrome();
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

  /* Track-aware entry (owner report Nov 11, 2026): landing pages link here
     with ?track=cse or ?track=sase. A stored session from the OTHER track
     must not swallow the entry: a Civil Service buyer who still holds a
     SASE session landed straight on the SASE exams and never saw the CSE
     gate. The token payload carries its track (UX routing only; the
     server still verifies the signature on every call). */
  function requestedTrack() {
    try {
      var t = new URLSearchParams(window.location.search).get("track");
      return t === "cse" || t === "sase" ? t : null;
    } catch (e) { return null; }
  }
  function tokenTrack(tok) {
    try {
      var body = tok.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      while (body.length % 4) body += "=";
      var p = JSON.parse(atob(body));
      return p && p.track === "cse" ? "cse" : "sase";
    } catch (e) { return null; }
  }

  /* Restore the session for the track the visitor actually entered.
     Sessions live in per-track slots, so entering one product can never
     surface the other product's exams. With an explicit ?track= entry,
     only that track's slot is restored (or its gate is branded). With a
     plain entry, the last-used track's session wins, then the other
     track's; with no session at all, the gate opens on the last-used
     track with the SASE / Civil Service toggle on top. */
  function restoreWithToken(t) {
    state.token = t;
    /* Brand the portal for the stored session's track BEFORE the
       list call, so an expired CSE session falls back to a CSE gate,
       not the static SASE defaults (audit finding, Nov 11, 2026). */
    state.track = tokenTrack(t) || "sase";
    try { localStorage.setItem(LAST_TRACK_KEY, state.track); } catch (e) {}
    state.durationMs = profile().durationMs;
    applyTrackChrome();
    gateForm.style.display = "none";
    if (logoutBtn) logoutBtn.hidden = false;
    loadExamList();
  }
  function brandGate(track) {
    state.track = track === "cse" ? "cse" : "sase";
    state.durationMs = profile().durationMs;
    applyTrackChrome();
    gateInput.placeholder = state.track === "cse" ? "e.g. CSE7-XXXX-XXXX" : "e.g. Xk9mQ2vT7pLz";
  }
  (function restoreSession() {
    migrateLegacySession();
    var want = requestedTrack();
    if (want) {
      var t = getStoredSession(want);
      if (t) { restoreWithToken(t); return; }
      brandGate(want);
      return;
    }
    var last = null;
    try { last = localStorage.getItem(LAST_TRACK_KEY); } catch (e) {}
    var order = last === "cse" ? ["cse", "sase"] : ["sase", "cse"];
    for (var i = 0; i < order.length; i++) {
      var tok = getStoredSession(order[i]);
      if (tok) { restoreWithToken(tok); return; }
    }
    brandGate(last === "cse" ? "cse" : "sase");
  })();

  /* Gate track toggle: the two products share one gate URL, so the buyer
     picks their product first. Picking a track with a stored session
     restores straight into that product; otherwise the gate rebrands. */
  function syncGateToggle() {
    var bs = $("gate-track-sase"), bc = $("gate-track-cse");
    if (bs) { bs.classList.toggle("active", state.track !== "cse"); bs.setAttribute("aria-pressed", state.track !== "cse" ? "true" : "false"); }
    if (bc) { bc.classList.toggle("active", state.track === "cse"); bc.setAttribute("aria-pressed", state.track === "cse" ? "true" : "false"); }
  }
  function chooseGateTrack(track) {
    var t = getStoredSession(track);
    if (t) { restoreWithToken(t); return; }
    brandGate(track);
    gateError.hidden = true;
    gateInput.value = "";
    gateInput.focus();
  }
  var gateTrackSaseBtn = $("gate-track-sase");
  if (gateTrackSaseBtn) gateTrackSaseBtn.addEventListener("click", function () { chooseGateTrack("sase"); });
  var gateTrackCseBtn = $("gate-track-cse");
  if (gateTrackCseBtn) gateTrackCseBtn.addEventListener("click", function () { chooseGateTrack("cse"); });

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
  /* Switch-portal link: always one tap from the other product's portal
     (its own session restores if one exists, otherwise its gate). */
  var switchLink = document.createElement("a");
  switchLink.id = "portal-switch";
  switchLink.className = "back-link";
  switchLink.textContent = "Civil Service portal";
  switchLink.href = "/exam?track=cse";
  switchLink.hidden = true;
  switchLink.setAttribute("aria-label", "Switch to the other exam portal");
  if (brandbarInner) brandbarInner.insertBefore(switchLink, logoutBtn);
  logoutBtn.addEventListener("click", function () {
    var leavingTrack = state.track; // clear THIS track's slot before the chrome reset below
    stopTimer();
    clearSync();
    clearSubmitRetry();
    state.submitting = false;
    state.token = null;
    state.sessionId = null;
    state.track = "sase";       // reset chrome so the next login starts clean
    state.lessons = null;
    state.lessonsFilter = "all";
    state.homeTab = "exams";
    var homeTabsOnOut = $("home-tabs");
    if (homeTabsOnOut) homeTabsOnOut.hidden = true;
    applyTrackChrome();
    clearSession(leavingTrack); // the other product's stored session is untouched
    $("exam-list-wrap").hidden = true;
    var lessonsWrapOnOut = $("lessons-wrap");
    if (lessonsWrapOnOut) lessonsWrapOnOut.hidden = true; // paid lessons leave with the session
    var submitErr = $("submit-error");
    if (submitErr) submitErr.hidden = true;
    gateForm.style.display = "";
    gateError.hidden = true;
    gateInput.value = "";
    logoutBtn.hidden = true;
    showScreen("screen-gate");
    gateInput.focus();
  });

  /* Home screen section tabs (owner order Nov 11, 2026): Video Lessons get
     their own section inside the portal, next to Mock Exams. The two wraps
     stay in the DOM once; the tabs only switch which one is visible. */
  function setHomeTab(tab) {
    state.homeTab = tab === "lessons" ? "lessons" : "exams";
    var tabs = $("home-tabs");
    if (tabs && state.token) tabs.hidden = false;
    var exBtn = $("tab-exams"), lsBtn = $("tab-lessons");
    if (exBtn) {
      exBtn.classList.toggle("active", state.homeTab === "exams");
      exBtn.setAttribute("aria-pressed", state.homeTab === "exams" ? "true" : "false");
    }
    if (lsBtn) {
      lsBtn.classList.toggle("active", state.homeTab === "lessons");
      lsBtn.setAttribute("aria-pressed", state.homeTab === "lessons" ? "true" : "false");
    }
    var listWrap = $("exam-list-wrap");
    if (listWrap && state.token) listWrap.hidden = state.homeTab !== "exams";
    var lessonsWrap = $("lessons-wrap");
    if (lessonsWrap) lessonsWrap.hidden = state.homeTab !== "lessons" || !state.token;
    if (state.homeTab === "lessons") loadLessons();
  }
  var tabExamsBtn = $("tab-exams");
  if (tabExamsBtn) tabExamsBtn.addEventListener("click", function () { setHomeTab("exams"); });
  var tabLessonsBtn = $("tab-lessons");
  if (tabLessonsBtn) tabLessonsBtn.addEventListener("click", function () { setHomeTab("lessons"); });

  var helpPara = document.createElement("p");
  helpPara.className = "page-foot-help";
  helpPara.innerHTML = 'Need help? <a href="https://www.facebook.com/profile.php?id=61594997556905" target="_blank" rel="noopener">Message SASE Practice Hub PH on Facebook</a> · <a href="/privacy.html">Privacy Policy</a>';
  var pageFoot = document.querySelector(".page-foot");
  if (pageFoot) pageFoot.appendChild(helpPara);

  /* Rewrite the gate/instructions chrome for the signed-in track. Called
     after auth and after every list load; SASE values are the page's
     original copy, so SASE buyers see zero change. */
  function applyTrackChrome() {
    var pr = profile();
    document.title = pr.docTitle;
    var set = function (id, html) { var el = $(id); if (el) el.innerHTML = html; };
    set("gate-title", escapeHtml(pr.title));
    set("gate-subtitle", escapeHtml(pr.subtitle));
    set("gate-disclaimer", pr.disclaimer);
    set("field-label", escapeHtml(pr.fieldLabel));
    set("field-hint", escapeHtml(pr.fieldHint));
    set("gate-note", pr.gateNote);
    set("list-sub", pr.listSub);
    set("brand-name", escapeHtml(pr.brand));
    set("foot-text", escapeHtml(pr.foot));
    var cseHint = $("gate-cse-hint");
    if (cseHint) cseHint.hidden = state.track === "cse";
    syncGateToggle();
    if (switchLink) {
      var otherTrack = state.track === "cse" ? "sase" : "cse";
      switchLink.href = "/exam?track=" + otherTrack;
      switchLink.textContent = otherTrack === "cse" ? "Civil Service portal" : "SASE portal";
      switchLink.hidden = !state.token;
    }
  }

  function loadExamList() {
    var loadingEl = $("exam-list-loading");
    var listEl = $("exam-list");
    if (listEl) listEl.innerHTML = "";
    $("exam-list-wrap").hidden = false;
    if (loadingEl) loadingEl.hidden = false;
    api("/api/exam-list", { token: state.token })
      .then(function (meta) {
        if (loadingEl) loadingEl.hidden = true;
        if (meta.track) {
          state.track = meta.track === "cse" ? "cse" : "sase";
          if (meta.exam_ms) state.durationMs = meta.exam_ms;
          applyTrackChrome();
        }
        var list = $("exam-list");
        list.innerHTML = "";
        (meta.exams || []).forEach(function (ex, idx) { list.appendChild(examCard(ex, idx)); });
        $("exam-list-wrap").hidden = false;
        loadLessons();
        setHomeTab(state.homeTab);
        /* No auto-start: an in-progress exam waits for an explicit Resume tap
           (audit fix). The Resume button on the card + the resume banner in
           beginExam stay available. */
        if (logoutBtn) logoutBtn.hidden = false;
      })
      .catch(function (err) {
        if (loadingEl) loadingEl.hidden = true;
        if (err.status === 401) { /* token expired: back to the gate */
          clearSession(state.track);
          state.token = null;
          if (logoutBtn) logoutBtn.hidden = true;
          $("exam-list-wrap").hidden = true; // hide stale cards under the gate
          gateForm.style.display = "";
          applyTrackChrome(); // gate stays branded for this track, switch link hides
          gateError.textContent = err.message || "Your session expired. Please sign in again.";
          gateError.hidden = false;
        } else {
          if (listEl) listEl.innerHTML = "";
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

  function examCard(ex, index) {
    var card = document.createElement("div");
    var accentIdx = (typeof index === "number" && isFinite(index)) ? Math.abs(index) % 3 : 0;
    card.className = "exam-card accent-" + accentIdx +
      (ex.status === "done" ? " is-done" : "") +
      (ex.status === "locked" ? " is-locked" : "");
    var donePct = (ex.pct != null ? ex.pct : (ex.total && ex.score != null ? Math.round(ex.score / ex.total * 1000) / 10 : null));
    var statusLabel =
      ex.status === "available"  ? '<span class="exam-status status-available">Available</span>' :
      ex.status === "in_progress"? '<span class="exam-status status-inprogress">In Progress</span>' :
      ex.status === "expired"    ? '<span class="exam-status status-locked">Time expired</span>' :
      ex.status === "done"       ? '<span class="exam-status status-done">Completed' + (donePct != null ? " · " + escapeHtml(String(donePct)) + "%" : "") + "</span>" :
                                   '<span class="exam-status status-locked">Locked</span>';
    var pr = profile();
    var breakdown = '<p class="exam-breakdown">' + escapeHtml(pr.breakdown) + "</p>";
    var meta;
    if (ex.status === "done") {
      var pct = donePct;
      meta = '<p class="exam-score">' + (pct != null ? "Completed · Your score: " + pct + "%" : "Completed") + "</p>";
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
      meta = '<p class="exam-meta">' + pr.questions + " questions · " + pr.durationShort + " timer · " +
        (ex.resume_remaining_ms != null ? fmtLong(ex.resume_remaining_ms) : "resume when ready") + "</p>";
    } else if (ex.status === "expired") {
      meta = '<p class="exam-meta">Your time ran out, view your auto-submitted result.</p>';
    } else {
      meta = '<p class="exam-meta">' + pr.questions + " questions · " + pr.durationShort + " · 1 attempt</p>";
    }
    card.innerHTML =
      '<div class="exam-num">' + escapeHtml(String(ex.n)) + "</div>" +
      '<div class="exam-body"><h3>Mock Exam ' + escapeHtml(String(ex.n)) + "</h3>" + meta + breakdown + statusLabel + "</div>";
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
        sessionStorage.setItem(RESULT_TRACK_KEY, state.track);
      } catch (e) {}
      window.location.href = "/exam/results.html";
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = orig;
      showListError(err.message || "Could not load your result. Please try again.");
    });
  }

  /* ============================================================
     VIDEO LESSONS (both tracks, paid-only)
     ------------------------------------------------------------
     Loaded from POST /api/exam-lessons with the signed token; the list
     never exists in any static file. The token's track decides which
     library the endpoint serves, and the section order below follows
     the track (Mathematics / Numerical first: the owner's math-first
     order), file order kept inside each group. Clicking a card swaps
     its thumbnail for a youtube-nocookie iframe, created only on click
     so the page stays fast. Watched state is a per-device localStorage
     check-off, keyed per track (v1, no server state).
     ============================================================ */
  var LESSON_SECTION_ORDER = {
    cse: ["Numerical", "Verbal", "Analytical", "General Information"],
    sase: ["Mathematics", "Language Usage", "Science", "Aptitude"]
  };
  function lessonSectionOrder() {
    return LESSON_SECTION_ORDER[state.track] || LESSON_SECTION_ORDER.sase;
  }

  function watchedIds() {
    try {
      var raw = localStorage.getItem(watchedKey());
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function setWatched(videoId, on) {
    var ids = watchedIds().filter(function (id) { return id !== videoId; });
    if (on) ids.push(videoId);
    try { localStorage.setItem(watchedKey(), JSON.stringify(ids)); } catch (e) {}
  }

  function loadLessons() {
    var wrap = $("lessons-wrap");
    if (!wrap || !state.token) return;
    wrap.hidden = state.homeTab !== "lessons";
    if (state.lessons) { renderLessons(); return; }
    if (state.lessonsLoading) return;
    state.lessonsLoading = true;
    api("/api/exam-lessons", { token: state.token })
      .then(function (data) {
        state.lessonsLoading = false;
        if (data.track) state.track = data.track === "cse" ? "cse" : "sase";
        state.lessons = Array.isArray(data.lessons) ? data.lessons : [];
        /* Deep link from a results page: /exam/?lessons=Mathematics
           opens the lessons section, filtered to the weak section. */
        try {
          var want = new URLSearchParams(window.location.search).get("lessons");
          if (want && lessonSectionOrder().indexOf(want) !== -1) {
            state.lessonsFilter = want;
            setHomeTab("lessons");
          }
        } catch (e) {}
        renderLessons();
      })
      .catch(function (err) {
        state.lessonsLoading = false;
        var el = $("lessons-error");
        if (el) { el.textContent = err.message || "Could not load the video lessons. Please try again."; el.hidden = false; }
      });
  }

  function renderLessons() {
    var listEl = $("lessons-list"), filtersEl = $("lessons-filters"), emptyEl = $("lessons-empty");
    if (!listEl) return;
    var lessons = state.lessons || [];
    if (emptyEl) emptyEl.hidden = lessons.length > 0;
    // Group, preserving file order inside each section (the study path).
    var groups = {}, order = [];
    lessons.forEach(function (l) {
      if (!groups[l.section]) { groups[l.section] = []; order.push(l.section); }
      groups[l.section].push(l);
    });
    var sectionOrder = lessonSectionOrder();
    order.sort(function (a, b) {
      var ia = sectionOrder.indexOf(a), ib = sectionOrder.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    // Filter chips: All + one per section present.
    if (filtersEl) {
      filtersEl.innerHTML = "";
      ["all"].concat(order).forEach(function (sec) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "lesson-chip" + (state.lessonsFilter === sec ? " active" : "");
        chip.textContent = sec === "all" ? "All sections" : sec;
        chip.setAttribute("aria-pressed", state.lessonsFilter === sec ? "true" : "false");
        chip.addEventListener("click", function () { state.lessonsFilter = sec; renderLessons(); });
        filtersEl.appendChild(chip);
      });
    }
    listEl.innerHTML = "";
    var watched = watchedIds();
    order.forEach(function (sec) {
      if (state.lessonsFilter !== "all" && state.lessonsFilter !== sec) return;
      var h = document.createElement("h3");
      h.className = "lessons-group-title";
      h.textContent = sec;
      listEl.appendChild(h);
      groups[sec].forEach(function (l) { listEl.appendChild(lessonCard(l, watched)); });
    });
  }

  /* Fullscreen helper (owner order Nov 11, 2026): ask the browser to put
     the element into fullscreen from the user's own tap, with the webkit
     prefix fallback. Returns false when the API does not exist at all
     (for example iPhone Safari, which reserves element fullscreen), and
     swallows promise rejections from webviews that expose the API but
     refuse the request (Messenger and Facebook in-app browsers); in both
     cases the permanent Watch on YouTube link under the player is the
     working path to a big screen. */
  function requestFullscreenOn(el, onFail) {
    if (!el) { if (onFail) onFail(); return false; }
    try {
      var p = null;
      if (el.requestFullscreen) p = el.requestFullscreen();
      else if (el.webkitRequestFullscreen) p = el.webkitRequestFullscreen();
      else if (el.msRequestFullscreen) p = el.msRequestFullscreen();
      else { if (onFail) onFail(); return false; }
      if (p && typeof p.catch === "function") {
        p.catch(function () { if (onFail) onFail(); });
      }
      return true;
    } catch (e) { if (onFail) onFail(); return false; }
  }
  function fullscreenApiExists() {
    var probe = document.documentElement;
    return !!(probe.requestFullscreen || probe.webkitRequestFullscreen || probe.msRequestFullscreen);
  }

  function lessonCard(l, watched) {
    var card = document.createElement("div");
    card.className = "lesson-card" + (watched.indexOf(l.video_id) !== -1 ? " is-watched" : "");

    var player = document.createElement("div");
    player.className = "lesson-player";
    /* The stage is the swap target for thumbnail and iframe, so the
       actions row under the player survives the swap. */
    var stage = document.createElement("div");
    stage.className = "lesson-stage";
    var currentIfr = null;
    var thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "lesson-thumb";
    thumb.setAttribute("aria-label", "Watch lesson: " + l.title);
    thumb.innerHTML =
      '<img src="https://i.ytimg.com/vi/' + escapeHtml(l.video_id) + '/hqdefault.jpg" alt="" loading="lazy">' +
      '<span class="lesson-play" aria-hidden="true">▶</span>';
    thumb.addEventListener("click", function () {
      // Lazy: the embed iframe exists only after an explicit tap.
      var ifr = document.createElement("iframe");
      ifr.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(l.video_id) + "?autoplay=1&rel=0";
      ifr.title = l.title;
      /* Fullscreen fix (owner report Nov 11, 2026): the allow list must name
         fullscreen explicitly or several mobile browsers and in-app
         webviews ignore the fullscreen button even with allowfullscreen. */
      ifr.setAttribute("allow", "accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen");
      ifr.setAttribute("allowfullscreen", "");
      ifr.setAttribute("webkitallowfullscreen", "");
      ifr.setAttribute("mozallowfullscreen", "");
      currentIfr = ifr;
      stage.innerHTML = "";
      stage.appendChild(ifr);
      /* Reveal the expand button only once a player exists, and only
         when this browser exposes a fullscreen API at all. */
      if (fullscreenApiExists()) expandBtn.hidden = false;
    });
    stage.appendChild(thumb);
    player.appendChild(stage);

    /* Actions row: an explicit Full screen button (the embed's own
       button is suppressed in some browsers and webviews, so the portal
       provides its own, driven by the user's tap) and a permanent Watch
       on YouTube link, the guaranteed big-screen path on every device,
       including in-app webviews that block iframe fullscreen outright. */
    var actions = document.createElement("div");
    actions.className = "lesson-actions";
    var expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "lesson-expand-btn";
    expandBtn.textContent = "Full screen";
    expandBtn.hidden = true;
    expandBtn.addEventListener("click", function () {
      /* Try the iframe first, then the stage wrapper if the iframe
         request is refused: some Android webviews accept one element
         and reject the other. */
      requestFullscreenOn(currentIfr, function () { requestFullscreenOn(stage, null); });
    });
    actions.appendChild(expandBtn);
    var ytLink = document.createElement("a");
    ytLink.className = "lesson-yt-link";
    ytLink.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(l.video_id);
    ytLink.target = "_blank";
    ytLink.rel = "noopener";
    ytLink.textContent = "Watch on YouTube";
    actions.appendChild(ytLink);
    player.appendChild(actions);
    card.appendChild(player);

    var body = document.createElement("div");
    body.className = "lesson-body";
    body.innerHTML =
      (l.topic ? '<p class="lesson-topic">' + escapeHtml(l.topic) + "</p>" : "") +
      "<h4>" + escapeHtml(l.title) + "</h4>" +
      (l.channel ? '<p class="lesson-meta">' + escapeHtml(l.channel) + "</p>" : "") +
      (l.why ? '<p class="lesson-why">' + escapeHtml(l.why) + "</p>" : "");
    var label = document.createElement("label");
    label.className = "lesson-watch";
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = watched.indexOf(l.video_id) !== -1;
    box.addEventListener("change", function () {
      setWatched(l.video_id, box.checked);
      card.classList.toggle("is-watched", box.checked);
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(" Watched"));
    body.appendChild(label);
    card.appendChild(body);
    return card;
  }

  /* ============================================================
     SCREEN 1b, instructions (shown before a NEW exam starts)
     ============================================================ */
  var pendingExamN = null;
  function showInstructions(examN) {
    pendingExamN = examN;
    var pr = profile();
    $("instr-kicker").textContent = "Mock Exam " + examN;
    var lead = $("instr-lead");
    if (lead) lead.innerHTML = "Read these quickly. Once you tap <strong>Start exam</strong>, your " + escapeHtml(pr.durationShort) + " timer begins and cannot be paused.";
    var fq = $("fact-questions");
    if (fq) fq.innerHTML = "<strong>" + pr.questions + "</strong><span>questions</span>";
    var ft = $("fact-time");
    if (ft) ft.innerHTML = "<strong>" + escapeHtml(pr.durationFact) + "</strong><span>time limit</span>";
    var secList = $("instr-sections");
    if (secList) {
      secList.innerHTML = pr.sections.map(function (s) {
        return "<li><span>" + escapeHtml(s[0]) + "</span><b>" + s[1] + "</b></li>";
      }).join("");
    }
    var stepTimer = $("instr-step-timer");
    if (stepTimer) stepTimer.innerHTML = "<strong>Once you start, the " + escapeHtml(pr.durationShort) + " timer runs even if you close the page. Start only when you are ready to finish.</strong>";
    var note = $("instr-note");
    if (note) note.textContent = pr.instrNote;
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
        if (data.track) state.track = data.track === "cse" ? "cse" : "sase";
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
        ["flag-btn", "prev-btn", "next-btn", "forfeit-btn"].forEach(function (id) {
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
    var frac = Math.max(0, Math.min(1, remaining / (state.durationMs || EXAM_DURATION_MS)));
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
    var subjectEl = $("q-section");
    if (subjectEl) {
      var subjectText = q.subject || q.section || "";
      /* Some banks store short section labels ("Language", "Math"); the
         chip always shows the full label the instructions screen uses. */
      if (subjectText === "Language") subjectText = "Language Usage";
      if (subjectText === "Math") subjectText = "Mathematics";
      subjectEl.textContent = subjectText;
      subjectEl.hidden = !subjectText;
    }
    $("q-number").textContent = "Question " + (q.number != null ? q.number : state.currentIndex + 1);
    var qp = $("q-passage");
    if (q.passage) { qp.textContent = q.passage; qp.hidden = false; }
    else { qp.textContent = ""; qp.hidden = true; }
    $("q-text").textContent = q.question || "";
    renderOptions(q);
    updateProgress();
    state.questions.forEach(function (qq) { updateGridCell(qq.qid); });
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
    var pct = total ? Math.round(answered / total * 100) : 0;
    $("progress-text").textContent = "Question " + (state.currentIndex + 1) + " of " + total + ", " + answered + " answered (" + pct + "%)";
    $("progress-fill").style.transform = "scaleX(" + (total ? answered / total : 0) + ")";
    $("progress-fill").parentElement.setAttribute("aria-valuenow", String(pct));
    var prev = $("prev-btn");
    if (prev) {
      prev.disabled = state.currentIndex === 0;
      prev.style.opacity = state.currentIndex === 0 ? ".4" : "1";
    }
    var next = $("next-btn");
    if (next) {
      var isLast = total > 0 && state.currentIndex === total - 1;
      next.innerHTML = isLast ? "Review and Submit" : 'Next <span aria-hidden="true">→</span>';
      next.setAttribute("aria-label", isLast ? "Review and submit exam" : "Next question");
      next.disabled = false;
    }
  }

  $("prev-btn").addEventListener("click", function () {
    if (state.currentIndex > 0) { state.currentIndex--; renderQuestion(true); }
  });
  $("next-btn").addEventListener("click", function () {
    if (state.questions.length && state.currentIndex === state.questions.length - 1) { openConfirm(); return; }
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
    applyGridFilter();
  }

  /* Display-only filter: hide non-flagged cells when the toggle is on. */
  function applyGridFilter() {
    var toggle = $("grid-flagged-only");
    var only = !!(toggle && toggle.checked);
    state.questions.forEach(function (q) {
      var cell = state.cellByQid[q.qid];
      if (!cell) return;
      cell.classList.toggle("is-filtered-out", only && !state.flagged[q.qid]);
    });
  }
  var gridFlaggedOnly = $("grid-flagged-only");
  if (gridFlaggedOnly) gridFlaggedOnly.addEventListener("change", applyGridFilter);

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
    if (idx === state.currentIndex) cell.setAttribute("aria-current", "true");
    else cell.removeAttribute("aria-current");
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

  $("grid-toggle").addEventListener("click", function () { applyGridFilter(); openDialog("grid-overlay"); });
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
    var submitBtnEl = $("submit-btn");
    if (submitBtnEl) submitBtnEl.disabled = true;
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
  var inRowSubmitBtn = $("submit-btn");
  if (inRowSubmitBtn) inRowSubmitBtn.addEventListener("click", openConfirm);
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
      sessionStorage.setItem(RESULT_TRACK_KEY, state.track);
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
