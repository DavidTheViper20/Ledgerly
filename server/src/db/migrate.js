'use strict';

const { Pool } = require('pg');

const { loadConfig } = require('../config');
const { REQUIRED_TABLES, migrationStatements } = require('./index');

async function runMigrations({ config = loadConfig(), pool } = {}) {
  const ownPool = !pool;
  const activePool = pool || new Pool({ connectionString: config.databaseUrl });
  const client = await activePool.connect();
  const statements = migrationStatements();

  try {
    await client.query('BEGIN');
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query('COMMIT');
    return {
      appEnv: config.appEnv,
      statementsApplied: statements.length,
      requiredTables: REQUIRED_TABLES,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    if (ownPool) await activePool.end();
  }
}

async function main() {
  const config = loadConfig();
  const result = await runMigrations({ config });
  console.log(`Applied ${result.statementsApplied} Ledgerly Cloud migration statements for ${result.appEnv}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { main, runMigrations };
