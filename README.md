# Ledgerly

A free, open desktop accounting application for small businesses — invoicing, bills,
bank reconciliation, double-entry ledger and financial reporting. All data stays in a
local SQLite file on your machine; no subscription, no cloud account.

## Features

**Sales**
- Invoices with full lifecycle: Draft → Awaiting Approval → Awaiting Payment → Paid (plus Void)
- Quotes (Draft / Sent / Accepted / Declined) with one-click conversion to invoice
- Line items with quantities, unit prices, discounts, per-line account & tax rate
- Tax exclusive / inclusive / no-tax amount modes
- Automatic invoice & quote numbering (configurable prefix and sequence)
- Record part or full payments; print or export any document to PDF

**Purchases**
- Bills with the same approval/payment lifecycle, posted to Accounts Payable
- Products & services catalogue with default sale/purchase prices, accounts and tax rates

**Banking**
- Multiple bank accounts; spend money, receive money and transfers
- Bank statement import from CSV (signed Amount or Debit/Credit columns, flexible dates)
- Reconciliation screen with automatic match suggestions, or create-and-code new
  transactions straight from a statement line
- Ledger balance vs statement balance shown side by side

**Accounting**
- True double-entry ledger: every document posts a balanced journal; reports are
  derived from posted journal lines, never from document totals
- Full editable chart of accounts (seeded with a standard small-business chart)
- Manual journals with draft/posted states and balance validation
- Configurable tax rates

**Reports**
- Profit & Loss, Balance Sheet, Trial Balance
- Aged Receivables and Aged Payables (current / 1–30 / 31–60 / 61–90 / 90+)
- Account Transactions with running balance, Tax Summary
- All reports printable and exportable to PDF

**Other**
- Dashboard with cash-flow chart, bank balances, invoice/bill status totals
- Contacts with customer/supplier flags, balances owed and full activity
- First-run setup wizard; org settings, financial year end, currency, tax label

## Getting started

Requires [Node.js](https://nodejs.org) 22.13+ (uses the built-in `node:sqlite` module —
no native compilation needed).

```bash
npm install
npm start          # run the app (data stored in your OS user-data folder)
npm run demo       # run with a throwaway database full of sample data
npm test           # unit tests for the accounting core (24 tests)
npm run smoke      # automated UI tour: every screen + scripted interactions
```

Your data lives in a single SQLite file (shown per platform under Electron's
`userData` directory, e.g. `~/.config/ledgerly/ledgerly.db` on Linux). Back it up by
copying that file. Set `LEDGERLY_DB=/path/to/file.db` to use a custom location.

## Architecture

```
electron/main.js      Electron shell, IPC, PDF export, smoke-test automation
electron/preload.js   contextBridge — renderer only sees ledgerly.call(method, args)
src/db.js             SQLite schema, migrations, seeding (node:sqlite)
src/coa.js            Default chart of accounts and tax rates
src/money.js          Integer-cents arithmetic, per-line tax calculation
src/services/         ledger (double-entry core), docs (invoices/bills/quotes),
                      bank (statements, reconciliation), reports
src/api.js            Method registry; every call wrapped in a DB transaction
ui/                   No-build-step SPA: hash router + vanilla JS views
tests/                node:test suite for the accounting core
scripts/              demo seeder, demo launcher, smoke runner
```

Design rules:

- **Money is integer cents** everywhere; rounding is half-away-from-zero per line.
- **Journals must balance** — `postJournal` rejects unbalanced input, so a corrupted
  ledger is structurally impossible.
- **Approved documents are immutable**; corrections go through void (which voids the
  journal) and re-issue, like real accounting systems.
- **Reports read only posted journals**, so P&L, Balance Sheet and Trial Balance always
  agree with each other.

## Packaging installers (optional)

The app runs fine via `npm start`. To build distributable installers, add
[electron-builder](https://www.electron.build):

```bash
npm i -D electron-builder
npx electron-builder --linux AppImage   # or --win nsis / --mac dmg on those platforms
```

## License

MIT
