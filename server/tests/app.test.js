'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createServer } = require('../src/app');
const { loadConfig } = require('../src/config');

function testConfig() {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://ledgerly:secret@db.example.com:5432/ledgerly_test',
    OIDC_ISSUER: 'https://issuer.test/',
    OIDC_AUDIENCE: 'ledgerly-api-test',
    BASIQ_API_KEY: 'basiq-secret-key',
    CORS_ORIGINS: 'http://localhost:3000',
    PORT: '0',
  });
}

test('app: GET /healthz returns safe status without leaking config secrets', async () => {
  const server = createServer({ config: testConfig() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true, service: 'ledgerly-cloud', appEnv: 'test' });
    assert.doesNotMatch(JSON.stringify(body), /basiq-secret-key|ledgerly:secret|DATABASE_URL|BASIQ_API_KEY/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('app: unknown routes return a stable JSON error', async () => {
  const server = createServer({ config: testConfig() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/missing`);
    const body = await res.json();

    assert.equal(res.status, 404);
    assert.deepEqual(body, { error: { code: 'not_found', message: 'Route not found' } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
