'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { REQUIRED_TABLES, loadSchemaSql, migrationStatements, listMigrations } = require('../src/db');
const { runMigrations, MIGRATIONS_TABLE_SQL } = require('../src/db/migrate');
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

test('schema: migrations are numbered files applied in order', () => {
  const migrations = listMigrations();

  assert.ok(migrations.length >= 1);
  assert.equal(migrations[0].version, '001_init');
  const versions = migrations.map(m => m.version);
  assert.deepEqual(versions, [...versions].sort(), 'migrations must sort in apply order');
  for (const migration of migrations) {
    assert.match(migration.file, /^\d{3,}_.+\.sql$/);
    assert.ok(migration.statements.length > 0, `${migration.file} has no statements`);
  }
});

test('schema: migration runner tracks applied versions transactionally', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (/^SELECT version FROM schema_migrations/.test(sql)) return { rows: [] };
      return {};
    },
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
  assert.equal(calls[1], MIGRATIONS_TABLE_SQL);
  assert.match(calls[2], /^SELECT version FROM schema_migrations/);
  assert.equal(calls[3], 'BEGIN');
  assert.match(calls.at(-3), /^INSERT INTO schema_migrations/);
  assert.equal(calls.at(-2), 'COMMIT');
  assert.equal(calls.at(-1), 'release');
  assert.equal(calls.filter(c => c === 'BEGIN').length, listMigrations().length);
  assert.equal(result.appEnv, 'test');
  assert.deepEqual(result.appliedVersions, listMigrations().map(m => m.version));
  assert.deepEqual(result.skippedVersions, []);
  assert.deepEqual(result.requiredTables, REQUIRED_TABLES);
});

test('schema: migration runner skips already-applied versions', async () => {
  const calls = [];
  const applied = listMigrations().map(m => ({ version: m.version }));
  const client = {
    async query(sql) {
      calls.push(sql);
      if (/^SELECT version FROM schema_migrations/.test(sql)) return { rows: applied };
      return {};
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
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

  assert.deepEqual(result.appliedVersions, []);
  assert.equal(result.skippedVersions.length, listMigrations().length);
  assert.ok(!calls.includes('BEGIN'), 'no transactions expected when everything is applied');
});
