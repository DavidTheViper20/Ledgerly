# Local Staging Run (Ledgerly Cloud)

Last checked: 2026-07-02

This runbook runs the Ledgerly Cloud API on your own machine (`localhost:3001`)
against a real hosted Postgres database, using Track A static-token auth (see
`docs/release/staging-cloud-deployment.md`). It is useful for exercising the
full bank-feeds flow — including a real Basiq sandbox call — without deploying
anywhere.

## Prerequisites

- A reachable Postgres database (e.g. a free/staging Neon project). Note its
  connection string, including `?sslmode=require`.
- A Basiq sandbox API key from the Basiq dashboard.
- Node.js (same major version used elsewhere in this repo) with
  `npm --prefix server install` already run so `server/node_modules` exists.

## 1. Create `server/.env.staging.local`

This file is **untracked** (ignored via `.env*.local` in `.gitignore`) and
must never be committed. Create it with these variable names:

```sh
APP_ENV=staging
PORT=3001
CLOUD_AUTH_MODE=static
CLOUD_STATIC_TOKEN=<random string, 32+ characters>
DATABASE_URL=<your Postgres connection string, e.g. Neon, with sslmode=require>
BASIQ_API_KEY=<your Basiq sandbox API key>
CORS_ORIGINS=ledgerly://desktop
```

Generate a static token with something like:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Treat `CLOUD_STATIC_TOKEN`, `DATABASE_URL`, and `BASIQ_API_KEY` as secrets.
Never paste real values into commits, PRs, or shared docs — this file, and
this file alone, is where they live locally.

## 2. Run it

```sh
./scripts/cloud-local.sh            # runs migrations, then starts the server
./scripts/cloud-local.sh migrate    # just apply pending DB migrations
./scripts/cloud-local.sh start      # just start the server (assumes migrated)
```

The script loads `server/.env.staging.local` and fails clearly if the file is
missing. Migrations are idempotent: `npm --prefix server run migrate` applies
only pending numbered files under `server/src/db/migrations/` and records
them in `schema_migrations`; re-running reports "none (up to date)".

## 3. Verify

With the server running, set the token for convenience:

```sh
export TOKEN="<the CLOUD_STATIC_TOKEN value from server/.env.staging.local>"
```

Then:

```sh
# a. Health check — expect 200, appEnv staging
curl -i http://localhost:3001/healthz

# b. Readiness — expect 200, store postgres (confirms DB connectivity)
curl -i http://localhost:3001/readyz

# c. No auth header — expect 401
curl -i http://localhost:3001/v1/me

# d. Wrong token — expect 401
curl -i -H "Authorization: Bearer wrong-token-wrong-token-wrong-token-xx" \
  http://localhost:3001/v1/me

# e. Real token — expect 200, identitySubject static|owner
curl -i -H "Authorization: Bearer $TOKEN" http://localhost:3001/v1/me

# f. Create an organization — expect 201; record the returned organization id
curl -i -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Ledgerly Owner Books"}' \
  http://localhost:3001/v1/organizations

# g. Start a bank-feed connection (real Basiq sandbox call) — expect 201 with
#    a consentUrl starting https://consent.basiq.io/
curl -i -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"organizationId":"<id from f>","email":"<your email>"}' \
  http://localhost:3001/v1/bank-feeds/connect/start

# h. Check status — expect 200, shows the pending connection
curl -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/v1/bank-feeds/status?organizationId=<id from f>"
```

When done, stop the server (`Ctrl-C`, or kill the background process) and
confirm port 3001 is free.

## Desktop App Connection

To point the desktop app at this local staging server, set (dev/unpackaged
builds only — see below):

```sh
export LEDGERLY_CLOUD_URL="http://localhost:3001"
export LEDGERLY_CLOUD_TOKEN="<the CLOUD_STATIC_TOKEN value>"
export LEDGERLY_CLOUD_ORG_ID="<the organization id from verification step f>"
```

This legacy env-token (`LEDGERLY_CLOUD_TOKEN`) path is a Track A shortcut: it
is honoured **only in unpackaged dev builds**, where `NODE_ENV`/`APP_ENV` is
not `production`. Packaged/production builds always require the real PKCE
sign-in flow described in `docs/release/desktop-cloud-auth.md`. Do not rely on
`LEDGERLY_CLOUD_TOKEN` outside local development.
