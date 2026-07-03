'use strict';

// Pass D3 — monthly IAS (Instalment Activity Statement) generation.
// See docs/superpowers/plans/2026-07-03-xero-ia-product-plan.md §4, stage D3.
//
// A monthly PAYG withholder whose GST is reported quarterly must lodge an IAS
// (PAYG withholding only — W1/W2, no GST) for the FIRST TWO months of each GST
// quarter; the quarter's BAS then carries only the THIRD month's withholding
// while its GST labels still cover the whole quarter. Annual GST reporters get
// an IAS every month and the annual statement carries no W labels. Quarterly /
// 'none' withholding produce no IAS at all (regression-guarded here).

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

// Post a pay run whose payment date lands in `paymentDate`, so its PAYG withheld
// (W2) is attributed to that month. Returns the W2 amount for that pay run.
function postPayroll({ periodStart, periodEnd, paymentDate }) {
  // Salary chosen so a whole month of withholding is comfortably nonzero.
  if (!db.prepare("SELECT id FROM employees LIMIT 1").get()) {
    call('payroll.saveEmployee', {
      name: 'Jamie Worker', payBasis: 'SALARY', payRateCents: 9750000, hoursPerWeek: 38, superPct: 12,
    });
  }
  const run = call('payroll.createRun', { periodStart, periodEnd, paymentDate });
  call('payroll.postRun', { id: run.id });
  return run;
}

// The raw PAYG-withheld (W2) figure for a given [from,to] range. Read via an
// IAS statement so the split-adjusted BAS W-range never interferes — an IAS
// always reports withholding for exactly its own period.
function w2For(from, to) {
  return call('tax.statement', { from, to, type: 'IAS' }).w2_payg_withheld_cents;
}

// ---------- (a) monthly WH + quarterly GST: two IAS + one BAS per quarter ----------

test('ias (a): monthly WH + quarterly GST yields IAS(m1), IAS(m2) and a quarter BAS', () => {
  const env = setupBasics();
  call('settings.update', { payg_wh_period: 'monthly', gst_period: 'quarterly' });

  // Q1 FY26 = Jul, Aug, Sep 2025. Payroll in each month, GST sale in the quarter.
  postSale(env, { cents: 100000, issueDate: '2025-08-10' }); // $100 GST in the quarter
  postPayroll({ periodStart: '2025-07-01', periodEnd: '2025-07-31', paymentDate: '2025-07-31' });
  postPayroll({ periodStart: '2025-08-01', periodEnd: '2025-08-31', paymentDate: '2025-08-31' });
  postPayroll({ periodStart: '2025-09-01', periodEnd: '2025-09-30', paymentDate: '2025-09-30' });

  const w2M1 = w2For('2025-07-01', '2025-07-31');
  const w2M3 = w2For('2025-09-01', '2025-09-30');
  assert.ok(w2M1 > 0, 'expected nonzero W2 in month 1');
  assert.ok(w2M3 > 0, 'expected nonzero W2 in month 3');

  const r = call('tax.statements', { today: '2026-07-02' });

  // The finished Q1 produces IAS(Jul), IAS(Aug), and a BAS(Q1).
  const iasM1 = r.needsAttention.find(s => s.type === 'IAS' && s.periodStart === '2025-07-01');
  const iasM2 = r.needsAttention.find(s => s.type === 'IAS' && s.periodStart === '2025-08-01');
  const basQ1 = r.needsAttention.find(s => s.type === 'BAS' && s.periodStart === '2025-07-01' && s.periodEnd === '2025-09-30');
  assert.ok(iasM1, 'expected an IAS for July');
  assert.ok(iasM2, 'expected an IAS for August');
  assert.ok(basQ1, 'expected a BAS for Q1');
  // No IAS for month 3 — its withholding rides on the quarter BAS.
  assert.equal(r.needsAttention.some(s => s.type === 'IAS' && s.periodStart === '2025-09-01'), false);

  // IAS(m1) net payable = that month's W2 (PAYG withholding only, no GST).
  assert.equal(iasM1.netPayableCents, w2M1);

  // BAS W2 covers ONLY month 3; GST covers the whole quarter.
  const basStmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(basStmt.type, 'BAS');
  assert.equal(basStmt.w2_payg_withheld_cents, w2M3);
  assert.equal(basStmt.a1a_gst_on_sales_cents, 10000); // full-quarter GST
  // BAS net = 1A - 1B + month-3 W2.
  assert.equal(basStmt.netPayableCents, 10000 + w2M3);

  // IAS statement detail: W labels + net only, no GST labels.
  const iasStmt = call('tax.statement', { from: '2025-07-01', to: '2025-07-31', type: 'IAS' });
  assert.equal(iasStmt.type, 'IAS');
  assert.equal(iasStmt.w2_payg_withheld_cents, w2M1);
  assert.equal(iasStmt.netPayableCents, w2M1);
  assert.equal(iasStmt.a1a_gst_on_sales_cents, undefined);
  assert.equal(iasStmt.g1_total_sales_cents, undefined);
});

// ---------- (b) due dates ----------

test('ias (b): IAS due 21 days after month end; BAS due date unchanged', () => {
  const env = setupBasics();
  call('settings.update', { payg_wh_period: 'monthly', gst_period: 'quarterly' });
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  postPayroll({ periodStart: '2025-07-01', periodEnd: '2025-07-31', paymentDate: '2025-07-31' });
  postPayroll({ periodStart: '2025-08-01', periodEnd: '2025-08-31', paymentDate: '2025-08-31' });

  const r = call('tax.statements', { today: '2026-07-02' });
  const iasM1 = r.needsAttention.find(s => s.type === 'IAS' && s.periodStart === '2025-07-01');
  const iasM2 = r.needsAttention.find(s => s.type === 'IAS' && s.periodStart === '2025-08-01');
  const basQ1 = r.needsAttention.find(s => s.type === 'BAS' && s.periodEnd === '2025-09-30');
  assert.equal(iasM1.dueDate, '2025-08-21'); // 31 Jul + 21 days
  assert.equal(iasM2.dueDate, '2025-09-21'); // 31 Aug + 21 days
  assert.equal(basQ1.dueDate, '2025-10-28'); // Jul-Sep quarter, unchanged (+28 days)

  // The Oct-Dec quarter BAS keeps the 28 Feb rule.
  const rQ2 = call('tax.statements', { today: '2026-07-02' });
  const basQ2 = rQ2.needsAttention.find(s => s.type === 'BAS' && s.periodEnd === '2025-12-31');
  assert.equal(basQ2.dueDate, '2026-02-28');
});

// ---------- (c) monthly WH + monthly GST: no IAS ----------

test('ias (c): monthly WH + monthly GST produces zero IAS, monthly BAS W labels intact', () => {
  const env = setupBasics();
  call('settings.update', { payg_wh_period: 'monthly', gst_period: 'monthly' });
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  postPayroll({ periodStart: '2025-08-01', periodEnd: '2025-08-31', paymentDate: '2025-08-31' });

  const r = call('tax.statements', { today: '2025-11-05' });
  assert.equal(r.needsAttention.some(s => s.type === 'IAS'), false);
  // Every statement is a monthly BAS.
  assert.ok(r.needsAttention.every(s => s.type === 'BAS'));
  const aug = r.needsAttention.find(s => s.periodStart === '2025-08-01');
  const augStmt = call('tax.statement', { from: '2025-08-01', to: '2025-08-31' });
  assert.ok(augStmt.w2_payg_withheld_cents > 0);
  assert.equal(augStmt.type, 'BAS');
  assert.equal(aug.netPayableCents, augStmt.netPayableCents);
});

// ---------- (d) quarterly WH + quarterly GST: regression, no IAS ----------

test('ias (d): quarterly WH + quarterly GST is identical to pre-D3 (no IAS, full-quarter W2)', () => {
  const env = setupBasics();
  // Defaults are payg_wh_period='quarterly', gst_period='quarterly'.
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  postPayroll({ periodStart: '2025-07-01', periodEnd: '2025-07-31', paymentDate: '2025-07-31' });
  postPayroll({ periodStart: '2025-08-01', periodEnd: '2025-08-31', paymentDate: '2025-08-31' });
  postPayroll({ periodStart: '2025-09-01', periodEnd: '2025-09-30', paymentDate: '2025-09-30' });

  const r = call('tax.statements', { today: '2026-07-02' });
  assert.equal(r.needsAttention.some(s => s.type === 'IAS'), false);
  // Statement periods are exactly the four quarters, all BAS.
  const periods = r.needsAttention.map(s => [s.periodStart, s.periodEnd]);
  assert.deepEqual(periods, [
    ['2025-07-01', '2025-09-30'],
    ['2025-10-01', '2025-12-31'],
    ['2026-01-01', '2026-03-31'],
    ['2026-04-01', '2026-06-30'],
  ]);
  // BAS W2 covers the full quarter (all three pay runs).
  const basStmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  const fullQuarterW2 = w2For('2025-07-01', '2025-09-30');
  assert.equal(basStmt.w2_payg_withheld_cents, fullQuarterW2);
});

// ---------- (e) WH 'none': no W labels, no IAS ----------

test('ias (e): WH none produces no IAS and no W labels', () => {
  const env = setupBasics();
  call('settings.update', { payg_wh_period: 'none', gst_period: 'quarterly' });
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  postPayroll({ periodStart: '2025-08-01', periodEnd: '2025-08-31', paymentDate: '2025-08-31' });

  const r = call('tax.statements', { today: '2026-07-02' });
  assert.equal(r.needsAttention.some(s => s.type === 'IAS'), false);
  const basStmt = call('tax.statement', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(basStmt.showWLabels, false);
  // W2 excluded from net payable.
  assert.equal(basStmt.netPayableCents, basStmt.a1a_gst_on_sales_cents - basStmt.a1b_gst_on_purchases_cents);
});

// ---------- (f) monthly WH + annual GST: 12 IAS, annual has no W labels ----------

test('ias (f): monthly WH + annual GST yields 12 IAS/FY, annual statement drops W labels', () => {
  const env = setupBasics();
  call('settings.update', { payg_wh_period: 'monthly', gst_period: 'annually' });
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  // Payroll every month of FY26 (Jul 2025 - Jun 2026).
  const months = [
    ['2025-07-01', '2025-07-31'], ['2025-08-01', '2025-08-31'], ['2025-09-01', '2025-09-30'],
    ['2025-10-01', '2025-10-31'], ['2025-11-01', '2025-11-30'], ['2025-12-01', '2025-12-31'],
    ['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-31'],
    ['2026-04-01', '2026-04-30'], ['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-06-30'],
  ];
  for (const [s, e] of months) postPayroll({ periodStart: s, periodEnd: e, paymentDate: e });

  // today after FY26 ends so the whole FY is finished.
  const r = call('tax.statements', { today: '2026-08-15' });
  const iasFy26 = r.needsAttention.filter(s => s.type === 'IAS' && s.periodStart >= '2025-07-01' && s.periodEnd <= '2026-06-30');
  assert.equal(iasFy26.length, 12);

  // The annual BAS drops W labels and excludes W2 from net.
  const annual = call('tax.statement', { from: '2025-07-01', to: '2026-06-30' });
  assert.equal(annual.type, 'BAS');
  assert.equal(annual.showWLabels, false);
  assert.equal(annual.netPayableCents, annual.a1a_gst_on_sales_cents - annual.a1b_gst_on_purchases_cents);

  // Each IAS net = that month's W2.
  const w2Jul = w2For('2025-07-01', '2025-07-31');
  const iasJul = iasFy26.find(s => s.periodStart === '2025-07-01');
  assert.equal(iasJul.netPayableCents, w2Jul);
});

// ---------- (g) lodgement lifecycle for IAS ----------

test('ias (g): markLodged snapshots type IAS, quarter BAS lodges separately, double-lodge rejected', () => {
  const env = setupBasics();
  call('settings.update', { payg_wh_period: 'monthly', gst_period: 'quarterly' });
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  postPayroll({ periodStart: '2025-07-01', periodEnd: '2025-07-31', paymentDate: '2025-07-31' });
  postPayroll({ periodStart: '2025-08-01', periodEnd: '2025-08-31', paymentDate: '2025-08-31' });
  postPayroll({ periodStart: '2025-09-01', periodEnd: '2025-09-30', paymentDate: '2025-09-30' });

  const w2M1 = w2For('2025-07-01', '2025-07-31');

  // Lodge the July IAS.
  const lodgedIas = call('tax.markLodged', { from: '2025-07-01', to: '2025-07-31', type: 'IAS' });
  const iasFigures = JSON.parse(lodgedIas.figures_json);
  assert.equal(iasFigures.type, 'IAS');
  assert.equal(iasFigures.w2_payg_withheld_cents, w2M1);
  assert.equal(lodgedIas.net_payable_cents, w2M1);

  // It appears in completed with type IAS.
  let r = call('tax.statements', { today: '2026-07-02' });
  const completedIas = r.completed.find(s => s.type === 'IAS' && s.periodStart === '2025-07-01');
  assert.ok(completedIas, 'lodged IAS should be in completed');
  assert.equal(r.needsAttention.some(s => s.type === 'IAS' && s.periodStart === '2025-07-01'), false);

  // The quarter BAS can still be lodged separately (different period).
  const lodgedBas = call('tax.markLodged', { from: '2025-07-01', to: '2025-09-30' });
  assert.equal(JSON.parse(lodgedBas.figures_json).type, 'BAS');
  r = call('tax.statements', { today: '2026-07-02' });
  assert.ok(r.completed.find(s => s.type === 'BAS' && s.periodEnd === '2025-09-30'));

  // Double-lodging the same IAS month is rejected.
  assert.throws(() => call('tax.markLodged', { from: '2025-07-01', to: '2025-07-31', type: 'IAS' }), /already been lodged/);
});

// ---------- (h) current-period behaviour ----------

test('ias (h): current period is the in-progress IAS month in monthly-WH+quarterly-GST mode', () => {
  const env = setupBasics();
  call('settings.update', { payg_wh_period: 'monthly', gst_period: 'quarterly' });
  postSale(env, { cents: 100000, issueDate: '2025-08-10' });
  // Pay run paid on the 10th so it's captured by an Aug-20 "figures so far" read.
  postPayroll({ periodStart: '2025-08-01', periodEnd: '2025-08-10', paymentDate: '2025-08-10' });

  // today falls in month 2 (August) of Q1.
  const r = call('tax.statements', { today: '2025-08-20' });
  assert.ok(r.current);
  // Current is the in-progress August IAS (month 2 of the quarter).
  assert.equal(r.current.type, 'IAS');
  assert.equal(r.current.periodStart, '2025-08-01');
  assert.equal(r.current.periodEnd, '2025-08-31');
  const w2Aug = w2For('2025-08-01', '2025-08-31');
  assert.equal(r.current.netPayableCents, w2Aug);
  // The quarter BAS is not yet in needsAttention (its period hasn't ended).
  assert.equal(r.needsAttention.some(s => s.type === 'BAS' && s.periodEnd === '2025-09-30'), false);
});
