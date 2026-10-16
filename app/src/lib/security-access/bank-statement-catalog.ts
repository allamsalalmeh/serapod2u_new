/**
 * Bank statement approval permissions (Finance → Cash & Banking). Seeded in
 * SHADOW and registered as enforcement-ready by
 * supabase/migrations/20261006160000_bank_statement_approval.sql
 * (bank-statement-catalog.test.ts keeps this list and the migration in step).
 * Until a security administrator enforces them, the legacy rule decides:
 * Super Admin only. Maker/checker is enforced by the database
 * (SoD rule bank-statement-maker-checker) in every mode.
 */
export interface BankStatementPermission {
  key: string
  role: string
  legacyRule: string
}

export const BANK_STATEMENT_PERMISSIONS: readonly BankStatementPermission[] = [
  { key: 'finance.statement.import', role: 'finance-statement-preparer', legacyRule: 'role_level 1 (Super Admin)' },
  { key: 'finance.statement.approve', role: 'finance-statement-approver', legacyRule: 'role_level 1 (Super Admin)' },
] as const

export const BANK_STATEMENT_PERMISSION_KEYS = BANK_STATEMENT_PERMISSIONS.map(p => p.key)

export const BANK_STATEMENT_SOD_RULE = 'bank-statement-maker-checker'
