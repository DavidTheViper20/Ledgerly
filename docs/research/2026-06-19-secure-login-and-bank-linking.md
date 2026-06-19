# Secure Login, Accounts, And Bank Linking Research

This research note is for the commercial version of Ledgerly. It is not an implementation patch. It defines the security architecture that should sit around bank linking before the app is sold to customers.

## Recommendation

Use a cloud-backed identity and bank-feed gateway instead of putting bank-provider secrets or account-management logic directly inside the Electron app.

Recommended shape:

```text
Ledgerly Electron app
  -> external browser login using OAuth/OIDC + PKCE
  -> Ledgerly Cloud API
  -> hosted identity provider
  -> Basiq/Open Banking provider
  -> statement_lines in local Ledgerly database
```

The desktop app stays local-first for accounting workflows, but login, subscriptions, bank-feed consent, provider tokens, revocation, and audit events are handled through a backend service.

## Why This Is Needed

Ledgerly is currently a local desktop accounting app. That is good for user control, but bank linking changes the risk profile:

- Bank-feed provider API keys must not be stored in Electron source, renderer JavaScript, or local SQLite.
- Users need accounts, password recovery, MFA, device/session revocation, subscription/entitlement checks, and consent management.
- Australian Open Banking/CDR data requires explicit consent, a dashboard for managing or withdrawing consent, and a way to delete redundant data.
- If Ledgerly is sold commercially, local data security, support access, billing, account recovery, audit logging, and incident response become product requirements.

## Sources Consulted

- RFC 8252 says OAuth authorization requests from native apps should use an external user-agent, primarily the user's browser: https://www.rfc-editor.org/info/rfc8252/
- Auth0 documents Authorization Code Flow with PKCE for public clients, including native apps that cannot securely store a client secret: https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce
- Supabase Auth supports PKCE for OAuth sign-in flows: https://supabase.com/docs/guides/auth/sessions/pkce-flow
- Electron recommends context isolation and other security controls for renderer isolation: https://electronjs.org/docs/latest/tutorial/security
- Electron `safeStorage` encrypts strings using OS-provided cryptography systems: https://electronjs.org/docs/latest/api/safe-storage
- Basiq quickstart covers API-key-to-access-token exchange and notes access tokens expire after 60 minutes: https://api.basiq.io/docs/quickstart-api
- Basiq Consent UI is hosted by Basiq and uses a client token bound to the Basiq user ID: https://api.basiq.io/docs/consent
- Basiq `action=manage` lets users view consent details, expiry, connections, delete connections, or revoke consent: https://api.basiq.io/docs/consent-actions
- OAIC says CDR consumer dashboards must let consumers withdraw consent and elect redundant-data deletion in a simple, prominent way: https://www.oaic.gov.au/consumer-data-right/consumer-data-right-guidance-for-business/privacy-obligations/consumer-consent%2C-authorisation-and-dashboards
- CDR provider obligations include an accessible CDR policy explaining data management, enquiries, and complaints: https://www.cdr.gov.au/for-providers/legal-obligations-data-recipients
- OWASP Password Storage recommends secure password hashing when passwords are stored: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Cryptographic Storage guidance says passwords should not be stored using reversible encryption: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- NIST SP 800-63B-4 is the current NIST authentication guideline family for digital identity services: https://pages.nist.gov/800-63-4/sp800-63b.html

## Identity Provider Decision

Do not build username/password auth from scratch for the first commercial version.

Recommended first provider: Auth0 or a comparable hosted OIDC provider.

Why:

- It supports OAuth/OIDC and PKCE for native apps.
- It can handle MFA, password reset, email verification, social login, suspicious-login controls, and session revocation.
- It avoids storing password hashes in Ledgerly infrastructure early.

Supabase Auth is a reasonable alternative if Ledgerly also wants a managed Postgres backend soon. Clerk can be considered for web-heavy account management, but for this desktop-first app the deciding requirement is clean native-app PKCE support plus backend token validation.

## Desktop Login Flow

Use OAuth/OIDC Authorization Code Flow with PKCE.

Flow:

```text
1. User clicks Sign in in Ledgerly.
2. Electron main process creates PKCE verifier/challenge and opens the system browser.
3. User authenticates with the hosted identity provider in the browser.
4. Identity provider redirects back to Ledgerly using a registered custom protocol or localhost callback.
5. Electron main process exchanges the auth code for tokens.
6. Access token is kept in memory.
7. Refresh token, if used, is stored through Electron safeStorage or the OS keychain.
8. Renderer receives only sanitized auth state through preload IPC.
```

Important constraints:

- No embedded login WebView for production auth.
- No client secret in the Electron app.
- No provider API keys in local settings.
- No raw tokens exposed to renderer JavaScript.
- Auth IPC should expose narrow methods such as `auth.signIn`, `auth.signOut`, `auth.me`, and `auth.refresh`, not a generic token getter.

## Ledgerly Cloud API

The commercial version needs a small backend service. It does not need to replace the desktop accounting engine.

Responsibilities:

- Validate user identity tokens from the hosted identity provider.
- Manage Ledgerly users, organizations, memberships, and roles.
- Manage subscriptions and license entitlements.
- Own all bank-feed provider secrets.
- Create Basiq users and Basiq client tokens.
- Store provider connection metadata and sync cursors.
- Receive provider webhooks later.
- Log account, consent, and sync events.
- Provide a customer account dashboard.

Minimum data model:

```text
users
  id
  identity_provider
  identity_subject
  email
  name
  created_at

organizations
  id
  name
  billing_customer_id
  created_at

organization_memberships
  organization_id
  user_id
  role
  created_at

devices
  id
  user_id
  name
  last_seen_at
  revoked_at

bank_feed_connections
  id
  organization_id
  provider
  provider_user_id
  provider_connection_id
  consent_status
  consent_expires_at
  last_sync_at
  revoked_at

bank_feed_account_links
  id
  connection_id
  provider_account_id
  ledgerly_bank_account_id
  ledgerly_org_local_id

security_events
  id
  organization_id
  user_id
  event_type
  metadata_json
  ip_address
  created_at
```

## Bank Linking Flow

Basiq-first architecture:

```text
1. Desktop app authenticates with Ledgerly Cloud.
2. Desktop asks Ledgerly Cloud to start bank linking.
3. Ledgerly Cloud creates or reuses a Basiq user mapped to the Ledgerly user/org.
4. Ledgerly Cloud requests a Basiq client token bound to that Basiq user ID.
5. Desktop opens Basiq Consent UI in the system browser.
6. User consents and connects institutions through Basiq-hosted UI.
7. Desktop or backend confirms connection status.
8. Desktop shows provider accounts for mapping to Ledgerly bank accounts.
9. Sync imports transactions into local `statement_lines`.
10. User reconciles through Ledgerly.
```

Do not store Basiq `SERVER_ACCESS` tokens or API keys in the Electron app. Basiq access tokens expire after 60 minutes, so refreshing them belongs on the backend.

## Consent Management

Ledgerly needs a visible Bank Feeds dashboard before production launch.

Required actions:

- View connected institutions.
- View consent expiry.
- Reconnect or renew consent.
- Open Basiq consent management using `action=manage`.
- Revoke connection.
- Delete local feed metadata and redundant synced CDR data when required.
- Explain what happens when consent is withdrawn.

This must be as easy to find as the connect action. OAIC guidance explicitly expects withdrawal and redundant-data deletion controls to be simple, straightforward, and prominently displayed.

## Local Data Protection

Current Ledgerly stores organization books in local SQLite under Electron user data. That may be acceptable for personal-use desktop software, but a commercial bank-linked product should add a local protection layer.

Recommended staged approach:

1. Keep bank-provider secrets out of local SQLite entirely.
2. Store only provider transaction IDs, account IDs, and imported statement lines locally.
3. Store refresh/session tokens using Electron safeStorage or OS keychain.
4. Add optional app lock using OS biometrics/password where available.
5. Add encrypted local database support before selling to businesses that expect stronger local data protection.

Database encryption options for later research:

- SQLCipher-backed SQLite distribution.
- App-level encrypted backup/export format.
- Per-organization local encryption key stored in OS keychain.

## Electron Security Notes

The current app already uses:

```js
contextIsolation: true
nodeIntegration: false
sandbox: false
```

Before production auth/bank linking:

- Keep `contextIsolation: true`.
- Keep `nodeIntegration: false`.
- Avoid loading remote content in the main application renderer.
- Add a restrictive Content Security Policy.
- Make IPC methods narrow and validate all inputs in the main process.
- Do not expose generic token access to the renderer.
- Keep bank-feed networking in main process or backend, not renderer views.
- Revisit `sandbox: false`; if it cannot be changed immediately, document why and limit renderer privileges.

## Authentication Feature Plan

This should become a separate implementation plan after the bank-feed importer is stable.

Phase A: Auth research spike

- Pick identity provider.
- Register development OAuth app.
- Decide custom protocol versus localhost callback.
- Decide token storage policy.
- Threat model login, logout, token refresh, and account deletion.

Phase B: Local auth shell

- Add `src/services/auth/session.js`.
- Add `electron/main.js` auth IPC.
- Add `electron/preload.js` auth bridge.
- Add login/logout UI.
- Add tests with fake identity provider.

Phase C: Cloud API skeleton

- Add minimal backend service outside Electron.
- Validate identity provider tokens.
- Add organizations, memberships, devices, security events.
- Add subscription entitlement placeholder.

Phase D: Bank-link token broker

- Move Basiq API keys to backend.
- Create Basiq users server-side.
- Generate Basiq client tokens server-side.
- Store connection metadata server-side.

Phase E: Consent dashboard

- Add visible connection list.
- Add manage consent action.
- Add revoke consent action.
- Add local redundant-data deletion flow.

Phase F: Commercial hardening

- MFA policy.
- Recovery flow.
- Device revocation.
- Audit log export.
- App lock.
- Local DB encryption decision.
- Privacy policy, CDR policy, terms, support process, incident response process.

## Testing Strategy

Unit tests:

- PKCE verifier/challenge generation.
- Auth callback parsing.
- Token storage abstraction with fake safeStorage.
- Login state transitions.
- Backend token validation with fixture JWTs.
- Basiq token broker request validation.
- Consent status mapping.

Integration tests:

- Fake identity provider login.
- Fake bank provider connect, manage, revoke.
- Sync after login imports statement lines.
- Revoked consent blocks sync.
- Logout clears local session but does not delete accounting books.

Security tests:

- Renderer cannot read refresh token.
- Bank-feed API keys never appear in renderer bundle or local SQLite.
- IPC rejects unknown methods and invalid arguments.
- Revoked device cannot call backend.
- Local token deletion makes authenticated calls fail.

Manual QA:

- Login using external browser.
- Quit and relaunch restores session only through safe storage.
- Sign out clears session.
- Revoke device from dashboard blocks the desktop app.
- Link bank through consent UI.
- Manage/revoke consent.
- Re-sync after consent expires shows a clear reconnect state.

## Next Recommendation

For the next coding pass, start with the bank-feed implementation plan already saved at:

`docs/superpowers/plans/2026-06-19-xero-style-bank-reconciliation.md`

Do not implement production login in the same pass as the first bank-feed importer. Build the statement-line/reconciliation architecture first. Then implement authentication and bank-feed token brokering as the next major track.

