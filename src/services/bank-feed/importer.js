'use strict';

const bank = require('../bank');
const { normalizeFeedTransaction } = require('./normalise');

function importProviderTransactions(db, { provider, bankAccountId, transactions }) {
  const normalized = transactions.map(tx => normalizeFeedTransaction(provider, tx));
  return bank.importFeedTransactions(db, { bankAccountId, transactions: normalized });
}

module.exports = { importProviderTransactions };
