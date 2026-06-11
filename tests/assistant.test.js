'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');
const assistant = require('../src/services/assistant');

let db;
const realFetch = global.fetch;
beforeEach(() => { db = dbm.open(':memory:'); });
afterEach(() => { global.fetch = realFetch; });

const call = (m, a) => api.call(db, m, a);

function setupOrg() {
  const c = call('contacts.save', { name: 'Acme Pty Ltd' });
  const sales = db.prepare("SELECT * FROM accounts WHERE code='200'").get();
  const inv = call('invoices.save', {
    kind: 'ACCREC', contactId: c.id, issueDate: '2026-01-10', dueDate: '2026-01-24', taxMode: 'none',
    lines: [{ description: 'Consulting', qty: 2, unitPriceCents: 50000, accountId: sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  return { c, inv };
}

function setAi(kv) {
  call('settings.update', { ai_provider: 'custom', ai_base_url: 'http://mock.test/v1', ai_model: 'test-model', ...kv });
}

function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    const out = handler(calls.length, body, url);
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  return calls;
}

// ---------- calculator ----------

test('assistant: safeCalc handles precedence, parens, unary minus; rejects junk', () => {
  assert.equal(assistant.safeCalc('2+3*4'), 14);
  assert.equal(assistant.safeCalc('(2+3)*4'), 20);
  assert.equal(assistant.safeCalc('-5 + 10'), 5);
  assert.equal(assistant.safeCalc('1234.56 * 0.1'), 123.456);
  assert.throws(() => assistant.safeCalc('process.exit(1)'));
  assert.throws(() => assistant.safeCalc('2+'));
});

// ---------- tools ----------

test('assistant: tools read live ledger data', () => {
  const { inv } = setupOrg();
  const docs = assistant.executeTool(db, 'list_documents', { kind: 'ACCREC' });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].total_cents, 100000);
  const one = assistant.executeTool(db, 'get_document', { id: inv.id });
  assert.equal(one.lines[0].description, 'Consulting');
  const banks = assistant.executeTool(db, 'bank_accounts', {});
  assert.deepEqual(banks, []);
  const bad = assistant.executeTool(db, 'nope', {});
  assert.match(bad.error, /Unknown tool/);
});

test('assistant: remember tool persists into memory and the system prompt', () => {
  assistant.executeTool(db, 'remember', { note: 'Acme always pays late' });
  const mems = assistant.memories(db);
  assert.equal(mems.length, 1);
  assert.ok(assistant.buildSystemPrompt(db).includes('Acme always pays late'));
  assistant.forget(db, mems[0].id);
  assert.equal(assistant.memories(db).length, 0);
});

// ---------- OpenAI-format adapter with tool loop ----------

test('assistant: openai adapter runs tool loop and persists history', async () => {
  setupOrg();
  setAi({ ai_api_key: 'sk-test' });
  const calls = mockFetch((n, body) => {
    if (n === 1) {
      // Model asks for the invoice list
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'tc1', type: 'function', function: { name: 'list_documents', arguments: '{"kind":"ACCREC"}' } },
      ] } }] };
    }
    // Second round: model has the tool result and answers
    const toolMsg = body.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg, 'tool result was sent back');
    assert.ok(toolMsg.content.includes('100000'), 'tool result contains invoice total');
    return { choices: [{ message: { role: 'assistant', content: 'You have 1 invoice totalling $1,000.00 awaiting payment.' } }] };
  });

  const r = await assistant.chat(db, { message: 'What invoices do I have?' });
  assert.match(r.reply, /1 invoice/);
  assert.deepEqual(r.toolsUsed, ['list_documents']);
  // Request shape
  assert.equal(calls[0].url, 'http://mock.test/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test');
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.ok(calls[0].body.messages[0].content.includes('Ledgerly'));
  assert.ok(calls[0].body.tools.find(t => t.function.name === 'calculate'));
  // History persisted
  const hist = assistant.history(db);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].role, 'user');
  assert.equal(hist[1].role, 'assistant');
  assert.deepEqual(JSON.parse(hist[1].tools_used), ['list_documents']);
});

test('assistant: history is sent as context on the next turn', async () => {
  setAi({});
  db.prepare("INSERT INTO chat_messages (role, content) VALUES ('user','Earlier question')").run();
  db.prepare("INSERT INTO chat_messages (role, content) VALUES ('assistant','Earlier answer')").run();
  const calls = mockFetch(() => ({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  await assistant.chat(db, { message: 'Follow-up' });
  const roles = calls[0].body.messages.map(m => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
  assert.equal(calls[0].body.messages[1].content, 'Earlier question');
});

// ---------- Anthropic-format adapter ----------

test('assistant: anthropic adapter request shape and tool loop', async () => {
  setupOrg();
  call('settings.update', {
    ai_provider: 'anthropic', ai_base_url: 'https://mock.anthropic.test',
    ai_model: 'claude-sonnet-4-6', ai_api_key: 'sk-ant-test',
  });
  const calls = mockFetch((n, body) => {
    if (n === 1) {
      return { stop_reason: 'tool_use', content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu1', name: 'calculate', input: { expression: '150000/100*1.1' } },
      ] };
    }
    const lastMsg = body.messages.at(-1);
    assert.equal(lastMsg.content[0].type, 'tool_result');
    assert.ok(lastMsg.content[0].content.includes('1650'));
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'That is $1,650.00 including GST.' }] };
  });

  const r = await assistant.chat(db, { message: 'What is 1500 plus GST?' });
  assert.match(r.reply, /1,650/);
  assert.deepEqual(r.toolsUsed, ['calculate']);
  assert.equal(calls[0].url, 'https://mock.anthropic.test/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-test');
  assert.ok(typeof calls[0].body.system === 'string' && calls[0].body.system.includes('Ledgerly'));
  assert.ok(calls[0].body.tools.find(t => t.name === 'list_documents' && t.input_schema));
});

// ---------- attachments ----------

test('assistant: image and csv attachments are encoded per provider format', async () => {
  setAi({});
  const png = Buffer.from('fakepng').toString('base64');
  const csv = Buffer.from('Date,Amount\n2026-01-01,12.50').toString('base64');
  const calls = mockFetch(() => ({ choices: [{ message: { role: 'assistant', content: 'Got it' } }] }));
  await assistant.chat(db, {
    message: 'Here is a receipt and an export',
    attachments: [
      { name: 'receipt.png', mime: 'image/png', dataBase64: png },
      { name: 'export.csv', mime: 'text/csv', dataBase64: csv },
    ],
  });
  const userMsg = calls[0].body.messages.at(-1);
  assert.ok(Array.isArray(userMsg.content));
  const img = userMsg.content.find(p => p.type === 'image_url');
  assert.ok(img.image_url.url.startsWith('data:image/png;base64,'));
  const text = userMsg.content.find(p => p.type === 'text');
  assert.ok(text.text.includes('Date,Amount'), 'csv contents inlined');
  // Attachment names recorded in stored history
  const hist = assistant.history(db);
  assert.ok(hist[0].content.includes('receipt.png'));
});

// ---------- guards ----------

test('assistant: clear errors when unconfigured, provider errors surfaced', async () => {
  await assert.rejects(() => assistant.chat(db, { message: 'hi' }), /Choose an AI provider/);
  setAi({});
  global.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'bad key' } }) });
  await assert.rejects(() => assistant.chat(db, { message: 'hi' }), /401.*bad key/);
  // Failed calls must not pollute history
  assert.equal(assistant.history(db).length, 0);
});

test('assistant: runaway tool loop is stopped', async () => {
  setAi({});
  mockFetch(() => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: 'x', type: 'function', function: { name: 'bank_accounts', arguments: '{}' } },
  ] } }] }));
  await assert.rejects(() => assistant.chat(db, { message: 'loop forever' }), /too many tool calls/);
});
