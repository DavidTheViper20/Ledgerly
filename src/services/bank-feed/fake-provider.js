'use strict';

const { importProviderTransactions } = require('./importer');

async function sync(db, { bankAccountId, providerAccountId }) {
  return importProviderTransactions(db, {
    provider: 'fake',
    bankAccountId,
    transactions: [
      {
        sourceAccountId: providerAccountId,
        sourceTransactionId: `${providerAccountId}-deposit-1`,
        date: '2026-06-10',
        payee: 'Acme Ltd',
        description: 'Customer deposit',
        reference: 'INV-1001',
        amountCents: 125000,
        postedAt: '2026-06-10T09:00:00Z',
        raw: { fixture: true },
      },
      {
        sourceAccountId: providerAccountId,
        sourceTransactionId: `${providerAccountId}-card-1`,
        date: '2026-06-11',
        payee: 'Officeworks',
        description: 'Office supplies',
        reference: 'CARD',
        amountCents: -8800,
        postedAt: '2026-06-11T10:00:00Z',
        raw: { fixture: true },
      },
    ],
  });
}

module.exports = { sync };
