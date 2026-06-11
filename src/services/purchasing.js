'use strict';

// Purchase orders: DRAFT -> APPROVED -> BILLED (or CANCELLED).

const { calcLine, sumLines } = require('../money');
const { getSetting, setSetting } = require('../db');
const docs = require('./docs');

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
      qty: Number(l.qty) || 0, unitPriceCents: Math.round(Number(l.unitPriceCents) || 0),
      discountPct: Number(l.discountPct) || 0, ratePct: rate, mode: taxMode,
    });
    out.push({ ...l, position: i, netCents: c.netCents, taxCents: c.taxCents });
  }
  return out;
}

function savePO(db, data) {
  const lines = computeLines(db, data.lines.filter(l => l.description || l.unitPriceCents || l.accountId), data.taxMode);
  if (!lines.length) throw new Error('Add at least one line');
  const totals = sumLines(lines);
  let id = data.id;
  if (id) {
    const po = getPO(db, id);
    if (po.status === 'BILLED') throw new Error('Cannot edit a billed purchase order');
    db.prepare(`UPDATE purchase_orders SET contact_id=?, issue_date=?, delivery_date=?, delivery_address=?,
      reference=?, tax_mode=?, subtotal_cents=?, tax_cents=?, total_cents=? WHERE id=?`)
      .run(data.contactId, data.issueDate, data.deliveryDate || null, data.deliveryAddress || '',
        data.reference || '', data.taxMode, totals.subtotalCents, totals.taxCents, totals.totalCents, id);
    db.prepare('DELETE FROM purchase_order_lines WHERE purchase_order_id=?').run(id);
  } else {
    const prefix = getSetting(db, 'po_prefix') || 'PO-';
    const n = parseInt(getSetting(db, 'po_next_number') || '1', 10);
    setSetting(db, 'po_next_number', String(n + 1));
    const number = prefix + String(n).padStart(4, '0');
    const r = db.prepare(`INSERT INTO purchase_orders (number, reference, contact_id, issue_date, delivery_date,
      delivery_address, status, tax_mode, subtotal_cents, tax_cents, total_cents)
      VALUES (?,?,?,?,?,?,'DRAFT',?,?,?,?)`)
      .run(number, data.reference || '', data.contactId, data.issueDate, data.deliveryDate || null,
        data.deliveryAddress || '', data.taxMode, totals.subtotalCents, totals.taxCents, totals.totalCents);
    id = Number(r.lastInsertRowid);
  }
  const ins = db.prepare(`INSERT INTO purchase_order_lines (purchase_order_id, item_id, description, qty,
    unit_price_cents, discount_pct, account_id, tax_rate_id, net_cents, tax_cents, position)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of lines) {
    ins.run(id, l.itemId || null, l.description || '', Number(l.qty) || 0, Math.round(Number(l.unitPriceCents) || 0),
      Number(l.discountPct) || 0, l.accountId || null, l.taxRateId || null, l.netCents, l.taxCents, l.position);
  }
  db.prepare('UPDATE contacts SET is_supplier = 1 WHERE id = ?').run(data.contactId);
  return getPO(db, id);
}

function getPO(db, id) {
  const po = db.prepare(`SELECT po.*, c.name AS contact_name FROM purchase_orders po
    JOIN contacts c ON c.id = po.contact_id WHERE po.id = ?`).get(id);
  if (!po) throw new Error('Purchase order not found');
  po.lines = db.prepare(`SELECT l.*, a.name AS account_name, t.name AS tax_name FROM purchase_order_lines l
    LEFT JOIN accounts a ON a.id = l.account_id LEFT JOIN tax_rates t ON t.id = l.tax_rate_id
    WHERE l.purchase_order_id = ? ORDER BY l.position`).all(id);
  return po;
}

function listPOs(db, { status = null, search = null } = {}) {
  let sql = `SELECT po.*, c.name AS contact_name FROM purchase_orders po
    JOIN contacts c ON c.id = po.contact_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND po.status = ?'; params.push(status); }
  if (search) { sql += ' AND (po.number LIKE ? OR c.name LIKE ?)'; const s = `%${search}%`; params.push(s, s); }
  return db.prepare(sql + ' ORDER BY po.issue_date DESC, po.id DESC LIMIT 500').all(...params);
}

function setPOStatus(db, id, status) {
  if (!['DRAFT', 'SENT', 'APPROVED', 'CANCELLED'].includes(status)) throw new Error('Invalid status');
  const po = getPO(db, id);
  if (po.status === 'BILLED') throw new Error('Purchase order is already billed');
  db.prepare('UPDATE purchase_orders SET status=? WHERE id=?').run(status, id);
  return getPO(db, id);
}

function poToBill(db, id) {
  const po = getPO(db, id);
  if (po.status === 'BILLED') throw new Error('Already billed');
  const dueDays = parseInt(getSetting(db, 'default_due_days') || '14', 10);
  const issue = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + dueDays * 864e5).toISOString().slice(0, 10);
  const bill = docs.saveInvoice(db, {
    kind: 'ACCPAY', contactId: po.contact_id, issueDate: issue, dueDate: due,
    reference: po.number, taxMode: po.tax_mode,
    lines: po.lines.map(l => ({
      itemId: l.item_id, description: l.description, qty: l.qty, unitPriceCents: l.unit_price_cents,
      discountPct: l.discount_pct, accountId: l.account_id, taxRateId: l.tax_rate_id,
    })),
  });
  db.prepare("UPDATE purchase_orders SET status='BILLED', bill_id=? WHERE id=?").run(bill.id, id);
  return bill;
}

function deletePO(db, id) {
  const po = getPO(db, id);
  if (po.status === 'BILLED') throw new Error('Cannot delete a billed purchase order');
  db.prepare('DELETE FROM purchase_order_lines WHERE purchase_order_id=?').run(id);
  db.prepare('DELETE FROM purchase_orders WHERE id=?').run(id);
  return { ok: true };
}

// ---------- repeating invoices ----------

function saveRepeating(db, data) {
  const lines = JSON.stringify(data.lines.filter(l => l.description || l.unitPriceCents || l.accountId));
  if (lines === '[]') throw new Error('Add at least one line');
  if (!data.nextDate) throw new Error('Next invoice date is required');
  const every = Math.max(1, parseInt(data.scheduleEvery, 10) || 1);
  const unit = data.scheduleUnit === 'WEEK' ? 'WEEK' : 'MONTH';
  if (data.id) {
    db.prepare(`UPDATE repeating_invoices SET kind=?, contact_id=?, reference=?, tax_mode=?, lines_json=?,
      schedule_every=?, schedule_unit=?, next_date=?, end_date=?, due_days=?, auto_approve=? WHERE id=?`)
      .run(data.kind || 'ACCREC', data.contactId, data.reference || '', data.taxMode, lines,
        every, unit, data.nextDate, data.endDate || null, parseInt(data.dueDays, 10) || 14,
        data.autoApprove ? 1 : 0, data.id);
    return getRepeating(db, data.id);
  }
  const r = db.prepare(`INSERT INTO repeating_invoices (kind, contact_id, reference, tax_mode, lines_json,
    schedule_every, schedule_unit, next_date, end_date, due_days, auto_approve)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(data.kind || 'ACCREC', data.contactId, data.reference || '', data.taxMode, lines,
      every, unit, data.nextDate, data.endDate || null, parseInt(data.dueDays, 10) || 14, data.autoApprove ? 1 : 0);
  return getRepeating(db, Number(r.lastInsertRowid));
}

function getRepeating(db, id) {
  const r = db.prepare(`SELECT ri.*, c.name AS contact_name FROM repeating_invoices ri
    JOIN contacts c ON c.id = ri.contact_id WHERE ri.id = ?`).get(id);
  if (!r) throw new Error('Repeating template not found');
  r.lines = JSON.parse(r.lines_json);
  return r;
}

function listRepeating(db) {
  const rows = db.prepare(`SELECT ri.*, c.name AS contact_name FROM repeating_invoices ri
    JOIN contacts c ON c.id = ri.contact_id ORDER BY ri.next_date`).all();
  for (const r of rows) r.lines = JSON.parse(r.lines_json);
  return rows;
}

function setRepeatingStatus(db, id, status) {
  if (!['ACTIVE', 'PAUSED'].includes(status)) throw new Error('Invalid status');
  db.prepare('UPDATE repeating_invoices SET status=? WHERE id=?').run(status, id);
  return getRepeating(db, id);
}

function deleteRepeating(db, id) {
  db.prepare('DELETE FROM repeating_invoices WHERE id=?').run(id);
  return { ok: true };
}

function advance(dateStr, every, unit) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (unit === 'WEEK') d.setUTCDate(d.getUTCDate() + 7 * every);
  else d.setUTCMonth(d.getUTCMonth() + every);
  return d.toISOString().slice(0, 10);
}

// Generates all invoices that have fallen due. Returns the documents created.
function generateDueRepeating(db, asOf = null) {
  asOf = asOf || new Date().toISOString().slice(0, 10);
  const created = [];
  for (const t of listRepeating(db)) {
    if (t.status !== 'ACTIVE') continue;
    let next = t.next_date;
    let guard = 0;
    while (next <= asOf && (!t.end_date || next <= t.end_date) && guard++ < 120) {
      const due = new Date(new Date(next + 'T00:00:00Z').getTime() + t.due_days * 864e5).toISOString().slice(0, 10);
      let inv = docs.saveInvoice(db, {
        kind: t.kind, contactId: t.contact_id, issueDate: next, dueDate: due,
        reference: t.reference, taxMode: t.tax_mode, lines: t.lines,
      });
      if (t.auto_approve) inv = docs.approveInvoice(db, inv.id);
      created.push(inv);
      next = advance(next, t.schedule_every, t.schedule_unit);
    }
    if (next !== t.next_date) db.prepare('UPDATE repeating_invoices SET next_date=? WHERE id=?').run(next, t.id);
  }
  return { created: created.length, documents: created.map(d => ({ id: d.id, number: d.number })) };
}

module.exports = {
  savePO, getPO, listPOs, setPOStatus, poToBill, deletePO,
  saveRepeating, getRepeating, listRepeating, setRepeatingStatus, deleteRepeating, generateDueRepeating,
};
