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

async function withServer({ claims, store = createMemoryStore() }, fn) {
  const verifyToken = async () => claims;
  const server = createServer({ config: testConfig(), store, verifyToken });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn({ baseUrl: `http://127.0.0.1:${port}`, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonFetch(baseUrl, path, { method = 'GET', body, token = 'test-token' } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { res, body: await res.json() };
}

test('org routes: GET /v1/me returns user and memberships without secrets', async () => {
  await withServer({
    claims: { sub: 'auth0|user-1', email: 'owner@example.com', name: 'Owner Example' },
  }, async ({ baseUrl }) => {
    const created = await jsonFetch(baseUrl, '/v1/organizations', {
      method: 'POST',
      body: { name: 'Viper Design Studio' },
    });
    assert.equal(created.res.status, 201);

    const { res, body } = await jsonFetch(baseUrl, '/v1/me');

    assert.equal(res.status, 200);
    assert.equal(body.user.identitySubject, 'auth0|user-1');
    assert.equal(body.user.email, 'owner@example.com');
    assert.deepEqual(body.organizations, [{
      id: created.body.organization.id,
      name: 'Viper Design Studio',
      role: 'owner',
    }]);
    assert.doesNotMatch(JSON.stringify(body), /basiq-secret-key|DATABASE_URL|secret/);
  });
});

test('org routes: missing bearer auth is rejected', async () => {
  await withServer({
    claims: { sub: 'auth0|user-1', email: 'owner@example.com', name: 'Owner Example' },
  }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/v1/me`);
    const body = await res.json();

    assert.equal(res.status, 401);
    assert.deepEqual(body, { error: { code: 'unauthorized', message: 'Missing bearer token' } });
  });
});

test('org routes: organization create/list and device registration require membership', async () => {
  await withServer({
    claims: { sub: 'auth0|user-1', email: 'owner@example.com', name: 'Owner Example' },
  }, async ({ baseUrl }) => {
    const create = await jsonFetch(baseUrl, '/v1/organizations', {
      method: 'POST',
      body: { name: 'Viper Design Studio' },
    });
    assert.equal(create.res.status, 201);
    assert.equal(create.body.organization.name, 'Viper Design Studio');
    assert.equal(create.body.membership.role, 'owner');

    const list = await jsonFetch(baseUrl, '/v1/organizations');
    assert.equal(list.res.status, 200);
    assert.deepEqual(list.body.organizations, [{
      id: create.body.organization.id,
      name: 'Viper Design Studio',
      role: 'owner',
    }]);

    const registered = await jsonFetch(baseUrl, `/v1/organizations/${create.body.organization.id}/devices/register`, {
      method: 'POST',
      body: { deviceName: 'David MacBook', publicKey: 'device-public-key' },
    });
    assert.equal(registered.res.status, 201);
    assert.equal(registered.body.device.deviceName, 'David MacBook');
    assert.equal(registered.body.device.revokedAt, null);

    const revoked = await jsonFetch(baseUrl, `/v1/organizations/${create.body.organization.id}/devices/${registered.body.device.id}/revoke`, {
      method: 'POST',
    });
    assert.equal(revoked.res.status, 200);
    assert.ok(revoked.body.device.revokedAt);
  });
});
