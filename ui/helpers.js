'use strict';

// Shared renderer helpers. Views register themselves on window.VIEWS.
window.VIEWS = {};
window.STATE = { settings: {}, accounts: [], taxRates: [], contacts: [], items: [] };

const api = (method, args) => window.ledgerly.call(method, args);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

let _fmt;
function moneyFmt() {
  if (!_fmt || _fmt.currency !== (STATE.settings.base_currency || 'USD')) {
    const currency = STATE.settings.base_currency || 'USD';
    _fmt = { currency, f: new Intl.NumberFormat(undefined, { style: 'currency', currency }) };
  }
  return _fmt.f;
}
function fmtMoney(cents) { return moneyFmt().format((cents || 0) / 100); }
function fmtMoneySigned(cents) {
  const cls = cents < 0 ? 'amount-neg' : '';
  return `<span class="${cls}">${esc(fmtMoney(cents))}</span>`;
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// Parse a money input string to cents.
function centsOf(v) {
  const n = parseFloat(String(v ?? '').replace(/[,\s]/g, ''));
  if (!isFinite(n)) return 0;
  return n >= 0 ? Math.floor(n * 100 + 0.5) : Math.ceil(n * 100 - 0.5);
}
function dollarsOf(cents) { return ((cents || 0) / 100).toFixed(2); }

function toast(msg, kind = '') {
  const host = document.getElementById('toast-host');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

function showError(e) { toast(e && e.message ? e.message : String(e), 'error'); }

function modal(html) {
  const host = document.getElementById('modal-host');
  host.innerHTML = `<div class="modal">${html}</div>`;
  host.onclick = (ev) => { if (ev.target === host) closeModal(); };
  return host.querySelector('.modal');
}
function closeModal() {
  const host = document.getElementById('modal-host');
  host.innerHTML = '';
  host.onclick = null;
}

// Refresh frequently-used reference data into STATE.
async function loadRefData() {
  const [settings, accounts, taxRates] = await Promise.all([
    api('settings.all'), api('accounts.list'), api('taxRates.list'),
  ]);
  STATE.settings = settings;
  STATE.accounts = accounts;
  STATE.taxRates = taxRates;
  document.getElementById('org-name').textContent = settings.org_name || '';
}

function accountOptions(selectedId, { filter = null, blank = true } = {}) {
  let accs = STATE.accounts.filter(a => !a.is_archived);
  if (filter === 'bank') accs = accs.filter(a => a.type === 'BANK');
  if (filter === 'nonbank') accs = accs.filter(a => a.type !== 'BANK');
  if (filter === 'pl') accs = accs.filter(a => ['REVENUE', 'EXPENSE'].includes(a.class));
  return (blank ? '<option value=""></option>' : '') + accs.map(a =>
    `<option value="${a.id}" ${a.id == selectedId ? 'selected' : ''}>${esc(a.code)} - ${esc(a.name)}</option>`).join('');
}

function taxOptions(selectedId, { blank = true } = {}) {
  return (blank ? '<option value=""></option>' : '') + STATE.taxRates.map(t =>
    `<option value="${t.id}" ${t.id == selectedId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
}

function contactOptions(contacts, selectedId) {
  return '<option value=""></option>' + contacts.map(c =>
    `<option value="${c.id}" ${c.id == selectedId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

function badge(status) {
  const labels = {
    DRAFT: 'Draft', SUBMITTED: 'Awaiting Approval', AUTHORISED: 'Awaiting Payment', PAID: 'Paid',
    VOIDED: 'Voided', SENT: 'Sent', ACCEPTED: 'Accepted', DECLINED: 'Declined', INVOICED: 'Invoiced',
    POSTED: 'Posted', MATCHED: 'Reconciled', UNMATCHED: 'Unreconciled', OVERDUE: 'Overdue',
    ACTIVE: 'Active', PAUSED: 'Paused', CLOSED: 'Closed', BILLED: 'Billed', CANCELLED: 'Cancelled',
    APPROVED: 'Approved', REGISTERED: 'Registered', DISPOSED: 'Disposed',
  };
  return `<span class="badge ${esc(status)}">${esc(labels[status] || status)}</span>`;
}

function navigate(hash) { location.hash = hash; }

// Tiny event helper: bind by selector within a root.
function on(root, selector, event, fn) {
  root.querySelectorAll(selector).forEach(el => el.addEventListener(event, fn));
}
