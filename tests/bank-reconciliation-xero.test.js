'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });
const call = (m, a) => api.call(db, m, a);

function setup() {
  const contact = call('contacts.save', { name: 'Acme Ltd' });
  const sales = db.prepare("SELECT * FROM accounts WHERE code='200'").get();
  const rent = db.prepare("SELECT * FROM accounts WHERE code='469'").get();
  const bank = call('bank.createAccount', { name: 'Cheque', code: '093' });
  return { contact, sales, rent, bank };
}

test('reconciliation audit: match records action and unreconcile closes it', () => {
  const env = setup();
  const inv = call('invoices.save', {
    kind: 'ACCREC',
    contactId: env.contact.id,
    issueDate: '2026-06-01',
    dueDate: '2026-06-14',
    taxMode: 'none',
    lines: [{ description: 'Consulting', qty: 1, unitPriceCents: 10000, accountId: env.sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2026-06-03', amountCents: 10000 });
  call('bank.importStatement', { bankAccountId: env.bank.id, csv: 'Date,Description,Amount\n2026-06-03,ACME,100.00\n' });

  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];
  const match = line.suggestions[0];
  call('bank.match', { statementLineId: line.id, kind: match.kind, id: match.id });

  let history = call('bank.reconciliationHistory', { statementLineId: line.id });
  assert.equal(history.length, 1);
  assert.equal(history[0].action, 'matched_existing');
  assert.equal(history[0].matched_kind, 'payment');
  assert.equal(history[0].matched_id, match.id);
  assert.equal(history[0].unreconciled_at, null);

  call('bank.unreconcile', { statementLineId: line.id });
  history = call('bank.reconciliationHistory', { statementLineId: line.id });
  assert.equal(history.length, 1);
  assert.match(history[0].unreconciled_at, /^\d{4}-\d{2}-\d{2}/);
});
