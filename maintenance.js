/* Scheduled maintenance overlay (owner order Nov 11, 2026).
   Shows a full-screen maintenance screen with a live countdown on every
   public page until MAINTENANCE_END. Self-expiring: at the end time the
   overlay never renders, and an open page reloads itself back to normal.
   Team bypass: open any page once with ?maint=off to skip the overlay in
   this browser session (used by the QA team during the maintenance hour).
   Buyer safety: this is a page overlay only. The exam APIs stay live, so
   answers from an exam started before maintenance keep syncing and no
   in-progress attempt is cut off. */
(function () {
  var MAINTENANCE_END = new Date("2026-11-11T21:10:00+08:00").getTime();

  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get("maint") === "off") {
      sessionStorage.setItem("maint_bypass", "1");
    }
    if (sessionStorage.getItem("maint_bypass") === "1") return;
  } catch (e) { /* storage unavailable: fall through and show the overlay */ }

  if (Date.now() >= MAINTENANCE_END) return;

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function render() {
    if (document.getElementById("maint-overlay")) return;
    var style = document.createElement("style");
    style.textContent =
      "#maint-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;" +
      "background:radial-gradient(900px 420px at 10% -10%,rgba(36,86,171,.25),transparent 60%),linear-gradient(180deg,#0f1d33,#0b1526);" +
      "color:#e8f0fa;font-family:Inter,system-ui,sans-serif;padding:20px;}" +
      ".maint-card{max-width:520px;text-align:center;}" +
      ".maint-badge{display:inline-block;background:#ffd85d;color:#0c2147;font-weight:800;font-size:12px;letter-spacing:1.2px;" +
      "padding:6px 14px;border-radius:999px;text-transform:uppercase;}" +
      ".maint-card h1{font-size:30px;font-weight:900;margin:18px 0 10px;letter-spacing:-.02em;}" +
      ".maint-card p{color:#a8b8d0;font-size:15px;line-height:1.6;margin:0 0 8px;}" +
      ".maint-count{font-size:52px;font-weight:900;letter-spacing:.02em;margin:18px 0 6px;font-variant-numeric:tabular-nums;}" +
      ".maint-until{color:#f3d9a0;font-weight:700;font-size:14px;}" +
      ".maint-note{margin-top:18px;font-size:13px;color:#7d8ea8;}";
    document.head.appendChild(style);

    var overlay = document.createElement("div");
    overlay.id = "maint-overlay";
    overlay.setAttribute("role", "alert");
    overlay.innerHTML =
      '<div class="maint-card">' +
      '<span class="maint-badge">Scheduled maintenance</span>' +
      "<h1>We are improving the portal</h1>" +
      "<p>SASE Practice Hub PH is under maintenance for one hour while we test, fix, and upgrade the mock exam portal and video lessons.</p>" +
      '<div class="maint-count" id="maint-count">--:--:--</div>' +
      '<div class="maint-until">Back online at 9:10 PM today</div>' +
      '<p class="maint-note">Your saved answers and progress are safe. Need urgent help? Message SASE Practice Hub PH on Facebook.</p>' +
      "</div>";
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    var countEl = document.getElementById("maint-count");
    function tick() {
      var left = MAINTENANCE_END - Date.now();
      if (left <= 0) { window.location.reload(); return; }
      var s = Math.floor(left / 1000);
      countEl.textContent = pad(Math.floor(s / 3600)) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
    }
    tick();
    setInterval(tick, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
