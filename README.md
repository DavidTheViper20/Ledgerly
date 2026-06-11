# Ledgerly

A free, open desktop accounting application for small businesses — invoicing, bills,
bank reconciliation, double-entry ledger, payroll, projects and financial reporting.
All data stays in a local SQLite file on your machine; no subscription, no cloud account.

**Localised for Australia (Victoria):** 10% GST tax codes (GST on Income/Expenses,
GST Free, BAS Excluded), financial year ending 30 June, AUD base currency, ABN on
invoices, BAS activity-statement summary (G1/1A/1B/W1/W2), PAYG withholding and
12% superannuation guarantee in payroll. All of it remains configurable in Settings.

## Features

**Sales**
- Credit notes with allocation against invoices, partial allocations and cash refunds
- Repeating invoice/bill templates (weekly/monthly schedules, optional auto-approve,
  generated automatically at app start)
- Invoices with full lifecycle: Draft → Awaiting Approval → Awaiting Payment → Paid (plus Void)
- Quotes (Draft / Sent / Accepted / Declined) with one-click conversion to invoice
- Line items with quantities, unit prices, discounts, per-line account & tax rate
- Tax exclusive / inclusive / no-tax amount modes
- Automatic invoice & quote numbering (configurable prefix and sequence)
- Record part or full payments; print or export any document to PDF

**Purchases**
- Bills with the same approval/payment lifecycle, posted to Accounts Payable
- Purchase orders (draft → sent → approved → billed) with one-click conversion to bills
- Supplier credit notes
- Expense claims: receipts entered GST-inclusive, approval posts the GST and a
  reimbursement liability, then pay it from any bank account
- Products & services catalogue with default sale/purchase prices, accounts and tax rates

**Payroll (simplified AU)**
- Employees on annual salary or hourly rates, configurable super %
- Draft pay runs with estimated PAYG withholding (2025–26 resident brackets + Medicare
  levy) — every payslip amount is editable before posting
- Posting books gross wages, super expense, PAYG/super/wages payable; one-click net
  wage payment. W1/W2 flow onto the BAS summary
- Note: Single Touch Payroll lodgement requires ATO-certified software and is out of scope

**Projects**
- Projects with customers, default hourly rates, time entries
- Invoice unbilled time into a draft invoice in one step
- Profitability per project: invoice revenue vs bill/spend/expense-claim costs

**Fixed assets**
- Asset register with straight-line depreciation, monthly posting runs
- Disposal with sale proceeds and automatic gain/loss calculation

**Multi-currency**
- Invoices and bills in foreign currencies with manual exchange rates
- Ledger posts in AUD at the document rate; payments capture the rate on the day and
  realised FX gains/losses post automatically (bank accounts stay in AUD)

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
- Account Transactions with running balance, GST Summary
- BAS activity statement summary (Simpler BAS: G1, 1A, 1B, W1, W2)
- Cash flow forecast (weekly projection from invoices and bills due)
- Budget manager with monthly budgets per account and Budget vs Actual report
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
npm test           # unit tests for the accounting core (39 tests)
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
