'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function repoPath(...parts) {
  return path.join(__dirname, '..', '..', ...parts);
}

test('deployment: Render Blueprint wires staging cloud to managed Postgres', () => {
  const yaml = fs.readFileSync(repoPath('render.yaml'), 'utf8');

  assert.match(yaml, /^services:\n/m);
  assert.match(yaml, /name:\s+ledgerly-cloud-staging/);
  assert.match(yaml, /runtime:\s+node/);
  assert.match(yaml, /rootDir:\s+server/);
  assert.match(yaml, /buildCommand:\s+npm ci/);
  assert.match(yaml, /preDeployCommand:\s+npm run migrate/);
  assert.match(yaml, /startCommand:\s+npm start/);
  assert.match(yaml, /healthCheckPath:\s+\/readyz/);
  assert.match(yaml, /autoDeployTrigger:\s+off/);
  assert.match(
    yaml,
    /key:\s+DATABASE_URL[\s\S]*fromDatabase:[\s\S]*name:\s+ledgerly-cloud-staging-db[\s\S]*property:\s+connectionString/,
  );
  assert.match(yaml, /ipAllowList:\s+\[\]/);
});

test('deployment: Blueprint prompts for secrets instead of committing them', () => {
  const yaml = fs.readFileSync(repoPath('render.yaml'), 'utf8');

  for (const key of ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL', 'BASIQ_API_KEY', 'CORS_ORIGINS', 'SENTRY_DSN']) {
    assert.match(yaml, new RegExp(`key:\\s+${key}\\n\\s+sync:\\s+false`), `${key} should be prompted in Render`);
  }

  assert.doesNotMatch(yaml, /postgres(?:ql)?:\/\/\S+:\S+@/i);
  assert.doesNotMatch(yaml, /basiq-[a-z0-9_-]{10,}/i);
  assert.doesNotMatch(yaml, /client_secret|refresh_token|access_token/i);
});

test('deployment: staging runbook documents deploy verification and recovery', () => {
  const runbook = fs.readFileSync(repoPath('docs', 'release', 'staging-cloud-deployment.md'), 'utf8');

  for (const expected of [
    'ledgerly-cloud-staging',
    'ledgerly-cloud-staging-db',
    '/healthz',
    '/readyz',
    '/v1/me',
    '401',
    'npm run migrate',
    'Rollback Plan',
    'Backup And Restore Drill',
    'point-in-time recovery',
    'https://render.com/docs/blueprint-spec',
    'https://render.com/docs/postgresql-backups',
  ]) {
    assert.match(runbook, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
