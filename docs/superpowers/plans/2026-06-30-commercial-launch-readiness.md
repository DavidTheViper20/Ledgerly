# Ledgerly Commercial Launch Readiness Plan

> **For agentic workers:** This is a docs-first audit and launch plan. Do not edit the original backup at `/Users/davidnaguib/Desktop/Ledgerly`. Productization work must happen in `/Volumes/1tb/Ledgerly-bank-feeds`.

## Goal

Turn the current Ledgerly desktop app plus Ledgerly Cloud bank-feed work into a legitimate, sellable product with account creation, secure bank linking, a customer website, installer/update flow, billing, support, monitoring, legal/compliance readiness, and a real staging-to-production release path.

## Track A vs Track B (2026-07-02 decision)

The launch work splits into two tracks so the owner can use the product before it is sellable to others:

- **Track A (now) — single-user path.** Get the owner's own bank data syncing end to end with the simplest safe auth: static token mode (`CLOUD_AUTH_MODE=static` + `CLOUD_STATIC_TOKEN`). This needs only hosting + hosted Postgres + a Basiq sandbox key. No Auth0, no tenants, no billing.
- **Track B (later, when selling to others) — multi-tenant productization.** Auth0 tenants, device registration/enforcement, billing, legal, and code signing. Device enforcement (Pass 4) is explicitly Track B.

Track A retires the static token path once Auth0 is live; from then on everything runs on the Track B OIDC identity model.

## Current Audit Snapshot

Date: 2026-06-30
Repo: `/Volumes/1tb/Ledgerly-bank-feeds`
Branch: `codex/xero-bank-feeds`

Verified locally:

- `npm test`: passing, 80/80 tests.
- `npm --prefix server test`: passing, 28/28 tests.
- `npm run smoke`: passing, 41 screens + 3 interactions.
- Git working tree: clean after audit.

## What Is Done

- Local-first desktop accounting app is functional: invoices, bills, ledger, reports, bank accounts, statement lines, reconciliation, payroll, projects, assets, budgets, assistant, and settings.
- Xero-style reconciliation engine exists: statement-line import, match suggestions, bank rules, transfers, split coding, create-and-code, unreconcile, and dedupe behavior.
- Bank-feed architecture has moved in the right direction:
  - Desktop calls Ledgerly Cloud for production bank-feed actions.
  - Basiq API key and server-token logic are intended to live on the backend.
  - Desktop imports normalized transactions into local `statement_lines`.
  - Consent dashboard exists in Settings with reconnect/manage/revoke/deletion-request actions.
- Ledgerly Cloud scaffold exists:
  - Health/config routes.
  - OIDC JWT verification.
  - Organization/member/device routes.
  - Bank-feed connect/accounts/map/sync/revoke/delete routes.
  - Basiq client and mocked Basiq tests.
  - Rate limiting, scrubbed error handling, and audit-event coverage.
- Security hardening started:
  - Electron context isolation, sandbox, CSP, limited IPC, and request validation.
  - Sign-out deletes local cloud-session settings.
  - Local app lock stores salted PBKDF2 hashes, not plaintext passcodes.
  - Provider secrets are not exposed to the renderer in tests.

## What Is Not Done Yet

- No real hosted Ledgerly Cloud deployment yet.
- No production PostgreSQL data-access implementation yet; the cloud app still defaults to `memory-store`, and `server/src/db/migrate.js` only prepares statements.
- No real Auth0/OIDC desktop sign-in flow yet; the app can store a supplied session token but does not yet launch the external-browser PKCE flow and callback.
- No OS-backed refresh-token/session storage yet; local session tokens are currently stored in SQLite settings.
- No real Basiq sandbox/live app credentials have been wired and tested end to end.
- No proof that device registration is enforced on every bank-feed API call.
- No website, account portal, pricing page, docs, downloads page, or support/security pages.
- No billing/subscription/entitlement system.
- No installer-quality release pipeline:
  - Current `npm run pack` creates a macOS package with `electron-packager`.
  - There is no DMG/PKG/NSIS/MSIX config.
  - There is no code-signing/notarization pipeline.
  - There is no auto-update pipeline.
- No production monitoring, alerting, crash reporting, uptime checks, backup restore drill, or runbook.
- No legal/compliance launch pack: privacy policy, terms, CDR policy/posture review, data retention policy, incident response, support/complaints process, vulnerability disclosure process.
- README is stale: it still describes Ledgerly as a no-cloud/no-subscription app and documents the older Electron-side Basiq key flow.
- App icon/logo replacement was researched, but the final generated unified icon should be confirmed and applied across app logo, `.icns`, and website/favicon assets before launch.

## Existing Plans Found

- `docs/superpowers/plans/2026-06-19-xero-style-bank-reconciliation.md`
- `docs/superpowers/plans/2026-06-26-secure-bank-connect-flow.md`
- `docs/superpowers/plans/2026-06-27-production-bank-connect-cloud.md`
- `docs/architecture/production-bank-connect-adr.md`
- `docs/production-security-hardening.md`
- `docs/research/2026-06-19-secure-login-and-bank-linking.md`
- `docs/research/2026-06-19-icon-refresh-brief.md`

The bank-feed plans are strong. The missing plan was a wider commercial-launch plan that treats Ledgerly as a product, not only a desktop codebase.

## Recommended Production Shape

```text
Public website / account portal
  -> sign up, pricing, downloads, docs, support, billing portal

Ledgerly Desktop
  -> external browser OAuth/OIDC PKCE login
  -> OS-backed local token storage
  -> local accounting database
  -> Ledgerly Cloud API for bank feeds, orgs, entitlement checks

Ledgerly Cloud
  -> hosted OIDC provider
  -> PostgreSQL
  -> Basiq API and Consent UI
  -> Stripe Billing / entitlements
  -> audit logs, monitoring, support/admin tooling
```

## Service Choices

Recommended v1:

- Identity: Auth0 or equivalent hosted OIDC provider with Authorization Code + PKCE, MFA, email verification, account recovery, organization support, and JWKS validation.
- Bank feeds: Basiq API v3.0 and hosted Consent UI.
- Cloud hosting: Render web service + managed PostgreSQL, or equivalent managed Node/Postgres platform with staging/prod separation, secret management, backups, logs, and AU-region suitability.
- Billing: Stripe Billing + Stripe Customer Portal + entitlement webhooks.
- Website: Astro, Next.js, or a simple static site deployed to Netlify, Vercel, or Render static site.
- Monitoring: Sentry or equivalent for backend errors and Electron crash reports, with sensitive-field scrubbing.
- Updates: Electron auto-update flow backed by GitHub Releases or cloud object storage update metadata.
- macOS distribution: Apple Developer ID signing and notarization.
- Windows distribution later: signed NSIS/MSIX installer with a code-signing certificate or Microsoft Trusted Signing.

## Investigation Summary And Product Implications

- Electron security guidance confirms the current direction: keep context isolation enabled, keep Node integration disabled in the renderer, enforce a CSP, avoid loading insecure remote content, and expose only narrow preload APIs. Ledgerly already started this, but every new auth, update, billing, and bank-feed IPC method must keep this pattern.
- Electron `safeStorage` is the right first local secret-storage step because it encrypts strings with OS-provided cryptography from the Electron main process. Ledgerly currently stores cloud session tokens in SQLite settings, so this must be changed before production.
- OAuth native-app guidance and Auth0 PKCE docs both support external-browser Authorization Code + PKCE. Ledgerly must not embed bank login or app login in an Electron webview.
- Auth0 refresh-token guidance supports refresh tokens for native apps, but says they must be stored securely. Refresh token rotation should be enabled for Ledgerly's desktop client.
- Basiq API guidance says the API key is exchanged for a `SERVER_ACCESS` token that expires every 60 minutes and should be refreshed server-side. This confirms the backend-only broker design.
- Basiq Consent UI is built for CDR consent management. Ledgerly should send users to hosted Basiq consent, then store only connection/account metadata and normalized transactions needed for reconciliation.
- Basiq webhooks can notify Ledgerly Cloud about connection, consent, account, and transaction events. Polling is acceptable for the first staging sync, but production should add webhooks for consent warnings, revocations, and transaction updates.
- OAIC CDR dashboard guidance requires consent withdrawal and redundant-data deletion controls to be simple, prominent, and no more difficult than granting consent. Ledgerly's Settings consent dashboard is directionally correct, but it needs legal/compliance review and real cloud deletion/de-identification handling.
- OAIC CDR policy guidance means Ledgerly will likely need a CDR/open-banking policy distinct from the general privacy policy if operating as a CDR participant or representative. A lawyer/compliance reviewer must determine the exact role and wording before sale.
- OAIC Notifiable Data Breaches guidance means Ledgerly needs an incident response and breach assessment process before handling customer bank-linked data at scale.
- Stripe Customer Portal can cover subscription self-service without building billing UI from scratch. Stripe entitlements can map paid plans to features such as bank feeds.
- Render provides managed web services, environment variables/secrets, and managed PostgreSQL. It is a practical v1 host, but any equivalent host is acceptable if it supports staging/prod separation, secrets, logs, backups, and an Australian-region posture suitable for customers.
- Electron Forge can generate platform-specific distributables such as DMG, Squirrel.Windows, and MSIX. The current `electron-packager` script is useful for local packaging but not enough for a normal customer installer/update flow.
- Apple requires Developer ID signing and notarization for professional macOS distribution outside the Mac App Store.
- Microsoft currently recommends Azure Artifact Signing for non-Store Windows app signing. Windows distribution can come after macOS if we want to launch on Mac first.

## Master Execution Order

This is the recommended order because each phase creates a foundation for the next one. Website, installer, and billing should not be first, because they need the production account/cloud model to exist.

### Pass 0: Freeze Direction And Update Docs

**Can do now:** Yes.
**Needs user:** Product name/domain/legal entity decisions only.

- [ ] Keep `/Users/davidnaguib/Desktop/Ledgerly` untouched as the backup.
- [ ] Keep active work in `/Volumes/1tb/Ledgerly-bank-feeds`.
- [ ] Update README so it no longer claims "no cloud account" as the commercial future.
- [ ] Add release docs under `docs/release/`.
- [ ] Add legal/compliance question docs under `docs/legal/`.
- [ ] Add security/threat-model docs under `docs/security/`.
- [ ] Commit docs cleanup separately as `docs: add Ledgerly commercial launch plan`.

### Pass 1: Real Cloud Persistence

**Can do now:** Mostly yes.
**Needs user:** Hosting choice can be deferred until after local Postgres tests.

- [x] Add `pg` dependency to `server/package.json`.
- [x] Create `server/src/db/postgres-store.js` implementing the same method surface as `memory-store`.
- [x] Keep `server/src/db/memory-store.js` as the test double.
- [x] Make `server/src/app.js` choose Postgres when `DATABASE_URL` exists and memory only in tests/dev.
- [x] Replace `server/src/db/migrate.js` with a real PostgreSQL migration runner. (Now applies numbered migration files under `server/src/db/migrations/` tracked in a `schema_migrations` table; re-running only applies pending migrations.)
- [x] Add store contract tests that run against `memory-store` and a local Postgres test database when available.
- [x] Add a deployment health check that confirms the app can reach the database without exposing secrets.
- [x] Commit as `feat: add Ledgerly Cloud Postgres persistence`.

### Pass 2: Hosted Staging Cloud

**Can do partly now:** Yes, config and docs.
**Needs user:** Render/Fly/Railway account access or environment variables.

- [x] Choose v1 host. Recommended default: Render.
- [x] Add `render.yaml` or a Dockerfile-based deploy path.
- [x] Configure staging env var prompts in `render.yaml`:
  - `APP_ENV=staging`
  - `DATABASE_URL`
  - `OIDC_ISSUER`
  - `OIDC_AUDIENCE`
  - `OIDC_JWKS_URL`
  - `BASIQ_API_KEY`
  - `CORS_ORIGINS`
  - `SENTRY_DSN` or equivalent later
- [x] Add staging deployment runbook in `docs/release/staging-cloud-deployment.md`.
- [ ] Deploy staging cloud API.
- [ ] Run migrations against staging.
- [ ] Verify `/healthz`, `/readyz`, auth rejection, and scrubbed errors.
- [x] Add rollback notes and backup/restore notes.
- [ ] Commit as `chore: add Ledgerly Cloud staging deployment`.

### Pass 3: Real Account Creation And Desktop Sign-In

**Can do partly now:** Code can be scaffolded.
**Needs user:** Auth0 tenant/app/API values.

- [ ] Create Auth0 tenant for staging.
- [ ] Create Ledgerly API audience.
- [ ] Create Ledgerly Desktop native app client.
- [ ] Enable Authorization Code + PKCE.
- [ ] Enable refresh token rotation.
- [ ] Enable email verification and MFA policy for production.
- [x] Add Electron main-process auth module:
  - generate verifier/challenge/state
  - open system browser
  - receive custom-protocol or loopback callback
  - exchange auth code for tokens
  - store refresh token using `safeStorage`
  - store access token only for current session where possible
- [x] Add preload IPC methods:
  - `cloudAuth.signIn`
  - `cloudAuth.signOut`
  - `cloudAuth.status`
  - `cloudAuth.refresh`
- [x] Do not expose raw token getters to renderer.
- [x] Update first-run company setup with optional cloud sign-in.
- [x] Update Settings with sign-in/sign-out/account status.
- [x] Add Auth0 desktop setup runbook in `docs/release/desktop-cloud-auth.md`.
- [ ] Commit as `feat: add secure Ledgerly Cloud sign-in`.

### Pass 4: Device And Organization Enforcement

**Can do after Pass 3:** Yes.
**Needs user:** None after auth tenant exists.

- [ ] Register each desktop install as a device after sign-in.
- [ ] Store device private key or token material with OS-backed protection.
- [ ] Send device identifier/proof on bank-feed API requests.
- [ ] Reject bank-feed calls for revoked devices.
- [ ] Ensure every bank-feed endpoint checks:
  - valid user
  - organization membership
  - role permission
  - active entitlement once billing exists
  - non-revoked device
- [ ] Add support route to revoke device.
- [ ] Commit as `feat: enforce org and device controls for bank feeds`.

### Pass 5: Real Basiq Sandbox Bank Linking

**Can do partly now:** Flow code is present; real test needs credentials.
**Needs user:** Basiq sandbox account/app/API key and any Basiq approval requirements.

- [ ] Create Basiq sandbox app.
- [ ] Configure consent policy, redirect/manage URLs, and webhook URL.
- [ ] Store `BASIQ_API_KEY` only in Ledgerly Cloud staging secrets.
- [ ] Start consent from desktop.
- [ ] Complete hosted Basiq Consent UI in system browser.
- [ ] Confirm cloud creates/reuses Basiq user per Ledgerly organization.
- [ ] Confirm cloud creates short-lived client token for consent launch only.
- [ ] List provider accounts after consent.
- [ ] Map provider account to local Ledgerly bank account.
- [ ] Sync transactions into `statement_lines`.
- [ ] Reconcile imported statement lines.
- [ ] Wait long enough to verify server token refresh behavior.
- [ ] Verify manage/reconnect/revoke/deletion-request paths.
- [ ] Add Basiq webhook receiver for consent/connection/transaction events.
- [ ] Commit as `test: document Basiq sandbox bank feed run`.

### Pass 6: Billing And Entitlements

**Can do partly now:** Data model and webhook handler can be built with Stripe test keys later.
**Needs user:** Stripe account, product/pricing decision, customer-facing billing terms.

- [ ] Create Stripe products:
  - Ledgerly Basic
  - Ledgerly Bank Feeds
  - Ledgerly Business or Team, if needed
- [ ] Add `billing_customer_id`, subscription status, plan, and entitlement fields to cloud organizations.
- [ ] Add checkout-session route.
- [ ] Add customer-portal route.
- [ ] Add Stripe webhook route with signature verification.
- [ ] Listen for subscription and entitlement updates.
- [ ] Enforce `bank_feeds` entitlement on bank-feed endpoints.
- [ ] Add Settings/account UI entry for "Manage billing".
- [ ] Commit as `feat: add subscriptions and bank-feed entitlements`.

### Pass 7: Website And Account Portal

**Can do now:** Static website scaffold can start.
**Needs user:** Domain, brand positioning, pricing, legal policy approvals.

- [ ] Create `website/`.
- [ ] Recommended stack: Astro for a fast content/download site, or Next.js if the account portal is built in the same app.
- [ ] Add pages:
  - `/`
  - `/pricing`
  - `/download`
  - `/help`
  - `/security`
  - `/privacy`
  - `/terms`
  - `/open-banking`
  - `/contact`
- [ ] Add account portal:
  - sign in/sign up
  - organization profile
  - billing portal launcher
  - device/session list
  - download latest installer
  - support request link
- [ ] Deploy website to Netlify, Vercel, Render static site, or equivalent.
- [ ] Point domain and add HTTPS.
- [ ] Commit as `feat: add Ledgerly website and account portal`.

### Pass 8: Installer, Signing, Notarization, And Updates

**Can do partly now:** Packaging config can be added.
**Needs user:** Apple Developer account/certificate access; Windows signing later.

- [ ] Choose packaging tool. Recommended: Electron Forge for official Electron packaging/publishing flow.
- [ ] Add Forge config with makers:
  - macOS DMG
  - macOS ZIP for auto-update
  - Windows Squirrel or MSIX later
- [ ] Add app metadata:
  - app ID
  - company name
  - copyright
  - icon paths
  - protocol handler for auth callback
- [ ] Configure macOS hardened runtime.
- [ ] Configure Developer ID signing.
- [ ] Configure Apple notarization.
- [ ] Add release CI.
- [ ] Publish signed/notarized beta installer.
- [ ] Add auto-update metadata and update checks.
- [ ] Verify clean install, update, rollback, uninstall, and reinstall.
- [ ] Commit as `build: add signed installer and update pipeline`.

### Pass 9: Legal, Compliance, And Policies

**Can do partly now:** Draft question list and policy skeletons.
**Needs user:** Lawyer/compliance reviewer and final approval.

- [ ] Decide Ledgerly's CDR role with legal advice:
  - direct accredited data recipient
  - CDR representative under a principal
  - outsourced service provider path
  - Basiq partner path with limited obligations
- [ ] Draft privacy policy.
- [ ] Draft terms of service.
- [ ] Draft CDR/open-banking policy if required.
- [ ] Draft data retention and deletion policy.
- [ ] Draft support and complaints process.
- [ ] Draft incident response process.
- [ ] Draft vulnerability disclosure process.
- [ ] Confirm how accounting records are handled when bank-feed data deletion is requested.
- [ ] Commit as `docs: add legal and compliance launch pack`.

### Pass 10: Monitoring, Support, And Admin Tools

**Can do after cloud exists:** Yes.
**Needs user:** Monitoring provider choice and support email/domain.

- [ ] Add Sentry or equivalent backend error reporting with sensitive-field scrubbing.
- [ ] Add Electron crash reporting only after privacy wording is approved.
- [ ] Add uptime checks for website and cloud.
- [ ] Add alerts for:
  - API downtime
  - Basiq error spike
  - sync failures
  - auth failure spike
  - webhook failures
  - DB backup failure
  - migration failure
- [ ] Add admin/support tool:
  - find organization
  - view subscription state
  - view devices
  - revoke device
  - view audit events
  - view bank-feed connection status without secrets
- [ ] Commit as `feat: add production monitoring and support tooling`.

### Pass 11: Beta

**Can do after Passes 1-10:** Yes.
**Needs user:** Beta testers and consent to use test/sandbox or production bank connections.

- [ ] Run signed installer on clean macOS machine.
- [ ] Run full first-run setup.
- [ ] Sign in.
- [ ] Connect sandbox bank feed.
- [ ] Sync and reconcile transactions.
- [ ] Revoke and reconnect consent.
- [ ] Test billing checkout and cancellation in Stripe test mode.
- [ ] Collect support issues.
- [ ] Fix blockers.
- [ ] Commit beta fixes in focused commits.

### Pass 12: Production Launch

**Can do after legal/compliance and real provider setup:** Yes.
**Needs user:** Final go/no-go approval.

- [ ] Production cloud deployed.
- [ ] Production database backed up and restore-tested.
- [ ] Production Auth0 configured.
- [ ] Production Basiq access approved and configured.
- [ ] Production Stripe configured.
- [ ] Website live.
- [ ] Signed/notarized installer live.
- [ ] Auto-update active.
- [ ] Support, privacy, terms, and security pages live.
- [ ] Monitoring/alerts live.
- [ ] Launch checklist signed off.

## User Action Checklist

These are the things Codex cannot fully do alone because they involve legal identity, paid accounts, private dashboards, or business decisions.

- [ ] Choose final product name: keep `Ledgerly` or rename.
- [ ] Buy/confirm domain, recommended examples:
  - `ledgerly.com.au`
  - `ledgerly.app`
  - `ledgerly.com`
- [ ] Create product email addresses:
  - `support@...`
  - `security@...`
  - `privacy@...`
  - `billing@...`
- [ ] Decide legal entity that sells the product.
- [ ] Get legal/compliance review before selling bank-linked features.
- [ ] Create or provide access to Auth0/identity provider.
- [ ] Create or provide access to Basiq developer/sandbox account.
- [ ] Confirm Basiq commercial path and whether Ledgerly is operating under Basiq/ADR arrangements.
- [ ] Create or provide access to hosting provider account.
- [ ] Create or provide access to Stripe account.
- [ ] Create Apple Developer account for macOS signing/notarization.
- [ ] Decide whether Windows support is v1 or later.
- [ ] If Windows is v1, set up Microsoft Partner Center or Azure Artifact Signing.
- [ ] Approve privacy policy, terms, CDR policy, incident process, and support/complaints wording.
- [ ] Decide pricing:
  - local-only free/paid
  - bank feeds paid add-on
  - monthly/annual tiers
  - trial length
- [ ] Provide beta testers or test businesses when ready.

## What Codex Can Start Without Waiting

- [ ] Update README and docs so the repo matches the cloud-backed product direction.
- [ ] Implement PostgreSQL store and migration runner locally.
- [ ] Add local Postgres contract tests.
- [ ] Add Render deployment config and env-var documentation.
- [ ] Scaffold Electron auth module with test fake provider.
- [ ] Add `safeStorage` token-storage abstraction and tests.
- [ ] Add device-enforcement tests and server checks.
- [ ] Scaffold Stripe webhook/entitlement interfaces with test fixtures.
- [ ] Scaffold website and static product/download pages.
- [ ] Add Electron Forge packaging config for unsigned local builds.
- [ ] Draft legal/compliance question docs for lawyer review.
- [ ] Draft release checklist and manual staging checklist.

## What Must Wait For User-Provided Accounts Or Approval

- [ ] Real Auth0 tenant integration.
- [ ] Real Basiq sandbox/live bank connection.
- [ ] Real hosted staging deployment.
- [ ] Real Stripe checkout/portal.
- [ ] Real domain and email setup.
- [ ] Apple signing and notarization.
- [ ] Windows signing.
- [ ] Publishing legal/compliance policies.
- [ ] Production launch.

## Workstream File Map

Expected files and responsibilities:

- `server/src/db/postgres-store.js`: PostgreSQL implementation of the Ledgerly Cloud store.
- `server/src/db/migrate.js`: real migration runner for `schema.sql`.
- `server/src/db/schema.sql`: cloud schema source of truth.
- `server/src/app.js`: cloud route wiring, auth, bank-feed checks, billing routes, health checks.
- `server/src/auth/verify-token.js`: OIDC/JWKS validation.
- `server/src/auth/device-proof.js`: device request verification, to be added.
- `server/src/providers/basiq-client.js`: Basiq API integration.
- `server/src/providers/stripe-client.js`: Stripe API integration, to be added.
- `server/src/security/scrub.js`: safe logging redaction.
- `electron/main.js`: main-process IPC wiring, auth flow, cloud calls.
- `electron/security.js`: IPC validation and browser security.
- `src/services/cloud/client.js`: desktop-to-cloud API client.
- `src/services/cloud/session.js`: replace SQLite token storage with OS-backed secure storage.
- `src/services/cloud/auth-flow.js`: desktop PKCE auth flow, to be added.
- `src/services/security/token-store.js`: `safeStorage` wrapper, to be added.
- `ui/views/settings.js`: signed-in state, bank-feed dashboard, billing/account links.
- `ui/views/setup.js` or first-run setup module: optional sign-in and optional bank-connect step, to be added if first-run code is split.
- `build/`: desktop icon assets.
- `website/`: public site and account portal, to be added.
- `docs/release/`: launch, staging, installer, and rollback checklists, to be added.
- `docs/legal/`: legal/compliance questions and draft policy notes, to be added.
- `docs/security/`: threat model and vulnerability process, to be added.

## Testing Strategy

- Unit tests:
  - accounting core
  - reconciliation
  - cloud client
  - cloud auth
  - Basiq client with mocks
  - billing webhooks
  - entitlement checks
- Integration tests:
  - desktop-to-cloud auth session
  - desktop-to-cloud bank-feed connect/map/sync
  - PostgreSQL store contract tests
  - Stripe webhook event flow
  - OIDC JWKS validation
- Smoke tests:
  - all desktop screens
  - first-run setup
  - sign in/out
  - connect bank optional setup path
  - connect bank later in settings
  - map/sync/reconcile
- Real staging manual tests:
  - Basiq sandbox consent
  - 60-minute token refresh
  - consent expiry/reconnect
  - revoke
  - deletion request
  - cloud deployment rollback
  - database restore
  - signed installer install/update
- Security tests:
  - no provider secrets in renderer bundle
  - no provider server tokens in local SQLite
  - refresh token stored only with OS-backed protection
  - auth callback rejects invalid state/verifier
  - bank-feed endpoints reject viewer/unauthorized/revoked device
  - webhooks verify signatures
  - logs scrub secrets and PII where required

## Immediate Next Coding Pass

Start with Pass 1 through Pass 5, because everything else depends on cloud persistence, secure login, device enforcement, and one real Basiq sandbox run:

1. Implement a real PostgreSQL-backed cloud store behind the current store interface.
2. Add real migration execution.
3. Add staging deployment config and documented env vars.
4. Implement the desktop Auth0/OIDC PKCE sign-in flow with OS-backed token storage.
5. Enforce device registration on bank-feed endpoints.
6. Then run the Basiq sandbox staging checklist.

## Reference Sources

- Electron security checklist: https://electronjs.org/docs/latest/tutorial/security
- Electron safeStorage: https://electronjs.org/docs/latest/api/safe-storage
- Electron autoUpdater: https://electronjs.org/docs/latest/api/auto-updater
- Electron publishing and updates: https://electronjs.org/docs/latest/tutorial/tutorial-publishing-updating
- Apple notarization: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- Apple Developer ID: https://developer.apple.com/developer-id/
- Auth0 Authorization Code Flow with PKCE: https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce
- Auth0 refresh tokens: https://auth0.com/docs/secure/tokens/refresh-tokens
- Auth0 refresh token rotation: https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation
- OAuth 2.0 for Native Apps, RFC 8252: https://datatracker.ietf.org/doc/html/rfc8252
- Basiq quickstart/API token guidance: https://api.basiq.io/docs/quickstart-api
- Basiq Consent UI: https://api.basiq.io/docs/consent
- Basiq Consent Actions: https://api.basiq.io/docs/consent-actions
- Basiq webhooks: https://api.basiq.io/docs/webhooks
- OAIC CDR consent/dashboard guidance: https://www.oaic.gov.au/consumer-data-right/consumer-data-right-guidance-for-business/privacy-obligations/consumer-consent%2C-authorisation-and-dashboards
- OAIC CDR policy guidance: https://www.oaic.gov.au/consumer-data-right/consumer-data-right-guidance-for-business/privacy-obligations/guide-to-developing-a-consumer-data-right-policy
- OAIC Notifiable Data Breaches guidance: https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/preventing-preparing-for-and-responding-to-data-breaches/data-breach-preparation-and-response/part-4-notifiable-data-breach-ndb-scheme
- Stripe Customer Portal: https://docs.stripe.com/customer-management
- Stripe entitlements: https://docs.stripe.com/billing/entitlements
- Render environment variables/secrets: https://render.com/docs/configure-environment-variables
- Render Postgres: https://render.com/docs/postgresql
- Render Postgres backups: https://render.com/docs/postgresql-backups
- Electron Forge makers: https://www.electronforge.io/config/makers
- Electron Forge Squirrel.Windows maker: https://www.electronforge.io/config/makers/squirrel.windows
- Microsoft Windows app code-signing options: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- Microsoft Azure Artifact Signing quickstart: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
