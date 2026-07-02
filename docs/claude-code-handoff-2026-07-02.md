# Claude Code Handoff: Ledgerly Bank Feeds And Commercial Launch

Date: 2026-07-02
Working copy: `/Volumes/1tb/Ledgerly-bank-feeds`
Original backup: `/Users/davidnaguib/Desktop/Ledgerly`
Current branch: `codex/xero-bank-feeds`

## First Principle

The desktop app is being moved toward a Xero-style production model:

- Ledgerly Desktop remains the accounting UI and local ledger.
- Ledgerly Cloud becomes the hosted broker for users, organizations, bank-feed consent, bank-provider tokens, sync jobs, audit logs, billing gates, and support operations.
- The desktop app never stores Basiq/provider API keys or server tokens.
- The desktop app authenticates to Ledgerly Cloud, then calls Ledgerly Cloud to start bank consent, list provider accounts, sync transactions, and manage consent.
- Imported transactions land locally as statement lines and flow through the existing reconciliation UX.

This handoff is deliberately not a command to preserve the current implementation exactly. Please review the architecture and code with fresh senior-engineer judgement. If a different structure is safer, simpler, or more production-ready, change it. The main constraint is to avoid unnecessary rewrites of the existing desktop accounting app and to keep the original backup untouched.

## Current Git State

The copied repo has uncommitted work from several passes. Nothing has been staged or committed by Codex.

Important: review the working tree before committing. Some files are new/untracked, including the master plan and release docs.

Useful commands:

```sh
cd /Volumes/1tb/Ledgerly-bank-feeds
git status --short
git diff --stat
npm test
npm --prefix server test
npm run smoke
```

Last verified by Codex before this handoff:

- `npm test`: 84 passed
- `npm --prefix server test`: 35 passed, 1 optional local Postgres contract test skipped
- `npm run smoke`: 41 screens + 3 interactions passed
- `git diff --check`: clean

## Core Planning Docs

- Master roadmap: `docs/superpowers/plans/2026-06-30-commercial-launch-readiness.md`
- Staging deploy runbook: `docs/release/staging-cloud-deployment.md`
- Desktop cloud auth runbook: `docs/release/desktop-cloud-auth.md`
- This handoff: `docs/claude-code-handoff-2026-07-02.md`

## What Codex Changed Recently

### Pass 1: Real Cloud Persistence

Goal: move Ledgerly Cloud from in-memory/test persistence toward real Postgres without rewriting the API surface.

Key changes:

- Added `pg` in `server/package.json`.
- Added `server/package-lock.json`.
- Added `server/src/db/postgres-store.js`.
- Kept `server/src/db/memory-store.js` as the test/dev double and added `healthCheck()`.
- Replaced `server/src/db/migrate.js` with a real migration runner.
- Extended `server/src/db/schema.sql` with idempotency/result fields and uniqueness constraints.
- Updated `server/src/app.js` to use async store calls and select Postgres when `DATABASE_URL` exists, while keeping memory for tests/dev/no DB.
- Added `/readyz` for database readiness.
- Added/updated tests:
  - `server/tests/store-contract.test.js`
  - `server/tests/app.test.js`
  - `server/tests/schema.test.js`

Things to re-check:

- Whether the async conversion in `server/src/app.js` is as small/clean as it should be.
- Whether `postgres-store.js` should be split into smaller modules before more tables are added.
- Whether migration naming/versioning should be introduced before production.

### Pass 2: Hosted Staging Cloud

Goal: create a staging deploy path but not deploy without the user's Render/Auth0/Basiq secrets.

Key changes:

- Added root `render.yaml`.
- Added `npm start` to `server/package.json`.
- Added `docs/release/staging-cloud-deployment.md`.
- Added `server/tests/deployment.test.js` to guard the Render Blueprint and avoid committed secrets.
- Updated the master launch plan checkboxes.

Current recommendation:

- Render is the default v1 host because it gets us a web service plus managed Postgres quickly.
- This is open to change. Fly.io, Railway, AWS, GCP, or another host may be better depending on deployment, compliance, cost, and support needs.

Not done:

- No live staging deployment has been created.
- No staging migrations have been run against hosted Postgres.
- No hosted `/healthz`, `/readyz`, auth rejection, or scrubbed-error checks have been run.

### Pass 3: Real Desktop Account Sign-In Scaffold

Goal: add production-style desktop sign-in without exposing tokens to the renderer.

Key changes:

- Added `src/services/cloud/auth.js`:
  - Auth0-compatible Authorization Code + PKCE URL generation.
  - Token exchange.
  - Refresh-token rotation support.
  - Refresh token encrypted via Electron `safeStorage`.
  - Access token kept only in main-process memory.
- Added `electron/cloud-auth-loopback.js`:
  - Local loopback callback handler for native-app OAuth.
- Updated `electron/main.js`:
  - Creates `cloudAuth`.
  - Adds `cloud-auth` IPC methods.
  - Wires bank-feed cloud client to use main-process access-token retrieval.
  - Leaves legacy `cloud-session`/env-token fallback so existing tests/dev paths keep working.
- Updated `electron/preload.js`:
  - Exposes `window.ledgerly.cloudAuth(method, args)`.
- Updated `electron/security.js`:
  - Adds `validateCloudAuthRequest`.
  - Tightens secret-field detection to include refresh tokens.
- Updated `src/services/cloud/client.js`:
  - Adds `hasSessionToken` so status checks do not force token refresh.
- Updated UI:
  - `ui/views/settings.js`: cloud sign-in/status/refresh/sign-out controls near Bank feeds.
  - `ui/views/dashboard.js`: optional first-run cloud sign-in and bank connect flow.
- Added tests:
  - `tests/cloud-auth.test.js`
  - extra coverage in `tests/electron-security.test.js`
- Added `docs/release/desktop-cloud-auth.md`.

Things to re-check:

- Whether loopback port `38987` should be fixed, configurable, or dynamically allocated with Auth0 callback constraints.
- Whether the Auth0 claim mapping for organization IDs should be formalized before real tenant setup.
- Whether status UI should be separated from the crowded Bank feeds card.
- Whether legacy `cloud-session.save` should be fully removed once Auth0 is live.

## Existing Bank Feed Direction

Before these latest passes, this copied repo already had significant bank-feed work:

- Desktop cloud client in `src/services/cloud/client.js`.
- Cloud bank-feed flow in `src/services/cloud/bank-feed-flow.js`.
- Basiq broker/service work under `src/services/bank-feed/` and server-side bank-feed routes.
- Local mapping between provider accounts and Ledgerly bank accounts.
- Sync into `statement_lines` with dedupe by provider transaction IDs.
- Xero-style reconciliation tests and flows.
- Consent management, revocation, and data-deletion request paths.
- Electron IPC validation to avoid exposing provider credentials.

Treat this as a working direction, not a final architecture.

## What Is Still Gated By User Accounts/Secrets

The user still needs to create/provide:

- Render or alternate hosting account/project.
- Hosted Postgres for staging.
- Auth0 staging tenant.
- Auth0 API audience for Ledgerly Cloud.
- Auth0 Native app client ID for Ledgerly Desktop.
- Auth0 callback URL configuration.
- Refresh Token Rotation enabled.
- Basiq sandbox account/app/API key.
- Sentry or equivalent monitoring project.
- Later: Stripe account/products if billing/entitlements are pursued.
- Later: domain, website, installer distribution, code signing certificates.

Do not hard-code secrets. Keep Basiq API keys and provider tokens in Ledgerly Cloud only.

## Recommended Next Work

### Immediate Step 1: Review And Stabilize Current Diff

Before adding more features:

1. Read the full diff.
2. Decide whether to keep, simplify, or restructure the Postgres store and auth scaffolding.
3. Re-run tests.
4. Commit in logical chunks, not as one giant commit if avoidable:
   - `feat: add Ledgerly Cloud Postgres persistence`
   - `chore: add Ledgerly Cloud staging deployment`
   - `feat: add secure Ledgerly Cloud desktop sign-in`

If the commits need to be rearranged because the current working tree overlaps, do that. The commit names in the plan are suggestions, not law.

### Immediate Step 2: Pass 4 Device And Organization Enforcement

This is the most important next technical pass before real bank data:

- Register each desktop install as a device after sign-in.
- Store device proof/key material with OS-backed protection.
- Send device identifier/proof on bank-feed API requests.
- Reject cloud bank-feed calls from revoked devices.
- Ensure every bank-feed endpoint checks:
  - valid user
  - organization membership
  - role permission
  - non-revoked device
  - active entitlement later, once billing exists
- Add tests for revoked devices, wrong org, wrong role, and missing device proof.

### Immediate Step 3: Real Staging Deployment

Once the user gives host/Auth0/Basiq details:

- Deploy Ledgerly Cloud staging.
- Run migrations.
- Verify `/healthz`.
- Verify `/readyz`.
- Verify unauthenticated cloud routes return stable `401`.
- Verify logs scrub secrets.
- Verify Auth0-issued access tokens work against `/v1/me`.

### Immediate Step 4: Real Basiq Sandbox Run

Once Basiq sandbox is available:

- Put `BASIQ_API_KEY` only in cloud staging secrets.
- Start connect from desktop.
- Complete Basiq consent in browser.
- List provider accounts.
- Map provider account to Ledgerly bank account.
- Sync transactions.
- Reconcile imported statement lines.
- Test manage, reconnect, revoke, and data-deletion request paths.
- Add webhook receiver if Basiq event delivery is required for production-grade freshness.

## Larger Commercial Launch Work Still Outstanding

The master plan continues beyond bank feeds:

- Billing and entitlements.
- Legal/compliance pack.
- Privacy/security docs.
- Observability and incident response.
- Website and download page.
- Installer generation.
- macOS/Windows code signing and notarization.
- Auto-update strategy.
- Support/admin tooling.
- Backup and restore drills.
- Production threat model and security review.

## Architecture Concerns To Challenge

Please actively challenge these:

- Is Electron + local SQLite + hosted cloud broker still the right product architecture?
- Should Ledgerly Cloud own more of the ledger data, or should local-first remain the product promise?
- Is Auth0 the right first auth provider, or would another identity provider simplify desktop native auth?
- Is Render appropriate past staging?
- Is Basiq the right bank-data provider for the launch region and compliance profile?
- Should bank-feed sync be pull-only from desktop, background job in cloud, webhook-driven, or hybrid?
- Does the current cloud API have enough idempotency/audit coverage for real money-adjacent data?
- Does the UI need a separate Cloud Account settings page instead of fitting into Bank feeds?

Better judgement is welcome. The goal is production readiness, not preserving Codex's first draft.

## Guardrails For Future Work

- Do not modify `/Users/davidnaguib/Desktop/Ledgerly`; it is the working backup.
- Work in `/Volumes/1tb/Ledgerly-bank-feeds`.
- Keep provider credentials out of Electron renderer and local SQLite.
- Keep access tokens out of renderer APIs.
- Prefer small, testable passes.
- Add tests for security boundaries before implementation where possible.
- Preserve the current accounting/reconciliation UX unless a change is clearly worth the migration cost.
- Keep user-facing docs honest about what is scaffolded versus actually deployed.

## Known Good Verification Commands

```sh
cd /Volumes/1tb/Ledgerly-bank-feeds
npm test
npm --prefix server test
npm run smoke
git diff --check
```

Optional Postgres contract testing requires a local test database and env var. Without that, the Postgres store contract test is expected to skip.
