'use strict';

// Ledgerly AI assistant. Runs in the Electron main process so API keys never
// reach the renderer. Two wire formats are supported:
//   - anthropic: Anthropic Messages API
//   - openai:    OpenAI-compatible chat completions (OpenAI, DeepSeek,
//                Ollama, LM Studio, vLLM, any compatible local server)
// The assistant gets READ-ONLY tools over the ledger plus a calculator and a
// persistent memory. It cannot create or modify records (yet).

const { getSetting, setSetting } = require('../db');
const api = require('../api');

const PROVIDER_PRESETS = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', format: 'anthropic' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', format: 'openai' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', format: 'openai' },
  local: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', format: 'openai' },
  custom: { baseUrl: '', model: '', format: 'openai' },
};

function aiConfig(db) {
  const provider = getSetting(db, 'ai_provider') || '';
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  return {
    provider,
    baseUrl: (getSetting(db, 'ai_base_url') || preset.baseUrl).replace(/\/+$/, ''),
    apiKey: getSetting(db, 'ai_api_key') || '',
    model: getSetting(db, 'ai_model') || preset.model,
    format: provider === 'anthropic' ? 'anthropic' : 'openai',
    maxTokens: parseInt(getSetting(db, 'ai_max_tokens') || '2048', 10),
  };
}

// ---------- tools ----------
// Provider-agnostic definitions, converted per wire format below.

const TOOLS = [
  {
    name: 'list_documents',
    description: 'List invoices, bills or credit notes. kind: ACCREC (sales invoices), ACCPAY (bills), ACCRECCREDIT (credit notes), ACCPAYCREDIT (supplier credits). status optional: DRAFT, SUBMITTED, AUTHORISED (awaiting payment), OVERDUE, PAID, VOIDED. search matches number/reference/contact. Amounts are integer cents.',
    params: { kind: { type: 'string', required: true }, status: { type: 'string' }, search: { type: 'string' } },
    run: (db, a) => api.call(db, 'invoices.list', { kind: a.kind || 'ACCREC', status: a.status || null, search: a.search || null })
      .slice(0, 50).map(d => ({
        id: d.id, number: d.number, reference: d.reference, contact: d.contact_name,
        issue_date: d.issue_date, due_date: d.due_date, status: d.status,
        total_cents: d.total_cents, due_cents: d.total_cents - d.paid_cents,
        currency: d.currency || 'AUD',
      })),
  },
  {
    name: 'get_document',
    description: 'Get one invoice/bill/credit note with line items, payments and credit allocations, by id.',
    params: { id: { type: 'number', required: true } },
    run: (db, a) => {
      const d = api.call(db, 'invoices.get', { id: Number(a.id) });
      return {
        id: d.id, kind: d.kind, number: d.number, reference: d.reference, contact: d.contact_name,
        issue_date: d.issue_date, due_date: d.due_date, status: d.status, currency: d.currency || 'AUD',
        subtotal_cents: d.subtotal_cents, tax_cents: d.tax_cents, total_cents: d.total_cents,
        paid_or_credited_cents: d.paid_cents,
        lines: d.lines.map(l => ({ description: l.description, qty: l.qty, unit_price_cents: l.unit_price_cents, account: l.account_name, tax: l.tax_name, net_cents: l.net_cents })),
        payments: d.payments.map(p => ({ date: p.date, amount_cents: p.amount_cents, bank: p.bank_name })),
        allocations: d.allocations.map(x => ({ date: x.date, amount_cents: x.amount_cents, credit_number: x.credit_number, invoice_number: x.invoice_number })),
      };
    },
  },
  {
    name: 'list_contacts',
    description: 'List contacts. filter: all, customers, suppliers. Includes what they owe you and what you owe them (cents, AUD).',
    params: { filter: { type: 'string' }, search: { type: 'string' } },
    run: (db, a) => api.call(db, 'contacts.list', { filter: a.filter || 'all', search: a.search || '' })
      .slice(0, 50).map(c => ({ id: c.id, name: c.name, email: c.email, is_customer: !!c.is_customer, is_supplier: !!c.is_supplier, they_owe_cents: c.they_owe_cents, you_owe_cents: c.you_owe_cents })),
  },
  {
    name: 'bank_accounts',
    description: 'Bank accounts with ledger balance, statement balance and unreconciled item counts (cents).',
    params: {},
    run: (db) => api.call(db, 'bank.accounts').map(b => ({ id: b.id, name: b.name, balance_cents: b.balance_cents, statement_balance_cents: b.statement_balance_cents, items_to_reconcile: b.unreconciled })),
  },
  {
    name: 'profit_and_loss',
    description: 'Profit & Loss between two dates (YYYY-MM-DD). Amounts in cents.',
    params: { from: { type: 'string', required: true }, to: { type: 'string', required: true } },
    run: (db, a) => api.call(db, 'reports.profitAndLoss', { from: a.from, to: a.to }),
  },
  {
    name: 'balance_sheet',
    description: 'Balance sheet as at a date (YYYY-MM-DD). Amounts in cents.',
    params: { asAt: { type: 'string', required: true } },
    run: (db, a) => api.call(db, 'reports.balanceSheet', { asAt: a.asAt }),
  },
  {
    name: 'bas_summary',
    description: 'Australian BAS (activity statement) summary between dates: G1 sales, 1A GST on sales, 1B GST on purchases, W1 wages, W2 PAYG withheld, net amounts. Cents.',
    params: { from: { type: 'string', required: true }, to: { type: 'string', required: true } },
    run: (db, a) => api.call(db, 'reports.bas', { from: a.from, to: a.to }),
  },
  {
    name: 'aged_balances',
    description: 'Aged receivables (who owes us) or payables (who we owe) as at a date, bucketed by days overdue. side: receivables | payables.',
    params: { side: { type: 'string', required: true }, asAt: { type: 'string' } },
    run: (db, a) => api.call(db, a.side === 'payables' ? 'reports.agedPayables' : 'reports.agedReceivables',
      { asAt: a.asAt || new Date().toISOString().slice(0, 10) }),
  },
  {
    name: 'cash_flow_forecast',
    description: 'Weekly cash flow forecast: opening bank balance plus invoices due in minus bills due out.',
    params: { weeks: { type: 'number' } },
    run: (db, a) => api.call(db, 'reports.cashFlowForecast', { weeks: Number(a.weeks) || 8 }),
  },
  {
    name: 'list_projects',
    description: 'Projects with revenue, costs and profit (cents).',
    params: {},
    run: (db) => api.call(db, 'projects.list', {}).map(p => ({ id: p.id, name: p.name, customer: p.contact_name, status: p.status, revenue_cents: p.revenue_cents, cost_cents: p.cost_cents, profit_cents: p.profit_cents })),
  },
  {
    name: 'list_pay_runs',
    description: 'Payroll pay runs with gross, PAYG, super and net totals (cents).',
    params: {},
    run: (db) => api.call(db, 'payroll.listRuns').map(r => ({ id: r.id, period: `${r.period_start} to ${r.period_end}`, status: r.status, paid: !!r.paid_journal_id, ...r.totals })),
  },
  {
    name: 'list_expense_claims',
    description: 'Expense claims with payee, status and totals (cents).',
    params: {},
    run: (db) => api.call(db, 'claims.list', {}).map(c => ({ id: c.id, number: c.number, payee: c.payee, date: c.date, status: c.status, total_cents: c.total_cents })),
  },
  {
    name: 'list_fixed_assets',
    description: 'Fixed asset register: cost, accumulated depreciation, book value (cents).',
    params: {},
    run: (db) => api.call(db, 'assets.list', {}).map(x => ({ id: x.id, name: x.name, status: x.status, purchase_date: x.purchase_date, cost_cents: x.cost_cents, accumulated_cents: x.accumulated_cents, book_value_cents: x.book_value_cents })),
  },
  {
    name: 'calculate',
    description: 'Evaluate an arithmetic expression precisely. Supports + - * / % ( ) and decimal numbers. Use this for any non-trivial maths.',
    params: { expression: { type: 'string', required: true } },
    run: (_db, a) => ({ expression: a.expression, result: safeCalc(a.expression) }),
  },
  {
    name: 'remember',
    description: 'Save a short note to your persistent memory. Use when the user tells you a preference or fact worth keeping (e.g. "always quote in USD for Acme"). Saved notes are shown to you in every future conversation.',
    params: { note: { type: 'string', required: true } },
    run: (db, a) => {
      const note = String(a.note || '').slice(0, 500);
      if (!note.trim()) throw new Error('Empty note');
      db.prepare('INSERT INTO assistant_memory (note) VALUES (?)').run(note.trim());
      return { saved: true, note };
    },
  },
];

// Minimal arithmetic evaluator (shunting-yard) — no eval, no Function.
function safeCalc(expr) {
  const tokens = String(expr).match(/\d+\.?\d*|[+\-*/%()]/g);
  if (!tokens || tokens.join('').replace(/\s/g, '') !== String(expr).replace(/[\s,]/g, '')) {
    throw new Error('Only numbers and + - * / % ( ) are supported');
  }
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };
  const out = [], ops = [];
  let prevWasValue = false;
  for (const t of tokens) {
    if (/^[\d.]/.test(t)) { out.push(parseFloat(t)); prevWasValue = true; }
    else if (t === '(') { ops.push(t); prevWasValue = false; }
    else if (t === ')') {
      while (ops.length && ops.at(-1) !== '(') out.push(ops.pop());
      ops.pop();
      prevWasValue = true;
    } else {
      let op = t;
      if (op === '-' && !prevWasValue) { out.push(0); } // unary minus
      while (ops.length && prec[ops.at(-1)] >= prec[op]) out.push(ops.pop());
      ops.push(op);
      prevWasValue = false;
    }
  }
  while (ops.length) out.push(ops.pop());
  const st = [];
  for (const t of out) {
    if (typeof t === 'number') st.push(t);
    else {
      const b = st.pop(), a = st.pop();
      if (a === undefined || b === undefined) throw new Error('Invalid expression');
      st.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : t === '/' ? a / b : a % b);
    }
  }
  if (st.length !== 1 || !isFinite(st[0])) throw new Error('Invalid expression');
  return st[0];
}

function executeTool(db, name, args) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    return tool.run(db, args || {});
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- system prompt ----------

const APP_GUIDE = `
You are the built-in assistant for Ledgerly, a desktop accounting app for Australian
small businesses. You are embedded in the app and can look up live data with your tools.

How Ledgerly works (use this to answer "how do I" questions):
- Dashboard: bank balances, cash in/out chart, invoice/bill totals.
- Business menu: Invoices, Quotes, Bills to pay, Purchase orders, Repeating invoices,
  Expense claims, Products & services.
  - Invoices/bills lifecycle: Draft -> (optional Submit for approval) -> Approve (posts to
    the ledger; document becomes immutable) -> Record payment -> Paid. Mistakes are fixed
    by voiding (reverses the ledger) or issuing a credit note (+ New -> Credit note),
    which is approved then allocated to a document or refunded in cash.
  - Quotes convert to invoices; purchase orders convert to bills; repeating templates
    auto-generate on schedule when the app starts.
  - Expense claims: receipts entered GST-inclusive; approving posts the GST credit and a
    reimbursement liability; pay it from a bank account.
- Accounting menu: Bank accounts (spend/receive money, transfers, CSV statement import,
  reconciliation with match suggestions), Reports, Chart of accounts, Fixed assets
  (straight-line depreciation runs, disposal), Manual journals, Budget manager.
- Projects: time entries, invoice unbilled time, profitability. Payroll: employees,
  draft pay runs with editable PAYG estimates and super, post then pay wages.
- Reports: P&L, Balance Sheet, Trial Balance, Aged Receivables/Payables, Account
  Transactions, GST Summary, BAS summary (G1/1A/1B/W1/W2), Cash Flow Forecast,
  Budget vs Actual. All printable / exportable to PDF.
- Settings: organisation & ABN, invoice numbering, tax rates, super %, AI assistant.

Rules:
- All amounts from tools are integer cents — divide by 100 and format as currency
  (the org base currency, usually AUD) before showing the user.
- Use the calculate tool for any arithmetic beyond trivial sums.
- For Australian tax/legal questions (GST, BAS, PAYG, super, Fair Work, etc.) give
  accurate general information for Victoria/Australia where you can, and note that it is
  general information, not professional tax or legal advice.
- Be concise and concrete. When you used tools, base your numbers on the tool results.
- If the user asks you to create or change records, explain you are read-only for now
  and tell them exactly where in the app to do it themselves.
`;

function buildSystemPrompt(db) {
  const org = getSetting(db, 'org_name') || 'this organisation';
  const currency = getSetting(db, 'base_currency') || 'AUD';
  const fyEnd = `${getSetting(db, 'fy_end_day') || 30}/${getSetting(db, 'fy_end_month') || 6}`;
  const memories = db.prepare('SELECT note FROM assistant_memory ORDER BY id DESC LIMIT 30').all();
  return APP_GUIDE +
    `\nContext: organisation "${org}", base currency ${currency}, financial year ends ${fyEnd}, ` +
    `today is ${new Date().toISOString().slice(0, 10)}.` +
    (memories.length ? `\nYour saved memory notes (most recent first):\n${memories.map(m => '- ' + m.note).join('\n')}` : '');
}

// ---------- attachments ----------
// att: { name, mime, dataBase64 }

function isTexty(att) {
  return /^text\/|json|csv|xml/.test(att.mime || '') || /\.(txt|csv|md|json|log)$/i.test(att.name || '');
}

function attachmentNote(atts) {
  if (!atts || !atts.length) return '';
  return '\n\n[Attached: ' + atts.map(a => a.name).join(', ') + ']';
}

// ---------- provider adapters with tool loop ----------

async function httpJson(url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text.slice(0, 300);
      throw new Error(`AI provider error (${res.status}): ${msg}`);
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function toolsForAnthropic() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, { type: v.type }])),
      required: Object.entries(t.params).filter(([, v]) => v.required).map(([k]) => k),
    },
  }));
}

function toolsForOpenAI() {
  return TOOLS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, { type: v.type }])),
        required: Object.entries(t.params).filter(([, v]) => v.required).map(([k]) => k),
      },
    },
  }));
}

function anthropicUserContent(text, atts) {
  const blocks = [];
  for (const a of atts || []) {
    if ((a.mime || '').startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.dataBase64 } });
    } else if (a.mime === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.dataBase64 } });
    } else if (isTexty(a)) {
      const body = Buffer.from(a.dataBase64, 'base64').toString('utf8').slice(0, 60000);
      blocks.push({ type: 'text', text: `Contents of attached file "${a.name}":\n${body}` });
    } else {
      blocks.push({ type: 'text', text: `(Attachment "${a.name}" of type ${a.mime} is not supported and was skipped.)` });
    }
  }
  blocks.push({ type: 'text', text: text || '(no message)' });
  return blocks;
}

function openaiUserContent(text, atts) {
  const parts = [];
  let extraText = '';
  for (const a of atts || []) {
    if ((a.mime || '').startsWith('image/')) {
      parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.dataBase64}` } });
    } else if (isTexty(a)) {
      const body = Buffer.from(a.dataBase64, 'base64').toString('utf8').slice(0, 60000);
      extraText += `\n\nContents of attached file "${a.name}":\n${body}`;
    } else {
      extraText += `\n\n(Attachment "${a.name}" of type ${a.mime} is not supported by this provider and was skipped.)`;
    }
  }
  const full = (text || '(no message)') + extraText;
  if (!parts.length) return full;
  parts.push({ type: 'text', text: full });
  return parts;
}

const MAX_TOOL_ROUNDS = 6;

async function runAnthropic(db, cfg, history, userText, atts, toolsUsed) {
  if (!cfg.apiKey) throw new Error('Set your Anthropic API key in Settings → AI assistant');
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: anthropicUserContent(userText, atts) });
  const headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await httpJson(`${cfg.baseUrl}/v1/messages`, headers, {
      model: cfg.model, max_tokens: cfg.maxTokens,
      system: buildSystemPrompt(db), tools: toolsForAnthropic(), messages,
    });
    const toolUses = (res.content || []).filter(b => b.type === 'tool_use');
    if (!toolUses.length || res.stop_reason !== 'tool_use') {
      return (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
        || '(The model returned an empty response.)';
    }
    messages.push({ role: 'assistant', content: res.content });
    const results = toolUses.map(tu => {
      toolsUsed.push(tu.name);
      const out = executeTool(db, tu.name, tu.input);
      return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 30000) };
    });
    messages.push({ role: 'user', content: results });
  }
  throw new Error('The assistant used too many tool calls in one turn');
}

async function runOpenAI(db, cfg, history, userText, atts, toolsUsed) {
  const messages = [{ role: 'system', content: buildSystemPrompt(db) }];
  for (const m of history) messages.push({ role: m.role, content: m.content });
  messages.push({ role: 'user', content: openaiUserContent(userText, atts) });
  const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await httpJson(`${cfg.baseUrl}/chat/completions`, headers, {
      model: cfg.model, max_tokens: cfg.maxTokens, tools: toolsForOpenAI(), messages,
    });
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error('Malformed response from AI provider');
    if (!msg.tool_calls || !msg.tool_calls.length) {
      return (msg.content || '').trim() || '(The model returned an empty response.)';
    }
    messages.push(msg);
    for (const tc of msg.tool_calls) {
      toolsUsed.push(tc.function.name);
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
      const out = executeTool(db, tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 30000) });
    }
  }
  throw new Error('The assistant used too many tool calls in one turn');
}

// ---------- public API ----------

function history(db, limit = 60) {
  return db.prepare('SELECT id, role, content, tools_used, created_at FROM chat_messages ORDER BY id DESC LIMIT ?')
    .all(limit).reverse();
}

function clearHistory(db) {
  db.prepare('DELETE FROM chat_messages').run();
  return { ok: true };
}

function memories(db) {
  return db.prepare('SELECT id, note, created_at FROM assistant_memory ORDER BY id DESC').all();
}

function forget(db, id) {
  db.prepare('DELETE FROM assistant_memory WHERE id = ?').run(id);
  return { ok: true };
}

async function chat(db, { message, attachments = [] }) {
  const cfg = aiConfig(db);
  if (!cfg.provider) throw new Error('Choose an AI provider in Settings → AI assistant first');
  if (!cfg.baseUrl) throw new Error('Set the AI endpoint URL in Settings → AI assistant');
  if (!cfg.model) throw new Error('Set the model name in Settings → AI assistant');
  if (!message && !attachments.length) throw new Error('Type a message first');

  // Last 16 stored turns become plain-text context.
  const hist = history(db, 16).map(m => ({ role: m.role, content: m.content }));
  const toolsUsed = [];
  const reply = cfg.format === 'anthropic'
    ? await runAnthropic(db, cfg, hist, message, attachments, toolsUsed)
    : await runOpenAI(db, cfg, hist, message, attachments, toolsUsed);

  db.prepare('INSERT INTO chat_messages (role, content) VALUES (?, ?)')
    .run('user', (message || '') + attachmentNote(attachments));
  db.prepare('INSERT INTO chat_messages (role, content, tools_used) VALUES (?, ?, ?)')
    .run('assistant', reply, JSON.stringify([...new Set(toolsUsed)]));
  return { reply, toolsUsed: [...new Set(toolsUsed)] };
}

async function testConnection(db) {
  const cfg = aiConfig(db);
  if (!cfg.provider || !cfg.baseUrl || !cfg.model) throw new Error('Fill in provider, endpoint and model first');
  if (cfg.format === 'anthropic') {
    const res = await httpJson(`${cfg.baseUrl}/v1/messages`,
      { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      { model: cfg.model, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with OK' }] });
    return { ok: true, reply: (res.content || []).map(b => b.text || '').join('') };
  }
  const res = await httpJson(`${cfg.baseUrl}/chat/completions`,
    cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    { model: cfg.model, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with OK' }] });
  return { ok: true, reply: res.choices?.[0]?.message?.content || '' };
}

module.exports = {
  chat, history, clearHistory, memories, forget, testConnection,
  aiConfig, PROVIDER_PRESETS, executeTool, safeCalc, TOOLS, buildSystemPrompt,
};
