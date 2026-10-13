# Exams 6–8 Wiring Plan — SASE Portal (Neon + Deploy worker)

Status: READINESS / PREP ONLY. No migration run, no deploy, no bank write yet.
Blocking rule: do NOT deploy until the coordinator confirms Exams 6–8 are
rebuilt, audited, and wired. (The previous 540-question files were lost
because they were never committed — see anti-loss rule below.)

## 1. How the portal serves the bank (verified in this branch)

- The question bank is NOT in this repo. It lives as `bank.json` in the
  private GitHub repo `Yametech12/sase-exam-state` (env `EXAM_STATE_REPO`).
- Server reads it in `api/_exam-lib.js` → `loadBank()`: GitHub Contents
  metadata → blob API (avoids the 1 MB Contents-API trap), 60 s in-memory
  cache. Per-attempt bank version is pinned by blob SHA
  (`loadBankAtBlob`), so grading uses the snapshot the attempt started with.
- `GH_EXAM_TOKEN` stays required (bank reads). `DATABASE_URL` is for state
  only, never for questions.
- Server code is ALREADY 8-exam-ready — no handler change needed for 6–8:
  - `EXAM_COUNT = 8` in `api/_exam-lib.js`; `validExamN` accepts 1–8.
  - `api/exam-list.js` loops 1–8; weekly unlock via `examUnlock`.
  - `exam/index.html` already says "Eight full-length mock exams".
  - Landing `index.html` (commit 06678dc) already says 8 exams.

## 2. Exact bank.json shape the auditors' output must land in

```
bank = { "exams": { "1": [ item, ... 180 ], ..., "8": [ item, ... 180 ] } }
item = {
  "id": "E6-L001",              // unique across ALL 8 exams, never reused
  "item_number": 1001,         // unique across whole bank; see note below
  "section": "Language Usage",  // EXACT label (see list below)
  "question": "...",
  "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
  "answer": "B",               // one of "A".."D" only
  "explanation": "...",        // required, non-empty
  "passage": "..." | null      // only for reading-comprehension items
}
```

- Sections must use EXACTLY: `Language Usage`, `Mathematics`, `Aptitude`,
  `Science`. (`canonicalSection` maps aliases, but do not rely on it.)
- Per exam: 80 Language Usage, 40 Mathematics, 30 Aptitude, 30 Science.
- `item_number`: `buildResult` treats it as traceability only
  (`item.item_number ?? null`), but keep it unique across the bank.
  Suggested: Exams 6–8 use 1001–1540 (180 per exam), never reusing 1–900.
- Do NOT copy the local `exam1.json` wrapper shape (`{exam, questions: []}`).
  The serving shape is the flat `exams: { "N": [items] }` map above.
- Current size note: `bank.json` is ~0.49 MB at 5 exams; 8 exams lands
  ~0.8 MB — still under the 1 MB Contents-API limit, and the blob path is
  already in use, so no read-path change is needed.

## 3. Where the auditors' output must land (two destinations)

1. **Anti-loss copy (FIRST):** commit the builders' per-exam files into
   THIS repo (e.g. `exam/bank-exam-6.json`, `-7`, `-8`) and push to
   `origin/neon-migration` immediately after each exam is done. Never
   leave 540 questions as uncommitted files again.
2. **Serving copy (AFTER audit passes):** update `bank.json` in
   `Yametech12/sase-exam-state` via the GitHub Contents API
   (PUT with base64 content + current file SHA). No script in this repo
   does this — it is a deliberate manual/API step. Preserve Exams 1–5
   byte-identical: diff the `1`–`5` arrays before/after and confirm zero
   changes to them; only `6`, `7`, `8` keys are added.
3. After the `bank.json` PUT, verify with a fresh `loadBank()`-equivalent
   read (blob API): keys `1`–`8` present, 180 items each, every item has
   `answer` + `explanation`, sections per-exam 80/40/30/30.

## 4. Neon migration — prepared, NOT run

### Route decision (important)
- `api/exam-migrate.js` (temporary endpoint, commit a427327) requires
  `MIGRATION_SECRET` in Vercel. **Verified: `MIGRATION_SECRET` is NOT
  set in Vercel** (env-name listing only — no values read). The endpoint
  would answer 503 until the secret is added.
- **Recommended route:** the local script `scripts/migrate-github-to-neon.mjs`
  (read-only against GitHub, idempotent upserts). It needs `GH_EXAM_TOKEN`
  + `DATABASE_URL` passed as env vars for that one command only — never
  print, log, commit, or paste them anywhere.

### Commands (run at deploy time, from repo root)
```sh
# 0. Pre-checks: branch = neon-migration, working tree clean except
#    intended files; mock tests pass:
node tests/neon-storage.test.mjs
# 1. Migrate (env vars supplied at invocation, never stored in a file):
GH_EXAM_TOKEN=<token> DATABASE_URL=<neon pooled URL> \
  node scripts/migrate-github-to-neon.mjs
# 2. Verify counts (via a read-only query against Neon; counts only):
#    SELECT (SELECT count(*) FROM bindings) bindings,
#           (SELECT count(*) FROM exams) exams,
#           (SELECT count(*) FROM used_submissions) subs;
```

### Expected counts (from the last known state.json — RE-CONFIRM at run time)
- `bindings`: 8 orders with bindings
- `exams`: 9 exam rows across orders
- `used_submissions`: 7 records
- If live `state.json` counts differ at run time, do NOT force-match:
  report actual source counts vs migrated counts; they must be equal.

### Verification checklist (real Neon, after migration)
- [ ] Schema tables exist: `bindings`, `exams`, `used_submissions`.
- [ ] Counts match source `state.json` exactly (see above).
- [ ] Spot-check one binding row: `devices` is a JSON array.
- [ ] Spot-check one exams row: `data` parses, has `status`/`q_order`.
- [ ] GitHub state repo untouched (no writes; still the rollback backup).
- [ ] Existing-account login works on the deployed site (owner test account).

### Delete the temporary endpoint (mandatory, right after success)
```sh
git rm api/exam-migrate.js
git commit -m "Remove one-time Neon migration endpoint after successful migration"
git push origin neon-migration   # then re-merge/deploy (see §5)
```
- Never leave `exam-migrate.js` deployed. If the endpoint was already
  used to migrate (only if `MIGRATION_SECRET` gets added), delete it in
  the same deploy cycle and redeploy.

## 5. Deploy sequence (only after coordinator go-ahead)

1. Exams 6–8 audited + wired (§3) — coordinator signals ready.
2. Real Neon migration (§4) + counts verified.
3. Delete `api/exam-migrate.js` (if still present), commit.
4. Merge `neon-migration` → `main`, push. Vercel auto-deploys from `main`.
5. Confirm the Vercel deployment for `main` is READY (deployment state,
   not just "pushed") before claiming live.

## 6. Live verification checklist (production)

- [ ] Landing page shows 8 exams + ₱167 (no "5 exams" anywhere).
- [ ] `/exam` lists Exams 1–8.
- [ ] Existing buyer login still works (owner test account).
- [ ] New flow works: login → exam list → start → answer → sync →
      submit → results/review with correct score.
- [ ] No secrets in any response, log, or commit.
- [ ] `bank.json` in the state repo has keys 1–8 (verified via blob read).

## 7. Vercel env state (verified, names only — no values read)

- Project `sase-practice-hub-ph` exists and is connected.
- `DATABASE_URL`: present (3 entries — Production, Preview, Development),
  stored as sensitive/secret. Never deploy without it.
- `GH_EXAM_TOKEN`, `EXAM_HMAC_SECRET`, `EXAM_STATE_REPO`: present.
- `MIGRATION_SECRET`: NOT set → temp endpoint unusable until added
  (use the local-script route instead, §4).
- Mock-Neon tests: 31/31 pass on this branch.

## 8. Open items / blockers (not mine to clear alone)

- Exams 6–8 content: with question-builder workers (rebuild in progress).
- `bank.json` PUT to the state repo: waits on audited Exams 6–8.
- Real Neon migration: waits on deploy go-ahead.
- Final live verification: waits on merge + deploy.
