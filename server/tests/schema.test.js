'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { REQUIRED_TABLES, loadSchemaSql, migrationStatements } = require('../src/db');

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
