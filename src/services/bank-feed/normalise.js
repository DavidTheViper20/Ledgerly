'use strict';

function normalizeFeedTransaction(provider, tx) {
  if (!provider) throw new Error('Provider is required');
  if (!tx.sourceTransactionId) throw new Error('sourceTransactionId is required');
  if (!tx.date) throw new Error('date is required');
  const amountCents = Math.round(Number(tx.amountCents));
  if (!Number.isFinite(amountCents) || amountCents === 0) throw new Error('amountCents must be a non-zero number');
  return {
    provider,
    sourceAccountId: tx.sourceAccountId || '',
    sourceTransactionId: String(tx.sourceTransactionId),
    date: tx.date,
    payee: tx.payee || '',
    description: tx.description || '',
    reference: tx.reference || '',
    amountCents,
    postedAt: tx.postedAt || null,
    raw: tx.raw || tx,
  };
}

module.exports = { normalizeFeedTransaction };
