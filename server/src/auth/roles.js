'use strict';

const ROLE_PERMISSIONS = {
  owner: new Set([
    'organizations.read',
    'organizations.manage',
    'devices.manage',
    'bank_feeds.manage',
  ]),
  admin: new Set([
    'organizations.read',
    'organizations.manage',
    'devices.manage',
    'bank_feeds.manage',
  ]),
  bookkeeper: new Set([
    'organizations.read',
    'bank_feeds.manage',
  ]),
  viewer: new Set([
    'organizations.read',
  ]),
};

function can(role, permission) {
  return Boolean(ROLE_PERMISSIONS[role]?.has(permission));
}

module.exports = {
  ROLE_PERMISSIONS,
  can,
};
