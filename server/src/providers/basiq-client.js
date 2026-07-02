'use strict';

const DEFAULT_BASE_URL = 'https://au-api.basiq.io';
const DEFAULT_CONSENT_URL = 'https://consent.basiq.io/home';
const REFRESH_BUFFER_MS = 60_000;

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function providerError(context, status, detail = '') {
  const err = new Error(`${context} failed: ${status}${detail ? ` ${detail}` : ''}`);
  err.code = 'basiq_upstream_error';
  err.status = 502;
  return err;
}

async function readJson(res, context) {
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const detail = data && (data.message || data.error || data.detail);
    throw providerError(context, res.status, detail);
  }
  return data || {};
}

function mapBasiqAccount(account) {
  return {
    provider: 'basiq',
    providerAccountId: String(account.id || ''),
    providerAccountName: account.name || account.nickname || account.displayName || '',
    providerAccountNumber: account.accountNo || account.accountNumber || account.number || '',
    providerAccountType: account.class?.type || account.type || '',
    raw: account,
  };
}

function toCents(value) {
  if (typeof value === 'object' && value !== null) {
    return toCents(value.amount ?? value.value ?? value.total);
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

function mapBasiqTransaction(tx, providerAccountId = '') {
  const accountId = tx.account || tx.accountId || tx.account_id || providerAccountId;
  return {
    sourceAccountId: String(accountId || ''),
    sourceTransactionId: String(tx.id || tx.transactionId || tx.transaction_id || ''),
    date: dateOnly(tx.postDate || tx.transactionDate || tx.date || tx.created),
    payee: tx.merchant?.name || tx.payee || tx.description || '',
    description: tx.description || tx.summary || tx.payee || '',
    reference: tx.reference || tx.receiptNumber || tx.class?.code || '',
    amountCents: toCents(tx.amount),
    postedAt: tx.postDate || tx.transactionDate || tx.date || null,
    raw: tx,
  };
}

function createBasiqClient({
  apiKey,
  fetch: fetchImpl = global.fetch,
  now = () => Date.now(),
  baseUrl = DEFAULT_BASE_URL,
  consentBaseUrl = DEFAULT_CONSENT_URL,
} = {}) {
  if (!fetchImpl) throw new Error('Basiq client requires fetch');
  let serverToken = null;
  let serverTokenExpiresAt = 0;

  async function requestToken(scope, extra = {}) {
    if (!apiKey) throw new Error('Basiq API key is not configured');
    const res = await fetchImpl(`${baseUrl}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'basiq-version': '3.0',
      },
      body: new URLSearchParams(compact({ scope, ...extra })).toString(),
    });
    const data = await readJson(res, `Basiq ${scope} token`);
    if (!data.access_token) throw providerError(`Basiq ${scope} token`, 502, 'missing access_token');
    return {
      token: data.access_token,
      expiresAt: now() + Number(data.expires_in || 3600) * 1000,
    };
  }

  async function getServerToken() {
    if (serverToken && now() < serverTokenExpiresAt - REFRESH_BUFFER_MS) return serverToken;
    const next = await requestToken('SERVER_ACCESS');
    serverToken = next.token;
    serverTokenExpiresAt = next.expiresAt;
    return serverToken;
  }

  async function createUser({ email, mobile } = {}) {
    const token = await getServerToken();
    const res = await fetchImpl(`${baseUrl}/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(compact({ email, mobile })),
    });
    return readJson(res, 'Basiq create user');
  }

  async function createClientToken({ userId } = {}) {
    if (!userId) throw new Error('Basiq userId is required');
    const next = await requestToken('CLIENT_ACCESS', { userId });
    return next.token;
  }

  async function createConsentUrl({ userId, action = 'connect' } = {}) {
    const clientToken = await createClientToken({ userId });
    const url = new URL(consentBaseUrl);
    url.searchParams.set('token', clientToken);
    url.searchParams.set('action', action);
    return {
      provider: 'basiq',
      userId,
      action,
      url: url.toString(),
    };
  }

  async function authenticatedGet(path, context) {
    const token = await getServerToken();
    const target = /^https?:\/\//.test(path) ? path : `${baseUrl}${path}`;
    const res = await fetchImpl(target, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    return readJson(res, context);
  }

  async function listAccounts({ userId } = {}) {
    if (!userId) throw new Error('Basiq userId is required');
    const data = await authenticatedGet(`/users/${encodeURIComponent(userId)}/accounts`, 'Basiq list accounts');
    return (data.data || []).map(mapBasiqAccount);
  }

  // Incremental pull: syncCursor is the last post date (YYYY-MM-DD) already
  // seen for this account. We re-fetch from that day (inclusive, so boundary
  // transactions are never missed — the desktop dedupe drops repeats) and
  // follow Basiq's pagination links. Returns { transactions, nextCursor }.
  async function listTransactions({ userId, providerAccountId, syncCursor = '', maxPages = 20 } = {}) {
    if (!userId) throw new Error('Basiq userId is required');
    if (!providerAccountId) throw new Error('Basiq providerAccountId is required');
    const filters = [`account.id.eq('${providerAccountId}')`];
    if (syncCursor) filters.push(`transaction.postDate.gteq('${syncCursor}')`);
    const params = new URLSearchParams({ filter: filters.join(',') });

    const transactions = [];
    let next = `/users/${encodeURIComponent(userId)}/transactions?${params.toString()}`;
    for (let page = 0; next && page < maxPages; page++) {
      const data = await authenticatedGet(next, 'Basiq list transactions');
      for (const tx of data.data || []) {
        transactions.push(mapBasiqTransaction(tx, providerAccountId));
      }
      next = data.links?.next || '';
    }

    let nextCursor = syncCursor;
    for (const tx of transactions) {
      if (tx.date && tx.date > nextCursor) nextCursor = tx.date;
    }
    return { transactions, nextCursor };
  }

  async function getJob({ jobId } = {}) {
    if (!jobId) throw new Error('Basiq jobId is required');
    return authenticatedGet(`/jobs/${encodeURIComponent(jobId)}`, 'Basiq get job');
  }

  async function revokeConnection({ providerConnectionId } = {}) {
    if (!providerConnectionId) throw new Error('Basiq providerConnectionId is required');
    return { ok: true };
  }

  return {
    getServerToken,
    createUser,
    createClientToken,
    createConsentUrl,
    listAccounts,
    listTransactions,
    getJob,
    revokeConnection,
  };
}

module.exports = {
  createBasiqClient,
  mapBasiqAccount,
  mapBasiqTransaction,
};
