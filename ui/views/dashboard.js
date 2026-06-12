'use strict';

VIEWS.dashboard = async function (main) {
  const d = await api('dashboard.data');
  const maxFlow = Math.max(1, ...d.cash.map(m => Math.max(m.in_cents, m.out_cents)));

  main.innerHTML = `
    <div class="page-head">
      <h1>Dashboard</h1>
      <div class="spacer"></div>
      <a class="btn primary" href="#/invoices/new">New invoice</a>
      <a class="btn" href="#/bills/new">New bill</a>
    </div>

    <div class="stat-row">
      <div class="stat" data-go="#/invoices?tab=DRAFT">
        <div class="label">Draft invoices</div>
        <div class="value">${fmtMoney(d.invoices.draft_cents)}</div>
        <div class="sub">${d.invoices.draft_count} invoice${d.invoices.draft_count === 1 ? '' : 's'}</div>
      </div>
      <div class="stat" data-go="#/invoices?tab=AUTHORISED">
        <div class="label">Invoices awaiting payment</div>
        <div class="value">${fmtMoney(d.invoices.awaiting_cents)}</div>
        <div class="sub">${d.invoices.awaiting_count} invoice${d.invoices.awaiting_count === 1 ? '' : 's'}</div>
      </div>
      <div class="stat" data-go="#/invoices?tab=OVERDUE">
        <div class="label">Overdue invoices</div>
        <div class="value ${d.invoices.overdue_cents > 0 ? 'amount-neg' : ''}">${fmtMoney(d.invoices.overdue_cents)}</div>
        <div class="sub">${d.invoices.overdue_count} overdue</div>
      </div>
      <div class="stat" data-go="#/bills?tab=AUTHORISED">
        <div class="label">Bills to pay</div>
        <div class="value">${fmtMoney(d.bills.awaiting_cents)}</div>
        <div class="sub">${d.bills.awaiting_count} bill${d.bills.awaiting_count === 1 ? '' : 's'}</div>
      </div>
      <div class="stat" data-go="#/bills?tab=OVERDUE">
        <div class="label">Overdue bills</div>
        <div class="value ${d.bills.overdue_cents > 0 ? 'amount-neg' : ''}">${fmtMoney(d.bills.overdue_cents)}</div>
        <div class="sub">${d.bills.overdue_count} overdue</div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card">
        <h2>Bank accounts</h2>
        ${d.banks.length === 0 ? `<div class="empty">No bank accounts yet. <a href="#/bank">Add one</a> to start reconciling.</div>` : ''}
        ${d.banks.map(b => `
          <div class="bank-card">
            <div>
              <a href="#/bank/${b.id}"><b>${esc(b.name)}</b></a>
              <div class="sub" style="font-size:12px;color:var(--ink-soft)">
                ${b.unreconciled > 0
                  ? `<a href="#/bank/${b.id}/reconcile">${b.unreconciled} item${b.unreconciled === 1 ? '' : 's'} to reconcile</a>`
                  : 'Fully reconciled'}
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-weight:700">${fmtMoney(b.balance_cents)}</div>
              <div style="font-size:12px;color:var(--ink-soft)">Statement: ${fmtMoney(b.statement_balance_cents)}</div>
            </div>
          </div>`).join('')}
      </div>

      <div class="card">
        <h2>Cash in and out (last 6 months)</h2>
        <div class="chart">
          ${d.cash.map(m => `
            <div class="col">
              <div class="bars">
                <div class="bar in" title="In ${esc(fmtMoney(m.in_cents))}" style="height:${Math.round(m.in_cents / maxFlow * 100)}%"></div>
                <div class="bar out" title="Out ${esc(fmtMoney(m.out_cents))}" style="height:${Math.round(m.out_cents / maxFlow * 100)}%"></div>
              </div>
              <div class="mon">${esc(m.month.slice(5))}/${esc(m.month.slice(2, 4))}</div>
            </div>`).join('')}
        </div>
        <div class="legend">
          <span><span class="sw" style="background:var(--brand)"></span>Money in</span>
          <span><span class="sw" style="background:var(--accent)"></span>Money out</span>
        </div>
      </div>
    </div>
  `;
};

// ---------- first-run setup wizard ----------
VIEWS.setup = async function (main, params = {}) {
  // Two modes: the mandatory first-run setup (no complete org yet), and
  // "add another organisation" reached from Settings — which keeps the
  // current org untouched until the form is submitted, so Back is safe.
  const addingNew = params.new === '1' && (STATE.settings.setup_complete || '0') === '1';
  const s = addingNew ? {} : STATE.settings;
  const e = (v) => esc(v || '');
  main.innerHTML = `
    <div class="setup-wrap">
      <div class="logo-big">Ledgerly</div>
      <div class="card">
        <h2>${addingNew ? 'Create a new organisation' : 'Set up your organisation'}</h2>
        <form id="setup-form">
          <label class="field">Organisation name
            <input name="org_name" required value="${e(s.org_name)}" placeholder="e.g. Viper Design Studio" />
          </label>
          <div class="field-row">
            <label class="field">Base currency
              <select name="base_currency">
                ${['AUD', 'USD', 'GBP', 'EUR', 'NZD', 'CAD', 'ZAR', 'SGD'].map(c =>
                  `<option ${c === (s.base_currency || 'AUD') ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </label>
            <label class="field">Financial year end
              <select name="fy_end_month">
                ${['January','February','March','April','May','June','July','August','September','October','November','December']
                  .map((m, i) => `<option value="${i + 1}" ${String(i + 1) === (s.fy_end_month || '6') ? 'selected' : ''}>${m}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="field-row">
            <label class="field">ABN (optional)
              <input name="org_tax_number" value="${e(s.org_tax_number)}" placeholder="51 824 753 556" />
            </label>
            <label class="field">Email (optional)
              <input name="org_email" value="${e(s.org_email)}" />
            </label>
          </div>
          <p style="color:var(--ink-soft);font-size:12.5px">
            Set up for Australia: 10% GST tax rates, financial year ending 30 June, BAS reporting
            and a standard chart of accounts are ready to go. Everything can be changed later in Settings.
          </p>
          <div class="btn-row">
            <button class="btn primary" type="submit">${addingNew ? 'Create organisation' : 'Start using Ledgerly'}</button>
            ${addingNew ? '<button class="btn" type="button" id="setup-back">← Back</button>' : ''}
          </div>
        </form>
      </div>
    </div>`;

  document.getElementById('setup-back')?.addEventListener('click', () => { location.hash = '#/settings'; });

  document.getElementById('setup-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const kv = Object.fromEntries(f.entries());
    if (!kv.org_name.trim()) return toast('Organisation name is required', 'error');
    kv.fy_end_day = kv.fy_end_month === '2' ? '28' : ['4', '6', '9', '11'].includes(kv.fy_end_month) ? '30' : '31';
    try {
      if (addingNew) {
        // Creates a fresh database, switches to it, and reloads into it.
        await window.ledgerly.orgs('create', { settings: kv });
        location.hash = '#/dashboard';
        location.reload();
        return;
      }
      kv.setup_complete = '1';
      await api('settings.update', kv);
      toast('Welcome to Ledgerly!', 'success');
      navigate('#/dashboard');
    } catch (e) { showError(e); }
  });
};
