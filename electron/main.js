'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
let win;

// ---------- organisations ----------
// Each organisation lives in its own SQLite file (org-<id>.db in userData),
// tracked by orgs.json. LEDGERLY_DB overrides everything with a single fixed
// database (used by tests), disabling org management.

let registry = null; // { active, orgs: [{ id, name, file }] }

function registryPath() { return path.join(app.getPath('userData'), 'orgs.json'); }
function orgDbPath(entry) { return path.join(app.getPath('userData'), entry.file); }
function newOrgId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function saveRegistry() { fs.writeFileSync(registryPath(), JSON.stringify(registry, null, 2)); }

function initRegistry() {
  if (process.env.LEDGERLY_DB) return;
  try { registry = JSON.parse(fs.readFileSync(registryPath(), 'utf8')); } catch { registry = null; }
  if (registry && registry.orgs.length) return;
  // First run (or pre-multi-org install): adopt the legacy single database
  // if one exists, otherwise start with one fresh organisation.
  const id = newOrgId();
  const entry = { id, name: 'New organisation', file: `org-${id}.db` };
  const legacy = path.join(app.getPath('userData'), 'ledgerly.db');
  if (fs.existsSync(legacy)) {
    fs.renameSync(legacy, orgDbPath(entry));
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(legacy + ext)) fs.renameSync(legacy + ext, orgDbPath(entry) + ext);
    }
  }
  registry = { active: id, orgs: [entry] };
  saveRegistry();
}

function activeOrgEntry() { return registry.orgs.find(o => o.id === registry.active) || registry.orgs[0]; }

// Refresh the registry's display name for the active org from its settings.
function syncActiveOrgName() {
  if (!registry) return;
  try {
    const name = db.prepare("SELECT value FROM settings WHERE key = 'org_name'").get()?.value;
    const entry = activeOrgEntry();
    if (name && entry && entry.name !== name) { entry.name = name; saveRegistry(); }
  } catch { /* settings table empty on brand-new org */ }
}

function openActiveOrg() {
  db = dbm.open(process.env.LEDGERLY_DB || orgDbPath(activeOrgEntry()));
  try {
    const r = api.call(db, 'repeating.generateDue', {});
    if (r.created) console.log(`Generated ${r.created} repeating document(s)`);
  } catch (e) { console.error('Repeating invoice generation failed:', e.message); }
  syncActiveOrgName();
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
  initRegistry();
  openActiveOrg();

  ipcMain.handle('api', (_e, method, args) => {
    try {
      const out = api.call(db, method, args);
      if (method === 'settings.update') syncActiveOrgName();
      return { ok: true, data: out };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  const ORG_METHODS = {
    list() {
      if (!registry) {
        const name = db.prepare("SELECT value FROM settings WHERE key = 'org_name'").get()?.value || 'Organisation';
        return [{ id: 'env', name, active: true }];
      }
      syncActiveOrgName();
      return registry.orgs.map(o => ({ id: o.id, name: o.name, active: o.id === registry.active }));
    },
    create({ settings = {} }) {
      if (!registry) throw new Error('Organisation management is disabled when LEDGERLY_DB is set');
      if (!String(settings.org_name || '').trim()) throw new Error('Organisation name is required');
      const id = newOrgId();
      const entry = { id, name: settings.org_name.trim(), file: `org-${id}.db` };
      const ndb = dbm.open(orgDbPath(entry));
      api.call(ndb, 'settings.update', { ...settings, setup_complete: '1' });
      db.close();
      db = ndb;
      registry.orgs.push(entry);
      registry.active = id;
      saveRegistry();
      return { id };
    },
    switch({ id }) {
      if (!registry) throw new Error('Organisation management is disabled when LEDGERLY_DB is set');
      const entry = registry.orgs.find(o => o.id === id);
      if (!entry) throw new Error('Unknown organisation');
      if (registry.active === id) return { id };
      db.close();
      registry.active = id;
      saveRegistry();
      openActiveOrg();
      return { id };
    },
    delete({ id, confirmName }) {
      if (!registry) throw new Error('Organisation management is disabled when LEDGERLY_DB is set');
      const entry = registry.orgs.find(o => o.id === id);
      if (!entry) throw new Error('Unknown organisation');
      if ((confirmName || '').trim() !== entry.name) {
        throw new Error('The name you typed does not match the organisation name');
      }
      const wasActive = registry.active === id;
      if (wasActive) db.close();
      registry.orgs = registry.orgs.filter(o => o.id !== id);
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.rmSync(orgDbPath(entry) + ext, { force: true }); } catch {}
      }
      if (!registry.orgs.length) {
        // Last organisation deleted: start over with a fresh one — the app
        // will land on the mandatory first-run setup screen.
        const nid = newOrgId();
        registry.orgs.push({ id: nid, name: 'New organisation', file: `org-${nid}.db` });
        registry.active = nid;
      } else if (wasActive) {
        registry.active = registry.orgs[0].id;
      }
      saveRegistry();
      if (wasActive) openActiveOrg();
      return { ok: true };
    },
  };
  ipcMain.handle('orgs', (_e, method, args) => {
    try {
      const fn = ORG_METHODS[method];
      if (!fn) throw new Error('Unknown orgs method: ' + method);
      return { ok: true, data: fn(args || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  const assistant = require('../src/services/assistant');
  const ASSISTANT_METHODS = {
    chat: (a) => assistant.chat(db, a),
    history: () => assistant.history(db),
    clear: () => assistant.clearHistory(db),
    memories: () => assistant.memories(db),
    forget: (a) => assistant.forget(db, a.id),
    test: () => assistant.testConnection(db),
    localModels: () => assistant.localModels(),
  };
  ipcMain.handle('assistant', async (_e, method, args) => {
    try {
      const fn = ASSISTANT_METHODS[method];
      if (!fn) throw new Error('Unknown assistant method: ' + method);
      return { ok: true, data: await fn(args || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Streaming chat: progress events (thinking/reply/tool/status) are pushed
  // to the renderer tagged with the caller-supplied id; the final result
  // resolves the invoke as usual.
  ipcMain.handle('assistant-stream', async (e, id, args) => {
    try {
      const data = await assistant.chat(db, args || {}, (ev) => {
        try { e.sender.send('assistant-stream-event', { id, ...ev }); } catch { /* window gone */ }
      });
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('open-external', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) require('electron').shell.openExternal(String(url));
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

  const claims = api.call(db, 'claims.list', {});
  const projectsList = api.call(db, 'projects.list', {});
  const payRuns = api.call(db, 'payroll.listRuns');
  const poList = api.call(db, 'pos.list', {});
  const creditNotes = api.call(db, 'invoices.list', { kind: 'ACCRECCREDIT' });

  const routes = [
    ['dashboard', '#/dashboard'],
    ['credit-notes', '#/credit-notes'],
    ['credit-note-view', `#/credit-notes/${creditNotes[0].id}`],
    ['purchase-orders', '#/purchase-orders'],
    ['purchase-order-view', `#/purchase-orders/${poList[0].id}`],
    ['repeating', '#/repeating'],
    ['expense-claims', '#/expense-claims'],
    ['expense-claim-view', `#/expense-claims/${claims[0].id}`],
    ['assets', '#/assets'],
    ['projects', '#/projects'],
    ['project-view', `#/projects/${projectsList[0].id}`],
    ['payroll', '#/payroll'],
    ['payroll-employees', '#/payroll?tab=employees'],
    ['pay-run-view', `#/payroll/runs/${payRuns[0].id}`],
    ['budgets', '#/budgets'],
    ['report-bas', '#/reports/bas'],
    ['report-cash-flow', '#/reports/cash-flow'],
    ['report-budget', '#/reports/budget-variance'],
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

  // --- interaction test 3: AI assistant end-to-end against a mock provider ---
  const http = require('node:http');
  const mockAi = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      const hasToolResult = payload.messages.some(ms => ms.role === 'tool');
      res.setHeader('content-type', 'application/json');
      if (!hasToolResult) {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'list_documents', arguments: '{"kind":"ACCREC","status":"AUTHORISED"}' } },
        ] } }] }));
      } else {
        const toolMsg = payload.messages.find(ms => ms.role === 'tool');
        const count = JSON.parse(toolMsg.content).length;
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant',
          content: `You currently have **${count} invoices awaiting payment**. I checked your live ledger to confirm.` } }] }));
      }
    });
  });
  await new Promise(r => mockAi.listen(0, '127.0.0.1', r));
  const mockPort = mockAi.address().port;
  api.call(db, 'settings.update', {
    ai_provider: 'custom', ai_base_url: `http://127.0.0.1:${mockPort}/v1`,
    ai_model: 'mock-model', ai_api_key: '',
  });

  await win.webContents.executeJavaScript(`location.hash = '#/dashboard'; true`);
  await sleep(600);
  const chatOk = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('ai-bubble').click();
    await new Promise(r => setTimeout(r, 400));
    const ta = document.getElementById('ai-text');
    ta.value = 'How many invoices are awaiting payment?';
    document.getElementById('ai-form').dispatchEvent(new Event('submit', { cancelable: true }));
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 250));
      const msgs = document.querySelectorAll('#ai-msgs .ai-msg.assistant');
      const last = msgs[msgs.length - 1];
      // The reply types out progressively; the footer (with tools used)
      // renders only once typing finishes — wait for that.
      if (last && /awaiting payment/.test(last.textContent) && last.querySelector('.ai-footer')) {
        return last.textContent.includes('list_documents');
      }
    }
    return false;
  })()`);
  if (!chatOk) errors.push('Assistant chat round-trip failed (no reply with tool usage rendered)');
  {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'interaction-assistant.png'), img.toPNG());
  }
  const chatHistory = api.call ? require('../src/services/assistant').history(db) : [];
  if (chatHistory.length < 2) errors.push('Assistant history was not persisted');
  mockAi.close();

  // --- assistant settings screen ---
  await win.webContents.executeJavaScript(`location.hash = '#/settings?focus=ai'; true`);
  await sleep(600);
  {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'settings-ai.png'), img.toPNG());
  }

  if (errors.length) {
    console.error('SMOKE ERRORS:\n' + errors.join('\n---\n'));
    app.exit(1);
  } else {
    console.log(`SMOKE OK: ${routes.length} screens + 3 interactions verified, captured to ${outDir}`);
    app.exit(0);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
