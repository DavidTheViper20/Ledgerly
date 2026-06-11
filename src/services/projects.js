'use strict';

// Projects, time tracking and project profitability.

const { round } = require('../money');
const docs = require('./docs');
const { getSetting } = require('../db');

function saveProject(db, d) {
  if (!d.name) throw new Error('Project name is required');
  if (d.id) {
    db.prepare('UPDATE projects SET name=?, contact_id=?, hourly_rate_cents=?, status=? WHERE id=?')
      .run(d.name, d.contactId || null, Math.round(Number(d.hourlyRateCents) || 0), d.status || 'ACTIVE', d.id);
    return getProject(db, d.id);
  }
  const r = db.prepare('INSERT INTO projects (name, contact_id, hourly_rate_cents) VALUES (?,?,?)')
    .run(d.name, d.contactId || null, Math.round(Number(d.hourlyRateCents) || 0));
  return getProject(db, Number(r.lastInsertRowid));
}

function getProject(db, id) {
  const p = db.prepare(`SELECT p.*, c.name AS contact_name FROM projects p
    LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.id = ?`).get(id);
  if (!p) throw new Error('Project not found');
  Object.assign(p, profitability(db, id));
  p.time_entries = db.prepare(`SELECT te.*, i.number AS invoice_number FROM time_entries te
    LEFT JOIN invoices i ON i.id = te.invoice_id
    WHERE te.project_id = ? ORDER BY te.date DESC, te.id DESC`).all(id);
  p.unbilled_hours = p.time_entries.filter(t => t.billable && !t.invoice_id).reduce((s, t) => s + t.hours, 0);
  p.unbilled_cents = p.time_entries.filter(t => t.billable && !t.invoice_id)
    .reduce((s, t) => s + round(t.hours * t.rate_cents), 0);
  return p;
}

function listProjects(db, { status = null } = {}) {
  let sql = `SELECT p.*, c.name AS contact_name FROM projects p
    LEFT JOIN contacts c ON c.id = p.contact_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND p.status = ?'; params.push(status); }
  const rows = db.prepare(sql + ' ORDER BY p.status, p.name').all(...params);
  for (const p of rows) Object.assign(p, profitability(db, p.id));
  return rows;
}

// Revenue: posted invoice lines tagged to the project (credit notes subtract).
// Costs: posted bill lines, spend-money lines and approved expense claim lines.
function profitability(db, projectId) {
  const inv = db.prepare(`SELECT COALESCE(SUM(CASE WHEN i.kind='ACCREC' THEN CAST(ROUND(il.net_cents * i.exchange_rate) AS INTEGER)
        WHEN i.kind='ACCRECCREDIT' THEN -CAST(ROUND(il.net_cents * i.exchange_rate) AS INTEGER) ELSE 0 END),0) AS revenue,
      COALESCE(SUM(CASE WHEN i.kind='ACCPAY' THEN CAST(ROUND(il.net_cents * i.exchange_rate) AS INTEGER)
        WHEN i.kind='ACCPAYCREDIT' THEN -CAST(ROUND(il.net_cents * i.exchange_rate) AS INTEGER) ELSE 0 END),0) AS cost
    FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
    WHERE il.project_id = ? AND i.status IN ('AUTHORISED','PAID')`).get(projectId);
  const spend = db.prepare(`SELECT COALESCE(SUM(CASE WHEN bt.kind='SPEND' THEN l.net_cents ELSE -l.net_cents END),0) AS cost
    FROM bank_transaction_lines l JOIN bank_transactions bt ON bt.id = l.bank_transaction_id
    WHERE l.project_id = ? AND bt.status='AUTHORISED'`).get(projectId);
  const claims = db.prepare(`SELECT COALESCE(SUM(l.net_cents),0) AS cost
    FROM expense_claim_lines l JOIN expense_claims ec ON ec.id = l.claim_id
    WHERE l.project_id = ? AND ec.status IN ('AUTHORISED','PAID')`).get(projectId);
  const revenue = inv.revenue;
  const costs = inv.cost + spend.cost + claims.cost;
  return { revenue_cents: revenue, cost_cents: costs, profit_cents: revenue - costs };
}

// ---------- time entries ----------

function saveTimeEntry(db, d) {
  const p = getProject(db, d.projectId);
  const hours = Number(d.hours);
  if (!hours || hours <= 0) throw new Error('Hours must be positive');
  const rate = d.rateCents != null && d.rateCents !== '' ? Math.round(Number(d.rateCents)) : p.hourly_rate_cents;
  if (d.id) {
    const existing = db.prepare('SELECT * FROM time_entries WHERE id=?').get(d.id);
    if (existing && existing.invoice_id) throw new Error('This time has already been invoiced');
    db.prepare('UPDATE time_entries SET project_id=?, date=?, hours=?, description=?, rate_cents=?, billable=? WHERE id=?')
      .run(d.projectId, d.date, hours, d.description || '', rate, d.billable === false ? 0 : 1, d.id);
    return db.prepare('SELECT * FROM time_entries WHERE id=?').get(d.id);
  }
  const r = db.prepare(`INSERT INTO time_entries (project_id, date, hours, description, rate_cents, billable)
    VALUES (?,?,?,?,?,?)`).run(d.projectId, d.date, hours, d.description || '', rate, d.billable === false ? 0 : 1);
  return db.prepare('SELECT * FROM time_entries WHERE id=?').get(Number(r.lastInsertRowid));
}

function deleteTimeEntry(db, id) {
  const t = db.prepare('SELECT * FROM time_entries WHERE id=?').get(id);
  if (!t) throw new Error('Time entry not found');
  if (t.invoice_id) throw new Error('This time has already been invoiced');
  db.prepare('DELETE FROM time_entries WHERE id=?').run(id);
  return { ok: true };
}

// Creates a draft invoice from all unbilled billable time on the project.
function invoiceUnbilledTime(db, { projectId, salesAccountId, taxRateId = null }) {
  const p = getProject(db, projectId);
  if (!p.contact_id) throw new Error('Set a customer on the project first');
  const entries = p.time_entries.filter(t => t.billable && !t.invoice_id);
  if (!entries.length) throw new Error('No unbilled time on this project');
  if (!salesAccountId) throw new Error('Choose a revenue account');
  const dueDays = parseInt(getSetting(db, 'default_due_days') || '14', 10);
  const issue = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + dueDays * 864e5).toISOString().slice(0, 10);
  const inv = docs.saveInvoice(db, {
    kind: 'ACCREC', contactId: p.contact_id, issueDate: issue, dueDate: due,
    reference: p.name, taxMode: taxRateId ? 'exclusive' : 'none',
    lines: entries.map(t => ({
      description: `${t.date} — ${t.description || 'Project time'} (${t.hours}h)`,
      qty: t.hours, unitPriceCents: t.rate_cents, accountId: salesAccountId,
      taxRateId, projectId,
    })),
  });
  const upd = db.prepare('UPDATE time_entries SET invoice_id=? WHERE id=?');
  for (const t of entries) upd.run(inv.id, t.id);
  return inv;
}

module.exports = { saveProject, getProject, listProjects, saveTimeEntry, deleteTimeEntry, invoiceUnbilledTime, profitability };
