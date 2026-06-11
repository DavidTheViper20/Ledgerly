'use strict';

// Payroll: employees and pay runs (simplified Australian payroll).

VIEWS.payroll = async function (main, params) {
  const tab = params.tab || 'runs';
  const employees = await api('payroll.employees', {});
  const runs = await api('payroll.listRuns');
  const t = (id, label) => `<a href="#/payroll?tab=${id}" class="${tab === id ? 'active' : ''}">${label}</a>`;

  main.innerHTML = `
    <div class="page-head">
      <h1>Payroll</h1>
      <div class="spacer"></div>
      <button class="btn" id="btn-new-emp">Add employee</button>
      <button class="btn primary" id="btn-new-run" ${employees.length ? '' : 'disabled title="Add employees first"'}>New pay run</button>
    </div>
    <div class="page-sub">
      PAYG is estimated from the 2025–26 resident tax rates (incl. 2% Medicare levy) and is editable per payslip.
      Super guarantee defaults to ${esc(STATE.settings.super_guarantee_pct || '12')}%.
      STP lodgement isn't included — export reports for your tax agent.
    </div>
    <div class="tabs">${t('runs', 'Pay runs')}${t('employees', 'Employees')}</div>

    ${tab === 'employees' ? `
    <div class="card">
      <table class="data">
        <thead><tr><th>Name</th><th>Email</th><th>Basis</th><th class="num">Rate</th><th class="num">Hours/week</th><th class="num">Super %</th><th></th></tr></thead>
        <tbody>
          ${employees.length === 0 ? '<tr><td colspan="7"><div class="empty">No employees yet</div></td></tr>' : ''}
          ${employees.map(e => `
            <tr>
              <td><b>${esc(e.name)}</b></td><td>${esc(e.email)}</td>
              <td>${e.pay_basis === 'SALARY' ? 'Annual salary' : 'Hourly'}</td>
              <td class="num">${fmtMoney(e.pay_rate_cents)}${e.pay_basis === 'SALARY' ? '/yr' : '/hr'}</td>
              <td class="num">${e.hours_per_week}</td>
              <td class="num">${e.super_pct}%</td>
              <td class="btn-row">
                <button class="btn small btn-edit-emp" data-id="${e.id}">Edit</button>
                <button class="btn small danger btn-arch-emp" data-id="${e.id}">Archive</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `
    <div class="card">
      <table class="data">
        <thead><tr><th>Period</th><th>Payment date</th><th>Status</th><th class="num">Gross</th><th class="num">PAYG</th><th class="num">Super</th><th class="num">Net</th></tr></thead>
        <tbody>
          ${runs.length === 0 ? '<tr><td colspan="7"><div class="empty">No pay runs yet</div></td></tr>' : ''}
          ${runs.map(r => `
            <tr class="click" data-go="#/payroll/runs/${r.id}">
              <td>${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}</td>
              <td>${fmtDate(r.payment_date)}</td>
              <td>${badge(r.status === 'POSTED' ? (r.paid_journal_id ? 'PAID' : 'AUTHORISED') : 'DRAFT')}</td>
              <td class="num">${fmtMoney(r.totals.gross_cents)}</td>
              <td class="num">${fmtMoney(r.totals.tax_cents)}</td>
              <td class="num">${fmtMoney(r.totals.super_cents)}</td>
              <td class="num"><b>${fmtMoney(r.totals.net_cents)}</b></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`}`;

  function empModal(e) {
    const x = e || { pay_basis: 'SALARY', hours_per_week: 38, super_pct: STATE.settings.super_guarantee_pct || 12 };
    const m = modal(`
      <h2>${e ? 'Edit employee' : 'Add employee'}</h2>
      <form id="emp-form">
        <div class="field-row">
          <label class="field">Name *<input name="name" required value="${esc(x.name || '')}" /></label>
          <label class="field">Email<input name="email" value="${esc(x.email || '')}" /></label>
        </div>
        <div class="field-row">
          <label class="field">Pay basis
            <select name="basis">
              <option value="SALARY" ${x.pay_basis === 'SALARY' ? 'selected' : ''}>Annual salary</option>
              <option value="HOURLY" ${x.pay_basis === 'HOURLY' ? 'selected' : ''}>Hourly rate</option>
            </select>
          </label>
          <label class="field">Rate *<input name="rate" required value="${x.pay_rate_cents ? dollarsOf(x.pay_rate_cents) : ''}" placeholder="annual $ or hourly $" /></label>
          <label class="field">Hours per week<input name="hours" value="${x.hours_per_week}" /></label>
          <label class="field">Super %<input name="super" value="${x.super_pct}" /></label>
        </div>
        <div class="btn-row">
          <button class="btn primary" type="submit">Save employee</button>
          <button class="btn" type="button" id="emp-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#emp-cancel').addEventListener('click', closeModal);
    m.querySelector('#emp-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api('payroll.saveEmployee', {
          id: x.id, name: f.elements.name.value.trim(), email: f.elements.email.value.trim(),
          payBasis: f.elements.basis.value, payRateCents: centsOf(f.elements.rate.value),
          hoursPerWeek: parseFloat(f.elements.hours.value) || 38,
          superPct: parseFloat(f.elements.super.value),
        });
        closeModal();
        toast('Employee saved', 'success');
        VIEWS.payroll(main, { tab: 'employees' });
      } catch (e2) { showError(e2); }
    });
  }

  document.getElementById('btn-new-emp').addEventListener('click', () => empModal(null));
  on(main, '.btn-edit-emp', 'click', (ev) => empModal(employees.find(e => e.id == ev.target.dataset.id)));
  on(main, '.btn-arch-emp', 'click', async (ev) => {
    if (!confirm('Archive this employee? They will be excluded from new pay runs.')) return;
    try { await api('payroll.archiveEmployee', { id: Number(ev.target.dataset.id) }); VIEWS.payroll(main, { tab: 'employees' }); } catch (e) { showError(e); }
  });

  document.getElementById('btn-new-run').addEventListener('click', () => {
    const start = new Date(); start.setDate(start.getDate() - 13);
    const m = modal(`
      <h2>New pay run</h2>
      <form id="run-form">
        <div class="field-row">
          <label class="field">Period start *<input type="date" name="start" required value="${start.toISOString().slice(0, 10)}" /></label>
          <label class="field">Period end *<input type="date" name="end" required value="${today()}" /></label>
          <label class="field">Payment date *<input type="date" name="pay" required value="${today()}" /></label>
        </div>
        <p style="color:var(--ink-soft);font-size:13px">Creates a draft run with calculated payslips for all ${employees.length} active employee(s).</p>
        <div class="btn-row">
          <button class="btn primary" type="submit">Create draft run</button>
          <button class="btn" type="button" id="run-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#run-cancel').addEventListener('click', closeModal);
    m.querySelector('#run-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const run = await api('payroll.createRun', {
          periodStart: f.elements.start.value, periodEnd: f.elements.end.value, paymentDate: f.elements.pay.value,
        });
        closeModal();
        navigate('#/payroll/runs/' + run.id);
      } catch (e) { showError(e); }
    });
  });
};

VIEWS.payRunView = async function (main, params) {
  const run = await api('payroll.getRun', { id: Number(params.id) });
  const isDraft = run.status === 'DRAFT';

  main.innerHTML = `
    <div class="page-head">
      <h1>Pay run ${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}</h1>
      ${badge(run.status === 'POSTED' ? (run.paid_journal_id ? 'PAID' : 'AUTHORISED') : 'DRAFT')}
      <div class="spacer"></div>
      ${isDraft ? `<button class="btn primary" id="btn-post">Post pay run</button>
        <button class="btn danger" id="btn-delete">Delete</button>` : ''}
      ${run.status === 'POSTED' && !run.paid_journal_id ? `<button class="btn primary" id="btn-pay">Pay wages</button>
        <button class="btn danger" id="btn-delete">Void &amp; delete</button>` : ''}
      <a class="btn" href="#/payroll">Back</a>
    </div>
    <div class="page-sub">Payment date ${fmtDate(run.payment_date)}.
      ${isDraft ? 'Click an amount to adjust it before posting.' : ''}</div>

    <div class="card">
      <table class="data">
        <thead><tr><th>Employee</th><th class="num">Hours</th><th class="num">Gross</th>
          <th class="num">PAYG (est.)</th><th class="num">Super</th><th class="num">Net pay</th></tr></thead>
        <tbody>
          ${run.payslips.map(ps => `
            <tr ${isDraft ? `class="click slip" data-id="${ps.id}" title="Adjust payslip"` : ''}>
              <td><b>${esc(ps.employee_name)}</b></td>
              <td class="num">${ps.hours != null ? ps.hours.toFixed(1) : ''}</td>
              <td class="num">${fmtMoney(ps.gross_cents)}</td>
              <td class="num">${fmtMoney(ps.tax_cents)}</td>
              <td class="num">${fmtMoney(ps.super_cents)}</td>
              <td class="num"><b>${fmtMoney(ps.net_cents)}</b></td>
            </tr>`).join('')}
          <tr class="total">
            <td>Total</td><td></td>
            <td class="num">${fmtMoney(run.totals.gross_cents)}</td>
            <td class="num">${fmtMoney(run.totals.tax_cents)}</td>
            <td class="num">${fmtMoney(run.totals.super_cents)}</td>
            <td class="num">${fmtMoney(run.totals.net_cents)}</td>
          </tr>
        </tbody>
      </table>
      <p style="color:var(--ink-soft);font-size:12.5px;margin-bottom:0">
        Posting debits Salaries &amp; Wages and Superannuation, and credits PAYG Withholding Payable,
        Superannuation Payable and Wages Payable. Pay PAYG/super later with spend-money coded to those accounts.
      </p>
    </div>`;

  const refresh = () => VIEWS.payRunView(main, params);

  on(main, '.slip', 'click', (ev) => {
    const ps = run.payslips.find(x => x.id == ev.target.closest('tr').dataset.id);
    const m = modal(`
      <h2>Adjust payslip — ${esc(ps.employee_name)}</h2>
      <form id="slip-form">
        <div class="field-row">
          <label class="field">Gross<input name="gross" value="${dollarsOf(ps.gross_cents)}" /></label>
          <label class="field">PAYG withheld<input name="tax" value="${dollarsOf(ps.tax_cents)}" /></label>
          <label class="field">Super<input name="super" value="${dollarsOf(ps.super_cents)}" /></label>
        </div>
        <div class="btn-row">
          <button class="btn primary" type="submit">Save</button>
          <button class="btn" type="button" id="slip-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#slip-cancel').addEventListener('click', closeModal);
    m.querySelector('#slip-form').addEventListener('submit', async (ev2) => {
      ev2.preventDefault();
      const f = ev2.target;
      try {
        await api('payroll.updatePayslip', {
          id: ps.id, grossCents: centsOf(f.elements.gross.value),
          taxCents: centsOf(f.elements.tax.value), superCents: centsOf(f.elements.super.value),
        });
        closeModal();
        refresh();
      } catch (e) { showError(e); }
    });
  });

  document.getElementById('btn-post')?.addEventListener('click', async () => {
    if (!confirm('Post this pay run to the ledger?')) return;
    try { await api('payroll.postRun', { id: run.id }); toast('Pay run posted', 'success'); refresh(); } catch (e) { showError(e); }
  });
  document.getElementById('btn-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this pay run?' + (run.status === 'POSTED' ? ' Its ledger entry will be voided.' : ''))) return;
    try { await api('payroll.deleteRun', { id: run.id }); navigate('#/payroll'); } catch (e) { showError(e); }
  });
  document.getElementById('btn-pay')?.addEventListener('click', () => {
    const banks = STATE.accounts.filter(a => a.type === 'BANK');
    if (!banks.length) return toast('Create a bank account first', 'error');
    const m = modal(`
      <h2>Pay net wages</h2>
      <form id="pw-form">
        <div class="field-row">
          <label class="field">From bank account *
            <select name="bank">${banks.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
          </label>
          <label class="field">Date *<input type="date" name="date" required value="${run.payment_date}" /></label>
        </div>
        <p style="color:var(--ink-soft);font-size:13px">Paying net wages of <b>${fmtMoney(run.totals.net_cents)}</b>.</p>
        <div class="btn-row">
          <button class="btn primary" type="submit">Pay wages</button>
          <button class="btn" type="button" id="pw-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#pw-cancel').addEventListener('click', closeModal);
    m.querySelector('#pw-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('payroll.payWages', { id: run.id, bankAccountId: Number(ev.target.elements.bank.value), date: ev.target.elements.date.value });
        closeModal();
        toast('Wages paid', 'success');
        refresh();
      } catch (e) { showError(e); }
    });
  });
};
