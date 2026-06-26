# Secure Bank Connect Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Xero-like "Connect bank account" flow to Ledgerly where users can optionally connect during organisation setup or later from banking/settings, while bank-provider secrets stay behind a small backend/token broker.

**Architecture:** Keep Ledgerly's existing local accounting and reconciliation code intact. Add a narrow bank-feed broker boundary that owns Basiq API-key exchange, token refresh, Basiq user creation, Consent UI URLs, account listing, job polling, and connection metadata; the renderer only receives safe connection status, account choices, and sync results.

**Tech Stack:** Electron, CommonJS Node.js, `node:sqlite` `DatabaseSync`, local SQLite migrations in `src/db.js`, IPC through `electron/main.js` and `electron/preload.js`, Basiq API v3.0, Basiq hosted Consent UI, existing provider-neutral `statement_lines` importer, vanilla JS renderer, `node:test`, and the existing smoke runner.

---

## Current State

The copied repo at `/Volumes/1tb/Ledgerly-bank-feeds` already has the Xero-style reconciliation engine:

- Bank feed transactions import into `statement_lines`.
- Duplicate provider transaction IDs are skipped.
- Reconcile queue supports match, create, transfer, split, and rule suggestions.
- Basiq transaction sync exists, but it currently asks the user to paste a `SERVER_ACCESS` token into Settings.

This plan replaces that testing-only Basiq settings path with a safer, Xero-like connect flow.

## Source Notes

- Xero's user flow is "Accounting > Bank accounts > Add bank account", search/select bank, authorize, then transactions flow automatically and reconciliation suggestions appear.
- Xero distinguishes bank connection from reconciliation: the feed imports bank data; reconciliation is the review/match/create step.
- Xero presents read-only bank feeds as secure, encrypted data connections and says bank feeds cannot make payments.
- Basiq v3.0 requires the Basiq Consent UI for consent capture.
- Basiq API keys must be kept secret and not placed in client-side code.
- Basiq access tokens expire after 60 minutes and should be refreshed by the backend.
- Basiq Consent UI is launched with a `CLIENT_ACCESS` token bound to the Basiq `userId`.
- Basiq Consent UI returns job IDs; Ledgerly should poll jobs until account and transaction retrieval completes.

References:

- `https://www.xero.com/us/accounting-software/connect-your-bank/`
- `https://central.xero.com/s/article/Connect-your-bank-to-Xero-US`
- `https://central.xero.com/s/article/Bank-reconciliation-in-Xero`
- `https://api.basiq.io/docs/quickstart-api`
- `https://api.basiq.io/docs/consent`
- `https://api.basiq.io/docs/consent-actions`

## Product Flow

### First-Run Organisation Setup

Add an optional bank-feed step to the existing setup wizard:

1. User enters organisation details as today.
2. Ledgerly shows a compact optional panel: "Connect a bank account".
3. Primary setup button remains "Start using Ledgerly".
4. Secondary action is "Connect bank account", which starts the same connection flow available later.
5. If skipped, setup completes normally and no bank-feed state is created.

This keeps onboarding fast like Xero: bank connection is encouraged, but it does not block creating books.

### Bank Accounts Screen

On the bank account list and individual account page:

1. Show "Connect bank account" as the main live-feed action.
2. If no provider account is linked, clicking it opens the bank connection wizard.
3. If provider accounts are already connected, clicking it lets the user map a provider account to a Ledgerly bank account.
4. Once mapped, the bank account page shows feed status, last sync time, consent expiry, and "Sync now".

### Settings

Replace raw Basiq token fields with a Bank feeds dashboard:

- Connection status.
- Connected institutions/accounts.
- Consent expiry.
- Manage consent.
- Reconnect/reauthorise.
- Remove local mapping.
- Development-only diagnostics when `LEDGERLY_BANK_FEED_DEV=1`.

Do not expose provider API keys, server tokens, or refresh tokens in the renderer.

## Backend/Broker Design

The first implementation uses a small backend module with an injectable transport. It can run inside Electron main process for local development, but it is deliberately shaped so it can move to a hosted Ledgerly Cloud service without changing the renderer or reconciliation code.

### Broker Responsibilities

- Read Basiq API key from server-side environment/config only.
- Exchange API key for `SERVER_ACCESS` token.
- Cache `SERVER_ACCESS` token until close to expiry.
- Create or reuse Basiq user for the Ledgerly organisation/user.
- Generate `CLIENT_ACCESS` token bound to that Basiq user.
- Return Basiq Consent UI URL to Electron main process.
- Poll Basiq jobs after consent.
- List Basiq accounts for mapping.
- Sync transactions by calling existing Basiq adapter/importer.
- Store only provider metadata and cursors locally.

### Renderer Boundary

Expose only these IPC methods:

```text
bankFeed('startConnect', { action })
bankFeed('listProviderAccounts', {})
bankFeed('mapProviderAccount', { providerAccountId, bankAccountId })
bankFeed('syncLinkedAccount', { bankAccountId })
bankFeed('manageConsent', {})
bankFeed('disconnectLocalMapping', { linkId })
```

Renderer must never receive:

- Basiq API key.
- `SERVER_ACCESS` token.
- Refresh token.
- Generic "get token" IPC method.

## Local Data Model

Add small, local metadata tables. These store mapping and user experience state only, not bank-provider secrets.

```text
bank_feed_connections
  id
  provider
  provider_user_id
  provider_connection_id
  institution_name
  status
  consent_status
  consent_expires_at
  last_sync_at
  last_error
  created_at
  updated_at

bank_feed_account_links
  id
  connection_id
  provider
  provider_account_id
  provider_account_name
  provider_account_number
  provider_account_type
  bank_account_id
  sync_cursor
  last_sync_at
  created_at
  updated_at
```

Existing `statement_lines` source metadata remains the source of imported bank transactions.

## Implementation Phases

### Phase 1: Basiq Broker Core

**Files:**

- Create: `/Volumes/1tb/Ledgerly-bank-feeds/src/services/bank-feed/basiq-broker.js`
- Test: `/Volumes/1tb/Ledgerly-bank-feeds/tests/bank-feed-broker.test.js`

- [ ] Write failing tests for:
  - `SERVER_ACCESS` token exchange uses Basic API key and `scope=SERVER_ACCESS`.
  - Token cache refreshes before expiry.
  - `CLIENT_ACCESS` token is created with a `userId`.
  - Consent URL uses `https://consent.basiq.io/home?token=...&action=connect`.
  - API key is never returned from public broker results.
- [ ] Run: `npm test -- tests/bank-feed-broker.test.js`
- [ ] Implement the broker with injected `fetch`, `now`, `baseUrl`, `consentBaseUrl`, and `apiKey`.
- [ ] Run: `npm test -- tests/bank-feed-broker.test.js && npm test`
- [ ] Commit: `feat: add secure Basiq broker core`

### Phase 2: Connection Metadata Store

**Files:**

- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/src/db.js`
- Create: `/Volumes/1tb/Ledgerly-bank-feeds/src/services/bank-feed/connections.js`
- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/src/api.js`
- Test: `/Volumes/1tb/Ledgerly-bank-feeds/tests/bank-feed-connections.test.js`

- [ ] Write failing tests for creating/upserting connections and account links.
- [ ] Add idempotent migrations for `bank_feed_connections` and `bank_feed_account_links`.
- [ ] Add methods:
  - `bankFeed.connections`
  - `bankFeed.accountLinks`
  - `bankFeed.upsertConnection`
  - `bankFeed.mapAccount`
  - `bankFeed.disconnectLocalMapping`
- [ ] Run: `npm test -- tests/bank-feed-connections.test.js && npm test`
- [ ] Commit: `feat: store bank feed connection metadata`

### Phase 3: Broker-backed IPC

**Files:**

- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/electron/main.js`
- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/electron/preload.js`
- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/src/services/bank-feed/basiq.js`
- Test: `/Volumes/1tb/Ledgerly-bank-feeds/tests/bank-feed-broker.test.js`

- [ ] Add `startConnect` IPC method that asks broker for a consent URL and opens it in the system browser.
- [ ] Add `listProviderAccounts` IPC method that fetches Basiq accounts through broker.
- [ ] Add `syncLinkedAccount` IPC method that reuses the existing `syncTransactions` importer without renderer tokens.
- [ ] Keep old `basiqSync` only behind dev mode or remove it after UI migration.
- [ ] Run: `npm test && npm run smoke`
- [ ] Commit: `feat: add broker-backed bank feed IPC`

### Phase 4: Xero-like Connection Wizard UI

**Files:**

- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/ui/views/bank.js`
- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/ui/views/settings.js`
- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/ui/styles.css`
- Test: `/Volumes/1tb/Ledgerly-bank-feeds/scripts/run-smoke.js`

- [ ] Replace "Sync Basiq feed" prompt with "Connect bank account".
- [ ] Add modal wizard states:
  - Intro: read-only feed explanation.
  - Connect: opens Basiq Consent UI.
  - Waiting: user returns after consent.
  - Map: choose provider account and Ledgerly bank account.
  - Done: sync now or reconcile.
- [ ] Add Settings bank-feed dashboard.
- [ ] Keep UI compact and operational, matching the app's existing card/table style.
- [ ] Run: `npm run smoke && npm test`
- [ ] Commit: `feat: add bank connect wizard`

### Phase 5: Optional Setup Entry Point

**Files:**

- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/ui/views/dashboard.js`
- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/scripts/run-smoke.js`

- [ ] Add a compact optional "Connect a bank account" panel in first-run setup.
- [ ] Do not block setup if skipped or broker is not configured.
- [ ] If the user connects during setup, save organisation details first, then open the same bank connection wizard.
- [ ] Add smoke coverage for skipping setup bank connection.
- [ ] Run: `npm run smoke && npm test`
- [ ] Commit: `feat: offer bank linking during setup`

### Phase 6: Consent Management

**Files:**

- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/src/services/bank-feed/basiq-broker.js`
- Modify: `/Volumes/1tb/Ledgerly-bank-feeds/ui/views/settings.js`
- Test: `/Volumes/1tb/Ledgerly-bank-feeds/tests/bank-feed-broker.test.js`

- [ ] Add `manageConsent` URL generation with `action=manage`.
- [ ] Add `reauthorise` URL generation with `connectionId` where available.
- [ ] Show consent expiry and reconnect prompts.
- [ ] Add local disconnect flow that removes mapping but does not delete accounting history.
- [ ] Run: `npm test && npm run smoke`
- [ ] Commit: `feat: manage bank feed consent`

### Phase 7: Commercial Security Follow-up

This phase is tracked in docs, not as part of the first connect-button implementation:

- Hosted Ledgerly Cloud API with real auth.
- OAuth/OIDC PKCE login.
- Organisation memberships and roles.
- Subscription entitlement checks.
- Device/session revocation.
- CDR dashboard/privacy policy/legal review.
- Optional local app lock and local database encryption.

## Testing Strategy

### Unit Tests

- Broker token exchange, expiry, refresh, and error mapping.
- Client token generation for consent.
- Consent/manage/reauthorise URL creation.
- Connection metadata upserts and account mapping.
- Sync imports using existing statement-line importer.

### Integration Tests

- Fake Basiq transport: create user, generate consent URL, list accounts, map one account, sync transactions.
- Duplicate sync does not create duplicate statement lines.
- Revoked/expired consent blocks sync and shows reconnect status.

### Smoke Tests

- First-run setup can be completed without connecting a bank.
- Bank account page shows connect action.
- Settings bank feeds dashboard renders with no broker configured.
- Existing reconciliation screens still render.

### Manual Real-Provider Test

For sandbox/live testing:

1. Set server-side `LEDGERLY_BASIQ_API_KEY`.
2. Start Ledgerly from `/Volumes/1tb/Ledgerly-bank-feeds`.
3. Create or open an organisation.
4. Go to Bank accounts and click "Connect bank account".
5. Complete Basiq Consent UI in the system browser.
6. Return to Ledgerly and map the provider account to a Ledgerly bank account.
7. Click "Sync now".
8. Confirm new `statement_lines` appear in the reconcile queue.
9. Reconcile one matched line and verify reports remain journal-driven.

## Non-Goals For This Pass

- Building a payment initiation feature.
- Storing bank login credentials in Ledgerly.
- Moving the whole accounting app to a cloud database.
- Auto-posting bank rules without user confirmation.
- Full production CDR compliance documents.
- Final hosted auth/subscription implementation.

## Self-Review

- The plan keeps provider-specific code outside core accounting logic.
- The renderer receives only safe workflow data.
- Existing reconciliation APIs remain the posting boundary.
- The setup flow stays optional, so a user can start using Ledgerly without a bank feed.
- The first implementation slice is isolated and test-first.
