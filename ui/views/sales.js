'use strict';

// Invoices (ACCREC) and Bills (ACCPAY) share list/editor/viewer; quotes below.

function docKind() { return location.hash.startsWith('#/bills') ? 'ACCPAY' : 'ACCREC'; }
function docBase(kind) { return kind === 'ACCPAY' ? 'bills' : 'invoices'; }
function docLabel(kind) { return kind === 'ACCPAY' ? 'Bill' : 'Invoice'; }

// ---------- list ----------

VIEWS.invoices = async function (main, params) {
  const kind = docKind();
  const base = docBase(kind);
  const tab = params.tab || 'ALL';
  const search = params.q || '';
  const rows = await api('invoices.list', {
    kind, status: tab === 'ALL' ? null : tab, search: search || null,
  });
  const t = (id, label) => `<a href="#/${base}?tab=${id}" class="${tab === id ? 'active' : ''}">${label}</a>`;

  main.innerHTML = `
    <div class="page-head">
      <h1>${kind === 'ACCPAY' ? 'Bills to pay' : 'Invoices'}</h1>
      <div class="spacer"></div>
      <input class="search" id="doc-search" placeholder="Search…" value="${esc(search)}" />
      <a class="btn primary" href="#/${base}/new">New ${docLabel(kind).toLowerCase()}</a>
    </div>
    <div class="tabs">
      ${t('ALL', 'All')}${t('DRAFT', 'Draft')}${t('SUBMITTED', 'Awaiting Approval')}
      ${t('AUTHORISED', 'Awaiting Payment')}${t('OVERDUE', 'Overdue')}${t('PAID', 'Paid')}${t('VOIDED', 'Voided')}
    </div>
    <div class="card">
      <table class="data">
        <thead><tr>
          <th>Number</th><th>Ref</th><th>To</th><th>Date</th><th>Due date</th>
          <th>Status</th><th class="num">Total</th><th class="num">Due</th>
        </tr></thead>
        <tbody>
          ${rows.length === 0 ? `<tr><td colspan="8"><div class="empty">No ${base} here yet</div></td></tr>` : ''}
          ${rows.map(d => `
            <tr class="click" data-go="#/${base}/${d.id}">
              <td><b>${esc(d.number || '—')}</b></td>
              <td>${esc(d.reference)}</td>
              <td>${esc(d.contact_name)}</td>
              <td>${fmtDate(d.issue_date)}</td>
              <td>${fmtDate(d.due_date)}</td>
              <td>${badge(d.status === 'AUTHORISED' && d.due_date < today() ? 'OVERDUE' : d.status)}</td>
              <td class="num">${fmtMoney(d.total_cents)}</td>
              <td class="num">${d.status === 'AUTHORISED' || d.status === 'PAID' ? fmtMoney(d.total_cents - d.paid_cents) : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const si = document.getElementById('doc-search');
  si.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') navigate(`#/${base}?tab=${tab}&q=${encodeURIComponent(si.value)}`);
  });
};

// ---------- shared line-item editor ----------

// Renders the editable lines table into a container and returns helpers.
function linesEditor(container, lines, { showItems = true } = {}) {
  let state = lines.map(l => ({ ...l }));
  if (state.length === 0) state = [{}, {}, {}];
  const itemsList = STATE._items || [];

  function rowHtml(l, i) {
    return `<tr data-i="${i}">
      ${showItems ? `<td style="width:110px">
        <select class="li-item">
          <option value=""></option>
          ${itemsList.map(it => `<option value="${it.id}" ${it.id == l.itemId ? 'selected' : ''}>${esc(it.code)}</option>`).join('')}
        </select></td>` : ''}
      <td><input class="li-desc" value="${esc(l.description || '')}" /></td>
      <td class="num" style="width:70px"><input class="li-qty" value="${l.qty ?? ''}" placeholder="1" /></td>
      <td class="num" style="width:110px"><input class="li-price" value="${l.unitPriceCents != null ? dollarsOf(l.unitPriceCents) : ''}" placeholder="0.00" /></td>
      <td class="num" style="width:80px"><input class="li-disc" value="${l.discountPct || ''}" placeholder="%" /></td>
      <td style="width:200px"><select class="li-acc">${accountOptions(l.accountId, { filter: 'nonbank' })}</select></td>
      <td style="width:170px"><select class="li-tax">${taxOptions(l.taxRateId)}</select></td>
      <td class="num li-amt" style="width:110px;padding-top:10px">${l.unitPriceCents != null ? fmtMoney(Math.round((l.qty || 1) * l.unitPriceCents * (1 - (l.discountPct || 0) / 100))) : ''}</td>
      <td style="width:30px"><button type="button" class="rm" title="Remove line">×</button></td>
    </tr>`;
  }

  function renderTable() {
    container.innerHTML = `
      <table class="lines">
        <thead><tr>
          ${showItems ? '<th>Item</th>' : ''}
          <th>Description</th><th>Qty</th><th>Unit price</th><th>Disc %</th><th>Account</th><th>Tax rate</th>
          <th style="text-align:right">Amount</th><th></th>
        </tr></thead>
        <tbody>${state.map(rowHtml).join('')}</tbody>
      </table>
      <button type="button" class="btn small" id="add-line" style="margin-top:8px">+ Add line</button>`;

    container.querySelector('#add-line').addEventListener('click', () => {
      state = read();
      state.push({});
      renderTable();
    });
    on(container, '.rm', 'click', (ev) => {
      const i = Number(ev.target.closest('tr').dataset.i);
      state = read();
      state.splice(i, 1);
      if (state.length === 0) state.push({});
      renderTable();
    });
    on(container, '.li-item', 'change', (ev) => {
      const tr = ev.target.closest('tr');
      const it = itemsList.find(x => x.id == ev.target.value);
      if (!it) return;
      const sale = docKind() === 'ACCREC';
      tr.querySelector('.li-desc').value = it.name + (it.description ? ' — ' + it.description : '');
      tr.querySelector('.li-qty').value = tr.querySelector('.li-qty').value || '1';
      tr.querySelector('.li-price').value = dollarsOf(sale ? it.sale_price_cents : it.purchase_price_cents);
      const acc = sale ? it.sale_account_id : it.purchase_account_id;
      if (acc) tr.querySelector('.li-acc').value = acc;
      const tx = sale ? it.sale_tax_rate_id : it.purchase_tax_rate_id;
      if (tx) tr.querySelector('.li-tax').value = tx;
      recalcRow(tr);
    });
    on(container, '.li-qty, .li-price, .li-disc', 'input', (ev) => recalcRow(ev.target.closest('tr')));
    on(container, 'input, select', 'change', () => container.dispatchEvent(new CustomEvent('lines-changed', { bubbles: true })));
    on(container, 'input', 'input', () => container.dispatchEvent(new CustomEvent('lines-changed', { bubbles: true })));
  }

  function recalcRow(tr) {
    const qty = parseFloat(tr.querySelector('.li-qty').value) || (tr.querySelector('.li-price').value ? 1 : 0);
    const price = centsOf(tr.querySelector('.li-price').value);
    const disc = parseFloat(tr.querySelector('.li-disc').value) || 0;
    tr.querySelector('.li-amt').textContent = price ? fmtMoney(Math.round(qty * price * (1 - disc / 100))) : '';
  }

  function read() {
    return [...container.querySelectorAll('tbody tr')].map(tr => ({
      itemId: showItems && tr.querySelector('.li-item').value ? Number(tr.querySelector('.li-item').value) : null,
      description: tr.querySelector('.li-desc').value.trim(),
      qty: parseFloat(tr.querySelector('.li-qty').value) || (tr.querySelector('.li-price').value ? 1 : 0),
      unitPriceCents: centsOf(tr.querySelector('.li-price').value),
      discountPct: parseFloat(tr.querySelector('.li-disc').value) || 0,
      accountId: tr.querySelector('.li-acc').value ? Number(tr.querySelector('.li-acc').value) : null,
      taxRateId: tr.querySelector('.li-tax').value ? Number(tr.querySelector('.li-tax').value) : null,
    }));
  }

  renderTable();
  return { read };
}

function liveTotals(lines, taxMode) {
  let subtotal = 0, tax = 0;
  for (const l of lines) {
    if (!l.unitPriceCents) continue;
    const gross = Math.round(l.qty * l.unitPriceCents * (1 - (l.discountPct || 0) / 100));
    const rate = taxMode === 'none' ? 0 : (STATE.taxRates.find(t => t.id === l.taxRateId)?.rate || 0);
    if (taxMode === 'inclusive' && rate) {
      const net = Math.round(gross / (1 + rate / 100));
      subtotal += net; tax += gross - net;
    } else {
      subtotal += gross;
      if (rate) tax += Math.round(gross * rate / 100);
    }
  }
  return { subtotal, tax, total: subtotal + tax };
}

// ---------- editor ----------

VIEWS.invoiceEdit = async function (main, params) {
  const kind = docKind();
  const base = docBase(kind);
  const isEdit = !!params.id;
  const contacts = await api('contacts.list', {});
  STATE._items = await api('items.list', {});
  const s = STATE.settings;
  const dueDays = parseInt(s.default_due_days || '14', 10);

  let doc;
  if (isEdit) {
    const d = await api('invoices.get', { id: Number(params.id) });
    doc = {
      id: d.id, contactId: d.contact_id, issueDate: d.issue_date, dueDate: d.due_date,
      reference: d.reference, number: d.number, taxMode: d.tax_mode,
      lines: d.lines.map(l => ({
        itemId: l.item_id, description: l.description, qty: l.qty, unitPriceCents: l.unit_price_cents,
        discountPct: l.discount_pct, accountId: l.account_id, taxRateId: l.tax_rate_id,
      })),
    };
  } else {
    doc = {
      contactId: params.contact ? Number(params.contact) : null,
      issueDate: today(), dueDate: addDays(today(), dueDays),
      reference: '', number: '', taxMode: 'exclusive', lines: [],
    };
  }

  main.innerHTML = `
    <div class="page-head"><h1>${isEdit ? 'Edit' : 'New'} ${docLabel(kind).toLowerCase()}</h1></div>
    <form id="doc-form" class="card">
      <div class="field-row">
        <label class="field">${kind === 'ACCPAY' ? 'From (supplier) *' : 'To (customer) *'}
          <select name="contactId" required>${contactOptions(contacts, doc.contactId)}</select>
        </label>
        <label class="field">Issue date *<input type="date" name="issueDate" required value="${doc.issueDate}" /></label>
        <label class="field">Due date *<input type="date" name="dueDate" required value="${doc.dueDate}" /></label>
        <label class="field">${kind === 'ACCPAY' ? 'Bill number' : 'Invoice number'}
          <input name="number" value="${esc(doc.number)}" placeholder="${kind === 'ACCREC' ? 'auto' : 'supplier ref'}" />
        </label>
        <label class="field">Reference<input name="reference" value="${esc(doc.reference)}" /></label>
        <label class="field">Amounts are
          <select name="taxMode">
            <option value="exclusive" ${doc.taxMode === 'exclusive' ? 'selected' : ''}>Tax exclusive</option>
            <option value="inclusive" ${doc.taxMode === 'inclusive' ? 'selected' : ''}>Tax inclusive</option>
            <option value="none" ${doc.taxMode === 'none' ? 'selected' : ''}>No tax</option>
          </select>
        </label>
      </div>
      <div id="lines-host"></div>
      <div class="totals-box" id="totals-box"></div>
      <div class="btn-row no-print" style="margin-top:16px">
        <button class="btn" type="submit" data-action="draft">Save as draft</button>
        <button class="btn primary" type="submit" data-action="approve">${isEdit ? 'Save' : 'Save'} &amp; approve</button>
        <a class="btn" href="#/${base}${isEdit ? '/' + doc.id : ''}">Cancel</a>
        <span style="color:var(--ink-soft);font-size:12.5px;margin-left:auto">
          Approving posts this ${docLabel(kind).toLowerCase()} to your ledger.
        </span>
      </div>
    </form>`;

  const linesHost = document.getElementById('lines-host');
  const editor = linesEditor(linesHost, doc.lines);
  const form = document.getElementById('doc-form');

  function renderTotals() {
    const mode = form.elements.taxMode.value;
    const t = liveTotals(editor.read(), mode);
    document.getElementById('totals-box').innerHTML = `
      <div class="row"><span>Subtotal</span><b>${fmtMoney(t.subtotal)}</b></div>
      <div class="row"><span>${esc(STATE.settings.tax_label || 'Tax')}</span><b>${fmtMoney(t.tax)}</b></div>
      <div class="row grand"><span>Total</span><span>${fmtMoney(t.total)}</span></div>`;
  }
  renderTotals();
  main.addEventListener('lines-changed', renderTotals);
  form.elements.taxMode.addEventListener('change', renderTotals);
  form.elements.issueDate.addEventListener('change', () => {
    if (!isEdit) form.elements.dueDate.value = addDays(form.elements.issueDate.value, dueDays);
  });

  let action = 'draft';
  on(form, 'button[type=submit]', 'click', (ev) => { action = ev.target.dataset.action; });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = {
      kind,
      id: doc.id,
      contactId: Number(form.elements.contactId.value),
      issueDate: form.elements.issueDate.value,
      dueDate: form.elements.dueDate.value,
      number: form.elements.number.value.trim() || undefined,
      reference: form.elements.reference.value.trim(),
      taxMode: form.elements.taxMode.value,
      lines: editor.read().filter(l => l.description || l.unitPriceCents || l.accountId),
    };
    if (!data.contactId) return toast('Choose a contact', 'error');
    try {
      let saved = await api('invoices.save', data);
      if (action === 'approve') saved = await api('invoices.approve', { id: saved.id });
      toast(`${docLabel(kind)} ${action === 'approve' ? 'approved' : 'saved'}`, 'success');
      navigate(`#/${base}/${saved.id}`);
    } catch (e) { showError(e); }
  });
};

// ---------- viewer ----------

VIEWS.invoiceView = async function (main, params) {
  const d = await api('invoices.get', { id: Number(params.id) });
  const kind = d.kind;
  const base = docBase(kind);
  const isRec = kind === 'ACCREC';
  const due = d.total_cents - d.paid_cents;
  const s = STATE.settings;
  const overdue = d.status === 'AUTHORISED' && d.due_date < today();

  main.innerHTML = `
    <div class="page-head no-print">
      <h1>${docLabel(kind)} ${esc(d.number || d.reference || '#' + d.id)}</h1>
      ${badge(overdue ? 'OVERDUE' : d.status)}
      <div class="spacer"></div>
      ${d.status === 'DRAFT' || d.status === 'SUBMITTED' ? `
        <a class="btn" href="#/${base}/${d.id}/edit">Edit</a>
        ${d.status === 'DRAFT' ? '<button class="btn" id="btn-submit">Submit for approval</button>' : ''}
        <button class="btn primary" id="btn-approve">Approve</button>
        <button class="btn danger" id="btn-delete">Delete</button>` : ''}
      ${d.status === 'AUTHORISED' ? `<button class="btn primary" id="btn-pay">Record payment</button>` : ''}
      ${(d.status === 'AUTHORISED' || d.status === 'PAID') && d.payments.length === 0 ? `<button class="btn danger" id="btn-void">Void</button>` : ''}
      <button class="btn" id="btn-copy">Copy</button>
      <button class="btn" id="btn-print">Print</button>
      <button class="btn" id="btn-pdf">Export PDF</button>
    </div>

    <div class="card" id="print-area">
      <div class="doc-head">
        <div>
          <div style="font-size:19px;font-weight:750">${esc(s.org_name || 'Ledgerly')}</div>
          <div class="meta">${esc(s.org_address || '')}</div>
          <div class="meta">${s.org_tax_number ? 'Tax no: ' + esc(s.org_tax_number) : ''}</div>
          <div style="margin-top:16px" class="meta">
            ${isRec ? 'Bill to' : 'From'}: <b><a href="#/contacts/${d.contact_id}">${esc(d.contact_name)}</a></b>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:17px;font-weight:700">${isRec ? 'TAX INVOICE' : 'BILL'}</div>
          <div class="meta">Number: <b>${esc(d.number || '—')}</b></div>
          ${d.reference ? `<div class="meta">Reference: <b>${esc(d.reference)}</b></div>` : ''}
          <div class="meta">Issue date: <b>${fmtDate(d.issue_date)}</b></div>
          <div class="meta">Due date: <b>${fmtDate(d.due_date)}</b></div>
          <div class="doc-total" style="margin-top:10px">${fmtMoney(d.total_cents)}</div>
          ${d.status === 'AUTHORISED' || d.status === 'PAID' ? `<div class="meta">Amount due: <b>${fmtMoney(due)}</b></div>` : ''}
        </div>
      </div>

      <table class="data" style="margin-top:18px">
        <thead><tr>
          <th>Description</th><th class="num">Qty</th><th class="num">Unit price</th>
          <th class="num">Disc %</th><th>Account</th><th>Tax</th><th class="num">Amount</th>
        </tr></thead>
        <tbody>
          ${d.lines.map(l => `
            <tr>
              <td>${esc(l.description)}</td>
              <td class="num">${l.qty}</td>
              <td class="num">${fmtMoney(l.unit_price_cents)}</td>
              <td class="num">${l.discount_pct || ''}</td>
              <td>${esc(l.account_code || '')} ${esc(l.account_name || '')}</td>
              <td>${esc(l.tax_name || '')}</td>
              <td class="num">${fmtMoney(l.net_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div class="totals-box">
        <div class="row"><span>Subtotal</span><b>${fmtMoney(d.subtotal_cents)}</b></div>
        <div class="row"><span>${esc(s.tax_label || 'Tax')}</span><b>${fmtMoney(d.tax_cents)}</b></div>
        <div class="row grand"><span>Total</span><span>${fmtMoney(d.total_cents)}</span></div>
        ${d.payments.map(p => `<div class="row"><span>Less payment ${fmtDate(p.date)} (${esc(p.bank_name)})</span><b>−${fmtMoney(p.amount_cents)}</b></div>`).join('')}
        ${d.payments.length ? `<div class="row grand"><span>Amount due</span><span>${fmtMoney(due)}</span></div>` : ''}
      </div>
    </div>

    ${d.payments.length ? `
    <div class="card no-print">
      <h2>Payments</h2>
      <table class="data">
        <thead><tr><th>Date</th><th>Bank account</th><th>Reference</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>
          ${d.payments.map(p => `
            <tr>
              <td>${fmtDate(p.date)}</td><td>${esc(p.bank_name)}</td><td>${esc(p.reference)}</td>
              <td class="num">${fmtMoney(p.amount_cents)}</td>
              <td><button class="btn small danger btn-rm-payment" data-id="${p.id}" ${p.is_reconciled ? 'disabled title="Reconciled — unreconcile first"' : ''}>Remove</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}`;

  const $ = (id) => document.getElementById(id);
  const refresh = () => VIEWS.invoiceView(main, params);

  $('btn-print')?.addEventListener('click', () => window.print());
  $('btn-pdf')?.addEventListener('click', async () => {
    const r = await window.ledgerly.exportPdf(`${d.number || docLabel(kind) + '-' + d.id}.pdf`);
    if (r.ok) toast('PDF saved to ' + r.data, 'success');
  });
  $('btn-submit')?.addEventListener('click', async () => {
    try { await api('invoices.submit', { id: d.id }); toast('Submitted for approval', 'success'); refresh(); } catch (e) { showError(e); }
  });
  $('btn-approve')?.addEventListener('click', async () => {
    try { await api('invoices.approve', { id: d.id }); toast('Approved and posted', 'success'); refresh(); } catch (e) { showError(e); }
  });
  $('btn-void')?.addEventListener('click', async () => {
    if (!confirm(`Void this ${docLabel(kind).toLowerCase()}? This reverses it from your ledger.`)) return;
    try { await api('invoices.void', { id: d.id }); toast('Voided', 'success'); refresh(); } catch (e) { showError(e); }
  });
  $('btn-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this draft?')) return;
    try { await api('invoices.delete', { id: d.id }); toast('Deleted', 'success'); navigate('#/' + base); } catch (e) { showError(e); }
  });
  $('btn-copy')?.addEventListener('click', async () => {
    try {
      const copy = await api('invoices.copy', { id: d.id });
      toast('Copied to new draft', 'success');
      navigate(`#/${base}/${copy.id}/edit`);
    } catch (e) { showError(e); }
  });
  on(main, '.btn-rm-payment', 'click', async (ev) => {
    if (!confirm('Remove this payment?')) return;
    try { await api('payments.remove', { id: Number(ev.target.dataset.id) }); toast('Payment removed', 'success'); refresh(); } catch (e) { showError(e); }
  });

  $('btn-pay')?.addEventListener('click', () => {
    const banks = STATE.accounts.filter(a => a.type === 'BANK');
    if (!banks.length) return toast('Create a bank account first (Accounting → Bank accounts)', 'error');
    const m = modal(`
      <h2>Record a payment</h2>
      <form id="pay-form">
        <div class="field-row">
          <label class="field">Amount *<input name="amount" required value="${dollarsOf(due)}" /></label>
          <label class="field">Date *<input type="date" name="date" required value="${today()}" /></label>
        </div>
        <div class="field-row">
          <label class="field">${isRec ? 'Paid into' : 'Paid from'} *
            <select name="bank">${banks.map(b => `<option value="${b.id}">${esc(b.code)} - ${esc(b.name)}</option>`).join('')}</select>
          </label>
          <label class="field">Reference<input name="reference" /></label>
        </div>
        <div class="btn-row">
          <button class="btn primary" type="submit">Record payment</button>
          <button class="btn" type="button" id="pay-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#pay-cancel').addEventListener('click', closeModal);
    m.querySelector('#pay-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api('payments.add', {
          invoiceId: d.id,
          bankAccountId: Number(f.elements.bank.value),
          date: f.elements.date.value,
          amountCents: centsOf(f.elements.amount.value),
          reference: f.elements.reference.value.trim(),
        });
        closeModal();
        toast('Payment recorded', 'success');
        refresh();
      } catch (e) { showError(e); }
    });
  });
};

// ---------- quotes ----------

VIEWS.quotes = async function (main, params) {
  const tab = params.tab || 'ALL';
  const rows = await api('quotes.list', { status: tab === 'ALL' ? null : tab });
  const t = (id, label) => `<a href="#/quotes?tab=${id}" class="${tab === id ? 'active' : ''}">${label}</a>`;
  main.innerHTML = `
    <div class="page-head">
      <h1>Quotes</h1>
      <div class="spacer"></div>
      <a class="btn primary" href="#/quotes/new">New quote</a>
    </div>
    <div class="tabs">
      ${t('ALL', 'All')}${t('DRAFT', 'Draft')}${t('SENT', 'Sent')}${t('ACCEPTED', 'Accepted')}${t('DECLINED', 'Declined')}${t('INVOICED', 'Invoiced')}
    </div>
    <div class="card">
      <table class="data">
        <thead><tr><th>Number</th><th>To</th><th>Title</th><th>Date</th><th>Expiry</th><th>Status</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="7"><div class="empty">No quotes here yet</div></td></tr>' : ''}
          ${rows.map(q => `
            <tr class="click" data-go="#/quotes/${q.id}">
              <td><b>${esc(q.number)}</b></td><td>${esc(q.contact_name)}</td><td>${esc(q.title)}</td>
              <td>${fmtDate(q.issue_date)}</td><td>${fmtDate(q.expiry_date)}</td>
              <td>${badge(q.status)}</td><td class="num">${fmtMoney(q.total_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
};

VIEWS.quoteEdit = async function (main, params) {
  const isEdit = !!params.id;
  const contacts = await api('contacts.list', {});
  STATE._items = await api('items.list', {});
  let q;
  if (isEdit) {
    const d = await api('quotes.get', { id: Number(params.id) });
    q = {
      id: d.id, contactId: d.contact_id, issueDate: d.issue_date, expiryDate: d.expiry_date || '',
      title: d.title, summary: d.summary, reference: d.reference, taxMode: d.tax_mode,
      lines: d.lines.map(l => ({
        itemId: l.item_id, description: l.description, qty: l.qty, unitPriceCents: l.unit_price_cents,
        discountPct: l.discount_pct, accountId: l.account_id, taxRateId: l.tax_rate_id,
      })),
    };
  } else {
    q = { contactId: null, issueDate: today(), expiryDate: addDays(today(), 30), title: '', summary: '', reference: '', taxMode: 'exclusive', lines: [] };
  }

  main.innerHTML = `
    <div class="page-head"><h1>${isEdit ? 'Edit' : 'New'} quote</h1></div>
    <form id="q-form" class="card">
      <div class="field-row">
        <label class="field">To *<select name="contactId" required>${contactOptions(contacts, q.contactId)}</select></label>
        <label class="field">Issue date *<input type="date" name="issueDate" required value="${q.issueDate}" /></label>
        <label class="field">Expiry<input type="date" name="expiryDate" value="${q.expiryDate || ''}" /></label>
        <label class="field">Reference<input name="reference" value="${esc(q.reference)}" /></label>
        <label class="field">Amounts are
          <select name="taxMode">
            <option value="exclusive" ${q.taxMode === 'exclusive' ? 'selected' : ''}>Tax exclusive</option>
            <option value="inclusive" ${q.taxMode === 'inclusive' ? 'selected' : ''}>Tax inclusive</option>
            <option value="none" ${q.taxMode === 'none' ? 'selected' : ''}>No tax</option>
          </select>
        </label>
      </div>
      <label class="field">Title<input name="title" value="${esc(q.title)}" placeholder="e.g. Website redesign" /></label>
      <label class="field">Summary<textarea name="summary" rows="2">${esc(q.summary)}</textarea></label>
      <div id="lines-host"></div>
      <div class="totals-box" id="totals-box"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn primary" type="submit">Save quote</button>
        <a class="btn" href="#/quotes${isEdit ? '/' + q.id : ''}">Cancel</a>
      </div>
    </form>`;

  const editor = linesEditor(document.getElementById('lines-host'), q.lines);
  const form = document.getElementById('q-form');
  const renderTotals = () => {
    const t = liveTotals(editor.read(), form.elements.taxMode.value);
    document.getElementById('totals-box').innerHTML = `
      <div class="row"><span>Subtotal</span><b>${fmtMoney(t.subtotal)}</b></div>
      <div class="row"><span>Tax</span><b>${fmtMoney(t.tax)}</b></div>
      <div class="row grand"><span>Total</span><span>${fmtMoney(t.total)}</span></div>`;
  };
  renderTotals();
  main.addEventListener('lines-changed', renderTotals);
  form.elements.taxMode.addEventListener('change', renderTotals);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const saved = await api('quotes.save', {
        id: q.id, contactId: Number(form.elements.contactId.value),
        issueDate: form.elements.issueDate.value, expiryDate: form.elements.expiryDate.value || null,
        title: form.elements.title.value.trim(), summary: form.elements.summary.value.trim(),
        reference: form.elements.reference.value.trim(), taxMode: form.elements.taxMode.value,
        lines: editor.read().filter(l => l.description || l.unitPriceCents || l.accountId),
      });
      toast('Quote saved', 'success');
      navigate('#/quotes/' + saved.id);
    } catch (e) { showError(e); }
  });
};

VIEWS.quoteView = async function (main, params) {
  const q = await api('quotes.get', { id: Number(params.id) });
  const s = STATE.settings;
  main.innerHTML = `
    <div class="page-head no-print">
      <h1>Quote ${esc(q.number)}</h1>
      ${badge(q.status)}
      <div class="spacer"></div>
      ${q.status !== 'INVOICED' ? `<a class="btn" href="#/quotes/${q.id}/edit">Edit</a>` : ''}
      ${q.status === 'DRAFT' ? '<button class="btn" id="btn-sent">Mark as sent</button>' : ''}
      ${q.status === 'SENT' ? `<button class="btn" id="btn-accept">Mark accepted</button>
        <button class="btn" id="btn-decline">Mark declined</button>` : ''}
      ${q.status !== 'INVOICED' && q.status !== 'DECLINED' ? '<button class="btn primary" id="btn-invoice">Create invoice</button>' : ''}
      ${q.invoice_id ? `<a class="btn" href="#/invoices/${q.invoice_id}">View invoice</a>` : ''}
      ${q.status !== 'INVOICED' ? '<button class="btn danger" id="btn-delete">Delete</button>' : ''}
      <button class="btn" id="btn-print">Print</button>
      <button class="btn" id="btn-pdf">Export PDF</button>
    </div>
    <div class="card">
      <div class="doc-head">
        <div>
          <div style="font-size:19px;font-weight:750">${esc(s.org_name || 'Ledgerly')}</div>
          <div class="meta" style="margin-top:14px">For: <b><a href="#/contacts/${q.contact_id}">${esc(q.contact_name)}</a></b></div>
          ${q.title ? `<div style="margin-top:10px;font-weight:650">${esc(q.title)}</div>` : ''}
          ${q.summary ? `<div class="meta">${esc(q.summary)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="font-size:17px;font-weight:700">QUOTE</div>
          <div class="meta">Number: <b>${esc(q.number)}</b></div>
          <div class="meta">Date: <b>${fmtDate(q.issue_date)}</b></div>
          ${q.expiry_date ? `<div class="meta">Expires: <b>${fmtDate(q.expiry_date)}</b></div>` : ''}
          <div class="doc-total" style="margin-top:10px">${fmtMoney(q.total_cents)}</div>
        </div>
      </div>
      <table class="data" style="margin-top:18px">
        <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Disc %</th><th>Tax</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${q.lines.map(l => `<tr>
            <td>${esc(l.description)}</td><td class="num">${l.qty}</td>
            <td class="num">${fmtMoney(l.unit_price_cents)}</td><td class="num">${l.discount_pct || ''}</td>
            <td>${esc(l.tax_name || '')}</td><td class="num">${fmtMoney(l.net_cents)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="totals-box">
        <div class="row"><span>Subtotal</span><b>${fmtMoney(q.subtotal_cents)}</b></div>
        <div class="row"><span>Tax</span><b>${fmtMoney(q.tax_cents)}</b></div>
        <div class="row grand"><span>Total</span><span>${fmtMoney(q.total_cents)}</span></div>
      </div>
    </div>`;

  const $ = (id) => document.getElementById(id);
  const refresh = () => VIEWS.quoteView(main, params);
  const setStatus = (status) => async () => {
    try { await api('quotes.setStatus', { id: q.id, status }); toast('Quote updated', 'success'); refresh(); } catch (e) { showError(e); }
  };
  $('btn-sent')?.addEventListener('click', setStatus('SENT'));
  $('btn-accept')?.addEventListener('click', setStatus('ACCEPTED'));
  $('btn-decline')?.addEventListener('click', setStatus('DECLINED'));
  $('btn-print')?.addEventListener('click', () => window.print());
  $('btn-pdf')?.addEventListener('click', async () => {
    const r = await window.ledgerly.exportPdf(`${q.number}.pdf`);
    if (r.ok) toast('PDF saved to ' + r.data, 'success');
  });
  $('btn-invoice')?.addEventListener('click', async () => {
    try {
      const inv = await api('quotes.toInvoice', { id: q.id });
      toast('Draft invoice created', 'success');
      navigate('#/invoices/' + inv.id);
    } catch (e) { showError(e); }
  });
  $('btn-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this quote?')) return;
    try { await api('quotes.delete', { id: q.id }); toast('Quote deleted', 'success'); navigate('#/quotes'); } catch (e) { showError(e); }
  });
};

// ---------- products & services ----------

VIEWS.items = async function (main) {
  const rows = await api('items.list', {});
  main.innerHTML = `
    <div class="page-head">
      <h1>Products &amp; services</h1>
      <div class="spacer"></div>
      <button class="btn primary" id="btn-new-item">New item</button>
    </div>
    <div class="card">
      <table class="data">
        <thead><tr><th>Code</th><th>Name</th><th class="num">Sale price</th><th>Sale account</th><th class="num">Purchase price</th><th>Purchase account</th><th></th></tr></thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="7"><div class="empty">No items yet — items speed up invoice entry</div></td></tr>' : ''}
          ${rows.map(i => `
            <tr>
              <td><b>${esc(i.code)}</b></td><td>${esc(i.name)}</td>
              <td class="num">${i.is_sold ? fmtMoney(i.sale_price_cents) : ''}</td>
              <td>${esc(i.sale_account_name || '')}</td>
              <td class="num">${i.is_purchased ? fmtMoney(i.purchase_price_cents) : ''}</td>
              <td>${esc(i.purchase_account_name || '')}</td>
              <td class="btn-row">
                <button class="btn small btn-edit" data-id="${i.id}">Edit</button>
                <button class="btn small danger btn-arch" data-id="${i.id}">Archive</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  function itemModal(item) {
    const it = item || { is_sold: 1 };
    const m = modal(`
      <h2>${item ? 'Edit item' : 'New item'}</h2>
      <form id="item-form">
        <div class="field-row">
          <label class="field">Code *<input name="code" required value="${esc(it.code || '')}" /></label>
          <label class="field">Name *<input name="name" required value="${esc(it.name || '')}" /></label>
        </div>
        <label class="field">Description<input name="description" value="${esc(it.description || '')}" /></label>
        <label class="checkbox"><input type="checkbox" name="is_sold" ${it.is_sold ? 'checked' : ''}/> I sell this item</label>
        <div class="field-row">
          <label class="field">Sale price<input name="sale_price" value="${it.sale_price_cents ? dollarsOf(it.sale_price_cents) : ''}" /></label>
          <label class="field">Sale account<select name="sale_account">${accountOptions(it.sale_account_id, { filter: 'nonbank' })}</select></label>
          <label class="field">Sale tax<select name="sale_tax">${taxOptions(it.sale_tax_rate_id)}</select></label>
        </div>
        <label class="checkbox"><input type="checkbox" name="is_purchased" ${it.is_purchased ? 'checked' : ''}/> I buy this item</label>
        <div class="field-row">
          <label class="field">Purchase price<input name="purchase_price" value="${it.purchase_price_cents ? dollarsOf(it.purchase_price_cents) : ''}" /></label>
          <label class="field">Purchase account<select name="purchase_account">${accountOptions(it.purchase_account_id, { filter: 'nonbank' })}</select></label>
          <label class="field">Purchase tax<select name="purchase_tax">${taxOptions(it.purchase_tax_rate_id)}</select></label>
        </div>
        <div class="btn-row">
          <button class="btn primary" type="submit">Save item</button>
          <button class="btn" type="button" id="item-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#item-cancel').addEventListener('click', closeModal);
    m.querySelector('#item-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api('items.save', {
          id: it.id,
          code: f.elements.code.value.trim(), name: f.elements.name.value.trim(),
          description: f.elements.description.value.trim(),
          is_sold: f.elements.is_sold.checked, is_purchased: f.elements.is_purchased.checked,
          sale_price_cents: centsOf(f.elements.sale_price.value),
          sale_account_id: Number(f.elements.sale_account.value) || null,
          sale_tax_rate_id: Number(f.elements.sale_tax.value) || null,
          purchase_price_cents: centsOf(f.elements.purchase_price.value),
          purchase_account_id: Number(f.elements.purchase_account.value) || null,
          purchase_tax_rate_id: Number(f.elements.purchase_tax.value) || null,
        });
        closeModal();
        toast('Item saved', 'success');
        VIEWS.items(main);
      } catch (e) { showError(e); }
    });
  }

  document.getElementById('btn-new-item').addEventListener('click', () => itemModal(null));
  on(main, '.btn-edit', 'click', (ev) => itemModal(rows.find(r => r.id == ev.target.dataset.id)));
  on(main, '.btn-arch', 'click', async (ev) => {
    if (!confirm('Archive this item?')) return;
    try { await api('items.archive', { id: Number(ev.target.dataset.id) }); VIEWS.items(main); } catch (e) { showError(e); }
  });
};
