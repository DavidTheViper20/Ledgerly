# Ledgerly Cloud Staging Deployment

Last checked: 2026-07-02

**Current status: NOT deployed. Everything below is scaffolding/runbook.** No Ledgerly Cloud service is live on Render or anywhere else. The `render.yaml` Blueprint, env-var prompts, and verification steps describe the intended first deploy; they have not been executed against a real environment yet.

This runbook deploys only the Ledgerly Cloud API. The desktop app stays local until the secure sign-in and cloud API client passes are complete.

## Region Note

Render has **no Australian region**. The Blueprint uses `singapore`, which is acceptable for staging only. For production, move to an AU region: Fly.io (`syd`), Railway, or AWS `ap-southeast-2`. Do not churn hosting now — pick the AU host as part of the production cutover, not during staging.

## Target Shape

- Host: Render Blueprint from `render.yaml`.
- API service: `ledgerly-cloud-staging`.
- Database: Render Postgres `ledgerly-cloud-staging-db`.
- Runtime: Node, `server` as the service root.
- Migration point: `preDeployCommand: npm run migrate`.
- Readiness check: `/readyz`, which confirms database reachability without exposing secrets.
- Auto deploys: off for staging until we have CI gates and secret rotation procedures.

Render references:

- Blueprint YAML reference: https://render.com/docs/blueprint-spec
- Deploy behavior: https://render.com/docs/deploys
- Rollbacks: https://render.com/docs/rollbacks
- Postgres recovery and backups: https://render.com/docs/postgresql-backups
- Postgres version support: https://render.com/docs/postgresql-upgrading

## Required Secret Values

Do not commit real values. The Blueprint uses `sync: false` so Render prompts for these during creation.

| Key | Source | Notes |
| --- | --- | --- |
| `OIDC_ISSUER` | Auth0 staging tenant | Example format: `https://tenant.region.auth0.com/` |
| `OIDC_AUDIENCE` | Auth0 API audience | Must match the Ledgerly Cloud API identifier |
| `OIDC_JWKS_URL` | Auth0 JWKS URL | Usually `OIDC_ISSUER + .well-known/jwks.json`; keep explicit for predictable deploys |
| `BASIQ_API_KEY` | Basiq dashboard | Staging/sandbox key first; production key only in production |
| `CORS_ORIGINS` | Ledgerly web/account surfaces | Comma-separated HTTPS origins; tighten before public beta |
| `SENTRY_DSN` | Sentry project | Optional until monitoring pass is wired, but reserve the variable now |

`DATABASE_URL` is generated from the Render Postgres database using `fromDatabase.connectionString`.

## Track A: Static Token Auth (single-user staging without Auth0)

Track A gets the owner's own bank data flowing end to end before Auth0 exists. Instead of OIDC/JWKS verification, the cloud server accepts a single shared bearer token as one fixed identity.

- On the cloud service, set `CLOUD_AUTH_MODE=static` and `CLOUD_STATIC_TOKEN` to a random string of **32 or more characters**. Treat `CLOUD_STATIC_TOKEN` as a cloud secret (it is `sync: false` in the Blueprint). Setting `CLOUD_STATIC_TOKEN` alone also switches the server into static mode.
- The desktop app uses the **same token** via `LEDGERLY_CLOUD_TOKEN`, but only in **unpackaged dev builds**. The legacy plaintext token path is blocked in packaged/production builds (it is honoured only when the app is unpackaged and `NODE_ENV`/`APP_ENV` is not `production`).
- Leave the `OIDC_*` variables unset while in static mode; OIDC verification is bypassed.
- Once Auth0 is live (Track B), this mode is **retired**: set `CLOUD_AUTH_MODE` back to OIDC (or unset it), remove `CLOUD_STATIC_TOKEN`, and populate the `OIDC_*` variables.

## First Deploy

1. Push this repo branch to GitHub or GitLab.
2. In Render, create a new Blueprint and select the repo.
3. Keep the Blueprint file path as `render.yaml` at the repo root.
4. Confirm the resources:
   - web service `ledgerly-cloud-staging`
   - Postgres database `ledgerly-cloud-staging-db`
   - region `singapore`
   - database IP allow list is empty
5. Enter the required secret values when prompted.
6. Start the Blueprint sync.
7. Confirm the service build runs `npm ci`, then `npm run migrate`, then `npm start`.

The first deploy is not complete until the migration step succeeds and `/readyz` reports `ok: true`.

## Verification Checklist

Set:

```sh
export LEDGERLY_STAGING_URL="https://ledgerly-cloud-staging.onrender.com"
```

Then verify:

```sh
curl -fsS "$LEDGERLY_STAGING_URL/healthz"
curl -fsS "$LEDGERLY_STAGING_URL/readyz"
curl -i "$LEDGERLY_STAGING_URL/v1/me"
```

Expected results:

- `/healthz` returns `ok: true`, service `ledgerly-cloud`, and `appEnv: staging`.
- `/readyz` returns `ok: true`, service `ledgerly-cloud`, `appEnv: staging`, and `store: postgres`.
- `/v1/me` without a bearer token returns `401` with a stable JSON auth error.
- Render logs do not contain `DATABASE_URL`, `BASIQ_API_KEY`, token strings, full bank identifiers, or Postgres passwords.

After Auth0 staging is created, repeat `/v1/me` with a real staging access token and confirm it returns the current user profile or creates the first user according to the server contract.

## Migration Rules

- `npm --prefix server run migrate` applies the numbered migration files under `server/src/db/migrations/` (e.g. `001_init.sql`) in order. Applied migrations are recorded in a `schema_migrations` table, so re-running the command is a no-op — only pending migrations are applied.
- Schema changes must be forward-compatible for at least one deployed version.
- Additive migrations are preferred until we have production traffic and formal release windows.
- Run migrations through Render's `preDeployCommand`.
- For a manual retry, use Render Shell or a one-off job from the service root and run:

```sh
npm run migrate
```

- Never run ad hoc destructive SQL against staging or production without a fresh backup or point-in-time recovery checkpoint.

## Rollback Plan

Render service rollback restores a previous successful service build. It does not automatically undo database migrations.

Use this order:

1. If only app code is broken, roll the service back to the last successful deploy from the Render service Events page.
2. Keep auto deploys off until the broken commit is fixed.
3. If a migration is broken but data is intact, deploy a forward-fix migration.
4. If data is damaged, create a point-in-time recovery database, validate it in isolation, then repoint `DATABASE_URL` only after validation.
5. Do not drop the original database during an incident. Rename or isolate it after recovery is proven.

## Backup And Restore Drill

Before production beta:

1. Confirm the database plan supports point-in-time recovery.
2. Trigger a recovery into a separate database.
3. Point a temporary staging API at the recovered database.
4. Verify `/readyz`, org creation, bank provider user creation, bank connection creation, and sync idempotency.
5. Record the recovery time and any manual steps.

Render's current docs state paid Render Postgres databases provide recovery/backups, while free databases do not. Keep staging on a paid database tier so the deployment path matches the production operating model.

## User-Owned Setup Still Needed

- Render account/workspace access.
- Git provider connection for this copied repo.
- Auth0 staging tenant, API audience, and desktop app.
- Basiq sandbox API key.
- Sentry project or a chosen observability equivalent.
- Final staging URL to wire into the desktop cloud client in the next passes.
