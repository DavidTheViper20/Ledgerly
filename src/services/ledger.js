'use strict';

// Double-entry posting engine. Every financial document posts a balanced
// journal here; reports read exclusively from posted journal lines.

function postJournal(db, { date, narration = '', sourceKind, sourceId = null, status = 'POSTED', lines }) {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('A journal needs at least two lines');
  let dr = 0, cr = 0;
  for (const l of lines) {
    const d = l.debitCents || 0, c = l.creditCents || 0;
    if (d < 0 || c < 0) throw new Error('Journal line amounts must be non-negative');
    if (d > 0 && c > 0) throw new Error('A journal line cannot have both debit and credit');
    dr += d; cr += c;
  }
  if (dr !== cr) throw new Error(`Journal does not balance: debits ${dr} != credits ${cr}`);
  if (dr === 0) throw new Error('Journal total cannot be zero');

  const r = db.prepare(
    'INSERT INTO journals (date, narration, source_kind, source_id, status) VALUES (?, ?, ?, ?, ?)')
    .run(date, narration, sourceKind, sourceId, status);
  const journalId = Number(r.lastInsertRowid);
  const ins = db.prepare(
    'INSERT INTO journal_lines (journal_id, account_id, contact_id, description, debit_cents, credit_cents) VALUES (?, ?, ?, ?, ?, ?)');
  for (const l of lines) {
    ins.run(journalId, l.accountId, l.contactId || null, l.description || '', l.debitCents || 0, l.creditCents || 0);
  }
  return journalId;
}

function voidJournal(db, journalId) {
  if (!journalId) return;
  db.prepare("UPDATE journals SET status = 'VOIDED' WHERE id = ?").run(journalId);
}

// Signed balance of an account over posted journals.
// Convention: positive = net debit. Assets/expenses are normally positive,
// liabilities/equity/revenue normally negative.
function accountBalance(db, accountId, { from = null, to = null } = {}) {
  let sql = `SELECT COALESCE(SUM(jl.debit_cents - jl.credit_cents), 0) AS bal
             FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
             WHERE j.status = 'POSTED' AND jl.account_id = ?`;
  const params = [accountId];
  if (from) { sql += ' AND j.date >= ?'; params.push(from); }
  if (to) { sql += ' AND j.date <= ?'; params.push(to); }
  return db.prepare(sql).get(...params).bal;
}

// Balances for every account in one query: { accountId: signedCents }
function allBalances(db, { from = null, to = null } = {}) {
  let sql = `SELECT jl.account_id AS id, SUM(jl.debit_cents - jl.credit_cents) AS bal
             FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
             WHERE j.status = 'POSTED'`;
  const params = [];
  if (from) { sql += ' AND j.date >= ?'; params.push(from); }
  if (to) { sql += ' AND j.date <= ?'; params.push(to); }
  sql += ' GROUP BY jl.account_id';
  const out = {};
  for (const r of db.prepare(sql).all(...params)) out[r.id] = r.bal;
  return out;
}

module.exports = { postJournal, voidJournal, accountBalance, allBalances };
