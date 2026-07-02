'use strict';

const { Pool } = require('pg');

const { loadConfig } = require('../config');
const { REQUIRED_TABLES, listMigrations } = require('./index');

const MIGRATIONS_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS schema_migrations (' +
  'version text PRIMARY KEY, ' +
  'applied_at timestamptz NOT NULL DEFAULT now());';

// Applies pending numbered migrations (server/src/db/migrations/*.sql) in
// filename order. Each migration runs in its own transaction and is recorded
// in schema_migrations, so re-running is a no-op for applied versions.
async function runMigrations({ config = loadConfig(), pool } = {}) {
  const ownPool = !pool;
  const activePool = pool || new Pool({ connectionString: config.databaseUrl });
  const client = await activePool.connect();

  try {
    await client.query(MIGRATIONS_TABLE_SQL);
    const res = await client.query('SELECT version FROM schema_migrations;');
    const alreadyApplied = new Set((res?.rows || []).map(row => row.version));
    const appliedVersions = [];

    for (const migration of listMigrations()) {
      if (alreadyApplied.has(migration.version)) continue;
      await client.query('BEGIN');
      try {
        for (const statement of migration.statements) {
          await client.query(statement);
        }
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1);',
          [migration.version],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Migration ${migration.version} failed: ${err.message}`;
        throw err;
      }
      appliedVersions.push(migration.version);
    }

    return {
      appEnv: config.appEnv,
      appliedVersions,
      skippedVersions: Array.from(alreadyApplied),
      requiredTables: REQUIRED_TABLES,
    };
  } finally {
    client.release();
    if (ownPool) await activePool.end();
  }
}

async function main() {
  const config = loadConfig();
  const result = await runMigrations({ config });
  const applied = result.appliedVersions.length
    ? result.appliedVersions.join(', ')
    : 'none (up to date)';
  console.log(`Ledgerly Cloud migrations applied for ${result.appEnv}: ${applied}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { main, runMigrations, MIGRATIONS_TABLE_SQL };
