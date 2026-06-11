'use strict';

// Purchase orders and repeating invoice templates.

VIEWS.pos = async function (main, params) {
  const tab = params.tab || 'ALL';
  const rows = await api('pos.list', { status: tab === 'ALL' ? null : tab });
  const t = (id, label) => `<a href="#/purchase-orders?tab=${id}" class="${tab === id ? 'active' : ''}">${label}</a>`;
  main.innerHTML = `
    <div class="page-head">
      <h1>Purchase orders</h1>
      <div class="spacer"></div>
      <a class="btn primary" href="#/purchase-orders/new">New purchase order</a>
    </div>
    <div class="tabs">${t('ALL', 'All')}${t('DRAFT', 'Draft')}${t('SENT', 'Sent')}${t('APPROVED', 'Approved')}${t('BILLED', 'Billed')}${t('CANCELLED', 'Cancelled')}</div>
    <div class="card">
      <table class="data">
        <thead><tr><th>Number</th><th>Supplier</th><th>Date</th><th>Delivery</th><th>Status</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="6"><div class="empty">No purchase orders yet</div></td></tr>' : ''}
          ${rows.map(po => `
            <tr class="click" data-go="#/purchase-orders/${po.id}">
              <td><b>${esc(po.number)}</b></td><td>${esc(po.contact_name)}</td>
              <td>${fmtDate(po.issue_date)}</td><td>${fmtDate(po.delivery_date)}</td>
              <td>${badge(po.status)}</td>
              <td class="num">${fmtMoney(po.total_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
};

VIEWS.poEdit = async function (main, params) {
  const isEdit = !!params.id;
  const contacts = await api('contacts.list', {});
  STATE._items = await api('items.list', {});
  let po;
  if (isEdit) {
    const d = await api('pos.get', { id: Number(params.id) });
    po = {
      id: d.id, contactId: d.contact_id, issueDate: d.issue_date, deliveryDate: d.delivery_date || '',
      deliveryAddress: d.delivery_address, reference: d.reference, taxMode: d.tax_mode,
      lines: d.lines.map(l => ({
        itemId: l.item_id, description: l.description, qty: l.qty, unitPriceCents: l.unit_price_cents,
        discountPct: l.discount_pct, accountId: l.account_id, taxRateId: l.tax_rate_id,
      })),
    };
  } else {
    po = { contactId: null, issueDate: today(), deliveryDate: '', deliveryAddress: '', reference: '', taxMode: 'exclusive', lines: [] };
  }

  main.innerHTML = `
    <div class="page-head"><h1>${isEdit ? 'Edit' : 'New'} purchase order</h1></div>
    <form id="po-form" class="card">
      <div class="field-row">
        <label class="field">Supplier *<select name="contactId" required>${contactOptions(contacts, po.contactId)}</select></label>
        <label class="field">Date *<input type="date" name="issueDate" required value="${po.issueDate}" /></label>
        <label class="field">Delivery date<input type="date" name="deliveryDate" value="${po.deliveryDate || ''}" /></label>
        <label class="field">Reference<input name="reference" value="${esc(po.reference)}" /></label>
        <label class="field">Amounts are
          <select name="taxMode">
            <option value="exclusive" ${po.taxMode === 'exclusive' ? 'selected' : ''}>Tax exclusive</option>
            <option value="inclusive" ${po.taxMode === 'inclusive' ? 'selected' : ''}>Tax inclusive</option>
            <option value="none" ${po.taxMode === 'none' ? 'selected' : ''}>No tax</option>
          </select>
        </label>
      </div>
      <label class="field">Delivery address<input name="deliveryAddress" value="${esc(po.deliveryAddress)}" /></label>
      <div id="lines-host"></div>
      <div class="totals-box" id="totals-box"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn primary" type="submit">Save purchase order</button>
        <a class="btn" href="#/purchase-orders${isEdit ? '/' + po.id : ''}">Cancel</a>
      </div>
    </form>`;

  const editor = linesEditor(document.getElementById('lines-host'), po.lines);
  const form = document.getElementById('po-form');
  const renderTotals = () => {
    const t = liveTotals(editor.read(), form.elements.taxMode.value);
    document.getElementById('totals-box').innerHTML = `
      <div class="row"><span>Subtotal</span><b>${fmtMoney(t.subtotal)}</b></div>
      <div class="row"><span>GST</span><b>${fmtMoney(t.tax)}</b></div>
      <div class="row grand"><span>Total</span><span>${fmtMoney(t.total)}</span></div>`;
  };
  renderTotals();
  main.addEventListener('lines-changed', renderTotals);
  form.elements.taxMode.addEventListener('change', renderTotals);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const saved = await api('pos.save', {
        id: po.id, contactId: Number(form.elements.contactId.value),
        issueDate: form.elements.issueDate.value, deliveryDate: form.elements.deliveryDate.value || null,
        deliveryAddress: form.elements.deliveryAddress.value.trim(), reference: form.elements.reference.value.trim(),
        taxMode: form.elements.taxMode.value,
        lines: editor.read().filter(l => l.description || l.unitPriceCents || l.accountId),
      });
      toast('Purchase order saved', 'success');
      navigate('#/purchase-orders/' + saved.id);
    } catch (e) { showError(e); }
  });
};

VIEWS.poView = async function (main, params) {
  const po = await api('pos.get', { id: Number(params.id) });
  const s = STATE.settings;
  main.innerHTML = `
    <div class="page-head no-print">
      <h1>Purchase order ${esc(po.number)}</h1>
      ${badge(po.status)}
      <div class="spacer"></div>
      ${po.status !== 'BILLED' && po.status !== 'CANCELLED' ? `<a class="btn" href="#/purchase-orders/${po.id}/edit">Edit</a>` : ''}
      ${po.status === 'DRAFT' ? '<button class="btn" id="btn-sent">Mark as sent</button>' : ''}
      ${['DRAFT', 'SENT'].includes(po.status) ? '<button class="btn" id="btn-approve">Approve</button>' : ''}
      ${['APPROVED', 'SENT'].includes(po.status) ? '<button class="btn primary" id="btn-bill">Create bill</button>' : ''}
      ${po.bill_id ? `<a class="btn" href="#/bills/${po.bill_id}">View bill</a>` : ''}
      ${po.status !== 'BILLED' ? '<button class="btn danger" id="btn-cancel">Cancel order</button>' : ''}
      <button class="btn" id="btn-print">Print</button>
      <button class="btn" id="btn-pdf">Export PDF</button>
    </div>
    <div class="card">
      <div class="doc-head">
        <div>
          <div style="font-size:19px;font-weight:750">${esc(s.org_name || 'Ledgerly')}</div>
          <div class="meta" style="margin-top:14px">Supplier: <b><a href="#/contacts/${po.contact_id}">${esc(po.contact_name)}</a></b></div>
          ${po.delivery_address ? `<div class="meta">Deliver to: ${esc(po.delivery_address)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="font-size:17px;font-weight:700">PURCHASE ORDER</div>
          <div class="meta">Number: <b>${esc(po.number)}</b></div>
          <div class="meta">Date: <b>${fmtDate(po.issue_date)}</b></div>
          ${po.delivery_date ? `<div class="meta">Delivery: <b>${fmtDate(po.delivery_date)}</b></div>` : ''}
          <div class="doc-total" style="margin-top:10px">${fmtMoney(po.total_cents)}</div>
        </div>
      </div>
      <table class="data" style="margin-top:18px">
        <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th>Tax</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${po.lines.map(l => `<tr><td>${esc(l.description)}</td><td class="num">${l.qty}</td>
            <td class="num">${fmtMoney(l.unit_price_cents)}</td><td>${esc(l.tax_name || '')}</td>
            <td class="num">${fmtMoney(l.net_cents)}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="totals-box">
        <div class="row"><span>Subtotal</span><b>${fmtMoney(po.subtotal_cents)}</b></div>
        <div class="row"><span>GST</span><b>${fmtMoney(po.tax_cents)}</b></div>
        <div class="row grand"><span>Total</span><span>${fmtMoney(po.total_cents)}</span></div>
      </div>
    </div>`;

  const $ = (id) => document.getElementById(id);
  const refresh = () => VIEWS.poView(main, params);
  $('btn-print')?.addEventListener('click', () => window.print());
  $('btn-pdf')?.addEventListener('click', async () => {
    const r = await window.ledgerly.exportPdf(`${po.number}.pdf`);
    if (r.ok) toast('PDF saved to ' + r.data, 'success');
  });
  $('btn-sent')?.addEventListener('click', async () => {
    try { await api('pos.setStatus', { id: po.id, status: 'SENT' }); refresh(); } catch (e) { showError(e); }
  });
  $('btn-approve')?.addEventListener('click', async () => {
    try { await api('pos.setStatus', { id: po.id, status: 'APPROVED' }); toast('Approved', 'success'); refresh(); } catch (e) { showError(e); }
  });
  $('btn-cancel')?.addEventListener('click', async () => {
    if (!confirm('Cancel this purchase order?')) return;
    try { await api('pos.setStatus', { id: po.id, status: 'CANCELLED' }); refresh(); } catch (e) { showError(e); }
  });
  $('btn-bill')?.addEventListener('click', async () => {
    try {
      const bill = await api('pos.toBill', { id: po.id });
      toast('Draft bill created', 'success');
      navigate('#/bills/' + bill.id);
    } catch (e) { showError(e); }
  });
};

// ---------- repeating invoices ----------

VIEWS.repeating = async function (main) {
  const rows = await api('repeating.list');
  main.innerHTML = `
    <div class="page-head">
      <h1>Repeating invoices</h1>
      <div class="spacer"></div>
      <button class="btn" id="btn-generate">Generate due now</button>
      <a class="btn primary" href="#/repeating/new">New repeating invoice</a>
    </div>
    <div class="page-sub">Templates generate automatically when the app starts, or on demand.</div>
    <div class="card">
      <table class="data">
        <thead><tr><th>Type</th><th>Contact</th><th>Reference</th><th>Every</th><th>Next date</th><th>Ends</th><th>Auto-approve</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="9"><div class="empty">No repeating templates yet</div></td></tr>' : ''}
          ${rows.map(r => `
            <tr>
              <td>${r.kind === 'ACCPAY' ? 'Bill' : 'Invoice'}</td>
              <td>${esc(r.contact_name)}</td>
              <td><a href="#/repeating/${r.id}/edit">${esc(r.reference || '(no reference)')}</a></td>
              <td>${r.schedule_every} ${r.schedule_unit.toLowerCase()}${r.schedule_every > 1 ? 's' : ''}</td>
              <td>${fmtDate(r.next_date)}</td>
              <td>${fmtDate(r.end_date)}</td>
              <td>${r.auto_approve ? 'Yes' : 'Draft only'}</td>
              <td>${badge(r.status)}</td>
              <td class="btn-row">
                <button class="btn small btn-toggle" data-id="${r.id}" data-status="${r.status}">${r.status === 'ACTIVE' ? 'Pause' : 'Resume'}</button>
                <button class="btn small danger btn-del" data-id="${r.id}">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  document.getElementById('btn-generate').addEventListener('click', async () => {
    try {
      const r = await api('repeating.generateDue', {});
      toast(r.created ? `Generated ${r.created} document${r.created === 1 ? '' : 's'}` : 'Nothing due to generate', 'success');
      VIEWS.repeating(main);
    } catch (e) { showError(e); }
  });
  on(main, '.btn-toggle', 'click', async (ev) => {
    const id = Number(ev.target.dataset.id);
    const status = ev.target.dataset.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    try { await api('repeating.setStatus', { id, status }); VIEWS.repeating(main); } catch (e) { showError(e); }
  });
  on(main, '.btn-del', 'click', async (ev) => {
    if (!confirm('Delete this repeating template? Already-generated documents are kept.')) return;
    try { await api('repeating.delete', { id: Number(ev.target.dataset.id) }); VIEWS.repeating(main); } catch (e) { showError(e); }
  });
};

VIEWS.repeatingEdit = async function (main, params) {
  const isEdit = !!params.id;
  const contacts = await api('contacts.list', {});
  STATE._items = await api('items.list', {});
  let t;
  if (isEdit) {
    t = await api('repeating.get', { id: Number(params.id) });
    t = {
      id: t.id, kind: t.kind, contactId: t.contact_id, reference: t.reference, taxMode: t.tax_mode,
      scheduleEvery: t.schedule_every, scheduleUnit: t.schedule_unit, nextDate: t.next_date,
      endDate: t.end_date || '', dueDays: t.due_days, autoApprove: t.auto_approve, lines: t.lines,
    };
  } else {
    t = { kind: 'ACCREC', contactId: null, reference: '', taxMode: 'exclusive', scheduleEvery: 1,
      scheduleUnit: 'MONTH', nextDate: today(), endDate: '', dueDays: 14, autoApprove: 0, lines: [] };
  }

  main.innerHTML = `
    <div class="page-head"><h1>${isEdit ? 'Edit' : 'New'} repeating invoice</h1></div>
    <form id="rep-form" class="card">
      <div class="field-row">
        <label class="field">Type
          <select name="kind">
            <option value="ACCREC" ${t.kind === 'ACCREC' ? 'selected' : ''}>Invoice (sales)</option>
            <option value="ACCPAY" ${t.kind === 'ACCPAY' ? 'selected' : ''}>Bill (purchase)</option>
          </select>
        </label>
        <label class="field">Contact *<select name="contactId" required>${contactOptions(contacts, t.contactId)}</select></label>
        <label class="field">Reference<input name="reference" value="${esc(t.reference)}" /></label>
        <label class="field">Amounts are
          <select name="taxMode">
            <option value="exclusive" ${t.taxMode === 'exclusive' ? 'selected' : ''}>Tax exclusive</option>
            <option value="inclusive" ${t.taxMode === 'inclusive' ? 'selected' : ''}>Tax inclusive</option>
            <option value="none" ${t.taxMode === 'none' ? 'selected' : ''}>No tax</option>
          </select>
        </label>
      </div>
      <div class="field-row">
        <label class="field">Repeat every
          <input name="scheduleEvery" value="${t.scheduleEvery}" style="max-width:80px" />
        </label>
        <label class="field">Period
          <select name="scheduleUnit">
            <option value="WEEK" ${t.scheduleUnit === 'WEEK' ? 'selected' : ''}>Week(s)</option>
            <option value="MONTH" ${t.scheduleUnit === 'MONTH' ? 'selected' : ''}>Month(s)</option>
          </select>
        </label>
        <label class="field">Next date *<input type="date" name="nextDate" required value="${t.nextDate}" /></label>
        <label class="field">End date (optional)<input type="date" name="endDate" value="${t.endDate || ''}" /></label>
        <label class="field">Due days<input name="dueDays" value="${t.dueDays}" style="max-width:90px" /></label>
      </div>
      <label class="checkbox"><input type="checkbox" name="autoApprove" ${t.autoApprove ? 'checked' : ''}/>
        Approve automatically (otherwise saved as draft)</label>
      <div id="lines-host"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn primary" type="submit">Save template</button>
        <a class="btn" href="#/repeating">Cancel</a>
      </div>
    </form>`;

  const editor = linesEditor(document.getElementById('lines-host'), t.lines);
  document.getElementById('rep-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api('repeating.save', {
        id: t.id, kind: f.elements.kind.value, contactId: Number(f.elements.contactId.value),
        reference: f.elements.reference.value.trim(), taxMode: f.elements.taxMode.value,
        scheduleEvery: f.elements.scheduleEvery.value, scheduleUnit: f.elements.scheduleUnit.value,
        nextDate: f.elements.nextDate.value, endDate: f.elements.endDate.value || null,
        dueDays: f.elements.dueDays.value, autoApprove: f.elements.autoApprove.checked,
        lines: editor.read().filter(l => l.description || l.unitPriceCents || l.accountId),
      });
      toast('Repeating template saved', 'success');
      navigate('#/repeating');
    } catch (e) { showError(e); }
  });
};
