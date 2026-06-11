'use strict';

// Expense claims.

VIEWS.claims = async function (main, params) {
  const tab = params.tab || 'ALL';
  const rows = await api('claims.list', { status: tab === 'ALL' ? null : tab });
  const t = (id, label) => `<a href="#/expense-claims?tab=${id}" class="${tab === id ? 'active' : ''}">${label}</a>`;
  main.innerHTML = `
    <div class="page-head">
      <h1>Expense claims</h1>
      <div class="spacer"></div>
      <a class="btn primary" href="#/expense-claims/new">New expense claim</a>
    </div>
    <div class="tabs">${t('ALL', 'All')}${t('DRAFT', 'Draft')}${t('SUBMITTED', 'Submitted')}${t('AUTHORISED', 'Awaiting Payment')}${t('PAID', 'Paid')}${t('DECLINED', 'Declined')}</div>
    <div class="card">
      <table class="data">
        <thead><tr><th>Number</th><th>Claimed by</th><th>Date</th><th>Status</th><th class="num">GST</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="6"><div class="empty">No expense claims yet — claim back out-of-pocket spending</div></td></tr>' : ''}
          ${rows.map(c => `
            <tr class="click" data-go="#/expense-claims/${c.id}">
              <td><b>${esc(c.number)}</b></td><td>${esc(c.payee)}</td><td>${fmtDate(c.date)}</td>
              <td>${badge(c.status)}</td>
              <td class="num">${fmtMoney(c.tax_cents)}</td>
              <td class="num">${fmtMoney(c.total_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
};

VIEWS.claimEdit = async function (main, params) {
  const isEdit = !!params.id;
  const projects = await api('projects.list', { status: 'ACTIVE' });
  let claim;
  if (isEdit) {
    const d = await api('claims.get', { id: Number(params.id) });
    claim = {
      id: d.id, payee: d.payee, date: d.date,
      lines: d.lines.map(l => ({
        date: l.date, description: l.description, merchant: l.merchant, grossCents: l.gross_cents,
        accountId: l.account_id, taxRateId: l.tax_rate_id, projectId: l.project_id,
      })),
    };
  } else {
    claim = { payee: '', date: today(), lines: [{}, {}] };
  }

  const projOpts = (sel) => '<option value=""></option>' + projects.map(p =>
    `<option value="${p.id}" ${p.id == sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  main.innerHTML = `
    <div class="page-head"><h1>${isEdit ? 'Edit' : 'New'} expense claim</h1></div>
    <form id="claim-form" class="card">
      <div class="field-row" style="max-width:560px">
        <label class="field">Claimed by *<input name="payee" required value="${esc(claim.payee)}" placeholder="e.g. David" /></label>
        <label class="field">Claim date *<input type="date" name="date" required value="${claim.date}" /></label>
      </div>
      <p class="page-sub" style="margin:0 0 10px">Enter receipt amounts <b>including GST</b>; the GST portion is claimed back automatically.</p>
      <table class="lines" id="cl-lines">
        <thead><tr><th>Date</th><th>Merchant</th><th>Description</th><th style="text-align:right">Amount (incl GST)</th><th>Account</th><th>Tax</th><th>Project</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      <button type="button" class="btn small" id="cl-add" style="margin-top:8px">+ Add receipt</button>
      <div class="totals-box" id="cl-totals"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn primary" type="submit">Save claim</button>
        <a class="btn" href="#/expense-claims${isEdit ? '/' + claim.id : ''}">Cancel</a>
      </div>
    </form>`;

  const tbody = main.querySelector('#cl-lines tbody');
  function addRow(l = {}) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="width:140px"><input type="date" class="cl-date" value="${l.date || claim.date}" /></td>
      <td style="width:150px"><input class="cl-merchant" value="${esc(l.merchant || '')}" /></td>
      <td><input class="cl-desc" value="${esc(l.description || '')}" /></td>
      <td class="num" style="width:130px"><input class="cl-amount" value="${l.grossCents ? dollarsOf(l.grossCents) : ''}" placeholder="0.00" /></td>
      <td style="width:190px"><select class="cl-acc">${accountOptions(l.accountId, { filter: 'nonbank' })}</select></td>
      <td style="width:160px"><select class="cl-tax">${taxOptions(l.taxRateId)}</select></td>
      <td style="width:140px"><select class="cl-proj">${projOpts(l.projectId)}</select></td>
      <td style="width:30px"><button type="button" class="rm">×</button></td>`;
    tbody.appendChild(tr);
    tr.querySelector('.rm').addEventListener('click', () => { tr.remove(); renderTotals(); });
    tr.querySelector('.cl-amount').addEventListener('input', renderTotals);
    tr.querySelector('.cl-tax').addEventListener('change', renderTotals);
  }
  claim.lines.forEach(addRow);
  main.querySelector('#cl-add').addEventListener('click', () => addRow());

  function readLines() {
    return [...tbody.querySelectorAll('tr')].map(tr => ({
      date: tr.querySelector('.cl-date').value,
      merchant: tr.querySelector('.cl-merchant').value.trim(),
      description: tr.querySelector('.cl-desc').value.trim(),
      grossCents: centsOf(tr.querySelector('.cl-amount').value),
      accountId: Number(tr.querySelector('.cl-acc').value) || null,
      taxRateId: Number(tr.querySelector('.cl-tax').value) || null,
      projectId: Number(tr.querySelector('.cl-proj').value) || null,
    })).filter(l => l.description || l.merchant || l.grossCents || l.accountId);
  }

  function renderTotals() {
    const lines = readLines();
    let total = 0, tax = 0;
    for (const l of lines) {
      total += l.grossCents;
      const rate = STATE.taxRates.find(t => t.id === l.taxRateId)?.rate || 0;
      if (rate) tax += l.grossCents - Math.round(l.grossCents / (1 + rate / 100));
    }
    document.getElementById('cl-totals').innerHTML = `
      <div class="row"><span>Includes GST</span><b>${fmtMoney(tax)}</b></div>
      <div class="row grand"><span>Total to reimburse</span><span>${fmtMoney(total)}</span></div>`;
  }
  renderTotals();

  document.getElementById('claim-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const saved = await api('claims.save', {
        id: claim.id, payee: ev.target.elements.payee.value.trim(),
        date: ev.target.elements.date.value, lines: readLines(),
      });
      toast('Expense claim saved', 'success');
      navigate('#/expense-claims/' + saved.id);
    } catch (e) { showError(e); }
  });
};

VIEWS.claimView = async function (main, params) {
  const c = await api('claims.get', { id: Number(params.id) });
  main.innerHTML = `
    <div class="page-head">
      <h1>Expense claim ${esc(c.number)}</h1>
      ${badge(c.status)}
      <div class="spacer"></div>
      ${['DRAFT', 'SUBMITTED'].includes(c.status) ? `
        <a class="btn" href="#/expense-claims/${c.id}/edit">Edit</a>
        ${c.status === 'DRAFT' ? '<button class="btn" id="btn-submit">Submit</button>' : ''}
        <button class="btn primary" id="btn-approve">Approve</button>
        <button class="btn danger" id="btn-decline">Decline</button>` : ''}
      ${c.status === 'AUTHORISED' ? `
        <button class="btn primary" id="btn-pay">Pay reimbursement</button>
        <button class="btn danger" id="btn-void">Void</button>` : ''}
      ${['DRAFT', 'SUBMITTED', 'DECLINED'].includes(c.status) ? '<button class="btn danger" id="btn-delete">Delete</button>' : ''}
    </div>
    <div class="card">
      <div class="page-sub" style="margin:0 0 12px">Claimed by <b>${esc(c.payee)}</b> on ${fmtDate(c.date)}</div>
      <table class="data">
        <thead><tr><th>Date</th><th>Merchant</th><th>Description</th><th>Account</th><th>Project</th><th class="num">GST</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${c.lines.map(l => `
            <tr>
              <td>${fmtDate(l.date)}</td><td>${esc(l.merchant)}</td><td>${esc(l.description)}</td>
              <td>${esc(l.account_name || '')}</td><td>${esc(l.project_name || '')}</td>
              <td class="num">${fmtMoney(l.tax_cents)}</td>
              <td class="num">${fmtMoney(l.gross_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div class="totals-box">
        <div class="row"><span>Includes GST</span><b>${fmtMoney(c.tax_cents)}</b></div>
        <div class="row grand"><span>Total to reimburse</span><span>${fmtMoney(c.total_cents)}</span></div>
      </div>
    </div>`;

  const $ = (id) => document.getElementById(id);
  const refresh = () => VIEWS.claimView(main, params);
  $('btn-submit')?.addEventListener('click', async () => {
    try { await api('claims.setStatus', { id: c.id, status: 'SUBMITTED' }); refresh(); } catch (e) { showError(e); }
  });
  $('btn-approve')?.addEventListener('click', async () => {
    try { await api('claims.approve', { id: c.id }); toast('Claim approved and posted', 'success'); refresh(); } catch (e) { showError(e); }
  });
  $('btn-decline')?.addEventListener('click', async () => {
    try { await api('claims.setStatus', { id: c.id, status: 'DECLINED' }); refresh(); } catch (e) { showError(e); }
  });
  $('btn-void')?.addEventListener('click', async () => {
    if (!confirm('Void this approved claim?')) return;
    try { await api('claims.void', { id: c.id }); refresh(); } catch (e) { showError(e); }
  });
  $('btn-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this claim?')) return;
    try { await api('claims.delete', { id: c.id }); navigate('#/expense-claims'); } catch (e) { showError(e); }
  });
  $('btn-pay')?.addEventListener('click', () => {
    const banks = STATE.accounts.filter(a => a.type === 'BANK');
    if (!banks.length) return toast('Create a bank account first', 'error');
    const m = modal(`
      <h2>Pay reimbursement</h2>
      <form id="pc-form">
        <div class="field-row">
          <label class="field">From bank account *
            <select name="bank">${banks.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
          </label>
          <label class="field">Date *<input type="date" name="date" required value="${today()}" /></label>
        </div>
        <p style="color:var(--ink-soft);font-size:13px">Paying <b>${fmtMoney(c.total_cents)}</b> to ${esc(c.payee)}.</p>
        <div class="btn-row">
          <button class="btn primary" type="submit">Pay</button>
          <button class="btn" type="button" id="pc-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#pc-cancel').addEventListener('click', closeModal);
    m.querySelector('#pc-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('claims.pay', { id: c.id, bankAccountId: Number(ev.target.elements.bank.value), date: ev.target.elements.date.value });
        closeModal();
        toast('Reimbursement paid', 'success');
        refresh();
      } catch (e) { showError(e); }
    });
  });
};
