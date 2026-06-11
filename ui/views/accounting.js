'use strict';

// Chart of accounts and manual journals.

VIEWS.chart = async function (main, params) {
  const includeArchived = params.tab === 'archived';
  const accounts = await api('accounts.list', { includeArchived: true });
  const types = await api('accounts.types');
  const rows = accounts.filter(a => includeArchived ? a.is_archived : !a.is_archived);
  const groups = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
  const groupLabels = { ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity', REVENUE: 'Revenue', EXPENSE: 'Expenses' };

  main.innerHTML = `
    <div class="page-head">
      <h1>Chart of accounts</h1>
      <div class="spacer"></div>
      <button class="btn primary" id="btn-new-acc">Add account</button>
    </div>
    <div class="tabs">
      <a href="#/chart" class="${includeArchived ? '' : 'active'}">Active</a>
      <a href="#/chart?tab=archived" class="${includeArchived ? 'active' : ''}">Archived</a>
    </div>
    ${groups.map(g => {
      const ga = rows.filter(a => a.class === g);
      if (!ga.length) return '';
      return `
      <div class="card">
        <h2>${groupLabels[g]}</h2>
        <table class="data">
          <thead><tr><th style="width:80px">Code</th><th>Name</th><th>Type</th><th>Tax</th><th class="num">Balance</th><th></th></tr></thead>
          <tbody>
            ${ga.map(a => `
              <tr>
                <td><b>${esc(a.code)}</b></td>
                <td>${esc(a.name)}${a.system_key ? ' <span class="badge DRAFT" title="System account">system</span>' : ''}</td>
                <td>${esc(a.type_label)}</td>
                <td>${esc(a.tax_name || '')}</td>
                <td class="num"><a href="#/reports/account-transactions?account=${a.id}">${fmtMoney(Math.abs(a.balance_cents))}${a.balance_cents !== 0 ? (a.balance_cents > 0 ? ' DR' : ' CR') : ''}</a></td>
                <td class="btn-row">
                  <button class="btn small btn-edit" data-id="${a.id}">Edit</button>
                  ${!a.system_key ? `<button class="btn small ${a.is_archived ? '' : 'danger'} btn-arch" data-id="${a.id}">${a.is_archived ? 'Restore' : 'Archive'}</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    }).join('')}`;

  function accModal(acc) {
    const a = acc || {};
    const m = modal(`
      <h2>${acc ? 'Edit account' : 'Add account'}</h2>
      <form id="acc-form">
        <div class="field-row">
          <label class="field">Code *<input name="code" required value="${esc(a.code || '')}" /></label>
          <label class="field">Type *
            <select name="type" ${a.system_key ? 'disabled' : ''}>
              ${types.map(t => `<option value="${t.value}" ${t.value === a.type ? 'selected' : ''}>${t.label}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="field">Name *<input name="name" required value="${esc(a.name || '')}" /></label>
        <label class="field">Description<input name="description" value="${esc(a.description || '')}" /></label>
        <label class="field">Default tax rate<select name="tax">${taxOptions(a.tax_rate_id)}</select></label>
        <div class="btn-row">
          <button class="btn primary" type="submit">Save</button>
          <button class="btn" type="button" id="acc-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#acc-cancel').addEventListener('click', closeModal);
    m.querySelector('#acc-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api('accounts.save', {
          id: a.id, code: f.elements.code.value.trim(), name: f.elements.name.value.trim(),
          type: a.system_key ? a.type : f.elements.type.value,
          description: f.elements.description.value.trim(),
          tax_rate_id: Number(f.elements.tax.value) || null,
        });
        closeModal();
        toast('Account saved', 'success');
        VIEWS.chart(main, params);
      } catch (e) { showError(e); }
    });
  }

  document.getElementById('btn-new-acc').addEventListener('click', () => accModal(null));
  on(main, '.btn-edit', 'click', (ev) => accModal(accounts.find(x => x.id == ev.target.dataset.id)));
  on(main, '.btn-arch', 'click', async (ev) => {
    const a = accounts.find(x => x.id == ev.target.dataset.id);
    try {
      await api('accounts.archive', { id: a.id, archived: !a.is_archived });
      toast(a.is_archived ? 'Account restored' : 'Account archived', 'success');
      VIEWS.chart(main, params);
    } catch (e) { showError(e); }
  });
};

// ---------- manual journals ----------

VIEWS.journals = async function (main) {
  const rows = await api('journals.list', { manualOnly: true });
  main.innerHTML = `
    <div class="page-head">
      <h1>Manual journals</h1>
      <div class="spacer"></div>
      <a class="btn primary" href="#/journals/new">New journal</a>
    </div>
    <div class="card">
      <table class="data">
        <thead><tr><th>Date</th><th>Narration</th><th>Status</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="4"><div class="empty">No manual journals yet</div></td></tr>' : ''}
          ${rows.map(j => `
            <tr class="click" data-go="#/journals/${j.id}">
              <td>${fmtDate(j.date)}</td><td>${esc(j.narration)}</td>
              <td>${badge(j.status)}</td><td class="num">${fmtMoney(j.total_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
};

VIEWS.journalView = async function (main, params) {
  const j = await api('journals.get', { id: Number(params.id) });
  const isManual = j.source_kind === 'manual';
  main.innerHTML = `
    <div class="page-head">
      <h1>Journal #${j.id}</h1>
      ${badge(j.status)}
      <div class="spacer"></div>
      ${isManual && j.status === 'DRAFT' ? `
        <a class="btn" href="#/journals/${j.id}/edit">Edit</a>
        <button class="btn primary" id="btn-post">Post</button>` : ''}
      ${isManual && j.status !== 'VOIDED' ? '<button class="btn danger" id="btn-void">Void</button>' : ''}
    </div>
    <div class="card">
      <div class="page-sub" style="margin:0 0 12px">
        ${fmtDate(j.date)} · ${esc(j.narration || '(no narration)')} · source: ${esc(j.source_kind)}
      </div>
      <table class="data">
        <thead><tr><th>Account</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
        <tbody>
          ${j.lines.map(l => `
            <tr>
              <td>${esc(l.account_code)} - ${esc(l.account_name)}</td>
              <td>${esc(l.description)}</td>
              <td class="num">${l.debit_cents ? fmtMoney(l.debit_cents) : ''}</td>
              <td class="num">${l.credit_cents ? fmtMoney(l.credit_cents) : ''}</td>
            </tr>`).join('')}
          <tr class="total">
            <td></td><td>Total</td>
            <td class="num">${fmtMoney(j.lines.reduce((s, l) => s + l.debit_cents, 0))}</td>
            <td class="num">${fmtMoney(j.lines.reduce((s, l) => s + l.credit_cents, 0))}</td>
          </tr>
        </tbody>
      </table>
    </div>`;

  document.getElementById('btn-post')?.addEventListener('click', async () => {
    try { await api('journals.postDraft', { id: j.id }); toast('Journal posted', 'success'); VIEWS.journalView(main, params); } catch (e) { showError(e); }
  });
  document.getElementById('btn-void')?.addEventListener('click', async () => {
    if (!confirm('Void this journal? It will be removed from all reports.')) return;
    try { await api('journals.void', { id: j.id }); toast('Journal voided', 'success'); navigate('#/journals'); } catch (e) { showError(e); }
  });
};

VIEWS.journalEdit = async function (main, params) {
  const isEdit = !!params.id;
  let j = { date: today(), narration: '', lines: [{}, {}] };
  if (isEdit) {
    const d = await api('journals.get', { id: Number(params.id) });
    if (d.status !== 'DRAFT') { navigate('#/journals/' + d.id); return; }
    j = {
      id: d.id, date: d.date, narration: d.narration,
      lines: d.lines.map(l => ({
        accountId: l.account_id, description: l.description,
        debitCents: l.debit_cents, creditCents: l.credit_cents,
      })),
    };
  }

  main.innerHTML = `
    <div class="page-head"><h1>${isEdit ? 'Edit' : 'New'} manual journal</h1></div>
    <form id="j-form" class="card">
      <div class="field-row" style="max-width:560px">
        <label class="field">Date *<input type="date" name="date" required value="${j.date}" /></label>
        <label class="field">Narration *<input name="narration" required value="${esc(j.narration)}" /></label>
      </div>
      <table class="lines" id="j-lines">
        <thead><tr><th>Account</th><th>Description</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      <button type="button" class="btn small" id="j-add" style="margin-top:8px">+ Add line</button>
      <div class="totals-box" id="j-totals"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn" type="submit" data-status="DRAFT">Save as draft</button>
        <button class="btn primary" type="submit" data-status="POSTED">Post journal</button>
        <a class="btn" href="#/journals">Cancel</a>
      </div>
    </form>`;

  const tbody = main.querySelector('#j-lines tbody');
  function addRow(l = {}) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="width:280px"><select class="jl-acc">${accountOptions(l.accountId)}</select></td>
      <td><input class="jl-desc" value="${esc(l.description || '')}" /></td>
      <td class="num" style="width:130px"><input class="jl-dr" value="${l.debitCents ? dollarsOf(l.debitCents) : ''}" placeholder="0.00" /></td>
      <td class="num" style="width:130px"><input class="jl-cr" value="${l.creditCents ? dollarsOf(l.creditCents) : ''}" placeholder="0.00" /></td>
      <td style="width:30px"><button type="button" class="rm">×</button></td>`;
    tbody.appendChild(tr);
    tr.querySelector('.rm').addEventListener('click', () => { tr.remove(); renderTotals(); });
    tr.querySelectorAll('input').forEach(i => i.addEventListener('input', renderTotals));
    // Typing in one side clears the other.
    tr.querySelector('.jl-dr').addEventListener('input', (e) => { if (e.target.value) tr.querySelector('.jl-cr').value = ''; });
    tr.querySelector('.jl-cr').addEventListener('input', (e) => { if (e.target.value) tr.querySelector('.jl-dr').value = ''; });
  }
  j.lines.forEach(addRow);
  main.querySelector('#j-add').addEventListener('click', () => addRow());

  function readLines() {
    return [...tbody.querySelectorAll('tr')].map(tr => ({
      accountId: Number(tr.querySelector('.jl-acc').value) || null,
      description: tr.querySelector('.jl-desc').value.trim(),
      debitCents: centsOf(tr.querySelector('.jl-dr').value),
      creditCents: centsOf(tr.querySelector('.jl-cr').value),
    })).filter(l => l.accountId || l.description || l.debitCents || l.creditCents);
  }

  function renderTotals() {
    const lines = readLines();
    const dr = lines.reduce((s, l) => s + l.debitCents, 0);
    const cr = lines.reduce((s, l) => s + l.creditCents, 0);
    document.getElementById('j-totals').innerHTML = `
      <div class="row"><span>Total debits</span><b>${fmtMoney(dr)}</b></div>
      <div class="row"><span>Total credits</span><b>${fmtMoney(cr)}</b></div>
      <div class="row grand"><span>Difference</span>
        <span class="${dr !== cr ? 'amount-neg' : 'amount-pos'}">${fmtMoney(dr - cr)}</span></div>`;
  }
  renderTotals();

  let status = 'POSTED';
  on(main, 'button[type=submit]', 'click', (ev) => { status = ev.target.dataset.status; });

  document.getElementById('j-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const lines = readLines();
    if (lines.some(l => !l.accountId)) return toast('Every line needs an account', 'error');
    try {
      const saved = await api('journals.saveManual', {
        id: j.id, date: ev.target.elements.date.value,
        narration: ev.target.elements.narration.value.trim(), status, lines,
      });
      toast(status === 'POSTED' ? 'Journal posted' : 'Draft saved', 'success');
      navigate('#/journals/' + saved.id);
    } catch (e) { showError(e); }
  });
};
