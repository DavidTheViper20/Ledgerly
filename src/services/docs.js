'use strict';

// Invoices (ACCREC), Bills (ACCPAY), Credit notes (ACCRECCREDIT/ACCPAYCREDIT),
// Quotes and Payments. Foreign-currency documents store amounts in the document
// currency; ledger postings convert to the base currency at the document rate,
// with realised FX differences posted on settlement.

const { round, calcLine, sumLines } = require('../money');
const { getSetting, setSetting, systemAccount } = require('../db');
const { postJournal, voidJournal } = require('./ledger');

const EDITABLE = new Set(['DRAFT', 'SUBMITTED']);
const RECEIVABLE = new Set(['ACCREC', 'ACCRECCREDIT']);
const CREDIT = new Set(['ACCRECCREDIT', 'ACCPAYCREDIT']);

// True when approving this kind debits the control account (AR/AP).
function debitsControl(kind) {
  return kind === 'ACCREC' || kind === 'ACCPAYCREDIT';
}

function toBase(cents, rate) { return round(cents * (rate || 1)); }

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
  const baseCur = getSetting(db, 'base_currency') || 'AUD';
  let currency = (data.currency || baseCur).toUpperCase();
  if (currency === baseCur) currency = '';
  const rate = currency ? (Number(data.exchangeRate) || 0) : 1;
  if (currency && rate <= 0) throw new Error('Foreign currency documents need a positive exchange rate');
  let id = data.id;
  if (id) {
    const existing = getInvoice(db, id);
    if (!EDITABLE.has(existing.status)) throw new Error(`Cannot edit a ${existing.status} document`);
    db.prepare(`UPDATE invoices SET contact_id=?, issue_date=?, due_date=?, reference=?, number=?,
      tax_mode=?, subtotal_cents=?, tax_cents=?, total_cents=?, currency=?, exchange_rate=?,
      updated_at=datetime('now') WHERE id=?`)
      .run(data.contactId, data.issueDate, data.dueDate, data.reference || '', data.number || existing.number,
        data.taxMode, totals.subtotalCents, totals.taxCents, totals.totalCents, currency, rate, id);
    db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(id);
  } else {
    let number = data.number || '';
    if (!number) {
      if (data.kind === 'ACCREC') number = nextNumber(db, 'invoice_prefix', 'invoice_next_number');
      else if (data.kind === 'ACCRECCREDIT') number = nextNumber(db, 'credit_prefix', 'credit_next_number');
    }
    const r = db.prepare(`INSERT INTO invoices (kind, number, reference, contact_id, issue_date, due_date,
      status, tax_mode, subtotal_cents, tax_cents, total_cents, currency, exchange_rate)
      VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`)
      .run(data.kind, number, data.reference || '', data.contactId, data.issueDate, data.dueDate,
        data.taxMode, totals.subtotalCents, totals.taxCents, totals.totalCents, currency, rate);
    id = Number(r.lastInsertRowid);
  }
  const ins = db.prepare(`INSERT INTO invoice_lines (invoice_id, item_id, description, qty, unit_price_cents,
    discount_pct, account_id, tax_rate_id, net_cents, tax_cents, position, project_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of lines) {
    ins.run(id, l.itemId || null, l.description || '', Number(l.qty) || 0, Math.round(Number(l.unitPriceCents) || 0),
      Number(l.discountPct) || 0, l.accountId, l.taxRateId || null, l.netCents, l.taxCents, l.position, l.projectId || null);
  }
  // Mark contact as customer/supplier
  db.prepare(`UPDATE contacts SET ${RECEIVABLE.has(data.kind) ? 'is_customer' : 'is_supplier'} = 1 WHERE id = ?`)
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
  // Credit allocations involving this document (as credit or as invoice).
  inv.allocations = db.prepare(`SELECT ca.*, ci.number AS credit_number, ii.number AS invoice_number,
      ii.reference AS invoice_reference
    FROM credit_allocations ca
    JOIN invoices ci ON ci.id = ca.credit_id
    JOIN invoices ii ON ii.id = ca.invoice_id
    WHERE ca.credit_id = ? OR ca.invoice_id = ? ORDER BY ca.date`).all(id, id);
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

const KIND_LABELS = {
  ACCREC: 'Invoice', ACCPAY: 'Bill', ACCRECCREDIT: 'Credit note', ACCPAYCREDIT: 'Supplier credit',
};

function approveInvoice(db, id) {
  const inv = getInvoice(db, id);
  if (!EDITABLE.has(inv.status)) throw new Error(`Cannot approve a ${inv.status} document`);
  if (inv.total_cents <= 0) throw new Error('Document total must be greater than zero to approve');
  const isRec = RECEIVABLE.has(inv.kind);
  const drControl = debitsControl(inv.kind);
  const control = systemAccount(db, isRec ? 'AR' : 'AP');
  const taxAcc = systemAccount(db, 'TAX');
  const rate = inv.exchange_rate || 1;
  const label = KIND_LABELS[inv.kind] || 'Document';

  // Convert each component to base currency; the control line is the sum of
  // the converted components so the journal always balances exactly.
  const lines = [];
  let controlBase = 0;
  for (const l of inv.lines) {
    if (l.net_cents !== 0) {
      const base = toBase(l.net_cents, rate);
      controlBase += base;
      const credit = drControl ? base > 0 : base < 0;
      lines.push({
        accountId: l.account_id, contactId: inv.contact_id, description: l.description,
        [credit ? 'creditCents' : 'debitCents']: Math.abs(base),
      });
    }
  }
  if (inv.tax_cents !== 0) {
    const base = toBase(inv.tax_cents, rate);
    controlBase += base;
    const credit = drControl ? base > 0 : base < 0;
    lines.push({
      accountId: taxAcc.id, contactId: inv.contact_id, description: 'GST',
      [credit ? 'creditCents' : 'debitCents']: Math.abs(base),
    });
  }
  lines.unshift({
    accountId: control.id, contactId: inv.contact_id,
    description: `${label} ${inv.number || inv.reference || '#' + id} - ${inv.contact_name}`,
    [drControl ? 'debitCents' : 'creditCents']: controlBase,
  });
  const journalId = postJournal(db, {
    date: inv.issue_date,
    narration: `${label} ${inv.number || inv.reference || '#' + id}`,
    sourceKind: 'invoice', sourceId: id, lines,
  });
  db.prepare(`UPDATE invoices SET status='AUTHORISED', journal_id=?, base_total_cents=?,
    updated_at=datetime('now') WHERE id=?`).run(journalId, controlBase, id);
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
  if (inv.allocations.length > 0) throw new Error('Remove credit allocations before voiding');
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

// Settles part of an approved document. For invoices/bills this is a payment;
// for credit notes it is a cash refund (sides reversed).
// For foreign-currency documents amountCents is in the document currency and
// exchangeRate is the rate at payment date; realised FX goes to the FX account.
function addPayment(db, { invoiceId, bankAccountId, date, amountCents, reference = '', exchangeRate = null }) {
  const inv = getInvoice(db, invoiceId);
  if (inv.status !== 'AUTHORISED' && inv.status !== 'PAID') throw new Error('Document must be approved before payment');
  amountCents = Math.round(amountCents);
  if (amountCents <= 0) throw new Error('Payment must be positive');
  const due = inv.total_cents - inv.paid_cents;
  if (amountCents > due) throw new Error('Payment exceeds amount due');

  const isRec = RECEIVABLE.has(inv.kind);
  const isCredit = CREDIT.has(inv.kind);
  const control = systemAccount(db, isRec ? 'AR' : 'AP');
  const docRate = inv.exchange_rate || 1;
  const payRate = inv.currency ? (Number(exchangeRate) || docRate) : 1;
  if (payRate <= 0) throw new Error('Exchange rate must be positive');

  // Base amounts: what hits the bank vs what relieves the control account.
  const bankBase = toBase(amountCents, payRate);
  const baseTotal = inv.base_total_cents != null ? inv.base_total_cents : inv.total_cents;
  const relievedSoFar = db.prepare(
    'SELECT COALESCE(SUM(ar_relief_base_cents),0) AS s FROM payments WHERE invoice_id = ?').get(invoiceId).s
    + allocationReliefBase(db, inv);
  const isFinal = amountCents === due;
  const reliefBase = isFinal ? baseTotal - relievedSoFar : toBase(amountCents, docRate);
  const fx = bankBase - reliefBase; // for receivable money-in: + = gain

  // Money direction: invoices receive into bank, credit notes refund out (and
  // vice versa on the payable side).
  const moneyIn = isRec ? !isCredit : isCredit;
  const desc = isCredit ? 'Refund' : (isRec ? 'Payment received' : 'Payment made');
  const lines = [
    { accountId: bankAccountId, contactId: inv.contact_id, description: desc,
      [moneyIn ? 'debitCents' : 'creditCents']: bankBase },
    { accountId: control.id, contactId: inv.contact_id, description: desc,
      [moneyIn ? 'creditCents' : 'debitCents']: reliefBase },
  ];
  if (fx !== 0) {
    const fxAcc = systemAccount(db, 'FX');
    // Balance the journal: whatever difference remains goes to FX.
    const drTotal = lines.reduce((s, l) => s + (l.debitCents || 0), 0);
    const crTotal = lines.reduce((s, l) => s + (l.creditCents || 0), 0);
    const diff = drTotal - crTotal;
    lines.push({ accountId: fxAcc.id, description: 'Realised currency ' + (diff < 0 ? 'gain' : 'loss'),
      [diff < 0 ? 'debitCents' : 'creditCents']: Math.abs(diff) });
  }
  const journalId = postJournal(db, {
    date, narration: `${isCredit ? 'Refund' : 'Payment'}: ${inv.number || inv.reference || '#' + invoiceId}`,
    sourceKind: 'payment', sourceId: null, lines,
  });
  const r = db.prepare(`INSERT INTO payments (invoice_id, bank_account_id, date, amount_cents, reference,
    journal_id, exchange_rate, base_amount_cents, ar_relief_base_cents) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(invoiceId, bankAccountId, date, amountCents, reference, journalId, payRate, bankBase, reliefBase);
  db.prepare('UPDATE journals SET source_id = ? WHERE id = ?').run(Number(r.lastInsertRowid), journalId);
  settleStatus(db, invoiceId);
  return getInvoice(db, invoiceId);
}

// Sum of base-currency control relief already recorded through allocations.
function allocationReliefBase(db, inv) {
  const rate = inv.exchange_rate || 1;
  const rows = db.prepare(
    'SELECT COALESCE(SUM(amount_cents),0) AS s FROM credit_allocations WHERE credit_id = ? OR invoice_id = ?')
    .get(inv.id, inv.id);
  return toBase(rows.s, rate);
}

// Recompute paid_cents (payments + allocations) and status for a document.
function settleStatus(db, invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE invoice_id=?').get(invoiceId).s;
  const alloc = db.prepare(
    'SELECT COALESCE(SUM(amount_cents),0) AS s FROM credit_allocations WHERE credit_id = ? OR invoice_id = ?')
    .get(invoiceId, invoiceId).s;
  const settled = paid + alloc;
  const status = inv.status === 'VOIDED' ? 'VOIDED' : (settled >= inv.total_cents ? 'PAID' : 'AUTHORISED');
  db.prepare(`UPDATE invoices SET paid_cents=?, status=?, updated_at=datetime('now') WHERE id=?`)
    .run(settled, status, invoiceId);
}

function removePayment(db, paymentId) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) throw new Error('Payment not found');
  if (p.is_reconciled) throw new Error('Unreconcile the bank statement line first');
  voidJournal(db, p.journal_id);
  db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId);
  settleStatus(db, p.invoice_id);
  return getInvoice(db, p.invoice_id);
}

// ---------- credit note allocation ----------

function allocateCredit(db, { creditId, invoiceId, amountCents, date }) {
  const credit = getInvoice(db, creditId);
  const inv = getInvoice(db, invoiceId);
  if (!CREDIT.has(credit.kind)) throw new Error('Not a credit note');
  const target = credit.kind === 'ACCRECCREDIT' ? 'ACCREC' : 'ACCPAY';
  if (inv.kind !== target) throw new Error(`This credit can only be applied to a ${KIND_LABELS[target].toLowerCase()}`);
  if (credit.contact_id !== inv.contact_id) throw new Error('Credit and document must be for the same contact');
  if ((credit.currency || '') !== (inv.currency || '')) throw new Error('Credit and document must be in the same currency');
  for (const d of [credit, inv]) {
    if (d.status !== 'AUTHORISED') throw new Error(`${KIND_LABELS[d.kind]} must be awaiting payment to allocate`);
  }
  amountCents = Math.round(amountCents);
  const creditRemaining = credit.total_cents - credit.paid_cents;
  const invRemaining = inv.total_cents - inv.paid_cents;
  if (amountCents <= 0) throw new Error('Allocation must be positive');
  if (amountCents > creditRemaining) throw new Error('Allocation exceeds credit remaining');
  if (amountCents > invRemaining) throw new Error('Allocation exceeds amount due on the document');

  db.prepare('INSERT INTO credit_allocations (credit_id, invoice_id, date, amount_cents) VALUES (?,?,?,?)')
    .run(creditId, invoiceId, date, amountCents);

  // Same-currency, same-rate allocations net out inside AR/AP with no journal.
  // If document rates differ, post the realised FX difference.
  const invRelief = toBase(amountCents, inv.exchange_rate || 1);
  const credRelief = toBase(amountCents, credit.exchange_rate || 1);
  if (invRelief !== credRelief) {
    const isRec = RECEIVABLE.has(credit.kind);
    const control = systemAccount(db, isRec ? 'AR' : 'AP');
    const fxAcc = systemAccount(db, 'FX');
    const diff = invRelief - credRelief;
    // Receivable: invoice relief credits AR, credit relief debits AR, so the
    // net AR movement is CR when diff>0. Payable mirrors this (DR when diff>0).
    const controlCredits = isRec ? diff > 0 : diff < 0;
    postJournal(db, {
      date, narration: `Credit allocation FX: ${credit.number} -> ${inv.number || inv.reference}`,
      sourceKind: 'payment', sourceId: null,
      lines: [
        { accountId: control.id, contactId: inv.contact_id, description: 'Credit allocation',
          [controlCredits ? 'creditCents' : 'debitCents']: Math.abs(diff) },
        { accountId: fxAcc.id, description: 'Realised currency ' + (controlCredits ? 'loss' : 'gain'),
          [controlCredits ? 'debitCents' : 'creditCents']: Math.abs(diff) },
      ],
    });
  }
  settleStatus(db, creditId);
  settleStatus(db, invoiceId);
  return getInvoice(db, creditId);
}

function removeAllocation(db, allocationId) {
  const a = db.prepare('SELECT * FROM credit_allocations WHERE id = ?').get(allocationId);
  if (!a) throw new Error('Allocation not found');
  db.prepare('DELETE FROM credit_allocations WHERE id = ?').run(allocationId);
  settleStatus(db, a.credit_id);
  settleStatus(db, a.invoice_id);
  return { ok: true };
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
  deleteDraftInvoice, copyInvoice, addPayment, removePayment, allocateCredit, removeAllocation,
  settleStatus, KIND_LABELS,
  saveQuote, getQuote, listQuotes, setQuoteStatus, quoteToInvoice, deleteQuote,
};
