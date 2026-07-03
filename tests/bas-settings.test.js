'use strict';

// Pass D1 — GST/BAS settings model + statement label rendering.
// See docs/superpowers/plans/2026-07-03-xero-ia-product-plan.md §4.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });

const call = (m, a) => api.call(db, m, a);

function setupBasics() {
  const c = call('contacts.save', { name: 'Acme Pty Ltd', is_supplier: 1 });
  const sales = db.prepare("SELECT * FROM accounts WHERE code='200'").get();
  const expAcc = db.prepare("SELECT * FROM accounts WHERE code='412'").get(); // Consulting & Accounting (tax: purchases)
  const taxSales = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Income%'").get();
  const taxPurchases = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Expenses%'").get();
  const taxGstFreeIncome = db.prepare("SELECT * FROM tax_rates WHERE name = 'GST Free Income (0%)'").get();
  const taxBasExcluded = db.prepare("SELECT * FROM tax_rates WHERE name = 'BAS Excluded (0%)'").get();
  return { c, sales, expAcc, taxSales, taxPurchases, taxGstFreeIncome, taxBasExcluded };
}

function postSale(env, { cents, issueDate, taxRateId }) {
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: env.c.id, issueDate, dueDate: issueDate, taxMode: 'exclusive',
    lines: [{ description: 'Consulting', qty: 1, unitPriceCents: cents, accountId: env.sales.id, taxRateId: taxRateId || env.taxSales.id }],
  });
  return call('invoices.approve', { id: inv.id });
}

function postBill(env, { cents, issueDate, taxRateId }) {
  const bill = call('invoices.save', {
    kind: 'ACCPAY', contactId: env.c.id, issueDate, dueDate: issueDate, taxMode: 'exclusive',
    lines: [{ description: 'Contractor work', qty: 1, unitPriceCents: cents, accountId: env.expAcc.id, taxRateId: taxRateId || env.taxPurchases.id }],
  });
  return call('invoices.approve', { id: bill.id });
}

// ---------- default settings ----------

test('bas settings: defaults for all new settings', () => {
  const s = call('settings.all');
  assert.equal(s.bas_form_type, 'simpler');
  assert.equal(s.gst_period, 'quarterly');
  assert.equal(s.gst_method, 'accruals');
  assert.equal(s.payg_wh_period, 'quarterly');
  assert.equal(s.payg_it_method, 'none');
  assert.equal(s.payg_instalment_amount_cents, '0');
  assert.equal(s.payg_instalment_rate_pct, '0');
  assert.equal(s.obligation_ftc, '0');
  assert.equal(s.obligation_wet, '0');
  assert.equal(s.obligation_lct, '0');
  assert.equal(s.obligation_fbt, '0');
});

test('bas settings: gst_period falls back to bas_cycle when unset', () => {
  // Simulate a pre-D1 database: clear gst_period, set only bas_cycle, and
  // confirm statement generation follows bas_cycle (monthly stepping).
  db.prepare("DELETE FROM settings WHERE key = 'gst_period'").run();
  call('settings.update', { bas_cycle: 'monthly' });
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  const r = call('tax.statements', { today: '2025-11-05' });
  const periods = r.needsAttention.map(s => [s.periodStart, s.periodEnd]);
  assert.deepEqual(periods, [
    ['2025-08-01', '2025-08-31'],
    ['2025-09-01', '2025-09-30'],
    ['2025-10-01', '2025-10-31'],
  ]);
});

// ---------- Full BAS: G2/G3/G10/G11 ----------

test('bas settings: full form type surfaces G2/G3/G10/G11 with footnotes', () => {
  call('settings.update', { bas_form_type: 'full' });
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' }); // normal GST sale
  postSale(env, { cents: 20000, issueDate: '2025-08-12', taxRateId: env.taxGstFreeIncome.id }); // G3 line
  postSale(env, { cents: 5000, issueDate: '2025-08-13', taxRateId: env.taxBasExcluded.id }); // NOT G3 (BAS Excluded)
  postBill(env, { cents: 30000, issueDate: '2025-08-14' }); // G11 line

  const stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.formType, 'full');
  assert.equal(stmt.g2_export_sales_cents, 0);
  assert.equal(stmt.g3_gst_free_sales_cents, 20000);
  assert.equal(stmt.g10_capital_purchases_cents, 0);
  assert.equal(stmt.g11_non_capital_purchases_cents, 30000);
  assert.ok(stmt.footnotes.some(f => f.includes('G2')));
  assert.ok(stmt.footnotes.some(f => f.includes('G10')));
});

test('bas settings: simpler form type (default) does not include Full BAS labels', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  const stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.formType, 'simpler');
  assert.equal(stmt.g3_gst_free_sales_cents, undefined);
  assert.equal(stmt.g11_non_capital_purchases_cents, undefined);
});

// ---------- PAYG withholding period ----------

test('bas settings: payg_wh_period none removes W labels and W2 from net payable', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' }); // $100 GST (1A)

  const withW = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(withW.showWLabels, true);
  assert.equal(withW.netPayableCents, 10000); // 1A only here since no wages posted

  call('settings.update', { payg_wh_period: 'none' });
  const withoutW = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(withoutW.showWLabels, false);
  // basSummary()'s w1_gross_wages_cents field is still present (UI hides it) —
  // only netPayableCents math and the showWLabels flag change here.
  assert.equal(withoutW.w1_gross_wages_cents, 0);
  assert.equal(withoutW.netPayableCents, 10000); // unchanged here since w2 was already 0
});

test('bas settings: payg_wh_period none excludes W2 from net payable when W2 is nonzero', () => {
  // Build a minimal payroll posting so W2 (PAYG withheld) is nonzero, then
  // confirm toggling payg_wh_period to 'none' removes it from netPayableCents.
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' }); // 1A = 10000

  call('payroll.saveEmployee', {
    name: 'Jamie Worker', payBasis: 'SALARY', payRateCents: 9750000, hoursPerWeek: 38, superPct: 12,
  });
  const run = call('payroll.createRun', { periodStart: '2025-08-01', periodEnd: '2025-08-31', paymentDate: '2025-08-31' });
  call('payroll.postRun', { id: run.id });

  const before = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.ok(before.w2_payg_withheld_cents > 0, 'expected nonzero W2 from the posted pay run');
  assert.equal(before.netPayableCents, before.a1a_gst_on_sales_cents + before.w2_payg_withheld_cents - before.a1b_gst_on_purchases_cents);

  call('settings.update', { payg_wh_period: 'none' });
  const after = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(after.showWLabels, false);
  assert.equal(after.netPayableCents, after.a1a_gst_on_sales_cents - after.a1b_gst_on_purchases_cents);
});

// ---------- PAYG income tax ----------

test('bas settings: option1 sets 5A to the configured instalment amount', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  call('settings.update', { payg_it_method: 'option1', payg_instalment_amount_cents: '150000' });

  const stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.itMethod, 'option1');
  assert.equal(stmt.t7_instalment_amount_cents, 150000);
  assert.equal(stmt.a5a_payg_instalment_cents, 150000);
  assert.equal(stmt.netPayableCents, stmt.a1a_gst_on_sales_cents - stmt.a1b_gst_on_purchases_cents + stmt.w2_payg_withheld_cents + 150000);
});

test('bas settings: option2 sets 5A to (G1 - 1A) x rate, rounded', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' }); // G1 = 110000 (incl GST), 1A = 10000 -> T1 = 100000
  call('settings.update', { payg_it_method: 'option2', payg_instalment_rate_pct: '7.5' });

  const stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.itMethod, 'option2');
  assert.equal(stmt.t1_instalment_income_cents, 100000);
  assert.equal(stmt.t2_instalment_rate_pct, 7.5);
  assert.equal(stmt.a5a_payg_instalment_cents, Math.round(100000 * 0.075));
  assert.equal(stmt.netPayableCents, stmt.a1a_gst_on_sales_cents - stmt.a1b_gst_on_purchases_cents + stmt.w2_payg_withheld_cents + stmt.a5a_payg_instalment_cents);
});

test('bas settings: payg_it_method none has no T/5A labels', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  const stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.itMethod, 'none');
  assert.equal(stmt.a5a_payg_instalment_cents, undefined);
});

// ---------- Other obligations ----------

test('bas settings: obligation toggle surfaces its labels with a manual-entry footnote', () => {
  call('settings.update', { obligation_wet: '1', obligation_fbt: '1' });
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });

  const stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.obligations.length, 2);
  const wet = stmt.obligations.find(o => o.key === 'wet');
  assert.deepEqual(wet.labels.map(l => l.code), ['1C', '1D']);
  assert.equal(wet.labels[0].amountCents, 0);
  const fbt = stmt.obligations.find(o => o.key === 'fbt');
  assert.deepEqual(fbt.labels.map(l => l.code), ['F1']);
  assert.ok(stmt.footnotes.some(f => f.toLowerCase().includes('manual entry')));
});

test('bas settings: no obligations toggled means no obligations array entries', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  const stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.obligations, undefined);
});

// ---------- gst_method engine selection (Pass D2) ----------

test('bas settings: gst_method cash selects the payment-dated engine', () => {
  // Pass D2 wires the cash engine: with gst_method='cash', statement figures
  // are payment-dated. An unpaid invoice therefore contributes 0 to 1A on cash
  // basis, whereas the accruals default recognises it at issue date.
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' }); // approved, unpaid

  // Default (accruals): 1A recognised at issue date.
  const accrualsStmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(accrualsStmt.a1a_gst_on_sales_cents, 10000);
  assert.equal(accrualsStmt.basis, 'accruals');

  // Cash: nothing recognised until payment is received.
  call('settings.update', { gst_method: 'cash' });
  const cashStmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(cashStmt.a1a_gst_on_sales_cents, 0);
  assert.equal(cashStmt.basis, 'cash');
});

// ---------- Simpler BAS unchanged with default settings ----------

test('bas settings: simpler-BAS statements unchanged when settings are defaults', () => {
  const env = setupBasics();
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  const stmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(stmt.g1_total_sales_cents, 110000);
  assert.equal(stmt.a1a_gst_on_sales_cents, 10000);
  assert.equal(stmt.a1b_gst_on_purchases_cents, 0);
  assert.equal(stmt.w1_gross_wages_cents, 0);
  assert.equal(stmt.w2_payg_withheld_cents, 0);
  assert.equal(stmt.netPayableCents, 10000);
  assert.equal(stmt.formType, 'simpler');
  assert.equal(stmt.showWLabels, true);
  assert.equal(stmt.obligations, undefined);
});
