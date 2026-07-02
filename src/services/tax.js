'use strict';

// ---------- Tax (Xero-style Activity Statements) ----------
// Derives BAS period boundaries from the org's financial year settings and
// bas_cycle, reusing reports.basSummary() for all tax math — this module
// only works out periods, due dates and lodgement bookkeeping.

const { getSetting } = require('../db');
const { basSummary, fyStart } = require('./reports');

function ymd(d) { return d.toISOString().slice(0, 10); }

// FY start date (as a Date) covering `today`, based on fy_end_day/fy_end_month.
function fyStartDate(db, today) {
  return new Date(fyStart(db, today) + 'T00:00:00Z');
}

// Build the list of period [start, end] pairs (inclusive, ISO date strings)
// from `seriesStart` up to and including the period containing `today`,
// stepping monthly or quarterly from the financial-year start.
function buildPeriods(db, { seriesStart, today, cycle }) {
  const fyStartD = fyStartDate(db, seriesStart);
  const stepMonths = cycle === 'monthly' ? 1 : 3;
  const todayD = new Date(today + 'T00:00:00Z');
  const seriesStartD = new Date(seriesStart + 'T00:00:00Z');

  const periods = [];
  let cursor = new Date(fyStartD);
  // Advance to the first period that could contain seriesStart or later.
  while (true) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + stepMonths, cursor.getUTCDate()));
    const periodEnd = new Date(next.getTime() - 864e5);
    if (periodEnd >= seriesStartD) break;
    cursor = next;
  }
  // Now generate periods until we've covered today.
  while (true) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + stepMonths, cursor.getUTCDate()));
    const periodStart = new Date(cursor);
    const periodEnd = new Date(next.getTime() - 864e5);
    periods.push({ periodStart: ymd(periodStart), periodEnd: ymd(periodEnd) });
    if (periodEnd >= todayD) break;
    cursor = next;
  }
  return periods;
}

// Due date: monthly = 21 days after period end; quarterly = 28 days after,
// except the Oct-Dec quarter (Q2 of the AU FY) which is due 28 February.
function dueDateFor(periodEnd, cycle) {
  const end = new Date(periodEnd + 'T00:00:00Z');
  if (cycle === 'monthly') {
    const d = new Date(end.getTime() + 21 * 864e5);
    return ymd(d);
  }
  // Quarterly: Oct-Dec quarter (ends 31 Dec) is due 28 Feb of the next year.
  if (end.getUTCMonth() === 11 && end.getUTCDate() === 31) {
    return `${end.getUTCFullYear() + 1}-02-28`;
  }
  const d = new Date(end.getTime() + 28 * 864e5);
  return ymd(d);
}

function earliestJournalDate(db) {
  const r = db.prepare("SELECT MIN(date) AS d FROM journals WHERE status='POSTED'").get();
  return r && r.d ? r.d : null;
}

function lodgementFor(db, periodStart, periodEnd) {
  return db.prepare('SELECT * FROM activity_statements WHERE period_start = ? AND period_end = ?')
    .get(periodStart, periodEnd);
}

// netPayableCents = (1A GST on sales + W2 PAYG withheld) - (1B GST on purchases)
function netPayableFromBas(bas) {
  return bas.a1a_gst_on_sales_cents + bas.w2_payg_withheld_cents - bas.a1b_gst_on_purchases_cents;
}

function listStatements(db, { today: todayArg } = {}) {
  const today = todayArg || new Date().toISOString().slice(0, 10);
  const cycle = getSetting(db, 'bas_cycle') === 'monthly' ? 'monthly' : 'quarterly';
  const earliest = earliestJournalDate(db);
  const seriesStart = earliest || fyStart(db, today);

  const periods = buildPeriods(db, { seriesStart, today, cycle });

  const needsAttention = [];
  const completed = [];

  for (const { periodStart, periodEnd } of periods) {
    // Only completed periods (period_end < today) are activity statements.
    if (periodEnd >= today) continue;
    const dueDate = dueDateFor(periodEnd, cycle);
    const lodged = lodgementFor(db, periodStart, periodEnd);
    if (lodged) {
      completed.push({
        id: lodged.id,
        periodStart, periodEnd, dueDate,
        status: 'LODGED',
        overdue: false,
        netPayableCents: lodged.net_payable_cents,
        lodgedAt: lodged.lodged_at,
      });
    } else {
      const bas = basSummary(db, { from: periodStart, to: periodEnd });
      needsAttention.push({
        periodStart, periodEnd, dueDate,
        status: 'DRAFT',
        overdue: dueDate < today,
        netPayableCents: netPayableFromBas(bas),
      });
    }
  }

  // Needs attention: soonest due first. Completed: most recently lodged first.
  needsAttention.sort((a, b) => a.periodEnd < b.periodEnd ? -1 : 1);
  completed.sort((a, b) => a.periodEnd < b.periodEnd ? 1 : -1);

  return { needsAttention, completed };
}

function getStatement(db, { from, to }) {
  const cycle = getSetting(db, 'bas_cycle') === 'monthly' ? 'monthly' : 'quarterly';
  const bas = basSummary(db, { from, to });
  const dueDate = dueDateFor(to, cycle);
  const lodged = lodgementFor(db, from, to);
  return {
    ...bas,
    dueDate,
    netPayableCents: netPayableFromBas(bas),
    status: lodged ? 'LODGED' : 'DRAFT',
    lodgement: lodged || null,
  };
}

function markLodged(db, { from, to }) {
  const existing = lodgementFor(db, from, to);
  if (existing) throw new Error('This period has already been lodged');
  const bas = basSummary(db, { from, to });
  const netPayableCents = netPayableFromBas(bas);
  const r = db.prepare(`INSERT INTO activity_statements
    (period_start, period_end, lodged_at, figures_json, net_payable_cents)
    VALUES (?, ?, datetime('now'), ?, ?)`)
    .run(from, to, JSON.stringify(bas), netPayableCents);
  return db.prepare('SELECT * FROM activity_statements WHERE id = ?').get(Number(r.lastInsertRowid));
}

function unlodge(db, { id }) {
  const existing = db.prepare('SELECT * FROM activity_statements WHERE id = ?').get(id);
  if (!existing) throw new Error('Statement not found');
  db.prepare('DELETE FROM activity_statements WHERE id = ?').run(id);
  return { ok: true };
}

module.exports = { listStatements, getStatement, markLodged, unlodge, dueDateFor, buildPeriods };
