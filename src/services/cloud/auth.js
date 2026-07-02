'use strict';

const crypto = require('node:crypto');

const DEFAULT_SCOPE = 'openid profile email offline_access';
const REFRESH_KEY = 'cloud_auth_refresh_token_encrypted';
const PROFILE_KEYS = [
  'cloud_auth_subject',
  'cloud_auth_email',
  'cloud_auth_name',
  'cloud_auth_expires_at',
];

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function setting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value || ''));
}

function deleteSetting(db, key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

function loadAuthConfig(env = process.env) {
  const issuer = trimSlash(env.LEDGERLY_AUTH_ISSUER || env.OIDC_ISSUER);
  const clientId = String(env.LEDGERLY_AUTH_CLIENT_ID || env.OIDC_CLIENT_ID || '').trim();
  const audience = String(env.LEDGERLY_AUTH_AUDIENCE || env.OIDC_AUDIENCE || '').trim();
  const redirectUri = String(env.LEDGERLY_AUTH_REDIRECT_URI || 'http://127.0.0.1:38987/auth/callback').trim();
  const scope = String(env.LEDGERLY_AUTH_SCOPE || DEFAULT_SCOPE).trim();
  return {
    issuer,
    clientId,
    audience,
    redirectUri,
    scope,
    configured: Boolean(issuer && clientId && audience && redirectUri),
    authorizeEndpoint: issuer ? `${issuer}/authorize` : '',
    tokenEndpoint: issuer ? `${issuer}/oauth/token` : '',
  };
}

function assertConfigured(config) {
  if (!config?.configured) throw new Error('Ledgerly Cloud sign-in is not configured');
  let issuerUrl;
  try { issuerUrl = new URL(config.issuer); } catch { throw new Error('Ledgerly Cloud issuer is invalid'); }
  if (issuerUrl.protocol !== 'https:') throw new Error('Ledgerly Cloud issuer must use HTTPS');
  try { new URL(config.redirectUri); } catch { throw new Error('Ledgerly Cloud redirect URI is invalid'); }
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function generatePkce() {
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  return {
    state: base64Url(crypto.randomBytes(32)),
    codeVerifier,
    codeChallenge,
  };
}

function buildAuthorizeUrl(config, pkce = generatePkce()) {
  assertConfigured(config);
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope || DEFAULT_SCOPE);
  url.searchParams.set('audience', config.audience);
  url.searchParams.set('state', pkce.state);
  url.searchParams.set('code_challenge', pkce.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), ...pkce };
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

async function tokenRequest(config, body, fetchImpl = global.fetch) {
  if (!fetchImpl) throw new Error('Ledgerly Cloud auth requires fetch');
  const res = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `Ledgerly Cloud sign-in failed: ${res.status}`);
  }
  if (!data.access_token) throw new Error('Ledgerly Cloud did not return an access token');
  return data;
}

function encryptRefreshToken(safeStorage, refreshToken) {
  if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('Secure token storage is not available on this device');
  return Buffer.from(safeStorage.encryptString(refreshToken)).toString('base64');
}

function decryptRefreshToken(safeStorage, encrypted) {
  if (!encrypted) return '';
  if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('Secure token storage is not available on this device');
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
}

function pickOrganizationId(claims, fallback = '') {
  return claims.organizationId ||
    claims.orgId ||
    claims.org_id ||
    claims['https://ledgerly.app/organization_id'] ||
    claims['https://ledgerly.com/organization_id'] ||
    fallback ||
    '';
}

function tokenExpiryMs(tokens, now) {
  const accessClaims = decodeJwtPayload(tokens.access_token);
  if (accessClaims.exp) return Number(accessClaims.exp) * 1000;
  return now() + Number(tokens.expires_in || 3600) * 1000;
}

function createDesktopCloudAuth({
  db,
  getDb = () => db,
  config = loadAuthConfig(),
  safeStorage,
  fetch: fetchImpl = global.fetch,
  openExternal,
  waitForCallback,
  now = () => Date.now(),
} = {}) {
  let current = null;

  function activeDb() {
    const out = getDb();
    if (!out) throw new Error('Ledgerly database is not open');
    return out;
  }

  function encryptedRefreshToken() {
    const database = activeDb();
    const encrypted = setting(database, REFRESH_KEY);
    if (encrypted) return encrypted;
    const legacyRefresh = setting(database, 'cloud_refresh_token');
    if (legacyRefresh) {
      const migrated = encryptRefreshToken(safeStorage, legacyRefresh);
      setSetting(database, REFRESH_KEY, migrated);
      deleteSetting(database, 'cloud_refresh_token');
      return migrated;
    }
    return '';
  }

  function hasSession() {
    return Boolean(current?.accessToken || encryptedRefreshToken());
  }

  function saveTokens(tokens, { requireRefresh = false } = {}) {
    const database = activeDb();
    if (requireRefresh && !tokens.refresh_token) {
      throw new Error('Ledgerly Cloud did not return a refresh token. Enable offline_access and refresh token rotation.');
    }
    const accessClaims = decodeJwtPayload(tokens.access_token);
    const idClaims = decodeJwtPayload(tokens.id_token);
    const claims = { ...accessClaims, ...idClaims };
    const expiresAtMs = tokenExpiryMs(tokens, now);
    current = {
      accessToken: tokens.access_token,
      expiresAtMs,
      email: claims.email || '',
      name: claims.name || claims.nickname || '',
      subject: claims.sub || '',
    };
    if (tokens.refresh_token) {
      setSetting(database, REFRESH_KEY, encryptRefreshToken(safeStorage, tokens.refresh_token));
    }
    setSetting(database, 'cloud_auth_subject', current.subject);
    setSetting(database, 'cloud_auth_email', current.email);
    setSetting(database, 'cloud_auth_name', current.name);
    setSetting(database, 'cloud_auth_expires_at', new Date(expiresAtMs).toISOString());
    const organizationId = pickOrganizationId(claims, setting(database, 'cloud_organization_id'));
    if (organizationId) setSetting(database, 'cloud_organization_id', organizationId);
    deleteSetting(database, 'cloud_session_token');
    deleteSetting(database, 'cloud_refresh_token');
  }

  function publicStatus() {
    const database = activeDb();
    return {
      configured: Boolean(config.configured),
      signedIn: hasSession(),
      email: current?.email || setting(database, 'cloud_auth_email'),
      name: current?.name || setting(database, 'cloud_auth_name'),
      expiresAt: current?.expiresAtMs ? new Date(current.expiresAtMs).toISOString() : setting(database, 'cloud_auth_expires_at'),
      organizationId: setting(database, 'cloud_organization_id'),
    };
  }

  async function signIn() {
    assertConfigured(config);
    if (!openExternal) throw new Error('Ledgerly Cloud sign-in cannot open the system browser');
    if (!waitForCallback) throw new Error('Ledgerly Cloud sign-in callback handler is not configured');
    const request = buildAuthorizeUrl(config);
    const callbackPromise = waitForCallback({
      state: request.state,
      redirectUri: config.redirectUri,
      timeoutMs: 120_000,
    });
    await openExternal(request.url);
    const callback = await callbackPromise;
    if (callback.error) throw new Error(callback.errorDescription || callback.error);
    if (!callback.code) throw new Error('Ledgerly Cloud sign-in did not return an authorization code');
    if (callback.state !== request.state) throw new Error('Ledgerly Cloud sign-in state did not match');
    const tokens = await tokenRequest(config, {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code: callback.code,
      code_verifier: request.codeVerifier,
      redirect_uri: config.redirectUri,
    }, fetchImpl);
    saveTokens(tokens, { requireRefresh: true });
    return publicStatus();
  }

  async function refresh() {
    assertConfigured(config);
    const refreshToken = decryptRefreshToken(safeStorage, encryptedRefreshToken());
    if (!refreshToken) throw new Error('Ledgerly Cloud sign-in is required');
    const tokens = await tokenRequest(config, {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: refreshToken,
    }, fetchImpl);
    saveTokens(tokens, { requireRefresh: false });
    return tokens.access_token;
  }

  async function getAccessToken() {
    if (current?.accessToken && now() < current.expiresAtMs - 60_000) return current.accessToken;
    return refresh();
  }

  function signOut() {
    current = null;
    const database = activeDb();
    deleteSetting(database, REFRESH_KEY);
    deleteSetting(database, 'cloud_session_token');
    deleteSetting(database, 'cloud_refresh_token');
    for (const key of PROFILE_KEYS) deleteSetting(database, key);
    return publicStatus();
  }

  return {
    signIn,
    refresh,
    getAccessToken,
    hasSession,
    publicStatus,
    signOut,
  };
}

module.exports = {
  buildAuthorizeUrl,
  createDesktopCloudAuth,
  decodeJwtPayload,
  generatePkce,
  loadAuthConfig,
};
