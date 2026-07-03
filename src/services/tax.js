'use strict';

// ---------- Tax (Xero-style Activity Statements) ----------
// Derives BAS period boundaries from the org's financial year settings and
// gst_period, reusing reports.basSummary() for GST/W1/W2 math — this module
// works out periods, due dates, lodgement bookkeeping, and (Pass D1) layers
// on the extra Full BAS / PAYG / obligation labels on top of basSummary().
//
// Pass D1 scope: settings model + statement label rendering only.
//   - Pass D2 (not built here) is the cash-basis GST engine — gst_method
//     'cash' is accepted as a setting value but gated out of the UI/save
//     path until then; statements always compute accruals-basis via
//     basSummary() regardless of gst_method.
//   - Pass D3 (not built here) is PAYG instalment / monthly IAS statement
//     generation — payg_wh_period 'monthly' currently behaves exactly like
//     'quarterly' for statement labels (see cycleSetting() below).

const { getSetting } = require('../db');
const { basSummary, fyStart } = require('./reports');

// gst_period supersedes the older bas_cycle setting. Existing orgs are
// migrated to carry their bas_cycle choice forward into gst_period on first
// open after upgrade (see db.js open()); this fallback additionally covers
// any settings row that predates that migration running (e.g. restored
// backups) by reading bas_cycle directly if gst_period is still unset.
function gstPeriodSetting(db) {
  const period = getSetting(db, 'gst_period');
  if (period) return period;
  return getSetting(db, 'bas_cycle') === 'monthly' ? 'monthly' : 'quarterly';
}

// Normalises the GST period into the step cadence buildPeriods() understands.
// 'annually' steps 12 months; anything else falls back to quarterly.
function cycleSetting(db) {
  const period = gstPeriodSetting(db);
  if (period === 'monthly') return 'monthly';
  if (period === 'annually') return 'annually';
  return 'quarterly';
}

function ymd(d) { return d.toISOString().slice(0, 10); }

// FY start date (as a Date) covering `today`, based on fy_end_day/fy_end_month.
function fyStartDate(db, today) {
  return new Date(fyStart(db, today) + 'T00:00:00Z');
}

// Build the list of period [start, end] pairs (inclusive, ISO date strings)
// from `seriesStart` up to and including the period containing `today`,
// stepping monthly, quarterly or annually from the financial-year start.
function buildPeriods(db, { seriesStart, today, cycle }) {
  const fyStartD = fyStartDate(db, seriesStart);
  const stepMonths = cycle === 'monthly' ? 1 : cycle === 'annually' ? 12 : 3;
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
// except the Oct-Dec quarter (Q2 of the AU FY) which is due 28 February;
// annually = ATO's standard 2-months-plus after period end (approximate —
// annual GST reporting due dates vary by lodgement pathway; treat as a
// placeholder until Pass D3 wires up real IAS/annual lodgement scheduling).
function dueDateFor(periodEnd, cycle) {
  const end = new Date(periodEnd + 'T00:00:00Z');
  if (cycle === 'monthly') {
    const d = new Date(end.getTime() + 21 * 864e5);
    return ymd(d);
  }
  if (cycle === 'annually') {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 2, end.getUTCDate()));
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

// ---------- Pass D1: Full BAS / PAYG / obligation label extras ----------
// Layers extra statement figures on top of basSummary() without touching
// basSummary() itself. Everything here is derived honestly from existing
// data (invoice/bill lines, settings) or explicitly flagged in `footnotes`
// as needing manual entry — no invented numbers.

// G3 = period sales invoice lines taxed at a 0% rate that ISN'T "BAS
// Excluded" (i.e. GST-free income, not out-of-scope income).
// G11 = total purchase (bill) lines subject to any non-zero GST rate.
// Mirrors basSummary()'s join style (invoice_lines -> tax_rates) since
// journal_lines don't carry per-line tax-rate granularity.
function fullBasFromLines(db, { from, to }) {
  const g3 = db.prepare(`
    SELECT COALESCE(SUM(il.net_cents),0) AS s
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    JOIN tax_rates t ON t.id = il.tax_rate_id
    WHERE i.kind = 'ACCREC' AND i.status IN ('AUTHORISED','PAID')
      AND i.issue_date >= ? AND i.issue_date <= ?
      AND t.rate = 0 AND t.name NOT LIKE 'BAS Excluded%'
  `).get(from, to).s;
  const g11 = db.prepare(`
    SELECT COALESCE(SUM(il.net_cents),0) AS s
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    JOIN tax_rates t ON t.id = il.tax_rate_id
    WHERE i.kind = 'ACCPAY' AND i.status IN ('AUTHORISED','PAID')
      AND i.issue_date >= ? AND i.issue_date <= ?
      AND t.rate > 0
  `).get(from, to).s;
  return { g3, g11 };
}

// Builds the extra label set + footnotes + net-payable adjustment for a
// statement, based on current settings. `bas` is the basSummary() result
// (Simpler BAS labels + W1/W2 already computed there).
function buildExtras(db, bas, { from, to }) {
  const formType = getSetting(db, 'bas_form_type') === 'full' ? 'full' : 'simpler';
  const wPeriod = getSetting(db, 'payg_wh_period') || 'quarterly'; // 'none' | 'monthly' | 'quarterly'
  const itMethod = getSetting(db, 'payg_it_method') || 'none';     // 'none' | 'option1' | 'option2'

  const footnotes = [];
  const extras = { formType, wPeriod, itMethod };

  // ---- Full BAS: G2/G3/G10/G11 ----
  if (formType === 'full') {
    const { g3, g11 } = fullBasFromLines(db, { from, to });
    extras.g2_export_sales_cents = 0;
    extras.g3_gst_free_sales_cents = g3;
    extras.g10_capital_purchases_cents = 0;
    extras.g11_non_capital_purchases_cents = g11;
    footnotes.push('G2 (export sales) shown as $0 — Ledgerly does not track export sales separately yet; review manually.');
    footnotes.push('G10 (capital purchases) shown as $0 — capital purchases need manual review; Ledgerly does not distinguish capital from non-capital purchases yet.');
  }

  // ---- PAYG withholding (W1/W2) visibility ----
  // payg_wh_period 'monthly' currently renders identically to 'quarterly' on
  // statement labels — Pass D3 is what actually interleaves monthly IAS
  // statements between BAS quarters; until then this setting only toggles
  // W-label visibility (via 'none'), matching pre-D1 behaviour otherwise.
  extras.showWLabels = wPeriod !== 'none';

  // ---- PAYG income tax instalments (T-labels / 5A) ----
  if (itMethod === 'option1') {
    const amount = Math.round(Number(getSetting(db, 'payg_instalment_amount_cents')) || 0);
    extras.t7_instalment_amount_cents = amount;
    extras.a5a_payg_instalment_cents = amount;
  } else if (itMethod === 'option2') {
    const t1 = bas.g1_total_sales_cents - bas.a1a_gst_on_sales_cents; // GST-exclusive sales income
    const ratePct = Number(getSetting(db, 'payg_instalment_rate_pct')) || 0;
    extras.t1_instalment_income_cents = t1;
    extras.t2_instalment_rate_pct = ratePct;
    extras.a5a_payg_instalment_cents = Math.round(t1 * (ratePct / 100));
  }

  // ---- Other obligations (toggles only — no automated calculation, v1) ----
  const obligations = [];
  if (getSetting(db, 'obligation_wet') === '1') {
    obligations.push({ key: 'wet', name: 'Wine equalisation tax', labels: [{ code: '1C', name: 'WET payable', amountCents: 0 }, { code: '1D', name: 'WET refundable', amountCents: 0 }] });
  }
  if (getSetting(db, 'obligation_lct') === '1') {
    obligations.push({ key: 'lct', name: 'Luxury car tax', labels: [{ code: '1E', name: 'LCT payable', amountCents: 0 }, { code: '1F', name: 'LCT refundable', amountCents: 0 }] });
  }
  if (getSetting(db, 'obligation_ftc') === '1') {
    obligations.push({ key: 'ftc', name: 'Fuel tax credits', labels: [{ code: '7C', name: 'FTC gross amount', amountCents: 0 }, { code: '7D', name: 'FTC credit', amountCents: 0 }] });
  }
  if (getSetting(db, 'obligation_fbt') === '1') {
    obligations.push({ key: 'fbt', name: 'Fringe benefits tax', labels: [{ code: 'F1', name: 'FBT instalment', amountCents: 0 }] });
  }
  if (obligations.length) {
    extras.obligations = obligations;
    footnotes.push('Fuel tax credits, WET, LCT and FBT amounts need manual entry at lodgement — Ledgerly does not calculate these (v1).');
  }

  extras.footnotes = footnotes;
  return extras;
}

// netPayableCents = 1A + (W2 if PAYG withholding active) + (5A if PAYG income
// tax active) - 1B - (7D FTC credit if toggled, currently always $0).
function netPayableFromBas(bas, extras) {
  const e = extras || {};
  let net = bas.a1a_gst_on_sales_cents - bas.a1b_gst_on_purchases_cents;
  if (e.showWLabels !== false) net += bas.w2_payg_withheld_cents;
  if (e.a5a_payg_instalment_cents) net += e.a5a_payg_instalment_cents;
  // 7D FTC credit reduces net payable once calculated (Pass D2/D3+); v1 it's
  // always $0 so this is a no-op today, kept explicit for when it isn't.
  const ftc = (e.obligations || []).find(o => o.key === 'ftc');
  if (ftc) {
    const sevenD = ftc.labels.find(l => l.code === '7D');
    if (sevenD) net -= sevenD.amountCents;
  }
  return net;
}

function listStatements(db, { today: todayArg } = {}) {
  const today = todayArg || new Date().toISOString().slice(0, 10);
  const cycle = cycleSetting(db);
  const earliest = earliestJournalDate(db);
  const seriesStart = earliest || fyStart(db, today);

  const periods = buildPeriods(db, { seriesStart, today, cycle });

  const needsAttention = [];
  const completed = [];
  let current = null;

  for (const { periodStart, periodEnd } of periods) {
    // The period containing today is always "in progress", never an activity
    // statement yet — it has no due date obligation until it ends.
    if (periodEnd >= today) {
      if (!current || periodStart > current.periodStart) {
        const dueDate = dueDateFor(periodEnd, cycle);
        const bas = basSummary(db, { from: periodStart, to: today });
        const extras = buildExtras(db, bas, { from: periodStart, to: today });
        current = {
          periodStart, periodEnd, dueDate,
          netPayableCents: netPayableFromBas(bas, extras),
        };
      }
      continue;
    }
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
      const extras = buildExtras(db, bas, { from: periodStart, to: periodEnd });
      needsAttention.push({
        periodStart, periodEnd, dueDate,
        status: 'DRAFT',
        overdue: dueDate < today,
        netPayableCents: netPayableFromBas(bas, extras),
      });
    }
  }

  // There is always a current period, even with zero journals: buildPeriods
  // stops at the period containing `today`, so the loop above should have
  // set it. As a defensive fallback (e.g. seriesStart computed oddly),
  // derive it directly from the FY start.
  if (!current) {
    const fyStartD = fyStart(db, today);
    const stepMonths = cycle === 'monthly' ? 1 : cycle === 'annually' ? 12 : 3;
    const start = new Date(fyStartD + 'T00:00:00Z');
    const todayD = new Date(today + 'T00:00:00Z');
    let cursor = new Date(start);
    while (true) {
      const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + stepMonths, cursor.getUTCDate()));
      if (next > todayD) break;
      cursor = next;
    }
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + stepMonths, cursor.getUTCDate()));
    const periodStart = ymd(cursor);
    const periodEnd = ymd(new Date(next.getTime() - 864e5));
    const dueDate = dueDateFor(periodEnd, cycle);
    const bas = basSummary(db, { from: periodStart, to: today });
    const extras = buildExtras(db, bas, { from: periodStart, to: today });
    current = { periodStart, periodEnd, dueDate, netPayableCents: netPayableFromBas(bas, extras) };
  }

  // Needs attention: soonest due first. Completed: most recently lodged first.
  needsAttention.sort((a, b) => a.periodEnd < b.periodEnd ? -1 : 1);
  completed.sort((a, b) => a.periodEnd < b.periodEnd ? 1 : -1);

  return { needsAttention, completed, current };
}

function getStatement(db, { from, to }) {
  const cycle = cycleSetting(db);
  const bas = basSummary(db, { from, to });
  const extras = buildExtras(db, bas, { from, to });
  const dueDate = dueDateFor(to, cycle);
  const lodged = lodgementFor(db, from, to);
  return {
    ...bas,
    ...extras,
    dueDate,
    netPayableCents: lodged ? lodged.net_payable_cents : netPayableFromBas(bas, extras),
    status: lodged ? 'LODGED' : 'DRAFT',
    lodgement: lodged || null,
  };
}

function markLodged(db, { from, to }) {
  const existing = lodgementFor(db, from, to);
  if (existing) throw new Error('This period has already been lodged');
  const bas = basSummary(db, { from, to });
  const extras = buildExtras(db, bas, { from, to });
  const netPayableCents = netPayableFromBas(bas, extras);
  const figures = { ...bas, ...extras };
  const r = db.prepare(`INSERT INTO activity_statements
    (period_start, period_end, lodged_at, figures_json, net_payable_cents)
    VALUES (?, ?, datetime('now'), ?, ?)`)
    .run(from, to, JSON.stringify(figures), netPayableCents);
  return db.prepare('SELECT * FROM activity_statements WHERE id = ?').get(Number(r.lastInsertRowid));
}

function unlodge(db, { id }) {
  const existing = db.prepare('SELECT * FROM activity_statements WHERE id = ?').get(id);
  if (!existing) throw new Error('Statement not found');
  db.prepare('DELETE FROM activity_statements WHERE id = ?').run(id);
  return { ok: true };
}

// ---------- Taxable Payments Annual Report (TPAR) ----------
// Payments made during a financial year against supplier bills (ACCPAY),
// grouped by contact. GST is apportioned from the invoice pro-rata to the
// payment amount — an approximation, noted in the UI.

// The most recently ENDED financial year, as its FY end date (e.g. '2026-06-30').
function mostRecentlyEndedFyEnd(db, today) {
  const currentFyStart = fyStart(db, today);
  // The day before this FY's start is the end of the most recently ended FY.
  const d = new Date(currentFyStart + 'T00:00:00Z');
  return ymd(new Date(d.getTime() - 864e5));
}

// The last `count` ENDED financial years, as their FY end dates, most recent first.
function recentFyEnds(db, { today: todayArg, count = 3 } = {}) {
  const today = todayArg || new Date().toISOString().slice(0, 10);
  const out = [];
  let end = mostRecentlyEndedFyEnd(db, today);
  for (let i = 0; i < count; i++) {
    out.push(end);
    // The prior FY's end is one day before this FY's start.
    const fyStartOfThis = fyStart(db, end);
    end = ymd(new Date(new Date(fyStartOfThis + 'T00:00:00Z').getTime() - 864e5));
  }
  return out;
}

function tpar(db, { fyEnd: fyEndArg } = {}) {
  const fyEnd = fyEndArg || mostRecentlyEndedFyEnd(db, new Date().toISOString().slice(0, 10));
  const fyStartDate = fyStart(db, fyEnd);

  const rows = db.prepare(`
    SELECT p.id AS payment_id, p.amount_cents, p.date,
           i.id AS invoice_id, i.total_cents AS invoice_total_cents, i.tax_cents AS invoice_tax_cents,
           c.id AS contact_id, c.name AS contact_name, c.tax_number AS abn,
           c.address AS address, c.city AS city, c.postcode AS postcode, c.country AS country
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    JOIN contacts c ON c.id = i.contact_id
    WHERE i.kind = 'ACCPAY' AND p.date >= ? AND p.date <= ?
  `).all(fyStartDate, fyEnd);

  const byContact = new Map();
  for (const r of rows) {
    if (!r.amount_cents) continue;
    const gstCents = r.invoice_total_cents
      ? Math.round((r.invoice_tax_cents || 0) * (r.amount_cents / r.invoice_total_cents))
      : 0;
    if (!byContact.has(r.contact_id)) {
      const address = [r.address, r.city, r.postcode, r.country].filter(Boolean).join(', ');
      byContact.set(r.contact_id, {
        contactId: r.contact_id, name: r.contact_name, abn: r.abn || '', address,
        totalPaidCents: 0, gstCents: 0,
      });
    }
    const row = byContact.get(r.contact_id);
    row.totalPaidCents += r.amount_cents;
    row.gstCents += gstCents;
  }

  const contacts = [...byContact.values()].filter(c => c.totalPaidCents !== 0);
  contacts.sort((a, b) => a.name.localeCompare(b.name));

  const totals = contacts.reduce((acc, c) => {
    acc.totalPaidCents += c.totalPaidCents;
    acc.gstCents += c.gstCents;
    return acc;
  }, { totalPaidCents: 0, gstCents: 0 });

  return { fyStart: fyStartDate, fyEnd, contacts, totals };
}

module.exports = {
  listStatements, getStatement, markLodged, unlodge, dueDateFor, buildPeriods,
  tpar, recentFyEnds, mostRecentlyEndedFyEnd,
};
