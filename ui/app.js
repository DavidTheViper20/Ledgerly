'use strict';

// Hash router. Routes map to view functions registered in window.VIEWS.
// Each view: async (main, params) => void

const ROUTES = [
  ['#/dashboard', 'dashboard'],
  ['#/setup', 'setup'],
  ['#/sales', 'salesOverview'],
  ['#/purchases', 'purchasesOverview'],
  ['#/contacts/new', 'contactEdit'],
  ['#/contacts/:id/edit', 'contactEdit'],
  ['#/contacts/:id', 'contactDetail'],
  ['#/contacts', 'contacts'],
  ['#/credit-notes/new', 'invoiceEdit'],
  ['#/credit-notes/:id/edit', 'invoiceEdit'],
  ['#/credit-notes/:id', 'invoiceView'],
  ['#/credit-notes', 'invoices'],
  ['#/supplier-credits/new', 'invoiceEdit'],
  ['#/supplier-credits/:id/edit', 'invoiceEdit'],
  ['#/supplier-credits/:id', 'invoiceView'],
  ['#/supplier-credits', 'invoices'],
  ['#/purchase-orders/new', 'poEdit'],
  ['#/purchase-orders/:id/edit', 'poEdit'],
  ['#/purchase-orders/:id', 'poView'],
  ['#/purchase-orders', 'pos'],
  ['#/repeating/new', 'repeatingEdit'],
  ['#/repeating/:id/edit', 'repeatingEdit'],
  ['#/repeating', 'repeating'],
  ['#/expense-claims/new', 'claimEdit'],
  ['#/expense-claims/:id/edit', 'claimEdit'],
  ['#/expense-claims/:id', 'claimView'],
  ['#/expense-claims', 'claims'],
  ['#/assets', 'assets'],
  ['#/projects/:id', 'projectDetail'],
  ['#/projects', 'projects'],
  ['#/payroll/runs/:id', 'payRunView'],
  ['#/payroll', 'payroll'],
  ['#/budgets', 'budgetManager'],
  ['#/reports/bas', 'reportBAS'],
  ['#/reports/cash-flow', 'reportCashFlow'],
  ['#/reports/budget-variance', 'reportBudget'],
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
  ['#/tax/statement', 'taxStatement'],
  ['#/tax', 'tax'],
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
  const base = hash.split('?')[0];
  // Contacts filtered by customers/suppliers highlight their owning menu.
  const query = parseQuery();
  const section =
    base.startsWith('#/contacts') && query.filter === 'customers' ? 'sales' :
    base.startsWith('#/contacts') && query.filter === 'suppliers' ? 'purchases' :
    base.startsWith('#/contacts') ? 'contacts' :
    base.startsWith('#/sales') || base.startsWith('#/invoices') || base.startsWith('#/quotes') ||
    base.startsWith('#/items') || base.startsWith('#/credit-notes') ? 'sales' :
    base.startsWith('#/purchases') || base.startsWith('#/bills') || base.startsWith('#/supplier-credits') ||
    base.startsWith('#/purchase-orders') || base.startsWith('#/repeating') || base.startsWith('#/expense-claims') ? 'purchases' :
    base.startsWith('#/projects') ? 'projects' :
    base.startsWith('#/payroll') ? 'payroll' :
    base.startsWith('#/reports') ? 'reporting' :
    base.startsWith('#/bank') || base.startsWith('#/chart') || base.startsWith('#/journals') ||
    base.startsWith('#/assets') || base.startsWith('#/budgets') ? 'accounting' :
    base.startsWith('#/tax') ? 'tax' :
    'dashboard';
  document.querySelectorAll('#mainnav [data-nav]').forEach(el => {
    el.classList.toggle('active', el.dataset.nav === section);
  });
}

// Show/hide the Projects nav item based on the projects_enabled flag.
function syncNavFlags() {
  const el = document.getElementById('nav-projects');
  if (el) el.hidden = (STATE.settings.projects_enabled || '0') !== '1';
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
    syncNavFlags();
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
