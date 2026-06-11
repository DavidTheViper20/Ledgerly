'use strict';

// Seeds a database with realistic sample data. Used by the smoke test and
// available manually: node scripts/demo-seed.js /path/to/ledgerly.db

const api = require('../src/api');

function iso(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); }

function seedDemo(db) {
  const call = (m, a) => api.call(db, m, a);

  call('settings.update', {
    org_name: 'Demo Trading Co', org_email: 'accounts@demo.example',
    org_address: '12 Collins Street, Melbourne VIC 3000', org_tax_number: '51 824 753 556',
    base_currency: 'AUD', setup_complete: '1',
  });

  const acme = call('contacts.save', { name: 'Acme Industries', email: 'ap@acme.example', phone: '555-0101', is_customer: true });
  const beta = call('contacts.save', { name: 'Beta Studios', email: 'hello@beta.example', is_customer: true });
  const gamma = call('contacts.save', { name: 'Gamma Web Services', email: 'finance@gamma.example', is_customer: true });
  const office = call('contacts.save', { name: 'OfficeMart Supplies', is_supplier: true });
  const landlord = call('contacts.save', { name: 'Harbour Property Trust', is_supplier: true });

  const acc = (code) => db.prepare('SELECT * FROM accounts WHERE code=?').get(code);
  const taxSales = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Income%'").get();
  const taxPurch = db.prepare("SELECT * FROM tax_rates WHERE name LIKE 'GST on Expenses%'").get();

  const checking = call('bank.createAccount', { name: 'Business Checking', code: '090' });
  const savings = call('bank.createAccount', { name: 'Business Savings', code: '091' });

  call('items.save', {
    code: 'CONSULT', name: 'Consulting (hourly)', sale_price_cents: 15000,
    sale_account_id: acc('200').id, sale_tax_rate_id: taxSales.id, is_sold: 1,
  });
  call('items.save', {
    code: 'SUPPORT', name: 'Support retainer (monthly)', sale_price_cents: 60000,
    sale_account_id: acc('200').id, sale_tax_rate_id: taxSales.id, is_sold: 1,
  });

  // Sales invoices in various states
  const mkInvoice = (contact, daysBack, dueIn, lines, approve = true) => {
    const inv = call('invoices.save', {
      kind: 'ACCREC', contactId: contact.id, issueDate: daysAgo(daysBack),
      dueDate: daysAgo(daysBack - dueIn), taxMode: 'exclusive', lines,
    });
    if (approve) return call('invoices.approve', { id: inv.id });
    return inv;
  };
  const sales = acc('200');

  const inv1 = mkInvoice(acme, 120, 14, [
    { description: 'Consulting — discovery phase', qty: 24, unitPriceCents: 15000, accountId: sales.id, taxRateId: taxSales.id },
  ]);
  call('payments.add', { invoiceId: inv1.id, bankAccountId: checking.id, date: daysAgo(100), amountCents: inv1.total_cents });

  const inv2 = mkInvoice(beta, 45, 14, [
    { description: 'Support retainer — May', qty: 1, unitPriceCents: 60000, accountId: sales.id, taxRateId: taxSales.id },
    { description: 'Additional consulting', qty: 6, unitPriceCents: 15000, accountId: sales.id, taxRateId: taxSales.id },
  ]); // overdue, unpaid

  const inv3 = mkInvoice(gamma, 10, 14, [
    { description: 'Website maintenance', qty: 8, unitPriceCents: 12500, accountId: sales.id, taxRateId: taxSales.id },
  ]); // awaiting payment
  call('payments.add', { invoiceId: inv3.id, bankAccountId: checking.id, date: daysAgo(3), amountCents: 50000 });

  mkInvoice(acme, 2, 14, [
    { description: 'Consulting — sprint 9', qty: 16, unitPriceCents: 15000, accountId: sales.id, taxRateId: taxSales.id },
  ], false); // draft

  // Bills
  const rentBill = call('invoices.save', {
    kind: 'ACCPAY', contactId: landlord.id, issueDate: daysAgo(35), dueDate: daysAgo(5),
    number: 'HPT-2206', taxMode: 'none',
    lines: [{ description: 'Office rent — last month', qty: 1, unitPriceCents: 180000, accountId: acc('469').id }],
  });
  call('invoices.approve', { id: rentBill.id });
  call('payments.add', { invoiceId: rentBill.id, bankAccountId: checking.id, date: daysAgo(20), amountCents: 180000 });

  const supplies = call('invoices.save', {
    kind: 'ACCPAY', contactId: office.id, issueDate: daysAgo(12), dueDate: daysAgo(-10),
    number: 'OM-44831', taxMode: 'exclusive',
    lines: [{ description: 'Stationery and printer ink', qty: 1, unitPriceCents: 23000, accountId: acc('461').id, taxRateId: taxPurch.id }],
  });
  call('invoices.approve', { id: supplies.id }); // awaiting payment

  // Quote
  const q = call('quotes.save', {
    contactId: beta.id, issueDate: daysAgo(7), expiryDate: daysAgo(-23),
    title: 'Q3 support expansion', taxMode: 'exclusive',
    lines: [{ description: 'Extended support retainer', qty: 3, unitPriceCents: 60000, accountId: sales.id, taxRateId: taxSales.id }],
  });
  call('quotes.setStatus', { id: q.id, status: 'SENT' });

  // Spend/receive money + transfer
  call('bank.saveTransaction', {
    kind: 'SPEND', bankAccountId: checking.id, contactId: office.id, date: daysAgo(15),
    reference: 'Card 4421', taxMode: 'inclusive',
    lines: [{ description: 'Team lunch', qty: 1, unitPriceCents: 8600, accountId: acc('420').id }],
  });
  call('bank.saveTransaction', {
    kind: 'RECEIVE', bankAccountId: savings.id, date: daysAgo(8),
    reference: 'INT-MAY', taxMode: 'none',
    lines: [{ description: 'Interest income', qty: 1, unitPriceCents: 1250, accountId: acc('270').id }],
  });
  call('bank.transfer', { fromAccountId: checking.id, toAccountId: savings.id, date: daysAgo(6), amountCents: 100000, reference: 'Monthly sweep' });

  // Credit note for Acme, partially allocated to the open Beta invoice? (must be same contact)
  const cn = call('invoices.save', {
    kind: 'ACCRECCREDIT', contactId: beta.id, issueDate: daysAgo(5), dueDate: daysAgo(5),
    taxMode: 'exclusive',
    lines: [{ description: 'Service credit — May outage', qty: 1, unitPriceCents: 20000, accountId: sales.id, taxRateId: taxSales.id }],
  });
  call('invoices.approve', { id: cn.id });
  call('credits.allocate', { creditId: cn.id, invoiceId: inv2.id, amountCents: 15000, date: daysAgo(4) });

  // Foreign currency invoice (USD)
  const fx = call('invoices.save', {
    kind: 'ACCREC', contactId: acme.id, issueDate: daysAgo(9), dueDate: daysAgo(-5),
    taxMode: 'none', currency: 'USD', exchangeRate: 1.52,
    lines: [{ description: 'US consulting engagement', qty: 10, unitPriceCents: 20000, accountId: sales.id }],
  });
  call('invoices.approve', { id: fx.id });

  // Purchase order
  const po = call('pos.save', {
    contactId: office.id, issueDate: daysAgo(4), deliveryDate: daysAgo(-7), taxMode: 'exclusive',
    deliveryAddress: '12 Collins Street, Melbourne VIC 3000',
    lines: [{ description: 'Standing desks x2', qty: 2, unitPriceCents: 89000, accountId: acc('710').id, taxRateId: taxPurch.id }],
  });
  call('pos.setStatus', { id: po.id, status: 'APPROVED' });

  // Repeating invoice template
  call('repeating.save', {
    kind: 'ACCREC', contactId: beta.id, reference: 'Support retainer', taxMode: 'exclusive',
    scheduleEvery: 1, scheduleUnit: 'MONTH', nextDate: daysAgo(-12), dueDays: 14, autoApprove: 1,
    lines: [{ description: 'Monthly support retainer', qty: 1, unitPriceCents: 60000, accountId: sales.id, taxRateId: taxSales.id }],
  });

  // Expense claim
  const claim = call('claims.save', {
    payee: 'David', date: daysAgo(6),
    lines: [
      { description: 'Client lunch', merchant: 'Lygon St Trattoria', grossCents: 8470, accountId: acc('420').id },
      { description: 'Taxi to airport', merchant: '13CABS', grossCents: 6600, accountId: acc('493').id, taxRateId: taxPurch.id },
    ],
  });
  call('claims.setStatus', { id: claim.id, status: 'SUBMITTED' });
  call('claims.approve', { id: claim.id });

  // Fixed asset with six months of depreciation
  const asset = call('assets.save', {
    name: 'MacBook Pro 16"', number: 'FA-0001', purchaseDate: daysAgo(200), costCents: 460000,
    residualCents: 100000, lifeYears: 3,
    assetAccountId: acc('720').id, accumAccountId: acc('721').id, expenseAccountId: acc('416').id,
  });
  call('assets.register', { id: asset.id });
  call('assets.runDepreciation', { toPeriod: daysAgo(30).slice(0, 7) });

  // Project with time and a cost
  const project = call('projects.save', { name: 'Acme platform rebuild', contactId: acme.id, hourlyRateCents: 16500 });
  call('projects.saveTime', { projectId: project.id, date: daysAgo(3), hours: 6, description: 'API integration' });
  call('projects.saveTime', { projectId: project.id, date: daysAgo(2), hours: 4.5, description: 'Frontend work' });

  // Payroll: two employees and a posted fortnightly run
  call('payroll.saveEmployee', { name: 'Jess Chen', email: 'jess@demo.example', payBasis: 'SALARY', payRateCents: 9500000 });
  call('payroll.saveEmployee', { name: 'Sam Patel', payBasis: 'HOURLY', payRateCents: 4200, hoursPerWeek: 24 });
  const run = call('payroll.createRun', {
    periodStart: daysAgo(18), periodEnd: daysAgo(5), paymentDate: daysAgo(4),
  });
  call('payroll.postRun', { id: run.id });

  // Budget for the sales account, current FY months
  const months = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }
  call('budgets.set', { rows: months.map(m => ({ accountId: sales.id, month: m, amountCents: 800000 })) });

  // Statement lines to reconcile (one auto-matchable, one needing create)
  const csv = [
    'Date,Payee,Description,Amount',
    `${daysAgo(3)},GAMMA WEB SERVICES,Invoice payment,500.00`,
    `${daysAgo(2)},CITY POWER,Electricity,-142.18`,
    `${daysAgo(1)},STRIPE PAYOUT,Card settlement,830.00`,
  ].join('\n');
  call('bank.importStatement', { bankAccountId: checking.id, csv });

  return { ok: true };
}

module.exports = { seedDemo };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/demo-seed.js /path/to/ledgerly.db'); process.exit(1); }
  const dbm = require('../src/db');
  const db = dbm.open(file);
  seedDemo(db);
  console.log('Demo data seeded into', file);
}
