'use strict';

const crypto = require('node:crypto');

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// Track A single-user verifier: one shared bearer token maps to one implicit
// identity. Anything that is not exactly the configured token is rejected, so
// bank-feed routes still require auth in this mode. Replaced by OIDC/JWKS
// verification (auth mode 'oidc') once an identity tenant exists.
function createStaticTokenVerifier({ staticToken } = {}) {
  if (!staticToken || String(staticToken).length < 32) {
    throw new Error('Static auth mode requires CLOUD_STATIC_TOKEN of at least 32 characters');
  }
  return async function verifyStaticToken(token) {
    if (!timingSafeEqualString(token, staticToken)) {
      throw new Error('Invalid bearer token');
    }
    return {
      sub: 'static|owner',
      iss: 'ledgerly-static',
      email: 'owner@ledgerly.local',
      name: 'Ledgerly Owner',
    };
  };
}

module.exports = { createStaticTokenVerifier };
