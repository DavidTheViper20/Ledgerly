'use strict';

const { ACCOUNT_TYPES, TYPE_LABELS } = require('../coa');
const { allBalances } = require('./ledger');
const { getSetting, systemAccount } = require('../db');

function accounts(db) {
  return db.prepare('SELECT * FROM accounts ORDER BY code').all();
}

// Financial year start for a date, based on settings fy_end_day/month.
function fyStart(db, asAt) {
  const endD = parseInt(getSetting(db, 'fy_end_day') || '31', 10);
  const endM = parseInt(getSetting(db, 'fy_end_month') || '12', 10);
  const d = new Date(asAt + 'T00:00:00Z');
  // FY ends on endM/endD; FY start is the day after, in the appropriate year.
  let fyEnd = new Date(Date.UTC(d.getUTCFullYear(), endM - 1, endD));
  if (d > fyEnd) fyEnd = new Date(Date.UTC(d.getUTCFullYear() + 1, endM - 1, endD));
  const start = new Date(fyEnd);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString().slice(0, 10);
}

// ---------- Profit & Loss ----------
// Sections: Revenue (REVENUE+OTHER_INCOME), Direct Costs, Expenses (EXPENSE+OTHER_EXPENSE+DEPRECIATION)
function profitAndLoss(db, { from, to }) {
  const bals = allBalances(db, { from, to });
  const rows = { revenue: [], directCosts: [], expenses: [] };
  let revenue = 0, direct = 0, expenses = 0;
  for (const a of accounts(db)) {
    const bal = bals[a.id] || 0;
    if (!bal) continue;
    const cls = ACCOUNT_TYPES[a.type];
    if (cls === 'REVENUE') {
      const amt = -bal; // revenue is credit-normal
      rows.revenue.push({ code: a.code, name: a.name, amount_cents: amt });
      revenue += amt;
    } else if (a.type === 'DIRECT_COSTS') {
      rows.directCosts.push({ code: a.code, name: a.name, amount_cents: bal });
      direct += bal;
    } else if (cls === 'EXPENSE') {
      rows.expenses.push({ code: a.code, name: a.name, amount_cents: bal });
      expenses += bal;
    }
  }
  return {
    from, to, rows,
    totals: {
      revenue_cents: revenue,
      direct_costs_cents: direct,
      gross_profit_cents: revenue - direct,
      expenses_cents: expenses,
      net_profit_cents: revenue - direct - expenses,
    },
  };
}

// ---------- Balance Sheet ----------
function balanceSheet(db, { asAt }) {
  const start = fyStart(db, asAt);
  const balsAll = allBalances(db, { to: asAt });
  const balsCurrentFY = allBalances(db, { from: start, to: asAt });

  const sections = { assets: [], liabilities: [], equity: [] };
  let assets = 0, liabilities = 0, equity = 0;
  let priorEarnings = 0, currentEarnings = 0;

  const accs = accounts(db);
  const retained = accs.find(a => a.system_key === 'RETAINED');

  for (const a of accs) {
    const cls = ACCOUNT_TYPES[a.type];
    const bal = balsAll[a.id] || 0;
    if (cls === 'REVENUE' || cls === 'EXPENSE') {
      // P&L accounts roll into earnings
      const cur = balsCurrentFY[a.id] || 0;
      currentEarnings += -cur; // profit = credit-normal
      priorEarnings += -(bal - cur);
      continue;
    }
    if (!bal) continue;
    if (cls === 'ASSET') {
      const grp = TYPE_LABELS[a.type];
      sections.assets.push({ code: a.code, name: a.name, group: grp, amount_cents: bal });
      assets += bal;
    } else if (cls === 'LIABILITY') {
      sections.liabilities.push({ code: a.code, name: a.name, group: TYPE_LABELS[a.type], amount_cents: -bal });
      liabilities += -bal;
    } else if (cls === 'EQUITY') {
      const amt = -bal;
      sections.equity.push({ code: a.code, name: a.name, group: 'Equity', amount_cents: amt });
      equity += amt;
    }
  }
  if (priorEarnings !== 0) {
    sections.equity.push({ code: retained ? retained.code : '960', name: 'Retained Earnings (prior years)', group: 'Equity', amount_cents: priorEarnings });
    equity += priorEarnings;
  }
  if (currentEarnings !== 0) {
    sections.equity.push({ code: '', name: 'Current Year Earnings', group: 'Equity', amount_cents: currentEarnings });
    equity += currentEarnings;
  }
  return {
    asAt, sections,
    totals: {
      assets_cents: assets,
      liabilities_cents: liabilities,
      equity_cents: equity,
      check_cents: assets - liabilities - equity, // should be 0
    },
  };
}

// ---------- Trial Balance ----------
function trialBalance(db, { asAt }) {
  const start = fyStart(db, asAt);
  const balsAll = allBalances(db, { to: asAt });
  const balsFY = allBalances(db, { from: start, to: asAt });
  const rows = [];
  let dr = 0, cr = 0;
  for (const a of accounts(db)) {
    const cls = ACCOUNT_TYPES[a.type];
    // P&L accounts show YTD movement; balance accounts show cumulative balance.
    const bal = (cls === 'REVENUE' || cls === 'EXPENSE') ? (balsFY[a.id] || 0) : (balsAll[a.id] || 0);
    if (!bal) continue;
    const row = { code: a.code, name: a.name, type: TYPE_LABELS[a.type], debit_cents: 0, credit_cents: 0 };
    if (bal > 0) { row.debit_cents = bal; dr += bal; } else { row.credit_cents = -bal; cr += -bal; }
    rows.push(row);
  }
  // Prior-year earnings not yet in retained earnings appear as one line so the TB balances.
  let prior = 0;
  for (const a of accounts(db)) {
    const cls = ACCOUNT_TYPES[a.type];
    if (cls === 'REVENUE' || cls === 'EXPENSE') prior += (balsAll[a.id] || 0) - (balsFY[a.id] || 0);
  }
  if (prior !== 0) {
    const row = { code: '', name: 'Retained Earnings (prior years)', type: 'Equity', debit_cents: 0, credit_cents: 0 };
    if (prior > 0) { row.debit_cents = prior; dr += prior; } else { row.credit_cents = -prior; cr += -prior; }
    rows.push(row);
  }
  return { asAt, rows, totals: { debit_cents: dr, credit_cents: cr } };
}

// ---------- Aged Receivables / Payables ----------
function agedDocuments(db, { kind, asAt }) {
  const docs = db.prepare(`SELECT i.*, c.name AS contact_name FROM invoices i
    JOIN contacts c ON c.id = i.contact_id
    WHERE i.kind = ? AND i.status = 'AUTHORISED' AND i.issue_date <= ?
    ORDER BY c.name, i.due_date`).all(kind, asAt);
  const buckets = { current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b90_plus: 0 };
  const byContact = new Map();
  const ref = new Date(asAt + 'T00:00:00Z');
  for (const d of docs) {
    const due = new Date(d.due_date + 'T00:00:00Z');
    const daysOver = Math.floor((ref - due) / 864e5);
    // Foreign-currency documents are shown at their document exchange rate.
    const owing = Math.round((d.total_cents - d.paid_cents) * (d.exchange_rate || 1));
    let bucket = 'current';
    if (daysOver > 90) bucket = 'b90_plus';
    else if (daysOver > 60) bucket = 'b61_90';
    else if (daysOver > 30) bucket = 'b31_60';
    else if (daysOver > 0) bucket = 'b1_30';
    buckets[bucket] += owing;
    if (!byContact.has(d.contact_id)) {
      byContact.set(d.contact_id, {
        contact_id: d.contact_id, contact_name: d.contact_name,
        current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b90_plus: 0, total: 0, documents: [],
      });
    }
    const row = byContact.get(d.contact_id);
    row[bucket] += owing;
    row.total += owing;
    row.documents.push({
      id: d.id, number: d.number, reference: d.reference, issue_date: d.issue_date,
      due_date: d.due_date, owing_cents: owing, days_overdue: Math.max(0, daysOver), bucket,
    });
  }
  return {
    asAt, rows: [...byContact.values()],
    totals: { ...buckets, total: Object.values(buckets).reduce((s, v) => s + v, 0) },
  };
}

// ---------- Account Transactions ----------
function accountTransactions(db, { accountId, from, to }) {
  const lines = db.prepare(`SELECT jl.*, j.date, j.narration, j.source_kind, j.source_id
    FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
    WHERE j.status = 'POSTED' AND jl.account_id = ? AND j.date >= ? AND j.date <= ?
    ORDER BY j.date, j.id`).all(accountId, from, to);
  const opening = db.prepare(`SELECT COALESCE(SUM(jl.debit_cents - jl.credit_cents),0) AS bal
    FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
    WHERE j.status='POSTED' AND jl.account_id = ? AND j.date < ?`).get(accountId, from).bal;
  let running = opening;
  for (const l of lines) {
    running += l.debit_cents - l.credit_cents;
    l.running_cents = running;
  }
  return { accountId, from, to, opening_cents: opening, closing_cents: running, lines };
}

// ---------- Tax Summary ----------
function taxSummary(db, { from, to }) {
  const taxAcc = systemAccount(db, 'TAX');
  // Tax collected: credits to tax account from sales-side sources; tax paid: debits.
  const rows = db.prepare(`SELECT j.source_kind, SUM(jl.credit_cents) AS collected, SUM(jl.debit_cents) AS paid
    FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
    WHERE j.status='POSTED' AND jl.account_id = ? AND j.date >= ? AND j.date <= ?
    GROUP BY j.source_kind`).all(taxAcc.id, from, to);
  let collected = 0, paid = 0;
  for (const r of rows) { collected += r.collected || 0; paid += r.paid || 0; }
  return {
    from, to, rows,
    totals: { collected_cents: collected, paid_cents: paid, net_cents: collected - paid },
  };
}

// ---------- Cash Summary (per month money in/out across bank accounts) ----------
function cashSummary(db, { months = 6, to = null } = {}) {
  const end = to ? new Date(to + 'T00:00:00Z') : new Date();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const fromS = d.toISOString().slice(0, 10);
    const toS = new Date(next - 864e5).toISOString().slice(0, 10);
    const r = db.prepare(`SELECT COALESCE(SUM(jl.debit_cents),0) AS inflow, COALESCE(SUM(jl.credit_cents),0) AS outflow
      FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id
      WHERE j.status='POSTED' AND a.type='BANK' AND j.date >= ? AND j.date <= ?`).get(fromS, toS);
    out.push({ month: fromS.slice(0, 7), in_cents: r.inflow, out_cents: r.outflow });
  }
  return out;
}

// ---------- BAS (Business Activity Statement) summary — Simpler BAS ----------
// Estimates the GST and PAYG-withholding labels from posted journals.
function basSummary(db, { from, to }) {
  const taxAcc = systemAccount(db, 'TAX');
  const gst = db.prepare(`SELECT COALESCE(SUM(jl.credit_cents),0) AS collected, COALESCE(SUM(jl.debit_cents),0) AS paid
    FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
    WHERE j.status='POSTED' AND jl.account_id=? AND j.date>=? AND j.date<=?`).get(taxAcc.id, from, to);
  // G1 = gross sales (net revenue movement + GST collected)
  const revenue = db.prepare(`SELECT COALESCE(SUM(jl.credit_cents - jl.debit_cents),0) AS net
    FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id
    WHERE j.status='POSTED' AND a.type IN ('REVENUE','OTHER_INCOME') AND j.date>=? AND j.date<=?`).get(from, to);
  // W1/W2 from payroll control accounts (if used)
  let w1 = 0, w2 = 0;
  try {
    const wagesExp = systemAccount(db, 'WAGES_EXP');
    w1 = db.prepare(`SELECT COALESCE(SUM(jl.debit_cents - jl.credit_cents),0) AS s
      FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
      WHERE j.status='POSTED' AND jl.account_id=? AND j.date>=? AND j.date<=?`).get(wagesExp.id, from, to).s;
    const payg = systemAccount(db, 'PAYG');
    w2 = db.prepare(`SELECT COALESCE(SUM(jl.credit_cents - jl.debit_cents),0) AS s
      FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
      WHERE j.status='POSTED' AND jl.account_id=? AND j.date>=? AND j.date<=? AND j.source_kind='pay_run'`)
      .get(payg.id, from, to).s;
  } catch { /* payroll accounts not present in very old files */ }
  return {
    from, to,
    g1_total_sales_cents: revenue.net + gst.collected,
    a1a_gst_on_sales_cents: gst.collected,
    a1b_gst_on_purchases_cents: gst.paid,
    w1_gross_wages_cents: w1,
    w2_payg_withheld_cents: w2,
    net_gst_cents: gst.collected - gst.paid,
    total_obligation_cents: gst.collected - gst.paid + w2,
  };
}

// ---------- short-term cash flow forecast ----------
// Opening bank balance, then weekly buckets of AR due in / AP due out.
function cashFlowForecast(db, { weeks = 8 } = {}) {
  const opening = db.prepare(`SELECT COALESCE(SUM(jl.debit_cents - jl.credit_cents),0) AS s
    FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id
    WHERE j.status='POSTED' AND a.type='BANK'`).get().s;
  const open = db.prepare(`SELECT kind, due_date, CAST(ROUND((total_cents - paid_cents) * exchange_rate) AS INTEGER) AS owing
    FROM invoices WHERE status='AUTHORISED' AND kind IN ('ACCREC','ACCPAY')`).all();
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const buckets = [];
  let running = opening;
  for (let w = 0; w < weeks; w++) {
    const start = new Date(today.getTime() + w * 7 * 864e5);
    const end = new Date(start.getTime() + 6 * 864e5);
    const startS = start.toISOString().slice(0, 10);
    const endS = end.toISOString().slice(0, 10);
    let inflow = 0, outflow = 0;
    for (const d of open) {
      const due = w === 0 ? (d.due_date <= endS) : (d.due_date >= startS && d.due_date <= endS);
      if (!due) continue;
      if (d.kind === 'ACCREC') inflow += d.owing; else outflow += d.owing;
    }
    running += inflow - outflow;
    buckets.push({ week_start: startS, week_end: endS, in_cents: inflow, out_cents: outflow, balance_cents: running });
  }
  return { opening_cents: opening, weeks: buckets };
}

// ---------- budgets ----------

function setBudgets(db, { rows }) {
  // rows: [{ accountId, month: 'YYYY-MM', amountCents }]
  const up = db.prepare(`INSERT INTO budgets (account_id, month, amount_cents) VALUES (?,?,?)
    ON CONFLICT(account_id, month) DO UPDATE SET amount_cents = excluded.amount_cents`);
  for (const r of rows || []) up.run(r.accountId, r.month, Math.round(r.amountCents || 0));
  return { ok: true };
}

function getBudgets(db, { from, to }) {
  return db.prepare('SELECT * FROM budgets WHERE month >= ? AND month <= ? ORDER BY account_id, month')
    .all(from.slice(0, 7), to.slice(0, 7));
}

function budgetVsActual(db, { from, to }) {
  const bals = allBalances(db, { from, to });
  const budgets = {};
  for (const b of getBudgets(db, { from, to })) {
    budgets[b.account_id] = (budgets[b.account_id] || 0) + b.amount_cents;
  }
  const rows = [];
  for (const a of accounts(db)) {
    const cls = ACCOUNT_TYPES[a.type];
    if (cls !== 'REVENUE' && cls !== 'EXPENSE') continue;
    const actualRaw = bals[a.id] || 0;
    const actual = cls === 'REVENUE' ? -actualRaw : actualRaw;
    const budget = budgets[a.id] || 0;
    if (!actual && !budget) continue;
    rows.push({
      code: a.code, name: a.name, class: cls,
      actual_cents: actual, budget_cents: budget, variance_cents: actual - budget,
    });
  }
  return { from, to, rows };
}

module.exports = {
  profitAndLoss, balanceSheet, trialBalance, agedDocuments, accountTransactions, taxSummary,
  cashSummary, fyStart, basSummary, cashFlowForecast, setBudgets, getBudgets, budgetVsActual,
};
