'use strict';

// Bank accounts, account transactions, spend/receive money, transfers,
// statement import and reconciliation.

VIEWS.bankAccounts = async function (main) {
  const banks = await api('bank.accounts');
  main.innerHTML = `
    <div class="page-head">
      <h1>Bank accounts</h1>
      <div class="spacer"></div>
      <button class="btn" id="btn-transfer" ${banks.length < 2 ? 'disabled' : ''}>Transfer money</button>
      <button class="btn primary" id="btn-add-bank">Add bank account</button>
    </div>
    ${banks.length === 0 ? `<div class="card"><div class="empty">
      Add your bank, credit card or cash accounts, then import statements to reconcile.
    </div></div>` : ''}
    ${banks.map(b => `
      <div class="card">
        <div class="doc-head">
          <div>
            <h2 style="margin-bottom:2px"><a href="#/bank/${b.id}">${esc(b.name)}</a></h2>
            <div class="meta" style="color:var(--ink-soft);font-size:12.5px">Code ${esc(b.code)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:750;font-size:19px">${fmtMoney(b.balance_cents)}</div>
            <div style="font-size:12.5px;color:var(--ink-soft)">Balance in Ledgerly</div>
            <div style="font-size:12.5px;color:var(--ink-soft)">Statement balance: ${fmtMoney(b.statement_balance_cents)}</div>
          </div>
        </div>
        <div class="btn-row" style="margin-top:10px">
          ${b.unreconciled > 0
            ? `<a class="btn primary" href="#/bank/${b.id}/reconcile">Reconcile ${b.unreconciled} item${b.unreconciled === 1 ? '' : 's'}</a>`
            : '<span class="badge MATCHED">Reconciled</span>'}
          <a class="btn" href="#/bank/${b.id}">Account transactions</a>
          <a class="btn" href="#/bank/${b.id}/import">Import statement</a>
          <a class="btn" href="#/bank/spend?bank=${b.id}">Spend money</a>
          <a class="btn" href="#/bank/receive?bank=${b.id}">Receive money</a>
        </div>
      </div>`).join('')}`;

  document.getElementById('btn-add-bank').addEventListener('click', () => {
    const m = modal(`
      <h2>Add bank account</h2>
      <form id="bank-form">
        <label class="field">Account name *<input name="name" required placeholder="e.g. Business Checking" /></label>
        <div class="field-row">
          <label class="field">Code *<input name="code" required placeholder="e.g. 090" /></label>
          <label class="field">Description<input name="description" /></label>
        </div>
        <div class="btn-row">
          <button class="btn primary" type="submit">Add account</button>
          <button class="btn" type="button" id="bank-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#bank-cancel').addEventListener('click', closeModal);
    m.querySelector('#bank-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('bank.createAccount', {
          name: ev.target.elements.name.value.trim(),
          code: ev.target.elements.code.value.trim(),
          description: ev.target.elements.description.value.trim(),
        });
        closeModal();
        toast('Bank account added', 'success');
        VIEWS.bankAccounts(main);
      } catch (e) { showError(e); }
    });
  });

  document.getElementById('btn-transfer')?.addEventListener('click', () => {
    const m = modal(`
      <h2>Transfer money</h2>
      <form id="tr-form">
        <div class="field-row">
          <label class="field">From *<select name="from">${banks.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>
          <label class="field">To *<select name="to">${banks.map((b, i) => `<option value="${b.id}" ${i === 1 ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
        </div>
        <div class="field-row">
          <label class="field">Amount *<input name="amount" required placeholder="0.00" /></label>
          <label class="field">Date *<input type="date" name="date" required value="${today()}" /></label>
        </div>
        <label class="field">Reference<input name="reference" /></label>
        <div class="btn-row">
          <button class="btn primary" type="submit">Transfer</button>
          <button class="btn" type="button" id="tr-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#tr-cancel').addEventListener('click', closeModal);
    m.querySelector('#tr-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api('bank.transfer', {
          fromAccountId: Number(f.elements.from.value), toAccountId: Number(f.elements.to.value),
          date: f.elements.date.value, amountCents: centsOf(f.elements.amount.value),
          reference: f.elements.reference.value.trim(),
        });
        closeModal();
        toast('Transfer recorded', 'success');
        VIEWS.bankAccounts(main);
      } catch (e) { showError(e); }
    });
  });
};

// ---------- single account: transactions ----------

VIEWS.bankAccount = async function (main, params) {
  const id = Number(params.id);
  const banks = await api('bank.accounts');
  const b = banks.find(x => x.id === id);
  if (!b) { main.innerHTML = '<div class="card">Account not found</div>'; return; }
  const txs = await api('bank.transactions', { bankAccountId: id });

  main.innerHTML = `
    <div class="page-head">
      <h1>${esc(b.name)}</h1>
      <div class="spacer"></div>
      <a class="btn" href="#/bank/${id}/import">Import statement</a>
      <a class="btn" href="#/bank/spend?bank=${id}">Spend money</a>
      <a class="btn" href="#/bank/receive?bank=${id}">Receive money</a>
      ${b.unreconciled > 0 ? `<a class="btn primary" href="#/bank/${id}/reconcile">Reconcile ${b.unreconciled}</a>` : ''}
    </div>
    <div class="stat-row" style="margin-bottom:16px">
      <div class="stat"><div class="label">Balance in Ledgerly</div><div class="value">${fmtMoney(b.balance_cents)}</div></div>
      <div class="stat"><div class="label">Statement balance</div><div class="value">${fmtMoney(b.statement_balance_cents)}</div>
        <div class="sub">${b.last_statement_date ? 'to ' + fmtDate(b.last_statement_date) : 'no statements imported'}</div></div>
      <div class="stat" data-go="#/bank/${id}/reconcile"><div class="label">Items to reconcile</div><div class="value">${b.unreconciled}</div></div>
    </div>
    <div class="card">
      <h2>Account transactions</h2>
      <table class="data">
        <thead><tr><th>Date</th><th>Description</th><th>Reference</th><th class="num">Money out</th><th class="num">Money in</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${txs.length === 0 ? '<tr><td colspan="7"><div class="empty">No transactions yet</div></td></tr>' : ''}
          ${txs.map(t => `
            <tr>
              <td>${fmtDate(t.date)}</td>
              <td>${t.kind === 'bank_transaction' ? `<a href="#/bank/transaction/${t.id}">${esc(t.description)}</a>` : esc(t.description)}</td>
              <td>${esc(t.reference || '')}</td>
              <td class="num">${t.amount_cents < 0 ? fmtMoney(-t.amount_cents) : ''}</td>
              <td class="num">${t.amount_cents > 0 ? fmtMoney(t.amount_cents) : ''}</td>
              <td>${t.is_reconciled ? badge('MATCHED') : badge('UNMATCHED')}</td>
              <td>${t.kind === 'bank_transaction' && !t.is_reconciled
                ? `<button class="btn small danger btn-del-tx" data-id="${t.id}">Delete</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  on(main, '.btn-del-tx', 'click', async (ev) => {
    if (!confirm('Delete this transaction? Its ledger entry will be reversed.')) return;
    try { await api('bank.deleteTransaction', { id: Number(ev.target.dataset.id) }); toast('Deleted', 'success'); VIEWS.bankAccount(main, params); } catch (e) { showError(e); }
  });
};

// ---------- spend / receive money editor ----------

VIEWS.bankTransactionEdit = async function (main, params) {
  const isEdit = !!params.id;
  const banks = (await api('bank.accounts'));
  if (!banks.length) {
    main.innerHTML = '<div class="card"><div class="empty">Create a bank account first. <a href="#/bank">Bank accounts</a></div></div>';
    return;
  }
  const contacts = await api('contacts.list', {});
  STATE._items = [];

  let t;
  if (isEdit) {
    const d = await api('bank.getTransaction', { id: Number(params.id) });
    t = {
      id: d.id, kind: d.kind, bankAccountId: d.bank_account_id, contactId: d.contact_id,
      date: d.date, reference: d.reference, taxMode: d.tax_mode, isReconciled: d.is_reconciled,
      lines: d.lines.map(l => ({
        description: l.description, qty: l.qty, unitPriceCents: l.unit_price_cents,
        accountId: l.account_id, taxRateId: l.tax_rate_id,
      })),
    };
  } else {
    const kind = location.hash.includes('/receive') ? 'RECEIVE' : 'SPEND';
    t = {
      kind, bankAccountId: params.bank ? Number(params.bank) : banks[0].id, contactId: null,
      date: today(), reference: '', taxMode: 'exclusive', lines: [],
    };
  }
  const isSpend = t.kind === 'SPEND';

  main.innerHTML = `
    <div class="page-head"><h1>${isEdit ? 'Edit' : ''} ${isSpend ? 'Spend money' : 'Receive money'}</h1>
    ${t.isReconciled ? badge('MATCHED') : ''}</div>
    <form id="bt-form" class="card">
      <div class="field-row">
        <label class="field">${isSpend ? 'From bank account *' : 'To bank account *'}
          <select name="bank">${banks.map(b => `<option value="${b.id}" ${b.id === t.bankAccountId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
        </label>
        <label class="field">${isSpend ? 'Payee' : 'Payer'}
          <select name="contact">${contactOptions(contacts, t.contactId)}</select>
        </label>
        <label class="field">Date *<input type="date" name="date" required value="${t.date}" /></label>
        <label class="field">Reference<input name="reference" value="${esc(t.reference)}" /></label>
        <label class="field">Amounts are
          <select name="taxMode">
            <option value="exclusive" ${t.taxMode === 'exclusive' ? 'selected' : ''}>Tax exclusive</option>
            <option value="inclusive" ${t.taxMode === 'inclusive' ? 'selected' : ''}>Tax inclusive</option>
            <option value="none" ${t.taxMode === 'none' ? 'selected' : ''}>No tax</option>
          </select>
        </label>
      </div>
      <div id="lines-host"></div>
      <div class="totals-box" id="totals-box"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn primary" type="submit" ${t.isReconciled ? 'disabled' : ''}>Save</button>
        <a class="btn" href="#/bank/${t.bankAccountId}">Cancel</a>
      </div>
    </form>`;

  const editor = linesEditor(document.getElementById('lines-host'), t.lines, { showItems: false });
  const form = document.getElementById('bt-form');
  const renderTotals = () => {
    const tt = liveTotals(editor.read(), form.elements.taxMode.value);
    document.getElementById('totals-box').innerHTML = `
      <div class="row"><span>Subtotal</span><b>${fmtMoney(tt.subtotal)}</b></div>
      <div class="row"><span>Tax</span><b>${fmtMoney(tt.tax)}</b></div>
      <div class="row grand"><span>Total ${isSpend ? 'spent' : 'received'}</span><span>${fmtMoney(tt.total)}</span></div>`;
  };
  renderTotals();
  main.addEventListener('lines-changed', renderTotals);
  form.elements.taxMode.addEventListener('change', renderTotals);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const saved = await api('bank.saveTransaction', {
        id: t.id, kind: t.kind,
        bankAccountId: Number(form.elements.bank.value),
        contactId: Number(form.elements.contact.value) || null,
        date: form.elements.date.value,
        reference: form.elements.reference.value.trim(),
        taxMode: form.elements.taxMode.value,
        lines: editor.read().filter(l => l.description || l.unitPriceCents || l.accountId),
      });
      toast('Transaction saved', 'success');
      navigate('#/bank/' + saved.bank_account_id);
    } catch (e) { showError(e); }
  });
};

// ---------- statement import ----------

VIEWS.bankImport = async function (main, params) {
  const id = Number(params.id);
  const banks = await api('bank.accounts');
  const b = banks.find(x => x.id === id);

  main.innerHTML = `
    <div class="page-head"><h1>Import statement — ${esc(b ? b.name : '')}</h1></div>
    <div class="card" style="max-width:760px">
      <p style="color:var(--ink-soft)">
        Import a CSV from your bank. Recognised columns: <b>Date</b>, <b>Payee/Description</b>,
        <b>Reference</b> and either a signed <b>Amount</b> column or separate <b>Money out / Money in</b>
        (Debit/Credit) columns. Dates may be <code>YYYY-MM-DD</code> or <code>DD/MM/YYYY</code>.
      </p>
      <div class="btn-row">
        <button class="btn primary" id="btn-pick">Choose CSV file…</button>
        <a class="btn" href="#/bank/${id}">Back</a>
      </div>
      <h2 style="margin-top:22px">Or paste CSV</h2>
      <textarea id="csv-paste" rows="8" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:10px;font:12.5px ui-monospace,monospace"
        placeholder="Date,Description,Amount&#10;2026-06-01,Coffee shop,-4.50"></textarea>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" id="btn-paste">Import pasted CSV</button>
        <button class="btn" id="btn-manual">Add single line manually</button>
      </div>
    </div>`;

  async function doImport(csv) {
    try {
      const r = await api('bank.importStatement', { bankAccountId: id, csv });
      toast(`Imported ${r.imported} line${r.imported === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped}` : ''}`, 'success');
      if (r.imported > 0) navigate(`#/bank/${id}/reconcile`);
    } catch (e) { showError(e); }
  }

  document.getElementById('btn-pick').addEventListener('click', async () => {
    const r = await window.ledgerly.openCsv();
    if (r.ok) doImport(r.data);
  });
  document.getElementById('btn-paste').addEventListener('click', () => {
    const v = document.getElementById('csv-paste').value.trim();
    if (!v) return toast('Paste some CSV first', 'error');
    doImport(v);
  });
  document.getElementById('btn-manual').addEventListener('click', () => {
    const m = modal(`
      <h2>Add statement line</h2>
      <form id="sl-form">
        <div class="field-row">
          <label class="field">Date *<input type="date" name="date" required value="${today()}" /></label>
          <label class="field">Amount * (negative = money out)<input name="amount" required placeholder="-25.00" /></label>
        </div>
        <div class="field-row">
          <label class="field">Payee<input name="payee" /></label>
          <label class="field">Description<input name="description" /></label>
        </div>
        <div class="btn-row">
          <button class="btn primary" type="submit">Add line</button>
          <button class="btn" type="button" id="sl-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#sl-cancel').addEventListener('click', closeModal);
    m.querySelector('#sl-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api('bank.addStatementLine', {
          bankAccountId: id, date: f.elements.date.value,
          payee: f.elements.payee.value.trim(), description: f.elements.description.value.trim(),
          amountCents: centsOf(f.elements.amount.value),
        });
        closeModal();
        toast('Statement line added', 'success');
        navigate(`#/bank/${id}/reconcile`);
      } catch (e) { showError(e); }
    });
  });
};

// ---------- reconcile ----------

VIEWS.reconcile = async function (main, params) {
  const id = Number(params.id);
  const banks = await api('bank.accounts');
  const b = banks.find(x => x.id === id);
  const data = await api('bank.reconcileData', { bankAccountId: id });
  const contacts = await api('contacts.list', {});
  const stmts = data.statementLines;

  main.innerHTML = `
    <div class="page-head">
      <h1>Reconcile — ${esc(b ? b.name : '')}</h1>
      <div class="spacer"></div>
      <a class="btn" href="#/bank/${id}/import">Import more</a>
      <a class="btn" href="#/bank/${id}">Account transactions</a>
    </div>
    <div class="page-sub">
      ${stmts.length === 0
        ? 'All statement lines are reconciled. 🎉'
        : `${stmts.length} statement line${stmts.length === 1 ? '' : 's'} to reconcile.
           Confirm a suggested match, pick another transaction, or create &amp; code a new one.`}
    </div>
    <div id="rec-list">
      ${stmts.map(s => recPairHtml(s, data.unreconciledTransactions, contacts)).join('')}
    </div>`;

  function recPairHtml(s, allTx, contacts) {
    const top = s.suggestions[0];
    return `
    <div class="rec-pair" data-sid="${s.id}">
      <div class="rec-side statement">
        <div class="rec-line1">
          <span>${esc(s.payee || s.description || 'Statement line')}</span>
          <span class="${s.amount_cents < 0 ? 'amount-neg' : 'amount-pos'}">${fmtMoney(s.amount_cents)}</span>
        </div>
        <div class="rec-line2">${fmtDate(s.date)}${s.description && s.payee ? ' · ' + esc(s.description) : ''}${s.reference ? ' · ref ' + esc(s.reference) : ''}
          <button class="btn small danger btn-del-sl" style="float:right">Delete</button>
        </div>
      </div>
      <div class="rec-mid">
        <button class="rec-ok" title="Reconcile" ${top ? '' : 'data-mode="create"'}>OK</button>
      </div>
      <div class="rec-side app">
        <div class="rec-tabs">
          <button class="t-match ${top ? 'active' : ''}">Match</button>
          <button class="t-create ${top ? '' : 'active'}">Create</button>
        </div>
        <div class="pane-match" ${top ? '' : 'hidden'}>
          ${s.suggestions.length ? `
            <select class="sel-match" style="width:100%;padding:7px;border:1px solid var(--line);border-radius:6px">
              ${s.suggestions.map((g, i) => `<option value="${g.kind}|${g.id}|${g.direction || ''}" ${i === 0 ? 'selected' : ''}>
                ${esc(g.description)} · ${fmtDate(g.date)} · ${fmtMoney(g.amount_cents)}</option>`).join('')}
            </select>` : '<div class="rec-line2">No matching transaction found — use Create.</div>'}
        </div>
        <div class="pane-create" ${top ? 'hidden' : ''}>
          <div class="field-row">
            <label class="field" style="margin-bottom:4px">Who
              <select class="cr-contact">${contactOptions(contacts, null)}</select>
            </label>
            <label class="field" style="margin-bottom:4px">Account *
              <select class="cr-account">${accountOptions(null, { filter: 'nonbank' })}</select>
            </label>
            <label class="field" style="margin-bottom:4px">Tax
              <select class="cr-tax">${taxOptions(null)}</select>
            </label>
          </div>
        </div>
      </div>
    </div>`;
  }

  on(main, '.t-match', 'click', (ev) => {
    const pair = ev.target.closest('.rec-pair');
    pair.querySelector('.t-match').classList.add('active');
    pair.querySelector('.t-create').classList.remove('active');
    pair.querySelector('.pane-match').hidden = false;
    pair.querySelector('.pane-create').hidden = true;
    pair.querySelector('.rec-ok').removeAttribute('data-mode');
  });
  on(main, '.t-create', 'click', (ev) => {
    const pair = ev.target.closest('.rec-pair');
    pair.querySelector('.t-create').classList.add('active');
    pair.querySelector('.t-match').classList.remove('active');
    pair.querySelector('.pane-match').hidden = true;
    pair.querySelector('.pane-create').hidden = false;
    pair.querySelector('.rec-ok').setAttribute('data-mode', 'create');
  });

  on(main, '.btn-del-sl', 'click', async (ev) => {
    const sid = Number(ev.target.closest('.rec-pair').dataset.sid);
    if (!confirm('Delete this statement line?')) return;
    try { await api('bank.deleteStatementLine', { id: sid }); VIEWS.reconcile(main, params); } catch (e) { showError(e); }
  });

  on(main, '.rec-ok', 'click', async (ev) => {
    const pair = ev.target.closest('.rec-pair');
    const sid = Number(pair.dataset.sid);
    const mode = ev.target.dataset.mode === 'create' ? 'create' : 'match';
    try {
      if (mode === 'match') {
        const sel = pair.querySelector('.sel-match');
        if (!sel) return toast('No match available — use Create', 'error');
        const [kind, mid, direction] = sel.value.split('|');
        await api('bank.match', { statementLineId: sid, kind, id: Number(mid), direction: direction || null });
      } else {
        const accountId = Number(pair.querySelector('.cr-account').value);
        if (!accountId) return toast('Choose an account to code this to', 'error');
        await api('bank.createAndMatch', {
          statementLineId: sid,
          contactId: Number(pair.querySelector('.cr-contact').value) || null,
          accountId,
          taxRateId: Number(pair.querySelector('.cr-tax').value) || null,
        });
      }
      toast('Reconciled ✓', 'success');
      VIEWS.reconcile(main, params);
    } catch (e) { showError(e); }
  });
};
