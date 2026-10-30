# HR — Payroll Risk Assessment (Task E)

Branch `Enhancement03` @ `82da8cd0` · read-only · 2026-10-24.
Schema evidence: production and staging catalog dumps of 2026-10-16 (`supabase/schemas/audit/*`) — the payroll tables are identical in both.

**Bottom line:** the payroll run path is not just "simplified" (baseline C4). As written, it **cannot produce payroll lines** against either database, it reports success anyway, its statutory settings cannot be saved, overtime always computes to zero, the audit trail is never written, and two GL routines can post the same run twice. Payroll must be treated as a rebuild of the calculation core on top of the existing (sound) run/approval/locking/RLS structure.

---

## 1. Defects that make the current run path invalid (P0)

| ID | Defect | Evidence | Effect |
|---|---|---|---|
| P1 | Line insert uses `employee_id`, `gross_salary`, `deductions`, `net_salary`; table has `employee_user_id`, `gross_amount`, `deductions_amount`, `net_amount`; NOT NULL `organization_id` not supplied | `runs/[id]/calculate/route.ts:143-161`; DDL `hr_payroll_run_items` | Every insert fails; `if (itemError) console.error(...)` (line 165) swallows it; run set to `calculated` with header totals and **zero lines**; approve locks it; payslips empty |
| P1b | Recalculation `delete()` then per-employee inserts, no transaction | line 63 | Partial runs possible even after the column fix |
| P2 | `hr_settings.config_key` does not exist | `statutory-settings/route.ts:18,51`; `calculate/route.ts:31` | Settings GET errors / PUT fails; calculation always uses hard-coded defaults |
| P3 | Timesheet columns `total_work_minutes/total_overtime_minutes` (actual `total_minutes`, `overtime_minutes`) | `calculate/route.ts:95-103` | Overtime = 0 for everyone |
| P4 | `hr_payroll_audit` columns `performed_by/details` (actual `actor_user_id/metadata`) | calculate:193-198, approve | No payroll audit rows |
| P7 | UI/preview read `gross_salary`, `net_salary`, `employee_id` | `HrPayrollPayslipsView.tsx:230,376-385`; `preview-journal/route.ts:58` | Totals show 0; journal preview errors |
| P9 | Former employees not excluded: selection is `compensation.status='active'` ∧ `onboarding_status='completed'`; employment `status/end_date` ignored; archive does not end compensation | calculate:44-58; lifecycle report D2 | Paying leavers once P1 is fixed |
| P10 | Approve sets `posted_at/posted_by` at approval time | `approve/route.ts:41` | Conflates approval with GL posting in reports |

## 2. Malaysian statutory gaps

| Scheme | Current code | Required behaviour (verify against the authoritative source in §5 at build time) | Effective-date notes |
|---|---|---|---|
| **EPF (KWSP)** | Flat 11% / 13% of **gross incl. OT and all allowances** | Third Schedule contribution table (banded amounts) for wages ≤ RM20,000, exact % above. Malaysian/PR < 60: employee 11%, employer 13% (wages ≤ RM5,000) / 12% (> RM5,000). Age 60–75: employee 0% (voluntary), employer 4%. **Non-Malaysians: 2% + 2% mandatory from 1 Oct 2025** (domestic workers excluded). EPF "wages" excludes overtime and certain payments — classify each pay component. | Rate set selected by wage month; foreign rule from Oct 2025 wages; age tier switches the month after the 60th birthday (confirm rule) |
| **SOCSO (PERKESO)** | Flat 0.5% / 1.75% of gross, no ceiling | Banded contribution table; **wage ceiling RM6,000 from 1 Oct 2024** (was RM5,000). Category 1 (< 60): Employment Injury + Invalidity, ~1.75% employer / 0.5% employee. Category 2 (≥ 60, and some late entrants): Employment Injury only, 1.25% employer. Foreign workers covered (Employment Injury). | Ceiling change Oct 2024 (grace to 31 Mar 2025) — historical recalcs need the old set |
| **EIS** | Flat 0.2% / 0.2% of gross | Banded table, **ceiling RM6,000 from Oct 2024**; ages 18–60; new employees ≥ 57 with no prior contribution exempt; foreign workers and domestic workers excluded | Same ceiling date as SOCSO |
| **PCB / MTD** | 3-tier approximation with **wrong bands** (8% / 16% / 21%), personal relief only, EPF relief uncapped, annualises current month ×12 | LHDN "Specification for MTD calculations using computerised calculation method" for the payment year: YA2023+ resident bands 0/1/3/6/11/19/25/26/28/30%; reliefs (individual, spouse, children, EPF/life capped, zakat), rebates, TP1/TP3 inputs (previous employer YTD), normal vs additional remuneration (bonus, arrears, commission), non-resident flat rate, CP38 additional deductions. Output must match LHDN's calculator for published test cases. | Spec and bands selected by **payment date** year |
| **HRD Corp levy** | absent | 1% (or 0.5%) of monthly wages for in-scope employers with ≥ 10 Malaysian employees — employer cost, GL only | Optional; confirm applicability |
| **Minimum wage** | absent | Validate basic ≥ Minimum Wages Order rate (RM1,700 from 1 Feb 2025; staged date for employers with < 5 staff) — warn, never auto-adjust | Effective-dated |
| **Employee master data** | absent (P8) | DOB, citizenship/PR/foreign, NRIC/passport, EPF/SOCSO/tax numbers, SOCSO category, marital status, children, disability, spouse working | Effective-dated residency & marital status |

## 3. Overtime validation

Current: OT minutes summed from approved **timesheets** (wrong columns, so 0), rate `salary_band.ot_rate || 1.5`, eligibility `salary_band.ot_eligible` (ignores `hr_employee_compensation.ot_eligible`), hourly rate `basic / (22 × 8)`. `hr_overtime_requests` (approver, `day_type`, `rate_multiplier`, `tier`) is never used by payroll, and its submit/approve API writes non-existent columns (dependency matrix P6), so it cannot be used today either.

Required:
- Payroll consumes **approved `hr_overtime_requests`** only (status `approved`, approver ≠ employee, within period), each carrying `day_type` (normal / rest day / public holiday) and the multiplier frozen at approval.
- Employment Act defaults (for employees covered by the First Schedule, wages ≤ RM4,000; extendable by policy): hourly rate = (monthly wage ÷ 26) ÷ normal daily hours; OT 1.5× on normal days, 2× rest day, 3× public holiday for hours beyond normal hours; rest-day and public-holiday normal-hours work follow the separate day-rate rules; monthly OT cap 104 hours (warn/refuse per `hr_overtime_policies.max_ot_per_*`).
- Eligibility from `hr_employee_compensation.ot_eligible` (single source); exclusions from `hr_overtime_policies` (`exclude_managers`, `exclude_probation`, …).
- Fix the OT request API column contract (`ot_minutes`, `approver_id`, `approver_comment`, `approval_required`) and forbid auto-approval by the requester (`approved_by = ctx.userId` today when approval is not required).

## 4. Unpaid leave

None today. Use `hr_leave_unpaid_days(org, period_start, period_end)` from the leave design (P4). Deduction = daily rate × unpaid working days, daily rate formula configurable (default monthly ÷ 26 for EA consistency, or calendar/working days per company policy — record the choice in the rate set). Reversals from cancelled leave in a locked period flow as adjustments into the next open run. Unpaid days must reduce EPF/SOCSO/EIS wages accordingly.

## 5. Authoritative references (re-check at implementation; record version/date in each rate set)

| Topic | Primary source |
|---|---|
| EPF rates, Third Schedule, foreign-worker contributions | EPF Act 1991 Third Schedule; KWSP employer pages (kwsp.gov.my) |
| SOCSO & EIS tables, ceiling, categories | Employees' Social Security Act 1969; Employment Insurance System Act 2017; PERKESO contribution schedules (perkeso.gov.my) |
| PCB / MTD | Income Tax (Deduction from Remuneration) Rules 1994; LHDN "Specification for MTD Calculations Using Computerised Calculation Method" for the payment year (hasil.gov.my → Employers → Employer payroll data specification) |
| Tax bands | Income Tax Act 1967 Schedule 1 (YA2023 onwards bands) |
| OT, rest days, holidays, leave | Employment Act 1955 (as amended 2022) ss.60A, 60D, 60E, 60F, 60FA; Employment (Limitation of Overtime Work) Regulations 1980 |
| Minimum wage | Minimum Wages Order in force at the payroll date |
| HRD levy | Pembangunan Sumber Manusia Berhad Act 2001 |

Secondary summaries used for this assessment: Crowe (SOCSO/EIS Oct 2024), Lockton (EPF foreign workers Oct 2025), Swingvy (EPF rates), KaizenCPA (tax bands) — links in the reply.

## 6. Effective-date requirements

1. **`hr_statutory_rate_sets`** (`scheme`, `version`, `effective_from`, `effective_to`, `source_reference`, `source_published_on`, `checksum`, `status draft|published|retired`) + **`hr_statutory_rate_rows`** (band lower/upper, employee amount/rate, employer amount/rate, category, citizenship, age band). Published sets are immutable (append-only trigger); corrections create a new version.
2. A run resolves one set per scheme by the governing date (EPF/SOCSO/EIS: wage month; PCB: payment date) and **stores the set ids on the run**; recalculating an approved run is impossible, a reversal + new run uses the sets of the original period.
3. Employee facts are resolved **as of period end** from `hr_employee_versions` / statutory profile (P5c): age tier, citizenship, SOCSO category, marital status.
4. Compensation, allowances, deductions resolved by effective range overlap with proration for mid-period joiners/leavers (calendar-day or working-day basis recorded on the run).
5. Test vectors per published set (at least: boundary of each band, ceiling, age-60 switch, foreign worker, mid-month join/leave) must pass before `published`.

## 7. Duplicate GL posting paths

| | `post_payroll_run_to_gl(run, posting_date)` | `hr_post_payroll_run_to_gl(run, amount)` |
|---|---|---|
| Caller | `/api/hr/payroll/post-to-gl` (used by `HrPayrollPayslipsView`) + reversal `reverse_payroll_gl_posting` | `/api/hr/finance/post-payroll-run` — **no UI caller** |
| Security | `SECURITY DEFINER`, `sa_require_operation('hr.payroll.release')` + legacy staff guard | invoker rights, `sa_require_operation` |
| Mapping | component mappings → `payroll_journals` + `gl_journals` | `hr_gl_mappings` aggregates → `gl_journals/lines` |
| Idempotency | `hr_payroll_runs.gl_status = 'POSTED'` | row in `hr_gl_postings` |
| Cross-check | never reads `hr_gl_postings` | never sets `gl_status` |

**Risk:** posting a run through one and then the other creates two journals. `p_amount` is accepted but unused.
**Decision proposed:** canonical = `post_payroll_run_to_gl` + `reverse_payroll_gl_posting` (has reversal, UI, mappings). Retire the other: route returns 410 (P2), `revoke execute … from authenticated, service_role` (P6), keep function body for history; before revoking, query for journals created by it (`hr_gl_postings` where `document_type='PAYROLL_RUN'`) and reconcile. Make the canonical function also write `hr_gl_postings` (single idempotency truth used by the HR reset blockers) and refuse when either marker exists.

Commission payroll transfers (`hr_commission_payroll_transfers`) are an outbox with no consumer; P6 should import approved transfers as an allowance component of the next open run (idempotent by transfer id).

## 8. Target architecture (reuse what is sound)

Keep: `hr_payroll_runs` (status draft→calculated→approved, `is_locked`, `run_number`, GL columns), `hr_payroll_run_items` (columns as in the DB), RLS (`sa_hr_self_or_manager_read` etc.), S&A keys prepare/approve/release, payslip access logging, column grants.

Replace: the calculation in the route handler with **`hr_payroll_calculate(actor, run_id, request_id)`** in the database — one transaction, row lock on the run, deterministic, writes lines + `hr_payroll_run_item_components` (component-level detail: code, type earning/deduction/statutory/employer, amount, statutory-wage flags) + rate set ids, fails the whole run on any employee error (with a per-employee error report), audit row with the correct columns. `hr_payroll_approve` enforces `approver <> calculated_by`. The route handlers become thin callers.

## 9. Phase P6 — implementation detail

| Sub-phase | Scope | Affected files | Migration | Acceptance | Tests | Rollback |
|---|---|---|---|---|---|---|
| **P2 (containment, early)** | Fix column contract in calculate/approve/payslips/preview; fail the run on any line error; correct audit columns; fix `hr_settings` access (key by organization); add `payroll.statutory_certified=false` gate that blocks **approve** with "Provisional payroll — statutory engine not certified"; 410 on `/api/hr/finance/post-payroll-run` | `runs/[id]/calculate`, `runs/[id]/approve`, `statutory-settings`, `HrPayrollPayslipsView`, `lib/api/payroll.ts`, `preview-journal`, `finance/post-payroll-run` | none | Calculated run has one line per eligible employee or fails; approve blocked while uncertified | route tests with schema-shaped mocks; column-contract test | revert commit |
| **P6a** | Statutory master data consumption, rate-set tables + seeds (EPF, SOCSO, EIS current + previous sets), PCB engine per LHDN spec | new `lib/server/hr/payroll/statutory/*` (pure, unit-testable) mirrored by SQL or called from server with frozen inputs | `hr_statutory_rate_sets/rows` | All published test vectors pass; PCB matches LHDN calculator samples | unit vectors; property tests on bands | sets are versioned; unpublish |
| **P6b** | DB calculation function, components table, proration, former-employee exclusion, OT from approved requests, unpaid leave, commission import, maker≠checker | calculate/approve routes become thin; `HrPayrollPayslipsView` shows components | `hr_payroll_calculate`, `hr_payroll_approve`, components table | Re-run idempotent; leaver excluded after end date; OT only from approved requests | SQL replica payroll fixture; concurrency test | drop functions, routes revert |
| **P6c** | Canonical GL, retire second RPC, payroll reports (summary, statutory remittance: EPF/SOCSO/EIS/PCB schedules, bank file later) | `post-to-gl`, `HrAccountingView`, new reports routes | revoke + canonical function update | One journal per run; reversal restores; second path unusable | accounting tests (`accounting/actions*.test.ts`) | restore grants |
| **Certification** | Parallel run for ≥ 2 months vs current external payroll; sign-off by finance | — | flip `payroll.statutory_certified` | Variance report = 0 or explained | UAT pack | flip back |

## 10. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Statutory under/over-deduction | High today | Penalties, employee claims | Rate sets + vectors + parallel run before certification |
| Paying leavers | High once P1 fixed | Financial loss | P9 fix in P2/P6b + lifecycle D2 |
| Double GL posting | Medium | Ledger misstatement | Retire second path; shared idempotency |
| Silent partial runs | High today | Wrong pay | Single-transaction DB function |
| Payroll data exposure via `() => true` in SHADOW | Low (RLS backstop verified on run items) | PDPA | S&A plan P3 |
| Rate changes mid-year (Budget announcements) | Certain | Wrong deductions | Effective-dated sets, owner checklist each January/Budget |
