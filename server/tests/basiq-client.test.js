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
