# HR — B0 Diagnostic Safety Review & B2 Implementation Plan

Repository `serapod2u_dev` · branch `Enhancement03` · HEAD `1e0830c6` (unchanged; working tree 83→86 paths from concurrent owner work, none HR) · 2026-10-24 · **read-only review: no code, SQL against live environments, migration, S&A, documentation or Git change.**

Testing performed: the diagnostic was executed only against **throwaway local PostgreSQL 16 replicas** built in my workspace from the 2026-10-16 production schema snapshot (structure only, no data) and destroyed afterwards.

---

## Task 1 — Review of `hr_b0_environment_readonly.sql` (v1)

| # | Check | v1 result | Severity | Fixed in v2 |
|---|---|---|---|---|
| 1 | Every called function read-only | ✅ Only catalog/system functions plus `sa_shadow_parity_summary` (pure `SELECT`, `STABLE`) | — | Kept read-only; app function removed |
| 2 | Runs under a read-only role | ❌ `sa_shadow_parity_summary` is EXECUTE-revoked from everyone but `service_role` (`20260928130000:245`) → permission error | High | Replaced by a direct aggregate on `sa_authorization_decisions` |
| 3 | **Failure isolation** | ❌ v1 header claimed graceful degradation, but every table is referenced directly. In one transaction, the first missing object or privilege aborts **all** later statements ("current transaction is aborted") | **High** | `\set ON_ERROR_ROLLBACK on` (statement savepoints) — proven: 26 isolated permission failures, 0 cascades, all 8 sections ran |
| 4 | Creates/modifies objects | ✅ None | — | Proven: catalog counts identical before/after (classes/functions/policies/triggers) |
| 5 | Sensitive exposure | ✅ Aggregates and catalog text only | — | v2 adds only further aggregates (approver categories, holder counts by source) |
| 6 | Missing objects / version differences | ⚠️ PG17 servers fine; missing objects → see #3 | Medium | Only long-standing catalog features used (`prokind` ≥ PG11); every statement isolated |
| 7 | Migration checks mistaken for proof | ⚠️ Column named `present`; only one body marker | Medium | Renamed `effect_present`, explicit "not complete proof" banner; body markers for `identity_resolve` (20261217) and `identity_archive_execute` (20261218); readiness-row marker (20261214). Markers verified present in the migration files and absent from the 10-16 snapshot (no false positives) |
| 8 | **Distinguish staging from production** | ❌ Both application databases are named `supabase` (PMS identity table) → `current_database()` is identical | **High** | Mandatory `-v env=staging|production` (script aborts without it, proven); fingerprints: `system_identifier`, server address/port, `cluster_name`, postmaster start, non-sensitive data counts |
| 9 | **RLS false negatives** | ❌ A non-owner, non-BYPASSRLS role sees 0 rows in RLS-forced tables and would report "0 leave requests" | **High** | Section R prints `role_sees_all`; instruction to re-run as owner/bypass role if false (proven to report `false` for a restricted role) |
| 10 | Lock waiting | ⚠️ Only statement timeout | Low | `lock_timeout 3s` added |
| 11 | Runner | Any client | — | **psql only** (meta-commands). Not for a web SQL editor |

**Verdict:** v1 must not be used; it can silently produce wrong (empty) results and cannot tell environments apart. **Use v2** (`hr_b0_environment_readonly_v2.sql`, delivered with this report).

---

## Task 2 — B2A Leave Containment: final security design

### 2.1 Facts the design relies on (verified)

- Two client write paths exist. **Neither submits on behalf of another employee**: the admin repository and the mobile form both insert `employee_id = signed-in user`.
- **Admin approval** (`supabaseRepository.updateLeaveRequestStatus`) sets **only `status`**, then inserts a `hr_leave_approvals` row with `approver_id = self`. **Mobile approval** sets `status`, `approved_by` and `approved_at`.
- No application code writes `hr_leave_balances`.
- `hr.mss.leave_approve` and `hr.mss.leave_view` are seeded as new-model keys with **no legacy compatibility rule**. They are granted through the `manager-self-service` standard policy.
- `hr.leave.approve` is held by `hr-payroll-full-access`, `hr-leave-attendance-administrator`, **and all three legacy compatibility policies**. On staging, 25 users hold it only that way (2026-10-23).
- `sa_rls_gate` and `sa_evaluate_permission_core` treat compatibility policies like explicit grants. A dedicated predicate is therefore needed to exclude them.
- Existing reusable functions (all present in production): `sa_evaluate_permission_core`, `sa_actor_is_root`, `sa_cached_actor_allows`, `hr_reject_append_only`, `hr_require_onboarded_employee`.

### 2.2 Authority model

| Authority | Definition (all evaluated in the **row's** organization, for `auth.uid()`) |
|---|---|
| **SELF** | `auth.uid() = employee_id` |
| **MANAGER** | `hr.mss.leave_approve` (for decisions) / `hr.mss.leave_view` (for reads) ALLOW, **and** a verified relationship: `hr_employees` row of the employee in this organization with `manager_user_id = auth.uid()`, employee onboarding `completed`. The manager's account must be active and not ARCHIVED, and the manager must be onboarded |
| **HR** (explicit) | New helper `hr_leave_explicit_hr_authority(org)`: `sa_evaluate_permission_core(auth.uid(), 'hr.leave.approve', {organization_id}, false /*no delegation*/, false /*no emergency*/)` = ALLOW **and** (`sa_actor_is_root(auth.uid())` **or** an active, in-window assignment of a **non-legacy**, active policy containing `hr.leave.approve` on an active membership). The membership requirement is decided by **OD-B2A-6** |
| **SERVICE** | `current_user` not in (`authenticated`, `anon`): service-role and database-owner paths. Examples: MSS APIs, HR Data Management reset/restore, future leave functions. **Bypasses the guard** (same pattern as `sa_payroll_run_transition_guard`) so that `hr_reset_restore` can re-insert historical approved rows |

Legacy compatibility policies therefore **never** confer HR leave authority (requirement met), and delegation and emergency access are excluded.

### 2.3 Guard trigger `hr_leave_requests_guard` (BEFORE INSERT OR UPDATE; `SECURITY DEFINER`, pinned `search_path`)

| Situation | Rule |
|---|---|
| INSERT | Only SELF. `status ∈ {draft, pending}`; `approved_by`, `approved_at`, `approval_comment`, `cancelled_at` must be null. On-behalf submission is **refused for everyone**: no current workflow uses it, and B6 will introduce it via `hr.leave.manage` |
| UPDATE by SELF while `draft`/`pending` | May edit content fields (dates, type, half day, reason, attachment) and move `draft→pending` or `→cancelled`. May **not** touch `employee_id`, `organization_id`, `approved_*`, or set `approved`/`rejected` |
| UPDATE by SELF after decision | Refused, including cancellation of approved leave (HR does that in B2A, OD-B2A-4) |
| `pending → approved/rejected` | Allowed for MANAGER or HR, **never if `auth.uid() = employee_id`**. The trigger **stamps** `approved_by = auth.uid()` and `approved_at = now()`, ignoring client values. This keeps the admin path, which sends only `status`, working. Only `status` and `approval_comment` may change in the same statement |
| `approved → cancelled` | HR only, stamps `cancelled_at = now()` |
| `rejected` / `cancelled` | Terminal (HR may not reopen in B2A) |
| Any change to `employee_id`, `organization_id` | Refused |
| SERVICE | Bypass (logged with authority `service`) |

Errors are raised with stable codes (`hr_leave_self_approval`, `hr_leave_not_authorized`, `hr_leave_invalid_transition`, `hr_leave_on_behalf_refused`) so the UI can map them.

### 2.4 RLS (replaces current policies on the four leave tables; previous text kept verbatim in the migration header)

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `hr_leave_requests` | SELF ∪ MANAGER(view) ∪ HR | SELF (row checks by trigger) | SELF ∪ MANAGER(approve) ∪ HR (transition rules by trigger) | none (`authenticated`) |
| `hr_leave_approvals` | via its request: SELF ∪ MANAGER(view) ∪ HR | `approver_id = auth.uid()`, approver ≠ request employee, approver is MANAGER(approve) or HR for that request | none | none |
| `hr_leave_balances` | SELF ∪ MANAGER(view) ∪ HR | none (`authenticated`; service only) | none | none |
| `hr_leave_types` | organization members (needed by ESS) — unchanged | unchanged (config; out of B2A, B3 item) | unchanged | unchanged |

Org-wide HR **read** uses explicit `hr.leave.approve` until `hr.leave.view` exists (B3/B6, OD-B2A-3).

### 2.5 Audit evidence

New append-only table **`hr_leave_request_events`**, written by an AFTER INSERT/UPDATE trigger on `hr_leave_requests`:

- Columns: `id`, `organization_id`, `request_id`, `actor_id` (null for service), `actor_db_role`, `authority` (`self`/`manager`/`hr`/`service`), `action` (`insert`/`update`/`status_change`), `from_status`, `to_status`, `changed_columns text[]`, `occurred_at`.
- **No leave reason text and no dates** are copied into the table.
- RLS is forced with no API-role policies; `hr_reject_append_only` blocks UPDATE/DELETE.
- The table is added to the HR Data Management allowlist (category Leave) and to `identity_deletion_category` as history.
- Existing `hr_leave_approvals` rows remain the approver record.

### 2.6 Existing data and status constraint

- A CHECK on status `∈ {draft, pending, approved, rejected, cancelled}` is added **`NOT VALID`**, so existing rows are untouched. It is validated later, after the diagnostic shows no other values.
- Existing self-approved or approver-less rows are **reported, not changed**. HR reviews them (OD-B2A-5).

### 2.7 Application changes paired with B2A

- `HrMobileLeave.tsx`:
  - Leave types filter on `status = 'active'`.
  - The team tab reads `/api/hr/mss/leave` (direct reports, existing route) instead of all organization pending requests.
  - The team tab is shown only when the user holds `hr.mss.leave_view`.
  - Approval sends only `status`; the trigger stamps the approver.
- `supabaseRepository.ts`: map the new error codes to clear messages. No other behaviour change.
- `hrNav.ts`: hide Leave → Approval Flow (mock).

### 2.8 Workflow impact (what changes for users)

| User | Before | After B2A |
|---|---|---|
| Employee | Can insert for anyone, can self-approve, sees everyone's leave | Own requests only; sees own + (if manager) team |
| Line manager with Manager Self-Service | Cannot approve (UPDATE policy denied) | **Can approve direct reports** (new capability) |
| Line manager without Manager Self-Service | Cannot approve | Cannot approve (unchanged) — grant the policy (OD-B2A-2) |
| HR with explicit HR/Leave policy | Can approve | Can approve; approver stamped; audit event |
| HQ / power user / SA holding only legacy compat | **Can approve and read all leave** | **Cannot** approve or read org-wide → explicit grant needed if legitimate (OD-B2A-1) |
| Root Access holder | Can | Can |
| Service routes, HR reset/restore | — | Unaffected |

---

## Task 3 — B2B Operational Repairs: confirmed boundaries

| Item | Files (HR-owned only) | Change | Explicitly not included |
|---|---|---|---|
| Payroll fail-closed | `api/hr/payroll/runs/[id]/calculate/route.ts`, `.../approve/route.ts`, `api/hr/payroll/statutory-settings/route.ts`, `api/hr/accounting/preview-journal/route.ts`, `components/hr/modules/HrPayrollPayslipsView.tsx`, `lib/api/payroll.ts` | Real column contract (`employee_user_id`, `gross_amount`, `deductions_amount`, `net_amount`, `organization_id`); any line error → run stays `draft`, error list returned, no header totals; `hr_payroll_audit` (`actor_user_id`, `metadata`); timesheet columns `total_minutes/overtime_minutes`; exclude employees `resigned/terminated` or `end_date < period_start`; statutory settings stored in `hr_settings.config` (organization-keyed JSON, no `config_key`); **approve refused** with `PAYROLL_STATUTORY_NOT_CERTIFIED` while `config.payroll.statutory_certified` is not `true` | Statutory engine, PCB, components table, DB calculation function (Phase B) |
| Attendance correction review | `api/hr/attendance/corrections/[id]/review/route.ts` | `review_comment`; audit insert `actor_user_id/entity_type='correction'/entity_id/metadata{before,after}`; refuse when reviewer = `requested_by`; refuse review if entry belongs to reviewer | Approver model change (B4b, PD-ATT-04) |
| Timesheet generation | `api/hr/attendance/timesheets/route.ts` | Write only `total_minutes`, `overtime_minutes`, `period_type`, period, status; drop non-existent counters (late/early counts are derivable, B4a) | Exception engine |
| OT request alignment & safety | `api/hr/attendance/overtime/requests/route.ts` | `ot_minutes`, `approver_id`, `approver_comment`, `policy.approval_required`; no requester auto-approval (when approval not required, status `approved` with `approver_id = null` and an explanatory comment, or require approval — OD-B2B-2); approver ≠ employee | Pre/post-approval policy, MSS OT approval (B5) |
| Mobile leave type query | `components/hr/mobile/HrMobileLeave.tsx` | (shared with B2A §2.7) | — |
| Public holiday template | `api/hr/public-holidays/route.ts` | Stop inserting `category`; template loads **national** holidays only; state holidays (incl. Thaipusam, Federal Territory Day) excluded from automatic load until state support (B6) — HR adds them manually with `state` | State calendars (B6) |
| Broken configuration seeds | `api/hr/config/audit/route.ts` | Disable `default_leave_types` and `default_approval_chain` actions (return 410 with explanation); fix access-group readiness check only if trivial, else leave for B3 | New seeds (B6), readiness rework (B3) |
| Duplicate payroll GL route containment | `api/hr/finance/post-payroll-run/route.ts` | Return 410; keep route in route-coverage; **DB function untouched** | Revoking function execute (Phase B, Finance owner) |
| Mock Approval Flow visibility | `modules/hr/hrNav.ts` (+ `hrNav.test.ts`) | Remove nav entry; direct URL shows "Not available yet" in `HrLeaveApprovalFlowView` (no mock data) | Real chains (B6) |
| Column-contract CI check | new `app/src/lib/hr/schema-contract.test.ts` (Vitest) | Parses `from('hr_*')` insert/update/upsert/select keys in `app/src/app/api/hr/**`, `components/hr/**`, `modules/hr/**` and compares with the committed schema snapshot; allowlist for JSON payload keys | Non-HR modules |
| Duplicate-migration CI check | new `app/src/lib/hr/migration-versions.test.ts` | Fails on a **new** duplicate version prefix; known historical duplicates allowlisted | Renaming files |
| CI wiring | `.github/workflows/ci.yml` is **shared** and runs only `npm run build` on main/staging/develop | Proposed: add `npm test -- src/lib/hr` step — **requires coordination** (OD-B2B-3). Without it, checks run locally / in PR review only | — |

Out of scope for B2B: payroll statutory rebuild, S&A cutover, Finance posting framework, leave backend, attendance features.

---

## Task 4 — Implementation plan

### 4.1 B2A file-level scope & acceptance tests

| File | Purpose |
|---|---|
| `supabase/migrations/20261219100000_hr_leave_containment_guard.sql` | Helper `hr_leave_explicit_hr_authority`, `hr_leave_manager_authority`; guard trigger; events table + append-only; RLS replacement on 3 tables; status CHECK `NOT VALID`; reset/deletion catalogue entries; prerequisite asserts; rollback in header |
| `supabase/tests/security/hr_leave_containment/{run.sh,10_fixtures.sql,20_before.sql,30_after.sql}` | Replica suite (pattern of `hr_employee_delete`) |
| `app/src/components/hr/mobile/HrMobileLeave.tsx` | §2.7 |
| `app/src/modules/hr/leave/supabaseRepository.ts` | Error mapping |
| `app/src/modules/hr/hrNav.ts`, `hrNav.test.ts`, `components/hr/modules/HrLeaveApprovalFlowView.tsx` | Hide mock |
| Component tests `HrMobileLeave.test.tsx` (new) | Types load; team tab gated |

**Acceptance (replica, `SET ROLE authenticated` + JWT claim):**
1. The negative control on the unpatched schema shows: impersonated insert succeeds, self-approval succeeds, org-wide read succeeds. This proves the tests detect the holes.
2. After the patch, these are refused with the expected code:
   - impersonated insert;
   - insert with `approved` status;
   - self-approval (manager or HR approving own request);
   - approval by a non-direct-report manager;
   - approval by a manager without `hr.mss.leave_approve`;
   - approval by an archived manager;
   - **approval by a legacy-compat-only holder**;
   - approval of another organization's request;
   - employee editing after decision.
3. These succeed:
   - own submit;
   - own edit/cancel while pending;
   - manager (with policy) approves a direct report;
   - explicit HR approves;
   - Root approves;
   - admin path sending only `status` (approver stamped);
   - service-role insert of an approved row (reset/restore).
4. Visibility: employee sees only own rows; manager sees self plus direct reports; explicit HR sees the organization; a compat-only user sees only own rows.
5. One event row per insert/update with the correct authority; events are not updatable or deletable.
6. Running the migration twice is idempotent. Rollback restores the previous policies, after which the negative control reproduces.

### 4.2 B2B file-level scope & acceptance tests

Files per Task 3 table. **Acceptance:**

| Area | Acceptance test |
|---|---|
| Payroll | Route tests with schema-shaped fixtures: N eligible → N lines with real columns; one failing line → run stays draft, 4xx with error list; leaver excluded; audit row columns correct; approve → `PAYROLL_STATUTORY_NOT_CERTIFIED`; statutory settings GET/PUT round-trip into `hr_settings.config` |
| Corrections | review approve/reject → 200, `review_comment` saved, entry updated, audit row with real columns; self-review → 403 |
| Timesheets | generate → upsert only real columns; repeat generate idempotent on `(user_id, period_start)` (unique constraint `hr_timesheets_user_id_period_start_key` verified in the 2026-10-16 production snapshot) |
| OT | submit → real columns; approver ≠ employee; approve sets `approver_id/approved_at/approver_comment`; linked entry overtime updated |
| Holidays | template load inserts national rows only; no `category` |
| Seeds | disabled actions return 410; other actions unchanged |
| GL route | POST → 410; `/api/hr/payroll/post-to-gl` unchanged |
| Nav | `hrNav.test.ts` has no approval-flow entry; direct URL renders unavailable state |
| CI checks | contract test fails on an injected bad key (negative control), passes on fixed code; migration test fails on an injected duplicate |
| Regression | Existing HR, MSS, ESS, nav-access and route-coverage Vitest suites pass |

### 4.3 Migration dependencies & sequencing

| Step | Item | Depends on | Note |
|---|---|---|---|
| 1 | Owner runs **v2 diagnostic** on staging and production | — | Confirms leave statuses, approver categories, compat holders, payroll volumes |
| 2 | Owner decisions OD-B2A-1…7, OD-B2B-1…3 | 1 | |
| 3 | **Explicit grants** (People & Access): `hr-leave-attendance-administrator` (or `hr-payroll-full-access`) to real HR approvers; `manager-self-service` to line managers | 2 | S&A action by owner, not an HR code change — must precede step 6 or legitimate approvers lose access |
| 4 | B2A + B2B coding and replica/Vitest tests | 2 | Can start right after approval |
| 5 | B2B application deploy (no DB change) | 4 | Independent of B1 |
| 6 | Apply `20261219100000_hr_leave_containment_guard` to **staging**, then UAT | 3, 4 | **Correction to B0 report:** B2A uses only objects already in production (`sa_evaluate_permission_core`, `sa_actor_is_root`, `hr_reject_append_only`, …); it does **not** depend on B1 (#1–#5). Stamping after `20261218100000` keeps lexical order; it may be applied before or after B1 |
| 7 | Production application | 6 + UAT pass + separate owner approval | Record in PMS |
| — | B1 lifecycle migrations | v2 diagnostic | Independent track |

### 4.4 Shared-workstream coordination

| Workstream | Coordination needed |
|---|---|
| **S&A (finalization V2, uncommitted)** | B2A reads S&A tables and calls `sa_evaluate_permission_core`; it does not change S&A objects. Inform S&A owner that leave approval will no longer honour compat policies, ahead of their compat cutover. Step 3 grants are S&A actions. No file overlap (B2 touches no `lib/security-access/**`) |
| **Identity lifecycle** | B2A registers `hr_leave_request_events` in `identity_deletion_category` (or confirms the default BLOCKING behaviour is acceptable) — coordinate with the identity owner because 20261216 may not be applied yet; if absent, skip with a guarded `if to_regprocedure(...)` |
| **HR Data Management (reset/restore)** | Add events table to the reset allowlist; guard bypass for service role keeps restore working — covered by replica test |
| **Navigation** | Only `modules/hr/hrNav.ts` (HR-owned); S&A V2 edits `lib/security-access/nav-access.ts` / `lib/server/nav-access.ts` — no overlap |
| **Finance** | 410 on the HR GL route; preview-journal fix — inform Finance owner |
| **All workstreams (CI)** | `ci.yml` change is shared (OD-B2B-3); migration-version check affects everyone's future files |
| **Shared staging** | `.env.local` → staging: UAT uses dedicated test employees/managers; announce window; no cleanup of other workstreams' data |

### 4.5 Staging UAT & rollback

**UAT (staging, dedicated test accounts: employee E1, E2; manager M1 with Manager Self-Service; manager M2 without; HR H1 explicit; legacy-only L1):**

1. E1 applies on mobile: types load and the request is created.
2. E1 tries to approve own request: refused.
3. M1 approves E1: approver stamped, event logged.
4. M2 approves E2: refused.
5. L1 approves E2: refused; L1 sees only own leave.
6. H1 approves E2 from the admin screen: approver stamped.
7. H1 cancels an approved request.
8. E1 edits a decided request: refused.
9. Payroll calculate succeeds with lines, or fails with an explicit list; approve is blocked with the provisional message.
10. Correction request → H1 review → entry updated; H1 self-review refused.
11. Timesheet generation succeeds.
12. OT request submit → approve.
13. Holiday template loads national holidays only.
14. The Approval Flow entry is hidden.

**Rollback:**
- B2A: run the header rollback, which drops the trigger and helpers, restores the previous policies, and drops the CHECK constraint. The events table is **kept** (audit). Re-running the negative control confirms the restore.
- B2B: revert the commit. No DB change is involved.

Rollback criteria: legitimate approvers blocked without a quick grant fix, or any service-path failure (reset/restore, MSS API).

### 4.6 Proposed HR master-document updates (not applied)

- **Index:**
  - Current phase "B0 complete; B2 plan ready, awaiting approval".
  - Add BL-8 (correction review/timesheet drift), BL-9 (25 staging compat-only HR holders), BL-10 (localhost = shared staging), BL-11 ("v1 diagnostic superseded — use v2").
  - Corrections §5.4: S-08.1 "schema-aligned" OUTDATED; B0 report statement "B2 migration blocked until B1" OUTDATED (B2A independent of B1).
- **Decision register:**
  - Add OD-B2A-1…7 and OD-B2B-1…3 as PENDING.
  - Add P-R11 "Leave authority excludes legacy compatibility policies" (PROPOSED).
- **Roadmap:**
  - Split B2 into **B2A** (leave containment, migration) and **B2B** (operational repairs, no migration), with the file scopes and acceptance criteria above.
  - B2A dependency: explicit grants (step 3), not B1.
  - Add a coordination row to each batch.
- **Progress tracker:**
  - B0 → Assessment done (2026-10-24); environment SQL pending (v2).
  - S-08.1 → Partial (review broken).
  - Add timesheet generation row.
  - S-12.1 → design final, awaiting approval.
- **Go-live gates:**
  - Gate 1: add 1.10 "no HR leave authority via legacy compat".
  - Gate 2: add 2.7 "re-stamp never-applied duplicates".
  - Gate 4: add 4.11 "correction review and timesheet generation work; self-review refused".
  - Gate 5: add 5.6 "UAT on shared staging uses dedicated test accounts".

### 4.7 Outstanding owner decisions

| ID | Decision | Recommendation |
|---|---|---|
| **OD-B2A-1** | HR leave authority = explicit non-legacy `hr.leave.approve` or Root; legacy compat holders lose leave approval and org-wide leave visibility | **Approve**, after granting explicit policies to genuine HR approvers (diagnostic shows how many past approvals came from compat-only users) |
| **OD-B2A-2** | Manager approval requires the `manager-self-service` policy **and** a direct-report relationship | **Approve**; assign the policy to line managers as part of step 3 |
| **OD-B2A-3** | Org-wide HR read uses explicit `hr.leave.approve` until `hr.leave.view` exists | Approve (interim) |
| **OD-B2A-4** | Only explicit HR may cancel approved leave; employees cannot cancel after approval in B2A | Approve (interim until B6) |
| **OD-B2A-5** | Existing self-approved or approver-less rows are reported to HR, not altered | Approve |
| **OD-B2A-6** | Explicit-HR check requires a non-legacy assignment on an active membership **in the request's organization or its HQ company** (stricter), vs. any active membership (looser, possible cross-org residual) | Stricter option; confirm HQ HR teams approve for child organizations |
| **OD-B2A-7** | Leave delegation (`hr_delegation_rules`) is **not** honoured in B2A | Approve (B6 implements delegation in the server workflow) |
| **OD-B2B-1** | Payroll approval fully blocked until statutory certification (Phase B) | Approve (production payroll runs were 0 on 2026-10-02; diagnostic to confirm) |
| **OD-B2B-2** | OT when policy does not require approval: auto-approved with no approver recorded, or approval always required | Always require approval until B5 |
| **OD-B2B-3** | Add `npm test -- src/lib/hr` to the shared `ci.yml` | Approve with notice to other workstreams; otherwise checks remain local |

Stopped after review. No implementation started.
