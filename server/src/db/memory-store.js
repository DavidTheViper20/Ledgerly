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
    revokedAt: row.revokedAt,
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
  const auditEvents = [];
  let userSeq = 1;
  let orgSeq = 1;
  let deviceSeq = 1;
  let providerUserSeq = 1;
  let connectionSeq = 1;
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

  return {
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
    firstBankFeedConnection,
    revokeBankFeedConnection,
    addAuditEvent,
    listAuditEventsForUser,
  };
}

module.exports = {
  createMemoryStore,
};
