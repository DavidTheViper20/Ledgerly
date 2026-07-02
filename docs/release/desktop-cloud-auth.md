# Desktop Cloud Sign-In Setup

Last checked: 2026-06-30

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
7. Allowed Callback URL: `http://127.0.0.1:38987/auth/callback` unless `LEDGERLY_AUTH_REDIRECT_URI` is changed.
8. Email verification: enabled before beta.
9. MFA policy: required before production for account/admin actions.

## Desktop Environment Values

Set these for staging runs:

```sh
export LEDGERLY_CLOUD_URL="https://ledgerly-cloud-staging.onrender.com"
export LEDGERLY_AUTH_ISSUER="https://YOUR_AUTH0_TENANT/"
export LEDGERLY_AUTH_CLIENT_ID="YOUR_NATIVE_APP_CLIENT_ID"
export LEDGERLY_AUTH_AUDIENCE="YOUR_LEDGERLY_API_AUDIENCE"
export LEDGERLY_AUTH_REDIRECT_URI="http://127.0.0.1:38987/auth/callback"
```

Do not set a client secret in the desktop app. Native desktop apps are public clients and must rely on PKCE, not an embedded secret.

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
