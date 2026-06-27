'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { createJwtVerifier, createRemoteJwksVerifier, verifyBearerAuth } = require('../src/auth/verify-token');
const { can } = require('../src/auth/roles');

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signJwt(privateKey, payload, { kid = 'test-key', issuer = 'https://issuer.test/', audience = 'ledgerly-api-test' } = {}) {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const claims = {
    iss: issuer,
    aud: audience,
    sub: 'auth0|user-1',
    email: 'owner@example.com',
    name: 'Owner Example',
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    ...payload,
  };
  const unsigned = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

function keyFixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privateKey,
    jwks: { keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] },
  };
}

test('auth: verifies a valid RS256 OIDC access token from JWKS', async () => {
  const { privateKey, jwks } = keyFixture();
  const token = signJwt(privateKey, { sub: 'auth0|verified-user' });
  const verify = createJwtVerifier({
    issuer: 'https://issuer.test/',
    audience: 'ledgerly-api-test',
    jwks,
  });

  const claims = await verify(token);

  assert.equal(claims.sub, 'auth0|verified-user');
  assert.equal(claims.email, 'owner@example.com');
  assert.equal(claims.name, 'Owner Example');
});

test('auth: remote JWKS verifier fetches signing keys once and caches them', async () => {
  const { privateKey, jwks } = keyFixture();
  const token = signJwt(privateKey, { sub: 'auth0|remote-user' });
  const fetchCalls = [];
  const verify = createRemoteJwksVerifier({
    issuer: 'https://issuer.test/',
    audience: 'ledgerly-api-test',
    jwksUrl: 'https://issuer.test/.well-known/jwks.json',
    fetch: async (url) => {
      fetchCalls.push(url);
      return {
        ok: true,
        status: 200,
        async json() { return jwks; },
      };
    },
  });

  assert.equal((await verify(token)).sub, 'auth0|remote-user');
  assert.equal((await verify(token)).sub, 'auth0|remote-user');
  assert.deepEqual(fetchCalls, ['https://issuer.test/.well-known/jwks.json']);
});

test('auth: rejects expired, wrong-audience, and malformed bearer tokens', async () => {
  const { privateKey, jwks } = keyFixture();
  const verify = createJwtVerifier({
    issuer: 'https://issuer.test/',
    audience: 'ledgerly-api-test',
    jwks,
    now: () => 1_700_000_000,
  });

  await assert.rejects(
    () => verify(signJwt(privateKey, { exp: 1_699_999_999 })),
    /Token expired/,
  );
  await assert.rejects(
    () => verify(signJwt(privateKey, { aud: 'wrong-audience' })),
    /Invalid token audience/,
  );
  await assert.rejects(
    () => verifyBearerAuth({ authorization: 'Bearer not-a-jwt' }, verify),
    /Invalid bearer token/,
  );
});

test('roles: owner/admin/bookkeeper can manage bank feeds but viewer cannot', () => {
  assert.equal(can('owner', 'bank_feeds.manage'), true);
  assert.equal(can('admin', 'bank_feeds.manage'), true);
  assert.equal(can('bookkeeper', 'bank_feeds.manage'), true);
  assert.equal(can('viewer', 'bank_feeds.manage'), false);
  assert.equal(can('viewer', 'organizations.read'), true);
});
