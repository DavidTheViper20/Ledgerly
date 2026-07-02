'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });
const call = (m, a) => api.call(db, m, a);

test('db upgrade: opening a pre-bank-feeds database adds feed columns without crashing', () => {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-legacy-')), 'org.db');

  // Simulate a database created before bank feeds existed: statement_lines
  // without the source_* columns (so the dedupe index cannot exist yet).
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE statement_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_account_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    payee TEXT DEFAULT '',
    description TEXT DEFAULT '',
    reference TEXT DEFAULT '',
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'UNMATCHED',
    matched_kind TEXT,
    matched_id INTEGER,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  legacy.close();

  const upgraded = dbm.open(file);
  const cols = upgraded.prepare('PRAGMA table_info(statement_lines)').all().map(c => c.name);
  assert.ok(cols.includes('source_provider'));
  assert.ok(cols.includes('source_transaction_id'));
  const indexes = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name);
  assert.ok(indexes.includes('idx_statement_source_tx'), 'dedupe index must exist after upgrade');
  upgraded.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

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

test('basiq adapter: maps transaction fixture to normalized signed cents', () => {
  const basiq = require('../src/services/bank-feed/basiq');
  const tx = basiq.mapBasiqTransaction({
    id: 'bq-tx-1',
    account: 'bq-acc-1',
    postDate: '2026-06-12',
    description: 'BP FUEL',
    amount: '-62.76',
    balance: '1000.00',
  });
  assert.equal(tx.provider, 'basiq');
  assert.equal(tx.sourceAccountId, 'bq-acc-1');
  assert.equal(tx.sourceTransactionId, 'bq-tx-1');
  assert.equal(tx.date, '2026-06-12');
  assert.equal(tx.description, 'BP FUEL');
  assert.equal(tx.amountCents, -6276);
});
