// GL Accounting Types (Phase 1)
// These types support the accounting foundation tables

export type GLAccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export type GLJournalStatus = 'draft' | 'posted' | 'reversed';

export type GLPostingMode = 'MANUAL' | 'AUTO';

// ============================================================================
// GL Settings (Control Accounts Mapping)
// ============================================================================

export interface GLSettings {
  id: string;
  company_id: string;
  // Control account mappings
  cash_account_id: string | null;
  ar_control_account_id: string | null;
  ap_control_account_id: string | null;
  supplier_deposit_account_id: string | null;
  sales_revenue_account_id: string | null;
  cogs_account_id: string | null;
  inventory_account_id: string | null;
  // Posting configuration
  posting_mode: GLPostingMode;
  require_supplier_ack_for_payment_posting?: boolean;
  // Metadata
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface GLSettingsUpdate {
  cash_account_id?: string | null;
  ar_control_account_id?: string | null;
  ap_control_account_id?: string | null;
  supplier_deposit_account_id?: string | null;
  sales_revenue_account_id?: string | null;
  cogs_account_id?: string | null;
  inventory_account_id?: string | null;
  posting_mode?: GLPostingMode;
  require_supplier_ack_for_payment_posting?: boolean;
}

// Settings with joined account details for display
export interface GLSettingsWithAccounts extends GLSettings {
  cash_account?: GLAccount | null;
  ar_control_account?: GLAccount | null;
  ap_control_account?: GLAccount | null;
  supplier_deposit_account?: GLAccount | null;
  sales_revenue_account?: GLAccount | null;
  cogs_account?: GLAccount | null;
  inventory_account?: GLAccount | null;
}

// Control account configuration definition (for UI)
export interface ControlAccountConfig {
  key: keyof GLSettingsUpdate;
  label: string;
  description: string;
  requiredForPosting: boolean;
  accountTypes: GLAccountType[]; // Filter accounts to show
}

export interface GLAccount {
  id: string;
  company_id: string;
  code: string;
  name: string;
  account_type: GLAccountType;
  subtype: string | null;
  description: string | null;
  parent_account_id: string | null;
  is_active: boolean;
  is_system: boolean;
  normal_balance: 'DEBIT' | 'CREDIT';
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface GLAccountInsert {
  company_id: string;
  code: string;
  name: string;
  account_type: GLAccountType;
  subtype?: string | null;
  description?: string | null;
  parent_account_id?: string | null;
  is_active?: boolean;
  is_system?: boolean;
  normal_balance?: 'DEBIT' | 'CREDIT';
}

export interface GLAccountUpdate {
  code?: string;
  name?: string;
  account_type?: GLAccountType;
  subtype?: string | null;
  description?: string | null;
  parent_account_id?: string | null;
  is_active?: boolean;
  normal_balance?: 'DEBIT' | 'CREDIT';
}

export interface GLJournal {
  id: string;
  company_id: string;
  journal_no: string;
  journal_date: string;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  status: GLJournalStatus;
  total_debit: number;
  total_credit: number;
  posted_at: string | null;
  posted_by: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reversal_of_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface GLJournalLine {
  id: string;
  journal_id: string;
  account_id: string;
  line_no: number;
  description: string | null;
  debit_amount: number;
  credit_amount: number;
  currency_code: string;
  created_at: string;
  // Joined fields
  account?: GLAccount;
}

export interface GLDocumentPosting {
  id: string;
  company_id: string;
  document_id: string;
  journal_id: string;
  posting_type: string;
  posted_at: string;
  posted_by: string | null;
}

// API Response types
export interface GLAccountsListResponse {
  accounts: GLAccount[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GLAccountsFilters {
  search?: string;
  accountType?: GLAccountType | 'ALL';
  isActive?: boolean | 'ALL';
  page?: number;
  pageSize?: number;
  sortBy?: 'code' | 'name' | 'account_type';
  sortOrder?: 'asc' | 'desc';
}

// Default Chart of Accounts template for seeding
export const DEFAULT_COA_TEMPLATE: Omit<GLAccountInsert, 'company_id'>[] = [
  // Assets (1xxx)
  { code: '1000', name: 'Assets', account_type: 'ASSET', subtype: 'Header', is_system: true, normal_balance: 'DEBIT' },
  { code: '1100', name: 'Cash and Bank', account_type: 'ASSET', subtype: 'Current Asset', normal_balance: 'DEBIT' },
  { code: '1110', name: 'Cash on Hand', account_type: 'ASSET', subtype: 'Current Asset', normal_balance: 'DEBIT' },
  { code: '1120', name: 'Bank Account', account_type: 'ASSET', subtype: 'Current Asset', normal_balance: 'DEBIT' },
  { code: '1200', name: 'Accounts Receivable', account_type: 'ASSET', subtype: 'Current Asset', is_system: true, normal_balance: 'DEBIT' },
  { code: '1210', name: 'Trade Receivables', account_type: 'ASSET', subtype: 'Current Asset', normal_balance: 'DEBIT' },
  { code: '1300', name: 'Inventory', account_type: 'ASSET', subtype: 'Current Asset', is_system: true, normal_balance: 'DEBIT' },
  { code: '1400', name: 'Prepaid Expenses', account_type: 'ASSET', subtype: 'Current Asset', normal_balance: 'DEBIT' },
  { code: '1500', name: 'Fixed Assets', account_type: 'ASSET', subtype: 'Fixed Asset', normal_balance: 'DEBIT' },

  // Liabilities (2xxx)
  { code: '2000', name: 'Liabilities', account_type: 'LIABILITY', subtype: 'Header', is_system: true, normal_balance: 'CREDIT' },
  { code: '2100', name: 'Accounts Payable', account_type: 'LIABILITY', subtype: 'Current Liability', is_system: true, normal_balance: 'CREDIT' },
  { code: '2110', name: 'Trade Payables', account_type: 'LIABILITY', subtype: 'Current Liability', normal_balance: 'CREDIT' },
  { code: '2200', name: 'Accrued Expenses', account_type: 'LIABILITY', subtype: 'Current Liability', normal_balance: 'CREDIT' },
  { code: '2300', name: 'Deposits Received', account_type: 'LIABILITY', subtype: 'Current Liability', normal_balance: 'CREDIT' },
  { code: '2400', name: 'GST/SST Payable', account_type: 'LIABILITY', subtype: 'Current Liability', normal_balance: 'CREDIT' },

  // Equity (3xxx)
  { code: '3000', name: 'Equity', account_type: 'EQUITY', subtype: 'Header', is_system: true, normal_balance: 'CREDIT' },
  { code: '3100', name: 'Share Capital', account_type: 'EQUITY', subtype: 'Capital', normal_balance: 'CREDIT' },
  { code: '3200', name: 'Retained Earnings', account_type: 'EQUITY', subtype: 'Retained Earnings', is_system: true, normal_balance: 'CREDIT' },

  // Income (4xxx)
  { code: '4000', name: 'Income', account_type: 'INCOME', subtype: 'Header', is_system: true, normal_balance: 'CREDIT' },
  { code: '4100', name: 'Sales Revenue', account_type: 'INCOME', subtype: 'Operating Income', is_system: true, normal_balance: 'CREDIT' },
  { code: '4200', name: 'Service Revenue', account_type: 'INCOME', subtype: 'Operating Income', normal_balance: 'CREDIT' },
  { code: '4900', name: 'Other Income', account_type: 'INCOME', subtype: 'Other Income', normal_balance: 'CREDIT' },

  // Expenses (5xxx-6xxx)
  { code: '5000', name: 'Cost of Goods Sold', account_type: 'EXPENSE', subtype: 'Header', is_system: true, normal_balance: 'DEBIT' },
  { code: '5100', name: 'Purchases', account_type: 'EXPENSE', subtype: 'Direct Cost', is_system: true, normal_balance: 'DEBIT' },
  { code: '5200', name: 'Freight In', account_type: 'EXPENSE', subtype: 'Direct Cost', normal_balance: 'DEBIT' },
  { code: '6000', name: 'Operating Expenses', account_type: 'EXPENSE', subtype: 'Header', normal_balance: 'DEBIT' },
  { code: '6100', name: 'Salaries & Wages', account_type: 'EXPENSE', subtype: 'Operating Expense', normal_balance: 'DEBIT' },
  { code: '6200', name: 'Rent Expense', account_type: 'EXPENSE', subtype: 'Operating Expense', normal_balance: 'DEBIT' },
  { code: '6300', name: 'Utilities', account_type: 'EXPENSE', subtype: 'Operating Expense', normal_balance: 'DEBIT' },
  { code: '6400', name: 'Marketing & Advertising', account_type: 'EXPENSE', subtype: 'Operating Expense', normal_balance: 'DEBIT' },
  { code: '6900', name: 'Other Expenses', account_type: 'EXPENSE', subtype: 'Other Expense', normal_balance: 'DEBIT' },
];

// ============================================================================
// MINIMAL STARTER CoA (for initial setup - 6 core accounts)
// ============================================================================
// Use this for "Create Starter Accounts" button when no accounts exist
export const STARTER_COA_TEMPLATE: Omit<GLAccountInsert, 'company_id'>[] = [
  // Assets
  { code: '1100', name: 'Cash / Bank', account_type: 'ASSET', subtype: 'Current Asset', is_system: true, normal_balance: 'DEBIT', description: 'Cash on hand and bank accounts' },
  { code: '1200', name: 'Accounts Receivable', account_type: 'ASSET', subtype: 'Current Asset', is_system: true, normal_balance: 'DEBIT', description: 'AR Control - amounts owed by customers' },
  { code: '1400', name: 'Supplier Deposits', account_type: 'ASSET', subtype: 'Current Asset', is_system: true, normal_balance: 'DEBIT', description: 'Prepayments to suppliers (30/70, 50/50 deposits)' },
  // Liabilities
  { code: '2100', name: 'Accounts Payable', account_type: 'LIABILITY', subtype: 'Current Liability', is_system: true, normal_balance: 'CREDIT', description: 'AP Control - amounts owed to suppliers' },
  // Income
  { code: '4100', name: 'Sales Revenue', account_type: 'INCOME', subtype: 'Operating Income', is_system: true, normal_balance: 'CREDIT', description: 'Revenue from product sales' },
  // Expense
  { code: '5100', name: 'Cost of Goods Sold', account_type: 'EXPENSE', subtype: 'Direct Cost', is_system: true, normal_balance: 'DEBIT', description: 'COGS - cost of products sold (for future use)' },
];

// ============================================================================
// Control Account Configuration (for Settings UI)
// ============================================================================
export const CONTROL_ACCOUNT_CONFIGS: ControlAccountConfig[] = [
  {
    key: 'cash_account_id',
    label: 'Cash / Bank Account',
    description: 'Default account for cash receipts and payments',
    requiredForPosting: true,
    accountTypes: ['ASSET']
  },
  {
    key: 'ar_control_account_id',
    label: 'AR Control Account',
    description: 'Accounts Receivable control for customer invoices',
    requiredForPosting: true,
    accountTypes: ['ASSET']
  },
  {
    key: 'ap_control_account_id',
    label: 'AP Control Account',
    description: 'Accounts Payable control for supplier invoices',
    requiredForPosting: true,
    accountTypes: ['LIABILITY']
  },
  {
    key: 'supplier_deposit_account_id',
    label: 'Supplier Deposit Account',
    description: 'Prepayments/deposits to suppliers (30/70, 50/50 terms)',
    requiredForPosting: true,
    accountTypes: ['ASSET']
  },
  {
    key: 'sales_revenue_account_id',
    label: 'Sales Revenue Account',
    description: 'Default revenue account for customer invoices',
    requiredForPosting: true,
    accountTypes: ['INCOME']
  },
  {
    key: 'cogs_account_id',
    label: 'Cost of Goods Sold',
    description: 'COGS account for inventory costing (future use)',
    requiredForPosting: false,
    accountTypes: ['EXPENSE']
  },
  {
    key: 'inventory_account_id',
    label: 'Inventory Account',
    description: 'Inventory asset account (future use)',
    requiredForPosting: false,
    accountTypes: ['ASSET']
  }
];

// ============================================================================
// Currency Settings
// ============================================================================

export interface CurrencySettings {
  id?: string;
  company_id?: string;
  base_currency_code: string;
  base_currency_name: string;
  base_currency_symbol: string;
  decimal_places: number;
  thousand_separator: string;
  decimal_separator: string;
  symbol_position: 'before' | 'after';
  created_at?: string;
  updated_at?: string;
}

// ============================================================================
// Fiscal Year & Period Management
// ============================================================================

export type FiscalYearStatus = 'open' | 'closed' | 'locked';
export type FiscalPeriodStatus = 'future' | 'open' | 'closed' | 'locked';
export type FiscalPeriodType = 'normal' | 'adjustment' | 'opening';

export interface FiscalYear {
  id: string;
  company_id: string;
  fiscal_year_name: string;
  fiscal_year_code: string;
  start_date: string;
  end_date: string;
  status: FiscalYearStatus;
  closed_at: string | null;
  closed_by: string | null;
  retained_earnings_posted: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  // Joined
  fiscal_periods?: FiscalPeriod[];
}

export interface FiscalPeriod {
  id: string;
  company_id: string;
  fiscal_year_id: string;
  period_number: number;
  period_name: string;
  start_date: string;
  end_date: string;
  status: FiscalPeriodStatus;
  period_type: FiscalPeriodType;
  closed_at: string | null;
  closed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FiscalYearInsert {
  company_id: string;
  fiscal_year_name: string;
  fiscal_year_code: string;
  start_date: string;
  end_date: string;
  status?: FiscalYearStatus;
}

export interface FiscalYearUpdate {
  fiscal_year_name?: string;
  status?: FiscalYearStatus;
}

export interface FiscalPeriodUpdate {
  status?: FiscalPeriodStatus;
}

// System Settings Response
export interface AccountingSystemSettings {
  currency: CurrencySettings;
  fiscalYears: FiscalYear[];
  currentFiscalYear: FiscalYear | null;
  currentPeriod: FiscalPeriod | null;
  company_id: string;
}
