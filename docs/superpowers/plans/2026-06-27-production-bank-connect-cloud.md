# Production Bank Connect Cloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary Electron-main-process bank-feed broker with a production-ready Ledgerly Cloud service that handles login, organisation membership, Basiq token brokering, consent management, account mapping, transaction sync, audit logs, and commercial security controls.

**Architecture:** Ledgerly Desktop remains local-first for accounting and reconciliation, but it becomes a client of Ledgerly Cloud for identity, bank-feed consent, provider token refresh, consent dashboards, and sync orchestration. Provider secrets and Basiq `SERVER_ACCESS` tokens live only in the hosted backend; the desktop receives only safe session state, consent launch status, provider account metadata, and normalized transactions that are imported into local `statement_lines`.

**Tech Stack:** Existing Electron/CommonJS desktop app, new isolated Node.js cloud backend, PostgreSQL, hosted OIDC identity provider with Authorization Code + PKCE, Basiq API v3.0, Basiq hosted Consent UI, server-side secrets manager, HTTPS-only APIs, structured audit logs, `node:test` contract tests, mocked Basiq integration tests, and existing Ledgerly smoke tests.

---

## The Production Answer

Do not ship the Basiq broker inside Electron for paying customers.

The current commit `f15685d` is useful because it created the correct boundaries: broker, flow service, connection metadata, and UI entry points. For production, move the broker boundary out of Electron and into Ledgerly Cloud.

Production shape:

```text
Ledgerly Desktop
  -> external browser login with PKCE
  -> Ledgerly Cloud API
  -> hosted identity provider
  -> PostgreSQL metadata store
  -> Basiq API / Basiq Consent UI
  -> normalized transactions returned to desktop
  -> local statement_lines
  -> local reconciliation
```

The desktop must not contain:

- Basiq API key.
- Basiq `SERVER_ACCESS` token.
- Basiq token refresh logic.
- Password database.
- Payment-initiation capability.

## Current Repo Starting Point

Work only in:

`/Volumes/1tb/Ledgerly-bank-feeds`

Do not edit:

`/Users/davidnaguib/Desktop/Ledgerly`

Existing useful pieces:

- `/Volumes/1tb/Ledgerly-bank-feeds/src/services/bank-feed/basiq-broker.js`
- `/Volumes/1tb/Ledgerly-bank-feeds/src/services/bank-feed/flow.js`
- `/Volumes/1tb/Ledgerly-bank-feeds/src/services/bank-feed/connections.js`
- `/Volumes/1tb/Ledgerly-bank-feeds/ui/views/bank.js`
- `/Volumes/1tb/Ledgerly-bank-feeds/ui/views/settings.js`
- `/Volumes/1tb/Ledgerly-bank-feeds/ui/views/dashboard.js`

These should be refactored into cloud-client calls instead of deleted.

## Sources And Constraints

- Basiq tokens expire after 60 minutes and Basiq recommends storing/refreshing them server-side: `https://api.basiq.io/docs/quickstart-api`
- Basiq Consent UI requires a `CLIENT_ACCESS` token bound to a Basiq `userId`: `https://api.basiq.io/docs/consent`
- Basiq consent actions include manage/reconnect style flows: `https://api.basiq.io/docs/consent-actions`
- Native apps should use external browser user-agents for OAuth: `https://datatracker.ietf.org/doc/html/rfc8252`
- Electron recommends hardening with context isolation and CSP: `https://electronjs.org/docs/latest/tutorial/security`
- OAIC CDR guidance expects consumer dashboards to let users withdraw consent and elect redundant-data deletion clearly and prominently: `https://www.oaic.gov.au/consumer-data-right/consumer-data-right-guidance-for-business/privacy-obligations/consumer-consent%2C-authorisation-and-dashboards`
- OWASP Password Storage guidance says passwords must use slow password hashing such as Argon2id/bcrypt/PBKDF2 if Ledgerly ever stores passwords directly: `https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html`
- OWASP Secrets Management recommends centralised, separated production secrets handling: `https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html`
- NIST SP 800-63B-4 is the current digital identity guidance family and should shape MFA/session policy: `https://pages.nist.gov/800-63-4/sp800-63b.html`

## Recommended Product Flow

### Sign In

1. User clicks Sign in in Ledgerly Desktop.
2. Electron opens the system browser for the hosted identity provider.
3. Desktop uses Authorization Code + PKCE.
4. Callback returns through a custom protocol or localhost callback.
5. Desktop stores refresh/session token only with OS-backed storage.
6. Renderer receives only `signedIn`, `email`, `orgs`, and entitlement status.

### Connect Bank

1. Desktop calls Ledgerly Cloud: `POST /v1/bank-feeds/connect/start`.
2. Cloud creates or reuses the Basiq user for the Ledgerly organisation.
3. Cloud creates a Basiq `CLIENT_ACCESS` token bound to that Basiq user.
4. Cloud returns `openedByServer: false` and a short-lived consent launch URL or opens the URL through a desktop command that does not expose server tokens.
5. Desktop opens Basiq Consent UI in the system browser.
6. User completes bank consent.
7. Desktop calls Cloud to list provider accounts.
8. User maps provider account to a Ledgerly local bank account.
9. Sync returns normalized transactions.
10. Desktop imports transactions into local `statement_lines`.
11. User reconciles locally.

### Manage Consent

1. Settings -> Bank feeds shows every connection.
2. User can manage consent, reconnect, revoke local mapping, or request deletion.
3. Cloud records consent/audit events.
4. Desktop removes local mappings only after explicit user confirmation.

## Production Data Model

Cloud PostgreSQL tables:

```text
users
  id uuid primary key
  identity_provider text
  identity_subject text unique
  email text
  name text
  created_at timestamptz

organizations
  id uuid primary key
  name text
  billing_customer_id text
  created_at timestamptz

organization_memberships
  organization_id uuid
  user_id uuid
  role text
  created_at timestamptz

devices
  id uuid primary key
  user_id uuid
  organization_id uuid
  device_name text
  public_key text
  last_seen_at timestamptz
  revoked_at timestamptz

bank_provider_users
  id uuid primary key
  organization_id uuid
  provider text
  provider_user_id text
  created_at timestamptz

bank_feed_connections
  id uuid primary key
  organization_id uuid
  provider text
  provider_user_id text
  provider_connection_id text
  institution_name text
  consent_status text
  consent_expires_at timestamptz
  last_sync_at timestamptz
  revoked_at timestamptz
  created_at timestamptz
  updated_at timestamptz

bank_feed_accounts
  id uuid primary key
  connection_id uuid
  provider_account_id text
  provider_account_name text
  provider_account_number_last4 text
  provider_account_type text
  desktop_bank_account_local_id text
  sync_cursor text
  last_sync_at timestamptz
  created_at timestamptz
  updated_at timestamptz

bank_feed_sync_runs
  id uuid primary key
  organization_id uuid
  bank_feed_account_id uuid
  status text
  imported_count integer
  skipped_count integer
  error_message text
  started_at timestamptz
  finished_at timestamptz

audit_events
  id uuid primary key
  organization_id uuid
  user_id uuid
  device_id uuid
  event_type text
  metadata_json jsonb
  ip_address inet
  created_at timestamptz
```

Cloud should not store raw bank-login credentials. For the first production version, avoid persistently storing full transaction descriptions in the cloud unless a legal/compliance review approves it.

## API Contract

Desktop calls:

```text
GET  /v1/me
GET  /v1/organizations
POST /v1/organizations/:orgId/devices/register
GET  /v1/bank-feeds/status
POST /v1/bank-feeds/connect/start
GET  /v1/bank-feeds/provider-accounts
POST /v1/bank-feeds/account-links
POST /v1/bank-feeds/sync
POST /v1/bank-feeds/consent/manage
POST /v1/bank-feeds/consent/revoke
POST /v1/bank-feeds/data-deletion/request
GET  /v1/audit-events
```

Every endpoint must:

- Require a valid user session.
- Require organization membership.
- Check role permissions.
- Return structured error codes.
- Log security-sensitive actions.
- Never return provider server tokens.

## File Structure To Add

New backend package:

```text
/Volumes/1tb/Ledgerly-bank-feeds/server/package.json
/Volumes/1tb/Ledgerly-bank-feeds/server/src/app.js
/Volumes/1tb/Ledgerly-bank-feeds/server/src/config.js
/Volumes/1tb/Ledgerly-bank-feeds/server/src/db/index.js
/Volumes/1tb/Ledgerly-bank-feeds/server/src/db/schema.sql
/Volumes/1tb/Ledgerly-bank-feeds/server/src/auth/verify-token.js
/Volumes/1tb/Ledgerly-bank-feeds/server/src/auth/roles.js
/Volumes/1tb/Ledgerly-bank-feeds/server/src/providers/basiq-client.js
/Volumes/1tb/Ledgerly-bank-feeds/server/src/services/bank-feeds.js
/Volumes/1tb/Ledgerly-bank-feeds/server/src/routes/bank-feeds.js
/Volumes/1tb/Ledgerly-bank-feeds/server/src/routes/me.js
/Volumes/1tb/Ledgerly-bank-feeds/server/src/routes/orgs.js
/Volumes/1tb/Ledgerly-bank-feeds/server/src/audit/events.js
/Volumes/1tb/Ledgerly-bank-feeds/server/tests/basiq-client.test.js
/Volumes/1tb/Ledgerly-bank-feeds/server/tests/bank-feeds.test.js
/Volumes/1tb/Ledgerly-bank-feeds/server/tests/auth.test.js
```

Desktop additions:

```text
/Volumes/1tb/Ledgerly-bank-feeds/src/services/cloud/client.js
/Volumes/1tb/Ledgerly-bank-feeds/src/services/auth/session.js
/Volumes/1tb/Ledgerly-bank-feeds/electron/auth.js
/Volumes/1tb/Ledgerly-bank-feeds/electron/main.js
/Volumes/1tb/Ledgerly-bank-feeds/electron/preload.js
/Volumes/1tb/Ledgerly-bank-feeds/ui/views/settings.js
/Volumes/1tb/Ledgerly-bank-feeds/ui/views/bank.js
/Volumes/1tb/Ledgerly-bank-feeds/ui/views/dashboard.js
```

## Implementation Phases

### Phase 1: Production Architecture Decision Record

- [ ] Create `/Volumes/1tb/Ledgerly-bank-feeds/docs/architecture/production-bank-connect-adr.md`.
- [ ] State that production uses Ledgerly Cloud, not Electron-main-process Basiq brokering.
- [ ] Pick identity provider for v1. Recommended: Auth0 or an equivalent OIDC provider with PKCE, MFA, account recovery, and organization support.
- [ ] Pick hosting for v1. Recommended: Render/Fly/Railway with managed PostgreSQL and separate staging/production environments.
- [ ] Define data residency/compliance assumptions for Australia before sale.
- [ ] Commit: `docs: add production bank connect architecture decision`.

### Phase 2: Cloud Backend Skeleton

- [ ] Create isolated `/server` package so the desktop app is not rewritten.
- [ ] Add `npm run server:test`, `npm run server:dev`, and `npm run server:migrate` scripts.
- [ ] Add config validation for:
  - `DATABASE_URL`
  - `OIDC_ISSUER`
  - `OIDC_AUDIENCE`
  - `BASIQ_API_KEY`
  - `APP_ENV`
  - `CORS_ORIGINS`
- [ ] Add health endpoint `GET /healthz`.
- [ ] Add PostgreSQL schema and migrations for users, orgs, devices, bank-feed tables, sync runs, and audit events.
- [ ] Tests:
  - Config fails closed when secrets are missing.
  - Health endpoint responds without leaking config.
  - Migrations create expected tables.
- [ ] Commit: `feat: scaffold ledgerly cloud backend`.

### Phase 3: Hosted Authentication And Organizations

- [ ] Implement OIDC/JWT verification using provider JWKS.
- [ ] Add `GET /v1/me`.
- [ ] Add organization creation/listing.
- [ ] Add membership roles: `owner`, `admin`, `bookkeeper`, `viewer`.
- [ ] Add device registration and revocation table.
- [ ] Desktop auth:
  - Use external browser PKCE flow.
  - Store refresh/session token with OS-backed secure storage.
  - Renderer receives sanitized auth state only.
- [ ] Tests:
  - Invalid JWT rejected.
  - Expired JWT rejected.
  - Wrong audience rejected.
  - Non-member cannot access org.
  - Revoked device cannot call bank-feed endpoints.
- [ ] Commit: `feat: add production auth and organizations`.

### Phase 4: Cloud Basiq Broker

- [ ] Move Basiq token exchange logic from `/src/services/bank-feed/basiq-broker.js` into `/server/src/providers/basiq-client.js`.
- [ ] Cache `SERVER_ACCESS` tokens server-side with refresh before expiry.
- [ ] Create Basiq user per Ledgerly organization.
- [ ] Create `CLIENT_ACCESS` token per consent launch.
- [ ] Add Consent UI start endpoint:
  - `POST /v1/bank-feeds/connect/start`
  - response contains consent launch URL only, never server token.
- [ ] Add account listing:
  - `GET /v1/bank-feeds/provider-accounts`
- [ ] Add consent manage/reconnect/revoke endpoints.
- [ ] Tests:
  - API key never appears in response body.
  - Server token never appears in response body.
  - Client token is scoped to expected Basiq user.
  - Token refresh happens before expiry.
  - Basiq errors map to stable Ledgerly errors.
- [ ] Commit: `feat: move Basiq broker to Ledgerly Cloud`.

### Phase 5: Desktop Cloud Bank-Feed Client

- [x] Add `/src/services/cloud/client.js` with a narrow HTTPS client.
- [x] Replace direct Electron Basiq broker calls in `/electron/main.js` with Ledgerly Cloud calls.
- [x] Keep `fakeSync` for demos.
- [x] Keep direct `basiqSync` disabled except explicit development mode.
- [x] `bankFeed('startConnect')` calls Cloud, then opens the returned consent URL.
- [x] `bankFeed('listProviderAccounts')` calls Cloud.
- [x] `bankFeed('syncLinkedAccount')` calls Cloud and imports returned transactions locally.
- [x] Tests:
  - Renderer cannot request tokens.
  - Desktop client attaches user session, not provider credentials.
  - Cloud sync result imports into `statement_lines` and dedupes provider transaction IDs.
- [x] Commit: implemented with Phase 6 as `feat: connect desktop bank feeds through cloud`.

### Phase 6: Account Mapping And Sync

- [x] Cloud stores provider account metadata and desktop-local mapping IDs.
- [x] Desktop keeps local `bank_feed_account_links` for UI speed and local sync state.
- [x] Sync endpoint returns normalized transactions:
  - `provider`
  - `sourceAccountId`
  - `sourceTransactionId`
  - `date`
  - `description`
  - `amountCents`
  - `postedAt`
  - `raw`
- [x] Desktop imports via existing provider-neutral importer.
- [x] Add idempotency keys for sync runs.
- [x] Add sync run audit history.
- [x] Tests:
  - Duplicate provider transaction IDs do not duplicate statement lines.
  - Partial provider failure records a failed sync run.
  - Mapping one provider account to another local bank account updates mapping safely.
- [x] Commit: implemented with Phase 5 as `feat: connect desktop bank feeds through cloud`.

### Phase 7: Consent And CDR Dashboard

- [x] Replace Settings bank-feed card with production dashboard state from Cloud.
- [x] Show:
  - Institution.
  - Linked account.
  - Consent status.
  - Consent expiry.
  - Last sync.
  - Reconnect/manage/revoke actions.
  - Redundant-data deletion request.
- [x] Add user-facing deletion flow:
  - remove local mappings
  - request cloud deletion/de-identification where applicable
  - leave reconciled accounting history intact unless user explicitly deletes their Ledgerly organization
- [x] Tests:
  - Revoked consent blocks sync.
  - Expired consent shows reconnect state.
  - Deletion request creates audit event.
- [x] Commit: `feat: add consent management dashboard`.

### Phase 8: Commercial Security Hardening

- [x] Add Electron CSP.
- [x] Revisit `sandbox: false` and document or fix.
- [x] Add IPC input validation for every auth/cloud/bank-feed method.
- [x] Add local app lock option.
- [x] Add secure token deletion on sign-out.
- [x] Add structured audit logs for login, device registration, consent start, consent manage, sync, revoke, deletion request, org deletion.
- [x] Add rate limiting on cloud endpoints.
- [x] Add production secrets separation.
- [x] Add backup/restore strategy for cloud DB.
- [x] Add Sentry or equivalent error monitoring with sensitive-field scrubbing.
- [x] Tests:
  - No provider secrets in renderer bundle.
  - No provider secrets in local SQLite.
  - IPC rejects unknown methods and invalid shapes.
  - Sign-out clears local session.
- [x] Commit: `feat: harden production auth and bank feed security`.

### Phase 9: Staging And Real-World Testing

- [ ] Create Basiq sandbox app.
- [ ] Create staging Ledgerly Cloud deployment.
- [ ] Create staging Auth/OIDC tenant/app.
- [ ] Connect one test bank/sandbox institution.
- [ ] Verify consent start/list accounts/map/sync/reconcile.
- [ ] Verify token refresh after 60 minutes.
- [ ] Verify consent expiry/reconnect path.
- [ ] Verify revoke path.
- [ ] Verify deletion request path.
- [ ] Run:
  - `/server` tests
  - desktop `npm test`
  - desktop `npm run smoke`
  - manual sandbox checklist
- [ ] Commit: `test: document production bank feed staging run`.

### Phase 10: Production Release Readiness

- [ ] Legal/compliance review for CDR posture.
- [ ] Privacy policy.
- [ ] Terms of service.
- [ ] Support and incident response process.
- [ ] Data retention policy.
- [ ] Security contact and vulnerability handling process.
- [ ] Billing/subscription integration.
- [ ] Production monitoring alerts.
- [ ] Production runbook.
- [ ] Release checklist signed off before selling.
- [ ] Commit: `docs: add production bank feed release checklist`.

## Minimum Production Definition Of Done

Ledgerly is not production-ready for bank linking until all of this is true:

- Basiq API key exists only in hosted backend secrets.
- Basiq server tokens exist only in backend memory/cache.
- Desktop uses OAuth/OIDC PKCE login.
- Desktop can sign out and clear local session secrets.
- Cloud verifies user, organization, role, and device on every bank-feed call.
- Consent dashboard can manage, reconnect, revoke, and request deletion.
- Sync is idempotent.
- Renderer cannot read provider tokens.
- Local SQLite never stores provider server tokens.
- Staging has completed a real Basiq sandbox connect/sync/revoke run.
- Legal/compliance review is complete before customer sale.

## Self-Review

- This plan does not require rewriting the accounting app.
- It keeps the current reconciliation engine intact.
- It moves production secrets out of Electron.
- It adds login and organization controls before bank-feed production launch.
- It accounts for consent management, deletion, audit logs, and staging tests.
- It explicitly separates current development broker code from the sellable target architecture.
