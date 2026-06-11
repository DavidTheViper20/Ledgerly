'use strict';

// Headless UI smoke test: boots the real Electron app against a temp database,
// seeds demo data, walks every screen, performs scripted interactions and
// captures screenshots. Requires a display (uses xvfb-run on Linux if needed).

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const outDir = process.argv[2] || path.join(os.tmpdir(), 'ledgerly-smoke');
const dbFile = path.join(os.tmpdir(), `ledgerly-smoke-${Date.now()}.db`);
const electron = require('electron');

const args = [root, '--no-sandbox', '--disable-gpu', `--smoke=${outDir}`];
let cmd = electron, argv = args;
if (process.platform === 'linux' && !process.env.DISPLAY) {
  cmd = 'xvfb-run';
  argv = ['-a', electron, ...args];
}
const r = spawnSync(cmd, argv, {
  stdio: 'inherit',
  env: { ...process.env, LEDGERLY_DB: dbFile },
});
try { fs.unlinkSync(dbFile); } catch {}
process.exit(r.status || 0);
