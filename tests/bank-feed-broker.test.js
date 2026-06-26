'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createBasiqBroker } = require('../src/services/bank-feed/basiq-broker');

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

test('basiq broker: exchanges API key for cached server token without exposing the key', async () => {
  const calls = [];
  const broker = createBasiqBroker({
    apiKey: 'secret-api-key',
    now: () => 0,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ access_token: 'server-token-1', expires_in: 3600 });
    },
  });

  assert.equal(await broker.getServerToken(), 'server-token-1');
  assert.equal(await broker.getServerToken(), 'server-token-1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://au-api.basiq.io/token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Basic secret-api-key');
  assert.equal(calls[0].options.headers['basiq-version'], '3.0');
  assert.equal(bodyParam(calls[0], 'scope'), 'SERVER_ACCESS');
  assert.doesNotMatch(JSON.stringify(await broker.publicStatus()), /secret-api-key/);
});

test('basiq broker: refreshes server token before expiry', async () => {
  let now = 0;
  const tokens = ['server-token-1', 'server-token-2'];
  const calls = [];
  const broker = createBasiqBroker({
    apiKey: 'secret-api-key',
    now: () => now,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ access_token: tokens.shift(), expires_in: 120 });
    },
  });

  assert.equal(await broker.getServerToken(), 'server-token-1');
  now = 61_000;
  assert.equal(await broker.getServerToken(), 'server-token-2');

  assert.equal(calls.length, 2);
});

test('basiq broker: creates user, creates client token, and returns consent url', async () => {
  const calls = [];
  const broker = createBasiqBroker({
    apiKey: 'secret-api-key',
    now: () => 0,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/token') && bodyParam({ options }, 'scope') === 'SERVER_ACCESS') {
        return jsonResponse({ access_token: 'server-token-1', expires_in: 3600 });
      }
      if (url.endsWith('/users')) {
        assert.equal(options.headers.Authorization, 'Bearer server-token-1');
        assert.deepEqual(JSON.parse(options.body), { email: 'owner@example.com', mobile: '+61400000000' });
        return jsonResponse({ id: 'basiq-user-1', email: 'owner@example.com' });
      }
      if (url.endsWith('/token') && bodyParam({ options }, 'scope') === 'CLIENT_ACCESS') {
        assert.equal(options.headers.Authorization, 'Basic secret-api-key');
        assert.equal(bodyParam({ options }, 'userId'), 'basiq-user-1');
        return jsonResponse({ access_token: 'client-token-1', expires_in: 600 });
      }
      throw new Error(`Unexpected call: ${url}`);
    },
  });

  const user = await broker.createUser({ email: 'owner@example.com', mobile: '+61400000000' });
  const consent = await broker.createConsentUrl({ userId: user.id, action: 'connect' });

  assert.equal(user.id, 'basiq-user-1');
  assert.equal(consent.userId, 'basiq-user-1');
  assert.equal(consent.url, 'https://consent.basiq.io/home?token=client-token-1&action=connect');
  assert.doesNotMatch(JSON.stringify(consent), /secret-api-key|server-token-1/);
  assert.equal(calls.length, 3);
});

test('basiq broker: lists accounts and polls jobs with server token', async () => {
  const calls = [];
  const broker = createBasiqBroker({
    apiKey: 'secret-api-key',
    now: () => 0,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/token')) {
        return jsonResponse({ access_token: 'server-token-1', expires_in: 3600 });
      }
      if (url.endsWith('/users/user-1/accounts')) {
        assert.equal(options.headers.Authorization, 'Bearer server-token-1');
        return jsonResponse({
          data: [
            { id: 'acc-1', name: 'Business Everyday', accountNo: '123-456 789', class: { type: 'transaction' } },
          ],
        });
      }
      if (url.endsWith('/jobs/job-1')) {
        assert.equal(options.headers.Authorization, 'Bearer server-token-1');
        return jsonResponse({ id: 'job-1', steps: [{ title: 'retrieve-accounts', status: 'success' }] });
      }
      throw new Error(`Unexpected call: ${url}`);
    },
  });

  const accounts = await broker.listAccounts({ userId: 'user-1' });
  const job = await broker.getJob({ jobId: 'job-1' });

  assert.deepEqual(accounts, [{
    provider: 'basiq',
    providerAccountId: 'acc-1',
    providerAccountName: 'Business Everyday',
    providerAccountNumber: '123-456 789',
    providerAccountType: 'transaction',
    raw: { id: 'acc-1', name: 'Business Everyday', accountNo: '123-456 789', class: { type: 'transaction' } },
  }]);
  assert.equal(job.id, 'job-1');
  assert.equal(calls.filter(c => c.url.endsWith('/token')).length, 1);
});
