'use strict';

const DEFAULT_BASE_URL = 'https://au-api.basiq.io';
const DEFAULT_CONSENT_URL = 'https://consent.basiq.io/home';
const REFRESH_BUFFER_MS = 60_000;

function cleanObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

async function readJsonResponse(res, context) {
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const detail = data && (data.message || data.error || data.detail);
    throw new Error(`${context} failed: ${res.status}${detail ? ` ${detail}` : ''}`);
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

function createBasiqBroker({
  apiKey,
  fetch: fetchImpl = global.fetch,
  now = () => Date.now(),
  baseUrl = DEFAULT_BASE_URL,
  consentBaseUrl = DEFAULT_CONSENT_URL,
} = {}) {
  if (!fetchImpl) throw new Error('Basiq broker requires fetch');
  let serverToken = null;
  let serverTokenExpiresAt = 0;

  async function requestToken(scope, extra = {}) {
    if (!apiKey) throw new Error('Basiq API key is not configured');
    const body = new URLSearchParams(cleanObject({ scope, ...extra })).toString();
    const res = await fetchImpl(`${baseUrl}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'basiq-version': '3.0',
      },
      body,
    });
    const data = await readJsonResponse(res, `Basiq ${scope} token`);
    if (!data.access_token) throw new Error(`Basiq ${scope} token response missing access_token`);
    return {
      token: data.access_token,
      expiresAt: now() + (Number(data.expires_in || 3600) * 1000),
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
      body: JSON.stringify(cleanObject({ email, mobile })),
    });
    return readJsonResponse(res, 'Basiq create user');
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
    if (action) url.searchParams.set('action', action);
    return {
      provider: 'basiq',
      userId,
      action,
      url: url.toString(),
    };
  }

  async function authenticatedGet(path, context) {
    const token = await getServerToken();
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    return readJsonResponse(res, context);
  }

  async function listAccounts({ userId } = {}) {
    if (!userId) throw new Error('Basiq userId is required');
    const data = await authenticatedGet(`/users/${encodeURIComponent(userId)}/accounts`, 'Basiq list accounts');
    return (data.data || []).map(mapBasiqAccount);
  }

  async function getJob({ jobId } = {}) {
    if (!jobId) throw new Error('Basiq jobId is required');
    return authenticatedGet(`/jobs/${encodeURIComponent(jobId)}`, 'Basiq get job');
  }

  function publicStatus() {
    return {
      provider: 'basiq',
      configured: Boolean(apiKey),
      serverTokenCached: Boolean(serverToken),
      serverTokenExpiresAt: serverToken ? serverTokenExpiresAt : null,
    };
  }

  return {
    getServerToken,
    createUser,
    createClientToken,
    createConsentUrl,
    listAccounts,
    getJob,
    publicStatus,
  };
}

module.exports = { createBasiqBroker, mapBasiqAccount };
