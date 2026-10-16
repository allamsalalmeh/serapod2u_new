# HR Position Management V1.1 — Implementation Report

Branch: `issues-fixing-oct2` · Repository: `edierwan/serapod2u_new`

> **Status:** position-centric foundation implemented. No migrations executed against
> staging/production. No merge, no deploy, no branch switch.

---

## 1. Part A — Pre-Implementation Audit (findings)

| Concern | Existing implementation | Reused? |
| --- | --- | --- |
| Position Master | `hr_positions` — flat job-title catalog (code/name/level/category/is_active). No hierarchy, slots, or effective dating. | Legacy source; superseded by `hr_job_classifications`. |
| Create/Edit Position UI | `HrPositionsView` (927-line client component) + seed templates. | Replaced by `HrPositionManagementView`; old file retained. |
| Employee records | `users` (position_id, manager_user_id, department_id) + `hr_employees` (employment facts). | Yes — assignments link to `users.id`. |
| Organization hierarchy | `departments` (parent_department_id, manager_user_id, chart_order); RPC `get_department_hierarchy`. | Yes — department hierarchy remains. |
| Job classification | None — `hr_positions` doubles as job title. | New `hr_job_classifications`. |
| Reporting manager | `users.manager_user_id` (employee→employee) + `departments.manager_user_id`. | Employee reporting stays; position reporting is new. |
| ESS | `/hr/my-workspace` + self-service APIs. | Unchanged. |
| MSS | `manager-self-service` S&A family + `/api/hr/mss/team`; `manager-compensation-viewer` RLS. | Unchanged. |
| Approval workflow | `hr_profile_change_requests` (approve/reject via `hrCan`), leave/timesheet approvals. | Pattern reused. |
| Security & Access | `sa_permissions`, `authorizeOperation` / `hrCan` / `hrCanIn`; RLS backstops. | Reused — routes call `hrCan('hr.employee.manage')`. |
| Effective-dated records | None in the position space (current-state only). | New effective dating added. |
| Audit | No position audit table. | New `hr_position_audit_events`. |

### 1.2 Org Chart duplicate-CEO issue (investigated)

The admin "People" chart (`OrgChartTab`) builds its tree from **employee** `manager_user_id`
via `get_user_org_chart()` (recursive CTE rooted at `manager_user_id IS NULL`) plus a client
fallback (`buildUserTree` in `lib/actions/departments.ts`). With **no position hierarchy**, a
"CEO" is an *employee* with null manager, so two co-equal executives (or the department-manager
fallback) surface **duplicate roots / a synthesized single root** — the reported "duplicate
CEO" behavior.

**Fix:** position-centric multi-root hierarchy (`hr_position_relationships` +
`hr_position_org_chart()` + `buildPositionTree()`) supporting multiple roots with **no dummy
CEO**; `buildPositionTree` breaks cycles and keeps vacant/detached positions visible (tested).

### 1.3 Compatibility risks

- `hr_positions` is **not** dropped/migrated; existing titles are preserved and optionally
  mapped into `hr_job_classifications` via the **manual** hr05 reconciliation step.
- Existing employee reporting is **not** rewritten; position assignments are additive.
- Legacy `HrPositionsView` is retained but no longer the active renderer.

---

## 2. Architecture summary

- **Job Classification** (`hr_job_classifications`) — title/family shared by many slots.
- **Position Master** (`hr_position_slots`) — one slot; immutable `id` + unique `position_code`; independent of incumbent.
- **Reporting Relationships** (`hr_position_relationships`) — typed PRIMARY/SECOND_MANAGER/MATRIX_MANAGER/HR_MANAGER/CUSTOM; effective-dated; cycle/overlap guarded.
- **Assignments** (`hr_position_assignments`) — effective-dated; one active PRIMARY per employee, one active incumbent per slot.
- **Change Requests + Approval Steps** (`hr_position_change_requests`, `hr_position_approval_steps`) — draft → pending → approved → scheduled/effective (+ rejected/returned/activation_failed/cancelled).
- **History + Audit** (`hr_position_versions`, `hr_position_audit_events`).

**Separation honored:** Organizational Tier ≠ Reporting Depth ≠ Security/Access Level ≠ Job Grade. No S&A role is derived from a position.


## 3. Files

**Migrations (additive, not applied):**
- `20261210100000_hr01_position_management_foundation.sql`
- `20261210110000_hr02_position_reporting_relationships.sql`
- `20261210120000_hr03_position_assignments.sql`
- `20261210130000_hr04_position_change_approval.sql`
- `20261210140000_hr05_position_history_and_permissions.sql`

**Domain logic (pure, tested):**
- `app/src/lib/hr/positions/{types,validation,workflow,org-chart,code}.ts`

**Server services:**
- `app/src/lib/server/hr/position-management.ts` (list/get, audit, approver resolution)
- `app/src/lib/server/hr/position-workflow.ts` (change-request lifecycle)
- `app/src/lib/server/hr/position-activation.ts` (apply approved changes)

**API routes:**
- `api/hr/job-classifications/route.ts`
- `api/hr/position-slots/route.ts` + `[id]/route.ts` + `org-chart/route.ts`
- `api/hr/position-change-requests/route.ts` + `[id]/route.ts` + `submit|approve|reject|return/route.ts`

**UI:**
- `app/src/components/hr/HrPositionManagementView.tsx`
- `app/src/components/dashboard/DashboardContent.tsx` (wired to the three Positions routes)

**Tests:**
- `app/src/lib/hr/positions/*.test.ts` (37 tests)

---

## 4. Test results

- `cd app && npx vitest run src/lib/hr` → **47 passed** (37 new + 10 existing commission).
- `cd app && npx tsc --noEmit` → **no errors in new files**. The repo carries pre-existing
  type errors in `DashboardContent.tsx` (unrelated `UserProfile` typing, missing
  `ConsumerScanView` module) that predate this work and are out of scope.

---

## 5. Security assessment

- All write routes require `hrCan('hr.employee.manage')` (S&A) + the verified session org (never a request param).
- Self-approval/reject/return of one's own request blocked server-side.
- Approvers snapshotted at submit; later hierarchy changes do not silently reroute an in-flight request.
- Structural changes create a **draft change request**; live data mutates only in `activateChangeRequest` (service role).
- RLS: `authenticated` SELECTs only its own org; direct writes denied (`with check (false)`); service role writes.
- **Scoped additional-manager visibility (Part F) enforced at the API layer for V1** (server-side), not yet as RLS predicates — documented limitation.

## 6. Backward compatibility

No destructive change: no table/column dropped, no existing HR record modified. Legacy
`hr_positions` and `HrPositionsView` preserved. ESS/MSS/leave/attendance/payroll/performance
routes untouched.

## 7. Known limitations

- Bulk import (D6) and position detail side panel / drag-and-drop reporting (D3/D4) not built.
- Scoped manager visibility enforced server-side only (not RLS) for V1.
- Future-dated auto-activation requires a scheduled job (not added); the status machine
  supports `scheduled` → `effective` but no cron triggers it.
- Approver resolution is role-based + S&A-validated at approval; full policy routing is a later phase.
- Malaysia business dates via `date`; unambiguous timestamptz for audit timestamps.
- Secondary assignments / shared occupancy intentionally out of scope (column exists).

## 8. Required manual migration steps (staging first)

1. Apply in order on a throwaway PostgreSQL 17 for syntax validation, then staging: `hr01` → `hr05`.
2. Run the optional reconciliation backfill (hr05 tail, commented) to map legacy `hr_positions` → `hr_job_classifications`, then the reconciliation report to detect unmapped/unassigned employees.
3. Verify no `hrNN` collision (none existed prior; `hr01`–`hr05` are new).
4. Rollback per file (reverse order; each ends with explicit `drop` statements).

## 9. Staging UAT

- Grant `hr.employee.manage` to an HR approver (S&A) and confirm create → submit → approve flow.
- Create three `WH-OP` slots sharing one `Warehouse Operator` classification; confirm `WH-OP-003` stays Vacant.
- Verify two Managing Directors render as **two roots** in the position org chart (no duplicate CEO).

## 10. Deployment readiness

**Not ready to deploy.** Requires manual migration on staging, S&A configuration,
reconciliation backfill, and UAT per section 9. No staging/production SQL was executed.
