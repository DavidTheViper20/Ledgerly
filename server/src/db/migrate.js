'use strict';

const { loadConfig } = require('../config');
const { migrationStatements } = require('./index');

function main() {
  const config = loadConfig();
  const statements = migrationStatements();

  console.log(`Prepared ${statements.length} Ledgerly Cloud migration statements for ${config.appEnv}.`);
  console.log('Install a PostgreSQL driver in the deployment task before applying these statements.');
}

if (require.main === module) main();

module.exports = { main };
