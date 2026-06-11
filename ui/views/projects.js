'use strict';

// Projects and time tracking.

VIEWS.projects = async function (main, params) {
  const tab = params.tab || 'ACTIVE';
  const rows = await api('projects.list', { status: tab === 'ALL' ? null : tab });
  const contacts = await api('contacts.list', {});
  const t = (id, label) => `<a href="#/projects?tab=${id}" class="${tab === id ? 'active' : ''}">${label}</a>`;

  main.innerHTML = `
    <div class="page-head">
      <h1>Projects</h1>
      <div class="spacer"></div>
      <button class="btn primary" id="btn-new-project">New project</button>
    </div>
    <div class="tabs">${t('ACTIVE', 'Active')}${t('CLOSED', 'Closed')}${t('ALL', 'All')}</div>
    <div class="card">
      <table class="data">
        <thead><tr><th>Project</th><th>Customer</th><th>Status</th>
          <th class="num">Revenue</th><th class="num">Costs</th><th class="num">Profit</th></tr></thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="6"><div class="empty">No projects yet — track time and profitability per job</div></td></tr>' : ''}
          ${rows.map(p => `
            <tr class="click" data-go="#/projects/${p.id}">
              <td><b>${esc(p.name)}</b></td>
              <td>${esc(p.contact_name || '')}</td>
              <td>${badge(p.status)}</td>
              <td class="num">${fmtMoney(p.revenue_cents)}</td>
              <td class="num">${fmtMoney(p.cost_cents)}</td>
              <td class="num">${fmtMoneySigned(p.profit_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  document.getElementById('btn-new-project').addEventListener('click', () => projectModal(null, contacts, () => VIEWS.projects(main, params)));
};

function projectModal(p, contacts, done) {
  const x = p || {};
  const m = modal(`
    <h2>${p ? 'Edit project' : 'New project'}</h2>
    <form id="proj-form">
      <label class="field">Project name *<input name="name" required value="${esc(x.name || '')}" /></label>
      <div class="field-row">
        <label class="field">Customer<select name="contact">${contactOptions(contacts, x.contact_id)}</select></label>
        <label class="field">Default hourly rate<input name="rate" value="${x.hourly_rate_cents ? dollarsOf(x.hourly_rate_cents) : ''}" /></label>
        ${p ? `<label class="field">Status
          <select name="status">
            <option value="ACTIVE" ${x.status === 'ACTIVE' ? 'selected' : ''}>Active</option>
            <option value="CLOSED" ${x.status === 'CLOSED' ? 'selected' : ''}>Closed</option>
          </select></label>` : ''}
      </div>
      <div class="btn-row">
        <button class="btn primary" type="submit">Save project</button>
        <button class="btn" type="button" id="proj-cancel">Cancel</button>
      </div>
    </form>`);
  m.querySelector('#proj-cancel').addEventListener('click', closeModal);
  m.querySelector('#proj-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api('projects.save', {
        id: x.id, name: f.elements.name.value.trim(),
        contactId: Number(f.elements.contact.value) || null,
        hourlyRateCents: centsOf(f.elements.rate.value),
        status: f.elements.status ? f.elements.status.value : 'ACTIVE',
      });
      closeModal();
      toast('Project saved', 'success');
      done();
    } catch (e) { showError(e); }
  });
}

VIEWS.projectDetail = async function (main, params) {
  const p = await api('projects.get', { id: Number(params.id) });
  const contacts = await api('contacts.list', {});

  main.innerHTML = `
    <div class="page-head">
      <h1>${esc(p.name)}</h1>
      ${badge(p.status)}
      <div class="spacer"></div>
      <button class="btn" id="btn-edit">Edit project</button>
      <button class="btn" id="btn-add-time">Log time</button>
      ${p.unbilled_cents > 0 ? `<button class="btn primary" id="btn-invoice-time">Invoice unbilled time (${fmtMoney(p.unbilled_cents)})</button>` : ''}
    </div>
    ${p.contact_name ? `<div class="page-sub">Customer: <a href="#/contacts/${p.contact_id}">${esc(p.contact_name)}</a></div>` : ''}

    <div class="stat-row" style="margin-bottom:16px">
      <div class="stat"><div class="label">Revenue</div><div class="value">${fmtMoney(p.revenue_cents)}</div></div>
      <div class="stat"><div class="label">Costs</div><div class="value">${fmtMoney(p.cost_cents)}</div></div>
      <div class="stat"><div class="label">Profit</div><div class="value ${p.profit_cents < 0 ? 'amount-neg' : ''}">${fmtMoney(p.profit_cents)}</div></div>
      <div class="stat"><div class="label">Unbilled time</div><div class="value">${p.unbilled_hours}h</div>
        <div class="sub">${fmtMoney(p.unbilled_cents)}</div></div>
    </div>

    <div class="card">
      <h2>Time entries</h2>
      <table class="data">
        <thead><tr><th>Date</th><th>Description</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Value</th><th>Billable</th><th>Invoiced</th><th></th></tr></thead>
        <tbody>
          ${p.time_entries.length === 0 ? '<tr><td colspan="8"><div class="empty">No time logged yet</div></td></tr>' : ''}
          ${p.time_entries.map(t => `
            <tr>
              <td>${fmtDate(t.date)}</td><td>${esc(t.description)}</td>
              <td class="num">${t.hours}</td>
              <td class="num">${fmtMoney(t.rate_cents)}</td>
              <td class="num">${fmtMoney(Math.round(t.hours * t.rate_cents))}</td>
              <td>${t.billable ? 'Yes' : 'No'}</td>
              <td>${t.invoice_id ? `<a href="#/invoices/${t.invoice_id}">${esc(t.invoice_number || '#' + t.invoice_id)}</a>` : ''}</td>
              <td>${!t.invoice_id ? `<button class="btn small danger btn-del-time" data-id="${t.id}">Delete</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const refresh = () => VIEWS.projectDetail(main, params);
  document.getElementById('btn-edit').addEventListener('click', () => projectModal(p, contacts, refresh));

  document.getElementById('btn-add-time').addEventListener('click', () => {
    const m = modal(`
      <h2>Log time</h2>
      <form id="time-form">
        <div class="field-row">
          <label class="field">Date *<input type="date" name="date" required value="${today()}" /></label>
          <label class="field">Hours *<input name="hours" required placeholder="e.g. 2.5" /></label>
          <label class="field">Rate (default ${fmtMoney(p.hourly_rate_cents)})<input name="rate" /></label>
        </div>
        <label class="field">Description<input name="description" /></label>
        <label class="checkbox"><input type="checkbox" name="billable" checked /> Billable</label>
        <div class="btn-row">
          <button class="btn primary" type="submit">Log time</button>
          <button class="btn" type="button" id="time-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#time-cancel').addEventListener('click', closeModal);
    m.querySelector('#time-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api('projects.saveTime', {
          projectId: p.id, date: f.elements.date.value, hours: parseFloat(f.elements.hours.value),
          description: f.elements.description.value.trim(),
          rateCents: f.elements.rate.value ? centsOf(f.elements.rate.value) : null,
          billable: f.elements.billable.checked,
        });
        closeModal();
        toast('Time logged', 'success');
        refresh();
      } catch (e) { showError(e); }
    });
  });

  on(main, '.btn-del-time', 'click', async (ev) => {
    if (!confirm('Delete this time entry?')) return;
    try { await api('projects.deleteTime', { id: Number(ev.target.dataset.id) }); refresh(); } catch (e) { showError(e); }
  });

  document.getElementById('btn-invoice-time')?.addEventListener('click', () => {
    const revAccs = STATE.accounts.filter(a => ['REVENUE', 'OTHER_INCOME'].includes(a.class));
    const m = modal(`
      <h2>Invoice unbilled time</h2>
      <p style="color:var(--ink-soft);font-size:13px">Creates a draft invoice for <b>${fmtMoney(p.unbilled_cents)}</b>
        (${p.unbilled_hours}h) to ${esc(p.contact_name || 'the project customer')}.</p>
      <form id="it-form">
        <div class="field-row">
          <label class="field">Revenue account *
            <select name="account">${revAccs.map(a => `<option value="${a.id}">${esc(a.code)} - ${esc(a.name)}</option>`).join('')}</select>
          </label>
          <label class="field">Tax rate<select name="tax">${taxOptions(null)}</select></label>
        </div>
        <div class="btn-row">
          <button class="btn primary" type="submit">Create draft invoice</button>
          <button class="btn" type="button" id="it-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#it-cancel').addEventListener('click', closeModal);
    m.querySelector('#it-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const inv = await api('projects.invoiceTime', {
          projectId: p.id,
          salesAccountId: Number(ev.target.elements.account.value),
          taxRateId: Number(ev.target.elements.tax.value) || null,
        });
        closeModal();
        toast('Draft invoice created', 'success');
        navigate('#/invoices/' + inv.id);
      } catch (e) { showError(e); }
    });
  });
};
