# Cross-Module Finance Architecture Audit

Repository `serapod2u_dev` · branch `Enhancement03` · HEAD `82da8cd0` · 2026-10-24 (MYT) · **read-only; nothing changed, executed or committed.**

Legend: **[F]** verified repository fact (file / schema reference given) · **[R]** architectural recommendation.

Schema evidence: `supabase/schemas/audit/production_schema_20261016.sql` (production catalog dump, 2026-10-16; identical HR/finance shapes in the staging dump). The dumps contain **no GRANT/REVOKE statements**, so function EXECUTE rights were taken from `docs/security/phase0b-rpc-inventory.md` and must be re-verified live. Live databases were not queried.

---

## 0. Inputs reviewed

| Input | Location | Status |
|---|---|---|
| `HR Gap & Go-Live Readiness Audit.md` | `docs/hr/` (repository) | Present, read |
| `HR_REMEDIATION_DEPENDENCY_MATRIX.md`, `HR_SA_CONSOLIDATION_PLAN.md`, `HR_LEAVE_IMPLEMENTATION_DESIGN.md`, `HR_EMPLOYEE_LIFECYCLE_GAP_REVIEW.md`, `HR_PAYROLL_RISK_ASSESSMENT.md`, `HR_IMPLEMENTATION_SEQUENCE.md` | **Not in the repository.** They exist only as the deliverables of the previous session (this workspace, not committed per the read-only instruction). Read from there; not modified. | Present outside repo |
| Finance module | `app/src/app/finance/**`, `app/src/app/api/accounting/**`, `app/src/modules/finance/**`, `app/src/components/accounting/**` (views), GL functions in schema | Audited |
| S&A finance catalogue | migrations `2026092811…`, `20261006160000`, `20261110100000` | Audited |

### Newer evidence that changes prior HR conclusions

| Prior conclusion (HR reports) | Correction | Evidence |
|---|---|---|
| "Approve route does not enforce maker ≠ checker" (payroll report §8/§9, S&A plan §4) | **Already enforced in the database**: trigger `sa_payroll_run_transition_guard` calls `sa_enforce_same_document_sod('payroll-prepare-approve', …, coalesce(auth.uid(), new.approved_by), array[old.calculated_by])`; the rule was moved to `enforce` by `20261110100000`. The service-role approve path is covered because `approved_by` is set. | prod schema line ~35339; `20260928100000…sql:969`; status doc row 57 |
| "Replace the route calculation with a new DB function" (payroll report §8) | A schema-aligned DB primitive **already exists**: `compute_payroll_item(org, employee, start, end)` uses the real column names (`total_minutes`, `gross_amount`, `net_amount`) and `get_statutory_config(org)`; also `get_payroll_ready_work_minutes`. **No application caller.** Its statutory logic is still simplified (flat %, RM5,000 ceiling, zero SOCSO/EIS above ceiling, PCB 0). → reuse as the base, not a greenfield function. | prod schema `compute_payroll_item` (~6310) |
| "`post_payroll_run_to_gl` never writes a shared idempotency marker" (payroll report P5) | It writes **`gl_document_postings`** (unique `company_id, document_type, document_id`) and `hr_payroll_audit` with correct columns. `hr_post_payroll_run_to_gl` writes `hr_gl_postings`. The double-posting conclusion stands (each checks only its own store). | function bodies |
| Payroll GL mapping is HR-owned (`hr_gl_mappings`) | There are **two** HR mapping models; the canonical-looking one (`payroll_components`, `payroll_component_gl_map`, `payroll_clearing_accounts`, `payroll_journals`, `payroll_payment_batches`) is **company-scoped and Finance-shaped**, and the commission outbox already uses its `COMMISSION` component code. | §3.3 |
| Commission migrations "not applied" (`STAFF_COMMISSION.md`) | Recorded verified applied on staging and production (2026-10-16). | `PRODUCTION_MIGRATION_STATUS.md` rows 48–49 |

---

## 1. Executive summary

**[F]** Serapod2U already has a real double-entry General Ledger (`gl_accounts`, `gl_journals`, `gl_journal_lines`, fiscal years/periods, trial balance / P&L / balance sheet reports), a **pull-based posting queue for supply-chain documents** (`v_pending_gl_postings` → `post_document_to_gl` → `gl_document_postings`), a mature two-person **bank statement** workflow, and a well-designed **commission → payroll outbox**. It does **not** have AP/AR subledgers of its own, cost centres, financial dimensions, multi-currency journals, a period-lock that all posting paths respect, posted-journal immutability, or a single posting contract.

**[F]** Eleven database functions write journals directly, using **three different idempotency stores** and **two HR mapping models**; authorization ranges from S&A operation guards to legacy `is_hq_admin()` to none.

**[R]** Do not build a new engine. Standardise on: `gl_document_postings` as the single idempotency ledger, a new generic **posting request** table filled by source modules (transactional outbox), a single Finance-owned posting function that reuses `post_document_to_gl`'s journal-writing core and `is_posting_date_allowed`, and the existing cron-lease worker pattern (`notifications_outbox` + `cron_worker_leases`) for asynchronous processing.

---

## 2. Finance module inventory

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Chart of Accounts | **IMPLEMENTED** | `gl_accounts` (company_id, code, type, subtype, parent, normal_balance, is_system); `/api/accounting/accounts*`, seed route; `ChartOfAccountsTab` | Company = HQ organization |
| GL journals | **IMPLEMENTED** (system-generated only) | `gl_journals` (status, reversal links, totals, posted_by/at), `gl_journal_lines` (account, debit, credit, `entity_type/entity_id`); `/api/accounting/journals` GET only | **No manual journal entry API/UI**; RLS lets `finance.journal.post` holders insert journals directly through PostgREST (bypassing posting functions) |
| Posted-journal immutability | **MISSING** | Only `update_gl_journals_updated_at` trigger; RLS allows UPDATE only on `DRAFT`, but service role/definer functions can change anything | [R] append-only guard for POSTED/REVERSED |
| Journal numbering | IMPLEMENTED | `generate_journal_number(company[, type])`, unique `(company_id, journal_number)` | |
| Fiscal years / periods | **PARTIAL** | `fiscal_years`, `fiscal_periods` (open/closed/locked), `generate_fiscal_periods` (S&A guarded), period PUT route | `is_posting_date_allowed()` exists but is called **only** by `post_payroll_run_to_gl`; `post_document_to_gl`, the `hr_post_*` family and `reverse_gl_journal` ignore periods. `close_fiscal_period()` has no authorization check (classified SERVER in phase0b, no app caller) |
| Posting rules | **CONFIG WITHOUT EFFECT** | `gl_posting_rules` table + Posting Rules screen | Actual rules are hard-coded `CASE` blocks in `get_posting_preview()`; the table is not read by posting |
| Default accounts | IMPLEMENTED | `gl_settings` (cash, AR, AP, supplier deposit, revenue, COGS, inventory, `posting_mode`) | `inventory_account_id` unused by any posting |
| Supply-chain posting | **IMPLEMENTED (5 types)** | `postingMap.ts`; `v_pending_gl_postings`; `post_document_to_gl` (S&A `finance.journal.post`); auto-post triggers on `documents` when `gl_settings.posting_mode = 'AUTO'` (errors swallowed) | Company resolved from the **actor**, not the document; no period check |
| AR | **READ-ONLY VIEWS** | `/api/accounting/ar/{invoices,receipts,aging}` read `documents` + `gl_document_postings` | No AR subledger, no customer statements, no credit notes; only D2H flow |
| AP | **READ-ONLY VIEWS** | `/api/accounting/ap/{bills,payments,aging}` read `documents` | No vendor bills outside H2M orders, no payment runs |
| Payments / settlement | **PARTIAL** | Supplier deposit/balance payments via supply-chain documents (`finance.payment.approve`, SoD `payment-request-maker-checker` enforce); `payroll_payment_batches` (+`post_payroll_payment_to_gl`, no app caller); `payment_terms` | No generic payment/settlement object |
| Cash & banking | **IMPLEMENTED (strongest)** | `bank_accounts`, statement import/stage/submit/approve/reverse with SHA-256 dedupe, immutable lines, events log, SoD `bank-statement-maker-checker` (enforce), reconciliation tables + route | Reference implementation for governance |
| Currency | **PARTIAL** | `accounting_currency_settings` (base currency), `exchange_rates`, settings screen | Journals and lines have **no currency / FX columns**; `payroll_journals` has currency + rate; storefront/marketplace carry currency |
| Tax | PARTIAL | `tax_codes` (rate, account, effective dates) | Not used by any posting |
| Budgets | DATA ONLY | `gl_budgets`, `gl_budget_lines` | No UI found in finance nav views listed |
| Cost centres / dimensions | **MISSING** | none | Only `gl_journal_lines.entity_type/entity_id` |
| Reports | IMPLEMENTED | trial balance, P&L, balance sheet, GL detail, cash flow routes | |
| Finance audit | **PARTIAL** | journal created_by/posted_by; `bank_statement_events` (append-only); `system_log_events`; S&A decision log | No append-only finance action log for posting/reversal/period changes |
| Destructive reset | EXISTS | `/api/accounting/reset` (`finance.data.reset`) | Must be excluded from any post-go-live environment |
| UI placeholders | — | `FinancePlaceholderView` imported in `DashboardContent.tsx:67` but unused; every finance route maps to a real view | |

### 2.1 Organization / legal-entity ownership **[F]**

- "Company" = the nearest ancestor organization with `org_type_code = 'HQ'` (`get_company_id(org)`); `get_user_company_id()` applies it to the caller. All GL, fiscal, payroll-mapping and bank tables key on `company_id`.
- HR tables key on `organization_id` (the employee's organization); payroll GL resolves `get_company_id(run.organization_id)`.
- There is **no legal-entity table**; `organizations` carries `registration_no`, `tax_id`, bank fields. Distributors/shops/manufacturers are business partners (separate organizations, not group legal entities).
- **Risk [F]:** functions that derive company from the **actor** (`post_document_to_gl`, `get_posting_preview`, `reverse_gl_journal`, `post_payroll_payment_to_gl` S&A context) rather than from the source record will mis-scope as soon as one person can act for two HQ companies (S&A organization scopes allow it).

### 2.2 Finance S&A permissions **[F]**

`finance.module.view`, `finance.ledger.view`, `finance.journal.post`, `finance.account.manage`, `finance.settings.manage`, `finance.payroll_integration.manage`, `finance.payment.approve`, `finance.cash.view`, `finance.cash.prepare`, `finance.statement.import/approve`, `finance.reconciliation.perform`, `finance.payable.view`, `finance.receivable.view`, `finance.report.view/_sensitive`, `finance.data.reset`; HR side `hr.payroll.release`. SoD rules: `payroll-prepare-approve` (enforce), `payroll-prepare-release`, `payment-request-maker-checker` (enforce), `bank-statement-maker-checker` (enforce), `security-admin-vs-payment-approval`, `order-maker-checker`.

---

## 3. Journal-writing paths (source of truth for "who can create GL entries")

| # | Function | Source | Auth inside | Period check | Idempotency store | Mapping source | App caller |
|---|---|---|---|---|---|---|---|
| 1 | `post_document_to_gl` | supply-chain documents | `sa_require_operation('finance.journal.post')` + legacy HQ | ✗ | `gl_document_postings` | hard-coded + `gl_settings` | `/api/accounting/posting` |
| 2 | `_auto_post_document_to_gl_internal` (via triggers) | same | none (SERVER) | ✗ | `gl_document_postings` | same | triggers on `documents` |
| 3 | `post_customer_receipt_to_gl` | receipts | none (SERVER) | ✗ | — | — | none |
| 4 | `batch_post_documents` | documents | `is_hq_admin()` | ✗ | via #1 | — | none |
| 5 | `post_payroll_run_to_gl` | payroll run | `hr.payroll.release` + legacy staff | **✓** | `gl_document_postings` + `hr_payroll_runs.gl_status` | `payroll_component_gl_map` + `payroll_clearing_accounts` | `/api/hr/payroll/post-to-gl` |
| 6 | `post_payroll_payment_to_gl` | payroll payment batch | `hr.payroll.release` (actor org) | ✗ | `gl_document_postings` + batch `gl_journal_id` | clearing accounts | none |
| 7 | `hr_post_payroll_run_to_gl` | payroll run | `hr.payroll.release` | ✗ | `hr_gl_postings` | `hr_gl_mappings` | `/api/hr/finance/post-payroll-run` (no UI) |
| 8 | `hr_post_payroll_payment_to_gl` | payroll run | **none** (invoker; RLS on `gl_journals`) | ✗ | `hr_gl_postings` | `hr_gl_mappings` | none |
| 9 | `hr_post_statutory_payment_to_gl` | free amount | **none** (invoker) | ✗ | — | `hr_gl_mappings` | none |
| 10 | `hr_post_expense_claim_to_gl` / `hr_post_expense_reimbursement_to_gl` | expense claims | `finance.journal.post` / **none** | ✗ | `hr_gl_postings` | `hr_gl_mappings` | `/api/hr/finance/post-expense-claim` |
| 11 | `hr_post_benefit_contribution_run_to_gl` | benefits | `finance.journal.post` | ✗ | `hr_gl_postings` | `hr_gl_mappings` | `/api/hr/finance/post-benefit-contribution-run` (orphaned UI) |
| — | `reverse_gl_journal` | any journal | legacy `is_hq_admin()` only | ✗ | updates `gl_document_postings` | — | via `reverse_payroll_gl_posting` |

Not posting to GL at all **[F]**: inventory/stock movements (carry `unit_cost/total_cost`), warehouse receipts, stock transfers, storefront orders (Stripe-paid), marketplace settlements/payouts, logistics (EasyParcel costs on `storefront_orders.shipping_actual_cost`), commission (outbox only), payment gateway.

### 3.1 Idempotency models

| Store | Key | Used by | Weakness |
|---|---|---|---|
| `gl_document_postings` | unique `(company_id, document_type, document_id)`; `posting_status` POSTED/REVERSED | #1, #2, #5, #6 | A reversed document can never be re-posted (unique row stays) — correct for immutable sources, wrong for "rerun" semantics |
| `hr_gl_postings` | unique `(document_type, document_id)` (no org) | #7–#11 | Separate universe; HR reset blockers check it, Finance views do not |
| Source-row markers | `hr_payroll_runs.gl_status/gl_journal_id`, `payroll_payment_batches.gl_journal_id`, `hr_commission_payroll_transfers.gl_journal_id` | #5, #6 | Fine as denormalised pointers if one store is authoritative |

### 3.2 Notable defects in journal writers **[F]**

- `hr_post_payroll_run_to_gl`: when no employer-expense account is mapped it sets `v_total_debit := v_total_credit` ("force balance") — the header can claim balance while lines do not balance; no `created_by/posted_by`; no reversal path; `p_amount` accepted but unused.
- `post_payroll_run_to_gl`: `payroll_component_gl_map` has `effective_from/effective_to` but the function filters only `is_active` (effective dating ignored); `payroll_journals` rows are never cleared, so a reverse-then-repost would duplicate them (re-post is blocked anyway by the unique `gl_document_postings` row).
- `reverse_gl_journal`: no S&A key, no period check on the reversal date.

### 3.3 Two HR GL mapping models

| | Model 1 — company payroll components | Model 2 — HR document mappings |
|---|---|---|
| Tables | `payroll_components` (code, category, statutory, taxable), `payroll_component_gl_map` (effective-dated Dr/Cr), `payroll_clearing_accounts`, `payroll_journals`, `payroll_payment_batches` | `hr_gl_mappings` (organization, document_type, mapping_key, expense/offset accounts), `hr_gl_postings` |
| Scope | `company_id` (Finance-shaped) | `organization_id` |
| UI / API | HR Settings → Accounting (`HrAccountingView`), `/api/hr/accounting/{mappings,control-accounts,preview-journal}`, `/api/hr/payroll/components` (+ seed RPCs) | `modules/hr/accounting/actions.ts` (`setup_hr_gl_mappings`, `apply_hr_coa_template`), `/api/hr/finance/gl-mappings` (Benefits, Time & Expense — both orphaned screens) |
| Posting | #5, #6 | #7–#11 |
| Commission | `COMMISSION` component (seeded 6140/2200) referenced by `hr_commission_payroll_transfers.payroll_component_code` | — |

**[R]** Model 1 is the canonical payroll mapping model; Model 2 is retired for payroll and later replaced for expenses/benefits by the shared framework (Phase D).

---

## 4. Supply chain & e-commerce financial events

| Capability | Exists? | Where | Reusable? |
|---|---|---|---|
| Financial event publishing | Partial | `order_status_events` (append-only order transitions), `storefront_order_events`, `bank_statement_events` | Pattern yes; not finance events |
| Posting queue / outbox | **Yes, two styles** | Pull: `v_pending_gl_postings` (derived queue); Push: `hr_commission_payroll_transfers` (idempotency key, status, run/item/GL refs); generic `notifications_outbox` (status, retry_count, max_retries, next_retry_at, scheduled_for) + `notification_logs` | **Yes** — outbox shape + worker |
| Worker / retry | **Yes** | `/api/cron/notification-outbox-worker`, `lib/cron-scheduler.ts`, `cron_worker_leases` (single-owner lease), System Logs worker report | **Yes** |
| Common accounting mappings | Partial | `gl_settings` (supply chain), Model 1 (payroll) | Extend, don't duplicate |
| Journal preparation | Yes | `get_posting_preview()` (preview lines before posting) | Pattern yes |
| Idempotency keys | Yes | `gl_document_postings` unique, `post_warehouse_receipt(p_idempotency_key)`, `marketplace_settlements.dedupe_key`, commission transfer `idempotency_key`, S&A/HR `request_id` patterns | **Yes** |
| Reconciliation | Partial | bank reconciliation; `v_documents_gl_status`, `get_document_gl_status` | Pattern yes |
| Finance posting authorization | Yes | `finance.journal.post`, `hr.payroll.release`, SoD framework (`sa_enforce_same_document_sod`, mitigations) | **Yes** |
| Marketplace / storefront / logistics → GL | **No** | `marketplace_settlements` (revenue, fees, refunds, currency), `marketplace_payouts`, `storefront_orders` (total, shipping, subsidy, paid_at, payment_ref) | Data is posting-ready-ish; mapping absent |
| Inventory valuation → GL | **No** | `stock_movements.unit_cost/total_cost` | Phase D |

---

## 5. Critical gaps (cross-module)

| ID | Gap | Severity | Phase |
|---|---|---|---|
| G1 | Three idempotency stores, eleven journal writers, no single posting contract | High | C |
| G2 | Period lock enforced by one writer only; reversals ignore periods | High | C (B for payroll) |
| G3 | Posted journals mutable by privileged paths; GL tables insertable by `finance.journal.post` holders directly | High | C |
| G4 | Company derived from actor in several functions | High (multi-HQ) | C |
| G5 | No cost centre / dimension model; HR departments are org-scoped operational units | Medium (blocks cost allocation) | A (decision) / C (build) |
| G6 | No currency on journals | Medium | C |
| G7 | Unguarded invoker HR posting functions (#8, #9, #10b) rely only on RLS | Medium | B (revoke) |
| G8 | Payroll source data invalid (column drift, statutory) — prior HR reports | Critical for payroll | B |
| G9 | Posting rules table has no effect | Low | C |
| G10 | No finance action audit log | Medium | C |

---

## 6. Reusable components (to preserve)

1. `post_document_to_gl` journal-writing core (balance check, numbering, lines, `gl_document_postings` insert).
2. `get_posting_preview` pattern (preview before post).
3. `gl_document_postings` as the idempotency ledger.
4. `is_posting_date_allowed` + fiscal periods.
5. Model 1 payroll components & effective-dated GL map; `payroll_payment_batches`.
6. `hr_commission_payroll_transfers` outbox and commission lifecycle (`… → locked → payroll_ready`).
7. `notifications_outbox` + cron worker + `cron_worker_leases` + System Logs worker reporting.
8. Bank statement maker-checker model (SoD rule + mitigation + immutable lines + events).
9. S&A `sa_require_operation`, `sa_enforce_same_document_sod`, controlled-action pattern (`request_id`, preview token, append-only action record) used by HR delete/reset and identity lifecycle.
