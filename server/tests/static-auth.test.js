'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createServer } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createStaticTokenVerifier } = require('../src/auth/static-token');

const STATIC_TOKEN = 'ledgerly-static-track-a-token-0123456789abcdef';

function staticEnv(extra = {}) {
  return {
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://ledgerly:secret@db.example.com:5432/ledgerly_test',
    BASIQ_API_KEY: 'basiq-secret-key',
    CORS_ORIGINS: 'http://localhost:3000',
    CLOUD_STATIC_TOKEN: STATIC_TOKEN,
    PORT: '0',
    ...extra,
  };
}

async function withServer(server, fn) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('config: static auth mode loads without OIDC settings', () => {
  const config = loadConfig(staticEnv());
  assert.equal(config.authMode, 'static');
  assert.equal(config.staticToken, STATIC_TOKEN);
});

test('config: oidc mode still requires OIDC settings', () => {
  assert.throws(
    () => loadConfig(staticEnv({ CLOUD_STATIC_TOKEN: '', CLOUD_AUTH_MODE: 'oidc' })),
    /Missing required config: OIDC_ISSUER, OIDC_AUDIENCE/,
  );
});

test('config: static mode rejects short tokens and unknown auth modes', () => {
  assert.throws(
    () => loadConfig(staticEnv({ CLOUD_STATIC_TOKEN: 'short-token' })),
    /CLOUD_STATIC_TOKEN must be at least 32 characters/,
  );
  assert.throws(
    () => loadConfig(staticEnv({ CLOUD_AUTH_MODE: 'anonymous' })),
    /CLOUD_AUTH_MODE must be one of/,
  );
  assert.throws(
    () => loadConfig(staticEnv({ CLOUD_AUTH_MODE: 'static', CLOUD_STATIC_TOKEN: '' })),
    /CLOUD_STATIC_TOKEN must be at least 32 characters/,
  );
});

test('static verifier: rejects construction with a weak token', () => {
  assert.throws(() => createStaticTokenVerifier({ staticToken: 'tiny' }), /at least 32 characters/);
  assert.throws(() => createStaticTokenVerifier({}), /at least 32 characters/);
});

test('static auth: /v1 routes reject missing and wrong tokens', async () => {
  const server = createServer({ config: loadConfig(staticEnv()) });
  await withServer(server, async (base) => {
    const missing = await fetch(`${base}/v1/me`);
    assert.equal(missing.status, 401);

    const wrong = await fetch(`${base}/v1/me`, {
      headers: { Authorization: 'Bearer not-the-right-token-but-long-enough-000' },
    });
    assert.equal(wrong.status, 401);
    const body = await wrong.json();
    assert.equal(body.error.code, 'unauthorized');
    assert.doesNotMatch(JSON.stringify(body), new RegExp(STATIC_TOKEN));
  });
});

test('static auth: valid token gets an identity, org, and bank-feed status end to end', async () => {
  const server = createServer({ config: loadConfig(staticEnv()) });
  await withServer(server, async (base) => {
    const headers = { Authorization: `Bearer ${STATIC_TOKEN}` };

    const me = await fetch(`${base}/v1/me`, { headers });
    assert.equal(me.status, 200);
    const identity = await me.json();
    assert.equal(identity.user.identitySubject, 'static|owner');

    const created = await fetch(`${base}/v1/organizations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Owner Books' }),
    });
    assert.equal(created.status, 201);
    const { organization } = await created.json();

    const status = await fetch(
      `${base}/v1/bank-feeds/status?organizationId=${organization.id}`,
      { headers },
    );
    assert.equal(status.status, 200);
    const feed = await status.json();
    assert.equal(feed.provider, 'basiq');

    // A second organization's data is still walled off: unknown org id -> 403.
    const foreign = await fetch(
      `${base}/v1/bank-feeds/status?organizationId=org_9999`,
      { headers },
    );
    assert.equal(foreign.status, 403);
  });
});
