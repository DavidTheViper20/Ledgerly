'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });
const call = (m, a) => api.call(db, m, a);

test('bank feed connections: upserts provider connection metadata', () => {
  const first = call('bankFeed.upsertConnection', {
    provider: 'basiq',
    providerUserId: 'user-1',
    providerConnectionId: 'conn-1',
    institutionName: 'Demo Bank',
    status: 'connected',
    consentStatus: 'active',
    consentExpiresAt: '2026-12-31T00:00:00Z',
  });

  assert.equal(first.provider, 'basiq');
  assert.equal(first.provider_user_id, 'user-1');
  assert.equal(first.provider_connection_id, 'conn-1');
  assert.equal(first.institution_name, 'Demo Bank');
  assert.equal(first.status, 'connected');
  assert.equal(first.consent_status, 'active');

  const second = call('bankFeed.upsertConnection', {
    provider: 'basiq',
    providerUserId: 'user-1',
    providerConnectionId: 'conn-1',
    institutionName: 'Demo Bank Updated',
    status: 'reauthorise_required',
    consentStatus: 'expired',
    lastError: 'consent expired',
  });

  assert.equal(second.id, first.id);
  assert.equal(second.institution_name, 'Demo Bank Updated');
  assert.equal(second.status, 'reauthorise_required');
  assert.equal(second.consent_status, 'expired');
  assert.equal(second.last_error, 'consent expired');

  const rows = call('bankFeed.connections');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id);
});

test('bank feed account links: maps provider accounts to Ledgerly bank accounts and disconnects locally', () => {
  const ledgerlyBankA = call('bank.createAccount', { name: 'Operating Account', code: '091' });
  const ledgerlyBankB = call('bank.createAccount', { name: 'Savings Account', code: '092' });
  const connection = call('bankFeed.upsertConnection', {
    provider: 'basiq',
    providerUserId: 'user-1',
    providerConnectionId: 'conn-1',
    institutionName: 'Demo Bank',
    status: 'connected',
    consentStatus: 'active',
  });

  const first = call('bankFeed.mapAccount', {
    connectionId: connection.id,
    providerAccountId: 'acc-1',
    providerAccountName: 'Business Everyday',
    providerAccountNumber: '123-456 789',
    providerAccountType: 'transaction',
    bankAccountId: ledgerlyBankA.id,
    syncCursor: 'cursor-1',
  });

  assert.equal(first.connection_id, connection.id);
  assert.equal(first.provider, 'basiq');
  assert.equal(first.provider_account_id, 'acc-1');
  assert.equal(first.bank_account_id, ledgerlyBankA.id);

  const second = call('bankFeed.mapAccount', {
    connectionId: connection.id,
    providerAccountId: 'acc-1',
    providerAccountName: 'Business Everyday',
    providerAccountNumber: '123-456 789',
    providerAccountType: 'transaction',
    bankAccountId: ledgerlyBankB.id,
    syncCursor: 'cursor-2',
  });

  assert.equal(second.id, first.id);
  assert.equal(second.bank_account_id, ledgerlyBankB.id);
  assert.equal(second.sync_cursor, 'cursor-2');

  const links = call('bankFeed.accountLinks');
  assert.equal(links.length, 1);
  assert.equal(links[0].bank_account_name, 'Savings Account');
  assert.equal(links[0].institution_name, 'Demo Bank');

  assert.deepEqual(call('bankFeed.disconnectLocalMapping', { linkId: first.id }), { ok: true });
  assert.equal(call('bankFeed.accountLinks').length, 0);
});
