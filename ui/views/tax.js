'use strict';

// Tax tab: Xero-style Activity Statements inbox, built on top of the
// existing BAS report logic (reports.bas / basSummary).

function periodLabel(periodStart, periodEnd) {
  const cycle = STATE.settings.bas_cycle === 'monthly' ? 'monthly' : 'quarterly';
  if (cycle === 'monthly') {
    const d = new Date(periodStart + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
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

function statementRow(s, { isCompleted }) {
  const label = periodLabel(s.periodStart, s.periodEnd);
  const amountLabel = s.netPayableCents >= 0 ? 'Payable' : 'Refund';
  const amountCls = s.netPayableCents >= 0 ? '' : 'amount-pos';
  const viewHref = `#/tax/statement?from=${s.periodStart}&to=${s.periodEnd}`;
  return `
    <div class="bank-card" data-period-start="${s.periodStart}" data-period-end="${s.periodEnd}" ${s.id ? `data-id="${s.id}"` : ''}>
      <div>
        <a href="${viewHref}"><b>${esc(label)}</b></a>
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
          : `<button class="btn small primary btn-tax-lodge" data-from="${s.periodStart}" data-to="${s.periodEnd}">Mark as lodged</button>`}
      </div>
    </div>`;
}

VIEWS.tax = async function (main) {
  const r = await api('tax.statements');

  main.innerHTML = `
    <div class="page-head"><h1>Activity Statements</h1></div>
    <div class="page-sub">
      Figures are accruals-basis, derived from your posted journals (Simpler BAS labels).
    </div>

    <div class="card">
      <h2>Needs attention</h2>
      ${r.needsAttention.length === 0
        ? `<div class="empty">You're up to date</div>`
        : r.needsAttention.map(s => statementRow(s, { isCompleted: false })).join('')}
    </div>

    <div class="card">
      <h2>Completed</h2>
      ${r.completed.length === 0
        ? `<div class="empty">No activity statements lodged</div>`
        : r.completed.map(s => statementRow(s, { isCompleted: true })).join('')}
    </div>`;

  on(main, '.btn-tax-lodge', 'click', async (ev) => {
    const { from, to } = ev.currentTarget.dataset;
    try {
      await api('tax.markLodged', { from, to });
      toast('Activity statement marked as lodged', 'success');
      VIEWS.tax(main);
    } catch (e) { showError(e); }
  });

  on(main, '.btn-tax-unlodge', 'click', async (ev) => {
    if (!confirm('Unlodge this activity statement? It will move back to Needs attention.')) return;
    try {
      await api('tax.unlodge', { id: Number(ev.currentTarget.dataset.id) });
      toast('Activity statement unlodged', 'success');
      VIEWS.tax(main);
    } catch (e) { showError(e); }
  });
};

VIEWS.taxStatement = async function (main, params) {
  const from = params.from;
  const to = params.to;
  if (!from || !to) { navigate('#/tax'); return; }
  const r = await api('tax.statement', { from, to });
  const label = periodLabel(from, to);
  const isLodged = r.status === 'LODGED';
  const amountLabel = r.netPayableCents >= 0 ? 'Net amount payable to the ATO' : 'Net amount refundable';

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

    <div class="card" style="max-width:680px;margin:0 auto">
      ${reportHeader('Activity Statement', `For the period ${fmtDate(from)} to ${fmtDate(to)} · Simpler BAS`)}
      <table class="data">
        <tbody>
          <tr><td><b>G1</b> Total sales (including GST)</td><td class="num">${fmtMoney(r.g1_total_sales_cents)}</td></tr>
          <tr><td><b>1A</b> GST on sales</td><td class="num">${fmtMoney(r.a1a_gst_on_sales_cents)}</td></tr>
          <tr><td><b>1B</b> GST on purchases</td><td class="num">${fmtMoney(r.a1b_gst_on_purchases_cents)}</td></tr>
          <tr class="subtotal"><td>Net GST ${r.net_gst_cents >= 0 ? 'payable' : 'refundable'}</td>
            <td class="num">${fmtMoney(Math.abs(r.net_gst_cents))}</td></tr>
          <tr><td><b>W1</b> Total salary and wages</td><td class="num">${fmtMoney(r.w1_gross_wages_cents)}</td></tr>
          <tr><td><b>W2</b> PAYG withheld</td><td class="num">${fmtMoney(r.w2_payg_withheld_cents)}</td></tr>
          <tr class="total"><td>${amountLabel}</td>
            <td class="num">${fmtMoney(Math.abs(r.netPayableCents))}</td></tr>
        </tbody>
      </table>
      <p style="color:var(--ink-soft);font-size:12.5px">
        Due ${fmtDate(r.dueDate)}. Ledgerly doesn't lodge electronically yet — copy these labels into
        ATO Online Services, then mark the statement as lodged.
      </p>
      <div class="btn-row no-print">
        <button class="btn" id="btn-open-ato">Open ATO Online Services</button>
        ${isLodged ? '' : '<button class="btn primary" id="btn-mark-lodged">Mark as lodged</button>'}
      </div>
    </div>`;

  document.getElementById('btn-open-ato').addEventListener('click', () => {
    window.ledgerly.openExternal('https://onlineservices.ato.gov.au/');
  });
  document.getElementById('btn-mark-lodged')?.addEventListener('click', async () => {
    try {
      await api('tax.markLodged', { from, to });
      toast('Activity statement marked as lodged', 'success');
      navigate('#/tax');
    } catch (e) { showError(e); }
  });
};
