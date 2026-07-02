'use strict';

function makeId(prefix, next) {
  return `${prefix}_${String(next).padStart(4, '0')}`;
}

function publicUser(user) {
  return {
    id: user.id,
    identityProvider: user.identityProvider,
    identitySubject: user.identitySubject,
    email: user.email,
    name: user.name,
  };
}

function publicOrganization(org, role) {
  return {
    id: org.id,
    name: org.name,
    role,
  };
}

function publicDevice(device) {
  return {
    id: device.id,
    organizationId: device.organizationId,
    userId: device.userId,
    deviceName: device.deviceName,
    publicKey: device.publicKey,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  };
}

function publicBankProviderUser(row) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    providerUserId: row.providerUserId,
  };
}

function publicBankConnection(row) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    providerUserId: row.providerUserId,
    providerConnectionId: row.providerConnectionId,
    institutionName: row.institutionName,
    consentStatus: row.consentStatus,
    consentExpiresAt: row.consentExpiresAt,
    lastSyncAt: row.lastSyncAt,
    revokedAt: row.revokedAt,
  };
}

function publicBankFeedAccount(row, connection) {
  return {
    id: row.id,
    organizationId: connection.organizationId,
    connectionId: row.connectionId,
    provider: connection.provider,
    providerAccountId: row.providerAccountId,
    providerAccountName: row.providerAccountName,
    providerAccountNumberLast4: row.providerAccountNumberLast4,
    providerAccountType: row.providerAccountType,
    desktopBankAccountLocalId: row.desktopBankAccountLocalId,
    syncCursor: row.syncCursor,
    lastSyncAt: row.lastSyncAt,
  };
}

function publicSyncRun(row) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    bankFeedAccountId: row.bankFeedAccountId,
    status: row.status,
    importedCount: row.importedCount,
    skippedCount: row.skippedCount,
    errorMessage: row.errorMessage,
    idempotencyKey: row.idempotencyKey,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    result: row.result || null,
  };
}

function publicAuditEvent(row) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    eventType: row.eventType,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function createMemoryStore({ now = () => new Date().toISOString() } = {}) {
  const users = new Map();
  const orgs = new Map();
  const memberships = [];
  const devices = new Map();
  const providerUsers = new Map();
  const bankConnections = new Map();
  const bankAccounts = new Map();
  const syncRuns = new Map();
  const syncRunsByIdempotency = new Map();
  const auditEvents = [];
  let userSeq = 1;
  let orgSeq = 1;
  let deviceSeq = 1;
  let providerUserSeq = 1;
  let connectionSeq = 1;
  let bankAccountSeq = 1;
  let syncRunSeq = 1;
  let auditSeq = 1;

  function upsertUserFromClaims(claims) {
    if (!claims.sub) throw new Error('Token subject is required');
    let user = users.get(claims.sub);
    if (!user) {
      user = {
        id: makeId('usr', userSeq++),
        identityProvider: claims.iss || '',
        identitySubject: claims.sub,
        email: claims.email || '',
        name: claims.name || claims.email || '',
        createdAt: now(),
      };
      users.set(claims.sub, user);
    } else {
      user.email = claims.email || user.email;
      user.name = claims.name || user.name;
    }
    return publicUser(user);
  }

  function listOrganizationsForUser(userId) {
    return memberships
      .filter(m => m.userId === userId)
      .map(m => publicOrganization(orgs.get(m.organizationId), m.role))
      .filter(o => o.id);
  }

  function createOrganization({ userId, name }) {
    if (!name || !String(name).trim()) throw new Error('Organization name is required');
    const org = {
      id: makeId('org', orgSeq++),
      name: String(name).trim(),
      billingCustomerId: '',
      createdAt: now(),
    };
    orgs.set(org.id, org);
    const membership = {
      organizationId: org.id,
      userId,
      role: 'owner',
      createdAt: now(),
    };
    memberships.push(membership);
    return {
      organization: publicOrganization(org, membership.role),
      membership: { role: membership.role },
    };
  }

  function membershipFor(userId, organizationId) {
    return memberships.find(m => m.userId === userId && m.organizationId === organizationId) || null;
  }

  function setMembershipRole({ userId, organizationId, role }) {
    const membership = membershipFor(userId, organizationId);
    if (!membership) throw new Error('Organization membership required');
    membership.role = role;
    return { role };
  }

  function organizationFor(userId, organizationId) {
    const membership = membershipFor(userId, organizationId);
    if (!membership) return null;
    const org = orgs.get(organizationId);
    if (!org) return null;
    return publicOrganization(org, membership.role);
  }

  function registerDevice({ userId, organizationId, deviceName, publicKey }) {
    if (!organizationFor(userId, organizationId)) throw new Error('Organization membership required');
    const device = {
      id: makeId('dev', deviceSeq++),
      userId,
      organizationId,
      deviceName: String(deviceName || '').trim(),
      publicKey: String(publicKey || '').trim(),
      lastSeenAt: now(),
      revokedAt: null,
      createdAt: now(),
    };
    devices.set(device.id, device);
    return publicDevice(device);
  }

  function revokeDevice({ userId, organizationId, deviceId }) {
    if (!organizationFor(userId, organizationId)) throw new Error('Organization membership required');
    const device = devices.get(deviceId);
    if (!device || device.organizationId !== organizationId) throw new Error('Device not found');
    device.revokedAt = now();
    return publicDevice(device);
  }

  function getBankProviderUser({ organizationId, provider }) {
    const row = providerUsers.get(`${organizationId}:${provider}`);
    return row ? publicBankProviderUser(row) : null;
  }

  function upsertBankProviderUser({ organizationId, provider, providerUserId }) {
    const key = `${organizationId}:${provider}`;
    let row = providerUsers.get(key);
    if (!row) {
      row = {
        id: makeId('bpu', providerUserSeq++),
        organizationId,
        provider,
        providerUserId,
        createdAt: now(),
      };
      providerUsers.set(key, row);
    } else {
      row.providerUserId = providerUserId;
    }
    return publicBankProviderUser(row);
  }

  function upsertBankFeedConnection({
    organizationId,
    provider = 'basiq',
    providerUserId,
    providerConnectionId = '',
    institutionName = '',
    consentStatus = 'pending',
    consentExpiresAt = null,
    revokedAt = null,
  }) {
    const key = `${organizationId}:${provider}:${providerUserId}:${providerConnectionId}`;
    let row = bankConnections.get(key);
    if (!row) {
      row = {
        id: makeId('bfc', connectionSeq++),
        organizationId,
        provider,
        providerUserId,
        providerConnectionId,
        institutionName,
        consentStatus,
        consentExpiresAt,
        lastSyncAt: null,
        revokedAt,
        createdAt: now(),
        updatedAt: now(),
      };
      bankConnections.set(key, row);
    } else {
      row.institutionName = institutionName || row.institutionName;
      row.consentStatus = consentStatus || row.consentStatus;
      row.consentExpiresAt = consentExpiresAt || row.consentExpiresAt;
      row.revokedAt = revokedAt;
      row.updatedAt = now();
    }
    return publicBankConnection(row);
  }

  function listBankFeedConnections({ organizationId, provider = 'basiq' }) {
    return Array.from(bankConnections.values())
      .filter(row => row.organizationId === organizationId && row.provider === provider)
      .map(publicBankConnection);
  }

  function bankFeedConnectionById({ organizationId, connectionId }) {
    for (const row of bankConnections.values()) {
      if (row.id === connectionId && row.organizationId === organizationId && !row.revokedAt) {
        return publicBankConnection(row);
      }
    }
    return null;
  }

  function firstBankFeedConnection({ organizationId, provider = 'basiq' }) {
    for (const row of bankConnections.values()) {
      if (row.organizationId === organizationId && row.provider === provider && !row.revokedAt) {
        return publicBankConnection(row);
      }
    }
    return null;
  }

  function revokeBankFeedConnection({ organizationId, providerConnectionId }) {
    for (const row of bankConnections.values()) {
      if (row.organizationId === organizationId && row.providerConnectionId === providerConnectionId) {
        row.revokedAt = now();
        row.consentStatus = 'revoked';
        row.updatedAt = now();
        return publicBankConnection(row);
      }
    }
    return null;
  }

  function upsertBankFeedAccount({
    connectionId,
    providerAccountId,
    providerAccountName = '',
    providerAccountNumber = '',
    providerAccountNumberLast4 = '',
    providerAccountType = '',
    desktopBankAccountLocalId = '',
    syncCursor = '',
  }) {
    const connection = Array.from(bankConnections.values()).find(row => row.id === connectionId && !row.revokedAt);
    if (!connection) throw new Error('Bank feed connection not found');
    if (!providerAccountId) throw new Error('Provider account ID is required');
    const key = `${connectionId}:${providerAccountId}`;
    const last4 = String(providerAccountNumberLast4 || providerAccountNumber || '').replace(/\D/g, '').slice(-4);
    let row = bankAccounts.get(key);
    if (!row) {
      row = {
        id: makeId('bfa', bankAccountSeq++),
        connectionId,
        providerAccountId,
        providerAccountName,
        providerAccountNumberLast4: last4,
        providerAccountType,
        desktopBankAccountLocalId: String(desktopBankAccountLocalId || ''),
        syncCursor,
        lastSyncAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      bankAccounts.set(key, row);
    } else {
      row.providerAccountName = providerAccountName || row.providerAccountName;
      row.providerAccountNumberLast4 = last4 || row.providerAccountNumberLast4;
      row.providerAccountType = providerAccountType || row.providerAccountType;
      row.desktopBankAccountLocalId = String(desktopBankAccountLocalId || row.desktopBankAccountLocalId || '');
      row.syncCursor = syncCursor || row.syncCursor;
      row.updatedAt = now();
    }
    return publicBankFeedAccount(row, connection);
  }

  function listBankFeedAccounts({ organizationId, connectionId } = {}) {
    return Array.from(bankAccounts.values())
      .map(row => {
        const connection = Array.from(bankConnections.values()).find(c => c.id === row.connectionId);
        return connection ? { row, connection } : null;
      })
      .filter(item => item && (!organizationId || item.connection.organizationId === organizationId))
      .filter(item => !connectionId || item.connection.id === connectionId)
      .map(item => publicBankFeedAccount(item.row, item.connection));
  }

  function bankFeedAccountByProvider({ organizationId, providerAccountId }) {
    for (const row of bankAccounts.values()) {
      const connection = Array.from(bankConnections.values()).find(c => c.id === row.connectionId);
      if (connection && connection.organizationId === organizationId && row.providerAccountId === providerAccountId) {
        return {
          account: publicBankFeedAccount(row, connection),
          connection: publicBankConnection(connection),
        };
      }
    }
    return null;
  }

  function startBankFeedSyncRun({ organizationId, bankFeedAccountId, idempotencyKey = '' }) {
    const key = idempotencyKey ? `${organizationId}:${idempotencyKey}` : '';
    if (key && syncRunsByIdempotency.has(key)) {
      return {
        syncRun: publicSyncRun(syncRuns.get(syncRunsByIdempotency.get(key))),
        replayed: true,
      };
    }
    const row = {
      id: makeId('bfs', syncRunSeq++),
      organizationId,
      bankFeedAccountId,
      status: 'running',
      importedCount: 0,
      skippedCount: 0,
      errorMessage: '',
      idempotencyKey,
      result: null,
      startedAt: now(),
      finishedAt: null,
    };
    syncRuns.set(row.id, row);
    if (key) syncRunsByIdempotency.set(key, row.id);
    return { syncRun: publicSyncRun(row), replayed: false };
  }

  function finishBankFeedSyncRun({
    syncRunId,
    status,
    importedCount = 0,
    skippedCount = 0,
    errorMessage = '',
    result = null,
  }) {
    const row = syncRuns.get(syncRunId);
    if (!row) throw new Error('Bank feed sync run not found');
    row.status = status;
    row.importedCount = importedCount;
    row.skippedCount = skippedCount;
    row.errorMessage = errorMessage;
    row.result = result;
    row.finishedAt = now();
    if (status === 'succeeded') {
      for (const account of bankAccounts.values()) {
        if (account.id === row.bankFeedAccountId) {
          account.lastSyncAt = row.finishedAt;
          account.updatedAt = now();
          const connection = Array.from(bankConnections.values()).find(c => c.id === account.connectionId);
          if (connection) {
            connection.lastSyncAt = row.finishedAt;
            connection.updatedAt = now();
          }
        }
      }
    }
    return publicSyncRun(row);
  }

  function listBankFeedSyncRuns({ organizationId } = {}) {
    return Array.from(syncRuns.values())
      .filter(row => !organizationId || row.organizationId === organizationId)
      .map(publicSyncRun);
  }

  function addAuditEvent({ organizationId, userId, deviceId = null, eventType, metadata = {} }) {
    const event = {
      id: makeId('aud', auditSeq++),
      organizationId,
      userId,
      deviceId,
      eventType,
      metadata,
      createdAt: now(),
    };
    auditEvents.push(event);
    return publicAuditEvent(event);
  }

  function listAuditEventsForUser(userId) {
    const orgIds = new Set(memberships.filter(m => m.userId === userId).map(m => m.organizationId));
    return auditEvents
      .filter(e => orgIds.has(e.organizationId))
      .map(publicAuditEvent);
  }

  function healthCheck() {
    return { ok: true, store: 'memory' };
  }

  return {
    healthCheck,
    upsertUserFromClaims,
    listOrganizationsForUser,
    createOrganization,
    membershipFor,
    setMembershipRole,
    organizationFor,
    registerDevice,
    revokeDevice,
    getBankProviderUser,
    upsertBankProviderUser,
    upsertBankFeedConnection,
    listBankFeedConnections,
    bankFeedConnectionById,
    firstBankFeedConnection,
    revokeBankFeedConnection,
    upsertBankFeedAccount,
    listBankFeedAccounts,
    bankFeedAccountByProvider,
    startBankFeedSyncRun,
    finishBankFeedSyncRun,
    listBankFeedSyncRuns,
    addAuditEvent,
    listAuditEventsForUser,
  };
}

module.exports = {
  createMemoryStore,
};
