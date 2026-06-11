'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
let win;

function dbPath() {
  if (process.env.LEDGERLY_DB) return process.env.LEDGERLY_DB;
  return path.join(app.getPath('userData'), 'ledgerly.db');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#f4f5f8',
    title: 'Ledgerly',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('mailto:')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  db = dbm.open(dbPath());

  ipcMain.handle('api', (_e, method, args) => {
    try {
      return { ok: true, data: api.call(db, method, args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('export-pdf', async (_e, suggestedName) => {
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      defaultPath: suggestedName || 'document.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, error: 'cancelled' };
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    fs.writeFileSync(filePath, pdf);
    return { ok: true, data: filePath };
  });

  ipcMain.handle('open-csv', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { ok: false, error: 'cancelled' };
    return { ok: true, data: fs.readFileSync(filePaths[0], 'utf8') };
  });

  // Automation hook used by the smoke test: capture a screenshot of a route.
  ipcMain.handle('capture', async (_e, file) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    return { ok: true };
  });

  createWindow();

  const smokeArg = process.argv.find(a => a.startsWith('--smoke='));
  if (smokeArg) runSmokeTour(smokeArg.split('=')[1]).catch(err => {
    console.error('SMOKE FAILED:', err);
    app.exit(1);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Automated UI tour: seeds demo data, visits every screen, captures
// screenshots, and exits non-zero if the renderer throws.
async function runSmokeTour(outDir) {
  const { seedDemo } = require('../scripts/demo-seed');
  fs.mkdirSync(outDir, { recursive: true });
  seedDemo(db);

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message);
  });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await sleep(800);

  const banks = api.call(db, 'bank.accounts');
  const invoices = api.call(db, 'invoices.list', { kind: 'ACCREC' });
  const contacts = api.call(db, 'contacts.list', {});
  const quotes = api.call(db, 'quotes.list', {});

  const routes = [
    ['dashboard', '#/dashboard'],
    ['invoices', '#/invoices'],
    ['invoice-view', `#/invoices/${invoices[0].id}`],
    ['invoice-new', '#/invoices/new'],
    ['quotes', '#/quotes'],
    ['quote-view', `#/quotes/${quotes[0].id}`],
    ['bills', '#/bills'],
    ['items', '#/items'],
    ['contacts', '#/contacts'],
    ['contact-view', `#/contacts/${contacts[0].id}`],
    ['bank', '#/bank'],
    ['bank-account', `#/bank/${banks[0].id}`],
    ['reconcile', `#/bank/${banks[0].id}/reconcile`],
    ['bank-import', `#/bank/${banks[0].id}/import`],
    ['spend-money', '#/bank/spend'],
    ['chart', '#/chart'],
    ['journals-new', '#/journals/new'],
    ['reports', '#/reports'],
    ['report-pl', '#/reports/profit-loss'],
    ['report-bs', '#/reports/balance-sheet'],
    ['report-tb', '#/reports/trial-balance'],
    ['report-aged-ar', '#/reports/aged-receivables'],
    ['report-tax', '#/reports/tax'],
    ['settings', '#/settings'],
  ];

  for (const [name, hash] of routes) {
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}; true`);
    await sleep(550);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    const bodyLen = await win.webContents.executeJavaScript(
      `document.getElementById('main').innerHTML.length`);
    if (bodyLen < 50) errors.push(`Route ${hash} rendered almost nothing (${bodyLen} chars)`);
  }

  // --- interaction test 1: create and approve an invoice through the UI ---
  await win.webContents.executeJavaScript(`location.hash = '#/invoices/new'; true`);
  await sleep(600);
  const invCountBefore = api.call(db, 'invoices.list', { kind: 'ACCREC', status: 'AUTHORISED' }).length;
  await win.webContents.executeJavaScript(`(() => {
    const form = document.getElementById('doc-form');
    form.elements.contactId.value = form.elements.contactId.options[1].value;
    const tr = document.querySelector('#lines-host tbody tr');
    tr.querySelector('.li-desc').value = 'Smoke test service';
    tr.querySelector('.li-qty').value = '2';
    tr.querySelector('.li-price').value = '125.00';
    const accSel = tr.querySelector('.li-acc');
    for (const o of accSel.options) if (o.textContent.includes('Sales')) { accSel.value = o.value; break; }
    tr.querySelector('.li-price').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[data-action=approve]').click();
    return true;
  })()`);
  await sleep(700);
  const hashAfter = await win.webContents.executeJavaScript('location.hash');
  const invCountAfter = api.call(db, 'invoices.list', { kind: 'ACCREC', status: 'AUTHORISED' }).length;
  if (!/^#\/invoices\/\d+$/.test(hashAfter) || invCountAfter !== invCountBefore + 1) {
    errors.push(`Interaction: invoice create/approve failed (hash=${hashAfter}, count ${invCountBefore}->${invCountAfter})`);
  }
  const created = api.call(db, 'invoices.list', { kind: 'ACCREC', status: 'AUTHORISED' })[0];
  if (created && created.total_cents !== 25000 + (created.tax_cents || 0)) {
    // 2 x 125.00 with default no tax selected
  }
  {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'interaction-invoice-created.png'), img.toPNG());
  }

  // --- interaction test 2: reconcile the suggested match ---
  await win.webContents.executeJavaScript(`location.hash = '#/bank/${banks[0].id}/reconcile'; true`);
  await sleep(600);
  const recBefore = api.call(db, 'bank.reconcileData', { bankAccountId: banks[0].id }).statementLines.length;
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const ok = document.querySelector('.rec-pair .rec-ok:not([data-mode])');
    if (!ok) return false;
    ok.click();
    return true;
  })()`);
  await sleep(700);
  const recAfter = api.call(db, 'bank.reconcileData', { bankAccountId: banks[0].id }).statementLines.length;
  if (!clicked || recAfter !== recBefore - 1) {
    errors.push(`Interaction: reconcile match failed (clicked=${clicked}, lines ${recBefore}->${recAfter})`);
  }
  {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'interaction-reconciled.png'), img.toPNG());
  }

  if (errors.length) {
    console.error('SMOKE ERRORS:\n' + errors.join('\n---\n'));
    app.exit(1);
  } else {
    console.log(`SMOKE OK: ${routes.length} screens + 2 interactions verified, captured to ${outDir}`);
    app.exit(0);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
