'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig, safeConfigSummary } = require('../src/config');

test('config: fails closed when required production secrets are missing', () => {
  assert.throws(
    () => loadConfig({ APP_ENV: 'production' }),
    /Missing required config: DATABASE_URL, OIDC_ISSUER, OIDC_AUDIENCE, BASIQ_API_KEY, CORS_ORIGINS/,
  );
});

test('config: parses required production settings and hides secrets in safe summary', () => {
  const config = loadConfig({
    APP_ENV: 'production',
    DATABASE_URL: 'postgres://ledgerly:secret@db.example.com:5432/ledgerly',
    OIDC_ISSUER: 'https://ledgerly.au.auth0.com/',
    OIDC_AUDIENCE: 'https://api.ledgerly.example',
    BASIQ_API_KEY: 'basiq-secret-key',
    CORS_ORIGINS: 'ledgerly://desktop,https://app.ledgerly.example',
    PORT: '4567',
  });

  assert.equal(config.appEnv, 'production');
  assert.equal(config.port, 4567);
  assert.deepEqual(config.corsOrigins, ['ledgerly://desktop', 'https://app.ledgerly.example']);

  const summary = safeConfigSummary(config);
  assert.deepEqual(summary, {
    appEnv: 'production',
    port: 4567,
    authMode: 'oidc',
    oidcIssuer: 'https://ledgerly.au.auth0.com/',
    oidcAudience: 'https://api.ledgerly.example',
    corsOrigins: ['ledgerly://desktop', 'https://app.ledgerly.example'],
    hasDatabaseUrl: true,
    hasBasiqApiKey: true,
    hasStaticToken: false,
  });
  assert.doesNotMatch(JSON.stringify(summary), /basiq-secret-key|ledgerly:secret/);
});
