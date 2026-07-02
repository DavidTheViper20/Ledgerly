'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });

const call = (m, a) => api.call(db, m, a);

function setupBasics() {
  const c = call('contacts.save', { name: 'Acme Pty Ltd' });
  const sales = db.prepare("SELECT * FROM accounts WHERE code='200'").get();
  const taxSales = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Income%'").get();
  return { c, sales, taxSales };
}

function postSale(env, { cents, issueDate }) {
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: env.c.id, issueDate, dueDate: issueDate, taxMode: 'exclusive',
    lines: [{ description: 'Consulting', qty: 1, unitPriceCents: cents, accountId: env.sales.id, taxRateId: env.taxSales.id }],
  });
  return call('invoices.approve', { id: inv.id });
}

// ---------- period generation ----------

test('tax: quarterly periods align to AU financial year with correct due dates', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  const r = call('tax.statements', { today: '2026-07-02' });
  const periods = r.needsAttention.map(s => [s.periodStart, s.periodEnd, s.dueDate]);
  assert.deepEqual(periods, [
    ['2025-07-01', '2025-09-30', '2025-10-28'],
    ['2025-10-01', '2025-12-31', '2026-02-28'], // Oct-Dec quarter due 28 Feb, not +28 days
    ['2026-01-01', '2026-03-31', '2026-04-28'],
    ['2026-04-01', '2026-06-30', '2026-07-28'],
  ]);
});

test('tax: overdue flag set only once due date has passed', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  const r = call('tax.statements', { today: '2026-07-02' });
  const q1 = r.needsAttention.find(s => s.periodStart === '2025-07-01');
  const q4 = r.needsAttention.find(s => s.periodStart === '2026-04-01');
  assert.equal(q1.overdue, true); // due 2025-10-28, well before today
  assert.equal(q4.overdue, false); // due 2026-07-28, after today
});

test('tax: monthly cycle produces one period per month', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  call('settings.update', { bas_cycle: 'monthly' });
  const r = call('tax.statements', { today: '2025-11-05' });
  const periods = r.needsAttention.map(s => [s.periodStart, s.periodEnd, s.dueDate]);
  assert.deepEqual(periods, [
    ['2025-08-01', '2025-08-31', '2025-09-21'],
    ['2025-09-01', '2025-09-30', '2025-10-21'],
    ['2025-10-01', '2025-10-31', '2025-11-21'],
  ]);
});

// ---------- figures ----------

test('tax: posted invoice makes the period netPayable reflect 1A GST on sales', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' }); // $1000 + 10% GST = $100 GST
  const r = call('tax.statements', { today: '2026-07-02' });
  const q1 = r.needsAttention.find(s => s.periodStart === '2025-07-01');
  assert.equal(q1.netPayableCents, 10000); // 1A only, no purchases/PAYG
  const stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.a1a_gst_on_sales_cents, 10000);
  assert.equal(stmt.netPayableCents, 10000);
});

// ---------- lodgement lifecycle ----------

test('tax: markLodged moves a statement to completed with a figures snapshot, unlodge reverses', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  let r = call('tax.statements', { today: '2026-07-02' });
  assert.equal(r.needsAttention.some(s => s.periodStart === '2025-07-01'), true);
  assert.equal(r.completed.length, 0);

  const lodged = call('tax.markLodged', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(lodged.net_payable_cents, 10000);
  const figures = JSON.parse(lodged.figures_json);
  assert.equal(figures.a1a_gst_on_sales_cents, 10000);

  r = call('tax.statements', { today: '2026-07-02' });
  assert.equal(r.needsAttention.some(s => s.periodStart === '2025-07-01'), false);
  assert.equal(r.completed.length, 1);
  assert.equal(r.completed[0].status, 'LODGED');
  assert.equal(r.completed[0].netPayableCents, 10000);

  // double-lodge rejected
  assert.throws(() => call('tax.markLodged', { from: '2025-07-01', to: '2025-09-30' }), /already been lodged/);

  // unlodge reverses
  call('tax.unlodge', { id: lodged.id });
  r = call('tax.statements', { today: '2026-07-02' });
  assert.equal(r.needsAttention.some(s => s.periodStart === '2025-07-01'), true);
  assert.equal(r.completed.length, 0);
});

test('tax: getStatement reflects lodgement status', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  let stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.status, 'DRAFT');
  call('tax.markLodged', { from: '2025-07-01', to: '2025-09-30' });
  stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.status, 'LODGED');
  assert.ok(stmt.lodgement);
});

// ---------- current (in-progress) period ----------

test('tax: a fresh org with zero journals still has a current period', () => {
  const r = call('tax.statements', { today: '2026-07-02' });
  assert.equal(r.needsAttention.length, 0);
  assert.equal(r.completed.length, 0);
  assert.ok(r.current);
  assert.deepEqual(
    [r.current.periodStart, r.current.periodEnd, r.current.dueDate],
    ['2026-07-01', '2026-09-30', '2026-10-28'],
  );
  assert.equal(r.current.netPayableCents, 0);
});

test('tax: current period reflects figures posted so far, separate from needsAttention', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' }); // ended Q1 FY26
  postSale(env, { cents: 50000, issueDate: '2026-07-02' }); // in the current (in-progress) quarter
  const r = call('tax.statements', { today: '2026-07-02' });
  assert.equal(r.current.periodStart, '2026-07-01');
  assert.equal(r.current.periodEnd, '2026-09-30');
  assert.equal(r.current.netPayableCents, 5000); // $500 x 10% GST
  // The in-progress period must never appear in needsAttention.
  assert.equal(r.needsAttention.some(s => s.periodStart === '2026-07-01'), false);
});

// ---------- Taxable Payments Annual Report (TPAR) ----------

function setupTparEnv() {
  const bank = call('bank.createAccount', { name: 'Operating Account', code: '091' });
  const supplier = call('contacts.save', { name: 'Bob Builder', is_supplier: 1, tax_number: '11 222 333 444' });
  const customer = call('contacts.save', { name: 'Alice Client', is_customer: 1 });
  const expAcc = db.prepare("SELECT * FROM accounts WHERE type='EXPENSE' LIMIT 1").get();
  const salesAcc = db.prepare("SELECT * FROM accounts WHERE code='200'").get();
  const taxRate = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Expenses%'").get();
  return { bank, supplier, customer, expAcc, salesAcc, taxRate };
}

test('tax: TPAR shows a bill with a partial payment, GST apportioned pro-rata', () => {
  const env = setupTparEnv();
  const bill = call('invoices.save', {
    kind: 'ACCPAY', contactId: env.supplier.id, issueDate: '2025-08-01', dueDate: '2025-08-15', taxMode: 'exclusive',
    lines: [{ description: 'Contract work', qty: 1, unitPriceCents: 100000, accountId: env.expAcc.id, taxRateId: env.taxRate.id }],
  });
  call('invoices.approve', { id: bill.id });
  // Bill total is $1100 ($1000 + $100 GST); pay half.
  call('payments.add', { invoiceId: bill.id, bankAccountId: env.bank.id, date: '2025-08-20', amountCents: 55000 });

  const r = call('tax.tpar', { fyEnd: '2026-06-30' });
  assert.equal(r.contacts.length, 1);
  const row = r.contacts[0];
  assert.equal(row.name, 'Bob Builder');
  assert.equal(row.abn, '11 222 333 444');
  assert.equal(row.totalPaidCents, 55000);
  assert.equal(row.gstCents, 5000); // 100 GST x (55000/110000)
  assert.equal(r.totals.totalPaidCents, 55000);
  assert.equal(r.totals.gstCents, 5000);
});

test('tax: TPAR excludes customer (ACCREC) invoices', () => {
  const env = setupTparEnv();
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: env.customer.id, issueDate: '2025-08-01', dueDate: '2025-08-15', taxMode: 'exclusive',
    lines: [{ description: 'Consulting', qty: 1, unitPriceCents: 50000, accountId: env.salesAcc.id, taxRateId: env.taxRate.id }],
  });
  call('invoices.approve', { id: inv.id });
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2025-08-20', amountCents: 55000 });

  const r = call('tax.tpar', { fyEnd: '2026-06-30' });
  assert.equal(r.contacts.length, 0);
  assert.equal(r.totals.totalPaidCents, 0);
});

test('tax: TPAR excludes payments outside the selected financial year', () => {
  const env = setupTparEnv();
  const bill = call('invoices.save', {
    kind: 'ACCPAY', contactId: env.supplier.id, issueDate: '2024-08-01', dueDate: '2024-08-15', taxMode: 'exclusive',
    lines: [{ description: 'Old work', qty: 1, unitPriceCents: 20000, accountId: env.expAcc.id, taxRateId: env.taxRate.id }],
  });
  call('invoices.approve', { id: bill.id });
  // Paid in FY25 (ends 2025-06-30), not FY26.
  call('payments.add', { invoiceId: bill.id, bankAccountId: env.bank.id, date: '2024-08-20', amountCents: 22000 });

  const r = call('tax.tpar', { fyEnd: '2026-06-30' });
  assert.equal(r.contacts.length, 0);

  const rPrior = call('tax.tpar', { fyEnd: '2025-06-30' });
  assert.equal(rPrior.contacts.length, 1);
  assert.equal(rPrior.contacts[0].totalPaidCents, 22000);
});

test('tax: recentFyEnds returns the last 3 ended financial years, most recent first', () => {
  const r = call('tax.recentFyEnds', { today: '2026-07-02' });
  assert.deepEqual(r, ['2026-06-30', '2025-06-30', '2024-06-30']);
});
