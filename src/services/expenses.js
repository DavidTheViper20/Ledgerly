'use strict';

// Expense claims: out-of-pocket employee/owner expenses.
// DRAFT -> SUBMITTED -> AUTHORISED (posts to Employee Reimbursements Payable) -> PAID.

const { calcLine } = require('../money');
const { getSetting, setSetting, systemAccount } = require('../db');
const { postJournal, voidJournal } = require('./ledger');

function taxRate(db, id) {
  if (!id) return 0;
  const r = db.prepare('SELECT rate FROM tax_rates WHERE id = ?').get(id);
  return r ? r.rate : 0;
}

function saveClaim(db, data) {
  // Receipt amounts are gross (GST inclusive).
  const lines = [];
  for (const [i, l] of (data.lines || []).entries()) {
    if (!l.description && !l.grossCents && !l.accountId) continue;
    if (!l.accountId) throw new Error('Every receipt needs an account');
    const c = calcLine({
      qty: 1, unitPriceCents: Math.round(Number(l.grossCents) || 0),
      ratePct: taxRate(db, l.taxRateId), mode: 'inclusive',
    });
    lines.push({ ...l, position: i, netCents: c.netCents, taxCents: c.taxCents });
  }
  if (!lines.length) throw new Error('Add at least one receipt');
  const subtotal = lines.reduce((s, l) => s + l.netCents, 0);
  const tax = lines.reduce((s, l) => s + l.taxCents, 0);

  let id = data.id;
  if (id) {
    const claim = getClaim(db, id);
    if (!['DRAFT', 'SUBMITTED'].includes(claim.status)) throw new Error(`Cannot edit a ${claim.status} claim`);
    db.prepare(`UPDATE expense_claims SET payee=?, date=?, subtotal_cents=?, tax_cents=?, total_cents=? WHERE id=?`)
      .run(data.payee, data.date, subtotal, tax, subtotal + tax, id);
    db.prepare('DELETE FROM expense_claim_lines WHERE claim_id=?').run(id);
  } else {
    if (!data.payee) throw new Error('Who is claiming this expense?');
    const prefix = getSetting(db, 'claim_prefix') || 'EXP-';
    const n = parseInt(getSetting(db, 'claim_next_number') || '1', 10);
    setSetting(db, 'claim_next_number', String(n + 1));
    const r = db.prepare(`INSERT INTO expense_claims (number, payee, date, status, subtotal_cents, tax_cents, total_cents)
      VALUES (?,?,?,'DRAFT',?,?,?)`)
      .run(prefix + String(n).padStart(4, '0'), data.payee, data.date, subtotal, tax, subtotal + tax);
    id = Number(r.lastInsertRowid);
  }
  const ins = db.prepare(`INSERT INTO expense_claim_lines (claim_id, date, description, merchant, gross_cents,
    account_id, tax_rate_id, project_id, net_cents, tax_cents, position) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of lines) {
    ins.run(id, l.date || data.date, l.description || '', l.merchant || '', Math.round(Number(l.grossCents) || 0),
      l.accountId, l.taxRateId || null, l.projectId || null, l.netCents, l.taxCents, l.position);
  }
  return getClaim(db, id);
}

function getClaim(db, id) {
  const c = db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(id);
  if (!c) throw new Error('Expense claim not found');
  c.lines = db.prepare(`SELECT l.*, a.name AS account_name, t.name AS tax_name, p.name AS project_name
    FROM expense_claim_lines l
    LEFT JOIN accounts a ON a.id = l.account_id
    LEFT JOIN tax_rates t ON t.id = l.tax_rate_id
    LEFT JOIN projects p ON p.id = l.project_id
    WHERE l.claim_id = ? ORDER BY l.position`).all(id);
  return c;
}

function listClaims(db, { status = null } = {}) {
  let sql = 'SELECT * FROM expense_claims WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  return db.prepare(sql + ' ORDER BY date DESC, id DESC LIMIT 500').all(...params);
}

function setClaimStatus(db, id, status) {
  const c = getClaim(db, id);
  if (status === 'SUBMITTED' && c.status === 'DRAFT') {
    db.prepare("UPDATE expense_claims SET status='SUBMITTED' WHERE id=?").run(id);
  } else if (status === 'DECLINED' && ['DRAFT', 'SUBMITTED'].includes(c.status)) {
    db.prepare("UPDATE expense_claims SET status='DECLINED' WHERE id=?").run(id);
  } else {
    throw new Error(`Cannot move claim from ${c.status} to ${status}`);
  }
  return getClaim(db, id);
}

function approveClaim(db, id) {
  const c = getClaim(db, id);
  if (!['DRAFT', 'SUBMITTED'].includes(c.status)) throw new Error(`Cannot approve a ${c.status} claim`);
  if (c.total_cents <= 0) throw new Error('Claim total must be greater than zero');
  const reimb = systemAccount(db, 'REIMB');
  const taxAcc = systemAccount(db, 'TAX');
  const lines = [];
  for (const l of c.lines) {
    if (l.net_cents) lines.push({ accountId: l.account_id, description: l.description || l.merchant, debitCents: l.net_cents });
  }
  if (c.tax_cents) lines.push({ accountId: taxAcc.id, description: 'GST', debitCents: c.tax_cents });
  lines.push({ accountId: reimb.id, description: `Expense claim ${c.number} - ${c.payee}`, creditCents: c.total_cents });
  const journalId = postJournal(db, {
    date: c.date, narration: `Expense claim ${c.number} - ${c.payee}`,
    sourceKind: 'expense_claim', sourceId: id, lines,
  });
  db.prepare("UPDATE expense_claims SET status='AUTHORISED', journal_id=? WHERE id=?").run(journalId, id);
  return getClaim(db, id);
}

function payClaim(db, { id, bankAccountId, date }) {
  const c = getClaim(db, id);
  if (c.status !== 'AUTHORISED') throw new Error('Approve the claim before paying it');
  const reimb = systemAccount(db, 'REIMB');
  const journalId = postJournal(db, {
    date, narration: `Reimbursement ${c.number} - ${c.payee}`,
    sourceKind: 'expense_claim', sourceId: id,
    lines: [
      { accountId: reimb.id, description: 'Reimbursement', debitCents: c.total_cents },
      { accountId: bankAccountId, description: `Reimbursement ${c.number} - ${c.payee}`, creditCents: c.total_cents },
    ],
  });
  db.prepare("UPDATE expense_claims SET status='PAID', paid_journal_id=? WHERE id=?").run(journalId, id);
  return getClaim(db, id);
}

function deleteClaim(db, id) {
  const c = getClaim(db, id);
  if (!['DRAFT', 'SUBMITTED', 'DECLINED'].includes(c.status)) throw new Error('Only unapproved claims can be deleted');
  db.prepare('DELETE FROM expense_claim_lines WHERE claim_id=?').run(id);
  db.prepare('DELETE FROM expense_claims WHERE id=?').run(id);
  return { ok: true };
}

function voidClaim(db, id) {
  const c = getClaim(db, id);
  if (c.status === 'PAID') throw new Error('Cannot void a paid claim');
  if (c.status !== 'AUTHORISED') throw new Error('Only approved claims can be voided');
  voidJournal(db, c.journal_id);
  db.prepare("UPDATE expense_claims SET status='DECLINED', journal_id=NULL WHERE id=?").run(id);
  return getClaim(db, id);
}

module.exports = { saveClaim, getClaim, listClaims, setClaimStatus, approveClaim, payClaim, deleteClaim, voidClaim };
