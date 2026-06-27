# ADR: Production Bank Connect Architecture

## Status

Accepted.

## Context

Ledgerly now has a local-first Xero-style reconciliation engine and a development
bank-feed broker inside Electron main process. That local broker is useful for
proving the flow, but it is not a production design for a sellable app.

Production bank linking changes the risk profile:

- Basiq API keys and server access tokens must not ship inside Electron.
- Desktop apps cannot safely store provider client secrets.
- Users need login, account recovery, MFA, device revocation, organization roles,
  consent management, audit logs, and support workflows.
- Australian CDR-style consent requires prominent controls for managing and
  withdrawing consent and handling redundant data.

## Decision

Ledgerly production bank linking will use Ledgerly Cloud.

The production architecture is:

```text
Ledgerly Desktop
  -> external browser login with OAuth/OIDC PKCE
  -> Ledgerly Cloud API
  -> hosted identity provider
  -> PostgreSQL metadata store
  -> Basiq API and hosted Consent UI
  -> normalized transactions returned to desktop
  -> local statement_lines
  -> local reconciliation
```

Ledgerly Desktop remains local-first for accounting, statements, reconciliation,
reports, and books. Ledgerly Cloud owns identity, bank-provider secrets, provider
token refresh, consent start/manage/revoke, account mapping metadata, sync runs,
device/session controls, and audit events.

## Identity Provider

Use a hosted OIDC identity provider for v1 rather than building password auth
from scratch.

Recommended default: Auth0 or an equivalent OIDC provider with:

- Authorization Code + PKCE support for native apps.
- MFA support.
- Email verification.
- Password reset and account recovery.
- Organization or tenant membership support.
- JWKS-based JWT verification.
- Session/device revocation support.

If Ledgerly later chooses to store passwords directly, it must follow OWASP
password storage guidance and use a slow password hashing scheme such as Argon2id,
bcrypt, or PBKDF2. That is deliberately not the v1 recommendation.

## Hosting

Use a hosted backend with managed PostgreSQL and separate staging and production
environments.

Recommended initial hosting options:

- Render web service + managed PostgreSQL.
- Fly.io app + managed PostgreSQL.
- Railway service + managed PostgreSQL.

Selection criteria:

- Server-side environment secrets.
- TLS by default.
- Managed PostgreSQL backups.
- Separate staging and production projects.
- Log drains or structured log export.
- Simple deploy rollback.
- Region choice suitable for Australian customers.

## Basiq Integration

Basiq integration must run only on Ledgerly Cloud.

Cloud responsibilities:

- Store `BASIQ_API_KEY` only in backend secrets.
- Exchange the API key for `SERVER_ACCESS` tokens server-side.
- Refresh server tokens before expiry.
- Create/reuse Basiq users per Ledgerly organization.
- Generate `CLIENT_ACCESS` tokens for Basiq Consent UI.
- List Basiq accounts after consent.
- Sync transactions through Basiq APIs.
- Return normalized transaction records to the desktop.

Desktop must never receive:

- Basiq API key.
- Basiq `SERVER_ACCESS` token.
- Generic provider token access.

## Consent And Compliance Assumptions

Ledgerly will target Australian small businesses first. Before selling bank-linked
Ledgerly commercially, the product must complete legal/compliance review for:

- Consumer Data Right obligations and exemptions.
- Privacy policy.
- CDR-style consumer dashboard obligations.
- Consent withdrawal.
- Redundant-data deletion or de-identification.
- Support and complaint handling.
- Incident response.
- Data retention.

The first production implementation should avoid storing full raw bank transaction
payloads in Ledgerly Cloud unless legal review explicitly approves it. The desktop
can store imported statement lines locally because that is the user's bookkeeping
data.

## Security Requirements

- Desktop auth uses external-browser OAuth/OIDC PKCE.
- Refresh/session tokens are stored only with OS-backed secure storage.
- Renderer receives sanitized auth state only.
- Every cloud bank-feed endpoint verifies user session, organization membership,
  role, and device status.
- Every consent start/manage/revoke/sync/delete action emits an audit event.
- Cloud responses must not include provider server tokens or backend secrets.
- Electron IPC for auth/cloud/bank-feed operations must be narrow and validated.
- Direct Electron Basiq sync remains development-only and must not be enabled in
  production builds.

## Consequences

Positive:

- Provider secrets move out of Electron.
- Bank-linking can become sellable and supportable.
- Login, membership, audit, consent, and device controls have a natural home.
- The existing local reconciliation engine stays intact.

Tradeoffs:

- Ledgerly is no longer completely offline for live bank feeds.
- Ledgerly now needs hosted infrastructure, monitoring, backups, and support.
- Legal/compliance work becomes part of the release checklist.
- Desktop/cloud API versioning must be managed carefully.

## References

- Basiq quickstart and token flow: `https://api.basiq.io/docs/quickstart-api`
- Basiq Consent UI: `https://api.basiq.io/docs/consent`
- Basiq consent actions: `https://api.basiq.io/docs/consent-actions`
- OAuth for native apps: `https://datatracker.ietf.org/doc/html/rfc8252`
- Electron security checklist: `https://electronjs.org/docs/latest/tutorial/security`
- OAIC CDR consumer dashboard guidance: `https://www.oaic.gov.au/consumer-data-right/consumer-data-right-guidance-for-business/privacy-obligations/consumer-consent%2C-authorisation-and-dashboards`
- OWASP Password Storage Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html`
- OWASP Secrets Management Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html`
