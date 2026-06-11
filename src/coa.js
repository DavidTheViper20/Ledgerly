'use strict';

// Default tax rates. Editable in Settings.
const DEFAULT_TAX_RATES = [
  { name: 'No Tax (0%)', rate: 0 },
  { name: 'Tax on Sales (20%)', rate: 20 },
  { name: 'Tax on Purchases (20%)', rate: 20 },
  { name: 'Reduced Rate (5%)', rate: 5 },
];

// Account types and the class they roll up to.
const ACCOUNT_TYPES = {
  BANK: 'ASSET',
  CURRENT_ASSET: 'ASSET',
  FIXED_ASSET: 'ASSET',
  INVENTORY: 'ASSET',
  NON_CURRENT_ASSET: 'ASSET',
  PREPAYMENT: 'ASSET',
  CURRENT_LIABILITY: 'LIABILITY',
  NON_CURRENT_LIABILITY: 'LIABILITY',
  EQUITY: 'EQUITY',
  REVENUE: 'REVENUE',
  OTHER_INCOME: 'REVENUE',
  DIRECT_COSTS: 'EXPENSE',
  EXPENSE: 'EXPENSE',
  OTHER_EXPENSE: 'EXPENSE',
  DEPRECIATION: 'EXPENSE',
};

const TYPE_LABELS = {
  BANK: 'Bank',
  CURRENT_ASSET: 'Current Asset',
  FIXED_ASSET: 'Fixed Asset',
  INVENTORY: 'Inventory',
  NON_CURRENT_ASSET: 'Non-current Asset',
  PREPAYMENT: 'Prepayment',
  CURRENT_LIABILITY: 'Current Liability',
  NON_CURRENT_LIABILITY: 'Non-current Liability',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  OTHER_INCOME: 'Other Income',
  DIRECT_COSTS: 'Direct Costs',
  EXPENSE: 'Expense',
  OTHER_EXPENSE: 'Other Expense',
  DEPRECIATION: 'Depreciation',
};

// Default chart of accounts for a small business.
// system: key used by the ledger engine to locate control accounts.
const DEFAULT_ACCOUNTS = [
  { code: '200', name: 'Sales', type: 'REVENUE', tax: 'sales' },
  { code: '260', name: 'Other Revenue', type: 'OTHER_INCOME', tax: 'sales' },
  { code: '270', name: 'Interest Income', type: 'OTHER_INCOME', tax: 'none' },

  { code: '310', name: 'Cost of Goods Sold', type: 'DIRECT_COSTS', tax: 'purchases' },

  { code: '400', name: 'Advertising', type: 'EXPENSE', tax: 'purchases' },
  { code: '404', name: 'Bank Fees', type: 'EXPENSE', tax: 'none' },
  { code: '408', name: 'Cleaning', type: 'EXPENSE', tax: 'purchases' },
  { code: '412', name: 'Consulting & Accounting', type: 'EXPENSE', tax: 'purchases' },
  { code: '416', name: 'Depreciation', type: 'DEPRECIATION', tax: 'none' },
  { code: '420', name: 'Entertainment', type: 'EXPENSE', tax: 'none' },
  { code: '425', name: 'Freight & Courier', type: 'EXPENSE', tax: 'purchases' },
  { code: '429', name: 'General Expenses', type: 'EXPENSE', tax: 'purchases' },
  { code: '433', name: 'Insurance', type: 'EXPENSE', tax: 'none' },
  { code: '437', name: 'Interest Expense', type: 'EXPENSE', tax: 'none' },
  { code: '441', name: 'Legal Expenses', type: 'EXPENSE', tax: 'purchases' },
  { code: '445', name: 'Light, Power, Heating', type: 'EXPENSE', tax: 'purchases' },
  { code: '449', name: 'Motor Vehicle Expenses', type: 'EXPENSE', tax: 'purchases' },
  { code: '453', name: 'Office Expenses', type: 'EXPENSE', tax: 'purchases' },
  { code: '461', name: 'Printing & Stationery', type: 'EXPENSE', tax: 'purchases' },
  { code: '469', name: 'Rent', type: 'EXPENSE', tax: 'purchases' },
  { code: '473', name: 'Repairs and Maintenance', type: 'EXPENSE', tax: 'purchases' },
  { code: '477', name: 'Salaries & Wages', type: 'EXPENSE', tax: 'none' },
  { code: '485', name: 'Subscriptions', type: 'EXPENSE', tax: 'purchases' },
  { code: '489', name: 'Telephone & Internet', type: 'EXPENSE', tax: 'purchases' },
  { code: '493', name: 'Travel', type: 'EXPENSE', tax: 'purchases' },
  { code: '497', name: 'Bad Debts', type: 'EXPENSE', tax: 'none' },

  { code: '610', name: 'Accounts Receivable', type: 'CURRENT_ASSET', tax: 'none', system: 'AR' },
  { code: '620', name: 'Prepayments', type: 'PREPAYMENT', tax: 'none' },
  { code: '630', name: 'Inventory', type: 'INVENTORY', tax: 'none' },

  { code: '710', name: 'Office Equipment', type: 'FIXED_ASSET', tax: 'purchases' },
  { code: '711', name: 'Less Accumulated Depreciation on Office Equipment', type: 'FIXED_ASSET', tax: 'none' },
  { code: '720', name: 'Computer Equipment', type: 'FIXED_ASSET', tax: 'purchases' },
  { code: '721', name: 'Less Accumulated Depreciation on Computer Equipment', type: 'FIXED_ASSET', tax: 'none' },

  { code: '800', name: 'Accounts Payable', type: 'CURRENT_LIABILITY', tax: 'none', system: 'AP' },
  { code: '820', name: 'Sales Tax', type: 'CURRENT_LIABILITY', tax: 'none', system: 'TAX' },
  { code: '825', name: 'Payroll Tax Payable', type: 'CURRENT_LIABILITY', tax: 'none' },
  { code: '830', name: 'Income Tax Payable', type: 'CURRENT_LIABILITY', tax: 'none' },
  { code: '840', name: 'Historical Adjustment', type: 'CURRENT_LIABILITY', tax: 'none', system: 'HISTORICAL' },
  { code: '850', name: 'Suspense', type: 'CURRENT_LIABILITY', tax: 'none' },
  { code: '860', name: 'Rounding', type: 'CURRENT_LIABILITY', tax: 'none', system: 'ROUNDING' },

  { code: '900', name: 'Loan', type: 'NON_CURRENT_LIABILITY', tax: 'none' },

  { code: '960', name: 'Retained Earnings', type: 'EQUITY', tax: 'none', system: 'RETAINED' },
  { code: '970', name: 'Owner A Funds Introduced', type: 'EQUITY', tax: 'none' },
  { code: '980', name: 'Owner A Drawings', type: 'EQUITY', tax: 'none' },
];

module.exports = { DEFAULT_TAX_RATES, DEFAULT_ACCOUNTS, ACCOUNT_TYPES, TYPE_LABELS };
