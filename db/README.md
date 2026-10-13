# Neon Postgres state backend — setup

Portal state (bindings / exams / used_submissions) lives in Neon Postgres.
`bank.json` stays in the private GitHub repo. Nothing here touches the
landing page, buyer passwords, or hashes.

## 1. Create the Neon project (user does this once)

- Sign up at https://neon.tech (free tier is enough for thousands of buyers).
- New project, region closest to PH users.
- Copy the **pooled** connection string (`...-pooler...`) — that is `DATABASE_URL`.

## 2. Migrate the existing state (one-time, idempotent)

From the repo root:

```sh
GH_EXAM_TOKEN=<github token with contents:read on the state repo> \
DATABASE_URL=<neon pooled URL> \
node scripts/migrate-github-to-neon.mjs
```

The script is read-only against GitHub (never writes to the state repo),
creates the tables from `db/schema.sql`, and upserts every row. Safe to
re-run. It logs counts and drops the legacy `attempts` / `in_progress`
keys (no handler reads them).

## 3. Set Vercel env vars, then deploy this branch

- Vercel project → Settings → Environment Variables → add `DATABASE_URL`
  (the Neon pooled connection string). Keep `EXAM_HMAC_SECRET` as-is.
  `GH_EXAM_TOKEN` is still needed for `bank.json` reads.
- Merge/deploy the `neon-migration` branch. The portal runs the moment
  `DATABASE_URL` is present.

## 4. Verify

- Log in with the owner test account (existing bound device) — must succeed.
- Start an exam, answer, sync, submit, view the result.
- Rollback if needed: the GitHub state repo is untouched, so redeploying
  `main` (GitHub backend) restores the old path — but any logins/exams
  recorded in Neon after the switch would NOT be in the GitHub file.

## 5. Tests (no real DB needed)

```sh
npm install
node tests/neon-storage.test.mjs
```
