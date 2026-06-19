# Xero-Style Bank Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Xero-style bank reconciliation in Ledgerly by treating bank feed, CSV, and manual imports as statement lines that are matched, created, split, transferred, ruled, and audited before they affect the accounting ledger.

**Architecture:** Keep the existing Ledgerly ledger, invoice, payment, journal, and report systems intact. Extend the bank statement/reconciliation boundary so all bank data lands in `statement_lines`, then reuse and enrich reconciliation actions to create or link existing accounting transactions.

**Tech Stack:** Electron, CommonJS Node.js, `node:sqlite` `DatabaseSync`, local SQLite migrations in `src/db.js`, IPC through `electron/main.js` and `electron/preload.js`, renderer views in plain browser JavaScript, `node:test`, and the existing Electron smoke runner.

---

## Workspace Rule

Implementation must happen only in this copied app:

`/Users/davidnaguib/Desktop/Ledgerly-bank-feeds`

Do not edit the backup app:

`/Users/davidnaguib/Desktop/Ledgerly`

Start every implementation session with:

```bash
cd /Users/davidnaguib/Desktop/Ledgerly-bank-feeds
git status --short
npm test
```

Expected baseline:

```text
git status --short
# no output except files intentionally changed by the current task

npm test
# all node:test tests pass
```

If baseline tests fail before any task work, stop and investigate the copied app before changing feature code.

## Design Principles

- Bank feed data is evidence from the bank, not an accounting transaction.
- `statement_lines` is the canonical input queue for reconciliation.
- Ledger entries are posted only when a reconciliation action creates or links an accounting transaction.
- Existing reports should continue reading posted journals only.
- Matching suggestions are advisory unless an explicit user action confirms them.
- Provider-specific code must stay outside core accounting logic.
- Dedupe must happen at the statement-line import boundary.
- Reconciliation actions must be reversible by `bank.unreconcile`.

## File Structure

Existing files to modify:

- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/db.js`
  - Schema additions and idempotent migrations.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank.js`
  - Statement imports, reconciliation actions, split support, transfer support, rule application, audit writes.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/api.js`
  - Register new synchronous bank/reconciliation APIs.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/electron/main.js`
  - Add async `bank-feed` IPC after provider-neutral services exist.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/electron/preload.js`
  - Expose `window.ledgerly.bankFeed(method, args)`.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/ui/views/bank.js`
  - Upgrade bank account and reconcile screens.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/scripts/run-smoke.js`
  - Keep existing runner; add routes/interactions only if smoke coverage needs hooks.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/electron/main.js`
  - Add smoke route visits for new screens after UI tasks.

New files to create:

- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/reconciliation/matcher.js`
  - Deterministic match scoring and reason generation.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/reconciliation/rules.js`
  - Rule matching and draft action creation.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/normalise.js`
  - Provider-neutral feed transaction normalization.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/importer.js`
  - Imports normalized feed transactions into `statement_lines`.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/fake-provider.js`
  - Deterministic test provider.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/basiq.js`
  - Basiq client adapter.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-reconciliation-xero.test.js`
  - Core reconciliation behavior tests.
- `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-feed.test.js`
  - Provider-neutral and fake-provider feed tests.

## Phase 1: Statement Line Metadata And Dedupe

### Task 1: Add Xero-Style Source Metadata To Statement Lines

**Files:**
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/db.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank.js`
- Test: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-feed.test.js`

- [ ] **Step 1: Add failing tests for source metadata and dedupe**

Create `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-feed.test.js` with:

```js
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });
const call = (m, a) => api.call(db, m, a);

function setupBank() {
  return call('bank.createAccount', { name: 'Business Feed Account', code: '092' });
}

test('bank feed import: inserts provider metadata and dedupes source transaction ids', () => {
  const bank = setupBank();
  const first = call('bank.importFeedTransactions', {
    bankAccountId: bank.id,
    transactions: [{
      provider: 'fake',
      sourceAccountId: 'acc-1',
      sourceTransactionId: 'txn-1',
      date: '2026-06-01',
      payee: 'Officeworks',
      description: 'Card purchase Officeworks',
      reference: 'AUTH123',
      amountCents: -5500,
      postedAt: '2026-06-01T10:00:00Z',
      raw: { category: 'office' },
    }],
  });
  assert.deepEqual(first, { imported: 1, skipped: 0, updated: 0 });

  const second = call('bank.importFeedTransactions', {
    bankAccountId: bank.id,
    transactions: [{
      provider: 'fake',
      sourceAccountId: 'acc-1',
      sourceTransactionId: 'txn-1',
      date: '2026-06-01',
      payee: 'Officeworks',
      description: 'Card purchase Officeworks',
      reference: 'AUTH123',
      amountCents: -5500,
      postedAt: '2026-06-01T10:00:00Z',
      raw: { category: 'office' },
    }],
  });
  assert.deepEqual(second, { imported: 0, skipped: 1, updated: 0 });

  const lines = call('bank.reconcileData', { bankAccountId: bank.id }).statementLines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].source_kind, 'bank_feed');
  assert.equal(lines[0].source_provider, 'fake');
  assert.equal(lines[0].source_account_id, 'acc-1');
  assert.equal(lines[0].source_transaction_id, 'txn-1');
  assert.equal(lines[0].posted_at, '2026-06-01T10:00:00Z');
  assert.match(lines[0].raw_json, /office/);
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
npm test -- tests/bank-feed.test.js
```

Expected:

```text
FAIL
Unknown method: bank.importFeedTransactions
```

- [ ] **Step 3: Add schema columns and unique dedupe index**

In `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/db.js`, extend `migrate(db)`:

```js
  ensureColumn(db, 'statement_lines', 'source_kind', "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(db, 'statement_lines', 'source_provider', 'TEXT');
  ensureColumn(db, 'statement_lines', 'source_account_id', 'TEXT');
  ensureColumn(db, 'statement_lines', 'source_transaction_id', 'TEXT');
  ensureColumn(db, 'statement_lines', 'posted_at', 'TEXT');
  ensureColumn(db, 'statement_lines', 'raw_json', 'TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_statement_source_tx
    ON statement_lines(source_provider, source_transaction_id)
    WHERE source_provider IS NOT NULL AND source_transaction_id IS NOT NULL`);
```

Also update `SCHEMA` table definition for fresh databases by adding the same columns before `imported_at`.

- [ ] **Step 4: Add feed import function**

In `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank.js`, add:

```js
function importFeedTransactions(db, { bankAccountId, transactions = [] }) {
  const existing = db.prepare(`SELECT id, status FROM statement_lines
    WHERE source_provider = ? AND source_transaction_id = ?`).get.bind(
      db.prepare(`SELECT id, status FROM statement_lines
        WHERE source_provider = ? AND source_transaction_id = ?`));
  const ins = db.prepare(`INSERT INTO statement_lines
    (bank_account_id, date, payee, description, reference, amount_cents,
     source_kind, source_provider, source_account_id, source_transaction_id, posted_at, raw_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let imported = 0, skipped = 0, updated = 0;
  for (const tx of transactions) {
    if (!tx.provider || !tx.sourceTransactionId) throw new Error('Feed transaction provider and sourceTransactionId are required');
    if (!tx.date || !tx.amountCents) throw new Error('Feed transaction date and amountCents are required');
    const prior = existing(tx.provider, tx.sourceTransactionId);
    if (prior) {
      skipped++;
      continue;
    }
    ins.run(
      bankAccountId,
      tx.date,
      tx.payee || '',
      tx.description || '',
      tx.reference || '',
      Math.round(tx.amountCents),
      'bank_feed',
      tx.provider,
      tx.sourceAccountId || '',
      tx.sourceTransactionId,
      tx.postedAt || null,
      JSON.stringify(tx.raw || {})
    );
    imported++;
  }
  return { imported, skipped, updated };
}
```

Then export it from `module.exports`.

- [ ] **Step 5: Register API method**

In `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/api.js`, add near the existing bank methods:

```js
  'bank.importFeedTransactions': (db, a) => bank.importFeedTransactions(db, a),
```

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
npm test -- tests/bank-feed.test.js
npm test
```

Expected:

```text
PASS tests/bank-feed.test.js
PASS all test files
```

- [ ] **Step 7: Commit**

Run:

```bash
git add src/db.js src/services/bank.js src/api.js tests/bank-feed.test.js
git commit -m "feat: add statement source metadata"
```

## Phase 2: Reconciliation Audit Trail

### Task 2: Add Durable Reconciliation Records

**Files:**
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/db.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank.js`
- Test: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-reconciliation-xero.test.js`

- [ ] **Step 1: Add failing reconciliation audit tests**

Create `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-reconciliation-xero.test.js` with:

```js
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const api = require('../src/api');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });
const call = (m, a) => api.call(db, m, a);

function setup() {
  const contact = call('contacts.save', { name: 'Acme Ltd' });
  const sales = db.prepare("SELECT * FROM accounts WHERE code='200'").get();
  const rent = db.prepare("SELECT * FROM accounts WHERE code='469'").get();
  const bank = call('bank.createAccount', { name: 'Cheque', code: '093' });
  return { contact, sales, rent, bank };
}

test('reconciliation audit: match records action and unreconcile closes it', () => {
  const env = setup();
  const inv = call('invoices.save', {
    kind: 'ACCREC',
    contactId: env.contact.id,
    issueDate: '2026-06-01',
    dueDate: '2026-06-14',
    taxMode: 'none',
    lines: [{ description: 'Consulting', qty: 1, unitPriceCents: 10000, accountId: env.sales.id }],
  });
  call('invoices.approve', { id: inv.id });
  call('payments.add', { invoiceId: inv.id, bankAccountId: env.bank.id, date: '2026-06-03', amountCents: 10000 });
  call('bank.importStatement', { bankAccountId: env.bank.id, csv: 'Date,Description,Amount\n2026-06-03,ACME,100.00\n' });

  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];
  const match = line.suggestions[0];
  call('bank.match', { statementLineId: line.id, kind: match.kind, id: match.id });

  let history = call('bank.reconciliationHistory', { statementLineId: line.id });
  assert.equal(history.length, 1);
  assert.equal(history[0].action, 'matched_existing');
  assert.equal(history[0].matched_kind, 'payment');
  assert.equal(history[0].matched_id, match.id);
  assert.equal(history[0].unreconciled_at, null);

  call('bank.unreconcile', { statementLineId: line.id });
  history = call('bank.reconciliationHistory', { statementLineId: line.id });
  assert.equal(history.length, 1);
  assert.match(history[0].unreconciled_at, /^\d{4}-\d{2}-\d{2}/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/bank-reconciliation-xero.test.js
```

Expected:

```text
FAIL
Unknown method: bank.reconciliationHistory
```

- [ ] **Step 3: Add reconciliation table**

In `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/db.js`, add to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_line_id INTEGER NOT NULL REFERENCES statement_lines(id),
  matched_kind TEXT NOT NULL,
  matched_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  reconciled_at TEXT NOT NULL DEFAULT (datetime('now')),
  unreconciled_at TEXT,
  note TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_reconciliations_statement ON reconciliations(statement_line_id, unreconciled_at);
```

- [ ] **Step 4: Write audit helper functions**

In `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank.js`, add helpers:

```js
function recordReconciliation(db, { statementLineId, matchedKind, matchedId, action, note = '' }) {
  db.prepare(`INSERT INTO reconciliations
    (statement_line_id, matched_kind, matched_id, action, note)
    VALUES (?,?,?,?,?)`).run(statementLineId, matchedKind, matchedId, action, note);
}

function closeReconciliation(db, statementLineId) {
  db.prepare(`UPDATE reconciliations
    SET unreconciled_at = datetime('now')
    WHERE statement_line_id = ? AND unreconciled_at IS NULL`).run(statementLineId);
}

function reconciliationHistory(db, statementLineId) {
  return db.prepare(`SELECT * FROM reconciliations
    WHERE statement_line_id = ?
    ORDER BY reconciled_at DESC, id DESC`).all(statementLineId);
}
```

- [ ] **Step 5: Call audit helpers from match and unreconcile**

In `matchStatementLine`, after updating `statement_lines`, call:

```js
  recordReconciliation(db, {
    statementLineId,
    matchedKind: kind + (kind === 'transfer' ? ':' + direction : ''),
    matchedId: id,
    action: 'matched_existing',
  });
```

In `createAndMatch`, avoid double-recording as `matched_existing` by either passing an internal `action` option to `matchStatementLine` or by having `createAndMatch` write:

```js
  recordReconciliation(db, {
    statementLineId,
    matchedKind: 'bank_transaction',
    matchedId: t.id,
    action: 'created_transaction',
  });
```

In `unreconcile`, before returning:

```js
  closeReconciliation(db, statementLineId);
```

- [ ] **Step 6: Register API method**

In `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/api.js`, add:

```js
  'bank.reconciliationHistory': (db, a) => bank.reconciliationHistory(db, a.statementLineId),
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm test -- tests/bank-reconciliation-xero.test.js
npm test
```

Expected:

```text
PASS tests/bank-reconciliation-xero.test.js
PASS all test files
```

- [ ] **Step 8: Commit**

Run:

```bash
git add src/db.js src/services/bank.js src/api.js tests/bank-reconciliation-xero.test.js
git commit -m "feat: audit bank reconciliations"
```

## Phase 3: Deterministic Match Scoring

### Task 3: Extract And Improve Match Suggestions

**Files:**
- Create: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/reconciliation/matcher.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank.js`
- Test: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-reconciliation-xero.test.js`

- [ ] **Step 1: Add failing scoring tests**

Append to `tests/bank-reconciliation-xero.test.js`:

```js
test('reconciliation matcher: ranks exact amount date and reference above amount-only matches', () => {
  const env = setup();
  const invA = call('invoices.save', {
    kind: 'ACCREC',
    contactId: env.contact.id,
    issueDate: '2026-06-01',
    dueDate: '2026-06-14',
    taxMode: 'none',
    reference: 'INV-A',
    lines: [{ description: 'A', qty: 1, unitPriceCents: 20000, accountId: env.sales.id }],
  });
  const invB = call('invoices.save', {
    kind: 'ACCREC',
    contactId: env.contact.id,
    issueDate: '2026-06-01',
    dueDate: '2026-06-14',
    taxMode: 'none',
    reference: 'INV-B',
    lines: [{ description: 'B', qty: 1, unitPriceCents: 20000, accountId: env.sales.id }],
  });
  call('invoices.approve', { id: invA.id });
  call('invoices.approve', { id: invB.id });
  const oldPayment = call('payments.add', { invoiceId: invA.id, bankAccountId: env.bank.id, date: '2026-05-15', amountCents: 20000, reference: 'OLD' });
  const bestPayment = call('payments.add', { invoiceId: invB.id, bankAccountId: env.bank.id, date: '2026-06-03', amountCents: 20000, reference: 'INV-B' });
  call('bank.importStatement', { bankAccountId: env.bank.id, csv: 'Date,Description,Reference,Amount\n2026-06-03,ACME PAYMENT,INV-B,200.00\n' });

  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];
  assert.equal(line.suggestions[0].kind, 'payment');
  assert.equal(line.suggestions[0].id, bestPayment.payments.at(-1).id);
  assert.ok(line.suggestions[0].score > line.suggestions.find(s => s.id === oldPayment.payments.at(-1).id).score);
  assert.ok(line.suggestions[0].reasons.includes('Exact amount'));
  assert.ok(line.suggestions[0].reasons.includes('Reference match'));
});
```

- [ ] **Step 2: Run test to verify it fails on missing score/reasons or wrong ranking**

Run:

```bash
npm test -- tests/bank-reconciliation-xero.test.js
```

Expected:

```text
FAIL
score/reasons missing or lower-quality match ranked first
```

- [ ] **Step 3: Create matcher module**

Create `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/reconciliation/matcher.js`:

```js
'use strict';

function daysApart(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / 864e5);
}

function clean(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function containsEither(haystack, ...needles) {
  const h = clean(haystack);
  return needles.some(n => {
    const c = clean(n);
    return c && h.includes(c);
  });
}

function scoreCandidate(statementLine, candidate) {
  let score = 0;
  const reasons = [];
  if (statementLine.amount_cents === candidate.amount_cents) {
    score += 60;
    reasons.push('Exact amount');
  } else {
    return { score: -1000, reasons: ['Amount mismatch'] };
  }
  const gap = daysApart(statementLine.date, candidate.date);
  if (gap === 0) {
    score += 20;
    reasons.push('Same date');
  } else if (gap <= 1) {
    score += 16;
    reasons.push('Within 1 day');
  } else if (gap <= 7) {
    score += 8;
    reasons.push('Within 7 days');
  }
  if (containsEither(statementLine.reference, candidate.reference, candidate.description)) {
    score += 20;
    reasons.push('Reference match');
  }
  if (containsEither(`${statementLine.payee} ${statementLine.description}`, candidate.description, candidate.reference)) {
    score += 10;
    reasons.push('Payee or description match');
  }
  return { score, reasons };
}

function suggestMatches(statementLines, candidates) {
  const used = new Set();
  return statementLines.map(line => {
    const suggestions = candidates
      .filter(c => !used.has(`${c.kind}:${c.id}:${c.direction || ''}`))
      .map(c => ({ ...c, ...scoreCandidate(line, c) }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score || a.date.localeCompare(b.date) || a.id - b.id)
      .slice(0, 5);
    if (suggestions[0]) used.add(`${suggestions[0].kind}:${suggestions[0].id}:${suggestions[0].direction || ''}`);
    return { ...line, suggestions };
  });
}

module.exports = { scoreCandidate, suggestMatches };
```

- [ ] **Step 4: Wire matcher into `reconcileData`**

In `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank.js`, import:

```js
const { suggestMatches } = require('./reconciliation/matcher');
```

Replace the suggestion loop in `reconcileData` with:

```js
  return { statementLines: suggestMatches(stmts, candidates), unreconciledTransactions: candidates };
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- tests/bank-reconciliation-xero.test.js
npm test
```

Expected:

```text
PASS focused reconciliation tests
PASS all test files
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/services/reconciliation/matcher.js src/services/bank.js tests/bank-reconciliation-xero.test.js
git commit -m "feat: score bank reconciliation matches"
```

## Phase 4: Bank Rules

### Task 4: Add Rule-Based Create Suggestions

**Files:**
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/db.js`
- Create: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/reconciliation/rules.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/api.js`
- Test: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-reconciliation-xero.test.js`

- [ ] **Step 1: Add failing rule tests**

Append:

```js
test('bank rules: matching rule returns create suggestion without posting a journal', () => {
  const env = setup();
  const rule = call('bank.rules.save', {
    name: 'Adobe subscription',
    bankAccountId: env.bank.id,
    direction: 'money_out',
    textContains: 'ADOBE',
    minAmountCents: 1000,
    maxAmountCents: 10000,
    contactId: null,
    accountId: env.rent.id,
    taxRateId: null,
    descriptionTemplate: 'Software subscription',
    priority: 10,
    enabled: true,
  });
  call('bank.importStatement', { bankAccountId: env.bank.id, csv: 'Date,Description,Amount\n2026-06-04,ADOBE CREATIVE CLOUD,-55.00\n' });
  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];
  assert.equal(line.ruleSuggestions.length, 1);
  assert.equal(line.ruleSuggestions[0].rule_id, rule.id);
  assert.equal(line.ruleSuggestions[0].account_id, env.rent.id);
  assert.equal(call('journals.list', { manualOnly: false }).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/bank-reconciliation-xero.test.js
```

Expected:

```text
FAIL
Unknown method: bank.rules.save
```

- [ ] **Step 3: Add `bank_rules` schema**

Add to `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/db.js` `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS bank_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  bank_account_id INTEGER REFERENCES accounts(id),
  direction TEXT NOT NULL DEFAULT 'any',
  text_contains TEXT DEFAULT '',
  min_amount_cents INTEGER,
  max_amount_cents INTEGER,
  contact_id INTEGER REFERENCES contacts(id),
  account_id INTEGER REFERENCES accounts(id),
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  description_template TEXT DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Implement rule module**

Create `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/reconciliation/rules.js`:

```js
'use strict';

function directionOf(amountCents) {
  return amountCents < 0 ? 'money_out' : 'money_in';
}

function listRules(db) {
  return db.prepare('SELECT * FROM bank_rules ORDER BY priority DESC, id ASC').all();
}

function saveRule(db, d) {
  if (!d.name || !String(d.name).trim()) throw new Error('Rule name is required');
  if (!['any', 'money_in', 'money_out'].includes(d.direction || 'any')) throw new Error('Invalid rule direction');
  const cols = {
    name: String(d.name).trim(),
    bank_account_id: d.bankAccountId || null,
    direction: d.direction || 'any',
    text_contains: d.textContains || '',
    min_amount_cents: d.minAmountCents == null ? null : Math.round(d.minAmountCents),
    max_amount_cents: d.maxAmountCents == null ? null : Math.round(d.maxAmountCents),
    contact_id: d.contactId || null,
    account_id: d.accountId || null,
    tax_rate_id: d.taxRateId || null,
    description_template: d.descriptionTemplate || '',
    priority: Math.round(d.priority || 0),
    enabled: d.enabled === false ? 0 : 1,
  };
  if (d.id) {
    db.prepare(`UPDATE bank_rules SET ${Object.keys(cols).map(k => `${k}=?`).join(', ')} WHERE id=?`)
      .run(...Object.values(cols), d.id);
    return db.prepare('SELECT * FROM bank_rules WHERE id=?').get(d.id);
  }
  const r = db.prepare(`INSERT INTO bank_rules (${Object.keys(cols).join(',')})
    VALUES (${Object.keys(cols).map(() => '?').join(',')})`).run(...Object.values(cols));
  return db.prepare('SELECT * FROM bank_rules WHERE id=?').get(Number(r.lastInsertRowid));
}

function ruleMatches(rule, line) {
  if (!rule.enabled) return false;
  if (rule.bank_account_id && rule.bank_account_id !== line.bank_account_id) return false;
  if (rule.direction !== 'any' && rule.direction !== directionOf(line.amount_cents)) return false;
  const abs = Math.abs(line.amount_cents);
  if (rule.min_amount_cents != null && abs < rule.min_amount_cents) return false;
  if (rule.max_amount_cents != null && abs > rule.max_amount_cents) return false;
  const haystack = `${line.payee || ''} ${line.description || ''} ${line.reference || ''}`.toLowerCase();
  if (rule.text_contains && !haystack.includes(String(rule.text_contains).toLowerCase())) return false;
  return true;
}

function suggestRules(db, line) {
  return listRules(db)
    .filter(rule => ruleMatches(rule, line))
    .map(rule => ({
      rule_id: rule.id,
      name: rule.name,
      contact_id: rule.contact_id,
      account_id: rule.account_id,
      tax_rate_id: rule.tax_rate_id,
      description: rule.description_template || line.description || line.payee || 'Bank transaction',
      priority: rule.priority,
    }));
}

module.exports = { listRules, saveRule, suggestRules };
```

- [ ] **Step 5: Attach rule suggestions to reconcile data**

In `src/services/bank.js`, import:

```js
const rules = require('./reconciliation/rules');
```

After match suggestions are computed, add:

```js
  const statementLines = suggestMatches(stmts, candidates);
  for (const line of statementLines) line.ruleSuggestions = rules.suggestRules(db, line);
  return { statementLines, unreconciledTransactions: candidates };
```

- [ ] **Step 6: Register rule APIs**

In `src/api.js`, add:

```js
  'bank.rules.list': (db) => require('./services/reconciliation/rules').listRules(db),
  'bank.rules.save': (db, a) => require('./services/reconciliation/rules').saveRule(db, a),
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm test -- tests/bank-reconciliation-xero.test.js
npm test
```

Expected:

```text
PASS focused rule test
PASS all test files
```

- [ ] **Step 8: Commit**

Run:

```bash
git add src/db.js src/services/reconciliation/rules.js src/services/bank.js src/api.js tests/bank-reconciliation-xero.test.js
git commit -m "feat: add bank reconciliation rules"
```

## Phase 5: Transfer Reconciliation

### Task 5: Create Transfers Directly From Statement Lines

**Files:**
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/api.js`
- Test: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-reconciliation-xero.test.js`

- [ ] **Step 1: Add failing transfer action test**

Append:

```js
test('reconciliation transfer: creates transfer from money-out statement line and marks source side reconciled', () => {
  const env = setup();
  const savings = call('bank.createAccount', { name: 'Savings', code: '094' });
  call('bank.importStatement', { bankAccountId: env.bank.id, csv: 'Date,Description,Amount\n2026-06-05,Transfer to savings,-250.00\n' });
  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];

  const transfer = call('bank.createTransferAndMatch', {
    statementLineId: line.id,
    otherBankAccountId: savings.id,
    reference: 'Transfer to savings',
  });
  assert.equal(transfer.from_account_id, env.bank.id);
  assert.equal(transfer.to_account_id, savings.id);
  assert.equal(transfer.amount_cents, 25000);
  assert.equal(transfer.from_reconciled, 1);
  assert.equal(transfer.to_reconciled, 0);

  const banks = call('bank.accounts');
  assert.equal(banks.find(b => b.id === env.bank.id).balance_cents, -25000);
  assert.equal(banks.find(b => b.id === savings.id).balance_cents, 25000);
  assert.equal(call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/bank-reconciliation-xero.test.js
```

Expected:

```text
FAIL
Unknown method: bank.createTransferAndMatch
```

- [ ] **Step 3: Implement transfer action**

In `src/services/bank.js`, add:

```js
function createTransferAndMatch(db, { statementLineId, otherBankAccountId, reference = '' }) {
  const sl = db.prepare('SELECT * FROM statement_lines WHERE id = ?').get(statementLineId);
  if (!sl) throw new Error('Statement line not found');
  if (sl.status === 'MATCHED') throw new Error('Already reconciled');
  const moneyOut = sl.amount_cents < 0;
  const transfer = saveTransfer(db, {
    fromAccountId: moneyOut ? sl.bank_account_id : otherBankAccountId,
    toAccountId: moneyOut ? otherBankAccountId : sl.bank_account_id,
    date: sl.date,
    amountCents: Math.abs(sl.amount_cents),
    reference: reference || sl.reference || sl.description || sl.payee || 'Bank transfer',
  });
  const direction = moneyOut ? 'out' : 'in';
  matchStatementLine(db, { statementLineId, kind: 'transfer', id: transfer.id, direction, action: 'created_transfer' });
  return db.prepare('SELECT * FROM transfers WHERE id=?').get(transfer.id);
}
```

Adjust `matchStatementLine` to accept `action = 'matched_existing'` and pass that value into `recordReconciliation`.

- [ ] **Step 4: Register API**

In `src/api.js`, add:

```js
  'bank.createTransferAndMatch': (db, a) => bank.createTransferAndMatch(db, a),
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- tests/bank-reconciliation-xero.test.js
npm test
```

Expected:

```text
PASS transfer reconciliation test
PASS all test files
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/services/bank.js src/api.js tests/bank-reconciliation-xero.test.js
git commit -m "feat: reconcile bank transfers from statement lines"
```

## Phase 6: Split Transactions

### Task 6: Split One Statement Line Across Multiple Accounts

**Files:**
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/api.js`
- Test: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-reconciliation-xero.test.js`

- [ ] **Step 1: Add failing split test**

Append:

```js
test('reconciliation split: creates one bank transaction with multiple coded lines', () => {
  const env = setup();
  const meals = db.prepare("SELECT * FROM accounts WHERE code='499'").get() || env.rent;
  call('bank.importStatement', { bankAccountId: env.bank.id, csv: 'Date,Description,Amount\n2026-06-06,Mixed supplier,-150.00\n' });
  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];

  const tx = call('bank.createSplitAndMatch', {
    statementLineId: line.id,
    contactId: null,
    taxMode: 'none',
    lines: [
      { description: 'Office rent portion', amountCents: 10000, accountId: env.rent.id, taxRateId: null },
      { description: 'Meal portion', amountCents: 5000, accountId: meals.id, taxRateId: null },
    ],
  });
  assert.equal(tx.kind, 'SPEND');
  assert.equal(tx.total_cents, 15000);
  assert.equal(tx.lines.length, 2);
  assert.equal(call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/bank-reconciliation-xero.test.js
```

Expected:

```text
FAIL
Unknown method: bank.createSplitAndMatch
```

- [ ] **Step 3: Implement split action using existing bank transaction writer**

In `src/services/bank.js`, add:

```js
function createSplitAndMatch(db, { statementLineId, contactId = null, taxMode = 'none', lines = [] }) {
  const sl = db.prepare('SELECT * FROM statement_lines WHERE id = ?').get(statementLineId);
  if (!sl) throw new Error('Statement line not found');
  if (sl.status === 'MATCHED') throw new Error('Already reconciled');
  const expected = Math.abs(sl.amount_cents);
  const total = lines.reduce((sum, line) => sum + Math.round(line.amountCents || 0), 0);
  if (total !== expected) throw new Error('Split total must equal the statement line amount');
  const kind = sl.amount_cents >= 0 ? 'RECEIVE' : 'SPEND';
  const tx = saveBankTransaction(db, {
    kind,
    bankAccountId: sl.bank_account_id,
    contactId,
    date: sl.date,
    reference: sl.reference || sl.payee || sl.description,
    taxMode,
    lines: lines.map(line => ({
      description: line.description || sl.description || sl.payee || 'Split bank transaction',
      qty: 1,
      unitPriceCents: Math.round(line.amountCents || 0),
      accountId: line.accountId,
      taxRateId: line.taxRateId || null,
    })),
  });
  matchStatementLine(db, { statementLineId, kind: 'bank_transaction', id: tx.id, action: 'created_split' });
  return getBankTransaction(db, tx.id);
}
```

- [ ] **Step 4: Register API**

In `src/api.js`, add:

```js
  'bank.createSplitAndMatch': (db, a) => bank.createSplitAndMatch(db, a),
```

- [ ] **Step 5: Add invalid split test**

Append:

```js
test('reconciliation split: rejects totals that do not equal statement line amount', () => {
  const env = setup();
  call('bank.importStatement', { bankAccountId: env.bank.id, csv: 'Date,Description,Amount\n2026-06-07,Mixed supplier,-150.00\n' });
  const line = call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines[0];
  assert.throws(() => call('bank.createSplitAndMatch', {
    statementLineId: line.id,
    taxMode: 'none',
    lines: [{ description: 'Short split', amountCents: 14999, accountId: env.rent.id }],
  }), /Split total must equal/);
});
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- tests/bank-reconciliation-xero.test.js
npm test
```

Expected:

```text
PASS split reconciliation tests
PASS all test files
```

- [ ] **Step 7: Commit**

Run:

```bash
git add src/services/bank.js src/api.js tests/bank-reconciliation-xero.test.js
git commit -m "feat: reconcile split bank transactions"
```

## Phase 7: Provider-Neutral Feed Layer

### Task 7: Normalize And Import Provider Feed Transactions

**Files:**
- Create: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/normalise.js`
- Create: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/importer.js`
- Create: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/fake-provider.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/api.js`
- Test: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-feed.test.js`

- [ ] **Step 1: Add fake provider sync test**

Append to `tests/bank-feed.test.js`:

```js
test('bank feed sync: fake provider normalizes transactions and imports statement lines', async () => {
  const bank = setupBank();
  const result = await require('../src/services/bank-feed/fake-provider').sync(db, {
    bankAccountId: bank.id,
    providerAccountId: 'fake-cheque',
  });
  assert.equal(result.imported, 2);
  assert.equal(result.skipped, 0);
  const lines = call('bank.reconcileData', { bankAccountId: bank.id }).statementLines;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].source_provider, 'fake');
  assert.ok(lines.some(l => l.amount_cents < 0));
  assert.ok(lines.some(l => l.amount_cents > 0));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/bank-feed.test.js
```

Expected:

```text
FAIL
Cannot find module '../src/services/bank-feed/fake-provider'
```

- [ ] **Step 3: Create normalizer**

Create `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/normalise.js`:

```js
'use strict';

function normalizeFeedTransaction(provider, tx) {
  if (!provider) throw new Error('Provider is required');
  if (!tx.sourceTransactionId) throw new Error('sourceTransactionId is required');
  if (!tx.date) throw new Error('date is required');
  const amountCents = Math.round(Number(tx.amountCents));
  if (!Number.isFinite(amountCents) || amountCents === 0) throw new Error('amountCents must be a non-zero number');
  return {
    provider,
    sourceAccountId: tx.sourceAccountId || '',
    sourceTransactionId: String(tx.sourceTransactionId),
    date: tx.date,
    payee: tx.payee || '',
    description: tx.description || '',
    reference: tx.reference || '',
    amountCents,
    postedAt: tx.postedAt || null,
    raw: tx.raw || tx,
  };
}

module.exports = { normalizeFeedTransaction };
```

- [ ] **Step 4: Create importer**

Create `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/importer.js`:

```js
'use strict';

const bank = require('../bank');
const { normalizeFeedTransaction } = require('./normalise');

function importProviderTransactions(db, { provider, bankAccountId, transactions }) {
  const normalized = transactions.map(tx => normalizeFeedTransaction(provider, tx));
  return bank.importFeedTransactions(db, { bankAccountId, transactions: normalized });
}

module.exports = { importProviderTransactions };
```

- [ ] **Step 5: Create fake provider**

Create `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/fake-provider.js`:

```js
'use strict';

const { importProviderTransactions } = require('./importer');

async function sync(db, { bankAccountId, providerAccountId }) {
  return importProviderTransactions(db, {
    provider: 'fake',
    bankAccountId,
    transactions: [
      {
        sourceAccountId: providerAccountId,
        sourceTransactionId: `${providerAccountId}-deposit-1`,
        date: '2026-06-10',
        payee: 'Acme Ltd',
        description: 'Customer deposit',
        reference: 'INV-1001',
        amountCents: 125000,
        postedAt: '2026-06-10T09:00:00Z',
        raw: { fixture: true },
      },
      {
        sourceAccountId: providerAccountId,
        sourceTransactionId: `${providerAccountId}-card-1`,
        date: '2026-06-11',
        payee: 'Officeworks',
        description: 'Office supplies',
        reference: 'CARD',
        amountCents: -8800,
        postedAt: '2026-06-11T10:00:00Z',
        raw: { fixture: true },
      },
    ],
  });
}

module.exports = { sync };
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- tests/bank-feed.test.js
npm test
```

Expected:

```text
PASS bank feed tests
PASS all test files
```

- [ ] **Step 7: Commit**

Run:

```bash
git add src/services/bank-feed/normalise.js src/services/bank-feed/importer.js src/services/bank-feed/fake-provider.js tests/bank-feed.test.js
git commit -m "feat: add provider-neutral bank feed importer"
```

## Phase 8: Async Bank Feed IPC

### Task 8: Add Async IPC Boundary Without Changing Existing `api.call`

**Files:**
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/electron/main.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/electron/preload.js`
- Test: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-feed.test.js`

- [ ] **Step 1: Keep core tests green before Electron IPC work**

Run:

```bash
npm test
```

Expected:

```text
PASS all test files
```

- [ ] **Step 2: Add preload bridge**

In `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/electron/preload.js`, add inside `contextBridge.exposeInMainWorld('ledgerly', { ... })`:

```js
  async bankFeed(method, args) {
    const res = await ipcRenderer.invoke('bank-feed', method, args);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
```

- [ ] **Step 3: Add main-process method registry**

In `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/electron/main.js`, after assistant IPC setup, add:

```js
  const BANK_FEED_METHODS = {
    async fakeSync(a) {
      return require('../src/services/bank-feed/fake-provider').sync(db, a);
    },
  };
  ipcMain.handle('bank-feed', async (_e, method, args) => {
    try {
      const fn = BANK_FEED_METHODS[method];
      if (!fn) throw new Error('Unknown bank feed method: ' + method);
      return { ok: true, data: await fn(args || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
```

- [ ] **Step 4: Run Electron smoke**

Run:

```bash
npm run smoke
```

Expected:

```text
Smoke tour completes without SMOKE FAILED
```

- [ ] **Step 5: Run full tests**

Run:

```bash
npm test
```

Expected:

```text
PASS all test files
```

- [ ] **Step 6: Commit**

Run:

```bash
git add electron/main.js electron/preload.js
git commit -m "feat: add async bank feed IPC"
```

## Phase 9: Basiq Provider Adapter

### Task 9: Add Basiq Client Behind Provider Interface

**Files:**
- Create: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/basiq.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/electron/main.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/ui/views/settings.js`
- Test: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-feed.test.js`

- [ ] **Step 1: Add Basiq mapping unit test using fixture data**

Append to `tests/bank-feed.test.js`:

```js
test('basiq adapter: maps transaction fixture to normalized signed cents', () => {
  const basiq = require('../src/services/bank-feed/basiq');
  const tx = basiq.mapBasiqTransaction({
    id: 'bq-tx-1',
    account: 'bq-acc-1',
    postDate: '2026-06-12',
    description: 'BP FUEL',
    amount: '-62.76',
    balance: '1000.00',
  });
  assert.equal(tx.provider, 'basiq');
  assert.equal(tx.sourceAccountId, 'bq-acc-1');
  assert.equal(tx.sourceTransactionId, 'bq-tx-1');
  assert.equal(tx.date, '2026-06-12');
  assert.equal(tx.description, 'BP FUEL');
  assert.equal(tx.amountCents, -6276);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/bank-feed.test.js
```

Expected:

```text
FAIL
Cannot find module '../src/services/bank-feed/basiq'
```

- [ ] **Step 3: Implement Basiq mapping and client shell**

Create `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/src/services/bank-feed/basiq.js`:

```js
'use strict';

const { importProviderTransactions } = require('./importer');

const BASE_URL = 'https://au-api.basiq.io';

function toCents(value) {
  return Math.round(Number(String(value || '0').replace(/,/g, '')) * 100);
}

function mapBasiqTransaction(tx) {
  return {
    provider: 'basiq',
    sourceAccountId: String(tx.account || tx.accountId || ''),
    sourceTransactionId: String(tx.id),
    date: String(tx.postDate || tx.transactionDate || tx.date || '').slice(0, 10),
    payee: tx.merchant?.businessName || tx.institution || '',
    description: tx.description || tx.class || '',
    reference: tx.reference || '',
    amountCents: toCents(tx.amount),
    postedAt: tx.postDate || tx.transactionDate || null,
    raw: tx,
  };
}

async function requestJson({ token, path, method = 'GET', body = null }) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Basiq ${method} ${path} failed: ${res.status}`);
  return res.json();
}

async function syncTransactions(db, { serverToken, userId, providerAccountId, bankAccountId }) {
  const data = await requestJson({
    token: serverToken,
    path: `/users/${encodeURIComponent(userId)}/transactions?limit=500`,
  });
  const transactions = (data.data || [])
    .map(mapBasiqTransaction)
    .filter(tx => tx.sourceAccountId === providerAccountId);
  return importProviderTransactions(db, {
    provider: 'basiq',
    bankAccountId,
    transactions,
  });
}

module.exports = { mapBasiqTransaction, syncTransactions };
```

- [ ] **Step 4: Register Basiq sync in async IPC**

In `electron/main.js`, add to `BANK_FEED_METHODS`:

```js
    async basiqSync(a) {
      return require('../src/services/bank-feed/basiq').syncTransactions(db, a);
    },
```

- [ ] **Step 5: Add settings fields for Basiq sandbox credentials**

In `ui/views/settings.js`, add a compact Bank feeds settings section with:

```html
<h2>Bank feed settings</h2>
<label class="field">Basiq server token<input name="basiq_server_token" value="${esc(s.basiq_server_token || '')}" /></label>
<label class="field">Basiq user ID<input name="basiq_user_id" value="${esc(s.basiq_user_id || '')}" /></label>
```

Use the existing `settings.update` submit pattern in that file.

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- tests/bank-feed.test.js
npm test
```

Expected:

```text
PASS Basiq mapping fixture test
PASS all test files
```

- [ ] **Step 7: Run smoke**

Run:

```bash
npm run smoke
```

Expected:

```text
Smoke tour completes without SMOKE FAILED
```

- [ ] **Step 8: Commit**

Run:

```bash
git add src/services/bank-feed/basiq.js electron/main.js ui/views/settings.js tests/bank-feed.test.js
git commit -m "feat: add Basiq bank feed adapter"
```

## Phase 10: Reconciliation UI

### Task 10: Upgrade The Bank Reconcile Screen

**Files:**
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/ui/views/bank.js`
- Test: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/electron/main.js` smoke route interactions if needed.

- [ ] **Step 1: Preserve existing reconcile UI behavior**

Run:

```bash
npm run smoke
```

Expected:

```text
Smoke tour completes without SMOKE FAILED
```

- [ ] **Step 2: Add tab panels**

In `ui/views/bank.js`, update each reconciliation pair to expose tabs:

```text
Match
Create
Transfer
Split
Rule
```

Reuse existing tab switching behavior for Match/Create and extend it to hide/show the new panes. Keep the `OK` button as the single commit action for the selected pane.

- [ ] **Step 3: Show scored match reasons**

Render each match option as:

```js
`${esc(g.description)} · ${fmtDate(g.date)} · ${fmtMoney(g.amount_cents)} · ${g.score} · ${esc((g.reasons || []).join(', '))}`
```

- [ ] **Step 4: Add transfer pane**

The transfer pane must include:

```html
<select class="tr-bank">other bank accounts excluding current account</select>
<input class="tr-ref" placeholder="Reference" />
```

On OK, call:

```js
await api('bank.createTransferAndMatch', {
  statementLineId: sid,
  otherBankAccountId: Number(pair.querySelector('.tr-bank').value),
  reference: pair.querySelector('.tr-ref').value.trim(),
});
```

- [ ] **Step 5: Add split pane**

The split pane must support two lines in the first pass:

```html
account select
description input
amount input
tax select
```

On OK, call:

```js
await api('bank.createSplitAndMatch', {
  statementLineId: sid,
  taxMode: 'none',
  lines: splitRows.map(row => ({
    description: row.description,
    amountCents: centsOf(row.amount),
    accountId: Number(row.accountId),
    taxRateId: Number(row.taxRateId) || null,
  })),
});
```

- [ ] **Step 6: Add rule pane**

If `s.ruleSuggestions.length > 0`, show the top suggestion and OK should call `bank.createAndMatch` with the suggested `contact_id`, `account_id`, `tax_rate_id`, and `description`.

- [ ] **Step 7: Run smoke and full tests**

Run:

```bash
npm run smoke
npm test
```

Expected:

```text
Smoke tour completes without SMOKE FAILED
PASS all test files
```

- [ ] **Step 8: Commit**

Run:

```bash
git add ui/views/bank.js electron/main.js
git commit -m "feat: add Xero-style reconciliation UI actions"
```

## Phase 11: Bank Account Feed Controls

### Task 11: Add Feed Controls To Bank Account Screens

**Files:**
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/ui/views/bank.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/electron/main.js`

- [ ] **Step 1: Add `Sync fake feed` development control**

On the bank account page, add a non-destructive development button:

```html
<button class="btn" id="btn-sync-fake">Sync demo feed</button>
```

Handler:

```js
document.getElementById('btn-sync-fake')?.addEventListener('click', async () => {
  try {
    const r = await window.ledgerly.bankFeed('fakeSync', {
      bankAccountId: id,
      providerAccountId: `ledgerly-bank-${id}`,
    });
    toast(`Synced ${r.imported} new line${r.imported === 1 ? '' : 's'}`, 'success');
    if (r.imported > 0) navigate(`#/bank/${id}/reconcile`);
  } catch (e) { showError(e); }
});
```

- [ ] **Step 2: Add Basiq sync control behind settings presence**

If `STATE.settings.basiq_server_token` and `STATE.settings.basiq_user_id` exist, render:

```html
<button class="btn" id="btn-sync-basiq">Sync Basiq feed</button>
```

Handler:

```js
await window.ledgerly.bankFeed('basiqSync', {
  serverToken: STATE.settings.basiq_server_token,
  userId: STATE.settings.basiq_user_id,
  providerAccountId: prompt('Basiq provider account ID'),
  bankAccountId: id,
});
```

- [ ] **Step 3: Run smoke**

Run:

```bash
npm run smoke
```

Expected:

```text
Smoke tour completes without SMOKE FAILED
```

- [ ] **Step 4: Commit**

Run:

```bash
git add ui/views/bank.js
git commit -m "feat: add bank feed sync controls"
```

## Phase 12: End-To-End Hardening

### Task 12: Add Regression Coverage For Full Xero-Style Flow

**Files:**
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-reconciliation-xero.test.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/tests/bank-feed.test.js`
- Modify: `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds/README.md`

- [ ] **Step 1: Add full flow test**

Add a test covering:

```text
1. Create invoice
2. Approve invoice
3. Import matching feed deposit
4. Confirm match
5. Import card expense
6. Apply rule suggestion
7. Verify no unreconciled lines remain
8. Verify bank balance equals ledger balance
9. Verify P&L includes created expense
```

Use exact assertions for:

```js
assert.equal(call('bank.reconcileData', { bankAccountId: env.bank.id }).statementLines.length, 0);
assert.equal(call('bank.accounts').find(b => b.id === env.bank.id).unreconciled, 0);
```

- [ ] **Step 2: Add duplicate and unreconcile regression tests**

Add assertions that:

```text
Duplicate feed import creates no new line.
Unreconcile reopens the statement line.
Previously matched transaction becomes editable only after unreconcile.
```

- [ ] **Step 3: Update README bank feed section**

In `README.md`, add a section:

```markdown
## Xero-style bank reconciliation

Ledgerly imports bank data as statement lines. Statement lines can come from CSV,
manual entry, demo feed sync, or provider feeds. A statement line does not change
the accounting ledger until it is matched to an existing transaction or used to
create a spend, receive, transfer, or split transaction during reconciliation.
```

- [ ] **Step 4: Run final verification**

Run:

```bash
npm test
npm run smoke
```

Expected:

```text
PASS all test files
Smoke tour completes without SMOKE FAILED
```

- [ ] **Step 5: Commit**

Run:

```bash
git add tests/bank-reconciliation-xero.test.js tests/bank-feed.test.js README.md
git commit -m "test: cover Xero-style bank reconciliation flow"
```

## Provider Research Notes For Implementation

Basiq is the preferred first provider for this app because Ledgerly is Australian-accounting oriented. The provider layer should follow Basiq's documented flow:

- Register app and keep API keys secret.
- Exchange API key for a server access token.
- Create a Basiq user.
- Create a client token bound to the Basiq user.
- Send user through Basiq Consent UI.
- Poll connection jobs until account and transaction retrieval succeeds.
- Fetch `/users/{userId}/transactions`.
- Normalize transactions into Ledgerly feed transactions.
- Insert them as `statement_lines`.

Reference docs:

- Basiq quickstart: `https://api.basiq.io/docs/quickstart-api`
- Basiq transactions endpoint: `https://api.basiq.io/reference/gettransactions`
- Basiq access methods: `https://api.basiq.io/docs/access-method`
- Basiq webhooks: `https://api.basiq.io/docs/webhooks`
- Xero bank feed model: `https://www.xero.com/us/accounting-software/connect-your-bank/`
- Xero Bank Feeds API closed-partner note: `https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_bankfeeds.yaml`

## Out Of Scope For First Implementation Pass

- Production CDR compliance program.
- Automatic background sync on app launch.
- Public webhook endpoint.
- Plaid production integration.
- Rule auto-posting without user confirmation.
- Multi-user reconciliation permissions.
- Imported PDF bank statement parsing.

## Final Self-Review

- Spec coverage: The plan covers statement-line metadata, dedupe, audit trail, improved matching, rules, transfer, split, provider-neutral imports, fake provider sync, Basiq adapter, IPC, UI, and regression tests.
- Placeholder scan: The plan contains concrete tasks, file paths, commands, and expected outcomes. No unspecified implementation gaps are required to complete a phase.
- Type consistency: Provider transactions use `provider`, `sourceAccountId`, `sourceTransactionId`, `date`, `payee`, `description`, `reference`, `amountCents`, `postedAt`, and `raw` consistently across tests and services.
- Safety: All work is scoped to `/Users/davidnaguib/Desktop/Ledgerly-bank-feeds`; the original `/Users/davidnaguib/Desktop/Ledgerly` remains untouched.

