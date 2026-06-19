'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });
const call = (m, a) => api.call(db, m, a);

function setupBank() {
  return call('bank.createAccount', { name: 'Business Feed Account', code: '092' });
}

test('bank feed import: inserts provider metadata and dedupes source transaction ids', () => {
  const bank = setupBank();
  const first = call('bank.importFeedTransactions', {
    bankAccountId: bank.id,
    transactions: [{
      provider: 'fake',
      sourceAccountId: 'acc-1',
      sourceTransactionId: 'txn-1',
      date: '2026-06-01',
      payee: 'Officeworks',
      description: 'Card purchase Officeworks',
      reference: 'AUTH123',
      amountCents: -5500,
      postedAt: '2026-06-01T10:00:00Z',
      raw: { category: 'office' },
    }],
  });
  assert.deepEqual(first, { imported: 1, skipped: 0, updated: 0 });

  const second = call('bank.importFeedTransactions', {
    bankAccountId: bank.id,
    transactions: [{
      provider: 'fake',
      sourceAccountId: 'acc-1',
      sourceTransactionId: 'txn-1',
      date: '2026-06-01',
      payee: 'Officeworks',
      description: 'Card purchase Officeworks',
      reference: 'AUTH123',
      amountCents: -5500,
      postedAt: '2026-06-01T10:00:00Z',
      raw: { category: 'office' },
    }],
  });
  assert.deepEqual(second, { imported: 0, skipped: 1, updated: 0 });

  const lines = call('bank.reconcileData', { bankAccountId: bank.id }).statementLines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].source_kind, 'bank_feed');
  assert.equal(lines[0].source_provider, 'fake');
  assert.equal(lines[0].source_account_id, 'acc-1');
  assert.equal(lines[0].source_transaction_id, 'txn-1');
  assert.equal(lines[0].posted_at, '2026-06-01T10:00:00Z');
  assert.match(lines[0].raw_json, /office/);
});

test('bank feed sync: fake provider normalizes transactions and imports statement lines', async () => {
  const bank = setupBank();
  const result = await require('../src/services/bank-feed/fake-provider').sync(db, {
    bankAccountId: bank.id,
    providerAccountId: 'fake-cheque',
  });
  assert.equal(result.imported, 2);
  assert.equal(result.skipped, 0);
  const lines = call('bank.reconcileData', { bankAccountId: bank.id }).statementLines;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].source_provider, 'fake');
  assert.ok(lines.some(l => l.amount_cents < 0));
  assert.ok(lines.some(l => l.amount_cents > 0));
});
