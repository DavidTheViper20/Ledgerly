'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');
const flow = require('../src/services/bank-feed/flow');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });
const call = (m, a) => api.call(db, m, a);

test('bank feed flow: starts connect by creating a Basiq user and opening consent without returning token url', async () => {
  const opened = [];
  const broker = {
    publicStatus: () => ({ configured: true }),
    createUser: async (details) => {
      assert.deepEqual(details, { email: 'owner@example.com', mobile: '+61400000000' });
      return { id: 'user-1' };
    },
    createConsentUrl: async ({ userId, action }) => {
      assert.equal(userId, 'user-1');
      assert.equal(action, 'connect');
      return { url: 'https://consent.basiq.io/home?token=client-token-1&action=connect' };
    },
  };

  const result = await flow.startConnect(db, {
    broker,
    email: 'owner@example.com',
    mobile: '+61400000000',
    openExternal: async (url) => { opened.push(url); },
  });

  assert.equal(opened[0], 'https://consent.basiq.io/home?token=client-token-1&action=connect');
  assert.equal(result.provider, 'basiq');
  assert.equal(result.connection.provider_user_id, 'user-1');
  assert.equal(result.connection.status, 'consent_started');
  assert.doesNotMatch(JSON.stringify(result), /client-token-1|secret-api-key/);
});

test('bank feed flow: lists provider accounts for stored connection user', async () => {
  call('bankFeed.upsertConnection', {
    provider: 'basiq',
    providerUserId: 'user-1',
    providerConnectionId: '',
    status: 'consent_started',
  });
  const broker = {
    listAccounts: async ({ userId }) => {
      assert.equal(userId, 'user-1');
      return [{ providerAccountId: 'acc-1', providerAccountName: 'Business Everyday' }];
    },
  };

  const accounts = await flow.listProviderAccounts(db, { broker });

  assert.deepEqual(accounts, [{ providerAccountId: 'acc-1', providerAccountName: 'Business Everyday' }]);
});

test('bank feed flow: syncs a linked account with server token hidden from renderer', async () => {
  const bank = call('bank.createAccount', { name: 'Operating Account', code: '091' });
  const connection = call('bankFeed.upsertConnection', {
    provider: 'basiq',
    providerUserId: 'user-1',
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
  const broker = {
    getServerToken: async () => 'server-token-1',
  };

  const result = await flow.syncLinkedAccount(db, {
    broker,
    linkId: link.id,
    syncTransactions: async (syncDb, args) => {
      assert.equal(syncDb, db);
      assert.deepEqual(args, {
        serverToken: 'server-token-1',
        userId: 'user-1',
        providerAccountId: 'acc-1',
        bankAccountId: bank.id,
      });
      return { imported: 2, skipped: 0, updated: 0 };
    },
  });

  assert.deepEqual(result, { imported: 2, skipped: 0, updated: 0 });
  const updated = call('bankFeed.accountLinks').find(l => l.id === link.id);
  assert.ok(updated.last_sync_at);
});
