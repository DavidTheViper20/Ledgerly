'use strict';

VIEWS.settingsView = async function (main) {
  const s = STATE.settings;
  const taxRates = STATE.taxRates;

  main.innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Organisation</h2>
        <form id="org-form">
          <label class="field">Organisation name *<input name="org_name" required value="${esc(s.org_name)}" /></label>
          <label class="field">Legal / trading name<input name="org_legal_name" value="${esc(s.org_legal_name)}" /></label>
          <div class="field-row">
            <label class="field">Email<input name="org_email" value="${esc(s.org_email)}" /></label>
            <label class="field">ABN<input name="org_tax_number" value="${esc(s.org_tax_number)}" /></label>
          </div>
          <label class="field">Address<textarea name="org_address" rows="2">${esc(s.org_address)}</textarea></label>
          <div class="field-row">
            <label class="field">Base currency
              <select name="base_currency">
                ${['USD', 'GBP', 'EUR', 'AUD', 'NZD', 'CAD', 'ZAR', 'SGD'].map(c =>
                  `<option ${c === (s.base_currency || 'USD') ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </label>
            <label class="field">Financial year end month
              <select name="fy_end_month">
                ${['January','February','March','April','May','June','July','August','September','October','November','December']
                  .map((m, i) => `<option value="${i + 1}" ${String(i + 1) === (s.fy_end_month || '12') ? 'selected' : ''}>${m}</option>`).join('')}
              </select>
            </label>
          </div>
          <button class="btn primary" type="submit">Save organisation</button>
        </form>
      </div>

      <div>
        <div class="card">
          <h2>Invoice settings</h2>
          <form id="inv-form">
            <div class="field-row">
              <label class="field">Invoice prefix<input name="invoice_prefix" value="${esc(s.invoice_prefix)}" /></label>
              <label class="field">Next invoice number<input name="invoice_next_number" value="${esc(s.invoice_next_number)}" /></label>
            </div>
            <div class="field-row">
              <label class="field">Quote prefix<input name="quote_prefix" value="${esc(s.quote_prefix)}" /></label>
              <label class="field">Next quote number<input name="quote_next_number" value="${esc(s.quote_next_number)}" /></label>
            </div>
            <div class="field-row">
              <label class="field">Default due days<input name="default_due_days" value="${esc(s.default_due_days)}" /></label>
              <label class="field">Tax label (e.g. GST)<input name="tax_label" value="${esc(s.tax_label)}" /></label>
              <label class="field">Super guarantee %<input name="super_guarantee_pct" value="${esc(s.super_guarantee_pct || '12')}" /></label>
            </div>
            <button class="btn primary" type="submit">Save invoice settings</button>
          </form>
        </div>

        <div class="card" id="ai-card">
          <h2>AI assistant</h2>
          <p style="color:var(--ink-soft);font-size:12.5px;margin-top:0">
            Powers the chat bubble in the bottom-right corner. Your key is stored only in your
            local Ledgerly database and requests are sent directly to the endpoint you choose.
            For a local model, run Ollama or LM Studio and pick "Local model".
          </p>
          <form id="ai-form-settings">
            <div class="field-row">
              <label class="field">Provider
                <select name="ai_provider" id="ai-provider-sel">
                  <option value="">Disabled</option>
                  <option value="anthropic" ${s.ai_provider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
                  <option value="openai" ${s.ai_provider === 'openai' ? 'selected' : ''}>OpenAI</option>
                  <option value="deepseek" ${s.ai_provider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
                  <option value="local" ${s.ai_provider === 'local' ? 'selected' : ''}>Local model (Ollama / LM Studio)</option>
                  <option value="custom" ${s.ai_provider === 'custom' ? 'selected' : ''}>Custom (OpenAI-compatible)</option>
                </select>
              </label>
              <label class="field">Model<input name="ai_model" id="ai-model-inp" value="${esc(s.ai_model || '')}" placeholder="e.g. claude-sonnet-4-6" /></label>
            </div>
            <label class="field">Endpoint URL<input name="ai_base_url" id="ai-url-inp" value="${esc(s.ai_base_url || '')}" placeholder="auto-filled from provider" /></label>
            <div class="field-row">
              <label class="field">API key<input name="ai_api_key" type="password" value="${esc(s.ai_api_key || '')}" placeholder="not needed for most local models" /></label>
              <label class="field">Max response tokens<input name="ai_max_tokens" value="${esc(s.ai_max_tokens || '2048')}" style="max-width:130px" /></label>
            </div>
            <div class="btn-row">
              <button class="btn primary" type="submit">Save AI settings</button>
              <button class="btn" type="button" id="ai-test">Test connection</button>
              <span id="ai-test-result" style="font-size:12.5px;color:var(--ink-soft)"></span>
            </div>
          </form>
        </div>

        <div class="card">
          <h2>Tax rates</h2>
          <table class="data">
            <thead><tr><th>Name</th><th class="num">Rate %</th><th></th></tr></thead>
            <tbody>
              ${taxRates.map(t => `
                <tr>
                  <td>${esc(t.name)}</td><td class="num">${t.rate}</td>
                  <td class="btn-row">
                    <button class="btn small btn-tax-edit" data-id="${t.id}">Edit</button>
                    <button class="btn small danger btn-tax-arch" data-id="${t.id}">Remove</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
          <button class="btn small" id="btn-tax-new" style="margin-top:10px">+ New tax rate</button>
        </div>
      </div>
    </div>`;

  document.getElementById('org-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('settings.update', Object.fromEntries(new FormData(ev.target).entries()));
      toast('Organisation settings saved', 'success');
      loadRefData();
    } catch (e) { showError(e); }
  });

  const AI_PRESETS = {
    anthropic: { url: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
    openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o' },
    deepseek: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    local: { url: 'http://localhost:11434/v1', model: 'llama3.1' },
    custom: { url: '', model: '' },
  };
  document.getElementById('ai-provider-sel').addEventListener('change', (ev) => {
    const p = AI_PRESETS[ev.target.value];
    if (p) {
      document.getElementById('ai-url-inp').value = p.url;
      document.getElementById('ai-model-inp').value = p.model;
    }
  });
  document.getElementById('ai-form-settings').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('settings.update', Object.fromEntries(new FormData(ev.target).entries()));
      toast('AI settings saved', 'success');
      loadRefData();
    } catch (e) { showError(e); }
  });
  document.getElementById('ai-test').addEventListener('click', async () => {
    const out = document.getElementById('ai-test-result');
    out.textContent = 'Saving & testing…';
    try {
      await api('settings.update', Object.fromEntries(new FormData(document.getElementById('ai-form-settings')).entries()));
      const r = await window.ledgerly.assistant('test');
      out.textContent = '✓ Connected — model replied: ' + (r.reply || 'OK').slice(0, 60);
      out.style.color = 'var(--green)';
    } catch (e) {
      out.textContent = '✗ ' + e.message;
      out.style.color = 'var(--red)';
    }
  });
  if (location.hash.includes('focus=ai')) {
    document.getElementById('ai-card').scrollIntoView({ block: 'center' });
  }

  document.getElementById('inv-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('settings.update', Object.fromEntries(new FormData(ev.target).entries()));
      toast('Invoice settings saved', 'success');
    } catch (e) { showError(e); }
  });

  function taxModal(t) {
    const m = modal(`
      <h2>${t ? 'Edit tax rate' : 'New tax rate'}</h2>
      <form id="tax-form">
        <div class="field-row">
          <label class="field">Name *<input name="name" required value="${esc(t ? t.name : '')}" /></label>
          <label class="field">Rate % *<input name="rate" required value="${t ? t.rate : ''}" /></label>
        </div>
        <div class="btn-row">
          <button class="btn primary" type="submit">Save</button>
          <button class="btn" type="button" id="tax-cancel">Cancel</button>
        </div>
      </form>`);
    m.querySelector('#tax-cancel').addEventListener('click', closeModal);
    m.querySelector('#tax-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('taxRates.save', {
          id: t ? t.id : undefined,
          name: ev.target.elements.name.value.trim(),
          rate: parseFloat(ev.target.elements.rate.value) || 0,
        });
        closeModal();
        toast('Tax rate saved', 'success');
        await loadRefData();
        VIEWS.settingsView(main);
      } catch (e) { showError(e); }
    });
  }

  document.getElementById('btn-tax-new').addEventListener('click', () => taxModal(null));
  on(main, '.btn-tax-edit', 'click', (ev) => taxModal(taxRates.find(t => t.id == ev.target.dataset.id)));
  on(main, '.btn-tax-arch', 'click', async (ev) => {
    if (!confirm('Remove this tax rate? Existing documents keep their tax.')) return;
    try {
      await api('taxRates.archive', { id: Number(ev.target.dataset.id) });
      await loadRefData();
      VIEWS.settingsView(main);
    } catch (e) { showError(e); }
  });
};
