'use strict';

// Tax section: Xero-style Activity Statements inbox, Taxable Payments Annual
// Report (TPAR) and in-section tax settings — built on top of the existing
// BAS report logic (reports.bas / basSummary).

function periodLabel(periodStart, periodEnd) {
  // gst_period supersedes bas_cycle (Pass D1); fall back for orgs mid-migration
  // or on very old settings snapshots — mirrors tax.js gstPeriodSetting().
  const period = STATE.settings.gst_period || (STATE.settings.bas_cycle === 'monthly' ? 'monthly' : 'quarterly');
  const cycle = period === 'monthly' ? 'monthly' : period === 'annually' ? 'annually' : 'quarterly';
  if (cycle === 'monthly') {
    const d = new Date(periodStart + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  if (cycle === 'annually') {
    return `FY ending ${fmtDate(periodEnd)} · ${fmtDate(periodStart)} – ${fmtDate(periodEnd)}`;
  }
  // Quarterly: label with the financial year the period falls in and the FY quarter number.
  const endM = parseInt(STATE.settings.fy_end_month || '6', 10);
  const end = new Date(periodEnd + 'T00:00:00');
  // FY "ends" in endM; the FY is named after the calendar year its end falls in.
  let fyYear = end.getUTCFullYear ? end.getFullYear() : end.getFullYear();
  if (end.getMonth() + 1 > endM) fyYear += 1;
  const start = new Date(periodStart + 'T00:00:00');
  const monthsSinceFyStart = (start.getFullYear() - (fyYear - 1)) * 12 + (start.getMonth() - endM);
  const qNum = (((monthsSinceFyStart % 12) + 12) % 12) / 3 + 1;
  return `Q${qNum} FY${String(fyYear).slice(-2)} · ${fmtDate(periodStart)} – ${fmtDate(periodEnd)}`;
}

// IAS rows are labelled "IAS <Month Year>" (they're always a single month);
// BAS rows keep the quarter/month/annual labelling from periodLabel().
function statementLabel(s) {
  if (s.type === 'IAS') {
    const d = new Date(s.periodStart + 'T00:00:00');
    return `IAS ${d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
  }
  return periodLabel(s.periodStart, s.periodEnd);
}

// Small type badge distinguishing BAS from IAS in the inbox.
function typeBadge(type) {
  const t = type === 'IAS' ? 'IAS' : 'BAS';
  const bg = t === 'IAS' ? '#eef2ff' : '#ecfeff';
  const fg = t === 'IAS' ? '#4338ca' : '#0e7490';
  return `<span style="display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.03em;
    padding:1px 6px;border-radius:5px;background:${bg};color:${fg};margin-right:6px">${t}</span>`;
}

function statementRow(s, { isCompleted }) {
  const label = statementLabel(s);
  const amountLabel = s.netPayableCents >= 0 ? 'Payable' : 'Refund';
  const amountCls = s.netPayableCents >= 0 ? '' : 'amount-pos';
  const typeParam = s.type === 'IAS' ? '&type=IAS' : '';
  const viewHref = `#/tax/statement?from=${s.periodStart}&to=${s.periodEnd}${typeParam}`;
  return `
    <div class="bank-card" data-period-start="${s.periodStart}" data-period-end="${s.periodEnd}" ${s.id ? `data-id="${s.id}"` : ''}>
      <div>
        <a href="${viewHref}">${typeBadge(s.type)}<b>${esc(label)}</b></a>
        <div class="sub" style="font-size:12px;color:var(--ink-soft)">
          ${isCompleted
            ? `Lodged ${fmtDate((s.lodgedAt || '').slice(0, 10))}`
            : `Due ${fmtDate(s.dueDate)} ${s.overdue ? badge('OVERDUE') : ''}`}
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:700" class="${amountCls}">${fmtMoney(Math.abs(s.netPayableCents))}</div>
        <div style="font-size:12px;color:var(--ink-soft)">${amountLabel}</div>
      </div>
      <div class="btn-row" style="margin-left:14px">
        <a class="btn small" href="${viewHref}">View</a>
        ${isCompleted
          ? `<button class="btn small danger btn-tax-unlodge" data-id="${s.id}">Unlodge</button>`
          : `<button class="btn small primary btn-tax-lodge" data-from="${s.periodStart}" data-to="${s.periodEnd}" data-type="${s.type || 'BAS'}">Mark as lodged</button>`}
      </div>
    </div>`;
}

function taxTabs(active) {
  const t = (id, label, href) => `<a href="${href}" class="${active === id ? 'active' : ''}">${label}</a>`;
  return `<div class="tabs">
    ${t('statements', 'Activity statements', '#/tax')}
    ${t('tpar', 'Taxable payments (TPAR)', '#/tax?tab=tpar')}
    ${t('settings', 'Tax settings', '#/tax?tab=settings')}
  </div>`;
}

VIEWS.tax = async function (main, params) {
  const tab = (params && params.tab) || 'statements';
  if (tab === 'tpar') return renderTpar(main, params);
  if (tab === 'settings') return renderTaxSettings(main);
  return renderActivityStatements(main);
};

async function renderActivityStatements(main) {
  const r = await api('tax.statements');
  const s = await api('settings.all');
  const isCash = s.gst_method === 'cash';
  const basisSub = isCash
    ? 'Figures are cash-basis, derived from payments (GST is reported in the period you receive or make payment).'
    : 'Figures are accruals-basis, derived from your posted journals (Simpler BAS labels).';
  const currentLabel = r.current ? statementLabel(r.current) : '';

  main.innerHTML = `
    <div class="page-head"><h1>Tax</h1></div>
    ${taxTabs('statements')}
    <div class="page-sub">
      ${basisSub}
    </div>

    ${r.current ? `
    <div class="card">
      <h2>In progress</h2>
      <div class="bank-card" data-period-start="${r.current.periodStart}" data-period-end="${r.current.periodEnd}">
        <div>
          ${typeBadge(r.current.type)}<b>${esc(currentLabel)}</b>
          <div class="sub" style="font-size:12px;color:var(--ink-soft)">Due ${fmtDate(r.current.dueDate)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:700">${fmtMoney(Math.abs(r.current.netPayableCents))}</div>
          <div style="font-size:12px;color:var(--ink-soft)">${r.current.netPayableCents >= 0 ? 'Payable so far' : 'Refund so far'}</div>
        </div>
        <div class="btn-row" style="margin-left:14px">
          <a class="btn small" href="#/tax/statement?from=${r.current.periodStart}&to=${r.current.periodEnd}${r.current.type === 'IAS' ? '&type=IAS' : ''}">View</a>
        </div>
      </div>
    </div>` : ''}

    <div class="card">
      <h2>Needs attention</h2>
      ${r.needsAttention.length === 0
        ? `<div class="empty">You're up to date<div style="margin-top:4px;font-size:12.5px">Statements appear here after a BAS period ends.</div></div>`
        : r.needsAttention.map(s => statementRow(s, { isCompleted: false })).join('')}
    </div>

    <div class="card">
      <h2>Completed</h2>
      ${r.completed.length === 0
        ? `<div class="empty">No activity statements lodged</div>`
        : r.completed.map(s => statementRow(s, { isCompleted: true })).join('')}
    </div>`;

  on(main, '.btn-tax-lodge', 'click', async (ev) => {
    const { from, to, type } = ev.currentTarget.dataset;
    try {
      await api('tax.markLodged', { from, to, type });
      toast('Activity statement marked as lodged', 'success');
      renderActivityStatements(main);
    } catch (e) { showError(e); }
  });

  on(main, '.btn-tax-unlodge', 'click', async (ev) => {
    if (!confirm('Unlodge this activity statement? It will move back to Needs attention.')) return;
    try {
      await api('tax.unlodge', { id: Number(ev.currentTarget.dataset.id) });
      toast('Activity statement unlodged', 'success');
      renderActivityStatements(main);
    } catch (e) { showError(e); }
  });
}

// ---------- Taxable Payments Annual Report ----------

async function renderTpar(main, params) {
  const fyEnds = await api('tax.recentFyEnds', {});
  const fyEnd = (params && params.fyEnd) || fyEnds[0];
  const r = await api('tax.tpar', { fyEnd });

  main.innerHTML = `
    <div class="page-head"><h1>Tax</h1></div>
    ${taxTabs('tpar')}
    <div class="page-sub">
      Payments made to contractors for services during a financial year, for the Taxable Payments Annual Report.
    </div>

    <div class="btn-row no-print" style="margin-bottom:14px">
      <label class="field" style="margin:0">Financial year
        <select id="tpar-fy">
          ${fyEnds.map(fe => `<option value="${fe}" ${fe === fyEnd ? 'selected' : ''}>FY ${fmtDate(fe)}</option>`).join('')}
        </select>
      </label>
    </div>

    <div class="card">
      <h2>Taxable Payments Annual Report — FY ending ${fmtDate(r.fyEnd)}</h2>
      ${r.contacts.length === 0 ? `<div class="empty">No contractor payments recorded for this year.</div>` : `
      <table class="data">
        <thead><tr><th>Contractor</th><th>ABN</th><th class="num">Gross paid</th><th class="num">GST</th></tr></thead>
        <tbody>
          ${r.contacts.map(c => `
            <tr>
              <td><b>${esc(c.name)}</b>${c.address ? `<div style="font-size:11.5px;color:var(--ink-soft)">${esc(c.address)}</div>` : ''}</td>
              <td>${esc(c.abn || '—')}</td>
              <td class="num">${fmtMoney(c.totalPaidCents)}</td>
              <td class="num">${fmtMoney(c.gstCents)}</td>
            </tr>`).join('')}
          <tr class="total">
            <td colspan="2">Total</td>
            <td class="num">${fmtMoney(r.totals.totalPaidCents)}</td>
            <td class="num">${fmtMoney(r.totals.gstCents)}</td>
          </tr>
        </tbody>
      </table>`}
      <p style="color:var(--ink-soft);font-size:12.5px;margin-bottom:0">
        TPAR covers payments to contractors for services. GST is apportioned pro-rata from each bill and is an
        approximation. Review against ATO TPAR rules and lodge via ATO Online Services — Ledgerly does not lodge
        electronically yet.
      </p>
    </div>`;

  document.getElementById('tpar-fy').addEventListener('change', (ev) => {
    navigate(`#/tax?tab=tpar&fyEnd=${ev.target.value}`);
  });
}

// ---------- Tax settings ----------
// Grouped BAS/GST setup workflow (Pass D1 — see docs/superpowers/plans/
// 2026-07-03-xero-ia-product-plan.md §4). Each section saves independently
// via settings.update, following the existing form/save/toast convention
// used elsewhere (see ui/views/settings.js).

function radioField(name, value, checked, label, sub, disabled) {
  return `
    <label class="checkbox" style="align-items:flex-start">
      <input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} style="margin-top:2px" />
      <span>
        <div>${label}</div>
        ${sub ? `<div style="font-size:12px;color:var(--ink-soft);font-weight:400">${sub}</div>` : ''}
      </span>
    </label>`;
}

async function renderTaxSettings(main) {
  const s = STATE.settings;
  // gst_period supersedes bas_cycle; fall back for orgs mid-migration so the
  // UI never shows a blank selection (mirrors tax.js gstPeriodSetting()).
  const gstPeriod = s.gst_period || (s.bas_cycle === 'monthly' ? 'monthly' : 'quarterly');
  const formType = s.bas_form_type === 'full' ? 'full' : 'simpler';
  const gstMethod = s.gst_method === 'cash' ? 'cash' : 'accruals';
  const whPeriod = s.payg_wh_period || 'quarterly';
  const itMethod = s.payg_it_method || 'none';

  main.innerHTML = `
    <div class="page-head"><h1>Tax</h1></div>
    ${taxTabs('settings')}
    <div class="page-sub">Settings that affect how activity statements and tax reports are calculated.</div>

    <div class="card" style="max-width:640px">
      <h2>Goods and services tax (GST)</h2>
      <form id="gst-settings-form">
        <label class="field" style="margin-bottom:6px">BAS form type</label>
        ${radioField('bas_form_type', 'simpler', formType === 'simpler', 'Simpler BAS',
          'G1, 1A and 1B only — suits most small businesses (default).')}
        ${radioField('bas_form_type', 'full', formType === 'full', 'Full BAS',
          'Adds G2, G3, G10 and G11 sales/purchase breakdown labels.')}

        <label class="field" style="margin-top:14px">GST calculation period
          <select name="gst_period">
            <option value="monthly" ${gstPeriod === 'monthly' ? 'selected' : ''}>Monthly</option>
            <option value="quarterly" ${gstPeriod === 'quarterly' ? 'selected' : ''}>Quarterly</option>
            <option value="annually" ${gstPeriod === 'annually' ? 'selected' : ''}>Annually</option>
          </select>
          <div style="font-size:12px;color:var(--ink-soft);margin-top:3px;font-weight:400">
            How often activity statements are generated.
          </div>
        </label>

        <label class="field" style="margin:14px 0 6px">GST accounting method</label>
        ${radioField('gst_method', 'accruals', gstMethod === 'accruals', 'Accruals',
          'GST is recognised when invoices and bills are approved, not when paid (default).')}
        ${radioField('gst_method', 'cash', gstMethod === 'cash',
          'Cash', 'GST is recognised when you receive or make payment.')}
        <div style="font-size:12px;color:var(--ink-soft);margin:2px 0 0 26px;font-weight:400">
          Cash: GST is reported in the period you receive or make payment. Accruals: in the period you issue or receive the invoice.
        </div>

        <button class="btn primary" type="submit" style="margin-top:8px">Save GST settings</button>
      </form>
    </div>

    <div class="card" style="max-width:640px">
      <h2>PAYG withholding</h2>
      <form id="payg-wh-form">
        <label class="field">Withholding period
          <select name="payg_wh_period">
            <option value="none" ${whPeriod === 'none' ? 'selected' : ''}>None — I don't withhold PAYG</option>
            <option value="quarterly" ${whPeriod === 'quarterly' ? 'selected' : ''}>Quarterly</option>
            <option value="monthly" ${whPeriod === 'monthly' ? 'selected' : ''}>Monthly</option>
          </select>
          <div style="font-size:12px;color:var(--ink-soft);margin-top:3px;font-weight:400">
            Controls whether W1/W2 labels appear on activity statements. Monthly withholding with a
            quarterly or annual GST period generates a separate monthly IAS (PAYG withholding only) in
            the statement inbox for the months that don't coincide with a BAS.
          </div>
        </label>
        <button class="btn primary" type="submit">Save PAYG withholding</button>
      </form>
    </div>

    <div class="card" style="max-width:640px">
      <h2>PAYG income tax</h2>
      <form id="payg-it-form">
        <label class="field" style="margin-bottom:6px">Instalment method</label>
        ${radioField('payg_it_method', 'none', itMethod === 'none', 'None', 'No PAYG income tax instalments (default).')}
        ${radioField('payg_it_method', 'option1', itMethod === 'option1', 'Option 1 — ATO instalment amount',
          'Pay the fixed amount the ATO calculates for you (label 5A).')}
        <div id="payg-it-amount-wrap" style="margin:4px 0 10px 26px;${itMethod === 'option1' ? '' : 'display:none'}">
          <label class="field">Instalment amount<input name="payg_instalment_amount_cents" id="payg-it-amount"
            value="${esc((parseInt(s.payg_instalment_amount_cents || '0', 10) / 100).toFixed(2))}"
            placeholder="0.00" /></label>
        </div>
        ${radioField('payg_it_method', 'option2', itMethod === 'option2', 'Option 2 — calculate using income × rate',
          'Apply an ATO-advised rate to this period’s GST-exclusive sales income (5A = T1 × T2).')}
        <div id="payg-it-rate-wrap" style="margin:4px 0 10px 26px;${itMethod === 'option2' ? '' : 'display:none'}">
          <label class="field">Instalment rate %<input name="payg_instalment_rate_pct" id="payg-it-rate"
            value="${esc(s.payg_instalment_rate_pct || '0')}" placeholder="0.00" /></label>
        </div>
        <button class="btn primary" type="submit">Save PAYG income tax</button>
      </form>
    </div>

    <div class="card" style="max-width:640px">
      <h2>Other obligations</h2>
      <p style="color:var(--ink-soft);font-size:12.5px;margin-top:0">
        Turning these on surfaces the label rows on Full BAS statements for manual entry at lodgement.
        Ledgerly doesn't calculate these amounts automatically yet.
      </p>
      <form id="obligations-form">
        <label class="checkbox"><input type="checkbox" name="obligation_ftc" ${s.obligation_ftc === '1' ? 'checked' : ''} /> Fuel tax credits</label>
        <label class="checkbox"><input type="checkbox" name="obligation_wet" ${s.obligation_wet === '1' ? 'checked' : ''} /> Wine equalisation tax</label>
        <label class="checkbox"><input type="checkbox" name="obligation_lct" ${s.obligation_lct === '1' ? 'checked' : ''} /> Luxury car tax</label>
        <label class="checkbox"><input type="checkbox" name="obligation_fbt" ${s.obligation_fbt === '1' ? 'checked' : ''} /> Fringe benefits tax</label>
        <button class="btn primary" type="submit" style="margin-top:8px">Save obligations</button>
      </form>
    </div>

    <div class="card" style="max-width:640px">
      <h2>Other settings</h2>
      <form id="tax-settings-form">
        <label class="field">Tax label<input name="tax_label" value="${esc(s.tax_label)}" placeholder="e.g. GST" /></label>
        <label class="field">Financial year end
          <input value="${esc(String(s.fy_end_day || '30'))}/${esc(String(s.fy_end_month || '6'))}" disabled />
          <div style="font-size:12px;color:var(--ink-soft);margin-top:3px">
            Change this in <a href="#/settings">Organisation settings</a>.
          </div>
        </label>
        <button class="btn primary" type="submit">Save</button>
      </form>
    </div>`;

  function moneyToCents(str) {
    const n = parseFloat(String(str || '0').replace(/[^0-9.\-]/g, ''));
    return Math.round((Number.isFinite(n) ? n : 0) * 100);
  }

  document.getElementById('gst-settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(ev.target).entries());
      await api('settings.update', data);
      toast('GST settings saved', 'success');
      await loadRefData();
      renderTaxSettings(main);
    } catch (e) { showError(e); }
  });

  document.getElementById('payg-wh-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('settings.update', Object.fromEntries(new FormData(ev.target).entries()));
      toast('PAYG withholding settings saved', 'success');
      await loadRefData();
      renderTaxSettings(main);
    } catch (e) { showError(e); }
  });

  document.getElementById('payg-it-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const form = new FormData(ev.target);
      await api('settings.update', {
        payg_it_method: form.get('payg_it_method'),
        payg_instalment_amount_cents: String(moneyToCents(document.getElementById('payg-it-amount').value)),
        payg_instalment_rate_pct: document.getElementById('payg-it-rate').value || '0',
      });
      toast('PAYG income tax settings saved', 'success');
      await loadRefData();
      renderTaxSettings(main);
    } catch (e) { showError(e); }
  });

  document.getElementById('obligations-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const form = new FormData(ev.target);
      await api('settings.update', {
        obligation_ftc: form.get('obligation_ftc') === 'on' ? '1' : '0',
        obligation_wet: form.get('obligation_wet') === 'on' ? '1' : '0',
        obligation_lct: form.get('obligation_lct') === 'on' ? '1' : '0',
        obligation_fbt: form.get('obligation_fbt') === 'on' ? '1' : '0',
      });
      toast('Obligation settings saved', 'success');
      await loadRefData();
      renderTaxSettings(main);
    } catch (e) { showError(e); }
  });

  document.getElementById('tax-settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('settings.update', Object.fromEntries(new FormData(ev.target).entries()));
      toast('Tax settings saved', 'success');
      await loadRefData();
      renderTaxSettings(main);
    } catch (e) { showError(e); }
  });

  main.querySelectorAll('input[name="payg_it_method"]').forEach(r => r.addEventListener('change', () => {
    const method = main.querySelector('input[name="payg_it_method"]:checked')?.value;
    document.getElementById('payg-it-amount-wrap').style.display = method === 'option1' ? '' : 'none';
    document.getElementById('payg-it-rate-wrap').style.display = method === 'option2' ? '' : 'none';
  }));
}

VIEWS.taxStatement = async function (main, params) {
  const from = params.from;
  const to = params.to;
  const type = params.type === 'IAS' ? 'IAS' : 'BAS';
  if (!from || !to) { navigate('#/tax'); return; }
  const r = await api('tax.statement', { from, to, type });
  const isIas = r.type === 'IAS';
  const label = isIas
    ? `IAS ${new Date(from + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`
    : periodLabel(from, to);
  const isLodged = r.status === 'LODGED';
  const isInProgress = to >= today();
  const amountLabel = r.netPayableCents >= 0 ? 'Net amount payable to the ATO' : 'Net amount refundable';
  const formType = r.formType === 'full' ? 'full' : 'simpler';
  const formLabel = formType === 'full' ? 'Full BAS' : 'Simpler BAS';
  const showW = r.showWLabels !== false;
  const basisLabel = r.basis === 'cash' ? 'Cash basis' : 'Accruals basis';

  const gstRows = `
    <tr><td><b>G1</b> Total sales (including GST)</td><td class="num">${fmtMoney(r.g1_total_sales_cents)}</td></tr>
    ${formType === 'full' ? `
    <tr><td><b>G2</b> Export sales</td><td class="num">${fmtMoney(r.g2_export_sales_cents)}</td></tr>
    <tr><td><b>G3</b> Other GST-free sales</td><td class="num">${fmtMoney(r.g3_gst_free_sales_cents)}</td></tr>
    <tr><td><b>G10</b> Capital purchases</td><td class="num">${fmtMoney(r.g10_capital_purchases_cents)}</td></tr>
    <tr><td><b>G11</b> Non-capital purchases</td><td class="num">${fmtMoney(r.g11_non_capital_purchases_cents)}</td></tr>` : ''}
    <tr><td><b>1A</b> GST on sales</td><td class="num">${fmtMoney(r.a1a_gst_on_sales_cents)}</td></tr>
    <tr><td><b>1B</b> GST on purchases</td><td class="num">${fmtMoney(r.a1b_gst_on_purchases_cents)}</td></tr>
    <tr class="subtotal"><td>Net GST ${r.net_gst_cents >= 0 ? 'payable' : 'refundable'}</td>
      <td class="num">${fmtMoney(Math.abs(r.net_gst_cents))}</td></tr>`;

  // On an IAS the withholding section always shows (it's the whole point of the
  // statement); on a BAS it respects the showWLabels visibility flag.
  const whRows = (isIas || showW) ? `
    <tr><td><b>W1</b> Total salary and wages</td><td class="num">${fmtMoney(r.w1_gross_wages_cents)}</td></tr>
    <tr><td><b>W2</b> PAYG withheld</td><td class="num">${fmtMoney(r.w2_payg_withheld_cents)}</td></tr>` : '';

  let itRows = '';
  if (r.itMethod === 'option1') {
    itRows = `
    <tr><td><b>T7</b> ATO instalment amount</td><td class="num">${fmtMoney(r.t7_instalment_amount_cents)}</td></tr>
    <tr><td><b>5A</b> PAYG income tax instalment</td><td class="num">${fmtMoney(r.a5a_payg_instalment_cents)}</td></tr>`;
  } else if (r.itMethod === 'option2') {
    itRows = `
    <tr><td><b>T1</b> PAYG instalment income</td><td class="num">${fmtMoney(r.t1_instalment_income_cents)}</td></tr>
    <tr><td><b>T2</b> Instalment rate</td><td class="num">${(r.t2_instalment_rate_pct || 0).toFixed(2)}%</td></tr>
    <tr><td><b>5A</b> PAYG income tax instalment</td><td class="num">${fmtMoney(r.a5a_payg_instalment_cents)}</td></tr>`;
  }

  const obligationRows = (r.obligations || []).map(o => o.labels.map(l =>
    `<tr><td><b>${esc(l.code)}</b> ${esc(l.name)}</td><td class="num">${fmtMoney(l.amountCents)}</td></tr>`).join('')).join('');

  main.innerHTML = `
    <div class="page-head no-print">
      <h1>${esc(label)}</h1>
      <div class="spacer"></div>
      <a class="btn" href="#/tax">← Back to Tax</a>
    </div>

    ${isLodged ? `
      <div class="card" style="background:#f0fdf4;border:1px solid #bbf7d0">
        <div class="doc-head">
          <div>
            <b>Lodged</b>
            <div class="meta">Marked as lodged on ${fmtDate((r.lodgement.lodged_at || '').slice(0, 10))}</div>
          </div>
          ${badge('LODGED')}
        </div>
      </div>` : ''}

    ${isInProgress ? `
      <div class="card" style="background:#fffbeb;border:1px solid #fde68a">
        <div class="doc-head">
          <div>
            <b>Period in progress</b>
            <div class="meta">Figures so far — the statement finalises after ${fmtDate(to)}.</div>
          </div>
        </div>
      </div>` : ''}

    <div class="card" style="max-width:680px;margin:0 auto">
      ${isIas
        ? reportHeader('Instalment Activity Statement', `For the period ${fmtDate(from)} to ${fmtDate(to)} · PAYG withholding`)
        : reportHeader('Activity Statement', `For the period ${fmtDate(from)} to ${fmtDate(to)} · ${formLabel} · ${basisLabel}`)}

      ${isIas ? '' : `
      <h3 style="margin-bottom:6px">Goods and services tax (GST)</h3>
      <table class="data"><tbody>${gstRows}</tbody></table>`}

      ${whRows ? `
      <h3 style="margin:16px 0 6px">PAYG withholding</h3>
      <table class="data"><tbody>${whRows}</tbody></table>
      ${isIas ? `<p style="color:var(--ink-soft);font-size:12px;margin:6px 0 0">
        PAYG withholding figures are payment-dated (from your pay runs), so they're the same on a cash or accruals basis.
      </p>` : ''}` : ''}

      ${isIas || !itRows ? '' : `
      <h3 style="margin:16px 0 6px">PAYG income tax</h3>
      <table class="data"><tbody>${itRows}</tbody></table>`}

      ${isIas || !obligationRows ? '' : `
      <h3 style="margin:16px 0 6px">Other obligations</h3>
      <table class="data"><tbody>${obligationRows}</tbody></table>`}

      <table class="data" style="margin-top:16px">
        <tbody>
          <tr class="total"><td>${amountLabel}</td>
            <td class="num">${fmtMoney(Math.abs(r.netPayableCents))}</td></tr>
        </tbody>
      </table>

      ${(r.footnotes || []).length ? `
      <ul style="color:var(--ink-soft);font-size:12px;padding-left:18px;margin:12px 0">
        ${r.footnotes.map(f => `<li>${esc(f)}</li>`).join('')}
      </ul>` : ''}

      <p style="color:var(--ink-soft);font-size:12.5px">
        Due ${fmtDate(r.dueDate)}. Ledgerly doesn't lodge electronically yet — copy these labels into
        ATO Online Services, then mark the statement as lodged.
      </p>
      <div class="btn-row no-print">
        <button class="btn" id="btn-open-ato">Open ATO Online Services</button>
        ${isLodged || isInProgress ? '' : '<button class="btn primary" id="btn-mark-lodged">Mark as lodged</button>'}
      </div>
    </div>`;

  document.getElementById('btn-open-ato').addEventListener('click', () => {
    window.ledgerly.openExternal('https://onlineservices.ato.gov.au/');
  });
  document.getElementById('btn-mark-lodged')?.addEventListener('click', async () => {
    try {
      await api('tax.markLodged', { from, to, type });
      toast('Activity statement marked as lodged', 'success');
      navigate('#/tax');
    } catch (e) { showError(e); }
  });
};
