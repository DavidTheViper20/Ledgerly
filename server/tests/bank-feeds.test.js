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
    async listTransactions(input) {
      calls.push(['listTransactions', input]);
      return [{
        sourceAccountId: input.providerAccountId,
        sourceTransactionId: 'tx-1',
        date: '2026-06-28',
        payee: 'Coffee Supplies',
        description: 'Coffee Supplies',
        reference: 'POS123',
        amountCents: -1299,
        postedAt: '2026-06-28T00:00:00.000Z',
      }];
    },
    async revokeConnection(input) {
      calls.push(['revokeConnection', input]);
      return { ok: true };
    },
    async deleteUser(input) {
      calls.push(['deleteUser', input]);
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
    await fn({ baseUrl: `http://127.0.0.1:${port}`, organizationId: created.organization.id, basiqClient, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonFetch(baseUrl, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
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
    assert.deepEqual(basiqClient.calls.at(-1), ['revokeConnection', { userId: 'basiq-user-1', providerConnectionId: 'conn-1' }]);

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

test('bank feeds: maps provider accounts and status returns cloud account links', async () => {
  await withServer({}, async ({ baseUrl, organizationId }) => {
    await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com' },
    });

    const mapped = await jsonFetch(baseUrl, '/v1/bank-feeds/account-links', {
      method: 'POST',
      body: {
        organizationId,
        providerAccountId: 'acc-1',
        providerAccountName: 'Business Everyday',
        providerAccountNumber: '123456789',
        providerAccountType: 'transaction',
        desktopBankAccountLocalId: '17',
      },
    });
    assert.equal(mapped.res.status, 201);
    assert.equal(mapped.body.account.providerAccountId, 'acc-1');
    assert.equal(mapped.body.account.providerAccountNumberLast4, '6789');
    assert.equal(mapped.body.account.desktopBankAccountLocalId, '17');

    const remapped = await jsonFetch(baseUrl, '/v1/bank-feeds/account-links', {
      method: 'POST',
      body: {
        organizationId,
        providerAccountId: 'acc-1',
        providerAccountName: 'Business Everyday',
        desktopBankAccountLocalId: '23',
      },
    });
    assert.equal(remapped.res.status, 200);
    assert.equal(remapped.body.account.id, mapped.body.account.id);
    assert.equal(remapped.body.account.desktopBankAccountLocalId, '23');

    const status = await jsonFetch(baseUrl, `/v1/bank-feeds/status?organizationId=${encodeURIComponent(organizationId)}`);
    assert.equal(status.res.status, 200);
    assert.equal(status.body.provider, 'basiq');
    assert.equal(status.body.configured, true);
    assert.equal(status.body.accountLinks[0].desktopBankAccountLocalId, '23');
  });
});

test('bank feeds: sync returns normalized transactions and replays idempotent sync runs', async () => {
  await withServer({}, async ({ baseUrl, organizationId, basiqClient }) => {
    await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com' },
    });
    await jsonFetch(baseUrl, '/v1/bank-feeds/account-links', {
      method: 'POST',
      body: {
        organizationId,
        providerAccountId: 'acc-1',
        providerAccountName: 'Business Everyday',
        desktopBankAccountLocalId: '17',
      },
    });

    const first = await jsonFetch(baseUrl, '/v1/bank-feeds/sync', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'sync-acc-1-2026-06-28' },
      body: { organizationId, providerAccountId: 'acc-1' },
    });
    const second = await jsonFetch(baseUrl, '/v1/bank-feeds/sync', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'sync-acc-1-2026-06-28' },
      body: { organizationId, providerAccountId: 'acc-1' },
    });

    assert.equal(first.res.status, 200);
    assert.equal(first.body.syncRun.status, 'succeeded');
    assert.deepEqual(first.body.transactions, [{
      sourceAccountId: 'acc-1',
      sourceTransactionId: 'tx-1',
      date: '2026-06-28',
      payee: 'Coffee Supplies',
      description: 'Coffee Supplies',
      reference: 'POS123',
      amountCents: -1299,
      postedAt: '2026-06-28T00:00:00.000Z',
    }]);
    assert.equal(second.res.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.syncRun.id, first.body.syncRun.id);
    assert.equal(basiqClient.calls.filter(([name]) => name === 'listTransactions').length, 1);
    assert.deepEqual(basiqClient.calls.at(-1), ['listTransactions', {
      userId: 'basiq-user-1',
      providerAccountId: 'acc-1',
      syncCursor: '',
    }]);
  });
});

test('bank feeds: sync cursor advances between runs so pulls stay incremental', async () => {
  const basiqClient = fakeBasiqClient();
  const pages = [
    { transactions: [{ sourceAccountId: 'acc-1', sourceTransactionId: 'tx-1', date: '2026-06-28', description: 'Coffee', amountCents: -1299 }], nextCursor: '2026-06-28' },
    { transactions: [{ sourceAccountId: 'acc-1', sourceTransactionId: 'tx-2', date: '2026-06-30', description: 'Sale', amountCents: 25000 }], nextCursor: '2026-06-30' },
  ];
  basiqClient.listTransactions = async (input) => {
    basiqClient.calls.push(['listTransactions', input]);
    return pages.shift();
  };

  await withServer({ basiqClient }, async ({ baseUrl, organizationId }) => {
    await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com' },
    });
    await jsonFetch(baseUrl, '/v1/bank-feeds/account-links', {
      method: 'POST',
      body: { organizationId, providerAccountId: 'acc-1', desktopBankAccountLocalId: '17' },
    });

    const first = await jsonFetch(baseUrl, '/v1/bank-feeds/sync', {
      method: 'POST',
      body: { organizationId, providerAccountId: 'acc-1' },
    });
    const second = await jsonFetch(baseUrl, '/v1/bank-feeds/sync', {
      method: 'POST',
      body: { organizationId, providerAccountId: 'acc-1' },
    });

    assert.equal(first.res.status, 200);
    assert.equal(second.res.status, 200);
    const syncCalls = basiqClient.calls.filter(([name]) => name === 'listTransactions');
    assert.equal(syncCalls[0][1].syncCursor, '', 'first sync starts with no cursor');
    assert.equal(syncCalls[1][1].syncCursor, '2026-06-28', 'second sync resumes from the stored cursor');

    const status = await jsonFetch(baseUrl, `/v1/bank-feeds/status?organizationId=${organizationId}`);
    assert.equal(status.body.accountLinks[0].syncCursor, '2026-06-30');
  });
});

test('bank feeds: failed sync run is audited without exposing provider secrets', async () => {
  const basiqClient = fakeBasiqClient();
  basiqClient.listTransactions = async (input) => {
    basiqClient.calls.push(['listTransactions', input]);
    const err = new Error('Basiq list transactions failed: 502 upstream unavailable');
    err.status = 502;
    err.code = 'basiq_upstream_error';
    throw err;
  };

  await withServer({ basiqClient }, async ({ baseUrl, organizationId }) => {
    await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com' },
    });
    await jsonFetch(baseUrl, '/v1/bank-feeds/account-links', {
      method: 'POST',
      body: {
        organizationId,
        providerAccountId: 'acc-1',
        providerAccountName: 'Business Everyday',
        desktopBankAccountLocalId: '17',
      },
    });

    const failed = await jsonFetch(baseUrl, '/v1/bank-feeds/sync', {
      method: 'POST',
      body: { organizationId, providerAccountId: 'acc-1' },
    });
    assert.equal(failed.res.status, 502);
    assert.deepEqual(failed.body, {
      error: {
        code: 'basiq_upstream_error',
        message: 'Basiq list transactions failed: 502 upstream unavailable',
      },
    });

    const audit = await jsonFetch(baseUrl, '/v1/audit-events');
    assert.equal(audit.body.events.at(-1).eventType, 'bank_feed.sync_failed');
    assert.doesNotMatch(JSON.stringify(failed.body), /basiq-secret-key|server-token/);
  });
});

test('bank feeds: revoked consent blocks sync', async () => {
  await withServer({}, async ({ baseUrl, organizationId }) => {
    await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com' },
    });
    await jsonFetch(baseUrl, '/v1/bank-feeds/account-links', {
      method: 'POST',
      body: {
        organizationId,
        providerAccountId: 'acc-1',
        providerAccountName: 'Business Everyday',
        desktopBankAccountLocalId: '17',
      },
    });
    await jsonFetch(baseUrl, '/v1/bank-feeds/consent/revoke', {
      method: 'POST',
      body: { organizationId, providerConnectionId: '' },
    });

    const sync = await jsonFetch(baseUrl, '/v1/bank-feeds/sync', {
      method: 'POST',
      body: { organizationId, providerAccountId: 'acc-1' },
    });

    assert.equal(sync.res.status, 409);
    assert.deepEqual(sync.body, {
      error: {
        code: 'consent_revoked',
        message: 'Bank feed consent is revoked',
      },
    });
  });
});

test('bank feeds: redundant data deletion request is audited', async () => {
  await withServer({}, async ({ baseUrl, organizationId }) => {
    const deletion = await jsonFetch(baseUrl, '/v1/bank-feeds/data-deletion/request', {
      method: 'POST',
      body: {
        organizationId,
        providerAccountId: 'acc-1',
        reason: 'user_requested',
      },
    });
    assert.equal(deletion.res.status, 202);
    assert.deepEqual(deletion.body, {
      ok: true,
      deleted: { connections: 0, accounts: 0, providerUsers: 0, syncRunsScrubbed: 0 },
    });

    const audit = await jsonFetch(baseUrl, '/v1/audit-events');
    assert.equal(audit.body.events.at(-1).eventType, 'bank_feed.data_deletion_requested');
    assert.deepEqual(audit.body.events.at(-1).metadata, {
      provider: 'basiq',
      providerAccountId: 'acc-1',
      reason: 'user_requested',
      connections: 0,
      accounts: 0,
      providerUsers: 0,
      syncRunsScrubbed: 0,
      providerDeletion: 'none',
    });
    assert.doesNotMatch(JSON.stringify(deletion.body), /basiq-secret-key|server-token/);
  });
});

test('bank feeds: data deletion removes provider user, links, and cached transactions', async () => {
  await withServer({}, async ({ baseUrl, organizationId, basiqClient }) => {
    await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com' },
    });
    await jsonFetch(baseUrl, '/v1/bank-feeds/account-links', {
      method: 'POST',
      body: {
        organizationId,
        providerAccountId: 'acc-1',
        providerAccountName: 'Business Everyday',
        desktopBankAccountLocalId: '17',
      },
    });
    const sync = await jsonFetch(baseUrl, '/v1/bank-feeds/sync', {
      method: 'POST',
      body: { organizationId, providerAccountId: 'acc-1' },
    });
    assert.equal(sync.res.status, 200);
    assert.ok(sync.body.transactions.length > 0);

    const deletion = await jsonFetch(baseUrl, '/v1/bank-feeds/data-deletion/request', {
      method: 'POST',
      body: { organizationId },
    });
    assert.equal(deletion.res.status, 202);
    assert.equal(deletion.body.ok, true);
    assert.equal(deletion.body.deleted.connections, 1);
    assert.equal(deletion.body.deleted.accounts, 1);
    assert.equal(deletion.body.deleted.providerUsers, 1);
    assert.equal(deletion.body.deleted.syncRunsScrubbed, 1);

    const status = await jsonFetch(baseUrl, `/v1/bank-feeds/status?organizationId=${encodeURIComponent(organizationId)}`);
    assert.equal(status.res.status, 200);
    assert.deepEqual(status.body.accountLinks, []);
    assert.deepEqual(status.body.connections, []);
    assert.ok(status.body.syncRuns.length > 0);
    for (const run of status.body.syncRuns) {
      assert.equal(run.result, null);
    }

    assert.deepEqual(basiqClient.calls.at(-1), ['deleteUser', { userId: 'basiq-user-1' }]);
  });
});

test('bank feeds: status surfaces expired consent for reconnect dashboard state', async () => {
  await withServer({}, async ({ baseUrl, organizationId, store }) => {
    await jsonFetch(baseUrl, '/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: { organizationId, email: 'owner@example.com' },
    });
    store.upsertBankFeedConnection({
      organizationId,
      provider: 'basiq',
      providerUserId: 'basiq-user-1',
      consentStatus: 'expired',
      consentExpiresAt: '2026-06-28T00:00:00.000Z',
    });

    const status = await jsonFetch(baseUrl, `/v1/bank-feeds/status?organizationId=${encodeURIComponent(organizationId)}`);

    assert.equal(status.res.status, 200);
    assert.equal(status.body.connections[0].consentStatus, 'expired');
    assert.equal(status.body.connections[0].consentExpiresAt, '2026-06-28T00:00:00.000Z');
  });
});
