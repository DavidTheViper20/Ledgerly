'use strict';

// Simplified Australian payroll: employees, pay runs, PAYG withholding
// estimate, superannuation guarantee. Posting:
//   DR Salaries & Wages (gross)   DR Superannuation expense
//   CR PAYG Withholding Payable   CR Superannuation Payable   CR Wages Payable (net)
// Note: this estimates PAYG using the 2025-26 resident tax brackets plus the
// 2% Medicare levy, ignoring offsets/HELP. Amounts are editable per payslip.
// Single Touch Payroll lodgement requires ATO-certified software and is out
// of scope — export the payroll reports for your agent instead.

const { round } = require('../money');
const { getSetting, systemAccount } = require('../db');
const { postJournal, voidJournal } = require('./ledger');

// 2025-26 resident income tax brackets (annual, cents thresholds in dollars).
const BRACKETS = [
  { upTo: 18200, rate: 0 },
  { upTo: 45000, rate: 0.16 },
  { upTo: 135000, rate: 0.30 },
  { upTo: 190000, rate: 0.37 },
  { upTo: Infinity, rate: 0.45 },
];
const MEDICARE = 0.02;

function annualTaxCents(annualGrossCents) {
  const g = annualGrossCents / 100;
  let tax = 0, prev = 0;
  for (const b of BRACKETS) {
    if (g > prev) tax += (Math.min(g, b.upTo) - prev) * b.rate;
    prev = b.upTo;
  }
  if (g > 26000) tax += g * MEDICARE; // simplified levy threshold
  return round(tax * 100);
}

function estimatePaygCents(grossCents, periodDays) {
  if (grossCents <= 0 || periodDays <= 0) return 0;
  const annual = grossCents * (365.25 / periodDays);
  return Math.max(0, round(annualTaxCents(annual) * (periodDays / 365.25)));
}

// ---------- employees ----------

function saveEmployee(db, d) {
  if (!d.name) throw new Error('Employee name is required');
  const basis = d.payBasis === 'HOURLY' ? 'HOURLY' : 'SALARY';
  const superPct = d.superPct != null && d.superPct !== ''
    ? Number(d.superPct)
    : Number(getSetting(db, 'super_guarantee_pct') || '12');
  const cols = [d.name, d.email || '', basis, Math.round(Number(d.payRateCents) || 0),
    Number(d.hoursPerWeek) || 38, superPct];
  if (d.id) {
    db.prepare('UPDATE employees SET name=?, email=?, pay_basis=?, pay_rate_cents=?, hours_per_week=?, super_pct=? WHERE id=?')
      .run(...cols, d.id);
    return db.prepare('SELECT * FROM employees WHERE id=?').get(d.id);
  }
  const r = db.prepare(`INSERT INTO employees (name, email, pay_basis, pay_rate_cents, hours_per_week, super_pct)
    VALUES (?,?,?,?,?,?)`).run(...cols);
  return db.prepare('SELECT * FROM employees WHERE id=?').get(Number(r.lastInsertRowid));
}

function listEmployees(db, { includeArchived = false } = {}) {
  return db.prepare(`SELECT * FROM employees ${includeArchived ? '' : 'WHERE is_archived = 0'} ORDER BY name`).all();
}

function archiveEmployee(db, id) {
  db.prepare('UPDATE employees SET is_archived = 1 WHERE id = ?').run(id);
  return { ok: true };
}

// ---------- pay runs ----------

function periodDays(start, end) {
  return Math.round((new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z')) / 864e5) + 1;
}

// Creates a draft pay run with calculated payslips for all active employees.
function createPayRun(db, { periodStart, periodEnd, paymentDate }) {
  if (!periodStart || !periodEnd || !paymentDate) throw new Error('Period and payment dates are required');
  if (periodEnd < periodStart) throw new Error('Period end must be after period start');
  const employees = listEmployees(db);
  if (!employees.length) throw new Error('Add employees first');
  const days = periodDays(periodStart, periodEnd);
  const r = db.prepare(`INSERT INTO pay_runs (period_start, period_end, payment_date) VALUES (?,?,?)`)
    .run(periodStart, periodEnd, paymentDate);
  const runId = Number(r.lastInsertRowid);
  const ins = db.prepare(`INSERT INTO payslips (pay_run_id, employee_id, gross_cents, tax_cents, super_cents, net_cents, hours)
    VALUES (?,?,?,?,?,?,?)`);
  for (const e of employees) {
    let gross, hours = null;
    if (e.pay_basis === 'SALARY') {
      gross = round(e.pay_rate_cents * (days / 365.25));
    } else {
      hours = e.hours_per_week * (days / 7);
      gross = round(e.pay_rate_cents * hours);
    }
    const tax = estimatePaygCents(gross, days);
    const sup = round(gross * e.super_pct / 100);
    ins.run(runId, e.id, gross, tax, sup, gross - tax, hours);
  }
  return getPayRun(db, runId);
}

function getPayRun(db, id) {
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(id);
  if (!run) throw new Error('Pay run not found');
  run.payslips = db.prepare(`SELECT ps.*, e.name AS employee_name FROM payslips ps
    JOIN employees e ON e.id = ps.employee_id WHERE ps.pay_run_id = ? ORDER BY e.name`).all(id);
  run.totals = run.payslips.reduce((t, p) => ({
    gross_cents: t.gross_cents + p.gross_cents, tax_cents: t.tax_cents + p.tax_cents,
    super_cents: t.super_cents + p.super_cents, net_cents: t.net_cents + p.net_cents,
  }), { gross_cents: 0, tax_cents: 0, super_cents: 0, net_cents: 0 });
  return run;
}

function listPayRuns(db) {
  return db.prepare('SELECT * FROM pay_runs ORDER BY period_end DESC, id DESC').all()
    .map(r => getPayRun(db, r.id));
}

// Adjust a payslip in a draft run (gross/tax/super override).
function updatePayslip(db, { id, grossCents, taxCents, superCents }) {
  const ps = db.prepare('SELECT * FROM payslips WHERE id = ?').get(id);
  if (!ps) throw new Error('Payslip not found');
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(ps.pay_run_id);
  if (run.status !== 'DRAFT') throw new Error('Pay run is already posted');
  const gross = grossCents != null ? Math.round(grossCents) : ps.gross_cents;
  const tax = taxCents != null ? Math.round(taxCents) : ps.tax_cents;
  const sup = superCents != null ? Math.round(superCents) : ps.super_cents;
  if (gross < 0 || tax < 0 || sup < 0 || tax > gross) throw new Error('Invalid payslip amounts');
  db.prepare('UPDATE payslips SET gross_cents=?, tax_cents=?, super_cents=?, net_cents=? WHERE id=?')
    .run(gross, tax, sup, gross - tax, id);
  return getPayRun(db, ps.pay_run_id);
}

function postPayRun(db, id) {
  const run = getPayRun(db, id);
  if (run.status !== 'DRAFT') throw new Error('Pay run is already posted');
  const t = run.totals;
  if (t.gross_cents <= 0) throw new Error('Pay run has no pay');
  const wagesExp = systemAccount(db, 'WAGES_EXP');
  const superExp = systemAccount(db, 'SUPER_EXP');
  const payg = systemAccount(db, 'PAYG');
  const superPay = systemAccount(db, 'SUPER_PAY');
  const wagesPay = systemAccount(db, 'WAGES_PAY');
  const lines = [
    { accountId: wagesExp.id, description: 'Gross wages', debitCents: t.gross_cents },
  ];
  if (t.super_cents) lines.push({ accountId: superExp.id, description: 'Superannuation guarantee', debitCents: t.super_cents });
  if (t.tax_cents) lines.push({ accountId: payg.id, description: 'PAYG withheld', creditCents: t.tax_cents });
  if (t.super_cents) lines.push({ accountId: superPay.id, description: 'Super payable', creditCents: t.super_cents });
  lines.push({ accountId: wagesPay.id, description: 'Net wages payable', creditCents: t.net_cents });
  const journalId = postJournal(db, {
    date: run.payment_date, narration: `Pay run ${run.period_start} – ${run.period_end}`,
    sourceKind: 'pay_run', sourceId: id, lines,
  });
  db.prepare("UPDATE pay_runs SET status='POSTED', journal_id=? WHERE id=?").run(journalId, id);
  return getPayRun(db, id);
}

// Pays the net wages from a bank account (clears Wages Payable).
function payWages(db, { id, bankAccountId, date }) {
  const run = getPayRun(db, id);
  if (run.status !== 'POSTED') throw new Error('Post the pay run first');
  if (run.paid_journal_id) throw new Error('Wages already paid for this run');
  const wagesPay = systemAccount(db, 'WAGES_PAY');
  const journalId = postJournal(db, {
    date: date || run.payment_date, narration: `Wages payment ${run.period_start} – ${run.period_end}`,
    sourceKind: 'pay_run', sourceId: id,
    lines: [
      { accountId: wagesPay.id, description: 'Net wages', debitCents: run.totals.net_cents },
      { accountId: bankAccountId, description: 'Net wages', creditCents: run.totals.net_cents },
    ],
  });
  db.prepare('UPDATE pay_runs SET paid_journal_id=? WHERE id=?').run(journalId, id);
  return getPayRun(db, id);
}

function deletePayRun(db, id) {
  const run = getPayRun(db, id);
  if (run.status === 'POSTED') {
    if (run.paid_journal_id) throw new Error('Wages have been paid — void those entries first');
    voidJournal(db, run.journal_id);
  }
  db.prepare('DELETE FROM payslips WHERE pay_run_id=?').run(id);
  db.prepare('DELETE FROM pay_runs WHERE id=?').run(id);
  return { ok: true };
}

module.exports = {
  saveEmployee, listEmployees, archiveEmployee, createPayRun, getPayRun, listPayRuns,
  updatePayslip, postPayRun, payWages, deletePayRun, estimatePaygCents,
};
