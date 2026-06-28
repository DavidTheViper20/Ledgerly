'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');
const flow = require('../src/services/cloud/bank-feed-flow');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });
const call = (m, a) => api.call(db, m, a);

test('cloud bank feed flow: starts connect through Ledgerly Cloud and opens consent URL', async () => {
  const opened = [];
  const cloudClient = {
    publicStatus: () => ({ configured: true }),
    startConnect: async (input) => {
      assert.deepEqual(input, { email: 'owner@example.com', mobile: '+61400000000', action: 'connect' });
      return {
        provider: 'basiq',
        consentUrl: 'https://consent.basiq.io/home?token=client-token-secret',
        connection: {
          provider: 'basiq',
          providerUserId: 'basiq-user-1',
          providerConnectionId: '',
          institutionName: '',
          consentStatus: 'pending',
        },
      };
    },
  };

  const result = await flow.startConnect(db, {
    cloudClient,
    email: 'owner@example.com',
    mobile: '+61400000000',
    openExternal: async (url) => opened.push(url),
  });

  assert.equal(opened[0], 'https://consent.basiq.io/home?token=client-token-secret');
  assert.equal(result.connection.provider_user_id, 'basiq-user-1');
  assert.doesNotMatch(JSON.stringify(result), /client-token-secret|basiq-secret-key|server-token/);
});

test('cloud bank feed flow: maps provider accounts locally and in Ledgerly Cloud', async () => {
  const bank = call('bank.createAccount', { name: 'Operating Account', code: '091' });
  const connection = call('bankFeed.upsertConnection', {
    provider: 'basiq',
    providerUserId: 'basiq-user-1',
    providerConnectionId: 'conn-1',
    institutionName: 'Demo Bank',
    status: 'connected',
    consentStatus: 'active',
  });
  const cloudCalls = [];
  const cloudClient = {
    publicStatus: () => ({ configured: true }),
    mapProviderAccount: async (input) => {
      cloudCalls.push(input);
      return { account: { id: 'bfa_0001', providerAccountId: input.providerAccountId } };
    },
  };

  const link = await flow.mapProviderAccount(db, {
    cloudClient,
    connectionId: connection.id,
    providerAccountId: 'acc-1',
    providerAccountName: 'Business Everyday',
    providerAccountNumber: '123456789',
    providerAccountType: 'transaction',
    bankAccountId: bank.id,
  });

  assert.equal(link.provider_account_id, 'acc-1');
  assert.equal(link.bank_account_id, bank.id);
  assert.deepEqual(cloudCalls[0], {
    providerAccountId: 'acc-1',
    providerAccountName: 'Business Everyday',
    providerAccountNumber: '123456789',
    providerAccountType: 'transaction',
    desktopBankAccountLocalId: String(bank.id),
  });
});

test('cloud bank feed flow: imports cloud sync transactions and dedupes provider transaction IDs', async () => {
  const bank = call('bank.createAccount', { name: 'Operating Account', code: '091' });
  const connection = call('bankFeed.upsertConnection', {
    provider: 'basiq',
    providerUserId: 'basiq-user-1',
    providerConnectionId: 'conn-1',
    institutionName: 'Demo Bank',
    status: 'connected',
    consentStatus: 'active',
  });
  const link = call('bankFeed.mapAccount', {
    connectionId: connection.id,
    providerAccountId: 'acc-1',
    providerAccountName: 'Business Everyday',
    bankAccountId: bank.id,
  });
  const cloudClient = {
    publicStatus: () => ({ configured: true }),
    syncLinkedAccount: async (input) => {
      assert.equal(input.providerAccountId, 'acc-1');
      assert.equal(input.desktopBankAccountLocalId, String(bank.id));
      return {
        provider: 'basiq',
        syncRun: { id: 'bfs_0001', status: 'succeeded', finishedAt: '2026-06-28T00:00:00.000Z' },
        transactions: [{
          sourceAccountId: 'acc-1',
          sourceTransactionId: 'tx-1',
          date: '2026-06-28',
          payee: 'Coffee Supplies',
          description: 'Coffee Supplies',
          reference: 'POS123',
          amountCents: -1299,
          postedAt: '2026-06-28T00:00:00.000Z',
        }],
      };
    },
  };

  const first = await flow.syncLinkedAccount(db, { cloudClient, linkId: link.id, idempotencyKey: 'sync-1' });
  const second = await flow.syncLinkedAccount(db, { cloudClient, linkId: link.id, idempotencyKey: 'sync-2' });

  assert.equal(first.imported, 1);
  assert.equal(first.skipped, 0);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM statement_lines WHERE source_transaction_id = ?').get('tx-1').c, 1);
  assert.ok(call('bankFeed.accountLinks')[0].last_sync_at);
});
