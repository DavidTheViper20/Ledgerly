'use strict';

// Launches Ledgerly against a throwaway demo database full of sample data.
// Usage: npm run demo

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const dbFile = path.join(os.tmpdir(), `ledgerly-demo-${Date.now()}.db`);
const dbm = require('../src/db');
const { seedDemo } = require('./demo-seed');

const db = dbm.open(dbFile);
seedDemo(db);
console.log('Demo database:', dbFile);

const electron = require('electron'); // resolves to the electron binary path
const child = spawn(electron, [path.join(__dirname, '..'), '--no-sandbox'], {
  stdio: 'inherit',
  env: { ...process.env, LEDGERLY_DB: dbFile },
});
child.on('exit', (code) => {
  try { fs.unlinkSync(dbFile); } catch {}
  process.exit(code || 0);
});
