'use strict';

const { importProviderTransactions } = require('./importer');

const BASE_URL = 'https://au-api.basiq.io';

function toCents(value) {
  return Math.round(Number(String(value || '0').replace(/,/g, '')) * 100);
}

function mapBasiqTransaction(tx) {
  return {
    provider: 'basiq',
    sourceAccountId: String(tx.account || tx.accountId || ''),
    sourceTransactionId: String(tx.id),
    date: String(tx.postDate || tx.transactionDate || tx.date || '').slice(0, 10),
    payee: tx.merchant?.businessName || tx.institution || '',
    description: tx.description || tx.class || '',
    reference: tx.reference || '',
    amountCents: toCents(tx.amount),
    postedAt: tx.postDate || tx.transactionDate || null,
    raw: tx,
  };
}

async function requestJson({ token, path, method = 'GET', body = null }) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Basiq ${method} ${path} failed: ${res.status}`);
  return res.json();
}

async function syncTransactions(db, { serverToken, userId, providerAccountId, bankAccountId }) {
  const data = await requestJson({
    token: serverToken,
    path: `/users/${encodeURIComponent(userId)}/transactions?limit=500`,
  });
  const transactions = (data.data || [])
    .map(mapBasiqTransaction)
    .filter(tx => tx.sourceAccountId === providerAccountId);
  return importProviderTransactions(db, {
    provider: 'basiq',
    bankAccountId,
    transactions,
  });
}

module.exports = { mapBasiqTransaction, syncTransactions };
