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

function fakeBasiqClient() {
  const calls = [];
  return {
    calls,
    async createUser(input) {
      calls.push(['createUser', input]);
      return { id: 'basiq-user-1' };
    },
    async createConsentUrl(input) {
      calls.push(['createConsentUrl', input]);
      return { url: `https://consent.basiq.io/home?token=client-token-${input.action}&action=${input.action}` };
    },
    async listAccounts(input) {
      calls.push(['listAccounts', input]);
      return [{
        provider: 'basiq',
        providerAccountId: 'acc-1',
        providerAccountName: 'Business Everyday',
        providerAccountNumber: '123456789',
        providerAccountType: 'transaction',
      }];
    },
    async revokeConnection(input) {
      calls.push(['revokeConnection', input]);
      return { ok: true };
    },
  };
}

async function withServer({ role = 'owner', basiqClient = fakeBasiqClient() } = {}, fn) {
  const store = createMemoryStore({ now: () => '2026-06-27T00:00:00.000Z' });
  const verifyToken = async () => ({ sub: 'auth0|user-1', email: 'owner@example.com', name: 'Owner Example' });
  const user = store.upsertUserFromClaims({ sub: 'auth0|user-1', email: 'owner@example.com', name: 'Owner Example' });
  const created = store.createOrganization({ userId: user.id, name: 'Viper Design Studio' });
  if (role !== 'owner') store.setMembershipRole({ userId: user.id, organizationId: created.organization.id, role });
  const server = createServer({ config: testConfig(), store, verifyToken, basiqClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn({ baseUrl: `http://127.0.0.1:${port}`, organizationId: created.organization.id, basiqClient });
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

test('bank feeds: connect start creates provider user and returns consent URL without secrets', async () => {
  await withServer({}, async ({ baseUrl, organizationId, basiqClient }) => {
    const { res, body } = await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com', mobile: '+61400000000' },
    });

    assert.equal(res.status, 201);
    assert.equal(body.provider, 'basiq');
    assert.equal(body.connection.providerUserId, 'basiq-user-1');
    assert.equal(body.connection.consentStatus, 'pending');
    assert.equal(body.consentUrl, 'https://consent.basiq.io/home?token=client-token-connect&action=connect');
    assert.deepEqual(basiqClient.calls[0], ['createUser', { email: 'owner@example.com', mobile: '+61400000000' }]);
    assert.deepEqual(basiqClient.calls[1], ['createConsentUrl', { userId: 'basiq-user-1', action: 'connect' }]);
    assert.doesNotMatch(JSON.stringify(body), /basiq-secret-key|server-token|DATABASE_URL/);
  });
});

test('bank feeds: provider accounts use stored Basiq user and viewer role cannot manage feeds', async () => {
  await withServer({}, async ({ baseUrl, organizationId, basiqClient }) => {
    await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com' },
    });
    const { res, body } = await jsonFetch(baseUrl, `/v1/bank-feeds/provider-accounts?organizationId=${encodeURIComponent(organizationId)}`);

    assert.equal(res.status, 200);
    assert.deepEqual(body.accounts, [{
      provider: 'basiq',
      providerAccountId: 'acc-1',
      providerAccountName: 'Business Everyday',
      providerAccountNumber: '123456789',
      providerAccountType: 'transaction',
    }]);
    assert.deepEqual(basiqClient.calls.at(-1), ['listAccounts', { userId: 'basiq-user-1' }]);
  });

  await withServer({ role: 'viewer' }, async ({ baseUrl, organizationId }) => {
    const { res, body } = await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'viewer@example.com' },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(body, { error: { code: 'forbidden', message: 'Permission denied' } });
  });
});

test('bank feeds: manage, reconnect, and revoke consent are audited and return no provider tokens', async () => {
  await withServer({}, async ({ baseUrl, organizationId, basiqClient }) => {
    await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com' },
    });

    const manage = await jsonFetch(baseUrl, '/v1/bank-feeds/consent/manage', {
      method: 'POST',
      body: { organizationId },
    });
    assert.equal(manage.res.status, 200);
    assert.equal(manage.body.consentUrl, 'https://consent.basiq.io/home?token=client-token-manage&action=manage');

    const reconnect = await jsonFetch(baseUrl, '/v1/bank-feeds/consent/reconnect', {
      method: 'POST',
      body: { organizationId },
    });
    assert.equal(reconnect.res.status, 200);
    assert.equal(reconnect.body.consentUrl, 'https://consent.basiq.io/home?token=client-token-reconnect&action=reconnect');

    const revoke = await jsonFetch(baseUrl, '/v1/bank-feeds/consent/revoke', {
      method: 'POST',
      body: { organizationId, providerConnectionId: 'conn-1' },
    });
    assert.equal(revoke.res.status, 200);
    assert.deepEqual(revoke.body, { ok: true });
    assert.deepEqual(basiqClient.calls.at(-1), ['revokeConnection', { providerConnectionId: 'conn-1' }]);

    const audit = await jsonFetch(baseUrl, '/v1/audit-events');
    assert.equal(audit.res.status, 200);
    assert.deepEqual(audit.body.events.map(e => e.eventType), [
      'bank_feed.consent_started',
      'bank_feed.consent_manage_started',
      'bank_feed.consent_reconnect_started',
      'bank_feed.consent_revoked',
    ]);
    assert.doesNotMatch(JSON.stringify({ manage: manage.body, reconnect: reconnect.body, revoke: revoke.body }), /basiq-secret-key|server-token/);
  });
});
