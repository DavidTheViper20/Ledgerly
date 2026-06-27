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

function schemaPath() {
  return path.join(__dirname, 'schema.sql');
}

function loadSchemaSql() {
  return fs.readFileSync(schemaPath(), 'utf8');
}

function migrationStatements() {
  return loadSchemaSql()
    .split(/;\s*(?:\r?\n|$)/)
    .map(statement => statement.trim())
    .filter(Boolean)
    .map(statement => `${statement};`);
}

module.exports = {
  REQUIRED_TABLES,
  schemaPath,
  loadSchemaSql,
  migrationStatements,
};
