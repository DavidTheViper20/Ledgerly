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
  org_tax_number: '',
  base_currency: 'USD',
  fy_end_day: '31',
  fy_end_month: '12',
  invoice_prefix: 'INV-',
  invoice_next_number: '1001',
  quote_prefix: 'QU-',
  quote_next_number: '1001',
  default_due_days: '14',
  setup_complete: '0',
  tax_label: 'Tax',
};

function open(filePath) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  seedDefaults(db);
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
      none: taxIds['No Tax (0%)'],
      sales: taxIds['Tax on Sales (20%)'],
      purchases: taxIds['Tax on Purchases (20%)'],
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
