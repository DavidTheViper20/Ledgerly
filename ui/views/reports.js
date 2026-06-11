'use strict';

// Reports hub and the individual financial reports.

function fyDefaults() {
  const endM = parseInt(STATE.settings.fy_end_month || '12', 10);
  const now = new Date();
  let fyEnd = new Date(Date.UTC(now.getUTCFullYear(), endM, 0));
  if (now > fyEnd) fyEnd = new Date(Date.UTC(now.getUTCFullYear() + 1, endM, 0));
  const fyStart = new Date(fyEnd);
  fyStart.setUTCFullYear(fyStart.getUTCFullYear() - 1);
  fyStart.setUTCDate(fyStart.getUTCDate() + 1);
  return { from: fyStart.toISOString().slice(0, 10), to: today() };
}

function reportToolbar({ from = null, to = null, asAt = null, extra = '' }) {
  return `<div class="btn-row no-print" style="margin-bottom:14px">
    ${from !== null ? `<label class="field" style="margin:0">From <input type="date" id="rp-from" value="${from}" /></label>` : ''}
    ${to !== null ? `<label class="field" style="margin:0">To <input type="date" id="rp-to" value="${to}" /></label>` : ''}
    ${asAt !== null ? `<label class="field" style="margin:0">As at <input type="date" id="rp-asat" value="${asAt}" /></label>` : ''}
    ${extra}
    <button class="btn primary" id="rp-update">Update</button>
    <span class="spacer" style="flex:1"></span>
    <button class="btn" id="rp-print">Print</button>
    <button class="btn" id="rp-pdf">Export PDF</button>
  </div>`;
}

function wireToolbar(rerun, pdfName) {
  document.getElementById('rp-update')?.addEventListener('click', rerun);
  document.getElementById('rp-print')?.addEventListener('click', () => window.print());
  document.getElementById('rp-pdf')?.addEventListener('click', async () => {
    const r = await window.ledgerly.exportPdf(pdfName);
    if (r.ok) toast('PDF saved to ' + r.data, 'success');
  });
}

function reportHeader(title, sub) {
  return `<div style="text-align:center;margin-bottom:14px">
    <div style="font-size:17px;font-weight:750">${esc(STATE.settings.org_name || 'Ledgerly')}</div>
    <div style="font-size:15px;font-weight:650">${esc(title)}</div>
    <div style="color:var(--ink-soft);font-size:12.5px">${esc(sub)}</div>
  </div>`;
}

VIEWS.reports = async function (main) {
  const card = (href, title, desc) => `
    <a class="card" href="${href}" style="display:block;color:inherit;text-decoration:none">
      <h2 style="color:var(--brand)">${title}</h2>
      <div style="color:var(--ink-soft);font-size:13px">${desc}</div>
    </a>`;
  main.innerHTML = `
    <div class="page-head"><h1>Reports</h1></div>
    <div class="grid cols-3">
      ${card('#/reports/profit-loss', 'Profit and Loss', 'Income, expenses and profit over a period')}
      ${card('#/reports/balance-sheet', 'Balance Sheet', 'Assets, liabilities and equity at a date')}
      ${card('#/reports/trial-balance', 'Trial Balance', 'Debit and credit balances for every account')}
      ${card('#/reports/aged-receivables', 'Aged Receivables', 'Who owes you money and how overdue it is')}
      ${card('#/reports/aged-payables', 'Aged Payables', 'Who you owe money to and when it is due')}
      ${card('#/reports/account-transactions', 'Account Transactions', 'Every ledger entry for one account')}
      ${card('#/reports/tax', 'Tax Summary', 'GST collected on sales and paid on purchases')}
      ${card('#/reports/bas', 'Activity Statement (BAS)', 'Simpler BAS labels: G1, 1A, 1B, W1, W2')}
      ${card('#/reports/cash-flow', 'Cash Flow Forecast', 'Projected bank balance from invoices and bills due')}
      ${card('#/reports/budget-variance', 'Budget vs Actual', 'Performance against your budget')}
    </div>`;
};

// ---------- Profit & Loss ----------
VIEWS.reportPL = async function (main, params) {
  const def = fyDefaults();
  const from = params.from || def.from;
  const to = params.to || def.to;
  const r = await api('reports.profitAndLoss', { from, to });

  const section = (title, rows, total, totalLabel) => `
    <tr><td colspan="2" style="font-weight:700;padding-top:14px">${title}</td></tr>
    ${rows.map(x => `<tr><td style="padding-left:22px">${esc(x.name)}</td><td class="num">${fmtMoney(x.amount_cents)}</td></tr>`).join('')}
    <tr class="subtotal"><td>${totalLabel}</td><td class="num">${fmtMoney(total)}</td></tr>`;

  main.innerHTML = `
    <div class="page-head no-print"><h1>Profit and Loss</h1></div>
    ${reportToolbar({ from, to })}
    <div class="card" style="max-width:760px;margin:0 auto">
      ${reportHeader('Profit and Loss', `For the period ${fmtDate(from)} to ${fmtDate(to)}`)}
      <table class="data">
        <tbody>
          ${section('Revenue', r.rows.revenue, r.totals.revenue_cents, 'Total Revenue')}
          ${r.rows.directCosts.length ? section('Less Direct Costs', r.rows.directCosts, r.totals.direct_costs_cents, 'Total Direct Costs') : ''}
          ${r.rows.directCosts.length ? `<tr class="subtotal"><td>Gross Profit</td><td class="num">${fmtMoney(r.totals.gross_profit_cents)}</td></tr>` : ''}
          ${section('Less Operating Expenses', r.rows.expenses, r.totals.expenses_cents, 'Total Operating Expenses')}
          <tr class="total"><td>Net Profit</td><td class="num">${fmtMoneySigned(r.totals.net_profit_cents)}</td></tr>
        </tbody>
      </table>
    </div>`;
  wireToolbar(() => navigate(`#/reports/profit-loss?from=${document.getElementById('rp-from').value}&to=${document.getElementById('rp-to').value}`), 'profit-and-loss.pdf');
};

// ---------- Balance Sheet ----------
VIEWS.reportBS = async function (main, params) {
  const asAt = params.asAt || today();
  const r = await api('reports.balanceSheet', { asAt });

  const renderGroup = (rows) => {
    const byGroup = {};
    for (const x of rows) (byGroup[x.group] ??= []).push(x);
    return Object.entries(byGroup).map(([g, xs]) => `
      <tr><td colspan="2" style="font-weight:650;padding-left:12px;color:var(--ink-soft)">${esc(g)}</td></tr>
      ${xs.map(x => `<tr><td style="padding-left:26px">${esc(x.name)}</td><td class="num">${fmtMoneySigned(x.amount_cents)}</td></tr>`).join('')}`).join('');
  };

  main.innerHTML = `
    <div class="page-head no-print"><h1>Balance Sheet</h1></div>
    ${reportToolbar({ asAt })}
    <div class="card" style="max-width:760px;margin:0 auto">
      ${reportHeader('Balance Sheet', `As at ${fmtDate(asAt)}`)}
      <table class="data">
        <tbody>
          <tr><td colspan="2" style="font-weight:700">Assets</td></tr>
          ${renderGroup(r.sections.assets)}
          <tr class="subtotal"><td>Total Assets</td><td class="num">${fmtMoney(r.totals.assets_cents)}</td></tr>
          <tr><td colspan="2" style="font-weight:700;padding-top:14px">Liabilities</td></tr>
          ${renderGroup(r.sections.liabilities)}
          <tr class="subtotal"><td>Total Liabilities</td><td class="num">${fmtMoney(r.totals.liabilities_cents)}</td></tr>
          <tr class="subtotal"><td>Net Assets</td><td class="num">${fmtMoneySigned(r.totals.assets_cents - r.totals.liabilities_cents)}</td></tr>
          <tr><td colspan="2" style="font-weight:700;padding-top:14px">Equity</td></tr>
          ${renderGroup(r.sections.equity)}
          <tr class="total"><td>Total Equity</td><td class="num">${fmtMoneySigned(r.totals.equity_cents)}</td></tr>
        </tbody>
      </table>
      ${r.totals.check_cents !== 0 ? `<p class="amount-neg">Warning: balance check off by ${fmtMoney(r.totals.check_cents)}</p>` : ''}
    </div>`;
  wireToolbar(() => navigate(`#/reports/balance-sheet?asAt=${document.getElementById('rp-asat').value}`), 'balance-sheet.pdf');
};

// ---------- Trial Balance ----------
VIEWS.reportTB = async function (main, params) {
  const asAt = params.asAt || today();
  const r = await api('reports.trialBalance', { asAt });
  main.innerHTML = `
    <div class="page-head no-print"><h1>Trial Balance</h1></div>
    ${reportToolbar({ asAt })}
    <div class="card" style="max-width:860px;margin:0 auto">
      ${reportHeader('Trial Balance', `As at ${fmtDate(asAt)}`)}
      <table class="data">
        <thead><tr><th>Account</th><th>Type</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
        <tbody>
          ${r.rows.map(x => `
            <tr><td>${esc(x.code)} ${esc(x.name)}</td><td>${esc(x.type)}</td>
            <td class="num">${x.debit_cents ? fmtMoney(x.debit_cents) : ''}</td>
            <td class="num">${x.credit_cents ? fmtMoney(x.credit_cents) : ''}</td></tr>`).join('')}
          <tr class="total"><td>Total</td><td></td>
            <td class="num">${fmtMoney(r.totals.debit_cents)}</td>
            <td class="num">${fmtMoney(r.totals.credit_cents)}</td></tr>
        </tbody>
      </table>
    </div>`;
  wireToolbar(() => navigate(`#/reports/trial-balance?asAt=${document.getElementById('rp-asat').value}`), 'trial-balance.pdf');
};

// ---------- Aged Receivables / Payables ----------
async function agedReport(main, params, kind) {
  const asAt = params.asAt || today();
  const isAR = kind === 'AR';
  const r = await api(isAR ? 'reports.agedReceivables' : 'reports.agedPayables', { asAt });
  const route = isAR ? 'aged-receivables' : 'aged-payables';
  const title = isAR ? 'Aged Receivables' : 'Aged Payables';

  main.innerHTML = `
    <div class="page-head no-print"><h1>${title}</h1></div>
    ${reportToolbar({ asAt })}
    <div class="card">
      ${reportHeader(title, `As at ${fmtDate(asAt)}`)}
      <table class="data">
        <thead><tr><th>Contact</th><th class="num">Current</th><th class="num">1–30 days</th>
          <th class="num">31–60</th><th class="num">61–90</th><th class="num">90+</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${r.rows.length === 0 ? `<tr><td colspan="7"><div class="empty">Nothing outstanding 🎉</div></td></tr>` : ''}
          ${r.rows.map(x => `
            <tr class="click" data-go="#/contacts/${x.contact_id}">
              <td>${esc(x.contact_name)}</td>
              <td class="num">${x.current ? fmtMoney(x.current) : ''}</td>
              <td class="num">${x.b1_30 ? fmtMoney(x.b1_30) : ''}</td>
              <td class="num">${x.b31_60 ? fmtMoney(x.b31_60) : ''}</td>
              <td class="num">${x.b61_90 ? fmtMoney(x.b61_90) : ''}</td>
              <td class="num">${x.b90_plus ? fmtMoney(x.b90_plus) : ''}</td>
              <td class="num"><b>${fmtMoney(x.total)}</b></td>
            </tr>`).join('')}
          <tr class="total"><td>Total</td>
            <td class="num">${fmtMoney(r.totals.current)}</td>
            <td class="num">${fmtMoney(r.totals.b1_30)}</td>
            <td class="num">${fmtMoney(r.totals.b31_60)}</td>
            <td class="num">${fmtMoney(r.totals.b61_90)}</td>
            <td class="num">${fmtMoney(r.totals.b90_plus)}</td>
            <td class="num">${fmtMoney(r.totals.total)}</td></tr>
        </tbody>
      </table>
    </div>`;
  wireToolbar(() => navigate(`#/reports/${route}?asAt=${document.getElementById('rp-asat').value}`), `${route}.pdf`);
}
VIEWS.reportAgedAR = (main, params) => agedReport(main, params, 'AR');
VIEWS.reportAgedAP = (main, params) => agedReport(main, params, 'AP');

// ---------- Account Transactions ----------
VIEWS.reportAccountTx = async function (main, params) {
  const def = fyDefaults();
  const from = params.from || def.from;
  const to = params.to || def.to;
  const accountId = params.account ? Number(params.account) : (STATE.accounts[0] && STATE.accounts[0].id);
  const acc = STATE.accounts.find(a => a.id === accountId);
  const r = accountId ? await api('reports.accountTransactions', { accountId, from, to }) : { lines: [], opening_cents: 0, closing_cents: 0 };

  main.innerHTML = `
    <div class="page-head no-print"><h1>Account Transactions</h1></div>
    ${reportToolbar({
      from, to,
      extra: `<label class="field" style="margin:0">Account
        <select id="rp-acc">${accountOptions(accountId, { blank: false })}</select></label>`,
    })}
    <div class="card">
      ${reportHeader('Account Transactions', `${acc ? acc.code + ' ' + acc.name : ''} · ${fmtDate(from)} to ${fmtDate(to)}`)}
      <table class="data">
        <thead><tr><th>Date</th><th>Description</th><th>Source</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Running</th></tr></thead>
        <tbody>
          <tr><td>${fmtDate(from)}</td><td><b>Opening balance</b></td><td></td><td></td><td></td>
            <td class="num">${fmtMoneySigned(r.opening_cents)}</td></tr>
          ${r.lines.map(l => `
            <tr class="click" data-go="#/journals/${l.journal_id}">
              <td>${fmtDate(l.date)}</td>
              <td>${esc(l.description || l.narration)}</td>
              <td>${esc(l.source_kind)}</td>
              <td class="num">${l.debit_cents ? fmtMoney(l.debit_cents) : ''}</td>
              <td class="num">${l.credit_cents ? fmtMoney(l.credit_cents) : ''}</td>
              <td class="num">${fmtMoneySigned(l.running_cents)}</td>
            </tr>`).join('')}
          <tr class="total"><td>${fmtDate(to)}</td><td>Closing balance</td><td></td><td></td><td></td>
            <td class="num">${fmtMoneySigned(r.closing_cents)}</td></tr>
        </tbody>
      </table>
    </div>`;
  wireToolbar(() => navigate(`#/reports/account-transactions?account=${document.getElementById('rp-acc').value}&from=${document.getElementById('rp-from').value}&to=${document.getElementById('rp-to').value}`), 'account-transactions.pdf');
};

// ---------- Tax Summary ----------
VIEWS.reportTax = async function (main, params) {
  const def = fyDefaults();
  const from = params.from || def.from;
  const to = params.to || def.to;
  const r = await api('reports.taxSummary', { from, to });
  main.innerHTML = `
    <div class="page-head no-print"><h1>Tax Summary</h1></div>
    ${reportToolbar({ from, to })}
    <div class="card" style="max-width:640px;margin:0 auto">
      ${reportHeader('Tax Summary', `For the period ${fmtDate(from)} to ${fmtDate(to)}`)}
      <table class="data">
        <tbody>
          <tr><td>Tax collected (on sales and money received)</td><td class="num">${fmtMoney(r.totals.collected_cents)}</td></tr>
          <tr><td>Tax paid (on purchases and money spent)</td><td class="num">${fmtMoney(r.totals.paid_cents)}</td></tr>
          <tr class="total"><td>Net tax ${r.totals.net_cents >= 0 ? 'to pay' : 'refundable'}</td>
            <td class="num">${fmtMoney(Math.abs(r.totals.net_cents))}</td></tr>
        </tbody>
      </table>
      <p style="color:var(--ink-soft);font-size:12.5px">
        Based on entries posted to the Sales Tax control account between the selected dates.
      </p>
    </div>`;
  wireToolbar(() => navigate(`#/reports/tax?from=${document.getElementById('rp-from').value}&to=${document.getElementById('rp-to').value}`), 'tax-summary.pdf');
};


// ---------- BAS ----------
VIEWS.reportBAS = async function (main, params) {
  // Default to the current quarter
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3);
  const defFrom = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1)).toISOString().slice(0, 10);
  const from = params.from || defFrom;
  const to = params.to || today();
  const r = await api('reports.bas', { from, to });
  main.innerHTML = `
    <div class="page-head no-print"><h1>Activity Statement (BAS)</h1></div>
    ${reportToolbar({ from, to })}
    <div class="card" style="max-width:680px;margin:0 auto">
      ${reportHeader('Activity Statement summary', `For the period ${fmtDate(from)} to ${fmtDate(to)} · Simpler BAS`)}
      <table class="data">
        <tbody>
          <tr><td><b>G1</b> Total sales (including GST)</td><td class="num">${fmtMoney(r.g1_total_sales_cents)}</td></tr>
          <tr><td><b>1A</b> GST on sales</td><td class="num">${fmtMoney(r.a1a_gst_on_sales_cents)}</td></tr>
          <tr><td><b>1B</b> GST on purchases</td><td class="num">${fmtMoney(r.a1b_gst_on_purchases_cents)}</td></tr>
          <tr class="subtotal"><td>Net GST ${r.net_gst_cents >= 0 ? 'payable' : 'refundable'}</td>
            <td class="num">${fmtMoney(Math.abs(r.net_gst_cents))}</td></tr>
          <tr><td><b>W1</b> Total salary and wages</td><td class="num">${fmtMoney(r.w1_gross_wages_cents)}</td></tr>
          <tr><td><b>W2</b> PAYG withheld</td><td class="num">${fmtMoney(r.w2_payg_withheld_cents)}</td></tr>
          <tr class="total"><td>Estimated amount ${r.total_obligation_cents >= 0 ? 'payable to the ATO' : 'refundable'}</td>
            <td class="num">${fmtMoney(Math.abs(r.total_obligation_cents))}</td></tr>
        </tbody>
      </table>
      <p style="color:var(--ink-soft);font-size:12.5px">
        Figures are derived from posted journals on an accruals basis. Verify against your records
        before lodging — this summary is an estimate, not a lodgeable form.
      </p>
    </div>`;
  wireToolbar(() => navigate(`#/reports/bas?from=${document.getElementById('rp-from').value}&to=${document.getElementById('rp-to').value}`), 'bas-summary.pdf');
};

// ---------- Cash flow forecast ----------
VIEWS.reportCashFlow = async function (main, params) {
  const weeks = parseInt(params.weeks, 10) || 8;
  const r = await api('reports.cashFlowForecast', { weeks });
  const maxAbs = Math.max(1, ...r.weeks.map(w => Math.abs(w.balance_cents)));
  main.innerHTML = `
    <div class="page-head no-print"><h1>Cash Flow Forecast</h1>
      <div class="spacer"></div>
      <button class="btn" id="rp-print">Print</button>
      <button class="btn" id="rp-pdf">Export PDF</button>
    </div>
    <div class="page-sub">Opening bank balance plus invoices due in, minus bills due out, week by week.</div>
    <div class="card">
      ${reportHeader('Cash Flow Forecast', `Next ${weeks} weeks · opening balance ${fmtMoney(r.opening_cents)}`)}
      <div class="chart" style="height:120px">
        ${r.weeks.map(w => `
          <div class="col">
            <div class="bars" style="height:90px">
              <div class="bar ${w.balance_cents >= 0 ? 'in' : 'out'}" title="${esc(fmtMoney(w.balance_cents))}"
                style="height:${Math.round(Math.abs(w.balance_cents) / maxAbs * 100)}%"></div>
            </div>
            <div class="mon">${esc(w.week_start.slice(5))}</div>
          </div>`).join('')}
      </div>
      <table class="data" style="margin-top:14px">
        <thead><tr><th>Week</th><th class="num">Money in (AR due)</th><th class="num">Money out (AP due)</th><th class="num">Projected balance</th></tr></thead>
        <tbody>
          ${r.weeks.map(w => `
            <tr>
              <td>${fmtDate(w.week_start)} – ${fmtDate(w.week_end)}</td>
              <td class="num">${w.in_cents ? fmtMoney(w.in_cents) : ''}</td>
              <td class="num">${w.out_cents ? fmtMoney(w.out_cents) : ''}</td>
              <td class="num">${fmtMoneySigned(w.balance_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  document.getElementById('rp-print')?.addEventListener('click', () => window.print());
  document.getElementById('rp-pdf')?.addEventListener('click', async () => {
    const res = await window.ledgerly.exportPdf('cash-flow-forecast.pdf');
    if (res.ok) toast('PDF saved to ' + res.data, 'success');
  });
};

// ---------- Budget vs Actual ----------
VIEWS.reportBudget = async function (main, params) {
  const def = fyDefaults();
  const from = params.from || def.from;
  const to = params.to || def.to;
  const r = await api('reports.budgetVsActual', { from, to });
  const section = (cls, label) => {
    const rows = r.rows.filter(x => x.class === cls);
    if (!rows.length) return '';
    return `
      <tr><td colspan="4" style="font-weight:700;padding-top:12px">${label}</td></tr>
      ${rows.map(x => `<tr>
        <td style="padding-left:22px">${esc(x.code)} ${esc(x.name)}</td>
        <td class="num">${fmtMoney(x.actual_cents)}</td>
        <td class="num">${fmtMoney(x.budget_cents)}</td>
        <td class="num">${fmtMoneySigned(x.variance_cents)}</td>
      </tr>`).join('')}`;
  };
  main.innerHTML = `
    <div class="page-head no-print"><h1>Budget vs Actual</h1>
      <div class="spacer"></div>
      <a class="btn" href="#/budgets">Edit budget</a>
    </div>
    ${reportToolbar({ from, to })}
    <div class="card" style="max-width:860px;margin:0 auto">
      ${reportHeader('Budget vs Actual', `For the period ${fmtDate(from)} to ${fmtDate(to)}`)}
      <table class="data">
        <thead><tr><th>Account</th><th class="num">Actual</th><th class="num">Budget</th><th class="num">Variance</th></tr></thead>
        <tbody>
          ${r.rows.length === 0 ? '<tr><td colspan="4"><div class="empty">No budget set — use the Budget manager</div></td></tr>' : ''}
          ${section('REVENUE', 'Income')}
          ${section('EXPENSE', 'Expenses')}
        </tbody>
      </table>
    </div>`;
  wireToolbar(() => navigate(`#/reports/budget-variance?from=${document.getElementById('rp-from').value}&to=${document.getElementById('rp-to').value}`), 'budget-vs-actual.pdf');
};

// ---------- Budget manager ----------
VIEWS.budgetManager = async function (main, params) {
  const def = fyDefaults();
  const from = (params.from || def.from).slice(0, 7);
  // 12 months from the FY start
  const months = [];
  let [y, m] = from.split('-').map(Number);
  for (let i = 0; i < 12; i++) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  const existing = await api('budgets.get', { from: months[0] + '-01', to: months[11] + '-28' });
  const byKey = {};
  for (const b of existing) byKey[b.account_id + '|' + b.month] = b.amount_cents;
  const plAccounts = STATE.accounts.filter(a => ['REVENUE', 'EXPENSE'].includes(a.class) && !a.is_archived);

  main.innerHTML = `
    <div class="page-head">
      <h1>Budget manager</h1>
      <div class="spacer"></div>
      <a class="btn" href="#/reports/budget-variance">Budget vs Actual report</a>
      <button class="btn primary" id="btn-save-budget">Save budget</button>
    </div>
    <div class="page-sub">Monthly budget for the financial year starting ${fmtDate(months[0] + '-01')}.
      Tip: type a value and press the ⇒ button on a row to copy it across the year.</div>
    <div class="card" style="overflow-x:auto">
      <table class="lines" id="budget-grid" style="min-width:1100px">
        <thead><tr><th style="min-width:200px">Account</th>
          ${months.map(mo => `<th style="text-align:right">${mo.slice(5)}/${mo.slice(2, 4)}</th>`).join('')}<th></th></tr></thead>
        <tbody>
          ${plAccounts.map(a => `
            <tr data-acc="${a.id}">
              <td style="font-size:12.5px">${esc(a.code)} ${esc(a.name)}</td>
              ${months.map(mo => `<td class="num"><input class="bg-cell" data-month="${mo}"
                value="${byKey[a.id + '|' + mo] ? dollarsOf(byKey[a.id + '|' + mo]) : ''}" /></td>`).join('')}
              <td><button type="button" class="btn small bg-fill" title="Copy first value across">⇒</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  on(main, '.bg-fill', 'click', (ev) => {
    const tr = ev.target.closest('tr');
    const cells = [...tr.querySelectorAll('.bg-cell')];
    const v = cells.find(c => c.value)?.value || '';
    cells.forEach(c => { c.value = v; });
  });

  document.getElementById('btn-save-budget').addEventListener('click', async () => {
    const rows = [];
    for (const tr of main.querySelectorAll('#budget-grid tbody tr')) {
      const accountId = Number(tr.dataset.acc);
      for (const cell of tr.querySelectorAll('.bg-cell')) {
        rows.push({ accountId, month: cell.dataset.month, amountCents: centsOf(cell.value) });
      }
    }
    try {
      await api('budgets.set', { rows });
      toast('Budget saved', 'success');
    } catch (e) { showError(e); }
  });
};
