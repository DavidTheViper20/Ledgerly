'use strict';

// Floating AI assistant: chat bubble bottom-right, slide-up panel with
// history, attachments and tool-usage indicators.

(function () {
  const host = document.createElement('div');
  host.id = 'assistant-host';
  host.innerHTML = `
    <div id="ai-panel" hidden>
      <div class="ai-head">
        <span class="ai-title">Ledgerly Assistant</span>
        <span class="ai-sub" id="ai-provider-label"></span>
        <span style="flex:1"></span>
        <button class="ai-icon" id="ai-clear" title="Clear conversation">🗑</button>
        <button class="ai-icon" id="ai-settings" title="AI settings">⚙</button>
        <button class="ai-icon" id="ai-close" title="Close">✕</button>
      </div>
      <div class="ai-msgs" id="ai-msgs"></div>
      <div class="ai-attach-row" id="ai-attach-row" hidden></div>
      <form class="ai-input" id="ai-form">
        <button type="button" class="ai-icon" id="ai-attach" title="Attach files (images, PDF, CSV…)">📎</button>
        <textarea id="ai-text" rows="1" placeholder="Ask about your books, the app, or anything…"></textarea>
        <button type="submit" class="ai-send" id="ai-send" title="Send">➤</button>
      </form>
      <input type="file" id="ai-file" multiple hidden
        accept="image/*,.pdf,.csv,.txt,.md,.json,.log" />
    </div>
    <button id="ai-bubble" title="Ledgerly Assistant">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
      </svg>
    </button>`;
  host.hidden = true; // shown only once an AI provider is configured in Settings
  document.body.appendChild(host);

  const panel = document.getElementById('ai-panel');
  const bubble = document.getElementById('ai-bubble');
  const msgsEl = document.getElementById('ai-msgs');
  const textEl = document.getElementById('ai-text');
  const fileEl = document.getElementById('ai-file');
  const attachRow = document.getElementById('ai-attach-row');
  const sendBtn = document.getElementById('ai-send');

  let attachments = []; // { name, mime, dataBase64 }
  let busy = false;
  let loaded = false;

  // Show the bubble only when an AI provider is configured; called from
  // loadRefData() so it tracks settings changes without a restart.
  window.assistantSyncVisibility = function () {
    const configured = !!((window.STATE && STATE.settings && STATE.settings.ai_provider) || '').trim();
    host.hidden = !configured;
    if (!configured) {
      panel.hidden = true;
      bubble.classList.remove('open');
    }
  };

  // Very small markdown-ish formatter: escapes HTML then applies bold,
  // inline code, code fences, links and bullet lines.
  function md(text) {
    let h = esc(text);
    h = h.replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${code.replace(/^\n|\n$/g, '')}</pre>`);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" class="ai-link">$1</a>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/^### (.*)$/gm, '<b>$1</b>');
    h = h.replace(/^## (.*)$/gm, '<b>$1</b>');
    h = h.replace(/^[-*] (.*)$/gm, '• $1');
    h = h.replace(/\n/g, '<br>');
    return h;
  }

  function sourcesHtml(sources) {
    if (!sources || !sources.length) return '';
    return `<details class="ai-sources"><summary>Sources (${sources.length})</summary>` +
      sources.map(s =>
        `<div class="ai-source"><a href="${esc(s.url)}" class="ai-link">${esc(s.title || s.url)}</a>` +
        (s.snippet ? `<div class="ai-source-sn">${esc(s.snippet)}</div>` : '') + '</div>').join('') +
      '</details>';
  }

  function thinkHtml(think, collapsed) {
    if (!think) return '';
    return collapsed
      ? `<details class="ai-think"><summary>Thinking</summary><div class="ai-think-body">${esc(think)}</div></details>`
      : `<div class="ai-think-live">${esc(think)}</div>`;
  }

  const TOOL_LABELS = {
    web_search: 'Searching the web…',
    read_webpage: 'Reading a page…',
    calculate: 'Calculating…',
  };

  function addMsg(role, html, meta = '') {
    const div = document.createElement('div');
    div.className = 'ai-msg ' + role;
    div.innerHTML = `<div class="ai-bubble-msg">${html}${meta ? `<div class="ai-meta">${meta}</div>` : ''}</div>`;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return div;
  }

  function toolMeta(tools) {
    if (!tools || !tools.length) return '';
    return '🔍 ' + tools.map(esc).join(' · ');
  }

  async function loadHistory() {
    msgsEl.innerHTML = '';
    try {
      const hist = await window.ledgerly.assistant('history');
      if (!hist.length) {
        addMsg('assistant', md(
          "G'day! I'm your Ledgerly assistant. I can look up your invoices, bills, contacts, " +
          'bank balances and reports, explain how anything in the app works, do precise calculations, ' +
          'read attachments (receipts, statements, contracts) and answer general GST/BAS questions.\n\n' +
          'Try: **"Who owes me money right now?"** or **"How do I fix an approved invoice?"**'));
        return;
      }
      for (const m of hist) {
        let tools = [], sources = [];
        try { tools = JSON.parse(m.tools_used || '[]'); } catch {}
        try { sources = JSON.parse(m.sources || '[]'); } catch {}
        addMsg(m.role, md(m.content) + sourcesHtml(sources), m.role === 'assistant' ? toolMeta(tools) : '');
      }
    } catch (e) {
      addMsg('assistant', md('Could not load chat history: ' + e.message));
    }
  }

  function renderAttachRow() {
    attachRow.hidden = attachments.length === 0;
    attachRow.innerHTML = attachments.map((a, i) =>
      `<span class="ai-chip">${esc(a.name)} <button data-i="${i}" type="button">×</button></span>`).join('');
    attachRow.querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => { attachments.splice(Number(b.dataset.i), 1); renderAttachRow(); }));
  }

  function setBusy(b) {
    busy = b;
    sendBtn.disabled = b;
    textEl.disabled = b;
  }

  async function send() {
    const message = textEl.value.trim();
    if ((!message && !attachments.length) || busy) return;
    if (!(STATE.settings.ai_provider || '').trim()) {
      addMsg('assistant', md('No AI provider configured yet. Open **Settings → AI assistant**, pick a provider (Anthropic, OpenAI, DeepSeek or a local model) and add your key.'));
      return;
    }
    const atts = attachments;
    attachments = [];
    renderAttachRow();
    textEl.value = '';
    textEl.style.height = 'auto';
    addMsg('user', md(message) + (atts.length ? `<div class="ai-meta">📎 ${atts.map(a => esc(a.name)).join(', ')}</div>` : ''));
    const pending = addMsg('assistant', '');
    const bubbleMsg = pending.querySelector('.ai-bubble-msg');

    // Streaming state: a status row ("Thinking…", "Searching the web…")
    // shows until the first reply token; thinking streams into a small
    // fixed-height window that collapses once the reply starts.
    let think = '', reply = '', label = 'Thinking…';
    function render(final, result) {
      let html = '';
      if (!final && !reply) {
        html += `<span class="ai-status"><span class="ai-thinking"><span></span><span></span><span></span></span>` +
          `<span class="ai-status-label">${esc(label)}</span></span>`;
      }
      html += thinkHtml(think, final || !!reply);
      if (reply || final) html += `<div class="ai-reply">${md(final ? result.reply : reply)}</div>`;
      if (final) {
        html += sourcesHtml(result.sources);
        if (result.toolsUsed?.length) html += `<div class="ai-meta">${toolMeta(result.toolsUsed)}</div>`;
      }
      bubbleMsg.innerHTML = html;
      const live = bubbleMsg.querySelector('.ai-think-live');
      if (live) live.scrollTop = live.scrollHeight;
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
    render(false);
    setBusy(true);
    try {
      const r = await window.ledgerly.assistantStream({ message, attachments: atts }, (ev) => {
        if (ev.type === 'status') { label = ev.label; }
        else if (ev.type === 'tool') { label = TOOL_LABELS[ev.name] || `Checking ${ev.name.replace(/_/g, ' ')}…`; }
        else if (ev.type === 'thinking') { think += ev.text; label = 'Thinking…'; }
        else if (ev.type === 'reply') { reply += ev.text; }
        render(false);
      });
      render(true, r);
    } catch (e) {
      bubbleMsg.innerHTML = `<span class="ai-error">${esc(e.message)}</span>`;
    } finally {
      setBusy(false);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      textEl.focus();
    }
  }

  // All links in the assistant open in the user's default browser.
  host.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('a[href^="http"]');
    if (a) { ev.preventDefault(); window.ledgerly.openExternal(a.href); }
  });

  bubble.addEventListener('click', async () => {
    panel.hidden = !panel.hidden;
    bubble.classList.toggle('open', !panel.hidden);
    if (!panel.hidden) {
      document.getElementById('ai-provider-label').textContent =
        STATE.settings.ai_provider ? `${STATE.settings.ai_provider} · ${STATE.settings.ai_model || ''}` : 'not configured';
      if (!loaded) { loaded = true; await loadHistory(); }
      textEl.focus();
    }
  });
  document.getElementById('ai-close').addEventListener('click', () => {
    panel.hidden = true;
    bubble.classList.remove('open');
  });
  document.getElementById('ai-settings').addEventListener('click', () => {
    panel.hidden = true;
    bubble.classList.remove('open');
    location.hash = '#/settings?focus=ai';
  });
  document.getElementById('ai-clear').addEventListener('click', async () => {
    if (!confirm('Clear the whole conversation?')) return;
    await window.ledgerly.assistant('clear');
    loadHistory();
  });

  document.getElementById('ai-attach').addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', async () => {
    for (const f of fileEl.files) {
      if (f.size > 8 * 1024 * 1024) { toast(`${f.name} is over 8 MB — skipped`, 'error'); continue; }
      const buf = await f.arrayBuffer();
      let b64 = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) {
        b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      attachments.push({ name: f.name, mime: f.type || 'application/octet-stream', dataBase64: btoa(b64) });
    }
    fileEl.value = '';
    renderAttachRow();
  });

  document.getElementById('ai-form').addEventListener('submit', (ev) => { ev.preventDefault(); send(); });
  textEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
  textEl.addEventListener('input', () => {
    textEl.style.height = 'auto';
    textEl.style.height = Math.min(textEl.scrollHeight, 120) + 'px';
  });
})();
