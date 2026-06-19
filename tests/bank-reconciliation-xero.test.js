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

test('reconciliation matcher: ranks exact amount date and reference above amount-only matches', () => {
  const env = setup();
  const invA = call('invoices.save', {
    kind: 'ACCREC',
    contactId: env.contact.id,
    issueDate: '2026-06-01',
    dueDate: '2026-06-14',
    taxMode: 'none',
    reference: 'INV-A',
    lines: [{ description: 'A', qty: 1, unitPriceCents: 20000, accountId: env.sales.id }],
  });
  const invB = call('invoices.save', {
    kind: 'ACCREC',
    contactId: env.contact.id,
    issueDate: '2026-06-01',
    dueDate: '2026-06-14',
    taxMode: 'none',
    reference: 'INV-B',
    lines: [{ description: 'B', qty: 1, unitPriceCents: 20000, accountId: env.sales.id }],
  });
  call('invoices.approve', { id: invA.id });
  call('invoices.approve', { id: invB.id });
  const oldPayment = call('payments.add', {
    invoiceId: invA.id,
    bankAccountId: env.bank.id,
    date: '2026-05-15',
    amountCents: 20000,
    reference: 'OLD',
  });
  const bestPayment = call('payments.add', {
    invoiceId: invB.id,
    bankAccountId: env.bank.id,
    date: '2026-06-03',
    amountCents: 20000,
    reference: 'INV-B',
  });
  call('bank.importStatement', {
    bankAccountId: env.bank.id,
    csv: 'Date,Description,Reference,Amount\n2026-06-03,ACME PAYMENT,INV-B,200.00\n',
  });

  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];
  assert.equal(line.suggestions[0].kind, 'payment');
  assert.equal(line.suggestions[0].id, bestPayment.payments.at(-1).id);
  assert.ok(line.suggestions[0].score > line.suggestions.find(s => s.id === oldPayment.payments.at(-1).id).score);
  assert.ok(line.suggestions[0].reasons.includes('Exact amount'));
  assert.ok(line.suggestions[0].reasons.includes('Reference match'));
});

test('bank rules: matching rule returns create suggestion without posting a journal', () => {
  const env = setup();
  const rule = call('bank.rules.save', {
    name: 'Adobe subscription',
    bankAccountId: env.bank.id,
    direction: 'money_out',
    textContains: 'ADOBE',
    minAmountCents: 1000,
    maxAmountCents: 10000,
    contactId: null,
    accountId: env.rent.id,
    taxRateId: null,
    descriptionTemplate: 'Software subscription',
    priority: 10,
    enabled: true,
  });
  call('bank.importStatement', {
    bankAccountId: env.bank.id,
    csv: 'Date,Description,Amount\n2026-06-04,ADOBE CREATIVE CLOUD,-55.00\n',
  });
  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];
  assert.equal(line.ruleSuggestions.length, 1);
  assert.equal(line.ruleSuggestions[0].rule_id, rule.id);
  assert.equal(line.ruleSuggestions[0].account_id, env.rent.id);
  assert.equal(call('journals.list', { manualOnly: false }).length, 0);
});
