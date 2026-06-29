'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createServer } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createMemoryStore } = require('../src/db/memory-store');

function testConfig() {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://ledgerly:secret@db.example.com:5432/ledgerly_test',
    OIDC_ISSUER: 'https://issuer.test/',
    OIDC_AUDIENCE: 'ledgerly-api-test',
    BASIQ_API_KEY: 'basiq-secret-key',
    CORS_ORIGINS: 'http://localhost:3000',
    PORT: '0',
  });
}

async function withServer(options, fn) {
  const store = createMemoryStore({ now: () => '2026-06-29T00:00:00.000Z' });
  const verifyToken = async () => ({ sub: 'auth0|user-1', email: 'owner@example.com', name: 'Owner Example' });
  const user = store.upsertUserFromClaims({ sub: 'auth0|user-1', email: 'owner@example.com', name: 'Owner Example' });
  const created = store.createOrganization({ userId: user.id, name: 'Viper Design Studio' });
  const server = createServer({ config: testConfig(), store, verifyToken, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn({ baseUrl: `http://127.0.0.1:${port}`, organizationId: created.organization.id, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonFetch(baseUrl, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { res, body: await res.json() };
}

test('security hardening: rate limits authenticated API bursts per bearer identity', async () => {
  await withServer({ rateLimit: { windowMs: 60_000, max: 2 } }, async ({ baseUrl }) => {
    assert.equal((await jsonFetch(baseUrl, '/v1/me')).res.status, 200);
    assert.equal((await jsonFetch(baseUrl, '/v1/me')).res.status, 200);

    const limited = await jsonFetch(baseUrl, '/v1/me');

    assert.equal(limited.res.status, 429);
    assert.deepEqual(limited.body, {
      error: {
        code: 'rate_limited',
        message: 'Too many requests',
      },
    });
    assert.equal(limited.res.headers.get('retry-after'), '60');
  });
});

test('security hardening: logs scrub provider tokens and secrets', async () => {
  const logs = [];
  const basiqClient = {
    async createUser() {
      throw new Error('provider failed with basiq-secret-key and server-token-1');
    },
  };
  await withServer({
    basiqClient,
    logger: { error: (...args) => logs.push(args) },
  }, async ({ baseUrl, organizationId }) => {
    const failed = await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com' },
    });

    assert.equal(failed.res.status, 500);
    assert.doesNotMatch(JSON.stringify(logs), /basiq-secret-key|server-token-1/);
    assert.match(JSON.stringify(logs), /\[REDACTED\]/);
  });
});

test('security hardening: auth and device routes create structured audit events', async () => {
  await withServer({}, async ({ baseUrl, organizationId }) => {
    await jsonFetch(baseUrl, '/v1/me');
    await jsonFetch(baseUrl, `/v1/organizations/${encodeURIComponent(organizationId)}/devices/register`, {
      method: 'POST',
      body: { deviceName: 'Office Mac', publicKey: 'pub-key-1' },
    });

    const audit = await jsonFetch(baseUrl, '/v1/audit-events');

    assert.deepEqual(audit.body.events.map(e => e.eventType), [
      'auth.session_checked',
      'device.registered',
    ]);
    assert.deepEqual(audit.body.events[1].metadata, { deviceName: 'Office Mac' });
  });
});
