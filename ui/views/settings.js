'use strict';

VIEWS.settingsView = async function (main) {
  const s = STATE.settings;
  const taxRates = STATE.taxRates;
  let orgs = [];
  try { orgs = await window.ledgerly.orgs('list'); } catch { /* env-pinned db */ }
  let feed = { configured: false, connections: [], accountLinks: [] };
  try { feed = await window.ledgerly.bankFeed('status'); } catch { /* older shell */ }
  let cloudAuth = { configured: false, signedIn: false, organizationId: '' };
  try { cloudAuth = await window.ledgerly.cloudAuth('status'); } catch { /* older shell */ }
  let cloudSession = { signedIn: false, organizationId: '' };
  try { cloudSession = await window.ledgerly.cloudSession('status'); } catch { /* older shell */ }
  const cloudSignedIn = Boolean(cloudAuth.signedIn || cloudSession.signedIn);
  const cloudIdentity = cloudAuth.email || cloudAuth.name || (cloudSignedIn ? 'Signed in' : 'Not signed in');
  const cloudOrgId = cloudAuth.organizationId || cloudSession.organizationId || '';
  let appLock = { enabled: false, configured: false, locked: false };
  try { appLock = await window.ledgerly.security('status'); } catch { /* older shell */ }
  const cloud = feed.cloud || {};
  const localConnections = feed.connections || [];
  const cloudConnections = cloud.connections || [];
  const displayConnections = cloudConnections.length ? cloudConnections : localConnections;
  const primaryConnection = displayConnections[0] || {};
  const hasConnection = displayConnections.length || localConnections.length;
  const consentStatus = primaryConnection.consentStatus || primaryConnection.consent_status || (hasConnection ? 'pending' : 'not connected');
  const consentExpiry = primaryConnection.consentExpiresAt || primaryConnection.consent_expires_at || '';
  const connectionIdForCloud = primaryConnection.providerConnectionId || primaryConnection.provider_connection_id || '';
  const feedStatusBadge = feed.configured ? badge(String(consentStatus).toUpperCase()) : badge(feed.cloudConfigured ? 'SETUP' : 'PAUSED');
  const feedSetupText = feed.configured
    ? ''
    : (feed.setupRequired === 'organization' ? 'Cloud organisation not linked' : 'Cloud bank feeds not configured');
  const cloudLinkByProviderId = new Map((cloud.accountLinks || []).map(l => [l.providerAccountId, l]));
  const feedLinksHtml = (feed.accountLinks || []).map(l => {
    const cloudLink = cloudLinkByProviderId.get(l.provider_account_id) || {};
    const lastSync = cloudLink.lastSyncAt || l.last_sync_at;
    return `
    <tr>
      <td>${esc(l.provider_account_name || l.provider_account_id)}</td>
      <td>${esc(l.bank_account_name || '')}</td>
      <td>${esc(l.institution_name || '')}</td>
      <td>${esc(String(consentStatus || 'unknown'))}</td>
      <td>${lastSync ? esc(new Date(lastSync).toLocaleString()) : 'Not synced'}</td>
      <td><button class="btn small danger btn-feed-unlink" data-id="${l.id}">Remove</button></td>
    </tr>`;
  }).join('');

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
        <div class="card" id="orgs-card">
          <h2>Organisations</h2>
          <p style="color:var(--ink-soft);font-size:12.5px;margin-top:0">
            Each organisation keeps completely separate books — contacts, invoices, bank
            accounts, payroll, settings and assistant history.
          </p>
          <table class="data">
            <tbody>
              ${orgs.map(o => `
                <tr>
                  <td>${esc(o.name)}${o.active ? ' <span class="org-current">current</span>' : ''}</td>
                  <td class="btn-row" style="justify-content:flex-end">
                    ${o.active ? '' : `<button class="btn small btn-org-switch" data-id="${esc(o.id)}">Switch</button>`}
                    <button class="btn small danger btn-org-del" data-id="${esc(o.id)}" data-name="${esc(o.name)}">Delete</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
          <button class="btn small" id="btn-org-new" style="margin-top:10px">+ New organisation</button>
        </div>
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

        <div class="card">
          <div class="doc-head">
            <h2>Bank feeds</h2>
            ${feedStatusBadge}
          </div>
          <div class="mini-grid" style="margin-bottom:10px">
            <div class="mini-card"><div>Cloud account</div><b>${cloudSignedIn ? 'Signed in' : (cloudAuth.configured ? 'Ready' : 'Not configured')}</b></div>
            <div class="mini-card"><div>User</div><b>${esc(cloudIdentity)}</b></div>
            <div class="mini-card"><div>Organisation</div><b>${cloudOrgId ? esc(cloudOrgId) : 'Not linked'}</b></div>
          </div>
          <div class="btn-row" style="margin-bottom:10px">
            <button class="btn primary" id="btn-cloud-signin" ${cloudAuth.configured && !cloudSignedIn ? '' : 'disabled'}>Sign in to Ledgerly Cloud</button>
            <button class="btn" id="btn-cloud-refresh" ${cloudSignedIn ? '' : 'disabled'}>Refresh session</button>
            <button class="btn" id="btn-cloud-signout" ${cloudSignedIn ? '' : 'disabled'}>Sign out</button>
            <button class="btn primary" id="btn-bank-feed-connect" ${feed.configured ? '' : 'disabled title="Connect Ledgerly Cloud first"'}>Connect bank account</button>
            <button class="btn" id="btn-bank-feed-manage" ${hasConnection ? '' : 'disabled'}>Manage consent</button>
            <button class="btn" id="btn-bank-feed-reconnect" ${hasConnection ? '' : 'disabled'}>Reconnect</button>
            <button class="btn danger" id="btn-bank-feed-revoke" ${hasConnection ? '' : 'disabled'} data-provider-connection-id="${esc(connectionIdForCloud)}">Revoke</button>
            <button class="btn danger" id="btn-bank-feed-delete-data" ${hasConnection ? '' : 'disabled'}>Delete feed data</button>
          </div>
          ${hasConnection ? `
            <div class="mini-grid" style="margin-bottom:10px">
              <div class="mini-card"><div>Consent</div><b>${esc(String(consentStatus || 'unknown'))}</b></div>
              <div class="mini-card"><div>Expires</div><b>${consentExpiry ? esc(new Date(consentExpiry).toLocaleDateString()) : 'Not supplied'}</b></div>
              <div class="mini-card"><div>Institution</div><b>${esc(primaryConnection.institutionName || primaryConnection.institution_name || 'Bank feed')}</b></div>
            </div>` : ''}
          ${(feed.accountLinks || []).length ? `
            <table class="data">
              <thead><tr><th>Provider account</th><th>Ledgerly account</th><th>Institution</th><th>Consent</th><th>Last sync</th><th></th></tr></thead>
              <tbody>${feedLinksHtml}</tbody>
            </table>` : '<div class="empty">No linked bank feeds</div>'}
          ${feed.configured ? '' : `<div class="meta" style="margin-top:8px;color:var(--ink-soft);font-size:12.5px">${esc(feedSetupText)}</div>`}
        </div>

        <div class="card">
          <h2>Local app lock</h2>
          <form id="app-lock-form">
            <label class="checkbox"><input type="checkbox" name="enabled" ${appLock.enabled ? 'checked' : ''} /> Require local passcode on this device</label>
            <label class="field">Passcode<input name="passcode" type="password" inputmode="numeric" autocomplete="new-password" placeholder="${appLock.configured ? 'Enter a new passcode to change it' : 'At least 6 digits'}" /></label>
            <button class="btn primary" type="submit">Save app lock</button>
          </form>
        </div>

        <div class="card" id="ai-card">
          <h2>AI assistant</h2>
          <p style="color:var(--ink-soft);font-size:12.5px;margin-top:0">
            Powers the chat bubble in the bottom-right corner. Your key is stored only in your
            local Ledgerly database and requests are sent directly to the endpoint you choose.
            Pick "Local model" to use Ollama or LM Studio — installed models are detected
            automatically and the server is started in the background on first use.
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
              <label class="field">Model<input name="ai_model" id="ai-model-inp" value="${esc(s.ai_model || '')}" placeholder="e.g. claude-sonnet-4-6" />
                <span id="ai-model-local" style="display:none;gap:6px">
                  <select id="ai-model-sel" style="flex:1"></select>
                  <button class="btn small" type="button" id="ai-model-rescan" title="Rescan local models">↻</button>
                </span>
              </label>
            </div>
            <label class="field">Endpoint URL<input name="ai_base_url" id="ai-url-inp" value="${esc(s.ai_base_url || '')}" placeholder="auto-filled from provider" /></label>
            <div class="field-row">
              <label class="field">API key<input name="ai_api_key" type="password" value="${esc(s.ai_api_key || '')}" placeholder="not needed for most local models" /></label>
              <label class="field">Max response tokens<input name="ai_max_tokens" value="${esc(s.ai_max_tokens || '2048')}" style="max-width:130px" /></label>
              <label class="field">Context length<input name="ai_context_length" value="${esc(s.ai_context_length || '8192')}" style="max-width:130px" title="Token window used when loading local models" /></label>
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

  // ----- organisations: switch / create / delete -----
  document.querySelectorAll('.btn-org-switch').forEach(b => b.addEventListener('click', async () => {
    try {
      await window.ledgerly.orgs('switch', { id: b.dataset.id });
      location.hash = '#/dashboard';
      location.reload();
    } catch (e) { showError(e); }
  }));
  document.getElementById('btn-org-new')?.addEventListener('click', () => {
    location.hash = '#/setup?new=1';
  });
  document.querySelectorAll('.btn-org-del').forEach(b => b.addEventListener('click', () => {
    const { id, name } = b.dataset;
    const m = modal(`
      <h2 style="color:var(--red)">Delete "${esc(name)}"?</h2>
      <p><b>This is irreversible.</b> Every invoice, bill, contact, bank transaction,
        payroll record, report and assistant conversation in this organisation will be
        permanently destroyed. There is no undo and no recovery.</p>
      <p>Type the organisation name to confirm:</p>
      <input id="org-del-confirm" placeholder="${esc(name)}" autocomplete="off" style="width:100%" />
      <div class="btn-row" style="margin-top:14px">
        <button class="btn danger" id="org-del-go" disabled>Delete this organisation forever</button>
        <button class="btn" id="org-del-cancel">Cancel</button>
      </div>`);
    const input = m.querySelector('#org-del-confirm');
    const go = m.querySelector('#org-del-go');
    input.addEventListener('input', () => { go.disabled = input.value.trim() !== name; });
    input.focus();
    m.querySelector('#org-del-cancel').addEventListener('click', closeModal);
    go.addEventListener('click', async () => {
      try {
        await window.ledgerly.orgs('delete', { id, confirmName: input.value });
        location.hash = '#/dashboard';
        location.reload();
      } catch (e) { showError(e); }
    });
  }));

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
    local: { url: 'http://localhost:1234/v1', model: '' },
    custom: { url: '', model: '' },
  };

  // Local provider: the text input is replaced by a dropdown of models
  // auto-detected from Ollama / LM Studio. The dropdown writes into the
  // (hidden) ai_model input so the form submit path stays unchanged.
  const modelInp = document.getElementById('ai-model-inp');
  const modelSel = document.getElementById('ai-model-sel');
  const localWrap = document.getElementById('ai-model-local');
  function applyLocalModelPick() {
    const opt = modelSel.selectedOptions[0];
    if (opt && opt.value) {
      modelInp.value = opt.value;
      document.getElementById('ai-url-inp').value = opt.dataset.url || '';
    }
  }
  async function loadLocalModels() {
    modelSel.innerHTML = '<option value="">Scanning…</option>';
    try {
      const r = await window.ledgerly.assistant('localModels');
      if (!r.models.length) {
        modelSel.innerHTML = '<option value="">No local models found — install Ollama or LM Studio</option>';
        return;
      }
      const current = modelInp.value;
      modelSel.innerHTML = r.models.map(m =>
        `<option value="${esc(m.id)}" data-url="${esc(m.baseUrl)}" ${m.id === current ? 'selected' : ''}>` +
        `${esc(m.id)} — ${esc(m.runtimeLabel)}</option>`).join('');
      applyLocalModelPick();
    } catch (e) {
      modelSel.innerHTML = `<option value="">Scan failed: ${esc(e.message)}</option>`;
    }
  }
  function syncLocalModelUI() {
    const isLocal = document.getElementById('ai-provider-sel').value === 'local';
    modelInp.style.display = isLocal ? 'none' : '';
    localWrap.style.display = isLocal ? 'flex' : 'none';
    if (isLocal) loadLocalModels();
  }
  modelSel.addEventListener('change', applyLocalModelPick);
  document.getElementById('ai-model-rescan').addEventListener('click', loadLocalModels);
  syncLocalModelUI();

  document.getElementById('ai-provider-sel').addEventListener('change', (ev) => {
    const p = AI_PRESETS[ev.target.value];
    if (p) {
      document.getElementById('ai-url-inp').value = p.url;
      document.getElementById('ai-model-inp').value = p.model;
    }
    syncLocalModelUI();
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

  document.getElementById('btn-bank-feed-connect')?.addEventListener('click', async () => {
    try {
      await window.ledgerly.bankFeed('startConnect', {});
      toast('Bank consent opened', 'success');
      VIEWS.settingsView(main);
    } catch (e) { showError(e); }
  });
  document.getElementById('btn-bank-feed-manage')?.addEventListener('click', async () => {
    try {
      await window.ledgerly.bankFeed('manageConsent', {});
      toast('Consent management opened', 'success');
    } catch (e) { showError(e); }
  });
  document.getElementById('btn-bank-feed-reconnect')?.addEventListener('click', async () => {
    try {
      await window.ledgerly.bankFeed('manageConsent', { action: 'reconnect' });
      toast('Reconnect consent opened', 'success');
    } catch (e) { showError(e); }
  });
  document.getElementById('btn-bank-feed-revoke')?.addEventListener('click', async (ev) => {
    if (!confirm('Revoke this bank feed consent? Local accounting history stays in Ledgerly.')) return;
    try {
      await window.ledgerly.bankFeed('revokeConsent', { providerConnectionId: ev.currentTarget.dataset.providerConnectionId || '' });
      toast('Bank feed consent revoked', 'success');
      VIEWS.settingsView(main);
    } catch (e) { showError(e); }
  });
  document.getElementById('btn-bank-feed-delete-data')?.addEventListener('click', async () => {
    if (!confirm('Request deletion of redundant bank feed data and remove local feed mappings? Reconciled accounting history stays in Ledgerly.')) return;
    try {
      await window.ledgerly.bankFeed('requestDataDeletion', { reason: 'user_requested' });
      for (const link of feed.accountLinks || []) {
        await window.ledgerly.bankFeed('disconnectLocalMapping', { linkId: Number(link.id) });
      }
      toast('Bank feed data deletion requested', 'success');
      VIEWS.settingsView(main);
    } catch (e) { showError(e); }
  });
  document.getElementById('btn-cloud-signin')?.addEventListener('click', async () => {
    try {
      await window.ledgerly.cloudAuth('signIn', {});
      toast('Signed in to Ledgerly Cloud', 'success');
      VIEWS.settingsView(main);
    } catch (e) { showError(e); }
  });
  document.getElementById('btn-cloud-refresh')?.addEventListener('click', async () => {
    try {
      await window.ledgerly.cloudAuth('refresh', {});
      toast('Ledgerly Cloud session refreshed', 'success');
      VIEWS.settingsView(main);
    } catch (e) { showError(e); }
  });
  document.getElementById('btn-cloud-signout')?.addEventListener('click', async () => {
    if (!confirm('Sign out of Ledgerly Cloud on this device? Local accounting data stays in Ledgerly.')) return;
    try {
      if (window.ledgerly.cloudAuth) await window.ledgerly.cloudAuth('signOut', {});
      await window.ledgerly.cloudSession('signOut', {});
      toast('Signed out of Ledgerly Cloud', 'success');
      VIEWS.settingsView(main);
    } catch (e) { showError(e); }
  });
  document.getElementById('app-lock-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const form = new FormData(ev.target);
      await window.ledgerly.security('configureLock', {
        enabled: form.get('enabled') === 'on',
        passcode: form.get('passcode') || '',
      });
      toast('App lock settings saved', 'success');
      VIEWS.settingsView(main);
    } catch (e) { showError(e); }
  });
  on(main, '.btn-feed-unlink', 'click', async (ev) => {
    if (!confirm('Remove this local bank feed mapping? Imported and reconciled accounting history stays in Ledgerly.')) return;
    try {
      await window.ledgerly.bankFeed('disconnectLocalMapping', { linkId: Number(ev.target.dataset.id) });
      toast('Bank feed mapping removed', 'success');
      VIEWS.settingsView(main);
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
