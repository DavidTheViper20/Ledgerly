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
