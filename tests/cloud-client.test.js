'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createCloudClient } = require('../src/services/cloud/client');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('cloud client sends the Ledgerly session token and never exposes provider tokens', async () => {
  const calls = [];
  const client = createCloudClient({
    baseUrl: 'https://cloud.ledgerly.test/',
    sessionToken: 'ledgerly-session-1',
    organizationId: 'org_0001',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        provider: 'basiq',
        consentUrl: 'https://consent.basiq.io/home?token=client-token-secret',
      }, 201);
    },
  });

  assert.equal(client.getServerToken, undefined);
  assert.equal(client.createClientToken, undefined);

  const result = await client.startConnect({ email: 'owner@example.com' });

  assert.equal(result.consentUrl, 'https://consent.basiq.io/home?token=client-token-secret');
  assert.equal(calls[0].url, 'https://cloud.ledgerly.test/v1/bank-feeds/connect/start');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ledgerly-session-1');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    organizationId: 'org_0001',
    email: 'owner@example.com',
  });
  assert.doesNotMatch(JSON.stringify(calls), /basiq-secret|server-token|providerAccessToken/i);
});

test('cloud client maps API errors to stable messages', async () => {
  const client = createCloudClient({
    baseUrl: 'https://cloud.ledgerly.test',
    sessionToken: 'ledgerly-session-1',
    organizationId: 'org_0001',
    fetch: async () => jsonResponse({ error: { code: 'forbidden', message: 'Permission denied' } }, 403),
  });

  await assert.rejects(
    () => client.listProviderAccounts(),
    /Permission denied/,
  );
});

test('cloud client supports consent revocation and deletion request without provider credentials', async () => {
  const calls = [];
  const client = createCloudClient({
    baseUrl: 'https://cloud.ledgerly.test',
    sessionToken: 'ledgerly-session-1',
    organizationId: 'org_0001',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ ok: true }, url.toString().includes('data-deletion') ? 202 : 200);
    },
  });

  await client.revokeConsent({ providerConnectionId: 'conn-1' });
  await client.requestDataDeletion({ providerAccountId: 'acc-1', reason: 'user_requested' });

  assert.equal(calls[0].url, 'https://cloud.ledgerly.test/v1/bank-feeds/consent/revoke');
  assert.equal(calls[1].url, 'https://cloud.ledgerly.test/v1/bank-feeds/data-deletion/request');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    organizationId: 'org_0001',
    providerConnectionId: 'conn-1',
  });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    organizationId: 'org_0001',
    providerAccountId: 'acc-1',
    reason: 'user_requested',
  });
  assert.doesNotMatch(JSON.stringify(calls), /basiq-secret|server-token|providerAccessToken/i);
});
