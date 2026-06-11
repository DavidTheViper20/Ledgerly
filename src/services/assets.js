'use strict';

// Fixed asset register with straight-line depreciation and disposal.

const { round } = require('../money');
const { systemAccount } = require('../db');
const { postJournal } = require('./ledger');

function saveAsset(db, d) {
  if (!d.name) throw new Error('Asset name is required');
  if (!d.purchaseDate) throw new Error('Purchase date is required');
  const cost = Math.round(Number(d.costCents) || 0);
  if (cost <= 0) throw new Error('Cost must be greater than zero');
  const residual = Math.round(Number(d.residualCents) || 0);
  if (residual >= cost) throw new Error('Residual value must be below cost');
  const life = Number(d.lifeYears) || 5;
  if (life <= 0) throw new Error('Useful life must be positive');
  const cols = [d.number || '', d.name, d.description || '', d.purchaseDate, cost, residual, life,
    d.assetAccountId || null, d.accumAccountId || null, d.expenseAccountId || null];
  if (d.id) {
    const a = getAsset(db, d.id);
    if (a.status === 'DISPOSED') throw new Error('Cannot edit a disposed asset');
    if (a.status === 'REGISTERED' && (cost !== a.cost_cents || d.purchaseDate !== a.purchase_date)) {
      const dep = db.prepare('SELECT COUNT(*) AS n FROM asset_depreciation WHERE asset_id=?').get(d.id).n;
      if (dep > 0) throw new Error('Cannot change cost or purchase date after depreciation has been posted');
    }
    db.prepare(`UPDATE fixed_assets SET number=?, name=?, description=?, purchase_date=?, cost_cents=?,
      residual_cents=?, life_years=?, asset_account_id=?, accum_account_id=?, expense_account_id=? WHERE id=?`)
      .run(...cols, d.id);
    return getAsset(db, d.id);
  }
  const r = db.prepare(`INSERT INTO fixed_assets (number, name, description, purchase_date, cost_cents,
    residual_cents, life_years, asset_account_id, accum_account_id, expense_account_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(...cols);
  return getAsset(db, Number(r.lastInsertRowid));
}

function getAsset(db, id) {
  const a = db.prepare(`SELECT fa.*, aa.name AS asset_account_name, ca.name AS accum_account_name,
      ea.name AS expense_account_name
    FROM fixed_assets fa
    LEFT JOIN accounts aa ON aa.id = fa.asset_account_id
    LEFT JOIN accounts ca ON ca.id = fa.accum_account_id
    LEFT JOIN accounts ea ON ea.id = fa.expense_account_id
    WHERE fa.id = ?`).get(id);
  if (!a) throw new Error('Asset not found');
  a.accumulated_cents = db.prepare(
    'SELECT COALESCE(SUM(amount_cents),0) AS s FROM asset_depreciation WHERE asset_id=?').get(id).s;
  a.book_value_cents = a.cost_cents - a.accumulated_cents;
  a.last_period = db.prepare('SELECT MAX(period) AS p FROM asset_depreciation WHERE asset_id=?').get(id).p;
  return a;
}

function listAssets(db, { status = null } = {}) {
  let sql = 'SELECT id FROM fixed_assets WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  return db.prepare(sql + ' ORDER BY purchase_date DESC, id DESC').all(...params).map(r => getAsset(db, r.id));
}

function registerAsset(db, id) {
  const a = getAsset(db, id);
  if (a.status !== 'DRAFT') throw new Error('Only draft assets can be registered');
  if (!a.asset_account_id || !a.accum_account_id || !a.expense_account_id) {
    throw new Error('Set the asset, accumulated depreciation and expense accounts first');
  }
  db.prepare("UPDATE fixed_assets SET status='REGISTERED' WHERE id=?").run(id);
  return getAsset(db, id);
}

function deleteAsset(db, id) {
  const a = getAsset(db, id);
  if (a.status !== 'DRAFT') throw new Error('Only draft assets can be deleted');
  db.prepare('DELETE FROM fixed_assets WHERE id=?').run(id);
  return { ok: true };
}

function monthsBetween(fromPeriod, toPeriod) {
  // periods are YYYY-MM, inclusive
  const out = [];
  let [y, m] = fromPeriod.split('-').map(Number);
  const [ty, tm] = toPeriod.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function nextPeriod(period) {
  let [y, m] = period.split('-').map(Number);
  m++; if (m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function endOfMonth(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Posts straight-line depreciation for all registered assets up to and
// including toPeriod (YYYY-MM). One journal per run.
function runDepreciation(db, { toPeriod }) {
  if (!/^\d{4}-\d{2}$/.test(toPeriod || '')) throw new Error('Period must be YYYY-MM');
  const assets = listAssets(db, { status: 'REGISTERED' });
  const jLines = [];
  const rows = [];
  for (const a of assets) {
    const depreciable = a.cost_cents - a.residual_cents;
    const monthly = round(depreciable / (a.life_years * 12));
    const startPeriod = a.last_period ? nextPeriod(a.last_period) : a.purchase_date.slice(0, 7);
    if (startPeriod > toPeriod) continue;
    let accumulated = a.accumulated_cents;
    let total = 0;
    const periods = [];
    for (const p of monthsBetween(startPeriod, toPeriod)) {
      const remaining = depreciable - accumulated;
      if (remaining <= 0) break;
      const amt = Math.min(monthly, remaining);
      accumulated += amt;
      total += amt;
      periods.push({ period: p, amount: amt });
    }
    if (total <= 0) continue;
    jLines.push({ accountId: a.expense_account_id, description: `Depreciation: ${a.name}`, debitCents: total });
    jLines.push({ accountId: a.accum_account_id, description: `Accum. depreciation: ${a.name}`, creditCents: total });
    rows.push({ assetId: a.id, periods });
  }
  if (!jLines.length) return { posted: 0, journalId: null };
  const journalId = postJournal(db, {
    date: endOfMonth(toPeriod), narration: `Depreciation to ${toPeriod}`,
    sourceKind: 'depreciation', sourceId: null, lines: jLines,
  });
  const ins = db.prepare('INSERT INTO asset_depreciation (asset_id, period, amount_cents, journal_id) VALUES (?,?,?,?)');
  let count = 0;
  for (const r of rows) for (const p of r.periods) { ins.run(r.assetId, p.period, p.amount, journalId); count++; }
  return { posted: count, journalId };
}

// Dispose / sell an asset. Proceeds (if any) are debited to the chosen bank
// account; the difference between proceeds and book value hits the disposal
// gain/loss account.
function disposeAsset(db, { id, date, proceedsCents = 0, bankAccountId = null }) {
  const a = getAsset(db, id);
  if (a.status !== 'REGISTERED') throw new Error('Only registered assets can be disposed');
  proceedsCents = Math.round(Number(proceedsCents) || 0);
  if (proceedsCents > 0 && !bankAccountId) throw new Error('Choose the bank account that received the proceeds');
  const disposal = systemAccount(db, 'DISPOSAL');
  const lines = [
    { accountId: a.accum_account_id, description: `Disposal: ${a.name}`, debitCents: a.accumulated_cents },
    { accountId: a.asset_account_id, description: `Disposal: ${a.name}`, creditCents: a.cost_cents },
  ];
  if (proceedsCents > 0) lines.push({ accountId: bankAccountId, description: `Sale proceeds: ${a.name}`, debitCents: proceedsCents });
  const gain = proceedsCents - a.book_value_cents;
  if (gain !== 0) {
    lines.push({ accountId: disposal.id, description: `${gain > 0 ? 'Gain' : 'Loss'} on disposal: ${a.name}`,
      [gain > 0 ? 'creditCents' : 'debitCents']: Math.abs(gain) });
  }
  // Remove zero-amount lines (e.g. no accumulated depreciation yet).
  const cleaned = lines.filter(l => (l.debitCents || 0) > 0 || (l.creditCents || 0) > 0);
  const journalId = postJournal(db, {
    date, narration: `Asset disposal: ${a.name}`, sourceKind: 'disposal', sourceId: id, lines: cleaned,
  });
  db.prepare("UPDATE fixed_assets SET status='DISPOSED', disposed_date=?, disposal_journal_id=? WHERE id=?")
    .run(date, journalId, id);
  return getAsset(db, id);
}

module.exports = { saveAsset, getAsset, listAssets, registerAsset, deleteAsset, runDepreciation, disposeAsset };
