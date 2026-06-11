'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');
const money = require('../src/money');
const bank = require('../src/services/bank');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });

const call = (m, a) => api.call(db, m, a);

function setupBasics() {
  const c = call('contacts.save', { name: 'Acme Ltd', email: 'acme@example.com' });
  const sales = db.prepare("SELECT * FROM accounts WHERE code='200'").get();
  const rent = db.prepare("SELECT * FROM accounts WHERE code='469'").get();
  const taxSales = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Income%'").get();
  const bankAcc = call('bank.createAccount', { name: 'Business Checking', code: '090' });
  return { c, sales, rent, taxSales, bankAcc };
}

// ---------- money ----------

test('money: line calc exclusive', () => {
  const r = money.calcLine({ qty: 3, unitPriceCents: 1000, ratePct: 20, mode: 'exclusive' });
  assert.deepEqual(r, { netCents: 3000, taxCents: 600, totalCents: 3600 });
});

test('money: line calc inclusive', () => {
  const r = money.calcLine({ qty: 1, unitPriceCents: 12000, ratePct: 20, mode: 'inclusive' });
  assert.equal(r.totalCents, 12000);
  assert.equal(r.netCents, 10000);
  assert.equal(r.taxCents, 2000);
});

test('money: discount and rounding', () => {
  const r = money.calcLine({ qty: 1, unitPriceCents: 999, discountPct: 10, ratePct: 20, mode: 'exclusive' });
  assert.equal(r.netCents, 899); // 999*0.9 = 899.1 -> 899
  assert.equal(r.taxCents, 180); // 899*0.2 = 179.8 -> 180
});

test('money: toCents parsing', () => {
  assert.equal(money.toCents('1,234.56'), 123456);
  assert.equal(money.toCents('-45.005'), -4501);
  assert.equal(money.toCents(''), 0);
});

// ---------- invoices lifecycle ----------

test('invoice: draft -> approve posts balanced journal', () => {
  const { c, sales, taxSales } = setupBasics();
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-01-10', dueDate: '2026-01-24',
    taxMode: 'exclusive',
    lines: [{ description: 'Consulting', qty: 10, unitPriceCents: 15000, accountId: sales.id, taxRateId: taxSales.id }],
  });
  assert.equal(inv.status, 'DRAFT');
  assert.equal(inv.total_cents, 165000); // 1500 + 10% GST
  assert.match(inv.number, /^INV-\d+/);

  const approved = call('invoices.approve', { id: inv.id });
  assert.equal(approved.status, 'AUTHORISED');
  const j = call('journals.get', { id: approved.journal_id });
  const dr = j.lines.reduce((s, l) => s + l.debit_cents, 0);
  const cr = j.lines.reduce((s, l) => s + l.credit_cents, 0);
  assert.equal(dr, cr);
  assert.equal(dr, 165000);
  // AR debited
  const ar = db.prepare("SELECT id FROM accounts WHERE system_key='AR'").get();
  const arLine = j.lines.find(l => l.account_id === ar.id);
  assert.equal(arLine.debit_cents, 165000);
});

test('invoice: payment flow to PAID, overpayment rejected', () => {
  const { c, sales, taxSales, bankAcc } = setupBasics();
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-01-10', dueDate: '2026-01-24', taxMode: 'none',
    lines: [{ description: 'Work', qty: 1, unitPriceCents: 50000, accountId: sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  let after = call('payments.add', { invoiceId: inv.id, bankAccountId: bankAcc.id, date: '2026-01-15', amountCents: 20000 });
  assert.equal(after.status, 'AUTHORISED');
  assert.equal(after.paid_cents, 20000);
  assert.throws(() => call('payments.add', { invoiceId: inv.id, bankAccountId: bankAcc.id, date: '2026-01-16', amountCents: 40000 }),
    /exceeds/);
  after = call('payments.add', { invoiceId: inv.id, bankAccountId: bankAcc.id, date: '2026-01-16', amountCents: 30000 });
  assert.equal(after.status, 'PAID');
  // Bank balance reflects both payments
  const banks = call('bank.accounts');
  assert.equal(banks.find(b => b.id === bankAcc.id).balance_cents, 50000);
  // Removing payment reverts status
  after = call('payments.remove', { id: after.payments[0].id });
  assert.equal(after.status, 'AUTHORISED');
  assert.equal(after.paid_cents, 30000);
});

test('invoice: cannot edit after approval; void reverses ledger', () => {
  const { c, sales } = setupBasics();
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-01-10', dueDate: '2026-01-24', taxMode: 'none',
    lines: [{ description: 'Work', qty: 1, unitPriceCents: 10000, accountId: sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  assert.throws(() => call('invoices.save', { ...inv, id: inv.id, contactId: c.id, issueDate: '2026-01-10', dueDate: '2026-01-24', taxMode: 'none', lines: [{ description: 'X', qty: 1, unitPriceCents: 1, accountId: sales.id }] }), /Cannot edit/);
  call('invoices.void', { id: inv.id });
  const pl = call('reports.profitAndLoss', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pl.totals.revenue_cents, 0);
});

test('bill: approve and pay reduces bank', () => {
  const { c, rent, bankAcc } = setupBasics();
  const bill = call('invoices.save', {
    kind: 'ACCPAY', contactId: c.id, issueDate: '2026-02-01', dueDate: '2026-02-14', taxMode: 'none',
    number: 'SUP-001',
    lines: [{ description: 'Office rent', qty: 1, unitPriceCents: 120000, accountId: rent.id }],
  });
  call('invoices.approve', { id: bill.id });
  call('payments.add', { invoiceId: bill.id, bankAccountId: bankAcc.id, date: '2026-02-05', amountCents: 120000 });
  const banks = call('bank.accounts');
  assert.equal(banks.find(b => b.id === bankAcc.id).balance_cents, -120000);
  const pl = call('reports.profitAndLoss', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pl.totals.expenses_cents, 120000);
});

// ---------- quotes ----------

test('quote: lifecycle and conversion to invoice', () => {
  const { c, sales } = setupBasics();
  const q = call('quotes.save', {
    contactId: c.id, issueDate: '2026-01-05', expiryDate: '2026-02-05', taxMode: 'none', title: 'Website build',
    lines: [{ description: 'Build', qty: 1, unitPriceCents: 500000, accountId: sales.id }],
  });
  assert.equal(q.status, 'DRAFT');
  call('quotes.setStatus', { id: q.id, status: 'SENT' });
  call('quotes.setStatus', { id: q.id, status: 'ACCEPTED' });
  const inv = call('quotes.toInvoice', { id: q.id });
  assert.equal(inv.kind, 'ACCREC');
  assert.equal(inv.total_cents, 500000);
  const q2 = call('quotes.get', { id: q.id });
  assert.equal(q2.status, 'INVOICED');
  assert.throws(() => call('quotes.toInvoice', { id: q.id }), /already invoiced/);
});

// ---------- bank ----------

test('bank: spend money posts and shows in P&L', () => {
  const { rent, bankAcc, taxSales } = setupBasics();
  const t = call('bank.saveTransaction', {
    kind: 'SPEND', bankAccountId: bankAcc.id, date: '2026-03-01', reference: 'March rent',
    taxMode: 'exclusive',
    lines: [{ description: 'Rent', qty: 1, unitPriceCents: 100000, accountId: rent.id, taxRateId: taxSales.id }],
  });
  assert.equal(t.total_cents, 110000);
  const banks = call('bank.accounts');
  assert.equal(banks.find(b => b.id === bankAcc.id).balance_cents, -110000);
  const pl = call('reports.profitAndLoss', { from: '2026-03-01', to: '2026-03-31' });
  assert.equal(pl.totals.expenses_cents, 100000); // net of tax
});

test('bank: transfer between accounts', () => {
  const { bankAcc } = setupBasics();
  const savings = call('bank.createAccount', { name: 'Savings', code: '091' });
  call('bank.transfer', { fromAccountId: bankAcc.id, toAccountId: savings.id, date: '2026-03-02', amountCents: 50000 });
  const banks = call('bank.accounts');
  assert.equal(banks.find(b => b.id === bankAcc.id).balance_cents, -50000);
  assert.equal(banks.find(b => b.id === savings.id).balance_cents, 50000);
});

test('bank: CSV import with header variants and date formats', () => {
  const { bankAcc } = setupBasics();
  const csv = 'Date,Description,Amount\n2026-01-05,"Coffee, beans",-4.50\n06/01/2026,Client deposit,1200.00\nbadrow,x,\n';
  const r = call('bank.importStatement', { bankAccountId: bankAcc.id, csv });
  assert.equal(r.imported, 2);
  assert.equal(r.skipped, 1);
  const rec = call('bank.reconcileData', { bankAccountId: bankAcc.id });
  assert.equal(rec.statementLines.length, 2);
  assert.equal(rec.statementLines[0].amount_cents, -450);
  assert.equal(rec.statementLines[1].date, '2026-01-06');
});

test('bank: debit/credit column CSV', () => {
  const { bankAcc } = setupBasics();
  const csv = 'Date,Details,Money Out,Money In\n2026-01-10,Card payment,25.00,\n2026-01-11,Refund,,10.00\n';
  const r = call('bank.importStatement', { bankAccountId: bankAcc.id, csv });
  assert.equal(r.imported, 2);
  const rec = call('bank.reconcileData', { bankAccountId: bankAcc.id });
  assert.equal(rec.statementLines[0].amount_cents, -2500);
  assert.equal(rec.statementLines[1].amount_cents, 1000);
});

test('reconciliation: suggestion, match, create-and-match, unreconcile', () => {
  const { c, sales, rent, bankAcc } = setupBasics();
  // An invoice payment of 300.00 into the bank
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-04-01', dueDate: '2026-04-10', taxMode: 'none',
    lines: [{ description: 'Job', qty: 1, unitPriceCents: 30000, accountId: sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  call('payments.add', { invoiceId: inv.id, bankAccountId: bankAcc.id, date: '2026-04-08', amountCents: 30000 });

  const csv = 'Date,Description,Amount\n2026-04-09,ACME LTD PAYMENT,300.00\n2026-04-10,STAPLES,-89.99\n';
  call('bank.importStatement', { bankAccountId: bankAcc.id, csv });

  let rec = call('bank.reconcileData', { bankAccountId: bankAcc.id });
  const inLine = rec.statementLines.find(s => s.amount_cents === 30000);
  assert.equal(inLine.suggestions.length, 1);
  assert.equal(inLine.suggestions[0].kind, 'payment');
  call('bank.match', { statementLineId: inLine.id, kind: 'payment', id: inLine.suggestions[0].id });

  // Spend line has no match: create-and-match into an expense account
  rec = call('bank.reconcileData', { bankAccountId: bankAcc.id });
  const outLine = rec.statementLines.find(s => s.amount_cents === -8999);
  assert.equal(outLine.suggestions.length, 0);
  call('bank.createAndMatch', { statementLineId: outLine.id, accountId: rent.id, description: 'Stationery' });

  rec = call('bank.reconcileData', { bankAccountId: bankAcc.id });
  assert.equal(rec.statementLines.length, 0);
  // Ledger bank balance must equal statement balance now
  const banks = call('bank.accounts');
  const b = banks.find(x => x.id === bankAcc.id);
  assert.equal(b.balance_cents, 30000 - 8999);
  assert.equal(b.statement_balance_cents, b.balance_cents);

  // Unreconcile the payment again
  const matched = db.prepare("SELECT * FROM statement_lines WHERE status='MATCHED' AND amount_cents=30000").get();
  call('bank.unreconcile', { statementLineId: matched.id });
  rec = call('bank.reconcileData', { bankAccountId: bankAcc.id });
  assert.equal(rec.statementLines.length, 1);
});

// ---------- manual journals ----------

test('manual journal: must balance, draft excluded from reports', () => {
  const { rent } = setupBasics();
  const equity = db.prepare("SELECT * FROM accounts WHERE code='970'").get();
  assert.throws(() => call('journals.saveManual', {
    date: '2026-01-01', narration: 'Bad', lines: [
      { accountId: rent.id, debitCents: 100 },
      { accountId: equity.id, creditCents: 99 },
    ],
  }), /balance/);
  const j = call('journals.saveManual', {
    date: '2026-01-01', narration: 'Accrual', status: 'DRAFT', lines: [
      { accountId: rent.id, debitCents: 5000 },
      { accountId: equity.id, creditCents: 5000 },
    ],
  });
  let pl = call('reports.profitAndLoss', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pl.totals.expenses_cents, 0);
  call('journals.postDraft', { id: j.id });
  pl = call('reports.profitAndLoss', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pl.totals.expenses_cents, 5000);
});

// ---------- reports ----------

test('reports: balance sheet balances and trial balance equality', () => {
  const { c, sales, rent, taxSales, bankAcc } = setupBasics();
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-01-10', dueDate: '2026-01-20', taxMode: 'exclusive',
    lines: [{ description: 'Service', qty: 2, unitPriceCents: 75000, accountId: sales.id, taxRateId: taxSales.id }],
  });
  call('invoices.approve', { id: inv.id });
  call('payments.add', { invoiceId: inv.id, bankAccountId: bankAcc.id, date: '2026-01-15', amountCents: 100000 });
  call('bank.saveTransaction', {
    kind: 'SPEND', bankAccountId: bankAcc.id, date: '2026-01-20', taxMode: 'none', reference: 'rent',
    lines: [{ description: 'Rent', qty: 1, unitPriceCents: 40000, accountId: rent.id }],
  });

  const bs = call('reports.balanceSheet', { asAt: '2026-12-31' });
  assert.equal(bs.totals.check_cents, 0, 'assets = liabilities + equity');
  assert.equal(bs.totals.assets_cents, 100000 - 40000 + 65000); // bank + AR remainder

  const tb = call('reports.trialBalance', { asAt: '2026-12-31' });
  assert.equal(tb.totals.debit_cents, tb.totals.credit_cents);

  const pl = call('reports.profitAndLoss', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pl.totals.revenue_cents, 150000);
  assert.equal(pl.totals.net_profit_cents, 110000);

  const tax = call('reports.taxSummary', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(tax.totals.collected_cents, 15000);
});

test('reports: balance sheet splits prior vs current year earnings', () => {
  const { c, sales, bankAcc } = setupBasics();
  // Revenue last FY (FY ends 31 Dec by default)
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2025-06-10', dueDate: '2025-06-20', taxMode: 'none',
    lines: [{ description: 'Old job', qty: 1, unitPriceCents: 70000, accountId: sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  const inv2 = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-02-01', dueDate: '2026-02-10', taxMode: 'none',
    lines: [{ description: 'New job', qty: 1, unitPriceCents: 30000, accountId: sales.id }],
  });
  call('invoices.approve', { id: inv2.id });

  const bs = call('reports.balanceSheet', { asAt: '2026-06-30' });
  const prior = bs.sections.equity.find(r => r.name.includes('prior years'));
  const current = bs.sections.equity.find(r => r.name === 'Current Year Earnings');
  assert.equal(prior.amount_cents, 70000);
  assert.equal(current.amount_cents, 30000);
  assert.equal(bs.totals.check_cents, 0);
});

test('reports: aged receivables buckets', () => {
  const { c, sales, bankAcc } = setupBasics();
  const mk = (issue, due, cents) => {
    const inv = call('invoices.save', {
      kind: 'ACCREC', contactId: c.id, issueDate: issue, dueDate: due, taxMode: 'none',
      lines: [{ description: 'x', qty: 1, unitPriceCents: cents, accountId: sales.id }],
    });
    call('invoices.approve', { id: inv.id });
    return inv;
  };
  mk('2026-05-01', '2026-06-20', 10000);  // current at 2026-06-15
  mk('2026-04-01', '2026-06-01', 20000);  // 14 days overdue -> 1-30
  mk('2026-01-01', '2026-02-01', 40000);  // >90 days
  const aged = call('reports.agedReceivables', { asAt: '2026-06-15' });
  assert.equal(aged.totals.current, 10000);
  assert.equal(aged.totals.b1_30, 20000);
  assert.equal(aged.totals.b90_plus, 40000);
  assert.equal(aged.totals.total, 70000);
  assert.equal(aged.rows.length, 1);
  assert.equal(aged.rows[0].documents.length, 3);
});

test('reports: account transactions running balance', () => {
  const { c, sales, bankAcc } = setupBasics();
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-01-10', dueDate: '2026-01-20', taxMode: 'none',
    lines: [{ description: 'A', qty: 1, unitPriceCents: 25000, accountId: sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  call('payments.add', { invoiceId: inv.id, bankAccountId: bankAcc.id, date: '2026-01-12', amountCents: 25000 });
  const r = call('reports.accountTransactions', { accountId: bankAcc.id, from: '2026-01-01', to: '2026-12-31' });
  assert.equal(r.opening_cents, 0);
  assert.equal(r.closing_cents, 25000);
  assert.equal(r.lines.at(-1).running_cents, 25000);
});

// ---------- contacts / items / accounts ----------

test('contacts: owed amounts and archive', () => {
  const { c, sales } = setupBasics();
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-01-10', dueDate: '2026-01-20', taxMode: 'none',
    lines: [{ description: 'A', qty: 1, unitPriceCents: 12300, accountId: sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  const list = call('contacts.list', { filter: 'customers' });
  assert.equal(list.length, 1);
  assert.equal(list[0].they_owe_cents, 12300);
  call('contacts.archive', { id: c.id });
  assert.equal(call('contacts.list', {}).length, 0);
});

test('accounts: CoA save/validate, system accounts protected', () => {
  const types = call('accounts.types');
  assert.ok(types.find(t => t.value === 'EXPENSE'));
  const a = call('accounts.save', { code: '450', name: 'Software', type: 'EXPENSE' });
  assert.equal(a.code, '450');
  assert.throws(() => call('accounts.save', { code: '451', name: 'Bad', type: 'NOPE' }), /Invalid account type/);
  const ar = db.prepare("SELECT * FROM accounts WHERE system_key='AR'").get();
  assert.throws(() => call('accounts.archive', { id: ar.id }), /System accounts/);
});

test('items: save and use defaults', () => {
  const { sales, taxSales } = setupBasics();
  const it = call('items.save', {
    code: 'CONS', name: 'Consulting hour', sale_price_cents: 15000,
    sale_account_id: sales.id, sale_tax_rate_id: taxSales.id, is_sold: 1,
  });
  assert.equal(it.sale_price_cents, 15000);
  const list = call('items.list', {});
  assert.equal(list.length, 1);
});

test('settings: invoice numbering sequence', () => {
  const { c, sales } = setupBasics();
  call('settings.update', { invoice_prefix: 'ZZ-', invoice_next_number: '7' });
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-01-10', dueDate: '2026-01-20', taxMode: 'none',
    lines: [{ description: 'A', qty: 1, unitPriceCents: 100, accountId: sales.id }],
  });
  assert.equal(inv.number, 'ZZ-0007');
  const s = call('settings.all');
  assert.equal(s.invoice_next_number, '8');
});

test('api: errors roll back the transaction', () => {
  const { c } = setupBasics();
  const before = db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  assert.throws(() => call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-01-10', dueDate: '2026-01-20', taxMode: 'none',
    lines: [{ description: 'no account', qty: 1, unitPriceCents: 100 }],
  }), /needs an account/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, before);
});
