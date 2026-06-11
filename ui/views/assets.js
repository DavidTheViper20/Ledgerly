'use strict';

// Fixed asset register.

VIEWS.assets = async function (main, params) {
  const tab = params.tab || 'ALL';
  const rows = await api('assets.list', { status: tab === 'ALL' ? null : tab });
  const t = (id, label) => `<a href="#/assets?tab=${id}" class="${tab === id ? 'active' : ''}">${label}</a>`;
  const statusBadge = (st) => badge(st);

  main.innerHTML = `
    <div class="page-head">
      <h1>Fixed assets</h1>
      <div class="spacer"></div>
      <button class="btn" id="btn-depreciate">Run depreciation</button>
      <button class="btn primary" id="btn-new-asset">New asset</button>
    </div>
    <div class="tabs">${t('ALL', 'All')}${t('DRAFT', 'Draft')}${t('REGISTERED', 'Registered')}${t('DISPOSED', 'Disposed')}</div>
    <div class="card">
      <table class="data">
        <thead><tr><th>Name</th><th>Number</th><th>Purchased</th><th>Status</th>
          <th class="num">Cost</th><th class="num">Accum. depreciation</th><th class="num">Book value</th><th></th></tr></thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="8"><div class="empty">No fixed assets yet — record equipment, vehicles and other long-life purchases</div></td></tr>' : ''}
          ${rows.map(a => `
            <tr>
              <td><b>${esc(a.name)}</b>${a.description ? `<div style="color:var(--ink-soft);font-size:12px">${esc(a.description)}</div>` : ''}</td>
              <td>${esc(a.number)}</td>
              <td>${fmtDate(a.purchase_date)}</td>
              <td>${statusBadge(a.status)}${a.disposed_date ? `<div style="font-size:11.5px;color:var(--ink-soft)">${fmtDate(a.disposed_date)}</div>` : ''}</td>
              <td class="num">${fmtMoney(a.cost_cents)}</td>
              <td class="num">${fmtMoney(a.accumulated_cents)}</td>
              <td class="num"><b>${fmtMoney(a.book_value_cents)}</b></td>
              <td class="btn-row">
                ${a.status !== 'DISPOSED' ? `<button class="btn small btn-edit" data-id="${a.id}">Edit</button>` : ''}
                ${a.status === 'DRAFT' ? `<button class="btn small btn-register" data-id="${a.id}">Register</button>
                  <button class="btn small danger btn-del" data-id="${a.id}">Delete</button>` : ''}
                ${a.status === 'REGISTERED' ? `<button class="btn small danger btn-dispose" data-id="${a.id}">Dispose</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  function assetModal(a) {
    const x = a || { lifeYears: 5, purchaseDate: today() };
    const fixedAccs = STATE.accounts.filter(acc => acc.type === 'FIXED_ASSET');
    const expAccs = STATE.accounts.filter(acc => ['DEPRECIATION', 'EXPENSE'].includes(acc.type));
    const opts = (list, sel) => '<option value=""></option>' + list.map(acc =>
      `<option value="${acc.id}" ${acc.id == sel ? 'selected' : ''}>${esc(acc.code)} - ${esc(acc.name)}</option>`).join('');
    const m = modal(`
      <h2>${a ? 'Edit asset' : 'New asset'}</h2>
      <form id="asset-form">
        <div class="field-row">
          <label class="field">Name *<input name="name" required value="${esc(x.name || '')}" /></label>
          <label class="field">Asset number<input name="number" value="${esc(x.number || '')}" /></label>
        </div>
        <label class="field">Description<input name="description" value="${esc(x.description || '')}" /></label>
        <div class="field-row">
          <label class="field">Purchase date *<input type="date" name="purchaseDate" required value="${x.purchase_date || x.purchaseDate}" /></label>
          <label class="field">Cost *<input name="cost" required value="${x.cost_cents ? dollarsOf(x.cost_cents) : ''}" /></label>
          <label class="field">Residual value<input name="residual" value="${x.residual_cents ? dollarsOf(x.residual_cents) : '0'}" /></label>
          <label class="field">Life (years) *<input name="life" required value="${x.life_years || x.lifeYears}" /></label>
        </div>
        <div class="field-row">
          <label class="field">Asset account *<select name="assetAcc">${opts(fixedAccs, x.asset_account_id)}</select></label>
          <label class="field">Accumulated depreciation *<select name="accumAcc">${opts(fixedAccs, x.accum_account_id)}</select></label>
          <label class="field">Depreciation expense *<select name="expAcc">${opts(expAccs, x.expense_account_id)}</select></label>
        </div>
        <p style="color:var(--ink-soft);font-size:12px">Straight-line depreciation, posted monthly via “Run depreciation”.
          Record the original purchase itself as a bill or spend-money coded to the asset account.</p>
        <div class="btn-row">
          <button class="btn primary" type="submit">Save asset</button>
          <button class="btn" type="button" id="asset-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#asset-cancel').addEventListener('click', closeModal);
    m.querySelector('#asset-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api('assets.save', {
          id: a ? a.id : undefined,
          name: f.elements.name.value.trim(), number: f.elements.number.value.trim(),
          description: f.elements.description.value.trim(),
          purchaseDate: f.elements.purchaseDate.value,
          costCents: centsOf(f.elements.cost.value), residualCents: centsOf(f.elements.residual.value),
          lifeYears: parseFloat(f.elements.life.value),
          assetAccountId: Number(f.elements.assetAcc.value) || null,
          accumAccountId: Number(f.elements.accumAcc.value) || null,
          expenseAccountId: Number(f.elements.expAcc.value) || null,
        });
        closeModal();
        toast('Asset saved', 'success');
        VIEWS.assets(main, params);
      } catch (e) { showError(e); }
    });
  }

  document.getElementById('btn-new-asset').addEventListener('click', () => assetModal(null));
  on(main, '.btn-edit', 'click', (ev) => assetModal(rows.find(r => r.id == ev.target.dataset.id)));
  on(main, '.btn-register', 'click', async (ev) => {
    try {
      await api('assets.register', { id: Number(ev.target.dataset.id) });
      toast('Asset registered', 'success');
      VIEWS.assets(main, params);
    } catch (e) { showError(e); }
  });
  on(main, '.btn-del', 'click', async (ev) => {
    if (!confirm('Delete this draft asset?')) return;
    try { await api('assets.delete', { id: Number(ev.target.dataset.id) }); VIEWS.assets(main, params); } catch (e) { showError(e); }
  });

  document.getElementById('btn-depreciate').addEventListener('click', () => {
    const thisMonth = today().slice(0, 7);
    const m = modal(`
      <h2>Run depreciation</h2>
      <form id="dep-form">
        <label class="field">Depreciate all registered assets up to and including
          <input type="month" name="period" required value="${thisMonth}" />
        </label>
        <div class="btn-row">
          <button class="btn primary" type="submit">Post depreciation</button>
          <button class="btn" type="button" id="dep-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#dep-cancel').addEventListener('click', closeModal);
    m.querySelector('#dep-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const r = await api('assets.runDepreciation', { toPeriod: ev.target.elements.period.value });
        closeModal();
        toast(r.posted ? `Posted ${r.posted} month-entr${r.posted === 1 ? 'y' : 'ies'} of depreciation` : 'Nothing to depreciate', 'success');
        VIEWS.assets(main, params);
      } catch (e) { showError(e); }
    });
  });

  on(main, '.btn-dispose', 'click', (ev) => {
    const a = rows.find(r => r.id == ev.target.dataset.id);
    const banks = STATE.accounts.filter(acc => acc.type === 'BANK');
    const m = modal(`
      <h2>Dispose of ${esc(a.name)}</h2>
      <p style="color:var(--ink-soft);font-size:13px">Book value: <b>${fmtMoney(a.book_value_cents)}</b>.
        Any difference between proceeds and book value posts to Gain/Loss on Asset Disposal.</p>
      <form id="disp-form">
        <div class="field-row">
          <label class="field">Disposal date *<input type="date" name="date" required value="${today()}" /></label>
          <label class="field">Sale proceeds<input name="proceeds" value="0.00" /></label>
          <label class="field">Proceeds paid into
            <select name="bank"><option value=""></option>${banks.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
          </label>
        </div>
        <div class="btn-row">
          <button class="btn danger" type="submit">Dispose asset</button>
          <button class="btn" type="button" id="disp-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#disp-cancel').addEventListener('click', closeModal);
    m.querySelector('#disp-form').addEventListener('submit', async (ev2) => {
      ev2.preventDefault();
      try {
        await api('assets.dispose', {
          id: a.id, date: ev2.target.elements.date.value,
          proceedsCents: centsOf(ev2.target.elements.proceeds.value),
          bankAccountId: Number(ev2.target.elements.bank.value) || null,
        });
        closeModal();
        toast('Asset disposed', 'success');
        VIEWS.assets(main, params);
      } catch (e) { showError(e); }
    });
  });
};
