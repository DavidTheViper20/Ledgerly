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

test('reconciliation transfer: creates transfer from money-out statement line and marks source side reconciled', () => {
  const env = setup();
  const savings = call('bank.createAccount', { name: 'Savings', code: '094' });
  call('bank.importStatement', {
    bankAccountId: env.bank.id,
    csv: 'Date,Description,Amount\n2026-06-05,Transfer to savings,-250.00\n',
  });
  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];

  const transfer = call('bank.createTransferAndMatch', {
    statementLineId: line.id,
    otherBankAccountId: savings.id,
    reference: 'Transfer to savings',
  });
  assert.equal(transfer.from_account_id, env.bank.id);
  assert.equal(transfer.to_account_id, savings.id);
  assert.equal(transfer.amount_cents, 25000);
  assert.equal(transfer.from_reconciled, 1);
  assert.equal(transfer.to_reconciled, 0);

  const banks = call('bank.accounts');
  assert.equal(banks.find(b => b.id === env.bank.id).balance_cents, -25000);
  assert.equal(banks.find(b => b.id === savings.id).balance_cents, 25000);
  assert.equal(call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines.length, 0);
});

test('reconciliation split: creates one bank transaction with multiple coded lines', () => {
  const env = setup();
  const meals = db.prepare("SELECT * FROM accounts WHERE code='499'").get() || env.rent;
  call('bank.importStatement', {
    bankAccountId: env.bank.id,
    csv: 'Date,Description,Amount\n2026-06-06,Mixed supplier,-150.00\n',
  });
  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];

  const tx = call('bank.createSplitAndMatch', {
    statementLineId: line.id,
    contactId: null,
    taxMode: 'none',
    lines: [
      { description: 'Office rent portion', amountCents: 10000, accountId: env.rent.id, taxRateId: null },
      { description: 'Meal portion', amountCents: 5000, accountId: meals.id, taxRateId: null },
    ],
  });
  assert.equal(tx.kind, 'SPEND');
  assert.equal(tx.total_cents, 15000);
  assert.equal(tx.lines.length, 2);
  assert.equal(call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines.length, 0);
});

test('reconciliation split: rejects totals that do not equal statement line amount', () => {
  const env = setup();
  call('bank.importStatement', {
    bankAccountId: env.bank.id,
    csv: 'Date,Description,Amount\n2026-06-07,Mixed supplier,-150.00\n',
  });
  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];
  assert.throws(() => call('bank.createSplitAndMatch', {
    statementLineId: line.id,
    taxMode: 'none',
    lines: [{ description: 'Short split', amountCents: 14999, accountId: env.rent.id }],
  }), /Split total must equal/);
});

test('xero-style flow: feed lines match existing payments and create ruled expenses', () => {
  const env = setup();
  const rule = call('bank.rules.save', {
    name: 'Officeworks card spend',
    bankAccountId: env.bank.id,
    direction: 'money_out',
    textContains: 'OFFICEWORKS',
    minAmountCents: 1000,
    maxAmountCents: 10000,
    accountId: env.rent.id,
    descriptionTemplate: 'Office supplies',
    priority: 20,
    enabled: true,
  });
  const inv = call('invoices.save', {
    kind: 'ACCREC',
    contactId: env.contact.id,
    issueDate: '2026-06-01',
    dueDate: '2026-06-14',
    taxMode: 'none',
    reference: 'INV-FLOW',
    lines: [{ description: 'Consulting', qty: 1, unitPriceCents: 10000, accountId: env.sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  call('payments.add', {
    invoiceId: inv.id,
    bankAccountId: env.bank.id,
    date: '2026-06-10',
    amountCents: 10000,
    reference: 'INV-FLOW',
  });
  call('bank.importFeedTransactions', {
    bankAccountId: env.bank.id,
    transactions: [
      {
        provider: 'fake',
        sourceAccountId: 'acc-flow',
        sourceTransactionId: 'flow-deposit',
        date: '2026-06-10',
        payee: 'Acme Ltd',
        description: 'Customer payment',
        reference: 'INV-FLOW',
        amountCents: 10000,
      },
      {
        provider: 'fake',
        sourceAccountId: 'acc-flow',
        sourceTransactionId: 'flow-card',
        date: '2026-06-11',
        payee: 'Officeworks',
        description: 'OFFICEWORKS CARD',
        reference: 'CARD',
        amountCents: -5500,
      },
    ],
  });

  let data = call('bank.reconcileData', { bankAccountId: env.bank.id });
  const deposit = data.statementLines.find(line => line.amount_cents === 10000);
  call('bank.match', {
    statementLineId: deposit.id,
    kind: deposit.suggestions[0].kind,
    id: deposit.suggestions[0].id,
  });

  data = call('bank.reconcileData', { bankAccountId: env.bank.id });
  const card = data.statementLines.find(line => line.amount_cents === -5500);
  const suggestion = card.ruleSuggestions[0];
  assert.equal(suggestion.rule_id, rule.id);
  call('bank.createAndMatch', {
    statementLineId: card.id,
    contactId: suggestion.contact_id,
    accountId: suggestion.account_id,
    taxRateId: suggestion.tax_rate_id,
    description: suggestion.description,
  });

  assert.equal(call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines.length, 0);
  const bank = call('bank.accounts').find(b => b.id === env.bank.id);
  assert.equal(bank.unreconciled, 0);
  assert.equal(bank.statement_balance_cents, bank.balance_cents);
  assert.equal(bank.balance_cents, 4500);
  const pl = call('reports.profitAndLoss', { from: '2026-06-01', to: '2026-06-30' });
  assert.equal(pl.totals.revenue_cents, 10000);
  assert.equal(pl.totals.expenses_cents, 5500);
});

test('reconciliation regression: duplicates are skipped and unreconcile unlocks created transaction edits', () => {
  const env = setup();
  const feed = {
    provider: 'fake',
    sourceAccountId: 'acc-dup',
    sourceTransactionId: 'dup-card',
    date: '2026-06-12',
    payee: 'OfficeMart',
    description: 'Stationery',
    reference: 'CARD',
    amountCents: -4200,
  };
  assert.deepEqual(call('bank.importFeedTransactions', {
    bankAccountId: env.bank.id,
    transactions: [feed],
  }), { imported: 1, skipped: 0, updated: 0 });
  assert.deepEqual(call('bank.importFeedTransactions', {
    bankAccountId: env.bank.id,
    transactions: [feed],
  }), { imported: 0, skipped: 1, updated: 0 });
  let data = call('bank.reconcileData', { bankAccountId: env.bank.id });
  assert.equal(data.statementLines.length, 1);

  const line = data.statementLines[0];
  call('bank.createAndMatch', {
    statementLineId: line.id,
    accountId: env.rent.id,
    description: 'Stationery',
  });
  const matched = db.prepare('SELECT * FROM statement_lines WHERE id=?').get(line.id);
  assert.equal(matched.status, 'MATCHED');
  assert.throws(() => call('bank.saveTransaction', {
    id: matched.matched_id,
    kind: 'SPEND',
    bankAccountId: env.bank.id,
    date: '2026-06-12',
    taxMode: 'none',
    reference: 'Locked edit',
    lines: [{ description: 'Locked', qty: 1, unitPriceCents: 4200, accountId: env.rent.id }],
  }), /Unreconcile/);

  call('bank.unreconcile', { statementLineId: line.id });
  data = call('bank.reconcileData', { bankAccountId: env.bank.id });
  assert.equal(data.statementLines.length, 1);
  const edited = call('bank.saveTransaction', {
    id: matched.matched_id,
    kind: 'SPEND',
    bankAccountId: env.bank.id,
    date: '2026-06-12',
    taxMode: 'none',
    reference: 'Unlocked edit',
    lines: [{ description: 'Unlocked', qty: 1, unitPriceCents: 4200, accountId: env.rent.id }],
  });
  assert.equal(edited.reference, 'Unlocked edit');
});
