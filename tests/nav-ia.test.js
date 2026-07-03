'use strict';

// Pass A — Xero-style IA restructure. Covers the data-facing pieces of the
// nav split: contacts filtering (Customers/Suppliers views), supplier-credit
// (ACCPAYCREDIT) listing, and the projects_enabled feature flag default.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });

const call = (m, a) => api.call(db, m, a);

function accByCode(code) { return db.prepare('SELECT * FROM accounts WHERE code=?').get(code); }

// ---------- contacts filter ----------

test('contacts filter: customers returns only customers', () => {
  call('contacts.save', { name: 'Cust Co', is_customer: true });
  call('contacts.save', { name: 'Supp Co', is_supplier: true });
  call('contacts.save', { name: 'Both Co', is_customer: true, is_supplier: true });

  const customers = call('contacts.list', { filter: 'customers' });
  const names = customers.map(c => c.name).sort();
  assert.deepEqual(names, ['Both Co', 'Cust Co']);
  assert.ok(customers.every(c => c.is_customer === 1));
});

test('contacts filter: suppliers returns only suppliers', () => {
  call('contacts.save', { name: 'Cust Co', is_customer: true });
  call('contacts.save', { name: 'Supp Co', is_supplier: true });
  call('contacts.save', { name: 'Both Co', is_customer: true, is_supplier: true });

  const suppliers = call('contacts.list', { filter: 'suppliers' });
  const names = suppliers.map(c => c.name).sort();
  assert.deepEqual(names, ['Both Co', 'Supp Co']);
  assert.ok(suppliers.every(c => c.is_supplier === 1));
});

// ---------- supplier credits (ACCPAYCREDIT) ----------

test('supplier-credit: listing via invoices.list kind ACCPAYCREDIT', () => {
  const c = call('contacts.save', { name: 'Supplier Ltd', is_supplier: true });
  const expenses = accByCode('300') || accByCode('400') || accByCode('469');
  const cn = call('invoices.save', {
    kind: 'ACCPAYCREDIT', contactId: c.id, issueDate: '2026-05-01', dueDate: '2026-05-01',
    taxMode: 'none', lines: [{ description: 'Returned goods', qty: 1, unitPriceCents: 5000, accountId: expenses.id }],
  });
  assert.equal(cn.kind, 'ACCPAYCREDIT');

  const list = call('invoices.list', { kind: 'ACCPAYCREDIT' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, cn.id);
  assert.equal(list[0].kind, 'ACCPAYCREDIT');

  // Supplier credits must not leak into the supplier-credit-adjacent kinds.
  assert.equal(call('invoices.list', { kind: 'ACCRECCREDIT' }).length, 0);
  assert.equal(call('invoices.list', { kind: 'ACCPAY' }).length, 0);
});

// ---------- projects flag default ----------

test('projects_enabled default is off', () => {
  const s = call('settings.all', {});
  assert.equal(s.projects_enabled, '0');
});
