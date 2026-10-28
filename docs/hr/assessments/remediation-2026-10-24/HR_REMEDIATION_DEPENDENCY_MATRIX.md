# HR Remediation — Dependency Matrix

Repository `serapod2u_dev` · branch `Enhancement03` · HEAD `82da8cd0` · assessed 2026-10-24 (MYT) · **read-only; nothing was changed, applied or committed.**

Baseline: `docs/hr/HR Gap & Go-Live Readiness Audit.md` (audited at HEAD `92022c44`). This report covers only what changed since then, what the baseline got wrong or missed, and how the remaining work depends on itself.

Evidence sources used for every schema claim: `supabase/schemas/audit/production_schema_20261016.sql` and `staging_schema_20261016.sql` (catalog dumps of both databases, 2026-10-16), `supabase/schemas/current_schema.sql` (2026-10-20), and `supabase/migrations/PRODUCTION_MIGRATION_STATUS.md` (last updated 2026-10-16). Live databases were **not** queried.

---

## 1. Pre-flight

| Check | Result |
|---|---|
| Directory | `/Users/edierwan/serapod2u_dev` ✅ |
| Branch | `Enhancement03` ✅ (not switched) |
| HEAD | `82da8cd0` — 6 commits after the baseline (`92022c44`); `82da8cd0` (Bulk Employee Removal) was committed by the owner at 07:57 MYT during this assessment |
| Working tree | ~60 modified S&A / system-logs / e-commerce files; untracked S&A migrations, tests and docs. All preserved; nothing touched by this assessment. |
| Oddity | `supabase/schemas/current_schema.sql<U+2028>` — an older (2026-10-16) duplicate whose filename ends in an invisible line-separator character. Harmless, but it will confuse tooling and diffs. |

### Commits since the baseline (all lifecycle-relevant)

| Commit | Change | Effect on baseline findings |
|---|---|---|
| `f5297467` | One canonical permanent identity deletion (UM + HR), migration `20261216100000_identity_permanent_deletion` | New delete path, coexists with registration-only delete |
| `0c43a44f` | Bulk delete users only through canonical deletion | — |
| `b9934f48` | **Archive & Revoke Access** + email/phone release, migration `20261217100000` | **Partly closes E3/C8 (offboarding)**: archive now ends employment (`resigned`/`terminated`, `end_date`) |
| `94299cf9` | HR Employees "Former employees" tab | Former-employee UI behaviour now defined |
| `0df40475` | Archive reason optional, migration `20261218100000` | — |
| `82da8cd0` | Bulk employee removal (loops canonical delete/archive; no migration) | Inherits archive gaps D1/D2 at batch scale |

---

## 2. Baseline findings — status after cross-check

| Baseline ID | Finding | Status now | Evidence |
|---|---|---|---|
| A-6 / H | "Migrations are un-applied in any environment" | **OUTDATED.** HR onboarding/reset (`20261003100000`), commission, MSS/compensation (`20261102…20261106`) and HR01–HR05 are recorded **verified applied on staging and production** (catalog diff 2026-10-16). The real outstanding set is `20261211…20261218` + untracked S&A files (§3). Note: `PRODUCTION_MIGRATION_STATUS.md` line 172 still says "Pending/Pending" for `20261003100000` in the historical table — it contradicts the current table and should be corrected. | `PRODUCTION_MIGRATION_STATUS.md` rows 2, 48–62 |
| C1 | Leave admin not a real workflow | **CONFIRMED, and worse** — see L1–L4 below | |
| C2 / G1 | Legacy HR permission store surfaced | **CONFIRMED but re-scoped.** `hr_permissions`/`hr_access_groups*` are *not* an authorization source (API comment + DB `sa_legacy_store_read_only` trigger). The live legacy authority in HR is elsewhere (see S1–S4). | `api/hr/settings/permissions/route.ts:64-70`; schema trigger on `hr_access_group_members` |
| C3 | Orphaned submodules | **CONFIRMED** | `DashboardContent.tsx` has no `hr/analytics/overview` etc. case |
| C4 | Simplified statutory payroll | **CONFIRMED, and the run cannot produce lines at all** (P1–P4) | |
| C5 | Duplicate GL RPCs | **CONFIRMED + double-posting path proven** (P5) | |
| C6 / E1 | Employee vs position reporting lines | **STILL OPEN**; archive now leaves direct reports pointing at an archived manager (warning only) | `20261217100000…sql:448` |
| C7 / E2 | No employment history | **STILL OPEN** | no `hr_employee_versions` in either schema |
| C8 / E3 | No offboarding | **PARTIAL** — Archive & Revoke Access ends employment, but couples it to immediate login revocation, forces `end_date = current_date`, and has no final-pay/leave/document steps | `20261217100000…sql:556` |
| C10 | Unpaid leave ignored | **CONFIRMED** | calculate route reads no leave |
| C11 | Additional-manager RLS | **STILL OPEN** | |
| C12 | Duplicated Departments/Positions | **CONFIRMED** | `hrNav.ts:97-98,146-147` |
| B (Public holidays) | "IMPLEMENTED" | **INCORRECT** — template load inserts a non-existent column | P/L5 |
| B (Overtime) | "PARTIAL" | **Submit/approve cannot work** — writes non-existent columns | P6 |

### New findings not in the baseline

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **L1** | **P0 security** | `hr_leave_requests` INSERT policy only checks same organization: any staff member can insert a request **for any `employee_id` with any `status`** (including `approved`). No status CHECK constraint exists. | prod/staging schema policy `hr_leave_requests_insert`; table DDL |
| **L2** | **P0 security** | UPDATE policy lets the **employee update their own row** in every mode → self-approval (`status='approved'`, `approved_by=self`) by direct client write. | `hr_leave_requests_update` (`u.id = employee_id OR …`) |
| **L3** | P1 privacy (PDPA) | SELECT on `hr_leave_requests` and `hr_leave_balances` is organization-wide: every employee can read everyone's leave reasons and balances. | `hr_leave_requests_select`, `hr_leave_balances_select` |
| **L4** | P0 functional | Mobile/ESS leave form queries `hr_leave_types.is_active` (column does not exist; the table uses `status`) → leave-type list is empty, employees cannot pick a type. | `components/hr/mobile/HrMobileLeave.tsx:106` |
| **P1** | **P0 payroll** | Payroll calculate inserts columns that do not exist (`employee_id`, `gross_salary`, `deductions`, `net_salary`) and omits NOT NULL `organization_id`/`employee_user_id`. Every line insert fails, the error is only `console.error`'d, and the run is still marked `calculated` with header totals. | `api/hr/payroll/runs/[id]/calculate/route.ts:143-165`; DDL `hr_payroll_run_items` (identical in prod and staging) |
| **P2** | P0 payroll | Statutory settings read/write `hr_settings.config_key` — column does not exist (`hr_settings` = `organization_id, config, …`). Settings cannot be saved; calculation silently falls back to hard-coded defaults. | `statutory-settings/route.ts:18,51`; `calculate/route.ts:31` |
| **P3** | P0 payroll | Overtime/work minutes read `hr_timesheets.total_work_minutes/total_overtime_minutes` (actual: `total_minutes`, `overtime_minutes`) → OT always 0. | `calculate/route.ts:95-103` |
| **P4** | P1 audit | `hr_payroll_audit` inserts `performed_by`/`details` (actual: `actor_user_id`, `metadata`) — payroll audit trail is never written; errors ignored. | `calculate/route.ts:193-198`, `approve/route.ts` |
| **P5** | P1 finance | The two GL RPCs use **different idempotency stores** (`post_payroll_run_to_gl` → `hr_payroll_runs.gl_status`; `hr_post_payroll_run_to_gl` → `hr_gl_postings`) and neither checks the other → one run can be posted twice. | prod schema bodies |
| **P6** | P1 | OT request API writes `planned_start_time`, `ot_minutes_claimed`, `approved_by`, `approver_remarks`, reads `policy.require_approval`; actual columns are `ot_minutes`, `approver_id`, `approver_comment`, `approval_required`. | `attendance/overtime/requests/route.ts:135-202` |
| **P7** | P1 | Payslip/run UI and journal preview read `gross_salary`/`net_salary`/`employee_id` that the table does not have. | `HrPayrollPayslipsView.tsx:230,376-385`; `preview-journal/route.ts:58` |
| **P8** | P0 compliance | No statutory employee master data anywhere: date of birth, citizenship/residency, NRIC/passport, EPF/SOCSO/income-tax numbers, marital status, children. Correct EPF/SOCSO/EIS/PCB is impossible without them. | prod `users` + all `hr_*` DDL |
| **H1** | P1 | Public-holiday template load inserts `category` (no such column) → fails. Thaipusam is tagged `national` (it is state-only); lunar dates 2027–2030 are approximations. | `public-holidays/route.ts:146,204` |
| **H2** | P2 | Configuration "seed defaults" write non-existent columns: `hr_leave_types.default_days`, `hr_approval_chains.steps/is_active`; carry-forward JSON uses `max_days` while the schema/UI use `maxDays`. | `config/audit/route.ts:534,554-559` |
| **S1** | P0 (production) | In production most S&A keys were SHADOW (2026-10-02: 111 SHADOW / 3 LEGACY_ENFORCED). In SHADOW the **legacy evaluator decides**: HR's default is `canManageHr` (role level ≤ 20 or HQ/SA role codes or legacy `manage_org_chart`/`edit_org_settings`), and 30+ HR routes pass `() => true`. RLS is the only backstop there. | `lib/server/hrAccess.ts:61-120`; status doc change log 2026-10-02 |
| **S2** | P1 | Legacy compatibility policies still grant HR keys: `legacy-hq` (HR payroll/compensation), `legacy-power-user` (HR payroll release). | `docs/security/SA_FINALIZATION_REPORT_20261023.md` §C |
| **M1** | P1 ops | Duplicate migration versions: new `20261216100000` (identity deletion + S&A preview), untracked `20261022100000_core_system_preferences` collides with an applied file. There is no migration ledger in either database. | §3 |
| **M2** | P2 ops | Migrations are stamped `202612xx` while today is 2026-10-24. A migration generated today (`20261024…`) would sort **before** files it depends on. | file list |

---

## 3. Database & migration readiness (Task A)

### 3.1 Outstanding migrations (not in the status ledger)

| # | File | Git | Header | Hard prerequisites | Touches HR? | Recommended state |
|---|---|---|---|---|---|---|
| 1 | `20261211100000_fix_acknowledge_guard_ambiguous_alias.sql` | tracked | — | — | no | Verify on staging, record |
| 2 | `20261212100000_distributor_analytics_active_orders.sql` | tracked | NOT applied | — | no | Independent |
| 3 | `20261213100000_sa_organization_insert_gate.sql` | tracked | NOT APPLIED | S&A row-context gates | no | Independent of HR |
| 4 | `20261214100000_hr_employee_controlled_delete.sql` | tracked | apply manually | 20261003100000, 20261009100000, 20261110100000 (all applied) | **yes** | **Apply first** (UI already calls its RPCs) |
| 5 | `20261215100000_sa_payment_gateway_restriction.sql` | **untracked** | NOT APPLIED | — | no | Commit before apply |
| 6 | `20261215110000_sa_legacy_compat_cutover_controls.sql` | **untracked** | NOT APPLIED | 20261026100000, 20261005110000 | indirect (P3 cutover) | Commit, then apply (reports/switches only) |
| 7 | `20261215120000_sa_hr_employee_delete_mode_retired.sql` | **untracked** | NOT APPLIED | #4 | yes (label) | Optional, after #4 |
| 8 | `20261216100000_identity_permanent_deletion.sql` | tracked | apply manually | #4 | **yes** | After #4 |
| 9 | `20261216100000_sa_legacy_preview_scope_coverage.sql` | **untracked** | OWNER REVIEW | #6 (header wrongly says "already applied") | indirect | After #6; **version collides with #8** |
| 10 | `20261217100000_identity_archive_identifier_release.sql` | tracked | apply manually | #8, #4, 20261027100000 | **yes** | After #8 |
| 11 | `20261218100000_identity_archive_optional_reason.sql` | tracked | — | #10 | yes | After #10 |
| 12 | `20261022100000_core_system_preferences.sql` | **untracked** | NOT APPLIED | — | no | Version collides with applied `…sa_actor_org_gates_row_context`; **re-stamp before first apply** (it has never been applied, so renaming is safe) |
| 13 | `20261024110000_sa_emergency_access_enable.sql` | untracked | NOT APPLIED | — | no | Intentional hold — do not apply |

**Application-status evidence gap:** none of #1–#12 appear in `PRODUCTION_MIGRATION_STATUS.md`. The deployed/branch application already calls RPCs from #4, #8, #10, #11 (`/api/hr/employees/registration`, `/api/identity/permanent-delete`, `/api/identity/archive`, bulk removal). Until they are applied, those HR People actions fail on any database without them (localhost shares staging).

### 3.2 Ordering and compatibility with ongoing S&A work

```
applied baseline (≤ 20261110 + HR01–05)
   ├─ #4 hr_employee_controlled_delete ──┬─ #7 hr.employee.delete → LEGACY_RETIRED (optional)
   │                                     └─ #8 identity_permanent_deletion ── #10 archive/release ── #11 optional reason
   ├─ #6 legacy compat cutover controls ── #9 legacy preview scope coverage ── (owner) sa_retire_legacy_compat_role(...)
   ├─ #3 org insert gate          (independent)
   ├─ #5 payment gateway           (independent)
   └─ #1, #2                        (independent)
```

- No outstanding S&A migration changes HR tables, HR RLS or HR keys except #7 (mode label only). S&A and HR streams can be applied independently **except** that any HR remediation adding new `hr.*` keys must run after #6 so the cutover impact report sees them.
- **New HR remediation migrations must be stamped after `20261218100000`** (e.g. `20261219100000_…`) to preserve lexical = dependency order, and must use a unique version. Recommend a CI check that fails on duplicate version prefixes (cheap, prevents a third collision).
- **Do not rename any applied file** (the status doc already rules this out for `20260928100000`). For #9 (unapplied) prefer re-stamping to `20261216110000` before its first application.

### 3.3 Schema-contract readiness

The HR code base contains a significant amount of code written against a column contract that neither database has (L4, P1–P4, P6, P7, H1, H2). Before any feature work, a **column-contract test** (static list of `from('<hr table>').select/insert` keys checked against the schema dump) should be added so this class of defect fails CI instead of failing silently in production.

---

## 4. Remediation dependency matrix

Phases are defined in `HR_IMPLEMENTATION_SEQUENCE.md`.

| Work item | Phase | Depends on | Blocks | DB change | S&A change |
|---|---|---|---|---|---|
| Environment truth: apply-state of #1–#12 on staging/prod, prod migration modes for `hr.*`, `legacy_authorization.read_only` on prod, schema-contract diff | **P0** | — | everything | none (read-only) | none |
| Apply lifecycle set #4 → #8 → #10 → #11 (+#7) | **P1** | P0 | P5, bulk removal, archive UI | yes (owner-run) | #7 mode label |
| Apply S&A #6 → #9 | **P1** | P0 | P3 cutover | yes (owner-run) | reports/switches only |
| Leave containment guard (transition trigger + narrowed RLS) | **P2** | P0 | P4 | yes | none (uses existing keys) |
| Payroll fail-closed + column-contract fix | **P2** | P0 | P6 | none / small | none |
| Hide mock Approval Flow, block `hr_post_payroll_run_to_gl` route | **P2** | — | P7 | revoke execute (optional) | none |
| HR S&A consolidation (new leave keys, remove `() => true`, parity, per-key prod flip, compat cutover for HR keys) | **P3** | P1 (#6), P2 | P4, P6 | catalog rows | **yes** |
| Leave server workflow + ledger | **P4** | P2, P3 | P6 (unpaid leave), P5 (approval reassignment) | yes | uses P3 keys |
| Reporting-line reconciliation | **P5a** | P1 | P4 approver resolution quality | yes | none |
| Archive hardening (direct-report blocker/reassign, pending approvals, last working day, former-employee documents) | **P5b** | P1, P4 | P6 final pay | yes | maybe `hr.employee.offboard` |
| Employment history (`hr_employee_versions`) + statutory master data | **P5c** | P1 | P6 | yes | column grants |
| Statutory engine (effective-dated EPF/SOCSO/EIS/PCB), atomic calc, OT from approved OT, unpaid leave, canonical GL | **P6** | P3, P4, P5c | payroll go-live | yes | payroll SoD enforce |
| Navigation & reporting | **P7** | P2 (quick wins), P4, P6 | — | none | destinations |

### Critical path

`P0 → P1 → P3 → P4 → P5c → P6`. P2 runs in parallel with P1 and should land first in production because L1/L2 are live exposures wherever the leave tables are used.
