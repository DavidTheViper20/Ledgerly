'use strict';

// Bank accounts, spend/receive money, transfers, statement import,
// match suggestions and reconciliation.

const { calcLine, sumLines, toCents } = require('../money');
const { postJournal, voidJournal, accountBalance } = require('./ledger');

function taxRate(db, id) {
  if (!id) return 0;
  const r = db.prepare('SELECT rate FROM tax_rates WHERE id = ?').get(id);
  return r ? r.rate : 0;
}

function listBankAccounts(db) {
  const accounts = db.prepare(
    "SELECT * FROM accounts WHERE type = 'BANK' AND is_archived = 0 ORDER BY code").all();
  for (const a of accounts) {
    a.balance_cents = accountBalance(db, a.id);
    a.unreconciled = db.prepare(
      "SELECT COUNT(*) AS c FROM statement_lines WHERE bank_account_id = ? AND status = 'UNMATCHED'").get(a.id).c;
    const last = db.prepare(
      'SELECT MAX(date) AS d, SUM(amount_cents) AS s FROM statement_lines WHERE bank_account_id = ?').get(a.id);
    a.statement_balance_cents = last.s || 0;
    a.last_statement_date = last.d;
  }
  return accounts;
}

function createBankAccount(db, { name, code, description = '' }) {
  if (!name) throw new Error('Account name required');
  if (!code) throw new Error('Account code required');
  const r = db.prepare(
    "INSERT INTO accounts (code, name, type, description) VALUES (?, ?, 'BANK', ?)").run(code, name, description);
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(r.lastInsertRowid));
}

// ---------- spend / receive money ----------

function saveBankTransaction(db, data) {
  // data: { id?, kind: SPEND|RECEIVE, bankAccountId, contactId?, date, reference, taxMode, lines }
  const lines = [];
  for (const [i, l] of data.lines.entries()) {
    if (!l.description && !l.unitPriceCents && !l.accountId) continue;
    if (!l.accountId) throw new Error('Every line needs an account');
    const rate = data.taxMode === 'none' ? 0 : taxRate(db, l.taxRateId);
    const c = calcLine({
      qty: Number(l.qty) || 1, unitPriceCents: Math.round(Number(l.unitPriceCents) || 0),
      ratePct: rate, mode: data.taxMode,
    });
    lines.push({ ...l, position: i, netCents: c.netCents, taxCents: c.taxCents });
  }
  if (!lines.length) throw new Error('Add at least one line');
  const totals = sumLines(lines);
  if (totals.totalCents <= 0) throw new Error('Total must be greater than zero');

  if (data.id) {
    const old = getBankTransaction(db, data.id);
    if (old.is_reconciled) throw new Error('Unreconcile before editing');
    voidJournal(db, old.journal_id);
    db.prepare('DELETE FROM bank_transaction_lines WHERE bank_transaction_id = ?').run(data.id);
    db.prepare('DELETE FROM bank_transactions WHERE id = ?').run(data.id);
  }

  const r = db.prepare(`INSERT INTO bank_transactions (kind, bank_account_id, contact_id, date, reference,
    tax_mode, subtotal_cents, tax_cents, total_cents) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(data.kind, data.bankAccountId, data.contactId || null, data.date, data.reference || '',
      data.taxMode, totals.subtotalCents, totals.taxCents, totals.totalCents);
  const id = Number(r.lastInsertRowid);
  const ins = db.prepare(`INSERT INTO bank_transaction_lines (bank_transaction_id, description, qty,
    unit_price_cents, account_id, tax_rate_id, net_cents, tax_cents, position) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const l of lines) {
    ins.run(id, l.description || '', Number(l.qty) || 1, Math.round(Number(l.unitPriceCents) || 0),
      l.accountId, l.taxRateId || null, l.netCents, l.taxCents, l.position);
  }

  const isSpend = data.kind === 'SPEND';
  const taxAccId = require('../db').systemAccount(db, 'TAX').id;
  const jl = [];
  jl.push({
    accountId: data.bankAccountId, contactId: data.contactId || null,
    description: data.reference || (isSpend ? 'Spend money' : 'Receive money'),
    [isSpend ? 'creditCents' : 'debitCents']: totals.totalCents,
  });
  for (const l of lines) {
    if (l.netCents !== 0) {
      const credit = isSpend ? l.netCents < 0 : l.netCents > 0;
      jl.push({
        accountId: l.accountId, contactId: data.contactId || null, description: l.description,
        [credit ? 'creditCents' : 'debitCents']: Math.abs(l.netCents),
      });
    }
  }
  if (totals.taxCents !== 0) {
    const credit = isSpend ? totals.taxCents < 0 : totals.taxCents > 0;
    jl.push({ accountId: taxAccId, description: 'Tax', [credit ? 'creditCents' : 'debitCents']: Math.abs(totals.taxCents) });
  }
  const journalId = postJournal(db, {
    date: data.date, narration: `${isSpend ? 'Spend' : 'Receive'} money: ${data.reference || ''}`,
    sourceKind: 'bank_transaction', sourceId: id, lines: jl,
  });
  db.prepare('UPDATE bank_transactions SET journal_id = ? WHERE id = ?').run(journalId, id);
  return getBankTransaction(db, id);
}

function getBankTransaction(db, id) {
  const t = db.prepare(`SELECT bt.*, c.name AS contact_name, a.name AS bank_name FROM bank_transactions bt
    LEFT JOIN contacts c ON c.id = bt.contact_id
    JOIN accounts a ON a.id = bt.bank_account_id WHERE bt.id = ?`).get(id);
  if (!t) throw new Error('Transaction not found');
  t.lines = db.prepare(`SELECT l.*, a.name AS account_name, tr.name AS tax_name FROM bank_transaction_lines l
    LEFT JOIN accounts a ON a.id = l.account_id LEFT JOIN tax_rates tr ON tr.id = l.tax_rate_id
    WHERE l.bank_transaction_id = ? ORDER BY l.position`).all(id);
  return t;
}

function deleteBankTransaction(db, id) {
  const t = getBankTransaction(db, id);
  if (t.is_reconciled) throw new Error('Unreconcile before deleting');
  voidJournal(db, t.journal_id);
  db.prepare("UPDATE bank_transactions SET status='VOIDED' WHERE id=?").run(id);
  return { ok: true };
}

// ---------- transfers ----------

function saveTransfer(db, { fromAccountId, toAccountId, date, amountCents, reference = '' }) {
  amountCents = Math.round(amountCents);
  if (fromAccountId === toAccountId) throw new Error('Choose two different accounts');
  if (amountCents <= 0) throw new Error('Amount must be positive');
  const journalId = postJournal(db, {
    date, narration: `Transfer: ${reference || ''}`, sourceKind: 'transfer', sourceId: null,
    lines: [
      { accountId: toAccountId, description: 'Transfer in', debitCents: amountCents },
      { accountId: fromAccountId, description: 'Transfer out', creditCents: amountCents },
    ],
  });
  const r = db.prepare(`INSERT INTO transfers (from_account_id, to_account_id, date, amount_cents, reference, journal_id)
    VALUES (?,?,?,?,?,?)`).run(fromAccountId, toAccountId, date, amountCents, reference, journalId);
  db.prepare('UPDATE journals SET source_id = ? WHERE id = ?').run(Number(r.lastInsertRowid), journalId);
  return db.prepare('SELECT * FROM transfers WHERE id = ?').get(Number(r.lastInsertRowid));
}

// ---------- account transactions view ----------

// Unified money-in/out list for a bank account: payments, spend/receive, transfers.
function listAccountTransactions(db, bankAccountId) {
  const out = [];
  for (const p of db.prepare(`SELECT p.*, i.kind, i.number, c.name AS contact_name FROM payments p
      JOIN invoices i ON i.id = p.invoice_id JOIN contacts c ON c.id = i.contact_id
      WHERE p.bank_account_id = ?`).all(bankAccountId)) {
    out.push({
      kind: 'payment', id: p.id, date: p.date, reference: p.reference || p.number,
      description: `${p.kind === 'ACCREC' ? 'Payment from' : 'Payment to'} ${p.contact_name}`,
      amount_cents: p.kind === 'ACCREC' ? p.amount_cents : -p.amount_cents,
      is_reconciled: p.is_reconciled,
    });
  }
  for (const t of db.prepare(`SELECT bt.*, c.name AS contact_name FROM bank_transactions bt
      LEFT JOIN contacts c ON c.id = bt.contact_id
      WHERE bt.bank_account_id = ? AND bt.status = 'AUTHORISED'`).all(bankAccountId)) {
    out.push({
      kind: 'bank_transaction', id: t.id, date: t.date, reference: t.reference,
      description: `${t.kind === 'SPEND' ? 'Spent' : 'Received'}${t.contact_name ? ' - ' + t.contact_name : ''}`,
      amount_cents: t.kind === 'SPEND' ? -t.total_cents : t.total_cents,
      is_reconciled: t.is_reconciled,
    });
  }
  for (const tr of db.prepare(`SELECT t.*, fa.name AS from_name, ta.name AS to_name FROM transfers t
      JOIN accounts fa ON fa.id = t.from_account_id JOIN accounts ta ON ta.id = t.to_account_id
      WHERE t.from_account_id = ? OR t.to_account_id = ?`).all(bankAccountId, bankAccountId)) {
    const incoming = tr.to_account_id === bankAccountId;
    out.push({
      kind: 'transfer', id: tr.id, date: tr.date, reference: tr.reference,
      description: incoming ? `Transfer from ${tr.from_name}` : `Transfer to ${tr.to_name}`,
      amount_cents: incoming ? tr.amount_cents : -tr.amount_cents,
      is_reconciled: incoming ? tr.to_reconciled : tr.from_reconciled,
      direction: incoming ? 'in' : 'out',
    });
  }
  out.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  return out;
}

// ---------- statement import ----------

// Tolerant CSV parser: handles quoted fields and commas inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

function normaliseDate(s) {
  s = (s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (m) {
    // DD/MM/YYYY assumed; if first part > 12 it is definitely a day,
    // if second part > 12 treat as MM/DD/YYYY.
    let d = +m[1], mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

// Import a bank statement CSV. Expected columns (header names are matched
// loosely): Date, Payee/Description, Reference, Amount  — or  Date, ..., Debit, Credit.
function importStatement(db, { bankAccountId, csv }) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('CSV is empty');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const find = (...names) => header.findIndex(h => names.some(n => h.includes(n)));
  let ix = {
    date: find('date'),
    payee: find('payee', 'name', 'merchant'),
    desc: find('description', 'details', 'memo', 'narrative'),
    ref: find('reference', 'ref'),
    amount: find('amount', 'value'),
    debit: find('debit', 'paid out', 'money out', 'withdraw'),
    credit: find('credit', 'paid in', 'money in', 'deposit'),
  };
  let dataRows = rows.slice(1);
  if (ix.date === -1) {
    // No header row — assume Date, Payee, Description, Amount
    ix = { date: 0, payee: 1, desc: 2, ref: -1, amount: 3, debit: -1, credit: -1 };
    dataRows = rows;
  }
  const ins = db.prepare(`INSERT INTO statement_lines (bank_account_id, date, payee, description, reference, amount_cents)
    VALUES (?,?,?,?,?,?)`);
  let imported = 0, skipped = 0;
  for (const r of dataRows) {
    const date = normaliseDate(r[ix.date]);
    if (!date) { skipped++; continue; }
    let amount = 0;
    if (ix.amount !== -1 && (r[ix.amount] || '').trim() !== '') {
      amount = toCents(r[ix.amount]);
    } else if (ix.debit !== -1 || ix.credit !== -1) {
      const d = ix.debit !== -1 ? toCents(r[ix.debit]) : 0;
      const c = ix.credit !== -1 ? toCents(r[ix.credit]) : 0;
      amount = c - Math.abs(d);
    }
    if (amount === 0) { skipped++; continue; }
    ins.run(bankAccountId, date,
      ix.payee !== -1 ? (r[ix.payee] || '').trim() : '',
      ix.desc !== -1 ? (r[ix.desc] || '').trim() : '',
      ix.ref !== -1 ? (r[ix.ref] || '').trim() : '',
      amount);
    imported++;
  }
  return { imported, skipped };
}

function addStatementLine(db, { bankAccountId, date, payee = '', description = '', reference = '', amountCents }) {
  amountCents = Math.round(amountCents);
  if (!amountCents) throw new Error('Amount required');
  const r = db.prepare(`INSERT INTO statement_lines (bank_account_id, date, payee, description, reference, amount_cents)
    VALUES (?,?,?,?,?,?)`).run(bankAccountId, date, payee, description, reference, amountCents);
  return db.prepare('SELECT * FROM statement_lines WHERE id = ?').get(Number(r.lastInsertRowid));
}

function deleteStatementLine(db, id) {
  const sl = db.prepare('SELECT * FROM statement_lines WHERE id = ?').get(id);
  if (!sl) throw new Error('Statement line not found');
  if (sl.status === 'MATCHED') throw new Error('Unreconcile first');
  db.prepare('DELETE FROM statement_lines WHERE id = ?').run(id);
  return { ok: true };
}

// ---------- reconciliation ----------

// For each unmatched statement line, suggest unreconciled app transactions
// with the same amount (and rank by date proximity).
function reconcileData(db, bankAccountId) {
  const stmts = db.prepare(`SELECT * FROM statement_lines
    WHERE bank_account_id = ? AND status = 'UNMATCHED' ORDER BY date, id`).all(bankAccountId);
  const candidates = listAccountTransactions(db, bankAccountId).filter(t => !t.is_reconciled);
  const used = new Set();
  for (const s of stmts) {
    s.suggestions = candidates
      .filter(c => c.amount_cents === s.amount_cents && !used.has(c.kind + ':' + c.id + ':' + (c.direction || '')))
      .map(c => ({ ...c, daysApart: Math.abs((new Date(c.date) - new Date(s.date)) / 864e5) }))
      .sort((a, b) => a.daysApart - b.daysApart)
      .slice(0, 3);
    if (s.suggestions.length) {
      const top = s.suggestions[0];
      used.add(top.kind + ':' + top.id + ':' + (top.direction || ''));
    }
  }
  return { statementLines: stmts, unreconciledTransactions: candidates };
}

function matchStatementLine(db, { statementLineId, kind, id, direction = null }) {
  const sl = db.prepare('SELECT * FROM statement_lines WHERE id = ?').get(statementLineId);
  if (!sl) throw new Error('Statement line not found');
  if (sl.status === 'MATCHED') throw new Error('Already reconciled');
  if (kind === 'payment') {
    db.prepare('UPDATE payments SET is_reconciled = 1 WHERE id = ?').run(id);
  } else if (kind === 'bank_transaction') {
    db.prepare('UPDATE bank_transactions SET is_reconciled = 1 WHERE id = ?').run(id);
  } else if (kind === 'transfer') {
    db.prepare(`UPDATE transfers SET ${direction === 'in' ? 'to_reconciled' : 'from_reconciled'} = 1 WHERE id = ?`).run(id);
  } else throw new Error('Unknown transaction kind');
  db.prepare("UPDATE statement_lines SET status='MATCHED', matched_kind=?, matched_id=? WHERE id=?")
    .run(kind + (kind === 'transfer' ? ':' + direction : ''), id, statementLineId);
  return { ok: true };
}

// Create a spend/receive transaction directly from a statement line and match it.
function createAndMatch(db, { statementLineId, contactId = null, accountId, taxRateId = null, description = '' }) {
  const sl = db.prepare('SELECT * FROM statement_lines WHERE id = ?').get(statementLineId);
  if (!sl) throw new Error('Statement line not found');
  if (sl.status === 'MATCHED') throw new Error('Already reconciled');
  const kind = sl.amount_cents >= 0 ? 'RECEIVE' : 'SPEND';
  const t = saveBankTransaction(db, {
    kind, bankAccountId: sl.bank_account_id, contactId, date: sl.date,
    reference: sl.reference || sl.payee || sl.description,
    taxMode: taxRateId ? 'inclusive' : 'none',
    lines: [{
      description: description || sl.description || sl.payee || 'Bank transaction',
      qty: 1, unitPriceCents: Math.abs(sl.amount_cents), accountId, taxRateId,
    }],
  });
  return matchStatementLine(db, { statementLineId, kind: 'bank_transaction', id: t.id });
}

function unreconcile(db, statementLineId) {
  const sl = db.prepare('SELECT * FROM statement_lines WHERE id = ?').get(statementLineId);
  if (!sl || sl.status !== 'MATCHED') throw new Error('Line is not reconciled');
  const [kind, direction] = (sl.matched_kind || '').split(':');
  if (kind === 'payment') db.prepare('UPDATE payments SET is_reconciled = 0 WHERE id = ?').run(sl.matched_id);
  else if (kind === 'bank_transaction') db.prepare('UPDATE bank_transactions SET is_reconciled = 0 WHERE id = ?').run(sl.matched_id);
  else if (kind === 'transfer') db.prepare(`UPDATE transfers SET ${direction === 'in' ? 'to_reconciled' : 'from_reconciled'} = 0 WHERE id = ?`).run(sl.matched_id);
  db.prepare("UPDATE statement_lines SET status='UNMATCHED', matched_kind=NULL, matched_id=NULL WHERE id=?").run(statementLineId);
  return { ok: true };
}

module.exports = {
  listBankAccounts, createBankAccount, saveBankTransaction, getBankTransaction, deleteBankTransaction,
  saveTransfer, listAccountTransactions, importStatement, addStatementLine, deleteStatementLine,
  reconcileData, matchStatementLine, createAndMatch, unreconcile, parseCsv, normaliseDate,
};
