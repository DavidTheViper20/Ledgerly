'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });
const call = (m, a) => api.call(db, m, a);

function setup() {
  const c = call('contacts.save', { name: 'Acme Pty Ltd' });
  const sup = call('contacts.save', { name: 'Supplies Co' });
  const sales = db.prepare("SELECT * FROM accounts WHERE code='200'").get();
  const rent = db.prepare("SELECT * FROM accounts WHERE code='469'").get();
  const gstIn = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Income%'").get();
  const gstEx = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Expenses%'").get();
  const bank = call('bank.createAccount', { name: 'Cheque', code: '090' });
  return { c, sup, sales, rent, gstIn, gstEx, bank };
}

function mkInvoice(env, { cents = 100000, kind = 'ACCREC', tax = null, currency, rate, contact } = {}) {
  const inv = call('invoices.save', {
    kind, contactId: contact || (kind.startsWith('ACCREC') ? env.c.id : env.sup.id),
    issueDate: '2026-01-10', dueDate: '2026-01-24',
    taxMode: tax ? 'exclusive' : 'none', currency, exchangeRate: rate,
    lines: [{ description: 'Line', qty: 1, unitPriceCents: cents,
      accountId: kind.startsWith('ACCREC') ? env.sales.id : env.rent.id, taxRateId: tax }],
  });
  return call('invoices.approve', { id: inv.id });
}

// ---------- AU localisation ----------

test('AU defaults: GST rates, AUD, FY ends 30 June', () => {
  const s = call('settings.all');
  assert.equal(s.base_currency, 'AUD');
  assert.equal(s.fy_end_month, '6');
  assert.equal(s.tax_label, 'GST');
  const rates = call('taxRates.list');
  assert.ok(rates.find(r => r.name.includes('GST on Income') && r.rate === 10));
  const gstAcc = db.prepare("SELECT * FROM accounts WHERE system_key='TAX'").get();
  assert.equal(gstAcc.name, 'GST');
});

test('BAS summary: G1, 1A, 1B and net GST', () => {
  const env = setup();
  mkInvoice(env, { cents: 100000, tax: env.gstIn.id });            // sale 1000 + 100 GST
  const bill = mkInvoice(env, { kind: 'ACCPAY', cents: 40000, tax: env.gstEx.id }); // purchase 400 + 40 GST
  const bas = call('reports.bas', { from: '2026-01-01', to: '2026-03-31' });
  assert.equal(bas.g1_total_sales_cents, 110000);
  assert.equal(bas.a1a_gst_on_sales_cents, 10000);
  assert.equal(bas.a1b_gst_on_purchases_cents, 4000);
  assert.equal(bas.net_gst_cents, 6000);
});

// ---------- credit notes ----------

test('credit note: approve reverses revenue, allocate settles invoice', () => {
  const env = setup();
  const inv = mkInvoice(env, { cents: 100000, tax: env.gstIn.id }); // 1100 total
  const cn = call('invoices.save', {
    kind: 'ACCRECCREDIT', contactId: env.c.id, issueDate: '2026-01-15', dueDate: '2026-01-15',
    taxMode: 'exclusive',
    lines: [{ description: 'Returned goods', qty: 1, unitPriceCents: 30000, accountId: env.sales.id, taxRateId: env.gstIn.id }],
  });
  assert.match(cn.number, /^CN-/);
  call('invoices.approve', { id: cn.id });

  // Revenue should be net 700 after the credit
  const pl = call('reports.profitAndLoss', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pl.totals.revenue_cents, 70000);

  // Allocate the full credit (330.00) against the invoice
  call('credits.allocate', { creditId: cn.id, invoiceId: inv.id, amountCents: 33000, date: '2026-01-16' });
  const cn2 = call('invoices.get', { id: cn.id });
  const inv2 = call('invoices.get', { id: inv.id });
  assert.equal(cn2.status, 'PAID');           // fully applied
  assert.equal(inv2.paid_cents, 33000);
  assert.equal(inv2.status, 'AUTHORISED');

  // Pay the rest; invoice becomes PAID and AR clears
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2026-01-20', amountCents: 77000 });
  assert.equal(call('invoices.get', { id: inv.id }).status, 'PAID');
  const ar = db.prepare("SELECT id FROM accounts WHERE system_key='AR'").get();
  const bs = call('reports.balanceSheet', { asAt: '2026-12-31' });
  assert.equal(bs.totals.check_cents, 0);
  const arBal = call('reports.accountTransactions', { accountId: ar.id, from: '2026-01-01', to: '2026-12-31' });
  assert.equal(arBal.closing_cents, 0);
});

test('credit note: over-allocation rejected, refund works', () => {
  const env = setup();
  const inv = mkInvoice(env, { cents: 50000 });
  const cn = call('invoices.save', {
    kind: 'ACCRECCREDIT', contactId: env.c.id, issueDate: '2026-01-15', dueDate: '2026-01-15', taxMode: 'none',
    lines: [{ description: 'Credit', qty: 1, unitPriceCents: 80000, accountId: env.sales.id }],
  });
  call('invoices.approve', { id: cn.id });
  assert.throws(() => call('credits.allocate', { creditId: cn.id, invoiceId: inv.id, amountCents: 60000, date: '2026-01-16' }),
    /exceeds amount due/);
  call('credits.allocate', { creditId: cn.id, invoiceId: inv.id, amountCents: 50000, date: '2026-01-16' });
  assert.equal(call('invoices.get', { id: inv.id }).status, 'PAID');
  // Refund remaining 300 in cash
  call('payments.add', { invoiceId: cn.id, bankAccountId: env.bank.id, date: '2026-01-17', amountCents: 30000 });
  const cn2 = call('invoices.get', { id: cn.id });
  assert.equal(cn2.status, 'PAID');
  // Bank went down by the refund
  const banks = call('bank.accounts');
  assert.equal(banks[0].balance_cents, -30000);
});

// ---------- multi-currency ----------

test('multi-currency: invoice posts at doc rate, payment FX gain/loss', () => {
  const env = setup();
  // USD 1,000 invoice at 1.50 AUD/USD => AR 1,500 AUD
  const inv = mkInvoice(env, { cents: 100000, currency: 'USD', rate: 1.5 });
  assert.equal(inv.currency, 'USD');
  assert.equal(inv.base_total_cents, 150000);
  const ar = db.prepare("SELECT id FROM accounts WHERE system_key='AR'").get();
  assert.equal(call('reports.accountTransactions', { accountId: ar.id, from: '2026-01-01', to: '2026-12-31' }).closing_cents, 150000);

  // Paid in full when rate is 1.60 => bank 1,600, FX gain 100
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2026-02-01', amountCents: 100000, exchangeRate: 1.6 });
  const banks = call('bank.accounts');
  assert.equal(banks[0].balance_cents, 160000);
  assert.equal(call('reports.accountTransactions', { accountId: ar.id, from: '2026-01-01', to: '2026-12-31' }).closing_cents, 0);
  const fx = db.prepare("SELECT id FROM accounts WHERE system_key='FX'").get();
  const fxBal = call('reports.accountTransactions', { accountId: fx.id, from: '2026-01-01', to: '2026-12-31' });
  assert.equal(fxBal.closing_cents, -10000); // credit balance = gain
  const bs = call('reports.balanceSheet', { asAt: '2026-12-31' });
  assert.equal(bs.totals.check_cents, 0);
});

test('multi-currency: partial payments settle AR exactly', () => {
  const env = setup();
  const inv = mkInvoice(env, { cents: 100033, currency: 'EUR', rate: 1.6321 });
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2026-02-01', amountCents: 30000, exchangeRate: 1.7 });
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2026-03-01', amountCents: 70033, exchangeRate: 1.55 });
  assert.equal(call('invoices.get', { id: inv.id }).status, 'PAID');
  const ar = db.prepare("SELECT id FROM accounts WHERE system_key='AR'").get();
  assert.equal(call('reports.accountTransactions', { accountId: ar.id, from: '2026-01-01', to: '2026-12-31' }).closing_cents, 0);
  const tb = call('reports.trialBalance', { asAt: '2026-12-31' });
  assert.equal(tb.totals.debit_cents, tb.totals.credit_cents);
});

// ---------- purchase orders ----------

test('purchase order: lifecycle and conversion to bill', () => {
  const env = setup();
  const po = call('pos.save', {
    contactId: env.sup.id, issueDate: '2026-02-01', taxMode: 'exclusive',
    lines: [{ description: 'Paper', qty: 10, unitPriceCents: 1200, accountId: env.rent.id, taxRateId: env.gstEx.id }],
  });
  assert.match(po.number, /^PO-/);
  assert.equal(po.total_cents, 13200);
  call('pos.setStatus', { id: po.id, status: 'APPROVED' });
  const bill = call('pos.toBill', { id: po.id });
  assert.equal(bill.kind, 'ACCPAY');
  assert.equal(bill.total_cents, 13200);
  assert.equal(call('pos.get', { id: po.id }).status, 'BILLED');
  assert.throws(() => call('pos.toBill', { id: po.id }), /Already billed/);
});

// ---------- repeating invoices ----------

test('repeating invoices: generates due documents and advances schedule', () => {
  const env = setup();
  call('repeating.save', {
    kind: 'ACCREC', contactId: env.c.id, reference: 'Monthly retainer', taxMode: 'none',
    scheduleEvery: 1, scheduleUnit: 'MONTH', nextDate: '2026-01-01', dueDays: 7, autoApprove: true,
    lines: [{ description: 'Retainer', qty: 1, unitPriceCents: 50000, accountId: env.sales.id }],
  });
  const r = call('repeating.generateDue', { asOf: '2026-03-15' });
  assert.equal(r.created, 3); // Jan, Feb, Mar
  const invs = call('invoices.list', { kind: 'ACCREC', status: 'AUTHORISED' });
  assert.equal(invs.length, 3);
  const t = call('repeating.list')[0];
  assert.equal(t.next_date, '2026-04-01');
  // Re-run is idempotent
  assert.equal(call('repeating.generateDue', { asOf: '2026-03-15' }).created, 0);
});

// ---------- expense claims ----------

test('expense claim: approve posts GST and liability, pay clears it', () => {
  const env = setup();
  const claim = call('claims.save', {
    payee: 'David', date: '2026-02-10',
    lines: [
      { description: 'Parking', grossCents: 2200, accountId: env.rent.id, taxRateId: env.gstEx.id },
      { description: 'Stationery', grossCents: 5500, accountId: env.rent.id, taxRateId: env.gstEx.id },
    ],
  });
  assert.match(claim.number, /^EXP-/);
  assert.equal(claim.total_cents, 7700);
  assert.equal(claim.tax_cents, 700); // GST portion of inclusive amounts
  call('claims.setStatus', { id: claim.id, status: 'SUBMITTED' });
  call('claims.approve', { id: claim.id });
  const reimb = db.prepare("SELECT id FROM accounts WHERE system_key='REIMB'").get();
  assert.equal(call('reports.accountTransactions', { accountId: reimb.id, from: '2026-01-01', to: '2026-12-31' }).closing_cents, -7700);
  call('claims.pay', { id: claim.id, bankAccountId: env.bank.id, date: '2026-02-15' });
  assert.equal(call('claims.get', { id: claim.id }).status, 'PAID');
  assert.equal(call('reports.accountTransactions', { accountId: reimb.id, from: '2026-01-01', to: '2026-12-31' }).closing_cents, 0);
  const banks = call('bank.accounts');
  assert.equal(banks[0].balance_cents, -7700);
});

// ---------- fixed assets ----------

test('fixed assets: straight-line depreciation and disposal', () => {
  const env = setup();
  const assetAcc = db.prepare("SELECT * FROM accounts WHERE code='720'").get();
  const accumAcc = db.prepare("SELECT * FROM accounts WHERE code='721'").get();
  const depExp = db.prepare("SELECT * FROM accounts WHERE code='416'").get();
  const a = call('assets.save', {
    name: 'MacBook Pro', purchaseDate: '2026-01-01', costCents: 360000, residualCents: 0, lifeYears: 3,
    assetAccountId: assetAcc.id, accumAccountId: accumAcc.id, expenseAccountId: depExp.id,
  });
  call('assets.register', { id: a.id });
  const run = call('assets.runDepreciation', { toPeriod: '2026-06' });
  assert.equal(run.posted, 6); // Jan..Jun
  const a2 = call('assets.get', { id: a.id });
  assert.equal(a2.accumulated_cents, 60000); // 10000/month * 6
  assert.equal(a2.book_value_cents, 300000);
  // Idempotent month guard
  assert.equal(call('assets.runDepreciation', { toPeriod: '2026-06' }).posted, 0);

  // Sell for 3,200 => gain 200
  call('assets.dispose', { id: a.id, date: '2026-07-01', proceedsCents: 320000, bankAccountId: env.bank.id });
  const a3 = call('assets.get', { id: a.id });
  assert.equal(a3.status, 'DISPOSED');
  const disp = db.prepare("SELECT id FROM accounts WHERE system_key='DISPOSAL'").get();
  assert.equal(call('reports.accountTransactions', { accountId: disp.id, from: '2026-01-01', to: '2026-12-31' }).closing_cents, -20000);
  const bs = call('reports.balanceSheet', { asAt: '2026-12-31' });
  assert.equal(bs.totals.check_cents, 0);
});

// ---------- projects ----------

test('projects: time tracking, invoicing unbilled time, profitability', () => {
  const env = setup();
  const p = call('projects.save', { name: 'Website rebuild', contactId: env.c.id, hourlyRateCents: 15000 });
  call('projects.saveTime', { projectId: p.id, date: '2026-03-01', hours: 4, description: 'Design' });
  call('projects.saveTime', { projectId: p.id, date: '2026-03-02', hours: 6, description: 'Build', rateCents: 18000 });
  let p2 = call('projects.get', { id: p.id });
  assert.equal(p2.unbilled_hours, 10);
  assert.equal(p2.unbilled_cents, 4 * 15000 + 6 * 18000);

  const inv = call('projects.invoiceTime', { projectId: p.id, salesAccountId: env.sales.id, taxRateId: env.gstIn.id });
  assert.equal(inv.subtotal_cents, 168000);
  call('invoices.approve', { id: inv.id });
  // A project cost via spend money
  call('bank.saveTransaction', {
    kind: 'SPEND', bankAccountId: env.bank.id, date: '2026-03-05', taxMode: 'none', reference: 'Stock photos',
    lines: [{ description: 'Photos', qty: 1, unitPriceCents: 20000, accountId: env.rent.id, projectId: p.id }],
  });
  p2 = call('projects.get', { id: p.id });
  assert.equal(p2.unbilled_hours, 0);
  assert.equal(p2.revenue_cents, 168000);
  assert.equal(p2.cost_cents, 20000);
  assert.equal(p2.profit_cents, 148000);
});

// ---------- payroll ----------

test('payroll: pay run calculates PAYG and super, posts and pays', () => {
  const env = setup();
  call('payroll.saveEmployee', { name: 'Jess Chen', payBasis: 'SALARY', payRateCents: 9000000 }); // $90k
  const fortnight = call('payroll.createRun', {
    periodStart: '2026-01-01', periodEnd: '2026-01-14', paymentDate: '2026-01-15',
  });
  const slip = fortnight.payslips[0];
  // Gross ≈ 90000 * 14/365.25 ≈ 3450.0
  assert.ok(Math.abs(slip.gross_cents - 345000) < 200, `gross ${slip.gross_cents}`);
  assert.ok(slip.tax_cents > 60000 && slip.tax_cents < 90000, `tax ${slip.tax_cents}`); // ~ $700+ PAYG
  assert.equal(slip.super_cents, Math.round(slip.gross_cents * 0.12));
  assert.equal(slip.net_cents, slip.gross_cents - slip.tax_cents);

  call('payroll.postRun', { id: fortnight.id });
  const run = call('payroll.getRun', { id: fortnight.id });
  assert.equal(run.status, 'POSTED');
  // Liabilities on the balance sheet
  const payg = db.prepare("SELECT id FROM accounts WHERE system_key='PAYG'").get();
  assert.equal(call('reports.accountTransactions', { accountId: payg.id, from: '2026-01-01', to: '2026-12-31' }).closing_cents, -run.totals.tax_cents);
  call('payroll.payWages', { id: fortnight.id, bankAccountId: env.bank.id });
  const banks = call('bank.accounts');
  assert.equal(banks[0].balance_cents, -run.totals.net_cents);
  const bs = call('reports.balanceSheet', { asAt: '2026-12-31' });
  assert.equal(bs.totals.check_cents, 0);
  // W1/W2 appear on the BAS
  const bas = call('reports.bas', { from: '2026-01-01', to: '2026-03-31' });
  assert.equal(bas.w1_gross_wages_cents, run.totals.gross_cents);
  assert.equal(bas.w2_payg_withheld_cents, run.totals.tax_cents);
});

test('payroll: hourly employee and payslip override', () => {
  setup();
  call('payroll.saveEmployee', { name: 'Sam', payBasis: 'HOURLY', payRateCents: 4500, hoursPerWeek: 20 });
  const run = call('payroll.createRun', { periodStart: '2026-01-05', periodEnd: '2026-01-11', paymentDate: '2026-01-12' });
  const slip = run.payslips[0];
  assert.equal(slip.gross_cents, 90000); // 20h * $45
  const updated = call('payroll.updatePayslip', { id: slip.id, grossCents: 100000, taxCents: 20000 });
  assert.equal(updated.payslips[0].net_cents, 80000);
  assert.throws(() => call('payroll.updatePayslip', { id: slip.id, taxCents: 999999 }), /Invalid payslip/);
});

// ---------- budgets & analytics ----------

test('budgets: budget vs actual variance', () => {
  const env = setup();
  mkInvoice(env, { cents: 100000 });
  call('budgets.set', { rows: [
    { accountId: env.sales.id, month: '2026-01', amountCents: 80000 },
    { accountId: env.sales.id, month: '2026-02', amountCents: 80000 },
  ] });
  const r = call('reports.budgetVsActual', { from: '2026-01-01', to: '2026-02-28' });
  const sales = r.rows.find(x => x.code === '200');
  assert.equal(sales.actual_cents, 100000);
  assert.equal(sales.budget_cents, 160000);
  assert.equal(sales.variance_cents, -60000);
});

test('analytics: cash flow forecast includes AR in and AP out', () => {
  const env = setup();
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: env.c.id, issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), taxMode: 'none',
    lines: [{ description: 'Soon', qty: 1, unitPriceCents: 50000, accountId: env.sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  const f = call('reports.cashFlowForecast', { weeks: 4 });
  const totalIn = f.weeks.reduce((s, w) => s + w.in_cents, 0);
  assert.equal(totalIn, 50000);
  assert.equal(f.weeks.at(-1).balance_cents, f.opening_cents + 50000);
});
