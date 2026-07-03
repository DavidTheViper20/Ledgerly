# Ledgerly × Xero Information Architecture — Product/UI Plan

> **Status:** Product plan approved by David 2026-07-03 (this is the WHAT/WHY).
> **For agentic workers:** Do NOT implement directly from this document. Each pass below gets its own
> implementation plan (superpowers:writing-plans format) before execution. Reference screenshots:
> Xero Tax > Activity Statements (provided); other areas follow Xero's documented IA.

**Goal:** Restructure Ledgerly's navigation, reports library, tax/GST settings, bank-account
onboarding, and settings so a business user coming from Xero feels at home — Sales work lives in
Sales, Purchases in Purchases, reports are searchable and favouritable, tax settings are complete
and trustworthy, and bank linking routes through Basiq first.

**Constraint carried from the master plan:** local-first accounting engine stays untouched where
possible; these are IA/UX passes over existing services. No cloud/ledger architecture changes.

---

## 1. Target navigation (top bar)

| Current | Target |
|---|---|
| Dashboard · Business▾ · Accounting▾ · Projects · Payroll · Tax · Contacts | Dashboard · **Sales▾** · **Purchases▾** · Accounting▾ · **Reporting** · Payroll · Tax▾ · Contacts |

- **Sales▾**: Sales overview · Invoices · Quotes · Credit notes · Products & services (sellable items) · Customers (contacts filtered `is_customer`) · Sales settings
- **Purchases▾**: Purchases overview (Bills to pay) · Purchase orders · Supplier credits (ACCPAYCREDIT — engine support exists, needs a list screen) · Repeating bills · Expense claims · Suppliers (contacts filtered `is_supplier`) · Purchase settings
- **Accounting▾**: Bank accounts · Chart of accounts · Fixed assets · Budgets · Manual journals
- **Reporting**: top-level, opens the new report library (see §2). Remove Reports from Accounting▾.
- **Projects: removed** from nav. Feature flag `projects_enabled` (default off): hides the tab, the
  project columns in invoice/bill/expense line editors, and the dashboard widgets. Service + data +
  tests stay (no deletion, no migration) so re-enabling is a one-setting change.
- Old hash routes stay as aliases (`#/invoices` etc. unchanged; `#/projects` shows a "Projects is
  disabled" note with the setting toggle) so bookmarks and the smoke tour don't break.
- Customers/Suppliers are *views over the single contacts dataset* — no data model split.

## 2. Reporting — report library redesign

Current: flat grid of 10 cards. All required reports already exist (P&L, Balance Sheet, Trial
Balance, Account Transactions, Aged Receivables, Aged Payables, Tax Summary, BAS, Cash Flow
Forecast, Budget vs Actual). This pass is pure library UX:

- **Search box** filtering by report name/description as you type.
- **Star/favourite** on every report row (persisted per-org in a `report_favourites` setting).
- **Favourites section** pinned at the top (Xero-style), empty-state prompt to star reports.
- **Grouped categories** replacing the grid: *Financial statements* (P&L, Balance Sheet, Trial
  Balance) · *Payables & receivables* (Aged Receivables, Aged Payables) · *Taxes and balances*
  (Tax Summary, Activity Statement/BAS, Account Transactions) · *Budgets & forecasts* (Budget vs
  Actual, Cash Flow Forecast).
- **Row layout** like Xero's library: name + one-line description + star, grouped under category
  headings, two-column on wide windows — not cards.
- BAS row deep-links to the Tax section statement flow (single source of truth).

## 3. Bank accounts — feed-first add flow

Current: "Add bank account" opens the manual name/code/description form. Target:

- Primary button **"Add bank account"** on the Bank accounts screen launches the existing Basiq
  connect flow (same `bankFeed.startConnect` path as Settings): consent in browser → provider
  accounts listed → each selected account **auto-creates the local ledger account** (name/last-4
  prefilled from provider data) and maps it in one step.
- Secondary text link **"Add manually (no bank feed)"** → the current form, unchanged.
- If Ledgerly Cloud isn't configured/signed in, the primary button shows a short explainer with a
  one-click jump to Settings → Cloud account (never a dead button).
- Empty state on Bank accounts pushes "Connect your bank" as the hero action.

## 4. Tax/GST settings — complete, Xero-grade (the big pass)

New **BAS settings** workflow under Tax → Tax settings (replaces the small form), presented as a
grouped setup flow with an explainer per choice:

| Setting | Options | Engine impact |
|---|---|---|
| BAS form type | **Simpler BAS** (default) / Full BAS | Full BAS adds G2/G3/G10/G11 labels to statements |
| GST calculation period | Monthly / Quarterly / Annually | replaces `bas_cycle`; drives statement generation |
| GST accounting method | **Accruals** / Cash | Cash basis = GST recognised on payment date — new report engine path (biggest work item, staged separately) |
| PAYG withholding period | None / Monthly / Quarterly | Monthly W-labels between quarters generate monthly IAS statements in the inbox |
| PAYG income tax method | None / Option 1 (ATO instalment amount) / Option 2 (income × rate) | adds T-labels / 5A to statements; amount/rate stored in settings |
| Other obligations | Fuel tax credits, WET, LCT, FBT toggles | v1: toggles surface the labels on Full BAS with manual-entry fields; automated calculation is explicitly out of scope |

Staging inside this pass: **D1** settings model + statement label rendering → **D2** cash-basis GST
engine (needs its own test battery against payment-dated scenarios) → **D3** PAYG instalments/IAS
generation. D2/D3 are accounting-engine changes and must not ship without dedicated tests.

## 5. Tax section polish

Tax already has Activity statements (In progress / Needs attention / Completed), TPAR, and Tax
settings tabs. Remaining:
- Fold the new BAS settings (§4) into the Tax settings tab (one place, linked from Settings).
- Statement inbox wording pass: "In progress", "Needs attention" (with overdue badges), "Completed"
  exactly mirror Xero's language; each statement row states its lodgement path ("lodge at ATO
  Online Services, then mark as lodged") until DSP e-lodgement exists (Track B).

## 6. Settings reorganisation

Replace the single long settings page with a **settings home** (grouped index, Xero-style) linking
to focused panes:

- **Organisation**: name, legal name, ABN, address, contact, financial year end, base currency
- **Sales**: invoice/quote/credit prefixes & numbering, default payment terms (due days), (future: branding)
- **Purchases**: PO/claim prefixes & numbering, bill defaults
- **Taxes**: tax rates table · GST/BAS settings (links to Tax section §4) · tax label
- **Bank feeds**: connections, consent dashboard (manage/reconnect/revoke/data deletion)
- **Cloud account**: sign-in status, refresh, sign-out (existing card)
- **Security**: app lock (existing), session behaviour
- **Advanced**: chart of accounts, AI assistant, organisation management (create/switch/delete), Projects toggle
- Every pane reachable by direct hash route so other screens can deep-link (e.g. bank empty state → Cloud account).

## 7. Sequencing & effort

| Pass | Scope | Size | Depends on |
|---|---|---|---|
| A | Nav split (Sales/Purchases), Reporting top-level, Projects flag, supplier-credits screen | M | — |
| B | Report library (search/favourites/categories) | S–M | A |
| C | Bank feed-first add flow | S | cloud configured (done) |
| D1 | BAS settings model + labels | M | — |
| D2 | Cash-basis GST engine | L (risk) | D1 |
| D3 | PAYG instalments / IAS statements | M | D1 |
| E | Settings home reorganisation | M | A (nav), D1 (taxes pane) |

Recommended order: **A → C → B → D1 → E → D2 → D3** (visible wins first; engine-risk last).
Each pass: own implementation plan → subagent execution → tests + smoke routes updated → commit → push.

## 8. Out of scope / risks

- ATO e-lodgement (DSP registration — Track B, user action required: ABN + OSF security audit).
- Automated FTC/WET/LCT/FBT calculation (labels + manual entry only in v1).
- In-app bank search screen (explicitly not wanted; Basiq consent handles institution choice).
- **Risk:** cash-basis GST (D2) touches money math — requires accountant-grade test scenarios
  (partial payments, credit allocations, FX invoices) before release.
- **Risk:** nav rework touches every view's routing — smoke tour must be extended to cover the new
  menus before merging Pass A.
