'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createBasiqClient } = require('../src/providers/basiq-client');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

function bodyParam(call, key) {
  return new URLSearchParams(call.options.body).get(key);
}

test('basiq client: exchanges API key for cached server token and refreshes before expiry', async () => {
  let now = 0;
  const tokens = ['server-token-1', 'server-token-2'];
  const calls = [];
  const client = createBasiqClient({
    apiKey: 'basiq-secret-key',
    now: () => now,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ access_token: tokens.shift(), expires_in: 120 });
    },
  });

  assert.equal(await client.getServerToken(), 'server-token-1');
  assert.equal(await client.getServerToken(), 'server-token-1');
  now = 61_000;
  assert.equal(await client.getServerToken(), 'server-token-2');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://au-api.basiq.io/token');
  assert.equal(calls[0].options.headers.Authorization, 'Basic basiq-secret-key');
  assert.equal(calls[0].options.headers['basiq-version'], '3.0');
  assert.equal(bodyParam(calls[0], 'scope'), 'SERVER_ACCESS');
});

test('basiq client: creates user and client token scoped to that user', async () => {
  const calls = [];
  const client = createBasiqClient({
    apiKey: 'basiq-secret-key',
    now: () => 0,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/token') && bodyParam({ options }, 'scope') === 'SERVER_ACCESS') {
        return jsonResponse({ access_token: 'server-token-1', expires_in: 3600 });
      }
      if (url.endsWith('/users')) {
        assert.equal(options.headers.Authorization, 'Bearer server-token-1');
        assert.deepEqual(JSON.parse(options.body), { email: 'owner@example.com', mobile: '+61400000000' });
        return jsonResponse({ id: 'basiq-user-1' });
      }
      if (url.endsWith('/token') && bodyParam({ options }, 'scope') === 'CLIENT_ACCESS') {
        assert.equal(options.headers.Authorization, 'Basic basiq-secret-key');
        assert.equal(bodyParam({ options }, 'userId'), 'basiq-user-1');
        return jsonResponse({ access_token: 'client-token-1', expires_in: 600 });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });

  const user = await client.createUser({ email: 'owner@example.com', mobile: '+61400000000' });
  const consent = await client.createConsentUrl({ userId: user.id, action: 'connect' });

  assert.equal(user.id, 'basiq-user-1');
  assert.equal(consent.url, 'https://consent.basiq.io/home?token=client-token-1&action=connect');
  assert.doesNotMatch(JSON.stringify(consent), /server-token-1|basiq-secret-key/);
  assert.equal(calls.length, 3);
});

test('basiq client: transactions follow pagination and return an advanced cursor', async () => {
  const requested = [];
  const client = createBasiqClient({
    apiKey: 'basiq-secret-key',
    fetch: async (url) => {
      if (url.endsWith('/token')) return jsonResponse({ access_token: 'server-token-1', expires_in: 3600 });
      requested.push(String(url));
      if (String(url).includes('page=2')) {
        return jsonResponse({
          data: [{ id: 'tx-3', postDate: '2026-07-01', description: 'Rent', amount: '-500.00' }],
          links: {},
        });
      }
      return jsonResponse({
        data: [
          { id: 'tx-1', postDate: '2026-06-28', description: 'Coffee', amount: '-12.99' },
          { id: 'tx-2', postDate: '2026-06-30', description: 'Sale', amount: '250.00' },
        ],
        links: { next: 'https://au-api.basiq.io/users/basiq-user-1/transactions?page=2' },
      });
    },
  });

  const { transactions, nextCursor } = await client.listTransactions({
    userId: 'basiq-user-1',
    providerAccountId: 'acc-1',
    syncCursor: '2026-06-27',
  });

  assert.equal(transactions.length, 3);
  assert.deepEqual(transactions.map(tx => tx.sourceTransactionId), ['tx-1', 'tx-2', 'tx-3']);
  assert.deepEqual(transactions.map(tx => tx.amountCents), [-1299, 25000, -50000]);
  assert.equal(nextCursor, '2026-07-01');
  // First request filters by account and re-fetches from the stored cursor day.
  assert.match(decodeURIComponent(requested[0]), /account\.id\.eq\('acc-1'\)/);
  assert.match(decodeURIComponent(requested[0]), /transaction\.postDate\.gteq\('2026-06-27'\)/);
  assert.equal(requested.length, 2);
});

test('basiq client: empty transaction page keeps the previous cursor', async () => {
  const client = createBasiqClient({
    apiKey: 'basiq-secret-key',
    fetch: async (url) => {
      if (url.endsWith('/token')) return jsonResponse({ access_token: 'server-token-1', expires_in: 3600 });
      return jsonResponse({ data: [], links: {} });
    },
  });

  const { transactions, nextCursor } = await client.listTransactions({
    userId: 'basiq-user-1',
    providerAccountId: 'acc-1',
    syncCursor: '2026-06-27',
  });

  assert.deepEqual(transactions, []);
  assert.equal(nextCursor, '2026-06-27');
});

test('basiq client: lists provider accounts and maps Basiq errors to stable errors', async () => {
  const client = createBasiqClient({
    apiKey: 'basiq-secret-key',
    fetch: async (url, options) => {
      if (url.endsWith('/token')) return jsonResponse({ access_token: 'server-token-1', expires_in: 3600 });
      if (url.endsWith('/users/basiq-user-1/accounts')) {
        assert.equal(options.headers.Authorization, 'Bearer server-token-1');
        return jsonResponse({ data: [{ id: 'acc-1', name: 'Business Everyday', accountNo: '123456789', class: { type: 'transaction' } }] });
      }
      return jsonResponse({ message: 'upstream unavailable' }, 503);
    },
  });

  assert.deepEqual(await client.listAccounts({ userId: 'basiq-user-1' }), [{
    provider: 'basiq',
    providerAccountId: 'acc-1',
    providerAccountName: 'Business Everyday',
    providerAccountNumber: '123456789',
    providerAccountType: 'transaction',
    raw: { id: 'acc-1', name: 'Business Everyday', accountNo: '123456789', class: { type: 'transaction' } },
  }]);

  await assert.rejects(
    () => client.getJob({ jobId: 'job-1' }),
    (err) => err.code === 'basiq_upstream_error' && /503 upstream unavailable/.test(err.message),
  );
});
