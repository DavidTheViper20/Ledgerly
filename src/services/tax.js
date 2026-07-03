'use strict';

// ---------- Tax (Xero-style Activity Statements) ----------
// Derives BAS period boundaries from the org's financial year settings and
// gst_period, reusing reports.basSummary() for GST/W1/W2 math — this module
// works out periods, due dates, lodgement bookkeeping, and (Pass D1) layers
// on the extra Full BAS / PAYG / obligation labels on top of basSummary().
//
// Pass D1 scope: settings model + statement label rendering.
//   - Pass D2 adds the cash-basis GST engine — gst_method 'cash' selects
//     cashBasSummary() (payment-dated GST) in place of basSummary() for all
//     statement figures, via basEngine() below.
//   - Pass D3 (this pass) adds monthly IAS statement generation: a monthly PAYG
//     withholder whose GST is reported quarterly/annually now gets a standalone
//     IAS (PAYG withholding only) for the months that don't coincide with a BAS
//     (see iasSplit()/statementDescriptors() below). Statements carry a `type`
//     of 'BAS' or 'IAS'.

const { getSetting } = require('../db');
const { basSummary, cashBasSummary, paygWithholding, fyStart } = require('./reports');

// D1/D2 engine seam: select the BAS figures engine by the gst_method setting.
// 'cash' -> cashBasSummary (GST recognised on payment date); anything else ->
// basSummary (accruals, GST recognised on invoice date). Both return the same
// shape, so every caller below (listStatements, getStatement, markLodged) swaps
// engines transparently just by routing through here.
function basEngine(db, { from, to }) {
  const method = getSetting(db, 'gst_method') === 'cash' ? 'cash' : 'accruals';
  return method === 'cash' ? cashBasSummary(db, { from, to }) : basSummary(db, { from, to });
}

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
// annual GST reporting due dates vary by lodgement pathway).
//
// Pass D3: a monthly IAS is always due 21 days after month end, regardless of
// the GST cycle, so it uses the 'monthly' branch here (see iasDueDate()).
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

// ---------- Pass D3: monthly IAS interleaving ----------
// A monthly PAYG withholder reports withholding every month. When GST is
// reported LESS often than monthly (quarterly or annually), the intervening
// months can't ride on a BAS, so each gets its own IAS (Instalment Activity
// Statement) carrying PAYG-withholding labels only (W1/W2 — no GST, no PAYG
// income-tax instalments). The withholding that DOES coincide with a BAS
// period end is reported on that BAS instead of on a separate IAS.
//
// iasSplit() returns which BAS months become standalone IAS statements:
//   - 'quarterly': the FIRST TWO months of each GST quarter become IAS; the
//     quarter's BAS reports withholding for the THIRD month only.
//   - 'annually':  EVERY month becomes an IAS; the annual GST statement carries
//     NO withholding at all (all of it was reported via the monthly IAS).
//   - otherwise (monthly GST, or WH quarterly/none): no IAS — behaviour today.
function iasSplit(db) {
  const wPeriod = getSetting(db, 'payg_wh_period') || 'quarterly';
  if (wPeriod !== 'monthly') return null;
  const gstPeriod = gstPeriodSetting(db);
  if (gstPeriod === 'quarterly') return 'quarterly';
  if (gstPeriod === 'annually') return 'annually';
  return null; // monthly GST already carries each month's W labels on its BAS.
}

// The calendar month periods (inclusive ISO ranges) that fall inside a BAS
// period [periodStart, periodEnd]. Used to slice a quarter/year into months.
function monthsIn(periodStart, periodEnd) {
  const out = [];
  let cursor = new Date(periodStart + 'T00:00:00Z');
  const end = new Date(periodEnd + 'T00:00:00Z');
  while (cursor <= end) {
    const mStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
    const mEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    out.push({ periodStart: ymd(mStart), periodEnd: ymd(mEnd) });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return out;
}

// IAS due date: always 21 days after the month end (uses dueDateFor's monthly
// branch), independent of the GST cycle.
function iasDueDate(periodEnd) {
  return dueDateFor(periodEnd, 'monthly');
}

// For a BAS period under a given split, the month sub-ranges that become
// standalone IAS statements (empty when there's no split).
function iasMonthsForBasPeriod(split, periodStart, periodEnd) {
  if (!split) return [];
  const months = monthsIn(periodStart, periodEnd);
  if (split === 'quarterly') return months.slice(0, 2);  // first two months -> IAS
  return months;                                          // annually: every month -> IAS
}

// The sub-range of a BAS period over which its OWN W1/W2 should be computed.
//   - 'quarterly' split: the THIRD month only.
//   - 'annually' split: none (W labels dropped entirely) -> null.
//   - no split: the whole period (unchanged).
function basWRange(split, periodStart, periodEnd) {
  if (!split) return { from: periodStart, to: periodEnd };
  if (split === 'annually') return null;
  const months = monthsIn(periodStart, periodEnd);
  const third = months[months.length - 1]; // last month of the quarter
  return { from: third.periodStart, to: third.periodEnd };
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
    // On cash basis, the primary 1A/1B/G1 figures are payment-dated, but G3/G11
    // are derived from invoice lines by issue date (fullBasFromLines()) — the
    // line-level data needed to apportion them pro-rata to each payment isn't
    // tracked, so we report them accruals-derived and say so, choosing accuracy
    // + honesty over a convoluted approximation.
    if (getSetting(db, 'gst_method') === 'cash') {
      footnotes.push('G3/G11 derived on an accruals basis (from invoice/bill lines by issue date), not on the cash basis used for 1A/1B/G1.');
    }
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

// ---------- Statement figure assembly (D3: BAS vs IAS) ----------

// Full BAS figure object for a period. When a monthly-WH IAS split is active,
// the BAS's own W1/W2 are recomputed over the split's sub-range: the third
// month only (quarterly split), or dropped entirely (annual split). GST and
// everything else still cover the whole `[from,to]` period.
//
// `asOf` limits the accrual window (used for the in-progress "current" period,
// where figures cover from the period start up to today).
function buildBasFigures(db, { from, to, asOf }) {
  const cycle = cycleSetting(db);
  const rangeTo = asOf || to;
  const bas = basEngine(db, { from, to: rangeTo });

  const split = iasSplit(db);
  const wRange = basWRange(split, from, to);
  if (split) {
    // Recompute W1/W2 over the BAS's own sub-range (month 3, or none).
    if (wRange) {
      const wTo = asOf && asOf < wRange.to ? asOf : wRange.to;
      const wFrom = wRange.from;
      // Only report W if the (possibly clipped) sub-range is valid.
      const { w1, w2 } = wFrom <= wTo ? paygWithholding(db, { from: wFrom, to: wTo }) : { w1: 0, w2: 0 };
      bas.w1_gross_wages_cents = w1;
      bas.w2_payg_withheld_cents = w2;
    } else {
      // Annual split: withholding reported entirely via monthly IAS.
      bas.w1_gross_wages_cents = 0;
      bas.w2_payg_withheld_cents = 0;
    }
  }

  const extras = buildExtras(db, bas, { from, to: rangeTo });
  // Annual split drops W labels from the annual statement.
  if (split === 'annually') extras.showWLabels = false;

  return {
    ...bas,
    ...extras,
    type: 'BAS',
    basis: bas.basis === 'cash' ? 'cash' : 'accruals',
    dueDate: dueDateFor(to, cycle),
    netPayableCents: netPayableFromBas(bas, extras),
  };
}

// IAS figure object: PAYG withholding labels + net only. No GST/G labels, no
// PAYG income-tax instalments, no Full-BAS extras, no obligations. Net = W2.
function buildIasFigures(db, { from, to, asOf }) {
  const wTo = asOf && asOf < to ? asOf : to;
  const { w1, w2 } = paygWithholding(db, { from, to: wTo });
  return {
    from, to,
    type: 'IAS',
    w1_gross_wages_cents: w1,
    w2_payg_withheld_cents: w2,
    showWLabels: true,
    dueDate: iasDueDate(to),
    netPayableCents: w2,
  };
}

// Ordered list of statement descriptors {type, periodStart, periodEnd, dueDate}
// covering the series, interleaving monthly IAS statements where the WH/GST
// settings require them. Order is chronological by (periodEnd, then IAS before
// BAS when they share a period end — which only happens for the third month of
// a quarter, and there we emit no IAS anyway).
function statementDescriptors(db, { seriesStart, today }) {
  const cycle = cycleSetting(db);
  const split = iasSplit(db);
  const basPeriods = buildPeriods(db, { seriesStart, today, cycle });
  const out = [];
  for (const { periodStart, periodEnd } of basPeriods) {
    // Interleave the IAS months for this BAS period, ahead of the BAS itself.
    for (const m of iasMonthsForBasPeriod(split, periodStart, periodEnd)) {
      out.push({ type: 'IAS', periodStart: m.periodStart, periodEnd: m.periodEnd, dueDate: iasDueDate(m.periodEnd) });
    }
    out.push({ type: 'BAS', periodStart, periodEnd, dueDate: dueDateFor(periodEnd, cycle) });
  }
  // Chronological by period end, IAS before its parent BAS on ties.
  out.sort((a, b) => {
    if (a.periodEnd !== b.periodEnd) return a.periodEnd < b.periodEnd ? -1 : 1;
    return a.type === 'IAS' ? -1 : 1;
  });
  return out;
}

function figuresFor(db, d, asOf) {
  return d.type === 'IAS'
    ? buildIasFigures(db, { from: d.periodStart, to: d.periodEnd, asOf })
    : buildBasFigures(db, { from: d.periodStart, to: d.periodEnd, asOf });
}

function listStatements(db, { today: todayArg } = {}) {
  const today = todayArg || new Date().toISOString().slice(0, 10);
  const earliest = earliestJournalDate(db);
  const seriesStart = earliest || fyStart(db, today);

  const descriptors = statementDescriptors(db, { seriesStart, today });

  const needsAttention = [];
  const completed = [];
  let current = null;

  for (const d of descriptors) {
    const { type, periodStart, periodEnd, dueDate } = d;
    // The period containing today is always "in progress", never a lodged
    // statement yet. The current (in-progress) item is the SHORTEST such
    // period covering today — i.e. the in-progress IAS month when one exists,
    // otherwise the in-progress BAS. Its parent BAS quarter keeps accumulating
    // and only appears once its own period ends.
    if (periodEnd >= today) {
      const isShorter = !current
        || periodStart > current.periodStart
        || (periodStart === current.periodStart && periodEnd < current.periodEnd);
      if (isShorter) {
        const fig = figuresFor(db, d, today);
        current = { type, periodStart, periodEnd, dueDate, netPayableCents: fig.netPayableCents };
      }
      continue;
    }
    const lodged = lodgementFor(db, periodStart, periodEnd);
    if (lodged) {
      const snapshotType = safeFiguresType(lodged) || type;
      completed.push({
        id: lodged.id,
        type: snapshotType,
        periodStart, periodEnd, dueDate,
        status: 'LODGED',
        overdue: false,
        netPayableCents: lodged.net_payable_cents,
        lodgedAt: lodged.lodged_at,
      });
    } else {
      const fig = figuresFor(db, d);
      needsAttention.push({
        type,
        periodStart, periodEnd, dueDate,
        status: 'DRAFT',
        overdue: dueDate < today,
        netPayableCents: fig.netPayableCents,
      });
    }
  }

  // There is always a current period. buildPeriods stops at the period
  // containing `today`, so the loop should have set it. Defensive fallback.
  if (!current) {
    const cycle = cycleSetting(db);
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
    const fig = buildBasFigures(db, { from: periodStart, to: periodEnd, asOf: today });
    current = { type: 'BAS', periodStart, periodEnd, dueDate: fig.dueDate, netPayableCents: fig.netPayableCents };
  }

  // Needs attention: soonest due first. Completed: most recently lodged first.
  needsAttention.sort((a, b) => a.periodEnd < b.periodEnd ? -1 : 1);
  completed.sort((a, b) => a.periodEnd < b.periodEnd ? 1 : -1);

  return { needsAttention, completed, current };
}

function safeFiguresType(row) {
  try { return JSON.parse(row.figures_json).type; } catch { return null; }
}

function getStatement(db, { from, to, type }) {
  const isIas = type === 'IAS';
  const lodged = lodgementFor(db, from, to);
  const fig = isIas
    ? buildIasFigures(db, { from, to })
    : buildBasFigures(db, { from, to });
  return {
    ...fig,
    netPayableCents: lodged ? lodged.net_payable_cents : fig.netPayableCents,
    status: lodged ? 'LODGED' : 'DRAFT',
    lodgement: lodged || null,
  };
}

function markLodged(db, { from, to, type }) {
  const existing = lodgementFor(db, from, to);
  if (existing) throw new Error('This period has already been lodged');
  const isIas = type === 'IAS';
  const figures = isIas
    ? buildIasFigures(db, { from, to })
    : buildBasFigures(db, { from, to });
  const netPayableCents = figures.netPayableCents;
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
