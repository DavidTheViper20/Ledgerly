'use strict';

// Method registry exposed to the renderer over IPC.
// Every method: (db, args) => result. Errors propagate as {error} to the UI.

const { getSetting, setSetting } = require('./db');
const { TYPE_LABELS, ACCOUNT_TYPES } = require('./coa');
const ledger = require('./services/ledger');
const docs = require('./services/docs');
const bank = require('./services/bank');
const reports = require('./services/reports');
const purchasing = require('./services/purchasing');
const expenses = require('./services/expenses');
const assets = require('./services/assets');
const projects = require('./services/projects');
const payroll = require('./services/payroll');

// ---------- contacts ----------
const contacts = {
  list(db, { filter = 'all', search = '' } = {}) {
    let sql = 'SELECT * FROM contacts WHERE is_archived = 0';
    const params = [];
    if (filter === 'customers') sql += ' AND is_customer = 1';
    if (filter === 'suppliers') sql += ' AND is_supplier = 1';
    if (filter === 'archived') sql = 'SELECT * FROM contacts WHERE is_archived = 1';
    if (search) { sql += ' AND (name LIKE ? OR email LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY name COLLATE NOCASE LIMIT 1000';
    const rows = db.prepare(sql).all(...params);
    for (const c of rows) {
      const rec = db.prepare(`SELECT COALESCE(SUM(CAST(ROUND((total_cents - paid_cents) * exchange_rate) AS INTEGER)),0) AS owed
        FROM invoices WHERE contact_id = ? AND kind='ACCREC' AND status='AUTHORISED'`).get(c.id);
      const pay = db.prepare(`SELECT COALESCE(SUM(CAST(ROUND((total_cents - paid_cents) * exchange_rate) AS INTEGER)),0) AS owed
        FROM invoices WHERE contact_id = ? AND kind='ACCPAY' AND status='AUTHORISED'`).get(c.id);
      c.they_owe_cents = rec.owed;
      c.you_owe_cents = pay.owed;
    }
    return rows;
  },
  get(db, { id }) {
    const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    if (!c) throw new Error('Contact not found');
    c.invoices = docs.listInvoices(db, { kind: 'ACCREC', contactId: id });
    c.bills = docs.listInvoices(db, { kind: 'ACCPAY', contactId: id });
    c.credit_notes = [
      ...docs.listInvoices(db, { kind: 'ACCRECCREDIT', contactId: id }),
      ...docs.listInvoices(db, { kind: 'ACCPAYCREDIT', contactId: id }),
    ];
    return c;
  },
  save(db, data) {
    if (!data.name || !data.name.trim()) throw new Error('Contact name is required');
    const fields = ['name', 'contact_person', 'email', 'phone', 'address', 'city', 'postcode',
      'country', 'tax_number', 'notes'];
    if (data.id) {
      db.prepare(`UPDATE contacts SET ${fields.map(f => f + '=?').join(', ')},
        is_customer=?, is_supplier=? WHERE id=?`)
        .run(...fields.map(f => data[f] || ''), data.is_customer ? 1 : 0, data.is_supplier ? 1 : 0, data.id);
      return contacts.get(db, { id: data.id });
    }
    const r = db.prepare(`INSERT INTO contacts (${fields.join(',')}, is_customer, is_supplier)
      VALUES (${fields.map(() => '?').join(',')}, ?, ?)`)
      .run(...fields.map(f => data[f] || ''), data.is_customer ? 1 : 0, data.is_supplier ? 1 : 0);
    return contacts.get(db, { id: Number(r.lastInsertRowid) });
  },
  archive(db, { id, archived = true }) {
    db.prepare('UPDATE contacts SET is_archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
    return { ok: true };
  },
};

// ---------- items (products & services) ----------
const items = {
  list(db, { search = '' } = {}) {
    let sql = 'SELECT i.*, sa.name AS sale_account_name, pa.name AS purchase_account_name FROM items i ' +
      'LEFT JOIN accounts sa ON sa.id = i.sale_account_id ' +
      'LEFT JOIN accounts pa ON pa.id = i.purchase_account_id WHERE i.is_archived = 0';
    const params = [];
    if (search) { sql += ' AND (i.code LIKE ? OR i.name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    return db.prepare(sql + ' ORDER BY i.code').all(...params);
  },
  save(db, d) {
    if (!d.code || !d.name) throw new Error('Item code and name are required');
    const cols = {
      code: d.code, name: d.name, description: d.description || '',
      sale_price_cents: Math.round(d.sale_price_cents || 0), sale_account_id: d.sale_account_id || null,
      sale_tax_rate_id: d.sale_tax_rate_id || null,
      purchase_price_cents: Math.round(d.purchase_price_cents || 0), purchase_account_id: d.purchase_account_id || null,
      purchase_tax_rate_id: d.purchase_tax_rate_id || null,
      is_sold: d.is_sold ? 1 : 0, is_purchased: d.is_purchased ? 1 : 0,
    };
    if (d.id) {
      db.prepare(`UPDATE items SET ${Object.keys(cols).map(k => k + '=?').join(', ')} WHERE id=?`)
        .run(...Object.values(cols), d.id);
      return db.prepare('SELECT * FROM items WHERE id=?').get(d.id);
    }
    const r = db.prepare(`INSERT INTO items (${Object.keys(cols).join(',')})
      VALUES (${Object.keys(cols).map(() => '?').join(',')})`).run(...Object.values(cols));
    return db.prepare('SELECT * FROM items WHERE id=?').get(Number(r.lastInsertRowid));
  },
  archive(db, { id }) {
    db.prepare('UPDATE items SET is_archived = 1 WHERE id = ?').run(id);
    return { ok: true };
  },
};

// ---------- chart of accounts & tax rates ----------
const accounts = {
  list(db, { includeArchived = false } = {}) {
    const rows = db.prepare(`SELECT a.*, t.name AS tax_name FROM accounts a
      LEFT JOIN tax_rates t ON t.id = a.tax_rate_id
      ${includeArchived ? '' : 'WHERE a.is_archived = 0'} ORDER BY a.code`).all();
    const bals = ledger.allBalances(db);
    for (const a of rows) {
      a.type_label = TYPE_LABELS[a.type] || a.type;
      a.class = ACCOUNT_TYPES[a.type];
      a.balance_cents = bals[a.id] || 0;
    }
    return rows;
  },
  save(db, d) {
    if (!d.code || !d.name || !d.type) throw new Error('Code, name and type are required');
    if (!TYPE_LABELS[d.type]) throw new Error('Invalid account type');
    if (d.id) {
      const existing = db.prepare('SELECT * FROM accounts WHERE id=?').get(d.id);
      if (existing.system_key && d.type !== existing.type) throw new Error('Cannot change the type of a system account');
      db.prepare('UPDATE accounts SET code=?, name=?, type=?, description=?, tax_rate_id=? WHERE id=?')
        .run(d.code, d.name, d.type, d.description || '', d.tax_rate_id || null, d.id);
      return db.prepare('SELECT * FROM accounts WHERE id=?').get(d.id);
    }
    const r = db.prepare('INSERT INTO accounts (code, name, type, description, tax_rate_id) VALUES (?,?,?,?,?)')
      .run(d.code, d.name, d.type, d.description || '', d.tax_rate_id || null);
    return db.prepare('SELECT * FROM accounts WHERE id=?').get(Number(r.lastInsertRowid));
  },
  archive(db, { id, archived = true }) {
    const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    if (a.system_key) throw new Error('System accounts cannot be archived');
    db.prepare('UPDATE accounts SET is_archived=? WHERE id=?').run(archived ? 1 : 0, id);
    return { ok: true };
  },
  types() {
    return Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label, class: ACCOUNT_TYPES[value] }));
  },
};

const taxRates = {
  list(db) { return db.prepare('SELECT * FROM tax_rates WHERE is_archived = 0 ORDER BY id').all(); },
  save(db, d) {
    if (!d.name) throw new Error('Name required');
    const rate = Number(d.rate) || 0;
    if (d.id) {
      db.prepare('UPDATE tax_rates SET name=?, rate=? WHERE id=?').run(d.name, rate, d.id);
      return db.prepare('SELECT * FROM tax_rates WHERE id=?').get(d.id);
    }
    const r = db.prepare('INSERT INTO tax_rates (name, rate) VALUES (?,?)').run(d.name, rate);
    return db.prepare('SELECT * FROM tax_rates WHERE id=?').get(Number(r.lastInsertRowid));
  },
  archive(db, { id }) {
    db.prepare('UPDATE tax_rates SET is_archived = 1 WHERE id = ?').run(id);
    return { ok: true };
  },
};

// ---------- manual journals ----------
const journals = {
  list(db, { manualOnly = true } = {}) {
    const sql = manualOnly
      ? "SELECT * FROM journals WHERE source_kind='manual' ORDER BY date DESC, id DESC LIMIT 500"
      : "SELECT * FROM journals ORDER BY date DESC, id DESC LIMIT 500";
    const rows = db.prepare(sql).all();
    for (const j of rows) {
      const t = db.prepare('SELECT COALESCE(SUM(debit_cents),0) AS dr FROM journal_lines WHERE journal_id=?').get(j.id);
      j.total_cents = t.dr;
    }
    return rows;
  },
  get(db, { id }) {
    const j = db.prepare('SELECT * FROM journals WHERE id=?').get(id);
    if (!j) throw new Error('Journal not found');
    j.lines = db.prepare(`SELECT jl.*, a.code AS account_code, a.name AS account_name FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id WHERE jl.journal_id=? ORDER BY jl.id`).all(id);
    return j;
  },
  saveManual(db, { id = null, date, narration, status = 'POSTED', lines }) {
    // Manual journals can be saved as DRAFT (not in reports) or POSTED.
    if (!['DRAFT', 'POSTED'].includes(status)) throw new Error('Invalid status');
    if (id) {
      const existing = journals.get(db, { id });
      if (existing.source_kind !== 'manual') throw new Error('Not a manual journal');
      if (existing.status === 'VOIDED') throw new Error('Journal is voided');
      db.prepare('DELETE FROM journal_lines WHERE journal_id=?').run(id);
      db.prepare('DELETE FROM journals WHERE id=?').run(id);
    }
    const jid = ledger.postJournal(db, { date, narration, sourceKind: 'manual', status, lines });
    return journals.get(db, { id: jid });
  },
  postDraft(db, { id }) {
    const j = journals.get(db, { id });
    if (j.source_kind !== 'manual' || j.status !== 'DRAFT') throw new Error('Only draft manual journals can be posted');
    db.prepare("UPDATE journals SET status='POSTED' WHERE id=?").run(id);
    return journals.get(db, { id });
  },
  void(db, { id }) {
    const j = journals.get(db, { id });
    if (j.source_kind !== 'manual') throw new Error('Only manual journals can be voided here');
    db.prepare("UPDATE journals SET status='VOIDED' WHERE id=?").run(id);
    return { ok: true };
  },
};

// ---------- settings ----------
const settings = {
  all(db) {
    const out = {};
    for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
    return out;
  },
  update(db, kv) {
    for (const [k, v] of Object.entries(kv)) setSetting(db, k, v);
    return settings.all(db);
  },
};

// ---------- dashboard ----------
const dashboard = {
  data(db) {
    const banks = bank.listBankAccounts(db);
    const sums = (kind) => db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN status IN ('DRAFT','SUBMITTED') THEN CAST(ROUND(total_cents * exchange_rate) AS INTEGER) END),0) AS draft_cents,
        COALESCE(SUM(CASE WHEN status='AUTHORISED' THEN CAST(ROUND((total_cents - paid_cents) * exchange_rate) AS INTEGER) END),0) AS awaiting_cents,
        COALESCE(SUM(CASE WHEN status='AUTHORISED' AND due_date < date('now') THEN CAST(ROUND((total_cents - paid_cents) * exchange_rate) AS INTEGER) END),0) AS overdue_cents,
        COUNT(CASE WHEN status IN ('DRAFT','SUBMITTED') THEN 1 END) AS draft_count,
        COUNT(CASE WHEN status='AUTHORISED' THEN 1 END) AS awaiting_count,
        COUNT(CASE WHEN status='AUTHORISED' AND due_date < date('now') THEN 1 END) AS overdue_count
      FROM invoices WHERE kind=?`).get(kind);
    const inv = sums('ACCREC');
    const bills = sums('ACCPAY');
    return {
      banks, invoices: inv, bills,
      cash: reports.cashSummary(db, { months: 6 }),
      recentContacts: db.prepare('SELECT id, name FROM contacts WHERE is_archived=0 ORDER BY id DESC LIMIT 5').all(),
    };
  },
};

// ---------- registry ----------
const METHODS = {
  'settings.all': settings.all,
  'settings.update': settings.update,

  'contacts.list': contacts.list,
  'contacts.get': contacts.get,
  'contacts.save': contacts.save,
  'contacts.archive': contacts.archive,

  'items.list': items.list,
  'items.save': items.save,
  'items.archive': items.archive,

  'accounts.list': accounts.list,
  'accounts.save': accounts.save,
  'accounts.archive': accounts.archive,
  'accounts.types': accounts.types,

  'taxRates.list': taxRates.list,
  'taxRates.save': taxRates.save,
  'taxRates.archive': taxRates.archive,

  'invoices.list': (db, a) => docs.listInvoices(db, a),
  'invoices.get': (db, a) => docs.getInvoice(db, a.id),
  'invoices.save': (db, a) => docs.saveInvoice(db, a),
  'invoices.submit': (db, a) => docs.submitInvoice(db, a.id),
  'invoices.approve': (db, a) => docs.approveInvoice(db, a.id),
  'invoices.void': (db, a) => docs.voidInvoice(db, a.id),
  'invoices.delete': (db, a) => docs.deleteDraftInvoice(db, a.id),
  'invoices.copy': (db, a) => docs.copyInvoice(db, a.id),
  'payments.add': (db, a) => docs.addPayment(db, a),
  'payments.remove': (db, a) => docs.removePayment(db, a.id),

  'quotes.list': (db, a) => docs.listQuotes(db, a),
  'quotes.get': (db, a) => docs.getQuote(db, a.id),
  'quotes.save': (db, a) => docs.saveQuote(db, a),
  'quotes.setStatus': (db, a) => docs.setQuoteStatus(db, a.id, a.status),
  'quotes.toInvoice': (db, a) => docs.quoteToInvoice(db, a.id),
  'quotes.delete': (db, a) => docs.deleteQuote(db, a.id),

  'bank.accounts': (db) => bank.listBankAccounts(db),
  'bank.createAccount': (db, a) => bank.createBankAccount(db, a),
  'bank.saveTransaction': (db, a) => bank.saveBankTransaction(db, a),
  'bank.getTransaction': (db, a) => bank.getBankTransaction(db, a.id),
  'bank.deleteTransaction': (db, a) => bank.deleteBankTransaction(db, a.id),
  'bank.transfer': (db, a) => bank.saveTransfer(db, a),
  'bank.transactions': (db, a) => bank.listAccountTransactions(db, a.bankAccountId),
  'bank.importStatement': (db, a) => bank.importStatement(db, a),
  'bank.addStatementLine': (db, a) => bank.addStatementLine(db, a),
  'bank.deleteStatementLine': (db, a) => bank.deleteStatementLine(db, a.id),
  'bank.reconcileData': (db, a) => bank.reconcileData(db, a.bankAccountId),
  'bank.match': (db, a) => bank.matchStatementLine(db, a),
  'bank.createAndMatch': (db, a) => bank.createAndMatch(db, a),
  'bank.unreconcile': (db, a) => bank.unreconcile(db, a.statementLineId),

  'journals.list': journals.list,
  'journals.get': journals.get,
  'journals.saveManual': journals.saveManual,
  'journals.postDraft': journals.postDraft,
  'journals.void': journals.void,

  'reports.profitAndLoss': (db, a) => reports.profitAndLoss(db, a),
  'reports.balanceSheet': (db, a) => reports.balanceSheet(db, a),
  'reports.trialBalance': (db, a) => reports.trialBalance(db, a),
  'reports.agedReceivables': (db, a) => reports.agedDocuments(db, { kind: 'ACCREC', asAt: a.asAt }),
  'reports.agedPayables': (db, a) => reports.agedDocuments(db, { kind: 'ACCPAY', asAt: a.asAt }),
  'reports.accountTransactions': (db, a) => reports.accountTransactions(db, a),
  'reports.taxSummary': (db, a) => reports.taxSummary(db, a),
  'reports.cashSummary': (db, a) => reports.cashSummary(db, a),

  'dashboard.data': dashboard.data,

  'credits.allocate': (db, a) => docs.allocateCredit(db, a),
  'credits.removeAllocation': (db, a) => docs.removeAllocation(db, a.id),

  'pos.list': (db, a) => purchasing.listPOs(db, a),
  'pos.get': (db, a) => purchasing.getPO(db, a.id),
  'pos.save': (db, a) => purchasing.savePO(db, a),
  'pos.setStatus': (db, a) => purchasing.setPOStatus(db, a.id, a.status),
  'pos.toBill': (db, a) => purchasing.poToBill(db, a.id),
  'pos.delete': (db, a) => purchasing.deletePO(db, a.id),

  'repeating.list': (db) => purchasing.listRepeating(db),
  'repeating.get': (db, a) => purchasing.getRepeating(db, a.id),
  'repeating.save': (db, a) => purchasing.saveRepeating(db, a),
  'repeating.setStatus': (db, a) => purchasing.setRepeatingStatus(db, a.id, a.status),
  'repeating.delete': (db, a) => purchasing.deleteRepeating(db, a.id),
  'repeating.generateDue': (db, a) => purchasing.generateDueRepeating(db, a && a.asOf),

  'claims.list': (db, a) => expenses.listClaims(db, a),
  'claims.get': (db, a) => expenses.getClaim(db, a.id),
  'claims.save': (db, a) => expenses.saveClaim(db, a),
  'claims.setStatus': (db, a) => expenses.setClaimStatus(db, a.id, a.status),
  'claims.approve': (db, a) => expenses.approveClaim(db, a.id),
  'claims.pay': (db, a) => expenses.payClaim(db, a),
  'claims.delete': (db, a) => expenses.deleteClaim(db, a.id),
  'claims.void': (db, a) => expenses.voidClaim(db, a.id),

  'assets.list': (db, a) => assets.listAssets(db, a),
  'assets.get': (db, a) => assets.getAsset(db, a.id),
  'assets.save': (db, a) => assets.saveAsset(db, a),
  'assets.register': (db, a) => assets.registerAsset(db, a.id),
  'assets.delete': (db, a) => assets.deleteAsset(db, a.id),
  'assets.runDepreciation': (db, a) => assets.runDepreciation(db, a),
  'assets.dispose': (db, a) => assets.disposeAsset(db, a),

  'projects.list': (db, a) => projects.listProjects(db, a),
  'projects.get': (db, a) => projects.getProject(db, a.id),
  'projects.save': (db, a) => projects.saveProject(db, a),
  'projects.saveTime': (db, a) => projects.saveTimeEntry(db, a),
  'projects.deleteTime': (db, a) => projects.deleteTimeEntry(db, a.id),
  'projects.invoiceTime': (db, a) => projects.invoiceUnbilledTime(db, a),

  'payroll.employees': (db, a) => payroll.listEmployees(db, a),
  'payroll.saveEmployee': (db, a) => payroll.saveEmployee(db, a),
  'payroll.archiveEmployee': (db, a) => payroll.archiveEmployee(db, a.id),
  'payroll.createRun': (db, a) => payroll.createPayRun(db, a),
  'payroll.getRun': (db, a) => payroll.getPayRun(db, a.id),
  'payroll.listRuns': (db) => payroll.listPayRuns(db),
  'payroll.updatePayslip': (db, a) => payroll.updatePayslip(db, a),
  'payroll.postRun': (db, a) => payroll.postPayRun(db, a.id),
  'payroll.payWages': (db, a) => payroll.payWages(db, a),
  'payroll.deleteRun': (db, a) => payroll.deletePayRun(db, a.id),

  'reports.bas': (db, a) => reports.basSummary(db, a),
  'reports.cashFlowForecast': (db, a) => reports.cashFlowForecast(db, a || {}),
  'reports.budgetVsActual': (db, a) => reports.budgetVsActual(db, a),
  'budgets.get': (db, a) => reports.getBudgets(db, a),
  'budgets.set': (db, a) => reports.setBudgets(db, a),
};

function call(db, method, args) {
  const fn = METHODS[method];
  if (!fn) throw new Error(`Unknown method: ${method}`);
  // Wrap every call in a transaction so multi-statement operations are atomic.
  db.exec('BEGIN');
  try {
    const result = fn(db, args || {});
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

module.exports = { call, METHODS };
