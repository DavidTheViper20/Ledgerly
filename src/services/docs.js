'use strict';

// Invoices (ACCREC), Bills (ACCPAY), Quotes and Payments.

const { calcLine, sumLines } = require('../money');
const { getSetting, setSetting, systemAccount } = require('../db');
const { postJournal, voidJournal } = require('./ledger');

const EDITABLE = new Set(['DRAFT', 'SUBMITTED']);

function taxRate(db, id) {
  if (!id) return 0;
  const r = db.prepare('SELECT rate FROM tax_rates WHERE id = ?').get(id);
  return r ? r.rate : 0;
}

function computeLines(db, lines, taxMode) {
  const out = [];
  for (const [i, l] of lines.entries()) {
    const rate = taxMode === 'none' ? 0 : taxRate(db, l.taxRateId);
    const c = calcLine({
      qty: Number(l.qty) || 0,
      unitPriceCents: Math.round(Number(l.unitPriceCents) || 0),
      discountPct: Number(l.discountPct) || 0,
      ratePct: rate,
      mode: taxMode,
    });
    out.push({ ...l, position: i, netCents: c.netCents, taxCents: c.taxCents });
  }
  return out;
}

function nextNumber(db, prefixKey, counterKey) {
  const prefix = getSetting(db, prefixKey) || '';
  const n = parseInt(getSetting(db, counterKey) || '1', 10);
  setSetting(db, counterKey, String(n + 1));
  return prefix + String(n).padStart(4, '0');
}

// ---------- invoices & bills ----------

function saveInvoice(db, data) {
  // data: { id?, kind, contactId, issueDate, dueDate, reference, number?, taxMode, lines: [...] }
  const lines = computeLines(db, data.lines.filter(l => l.description || l.unitPriceCents || l.accountId), data.taxMode);
  if (lines.length === 0) throw new Error('Add at least one line');
  for (const l of lines) {
    if (!l.accountId) throw new Error('Every line needs an account');
  }
  const totals = sumLines(lines);
  let id = data.id;
  if (id) {
    const existing = getInvoice(db, id);
    if (!EDITABLE.has(existing.status)) throw new Error(`Cannot edit a ${existing.status} document`);
    db.prepare(`UPDATE invoices SET contact_id=?, issue_date=?, due_date=?, reference=?, number=?,
      tax_mode=?, subtotal_cents=?, tax_cents=?, total_cents=?, updated_at=datetime('now') WHERE id=?`)
      .run(data.contactId, data.issueDate, data.dueDate, data.reference || '', data.number || existing.number,
        data.taxMode, totals.subtotalCents, totals.taxCents, totals.totalCents, id);
    db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(id);
  } else {
    const number = data.kind === 'ACCREC'
      ? (data.number || nextNumber(db, 'invoice_prefix', 'invoice_next_number'))
      : (data.number || '');
    const r = db.prepare(`INSERT INTO invoices (kind, number, reference, contact_id, issue_date, due_date,
      status, tax_mode, subtotal_cents, tax_cents, total_cents)
      VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`)
      .run(data.kind, number, data.reference || '', data.contactId, data.issueDate, data.dueDate,
        data.taxMode, totals.subtotalCents, totals.taxCents, totals.totalCents);
    id = Number(r.lastInsertRowid);
  }
  const ins = db.prepare(`INSERT INTO invoice_lines (invoice_id, item_id, description, qty, unit_price_cents,
    discount_pct, account_id, tax_rate_id, net_cents, tax_cents, position) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of lines) {
    ins.run(id, l.itemId || null, l.description || '', Number(l.qty) || 0, Math.round(Number(l.unitPriceCents) || 0),
      Number(l.discountPct) || 0, l.accountId, l.taxRateId || null, l.netCents, l.taxCents, l.position);
  }
  // Mark contact as customer/supplier
  db.prepare(`UPDATE contacts SET ${data.kind === 'ACCREC' ? 'is_customer' : 'is_supplier'} = 1 WHERE id = ?`)
    .run(data.contactId);
  return getInvoice(db, id);
}

function getInvoice(db, id) {
  const inv = db.prepare(`SELECT i.*, c.name AS contact_name FROM invoices i
    JOIN contacts c ON c.id = i.contact_id WHERE i.id = ?`).get(id);
  if (!inv) throw new Error('Document not found');
  inv.lines = db.prepare(`SELECT il.*, a.name AS account_name, a.code AS account_code, t.name AS tax_name, t.rate AS tax_rate
    FROM invoice_lines il
    LEFT JOIN accounts a ON a.id = il.account_id
    LEFT JOIN tax_rates t ON t.id = il.tax_rate_id
    WHERE il.invoice_id = ? ORDER BY il.position`).all(id);
  inv.payments = db.prepare(`SELECT p.*, a.name AS bank_name FROM payments p
    JOIN accounts a ON a.id = p.bank_account_id WHERE p.invoice_id = ? ORDER BY p.date`).all(id);
  return inv;
}

function listInvoices(db, { kind, status = null, contactId = null, search = null } = {}) {
  let sql = `SELECT i.*, c.name AS contact_name FROM invoices i
    JOIN contacts c ON c.id = i.contact_id WHERE i.kind = ?`;
  const params = [kind];
  if (status === 'OVERDUE') {
    sql += " AND i.status = 'AUTHORISED' AND i.due_date < date('now')";
  } else if (status) {
    sql += ' AND i.status = ?'; params.push(status);
  } else {
    sql += " AND i.status != 'VOIDED'";
  }
  if (contactId) { sql += ' AND i.contact_id = ?'; params.push(contactId); }
  if (search) {
    sql += ' AND (i.number LIKE ? OR i.reference LIKE ? OR c.name LIKE ?)';
    const s = `%${search}%`; params.push(s, s, s);
  }
  sql += ' ORDER BY i.issue_date DESC, i.id DESC LIMIT 500';
  return db.prepare(sql).all(...params);
}

function approveInvoice(db, id) {
  const inv = getInvoice(db, id);
  if (!EDITABLE.has(inv.status)) throw new Error(`Cannot approve a ${inv.status} document`);
  if (inv.total_cents <= 0) throw new Error('Document total must be greater than zero to approve');
  const isRec = inv.kind === 'ACCREC';
  const control = systemAccount(db, isRec ? 'AR' : 'AP');
  const taxAcc = systemAccount(db, 'TAX');

  const lines = [];
  // Control account for the full total
  lines.push({
    accountId: control.id, contactId: inv.contact_id,
    description: `${isRec ? 'Invoice' : 'Bill'} ${inv.number || inv.reference || '#' + id} - ${inv.contact_name}`,
    [isRec ? 'debitCents' : 'creditCents']: inv.total_cents,
  });
  for (const l of inv.lines) {
    if (l.net_cents !== 0) {
      // Revenue lines on an invoice are credits; negative lines (credit notes
      // within a document) flip side. Bills mirror this.
      const credit = isRec ? l.net_cents > 0 : l.net_cents < 0;
      lines.push({
        accountId: l.account_id, contactId: inv.contact_id, description: l.description,
        [credit ? 'creditCents' : 'debitCents']: Math.abs(l.net_cents),
      });
    }
  }
  if (inv.tax_cents !== 0) {
    const credit = isRec ? inv.tax_cents > 0 : inv.tax_cents < 0;
    lines.push({
      accountId: taxAcc.id, contactId: inv.contact_id, description: 'Tax',
      [credit ? 'creditCents' : 'debitCents']: Math.abs(inv.tax_cents),
    });
  }
  const journalId = postJournal(db, {
    date: inv.issue_date,
    narration: `${isRec ? 'Invoice' : 'Bill'} ${inv.number || inv.reference || '#' + id}`,
    sourceKind: 'invoice', sourceId: id, lines,
  });
  db.prepare("UPDATE invoices SET status='AUTHORISED', journal_id=?, updated_at=datetime('now') WHERE id=?")
    .run(journalId, id);
  return getInvoice(db, id);
}

function submitInvoice(db, id) {
  const inv = getInvoice(db, id);
  if (inv.status !== 'DRAFT') throw new Error('Only drafts can be submitted for approval');
  db.prepare("UPDATE invoices SET status='SUBMITTED', updated_at=datetime('now') WHERE id=?").run(id);
  return getInvoice(db, id);
}

function voidInvoice(db, id) {
  const inv = getInvoice(db, id);
  if (inv.status === 'VOIDED') return inv;
  if (inv.payments.length > 0) throw new Error('Remove payments before voiding');
  voidJournal(db, inv.journal_id);
  db.prepare("UPDATE invoices SET status='VOIDED', updated_at=datetime('now') WHERE id=?").run(id);
  return getInvoice(db, id);
}

function deleteDraftInvoice(db, id) {
  const inv = getInvoice(db, id);
  if (!EDITABLE.has(inv.status)) throw new Error('Only draft documents can be deleted');
  db.prepare('DELETE FROM invoice_lines WHERE invoice_id=?').run(id);
  db.prepare('DELETE FROM invoices WHERE id=?').run(id);
  return { ok: true };
}

function copyInvoice(db, id) {
  const inv = getInvoice(db, id);
  return saveInvoice(db, {
    kind: inv.kind, contactId: inv.contact_id,
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date().toISOString().slice(0, 10),
    reference: inv.reference, taxMode: inv.tax_mode,
    number: inv.kind === 'ACCPAY' ? '' : undefined,
    lines: inv.lines.map(l => ({
      itemId: l.item_id, description: l.description, qty: l.qty,
      unitPriceCents: l.unit_price_cents, discountPct: l.discount_pct,
      accountId: l.account_id, taxRateId: l.tax_rate_id,
    })),
  });
}

// ---------- payments ----------

function addPayment(db, { invoiceId, bankAccountId, date, amountCents, reference = '' }) {
  const inv = getInvoice(db, invoiceId);
  if (inv.status !== 'AUTHORISED' && inv.status !== 'PAID') throw new Error('Document must be approved before payment');
  amountCents = Math.round(amountCents);
  if (amountCents <= 0) throw new Error('Payment must be positive');
  const due = inv.total_cents - inv.paid_cents;
  if (amountCents > due) throw new Error('Payment exceeds amount due');
  const isRec = inv.kind === 'ACCREC';
  const control = systemAccount(db, isRec ? 'AR' : 'AP');
  const journalId = postJournal(db, {
    date, narration: `Payment: ${inv.number || inv.reference || '#' + invoiceId}`,
    sourceKind: 'payment', sourceId: null,
    lines: isRec ? [
      { accountId: bankAccountId, contactId: inv.contact_id, description: 'Payment received', debitCents: amountCents },
      { accountId: control.id, contactId: inv.contact_id, description: 'Payment received', creditCents: amountCents },
    ] : [
      { accountId: control.id, contactId: inv.contact_id, description: 'Payment made', debitCents: amountCents },
      { accountId: bankAccountId, contactId: inv.contact_id, description: 'Payment made', creditCents: amountCents },
    ],
  });
  const r = db.prepare(`INSERT INTO payments (invoice_id, bank_account_id, date, amount_cents, reference, journal_id)
    VALUES (?,?,?,?,?,?)`).run(invoiceId, bankAccountId, date, amountCents, reference, journalId);
  db.prepare('UPDATE journals SET source_id = ? WHERE id = ?').run(Number(r.lastInsertRowid), journalId);
  const paid = inv.paid_cents + amountCents;
  db.prepare(`UPDATE invoices SET paid_cents=?, status=?, updated_at=datetime('now') WHERE id=?`)
    .run(paid, paid >= inv.total_cents ? 'PAID' : 'AUTHORISED', invoiceId);
  return getInvoice(db, invoiceId);
}

function removePayment(db, paymentId) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) throw new Error('Payment not found');
  if (p.is_reconciled) throw new Error('Unreconcile the bank statement line first');
  voidJournal(db, p.journal_id);
  db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId);
  const inv = getInvoice(db, p.invoice_id);
  const paid = inv.payments.reduce((s, x) => s + x.amount_cents, 0);
  db.prepare(`UPDATE invoices SET paid_cents=?, status=?, updated_at=datetime('now') WHERE id=?`)
    .run(paid, paid >= inv.total_cents ? 'PAID' : 'AUTHORISED', p.invoice_id);
  return getInvoice(db, p.invoice_id);
}

// ---------- quotes ----------

function saveQuote(db, data) {
  const lines = computeLines(db, data.lines.filter(l => l.description || l.unitPriceCents || l.accountId), data.taxMode);
  if (lines.length === 0) throw new Error('Add at least one line');
  const totals = sumLines(lines);
  let id = data.id;
  if (id) {
    const q = getQuote(db, id);
    if (q.status === 'INVOICED') throw new Error('Cannot edit an invoiced quote');
    db.prepare(`UPDATE quotes SET contact_id=?, issue_date=?, expiry_date=?, reference=?, title=?, summary=?,
      tax_mode=?, subtotal_cents=?, tax_cents=?, total_cents=?, updated_at=datetime('now') WHERE id=?`)
      .run(data.contactId, data.issueDate, data.expiryDate || null, data.reference || '', data.title || '',
        data.summary || '', data.taxMode, totals.subtotalCents, totals.taxCents, totals.totalCents, id);
    db.prepare('DELETE FROM quote_lines WHERE quote_id = ?').run(id);
  } else {
    const number = nextNumber(db, 'quote_prefix', 'quote_next_number');
    const r = db.prepare(`INSERT INTO quotes (number, title, summary, reference, contact_id, issue_date, expiry_date,
      status, tax_mode, subtotal_cents, tax_cents, total_cents) VALUES (?,?,?,?,?,?,?, 'DRAFT', ?,?,?,?)`)
      .run(number, data.title || '', data.summary || '', data.reference || '', data.contactId,
        data.issueDate, data.expiryDate || null, data.taxMode, totals.subtotalCents, totals.taxCents, totals.totalCents);
    id = Number(r.lastInsertRowid);
  }
  const ins = db.prepare(`INSERT INTO quote_lines (quote_id, item_id, description, qty, unit_price_cents,
    discount_pct, account_id, tax_rate_id, net_cents, tax_cents, position) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of lines) {
    ins.run(id, l.itemId || null, l.description || '', Number(l.qty) || 0, Math.round(Number(l.unitPriceCents) || 0),
      Number(l.discountPct) || 0, l.accountId || null, l.taxRateId || null, l.netCents, l.taxCents, l.position);
  }
  return getQuote(db, id);
}

function getQuote(db, id) {
  const q = db.prepare(`SELECT q.*, c.name AS contact_name FROM quotes q
    JOIN contacts c ON c.id = q.contact_id WHERE q.id = ?`).get(id);
  if (!q) throw new Error('Quote not found');
  q.lines = db.prepare(`SELECT ql.*, a.name AS account_name, t.name AS tax_name, t.rate AS tax_rate
    FROM quote_lines ql LEFT JOIN accounts a ON a.id = ql.account_id
    LEFT JOIN tax_rates t ON t.id = ql.tax_rate_id
    WHERE ql.quote_id = ? ORDER BY ql.position`).all(id);
  return q;
}

function listQuotes(db, { status = null, search = null } = {}) {
  let sql = `SELECT q.*, c.name AS contact_name FROM quotes q JOIN contacts c ON c.id = q.contact_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND q.status = ?'; params.push(status); }
  if (search) { sql += ' AND (q.number LIKE ? OR q.title LIKE ? OR c.name LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
  sql += ' ORDER BY q.issue_date DESC, q.id DESC LIMIT 500';
  return db.prepare(sql).all(...params);
}

function setQuoteStatus(db, id, status) {
  const allowed = ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED'];
  if (!allowed.includes(status)) throw new Error('Invalid quote status');
  const q = getQuote(db, id);
  if (q.status === 'INVOICED') throw new Error('Quote already invoiced');
  db.prepare("UPDATE quotes SET status=?, updated_at=datetime('now') WHERE id=?").run(status, id);
  return getQuote(db, id);
}

function quoteToInvoice(db, id) {
  const q = getQuote(db, id);
  if (q.status === 'INVOICED') throw new Error('Quote already invoiced');
  const dueDays = parseInt(getSetting(db, 'default_due_days') || '14', 10);
  const issue = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + dueDays * 864e5).toISOString().slice(0, 10);
  const inv = saveInvoice(db, {
    kind: 'ACCREC', contactId: q.contact_id, issueDate: issue, dueDate: due,
    reference: q.number, taxMode: q.tax_mode,
    lines: q.lines.map(l => ({
      itemId: l.item_id, description: l.description, qty: l.qty, unitPriceCents: l.unit_price_cents,
      discountPct: l.discount_pct, accountId: l.account_id, taxRateId: l.tax_rate_id,
    })),
  });
  db.prepare("UPDATE quotes SET status='INVOICED', invoice_id=?, updated_at=datetime('now') WHERE id=?").run(inv.id, id);
  return inv;
}

function deleteQuote(db, id) {
  const q = getQuote(db, id);
  if (q.status === 'INVOICED') throw new Error('Cannot delete an invoiced quote');
  db.prepare('DELETE FROM quote_lines WHERE quote_id=?').run(id);
  db.prepare('DELETE FROM quotes WHERE id=?').run(id);
  return { ok: true };
}

module.exports = {
  saveInvoice, getInvoice, listInvoices, approveInvoice, submitInvoice, voidInvoice,
  deleteDraftInvoice, copyInvoice, addPayment, removePayment,
  saveQuote, getQuote, listQuotes, setQuoteStatus, quoteToInvoice, deleteQuote,
};
