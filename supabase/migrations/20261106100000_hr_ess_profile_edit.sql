-- ============================================================================
-- HR — Employee Self-Service hybrid profile editing (audit + approval columns)
-- ----------------------------------------------------------------------------
-- NOT APPLIED. Apply by hand per environment (staging first), after 20261105100000_hr_compensation_column_grants.sql.
-- Validated only on a throwaway PostgreSQL 17. Creates NO business data and NO assignments.
--
-- Category A (direct self-edit: contact number, current address, emergency contact) writes an audit row on every change
-- (before/after value, who, when), so a basic edit is always traceable.
--
-- Category B (sensitive change: legal name, IC/passport, bank account) reuses hr_profile_change_requests (request →
-- HR review → approve/reject → apply). This migration adds the columns the review step needs to record the outcome and
-- the applied result: rejection_reason and applied_at. reviewed_by/reviewed_at already record who reviewed and when.
--
-- Neither path writes hr_employee_compensation / hr_employee_allowances / hr_employee_deductions: salary and payroll data
-- stay outside ordinary ESS edit permissions by construction (those tables are HR-compensation-gated and read-only here).
--
-- Idempotent (if not exists). Rollback: drop the audit table and the two added columns.
-- ============================================================================

create table if not exists public.hr_profile_edit_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  field text not null,
  before_value text,
  after_value text,
  changed_by uuid not null,
  changed_at timestamptz not null default now()
);

-- Employee Self-Service requests only (insert own row, read own/HR rows) — no API role writes the audit table directly.
revoke all on table public.hr_profile_edit_audit from anon, authenticated;
grant all on table public.hr_profile_edit_audit to service_role;

alter table public.hr_profile_change_requests add column if not exists rejection_reason text;
alter table public.hr_profile_change_requests add column if not exists applied_at timestamptz;
