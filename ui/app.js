'use strict';

// Hash router. Routes map to view functions registered in window.VIEWS.
// Each view: async (main, params) => void

const ROUTES = [
  ['#/dashboard', 'dashboard'],
  ['#/setup', 'setup'],
  ['#/contacts/new', 'contactEdit'],
  ['#/contacts/:id/edit', 'contactEdit'],
  ['#/contacts/:id', 'contactDetail'],
  ['#/contacts', 'contacts'],
  ['#/invoices/new', 'invoiceEdit'],
  ['#/invoices/:id/edit', 'invoiceEdit'],
  ['#/invoices/:id', 'invoiceView'],
  ['#/invoices', 'invoices'],
  ['#/bills/new', 'invoiceEdit'],
  ['#/bills/:id/edit', 'invoiceEdit'],
  ['#/bills/:id', 'invoiceView'],
  ['#/bills', 'invoices'],
  ['#/quotes/new', 'quoteEdit'],
  ['#/quotes/:id/edit', 'quoteEdit'],
  ['#/quotes/:id', 'quoteView'],
  ['#/quotes', 'quotes'],
  ['#/items', 'items'],
  ['#/bank/spend', 'bankTransactionEdit'],
  ['#/bank/receive', 'bankTransactionEdit'],
  ['#/bank/transaction/:id', 'bankTransactionEdit'],
  ['#/bank/:id/reconcile', 'reconcile'],
  ['#/bank/:id/import', 'bankImport'],
  ['#/bank/:id', 'bankAccount'],
  ['#/bank', 'bankAccounts'],
  ['#/chart', 'chart'],
  ['#/journals/new', 'journalEdit'],
  ['#/journals/:id/edit', 'journalEdit'],
  ['#/journals/:id', 'journalView'],
  ['#/journals', 'journals'],
  ['#/reports/profit-loss', 'reportPL'],
  ['#/reports/balance-sheet', 'reportBS'],
  ['#/reports/trial-balance', 'reportTB'],
  ['#/reports/aged-receivables', 'reportAgedAR'],
  ['#/reports/aged-payables', 'reportAgedAP'],
  ['#/reports/account-transactions', 'reportAccountTx'],
  ['#/reports/tax', 'reportTax'],
  ['#/reports', 'reports'],
  ['#/settings', 'settingsView'],
];

function matchRoute(hash) {
  hash = hash.split('?')[0] || '#/dashboard';
  for (const [pattern, view] of ROUTES) {
    const pp = pattern.split('/');
    const hp = hash.split('/');
    if (pp.length !== hp.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(hp[i]);
      else if (pp[i] !== hp[i]) { ok = false; break; }
    }
    if (ok) return { view, params, query: parseQuery(hash) };
  }
  return { view: 'dashboard', params: {}, query: {} };
}

function parseQuery() {
  const q = {};
  const ix = location.hash.indexOf('?');
  if (ix === -1) return q;
  for (const [k, v] of new URLSearchParams(location.hash.slice(ix + 1))) q[k] = v;
  return q;
}

function setActiveNav(hash) {
  const section =
    hash.startsWith('#/contacts') ? 'contacts' :
    hash.startsWith('#/invoices') || hash.startsWith('#/quotes') || hash.startsWith('#/bills') || hash.startsWith('#/items') ? 'business' :
    hash.startsWith('#/bank') || hash.startsWith('#/reports') || hash.startsWith('#/chart') || hash.startsWith('#/journals') ? 'accounting' :
    'dashboard';
  document.querySelectorAll('#mainnav [data-nav]').forEach(el => {
    el.classList.toggle('active', el.dataset.nav === section);
  });
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const main = document.getElementById('main');
  const hash = location.hash || '#/dashboard';
  closeModal();
  try {
    await loadRefData();
    if (seq !== renderSeq) return;
    if ((STATE.settings.setup_complete || '0') !== '1' && !hash.startsWith('#/setup')) {
      location.hash = '#/setup';
      return;
    }
    const { view, params, query } = matchRoute(hash);
    setActiveNav(hash);
    const fn = window.VIEWS[view];
    if (!fn) { main.innerHTML = `<div class="card">Unknown view: ${esc(view)}</div>`; return; }
    await fn(main, { ...params, ...query });
    if (seq !== renderSeq) return;
    window.scrollTo(0, 0);
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
  }
}

// Dropdown menus in the top bar
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.menu-btn');
  document.querySelectorAll('.menu.open').forEach(m => {
    if (!btn || m !== btn.parentElement) m.classList.remove('open');
  });
  if (btn) btn.parentElement.classList.toggle('open');
  const link = ev.target.closest('.menu-list a');
  if (link) link.closest('.menu').classList.remove('open');
  const go = ev.target.closest('[data-go]');
  if (go) location.hash = go.dataset.go;
});

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);
