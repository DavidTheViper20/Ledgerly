'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { DEFAULT_TAX_RATES, DEFAULT_ACCOUNTS } = require('./coa');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS tax_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rate REAL NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT DEFAULT '',
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  system_key TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_person TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  postcode TEXT DEFAULT '',
  country TEXT DEFAULT '',
  tax_number TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  is_customer INTEGER NOT NULL DEFAULT 0,
  is_supplier INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sale_price_cents INTEGER DEFAULT 0,
  sale_account_id INTEGER REFERENCES accounts(id),
  sale_tax_rate_id INTEGER REFERENCES tax_rates(id),
  purchase_price_cents INTEGER DEFAULT 0,
  purchase_account_id INTEGER REFERENCES accounts(id),
  purchase_tax_rate_id INTEGER REFERENCES tax_rates(id),
  is_sold INTEGER NOT NULL DEFAULT 1,
  is_purchased INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0
);

-- kind: ACCREC (sales invoice) | ACCPAY (bill)
-- status: DRAFT | SUBMITTED | AUTHORISED | PAID | VOIDED
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  number TEXT DEFAULT '',
  reference TEXT DEFAULT '',
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  tax_mode TEXT NOT NULL DEFAULT 'exclusive',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  journal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id),
  description TEXT DEFAULT '',
  qty REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  account_id INTEGER REFERENCES accounts(id),
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  net_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

-- status: DRAFT | SENT | ACCEPTED | DECLINED | INVOICED
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT DEFAULT '',
  title TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  reference TEXT DEFAULT '',
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  issue_date TEXT NOT NULL,
  expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  tax_mode TEXT NOT NULL DEFAULT 'exclusive',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  invoice_id INTEGER REFERENCES invoices(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quote_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id),
  description TEXT DEFAULT '',
  qty REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  account_id INTEGER REFERENCES accounts(id),
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  net_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  bank_account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reference TEXT DEFAULT '',
  journal_id INTEGER,
  is_reconciled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- kind: SPEND | RECEIVE ; status: AUTHORISED | VOIDED
CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  bank_account_id INTEGER NOT NULL REFERENCES accounts(id),
  contact_id INTEGER REFERENCES contacts(id),
  date TEXT NOT NULL,
  reference TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'AUTHORISED',
  tax_mode TEXT NOT NULL DEFAULT 'exclusive',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  journal_id INTEGER,
  is_reconciled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_transaction_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_transaction_id INTEGER NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  description TEXT DEFAULT '',
  qty REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER REFERENCES accounts(id),
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  net_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reference TEXT DEFAULT '',
  journal_id INTEGER,
  from_reconciled INTEGER NOT NULL DEFAULT 0,
  to_reconciled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Imported/entered bank statement lines awaiting reconciliation.
-- amount_cents signed: positive = money in, negative = money out.
-- status: UNMATCHED | MATCHED
CREATE TABLE IF NOT EXISTS statement_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  payee TEXT DEFAULT '',
  description TEXT DEFAULT '',
  reference TEXT DEFAULT '',
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNMATCHED',
  matched_kind TEXT,
  matched_id INTEGER,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- source_kind: invoice | payment | bank_transaction | transfer | manual
-- status: DRAFT (manual only) | POSTED | VOIDED
CREATE TABLE IF NOT EXISTS journals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  narration TEXT DEFAULT '',
  source_kind TEXT NOT NULL,
  source_id INTEGER,
  status TEXT NOT NULL DEFAULT 'POSTED',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  contact_id INTEGER REFERENCES contacts(id),
  description TEXT DEFAULT '',
  debit_cents INTEGER NOT NULL DEFAULT 0,
  credit_cents INTEGER NOT NULL DEFAULT 0
);

-- Credit note allocations: applying a credit note against an invoice/bill.
CREATE TABLE IF NOT EXISTS credit_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_id INTEGER NOT NULL REFERENCES invoices(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- status: DRAFT | SENT | APPROVED | BILLED | CANCELLED
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT DEFAULT '',
  reference TEXT DEFAULT '',
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  issue_date TEXT NOT NULL,
  delivery_date TEXT,
  delivery_address TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  tax_mode TEXT NOT NULL DEFAULT 'exclusive',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  bill_id INTEGER REFERENCES invoices(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id),
  description TEXT DEFAULT '',
  qty REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  account_id INTEGER REFERENCES accounts(id),
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  net_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

-- Repeating invoice/bill templates. lines_json stores the line array.
-- unit: WEEK | MONTH ; status: ACTIVE | PAUSED
CREATE TABLE IF NOT EXISTS repeating_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'ACCREC',
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  reference TEXT DEFAULT '',
  tax_mode TEXT NOT NULL DEFAULT 'exclusive',
  lines_json TEXT NOT NULL DEFAULT '[]',
  schedule_every INTEGER NOT NULL DEFAULT 1,
  schedule_unit TEXT NOT NULL DEFAULT 'MONTH',
  next_date TEXT NOT NULL,
  end_date TEXT,
  due_days INTEGER NOT NULL DEFAULT 14,
  auto_approve INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- status: DRAFT | SUBMITTED | AUTHORISED | PAID | DECLINED
CREATE TABLE IF NOT EXISTS expense_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT DEFAULT '',
  payee TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  journal_id INTEGER,
  paid_journal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_claim_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  date TEXT,
  description TEXT DEFAULT '',
  merchant TEXT DEFAULT '',
  gross_cents INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER REFERENCES accounts(id),
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  project_id INTEGER,
  net_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

-- Fixed asset register. status: DRAFT | REGISTERED | DISPOSED
CREATE TABLE IF NOT EXISTS fixed_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT DEFAULT '',
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  purchase_date TEXT NOT NULL,
  cost_cents INTEGER NOT NULL,
  residual_cents INTEGER NOT NULL DEFAULT 0,
  life_years REAL NOT NULL DEFAULT 5,
  asset_account_id INTEGER REFERENCES accounts(id),
  accum_account_id INTEGER REFERENCES accounts(id),
  expense_account_id INTEGER REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'DRAFT',
  disposed_date TEXT,
  disposal_journal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per asset per depreciation posting.
CREATE TABLE IF NOT EXISTS asset_depreciation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES fixed_assets(id),
  period TEXT NOT NULL,          -- YYYY-MM
  amount_cents INTEGER NOT NULL,
  journal_id INTEGER NOT NULL
);

-- Projects & time tracking. status: ACTIVE | CLOSED
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_id INTEGER REFERENCES contacts(id),
  hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  date TEXT NOT NULL,
  hours REAL NOT NULL,
  description TEXT DEFAULT '',
  rate_cents INTEGER NOT NULL DEFAULT 0,
  billable INTEGER NOT NULL DEFAULT 1,
  invoice_id INTEGER REFERENCES invoices(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Payroll (simplified Australian payroll).
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  pay_basis TEXT NOT NULL DEFAULT 'SALARY',   -- SALARY (annual) | HOURLY
  pay_rate_cents INTEGER NOT NULL DEFAULT 0,  -- annual salary or hourly rate
  hours_per_week REAL NOT NULL DEFAULT 38,
  super_pct REAL NOT NULL DEFAULT 12,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- status: DRAFT | POSTED
CREATE TABLE IF NOT EXISTS pay_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  payment_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  journal_id INTEGER,
  paid_journal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pay_run_id INTEGER NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  gross_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  super_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL DEFAULT 0,
  hours REAL,
  notes TEXT DEFAULT ''
);

-- Budgets: monthly amount per account (P&L budgeting).
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  month TEXT NOT NULL,           -- YYYY-MM
  amount_cents INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, month)
);

-- AI assistant conversation and persistent memory.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tools_used TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assistant_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jl_journal ON journal_lines(journal_id);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_journals_date ON journals(date);
CREATE INDEX IF NOT EXISTS idx_inv_status ON invoices(kind, status);
CREATE INDEX IF NOT EXISTS idx_stmt_bank ON statement_lines(bank_account_id, status);
`;

const DEFAULT_SETTINGS = {
  org_name: '',
  org_legal_name: '',
  org_email: '',
  org_address: '',
  org_tax_number: '',          // ABN
  org_country: 'Australia',
  org_state: 'VIC',
  base_currency: 'AUD',
  fy_end_day: '30',            // Australian financial year ends 30 June
  fy_end_month: '6',
  invoice_prefix: 'INV-',
  invoice_next_number: '1001',
  quote_prefix: 'QU-',
  quote_next_number: '1001',
  credit_prefix: 'CN-',
  credit_next_number: '1001',
  po_prefix: 'PO-',
  po_next_number: '1001',
  claim_prefix: 'EXP-',
  claim_next_number: '1001',
  default_due_days: '14',
  setup_complete: '0',
  ai_provider: '',
  ai_base_url: '',
  ai_api_key: '',
  ai_model: '',
  ai_max_tokens: '2048',
  ai_context_length: '8192',
  tax_label: 'GST',
  super_guarantee_pct: '12',   // AU super guarantee from 1 July 2025
};

// Idempotent column add for databases created by older versions.
function ensureColumn(db, table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

function migrate(db) {
  // Multi-currency on invoices/bills/credit notes and their payments.
  ensureColumn(db, 'invoices', 'currency', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'invoices', 'exchange_rate', 'REAL NOT NULL DEFAULT 1');
  ensureColumn(db, 'invoices', 'base_total_cents', 'INTEGER');
  ensureColumn(db, 'payments', 'exchange_rate', 'REAL NOT NULL DEFAULT 1');
  ensureColumn(db, 'payments', 'base_amount_cents', 'INTEGER');
  ensureColumn(db, 'payments', 'ar_relief_base_cents', 'INTEGER');
  // Project tagging on revenue/cost lines.
  ensureColumn(db, 'invoice_lines', 'project_id', 'INTEGER');
  ensureColumn(db, 'bank_transaction_lines', 'project_id', 'INTEGER');
  // Web sources cited by assistant replies.
  ensureColumn(db, 'chat_messages', 'sources', 'TEXT');
  // System accounts added after first release (no-op on fresh DBs).
  const have = new Set(db.prepare('SELECT code FROM accounts').all().map(r => r.code));
  if (have.size) {
    const { DEFAULT_ACCOUNTS } = require('./coa');
    const taxNone = db.prepare("SELECT id FROM tax_rates ORDER BY id LIMIT 1").get();
    const ins = db.prepare('INSERT INTO accounts (code, name, type, tax_rate_id, system_key) VALUES (?,?,?,?,?)');
    for (const a of DEFAULT_ACCOUNTS) {
      if (!have.has(a.code) && a.system) ins.run(a.code, a.name, a.type, taxNone ? taxNone.id : null, a.system);
    }
  }
}

function open(filePath) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  seedDefaults(db);
  migrate(db);
  return db;
}

function seedDefaults(db) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM accounts').get();
  if (row.c === 0) {
    const insTax = db.prepare('INSERT INTO tax_rates (name, rate) VALUES (?, ?)');
    const taxIds = {};
    for (const t of DEFAULT_TAX_RATES) {
      const r = insTax.run(t.name, t.rate);
      taxIds[t.name] = Number(r.lastInsertRowid);
    }
    const taxByRole = {
      none: taxIds['BAS Excluded (0%)'],
      sales: taxIds['GST on Income (10%)'],
      purchases: taxIds['GST on Expenses (10%)'],
    };
    const insAcc = db.prepare(
      'INSERT INTO accounts (code, name, type, tax_rate_id, system_key) VALUES (?, ?, ?, ?, ?)');
    for (const a of DEFAULT_ACCOUNTS) {
      insAcc.run(a.code, a.name, a.type, taxByRole[a.tax] || taxByRole.none, a.system || null);
    }
  }
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);
}

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function systemAccount(db, key) {
  const r = db.prepare('SELECT * FROM accounts WHERE system_key = ?').get(key);
  if (!r) throw new Error(`System account missing: ${key}`);
  return r;
}

module.exports = { open, getSetting, setSetting, systemAccount };
