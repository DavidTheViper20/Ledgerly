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

function createMemoryStore({ now = () => new Date().toISOString() } = {}) {
  const users = new Map();
  const orgs = new Map();
  const memberships = [];
  const devices = new Map();
  let userSeq = 1;
  let orgSeq = 1;
  let deviceSeq = 1;

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

  return {
    upsertUserFromClaims,
    listOrganizationsForUser,
    createOrganization,
    membershipFor,
    organizationFor,
    registerDevice,
    revokeDevice,
  };
}

module.exports = {
  createMemoryStore,
};
