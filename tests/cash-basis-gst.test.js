'use strict';

// Pass D2 — cash-basis GST engine (cashBasSummary).
// See docs/superpowers/plans/2026-07-03-xero-ia-product-plan.md §4, stage D2.
//
// Cash-basis GST (ATO): GST on sales is attributed to the period payment is
// RECEIVED; GST credits on purchases to the period payment is MADE. These
// scenarios assert exact cents against payment-dated events, and guard that the
// accruals engine (basSummary) is byte-for-byte unchanged.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');
const { basSummary, cashBasSummary } = require('../src/services/reports');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });

const call = (m, a) => api.call(db, m, a);

// P1 = Jul-Sep 2025, P2 = Oct-Dec 2025, P3 = Jan-Mar 2026 (AU FY quarters).
const P1 = { from: '2025-07-01', to: '2025-09-30' };
const P2 = { from: '2025-10-01', to: '2025-12-31' };
const P3 = { from: '2026-01-01', to: '2026-03-31' };

function setupEnv() {
  const bank = call('bank.createAccount', { name: 'Operating', code: '090' });
  const c = call('contacts.save', { name: 'Acme Pty Ltd', is_customer: 1, is_supplier: 1 });
  const sales = db.prepare("SELECT * FROM accounts WHERE code='200'").get();
  const expAcc = db.prepare("SELECT * FROM accounts WHERE code='412'").get();
  const taxSales = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Income%'").get();
  const taxPurchases = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Expenses%'").get();
  return { bank, c, sales, expAcc, taxSales, taxPurchases };
}

// A $1000 + $100 GST invoice (total $1100), approved on `issueDate`.
function postSale(env, { cents = 100000, issueDate, taxRateId } = {}) {
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: env.c.id, issueDate, dueDate: issueDate, taxMode: 'exclusive',
    lines: [{ description: 'Consulting', qty: 1, unitPriceCents: cents, accountId: env.sales.id, taxRateId: taxRateId || env.taxSales.id }],
  });
  return call('invoices.approve', { id: inv.id });
}

function postBill(env, { cents = 50000, issueDate, taxRateId } = {}) {
  const bill = call('invoices.save', {
    kind: 'ACCPAY', contactId: env.c.id, issueDate, dueDate: issueDate, taxMode: 'exclusive',
    lines: [{ description: 'Contractor', qty: 1, unitPriceCents: cents, accountId: env.expAcc.id, taxRateId: taxRateId || env.taxPurchases.id }],
  });
  return call('invoices.approve', { id: bill.id });
}

// A credit note (ACCRECCREDIT), approved on issueDate.
function postCreditNote(env, { cents = 100000, issueDate, taxRateId } = {}) {
  const cn = call('invoices.save', {
    kind: 'ACCRECCREDIT', contactId: env.c.id, issueDate, dueDate: issueDate, taxMode: 'exclusive',
    lines: [{ description: 'Refund of consulting', qty: 1, unitPriceCents: cents, accountId: env.sales.id, taxRateId: taxRateId || env.taxSales.id }],
  });
  return call('invoices.approve', { id: cn.id });
}

const cash = (p) => cashBasSummary(db, p);
const accr = (p) => basSummary(db, p);

// ---------- scenario a: invoice issued P1, paid in full P2 ----------

test('cash a: invoice issued P1, paid in full P2 — 1A lands in the payment period', () => {
  const env = setupEnv();
  const inv = postSale(env, { issueDate: '2025-08-10' }); // P1
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2025-11-15', amountCents: 110000 }); // P2

  // Accruals: 1A in P1 (issue date), nothing in P2.
  assert.equal(accr(P1).a1a_gst_on_sales_cents, 10000);
  assert.equal(accr(P2).a1a_gst_on_sales_cents, 0);

  // Cash: nothing in P1, full 1A + G1 in P2.
  assert.equal(cash(P1).a1a_gst_on_sales_cents, 0);
  assert.equal(cash(P1).g1_total_sales_cents, 0);
  assert.equal(cash(P2).a1a_gst_on_sales_cents, 10000);
  assert.equal(cash(P2).g1_total_sales_cents, 110000);
});

// ---------- scenario b: 50% paid P2, remainder unpaid ----------

test('cash b: invoice paid 50% in P2 — pro-rata half, nothing in P3', () => {
  const env = setupEnv();
  const inv = postSale(env, { issueDate: '2025-08-10' });
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2025-11-15', amountCents: 55000 }); // half

  assert.equal(cash(P1).a1a_gst_on_sales_cents, 0);
  assert.equal(cash(P2).a1a_gst_on_sales_cents, 5000);   // 100 GST * 55000/110000
  assert.equal(cash(P2).g1_total_sales_cents, 55000);
  assert.equal(cash(P3).a1a_gst_on_sales_cents, 0);
  assert.equal(cash(P3).g1_total_sales_cents, 0);
});

// ---------- scenario c: bill paid P2 → 1B in P2 ----------

test('cash c: bill $550 inc $50 GST paid P2 — 1B lands in P2, nothing in P1', () => {
  const env = setupEnv();
  const bill = postBill(env, { cents: 50000, issueDate: '2025-08-01' }); // $500 + $50 GST
  call('payments.add', { invoiceId: bill.id, bankAccountId: env.bank.id, date: '2025-11-10', amountCents: 55000 });

  assert.equal(cash(P1).a1b_gst_on_purchases_cents, 0);
  assert.equal(cash(P2).a1b_gst_on_purchases_cents, 5000);
});

// ---------- scenario d: invoice settled by credit allocation, no cash ----------

test('cash d: invoice fully settled by credit-note allocation contributes zero across all periods', () => {
  const env = setupEnv();
  const inv = postSale(env, { issueDate: '2025-08-10' }); // $1100
  const cn = postCreditNote(env, { issueDate: '2025-08-11' }); // $1100 credit
  call('credits.allocate', { creditId: cn.id, invoiceId: inv.id, amountCents: 110000, date: '2025-08-12' });

  // No payment ever changes hands, so cash-basis 1A total across all periods is 0.
  const total = cash(P1).a1a_gst_on_sales_cents + cash(P2).a1a_gst_on_sales_cents + cash(P3).a1a_gst_on_sales_cents;
  assert.equal(total, 0);
  assert.equal(cash(P1).g1_total_sales_cents, 0);
});

// ---------- scenario e: receive money — consistency between engines ----------

test('cash e: receive-money $220 inc $20 GST in P1 — both engines report 1A=$20 in P1', () => {
  const env = setupEnv();
  call('bank.saveTransaction', {
    kind: 'RECEIVE', bankAccountId: env.bank.id, contactId: env.c.id, date: '2025-08-05', taxMode: 'inclusive',
    lines: [{ description: 'Cash sale', qty: 1, unitPriceCents: 22000, accountId: env.sales.id, taxRateId: env.taxSales.id }],
  });
  assert.equal(accr(P1).a1a_gst_on_sales_cents, 2000);
  assert.equal(cash(P1).a1a_gst_on_sales_cents, 2000);
  assert.equal(cash(P1).g1_total_sales_cents, 22000);
  assert.equal(cash(P2).a1a_gst_on_sales_cents, 0);
});

// ---------- scenario f: expense claim approved P1, paid P2 ----------

test('cash f: expense claim approved P1, paid P2 — 1B lands in P2 only', () => {
  const env = setupEnv();
  const claim = call('claims.save', {
    payee: 'Owner', date: '2025-08-15',
    lines: [{ description: 'Fuel', grossCents: 11000, accountId: env.expAcc.id, taxRateId: env.taxPurchases.id }],
  });
  call('claims.approve', { id: claim.id });
  call('claims.pay', { id: claim.id, bankAccountId: env.bank.id, date: '2025-11-20' }); // paid P2

  assert.equal(cash(P1).a1b_gst_on_purchases_cents, 0);
  assert.equal(cash(P2).a1b_gst_on_purchases_cents, 1000); // $110 inc = $10 GST
});

test('cash f2: unpaid expense claim contributes no 1B', () => {
  const env = setupEnv();
  const claim = call('claims.save', {
    payee: 'Owner', date: '2025-08-15',
    lines: [{ description: 'Fuel', grossCents: 11000, accountId: env.expAcc.id, taxRateId: env.taxPurchases.id }],
  });
  call('claims.approve', { id: claim.id }); // approved, not paid
  assert.equal(cash(P1).a1b_gst_on_purchases_cents, 0);
  assert.equal(cash(P2).a1b_gst_on_purchases_cents, 0);
});

// ---------- scenario g: customer refund reduces 1A in refund period ----------

test('cash g: customer refund (credit note refund payment in P2) reduces 1A by the refund GST', () => {
  const env = setupEnv();
  const inv = postSale(env, { issueDate: '2025-08-10' });
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2025-08-20', amountCents: 110000 }); // 1A +100 in P1

  const cn = postCreditNote(env, { cents: 20000, issueDate: '2025-11-01' }); // $220 credit note = $20 GST
  // Refund the credit note in cash (P2) — a payment against an ACCRECCREDIT.
  call('payments.add', { invoiceId: cn.id, bankAccountId: env.bank.id, date: '2025-11-15', amountCents: 22000 });

  assert.equal(cash(P1).a1a_gst_on_sales_cents, 10000);   // original receipt
  assert.equal(cash(P2).a1a_gst_on_sales_cents, -2000);   // refund reduces 1A
  assert.equal(cash(P2).g1_total_sales_cents, -22000);    // gross refund reduces G1
});

// ---------- scenario h: accruals output unchanged (regression guard) ----------

test('cash h: basSummary (accruals) numbers for scenarios a–c are unchanged from pre-D2', () => {
  const env = setupEnv();
  const inv = postSale(env, { issueDate: '2025-08-10' });     // a/b sale in P1
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2025-11-15', amountCents: 55000 });
  const bill = postBill(env, { cents: 50000, issueDate: '2025-08-01' }); // c bill in P1
  call('payments.add', { invoiceId: bill.id, bankAccountId: env.bank.id, date: '2025-11-10', amountCents: 55000 });

  // Accruals attributes to issue date (P1) regardless of when paid.
  const a = accr(P1);
  assert.equal(a.g1_total_sales_cents, 110000);
  assert.equal(a.a1a_gst_on_sales_cents, 10000);
  assert.equal(a.a1b_gst_on_purchases_cents, 5000);
  assert.equal(a.net_gst_cents, 5000);
  // P2 accruals: nothing (both docs issued in P1).
  const a2 = accr(P2);
  assert.equal(a2.a1a_gst_on_sales_cents, 0);
  assert.equal(a2.a1b_gst_on_purchases_cents, 0);
});

// ---------- scenario i: statement engine switch ----------

test('cash i: gst_method cash switches the statement engine; default stays accruals', () => {
  const env = setupEnv();
  const inv = postSale(env, { issueDate: '2025-08-10' }); // issued P1
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2025-11-15', amountCents: 110000 }); // paid P2

  // Default (accruals): 1A in P1, nothing in P2.
  let p1 = call('tax.statement', { from: P1.from, to: P1.to });
  let p2 = call('tax.statement', { from: P2.from, to: P2.to });
  assert.equal(p1.a1a_gst_on_sales_cents, 10000);
  assert.equal(p2.a1a_gst_on_sales_cents, 0);

  // Switch to cash: 1A moves to P2 (payment period).
  call('settings.update', { gst_method: 'cash' });
  p1 = call('tax.statement', { from: P1.from, to: P1.to });
  p2 = call('tax.statement', { from: P2.from, to: P2.to });
  assert.equal(p1.a1a_gst_on_sales_cents, 0);
  assert.equal(p2.a1a_gst_on_sales_cents, 10000);
  assert.equal(p2.basis, 'cash');
});
