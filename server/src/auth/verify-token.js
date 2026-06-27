'use strict';

const crypto = require('node:crypto');

function decodeJson(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid bearer token');
  }
}

function secondsNow(now) {
  const value = Number(now());
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function audienceMatches(actual, expected) {
  if (Array.isArray(actual)) return actual.includes(expected);
  return actual === expected;
}

function createJwtVerifier({ issuer, audience, jwks, now = () => Date.now() } = {}) {
  if (!issuer) throw new Error('OIDC issuer is required');
  if (!audience) throw new Error('OIDC audience is required');
  if (!jwks || !Array.isArray(jwks.keys)) throw new Error('OIDC JWKS is required');

  return async function verifyJwt(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts.some(p => !p)) throw new Error('Invalid bearer token');

    const header = decodeJson(parts[0]);
    const claims = decodeJson(parts[1]);
    if (header.alg !== 'RS256') throw new Error('Unsupported token algorithm');

    const jwk = jwks.keys.find(key => key.kid === header.kid);
    if (!jwk) throw new Error('Unknown token signing key');

    const unsigned = `${parts[0]}.${parts[1]}`;
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(unsigned),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    );
    if (!ok) throw new Error('Invalid token signature');

    if (claims.iss !== issuer) throw new Error('Invalid token issuer');
    if (!audienceMatches(claims.aud, audience)) throw new Error('Invalid token audience');

    const nowSeconds = secondsNow(now);
    if (claims.exp && nowSeconds >= Number(claims.exp)) throw new Error('Token expired');
    if (claims.nbf && nowSeconds < Number(claims.nbf)) throw new Error('Token not active');

    return claims;
  };
}

function defaultJwksUrl(issuer) {
  return `${String(issuer || '').replace(/\/+$/, '')}/.well-known/jwks.json`;
}

function createRemoteJwksVerifier({
  issuer,
  audience,
  jwksUrl = defaultJwksUrl(issuer),
  fetch: fetchImpl = global.fetch,
  now = () => Date.now(),
} = {}) {
  if (!fetchImpl) throw new Error('OIDC JWKS fetch is not available');
  let cachedVerifier = null;

  async function loadVerifier() {
    if (cachedVerifier) return cachedVerifier;
    const res = await fetchImpl(jwksUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`OIDC JWKS fetch failed: ${res.status}`);
    const jwks = await res.json();
    cachedVerifier = createJwtVerifier({ issuer, audience, jwks, now });
    return cachedVerifier;
  }

  return async function verifyRemoteJwt(token) {
    const verifier = await loadVerifier();
    return verifier(token);
  };
}

async function verifyBearerAuth(headers = {}, verifyToken) {
  const auth = headers.authorization || headers.Authorization || '';
  if (!auth) throw new Error('Missing bearer token');
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) throw new Error('Missing bearer token');
  try {
    return await verifyToken(match[1]);
  } catch (err) {
    if (err.message === 'Missing bearer token') throw err;
    throw err.message === 'Invalid bearer token' ? err : new Error(err.message || 'Invalid bearer token');
  }
}

module.exports = {
  createJwtVerifier,
  createRemoteJwksVerifier,
  verifyBearerAuth,
};
