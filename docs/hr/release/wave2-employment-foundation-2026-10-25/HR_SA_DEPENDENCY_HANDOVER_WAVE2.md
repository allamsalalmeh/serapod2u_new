# HR → S&A dependency handover (Wave 2, 2026-10-25)

For the owner of the canonical Security & Access engine (S&A finalization V2). Back to the [Wave 2 release README](README.md).

HR did **not** change the S&A engine, catalogue, grants, policy assignments, migration modes, Root Access or legacy compatibility policies. Everything below is either already done on the HR side (consumer code only) or a request for the S&A owner.

## 1. What HR now relies on (no change requested)

| HR consumer | S&A primitive used | Contract HR assumes |
|---|---|---|
| `hr_actor_has_explicit(actor, permission, context)` (Wave 2) and B2A `hr_leave_actor_has_explicit` | `sa_evaluate_permission_core(actor, key, ctx, false, false)` → `decision`, `reason_code` (`ALLOWED_BY_ROOT_ACCESS` / `ALLOWED_BY_ASSIGNMENT`), `matched_assignments[].roleId` | Stable JSON shape; `sa_business_roles.source = 'legacy'` marks compatibility policies |
| Organization scope | assignment scopes (an organization scope covers its descendants) | HQ scope reaches child organizations; never another HQ |
| `hrCan` / `hrCanIn` (app) | `authorizeOperation` | Legacy evaluator decides only in SHADOW / LEGACY_ENFORCED |
| Mobile Approvals tab | destinations `hr/leave/requests` (HR) **or** `hr/team-leave` (MSS) | `hr/team-leave` keeps requiring `hr.mss.leave_view` |

## 2. HR-side changes that touch S&A-owned files (please review)

| File | Change | Why |
|---|---|---|
| `app/src/lib/security-access/route-coverage.ts` | Registered 3 new HR routes: `hr/employees/[id]/history` (`hr.employee.view`, `hr.employee.manage`), `hr/employees/[id]/employment` (`hr.employee.manage`), `hr/reporting-lines` (`hr.employee.view`, `hr.employee.manage`), all `via: lib/hr/employment-foundation.ts` | Coverage gate requires every route classified; the database entry points assert the keys |
| 32 HR routes under `app/src/app/api/hr/**` (list: `b3_route_files.txt`) | `hrCan(ctx, key, () => true)` → `hrCan(ctx, key)` (default legacy evaluator `canManageHr`) | `() => true` let every signed-in user through wherever a key was SHADOW/LEGACY_ENFORCED. In NEW_ENFORCED/LEGACY_RETIRED nothing changes (staging: all 38 HR keys LEGACY_RETIRED on 2026-10-25) |

## 3. Requests for the S&A owner (not done by HR)

| # | Request | Detail | Blocks |
|---|---|---|---|
| SA-R1 | **Explicit grants on staging** (owner action in People & Access) | *Leave & Attendance Administrator* to real HR leave approvers, *Manager Self-Service* to real line managers, *HR Records Officer* to HR administrators who manage employee records — all **HQ-scoped**. Staging today: 0 explicit holders of `hr.leave.approve`, 13 legacy-only | Leave approval by anyone but Root; all Wave 2 HR screens |
| SA-R2 | New permission keys (PD-SA-01) | `hr.employee.view_sensitive` (statutory/personal data read, separate from `hr.employee.manage`), `hr.leave.manage`, `hr.leave.view`, optional `hr.mss.overtime_approve`. Wave 2 uses `hr.employee.manage` for statutory data until `view_sensitive` exists | Finer HR separation (B3) |
| SA-R3 | Production modes for HR keys (PD-SA-02) | Measure production modes (last recorded SHADOW, 2026-10-02) and plan SHADOW → NEW_ENFORCED; then retire `legacy-hq` / `legacy-power-user` HR permissions after explicit grants | Gate 1 |
| SA-R4 | `20261215100000_sa_payment_gateway_restriction` version collision | Collides with applied `20261215100000_return_items_source_unit_price`. HR did not rename it. If it was never applied anywhere, re-stamp it; if applied, keep and record | Tooling only (staging has no migration ledger) |
| SA-R5 | Inline role-level checks in HR legacy evaluators (14) | e.g. `() => roleLevel <= 20` remain as **legacy evaluators** (decide only in legacy modes). Retire with the key once production is NEW_ENFORCED | B3 completion |
| SA-R6 | Identity retention of HR history refs (BL-20 extended) | `hr_leave_request_events.actor_ref`, `hr_employee_versions.person_ref/actor_ref`, `hr_reporting_line_changes.*_ref`, `hr_compensation_change_log.*_ref`, `hr_statutory_profile_changes.*_ref` keep bare ids after a permanent deletion (they are not listed in `identity_deletion_plan`'s `v_retained`). Identity owner: decide PDPA retention and list them explicitly | PDPA documentation |

## 4. Tests the S&A owner can run

* `supabase/tests/security/hr_employment_foundation/run.sh` (disposable replica; builds on `../hr_leave_containment/build_replica_from_snapshot.sh`) — includes legacy-only refusal (S2, E10, G4, G10, F7), cross-company refusal (S3, G5, G15) and Root/explicit allowance.
* `app/src/lib/hr/b3-legacy-evaluators.test.ts`, `app/src/lib/security-access/route-coverage.test.ts`.
