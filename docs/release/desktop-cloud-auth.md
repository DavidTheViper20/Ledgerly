# Desktop Cloud Sign-In Setup

Last checked: 2026-07-02

Ledgerly Desktop uses a native-app OAuth flow:

- Authorization Code + PKCE.
- System browser sign-in.
- Loopback callback to the Electron main process.
- Token exchange in the main process.
- Refresh token encrypted with Electron `safeStorage`.
- Access token kept in memory and refreshed when the bank-feed cloud client needs it.
- Renderer IPC exposes only `status`, `signIn`, `refresh`, and `signOut`.

Auth0 references:

- Authorization Code with PKCE: https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce
- Refresh Token Rotation: https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation

## Auth0 Staging Setup

Create these in the Auth0 staging tenant:

1. API: Ledgerly Cloud staging.
2. Audience: the same value used by `OIDC_AUDIENCE` on the staging API.
3. Application: Ledgerly Desktop, type Native.
4. Grant types: Authorization Code and Refresh Token.
5. PKCE: enabled.
6. Refresh Token Rotation: enabled with reuse detection.
7. Allowed Callback URL: register exactly `http://127.0.0.1/auth/callback`.
8. Email verification: enabled before beta.
9. MFA policy: required before production for account/admin actions.

## Callback And Port

The default redirect URI is `http://127.0.0.1/auth/callback` with **no port**. At sign-in time the loopback listener binds an **ephemeral port** and hands the effective redirect URI (with that port) to both the authorize request and the token exchange. This follows RFC 8252 (OAuth 2.0 for Native Apps): loopback redirects should use a dynamically chosen port.

- Register exactly `http://127.0.0.1/auth/callback` in Auth0. Auth0 ignores the port on loopback (`127.0.0.1`) redirect URIs, so the portless URL matches every ephemeral port.
- `LEDGERLY_AUTH_REDIRECT_URI` with an **explicit port** is still supported (e.g. if the identity provider cannot ignore loopback ports). In that case the fixed port is used, and sign-in errors clearly if that port is already in use.

## Desktop Environment Values

Set these for staging runs:

```sh
export LEDGERLY_CLOUD_URL="https://ledgerly-cloud-staging.onrender.com"
export LEDGERLY_AUTH_ISSUER="https://YOUR_AUTH0_TENANT/"
export LEDGERLY_AUTH_CLIENT_ID="YOUR_NATIVE_APP_CLIENT_ID"
export LEDGERLY_AUTH_AUDIENCE="YOUR_LEDGERLY_API_AUDIENCE"
# Optional. Leave unset to use the default portless loopback with an ephemeral
# port. Set an explicit port only if the identity provider cannot ignore
# loopback ports:
# export LEDGERLY_AUTH_REDIRECT_URI="http://127.0.0.1:38987/auth/callback"
```

Do not set a client secret in the desktop app. Native desktop apps are public clients and must rely on PKCE, not an embedded secret.

The legacy `cloud-session` token path (setting a session token directly, e.g. via `LEDGERLY_CLOUD_TOKEN`) is now **dev-only**: it is honoured only in unpackaged builds when `NODE_ENV`/`APP_ENV` is not `production`, and is blocked in packaged/production builds. Use it only for Track A single-user staging (see the staging deployment runbook); real sign-in uses the PKCE flow above.

## Verification

1. Start the desktop app with the staging values above.
2. Go to Settings.
3. Confirm Bank feeds shows Cloud account as Ready.
4. Click Sign in to Ledgerly Cloud.
5. Complete Auth0 sign-in in the system browser.
6. Confirm Settings shows the signed-in user and no token values.
7. Click Refresh session.
8. Confirm no `cloud_session_token`, raw refresh token, access token, or Auth0 token string is present in the local SQLite `settings` table.
9. Click Connect bank account only after the signed-in cloud status is healthy.

The local database may contain `cloud_auth_refresh_token_encrypted`; that value is encrypted with the operating system through Electron `safeStorage`.
