'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_TABLES = [
  'users',
  'organizations',
  'organization_memberships',
  'devices',
  'bank_provider_users',
  'bank_feed_connections',
  'bank_feed_accounts',
  'bank_feed_sync_runs',
  'audit_events',
];

function migrationsDir() {
  return path.join(__dirname, 'migrations');
}

// Numbered migration files: 001_init.sql, 002_*.sql, ... Applied in filename
// order and tracked in the schema_migrations table by the runner.
function listMigrations() {
  return fs.readdirSync(migrationsDir())
    .filter(file => /^\d{3,}_.+\.sql$/.test(file))
    .sort()
    .map(file => {
      const sql = fs.readFileSync(path.join(migrationsDir(), file), 'utf8');
      return {
        version: file.replace(/\.sql$/, ''),
        file,
        sql,
        statements: splitStatements(sql),
      };
    });
}

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(statement => statement.trim())
    .filter(Boolean)
    .map(statement => `${statement};`);
}

// Full schema as one string (all migrations concatenated in order).
function loadSchemaSql() {
  return listMigrations().map(m => m.sql).join('\n');
}

function migrationStatements() {
  return listMigrations().flatMap(m => m.statements);
}

module.exports = {
  REQUIRED_TABLES,
  migrationsDir,
  listMigrations,
  loadSchemaSql,
  migrationStatements,
};
