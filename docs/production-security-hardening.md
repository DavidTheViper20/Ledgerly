# Ledgerly Production Security Hardening

This note records the Phase 8 controls that sit outside the desktop UI code path.

## Electron Desktop

- Renderer CSP is enforced in `ui/index.html` and again from Electron response headers.
- Browser windows use `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Renderer IPC for bank feeds and cloud sessions is allow-listed and shape-validated.
- Cloud sign-out deletes `cloud_session_token` and `cloud_refresh_token` from local SQLite.
- Local app lock stores PBKDF2 salted hashes only; the passcode is never stored.

## Secrets Separation

- Provider credentials stay in Ledgerly Cloud only. Do not put `BASIQ_API_KEY`, server tokens, or client tokens in the desktop app, renderer bundle, or local SQLite.
- Production deployments should source `DATABASE_URL`, `BASIQ_API_KEY`, OIDC config, and monitoring keys from the hosting platform secret manager or environment group.
- Desktop should authenticate to Ledgerly Cloud with a user/session token only. Sign-out must delete that local token.

## Cloud Database Backup And Restore

- Use managed PostgreSQL point-in-time recovery for the production database.
- Keep encrypted daily backups with retention aligned to the commercial/legal policy.
- Run a restore drill before launch and after any schema migration that changes bank-feed, auth, or audit tables.
- Store restore runbooks outside the app repository with production access controls.

## Monitoring And Scrubbing

- Server error logging passes through `server/src/security/scrub.js` before logging unexpected errors.
- Sentry, OpenTelemetry, or an equivalent monitor can be added at the server boundary, but events must use the same scrubber before leaving the process.
- Never attach provider API keys, bearer tokens, raw consent URLs, or local SQLite paths to monitoring events.
- Audit logs should capture the event type, organization, user, device where applicable, and minimal non-secret metadata.
