'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { REQUIRED_TABLES, loadSchemaSql, migrationStatements } = require('../src/db');
const { runMigrations } = require('../src/db/migrate');
const { loadConfig } = require('../src/config');

test('schema: includes every production bank-connect table', () => {
  const schema = loadSchemaSql();
  for (const table of REQUIRED_TABLES) {
    assert.match(
      schema,
      new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`, 'i'),
      `missing table ${table}`,
    );
  }
});

test('schema: migration statements are ordered and non-empty', () => {
  const statements = migrationStatements();

  assert.ok(statements.length >= REQUIRED_TABLES.length);
  assert.ok(statements[0].startsWith('CREATE EXTENSION IF NOT EXISTS pgcrypto'));
  for (const statement of statements) {
    assert.doesNotMatch(statement, /TODO|TBD|placeholder/i);
    assert.match(statement, /;$/);
  }
});

test('schema: migration runner applies statements inside one transaction', async () => {
  const calls = [];
  const client = {
    async query(sql) { calls.push(sql); },
    release() { calls.push('release'); },
  };
  const pool = {
    async connect() { calls.push('connect'); return client; },
  };
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://ledgerly:secret@db.example.com:5432/ledgerly_test',
    OIDC_ISSUER: 'https://issuer.test/',
    OIDC_AUDIENCE: 'ledgerly-api-test',
    BASIQ_API_KEY: 'basiq-secret-key',
    CORS_ORIGINS: 'http://localhost:3000',
    PORT: '0',
  });

  const result = await runMigrations({ config, pool });

  assert.equal(calls[0], 'connect');
  assert.equal(calls[1], 'BEGIN');
  assert.equal(calls.at(-2), 'COMMIT');
  assert.equal(calls.at(-1), 'release');
  assert.equal(result.appEnv, 'test');
  assert.equal(result.statementsApplied, migrationStatements().length);
  assert.deepEqual(result.requiredTables, REQUIRED_TABLES);
});
