/* ============================================================
   SASE Practice Hub PH, site URL configuration
   ------------------------------------------------------------
   Single source of truth for the site's ABSOLUTE URL.

   RULE: all internal links in pages and scripts use RELATIVE URLs
   (/, /exam, /privacy.html) so they work on any domain. Only the
   static spots listed in the DOMAIN_SWAP checklist below need an
   absolute URL, because search engines require absolute URLs there.

   CURRENT: the live site is still on the Vercel domain. Do NOT
   change SITE_URL until the .me domain is chosen and live.

   CONSUMERS: no page JS currently needs an absolute site URL, so
   no page loads this file yet. Any future JS that needs an absolute
   site URL MUST load this file BEFORE use and read
   window.SASE_SITE_CONFIG.SITE_URL, never hardcode the domain.
   ============================================================ */
(function () {
  "use strict";
  window.SASE_SITE_CONFIG = {
    SITE_URL: "https://sase-practice-hub-ph.vercel.app"
  };
})();

/* ============================================================
   DOMAIN_SWAP CHECKLIST, moving to a free .me domain
   (GitHub Student Pack / Namecheap). Exact .me name NOT chosen
   yet, do NOT swap until it is.
   ------------------------------------------------------------
   ONE-LINE CHANGE:
     1. Change SITE_URL above to the new .me URL (keep the
        trailing-slash-free form, e.g. "https://example.me").

   STATIC SPOTS THAT STILL REQUIRE ABSOLUTE URLs (search engines
   require absolute URLs here, update each to the new .me URL):
     2. index.html, <link rel="canonical">, og:url, og:image,
        twitter:image (4 spots).
     3. privacy.html, <link rel="canonical"> (1 spot).
     4. sitemap.xml, every <loc> (currently 2 URLs).
     5. robots.txt, the "Sitemap:" line (1 spot).

   NO CHANGE NEEDED:
     - Every other internal link is relative (/, /exam,
       /privacy.html) and works unchanged on the new domain.
     - Facebook Page links are external (facebook.com), untouched.

   OUT OF SCOPE FOR THIS FILE (separate steps / owners):
     - exam/index.html, api/, generator scripts (wiring agent).
     - Goal / cron / marketing templates (separate parent step
       after the .me name is chosen).
     - exam/results-ui.js score-card footer (hardcoded domain in
       canvas text, route to its owner; NOT changed here).

   AFTER THE SWAP, VERIFY:
     - View-source on / and /privacy.html: canonical + OG tags
       show the .me URL.
     - Fetch /sitemap.xml and /robots.txt: .me URLs throughout.
     - Resubmit the sitemap in Google Search Console / Bing
       Webmaster Tools.
     - Keep the old Vercel domain redirecting to the .me domain
       if possible, so old links keep working.
   ============================================================ */
