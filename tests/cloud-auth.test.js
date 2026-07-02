'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const {
  buildAuthorizeUrl,
  createDesktopCloudAuth,
  loadAuthConfig,
} = require('../src/services/cloud/auth');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (buffer) => Buffer.from(buffer).toString('utf8').replace(/^encrypted:/, ''),
  };
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function authConfig(extra = {}) {
  return loadAuthConfig({
    LEDGERLY_AUTH_ISSUER: 'https://ledgerly-auth.test/',
    LEDGERLY_AUTH_CLIENT_ID: 'desktop-client-id',
    LEDGERLY_AUTH_AUDIENCE: 'https://api.ledgerly.test',
    LEDGERLY_AUTH_REDIRECT_URI: 'http://127.0.0.1:38987/auth/callback',
    ...extra,
  });
}

test('cloud auth: builds Auth0 PKCE URL without exposing the verifier', () => {
  const request = buildAuthorizeUrl(authConfig(), {
    state: 'state-1',
    codeVerifier: 'verifier-secret',
    codeChallenge: 'challenge-public',
  });
  const url = new URL(request.url);

  assert.equal(url.origin, 'https://ledgerly-auth.test');
  assert.equal(url.pathname, '/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'desktop-client-id');
  assert.equal(url.searchParams.get('audience'), 'https://api.ledgerly.test');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:38987/auth/callback');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-public');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.match(url.searchParams.get('scope'), /openid/);
  assert.match(url.searchParams.get('scope'), /offline_access/);
  assert.doesNotMatch(request.url, /verifier-secret/);
});

test('cloud auth: sign-in exchanges code, encrypts refresh token, and keeps access token in memory', async () => {
  const opened = [];
  const tokenCalls = [];
  const auth = createDesktopCloudAuth({
    getDb: () => db,
    config: authConfig(),
    safeStorage: fakeSafeStorage(),
    openExternal: async (url) => { opened.push(url); },
    waitForCallback: async ({ state }) => ({ code: 'auth-code-1', state }),
    fetch: async (url, init) => {
      tokenCalls.push({ url: String(url), body: String(init.body) });
      return new Response(JSON.stringify({
        access_token: jwt({
          sub: 'auth0|user-1',
          email: 'owner@example.com',
          name: 'Owner Person',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        refresh_token: 'refresh-secret-1',
        id_token: jwt({ sub: 'auth0|user-1', email: 'owner@example.com', name: 'Owner Person' }),
        expires_in: 3600,
        token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const status = await auth.signIn();

  assert.equal(status.signedIn, true);
  assert.equal(status.email, 'owner@example.com');
  assert.equal(status.name, 'Owner Person');
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^https:\/\/ledgerly-auth\.test\/authorize/);
  assert.match(tokenCalls[0].body, /grant_type=authorization_code/);
  assert.match(tokenCalls[0].body, /code=auth-code-1/);
  assert.match(tokenCalls[0].body, /code_verifier=/);

  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'cloud_auth_%' OR key LIKE 'cloud_session_%'").all();
  assert.doesNotMatch(JSON.stringify(rows), /refresh-secret-1|access_token|cloud_session_token/);
  assert.ok(rows.find(row => row.key === 'cloud_auth_refresh_token_encrypted'));
  assert.match(await auth.getAccessToken(), /^ey/);
  assert.equal(status.accessToken, undefined);
  assert.equal(status.refreshToken, undefined);
});

test('cloud auth: refresh rotates encrypted refresh token without exposing tokens to renderer status', async () => {
  let refreshCount = 0;
  const auth = createDesktopCloudAuth({
    getDb: () => db,
    config: authConfig(),
    safeStorage: fakeSafeStorage(),
    openExternal: async () => {},
    waitForCallback: async ({ state }) => ({ code: 'auth-code-1', state }),
    fetch: async (_url, init) => {
      const body = String(init.body);
      if (body.includes('grant_type=authorization_code')) {
        return new Response(JSON.stringify({
          access_token: jwt({ sub: 'auth0|user-1', email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) - 30 }),
          refresh_token: 'refresh-secret-1',
          expires_in: 1,
          token_type: 'Bearer',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      refreshCount += 1;
      assert.match(body, /grant_type=refresh_token/);
      assert.match(body, /refresh_token=refresh-secret-1/);
      return new Response(JSON.stringify({
        access_token: jwt({ sub: 'auth0|user-1', email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'refresh-secret-2',
        expires_in: 3600,
        token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  await auth.signIn();
  const freshToken = await auth.refresh();
  const status = auth.publicStatus();
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'cloud_auth_%'").all();

  assert.equal(refreshCount, 1);
  assert.match(freshToken, /^ey/);
  assert.equal(status.signedIn, true);
  assert.equal(status.accessToken, undefined);
  assert.equal(status.refreshToken, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /refresh-secret-1|refresh-secret-2/);
});
