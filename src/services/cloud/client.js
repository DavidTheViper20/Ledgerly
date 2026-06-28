'use strict';

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function createCloudClient({
  baseUrl = '',
  sessionToken = '',
  getSessionToken,
  organizationId = '',
  fetch: fetchImpl = global.fetch,
} = {}) {
  if (!fetchImpl) throw new Error('Ledgerly Cloud client requires fetch');
  const root = trimSlash(baseUrl);
  const tokenProvider = getSessionToken || (() => sessionToken);

  function publicStatus() {
    return {
      configured: Boolean(root && tokenProvider()),
      baseUrl: root,
      organizationConfigured: Boolean(organizationId),
    };
  }

  function resolveOrganizationId(input = {}) {
    return input.organizationId || organizationId;
  }

  async function request(path, {
    method = 'GET',
    body,
    query,
    headers = {},
  } = {}) {
    if (!root) throw new Error('Ledgerly Cloud URL is not configured');
    const token = await tokenProvider();
    if (!token) throw new Error('Ledgerly Cloud session is not configured');
    const url = new URL(`${root}${path}`);
    for (const [key, value] of Object.entries(compact(query || {}))) {
      url.searchParams.set(key, value);
    }
    const res = await fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(compact(body)) } : {}),
    });
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) {
      const err = new Error(data.error?.message || `Ledgerly Cloud request failed: ${res.status}`);
      err.status = res.status;
      err.code = data.error?.code || 'cloud_request_failed';
      throw err;
    }
    return data;
  }

  function status(input = {}) {
    return request('/v1/bank-feeds/status', {
      query: { organizationId: resolveOrganizationId(input) },
    });
  }

  function startConnect(input = {}) {
    return request('/v1/bank-feeds/connect/start', {
      method: 'POST',
      body: {
        organizationId: resolveOrganizationId(input),
        email: input.email,
        mobile: input.mobile,
        action: input.action,
      },
    });
  }

  function listProviderAccounts(input = {}) {
    return request('/v1/bank-feeds/provider-accounts', {
      query: { organizationId: resolveOrganizationId(input) },
    });
  }

  function mapProviderAccount(input = {}) {
    return request('/v1/bank-feeds/account-links', {
      method: 'POST',
      body: {
        organizationId: resolveOrganizationId(input),
        providerAccountId: input.providerAccountId,
        providerAccountName: input.providerAccountName,
        providerAccountNumber: input.providerAccountNumber,
        providerAccountType: input.providerAccountType,
        desktopBankAccountLocalId: input.desktopBankAccountLocalId,
        syncCursor: input.syncCursor,
      },
    });
  }

  function syncLinkedAccount(input = {}) {
    return request('/v1/bank-feeds/sync', {
      method: 'POST',
      headers: input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {},
      body: {
        organizationId: resolveOrganizationId(input),
        providerAccountId: input.providerAccountId,
        desktopBankAccountLocalId: input.desktopBankAccountLocalId,
      },
    });
  }

  function manageConsent(input = {}) {
    const action = input.action === 'reconnect' ? 'reconnect' : 'manage';
    return request(`/v1/bank-feeds/consent/${action}`, {
      method: 'POST',
      body: {
        organizationId: resolveOrganizationId(input),
      },
    });
  }

  return {
    publicStatus,
    status,
    startConnect,
    listProviderAccounts,
    mapProviderAccount,
    syncLinkedAccount,
    manageConsent,
  };
}

module.exports = { createCloudClient };
