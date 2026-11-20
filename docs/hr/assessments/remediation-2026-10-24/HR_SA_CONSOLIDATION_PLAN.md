# HR — Security & Access Consolidation Plan (Task B)

Branch `Enhancement03` @ `82da8cd0` · read-only assessment · 2026-10-24.
Preserves: S&A as the single authorization authority, explicit (non-title-derived) ESS/MSS/compensation-viewer grants, break-glass `hr.employee.delete`, canonical identity.

---

## 1. What "legacy HR permissions" actually means today

The baseline treated `hr_permissions` / `hr_access_groups*` as the second permission system. Cross-checking shows four distinct legacy layers, of which that store is the **least** dangerous:

| # | Legacy layer | Is it an authorization source? | Where | Risk |
|---|---|---|---|---|
| **L-A** | HR-local store `hr_permissions`, `hr_access_groups`, `hr_access_group_permissions`, `hr_access_group_members` | **No.** Nothing evaluates it. DB trigger `sa_legacy_store_read_only` blocks writes when `legacy_authorization.read_only = true`; API returns 410 then. | `api/hr/settings/permissions/route.ts`, `HrSettingsPermissionsView.tsx`, `seedPermissions.ts`, `config/audit/route.ts:82,110`, `lib/ai/hrAudit.ts:405` | **Confusion**: admins believe groups grant access; the Configuration readiness check and HR AI audit *reward* creating groups. If prod `read_only` is false, the UI still writes (role level ≤ 20 fallback). |
| **L-B** | Legacy evaluators passed to `hrCan` | **Yes, in LEGACY_ENFORCED / SHADOW** | `lib/server/hrAccess.ts` (`canManageHr`: role level ≤ 20, role codes SA/HQ/ADMIN…, `HR_MANAGER`, legacy `manage_org_chart`/`edit_org_settings`); **51** route calls use this default; **32** HR routes pass `() => true`; 14 routes read `role_level` inline; `lib/server/nav-access.ts:119` uses `canManageHr` for every `hr.*` destination | Decisive in production while keys are SHADOW (2026-10-02 record: 111 SHADOW / 3 LEGACY_ENFORCED; not re-verified). `() => true` routes then rely solely on RLS. |
| **L-C** | Compatibility policies `legacy-*` (`sa_business_roles.source='legacy'`) | **Yes, in every mode** — the evaluator treats them as explicit grants | `sa_legacy_compat_rules`: every `hr.*` key except ESS has `max_role_level = 20` ⇒ held by `legacy-sa` (3 holders), `legacy-hq` (15), `legacy-power-user` (9) | Power users and HQ staff hold **payroll view/prepare/approve, compensation view/manage, payroll release** without an HR decision. Biggest real over-privilege. |
| **L-D** | Legacy branches inside RLS | Yes, while `sa_rls_new_mode(key)` is false | e.g. `hr_leave_*` policies `r.role_level <= 20`, payroll `sa_actor_is_hr_manager()` | Mirrors L-B at the DB layer |
| (L-E) | Residual role-level checks in lifecycle SQL | Protection, not grant | `identity_archive_plan` LAST_ADMINISTRATOR uses `role_level <= 10` | Low; note for later |

## 2. Active dependencies on the legacy store (L-A)

| Dependency | Type | Action |
|---|---|---|
| `HrSettingsPermissionsView` (HR Settings → HR Permissions) | UI read + write | Replace with a read-only "HR access is managed in Security & Access" panel listing the canonical HR policies and a deep link to `/security-access` (filtered to HR). |
| `/api/hr/settings/permissions` GET/POST/DELETE | API | GET → 410 or read-only export; POST/DELETE → 410 unconditionally (not only when `read_only`). Delete `set_permissions` (non-atomic delete-then-insert). |
| `seedPermissions.ts` (`seed_permissions_catalog`, `seed_template_groups`) | seed | Remove both actions; keep file only if needed by a migration-history test. |
| `config/audit/route.ts` (`default_access_groups`, readiness "groups with members") | readiness scoring | Replace the check with "≥ 1 explicit holder of HR & Payroll policies in this organization" from S&A. |
| `lib/ai/hrAudit.ts:405` | AI audit | Same replacement. |
| `lib/identity/permanent-deletion.ts:94` | cleanup allowlist label | Keep (deletion must still clean rows if they exist). |
| `types/database.ts` | generated types | Regenerate after table retirement. |

**Table retirement:** do **not** drop the four tables in this programme. After the UI/API removal ships and one release passes, a migration can `revoke all … from authenticated, anon` and leave rows for audit; dropping is a later, separate decision.

## 3. Permission mapping (legacy HR code → canonical S&A)

| Legacy `hr_permissions.code` | Canonical S&A key | Notes / gap |
|---|---|---|
| `employee.view` | `hr.employee.view` | |
| `employee.create`, `employee.edit`, `employee.profile.edit` | `hr.employee.manage` | |
| `employee.profile` (IC, bank, emergency) | **gap** → propose `hr.employee.view_sensitive` | Today any `hr.employee.view` holder may see sensitive profile fields depending on the route; PDPA argues for a separate key (column grants like compensation). |
| `employee.delete` | `hr.employee.delete` (break-glass) + `platform.identity.delete` for permanent delete/archive | Already canonical |
| `attendance.view/manage/corrections/overtime/timesheets` | `hr.attendance.manage`; managers: `hr.mss.attendance_view` | OT approval by direct manager has no MSS key → propose `hr.mss.overtime_approve` (or reuse `hr.mss.requests_view` + workflow) |
| `attendance.clock` | `hr.self_service.use` | |
| `leave.apply` | `hr.self_service.use` (own_record) | |
| `leave.approve` | managers: `hr.mss.leave_approve` (direct reports); HR: `hr.leave.approve` | |
| `leave.view`, `leave.balance` | **gap** → propose `hr.leave.view` (read all leave/balances in org) | Today only `hr.leave.approve` exists and it also covers configuration |
| `leave.types.manage` | **gap** → propose `hr.leave.manage` (types, entitlements, adjustments, year-end close) | Split from `hr.leave.approve` (SoD: whoever adjusts balances should not approve own team's leave in the same act) |
| `leave.holidays` | `hr.settings.manage` (existing destination `hr/attendance/public-holidays`) | |
| `payroll.view` / `payroll.manage` / `payroll.salary` / `payroll.allowances` / `payroll.deductions` / `payroll.payslips` | `hr.payroll.view`, `hr.payroll.prepare`, `hr.payroll.approve`, `hr.payroll.release`, `hr.compensation.view/manage` (+ `salary_view`, `allowance_view` for MSS viewer) | Statutory master data needs its own column grants (P5c) |
| `reports.*` | `hr.analytics.view` | Payroll reports should additionally require `hr.payroll.view` |
| `settings.org`, `settings.notifications` | `hr.settings.manage` | |
| `settings.permissions` | **none** — Security & Access only (`security.*`) | By design |
| `expense.*`, `recruitment.*` | `hr.expense.manage`, `hr.recruitment.manage`; ESS submit → `hr.self_service.use` | |

New keys proposed: `hr.leave.manage`, `hr.leave.view`, `hr.employee.view_sensitive`, optionally `hr.mss.overtime_approve`, optionally `hr.employee.offboard` (P5b). All new keys: **no legacy compat rule**, seeded straight to `LEGACY_RETIRED` with readiness rows (precedent: `hr.employee.delete`, 20261215120000), added to the HR & Payroll standard policies with an explicit decision per policy, registered in `route-coverage.ts` and `policy-dependencies.ts`.

## 4. Authorization risks

| Risk | Where | Consequence | Mitigation (phase) |
|---|---|---|---|
| Self-approval / impersonated leave via direct table writes | `hr_leave_requests` RLS | Leave balances & payroll integrity | Transition guard trigger (P2) then server-only writes (P4) |
| Org-wide read of leave reasons/balances | RLS SELECT | PDPA exposure (medical reasons) | Narrow SELECT (P2) |
| `() => true` legacy evaluators | 32 routes | In SHADOW, any authenticated staff passes the app gate; RLS is last line | Replace with explicit legacy evaluators or remove after keys reach NEW_ENFORCED (P3) |
| Compat policies granting payroll/compensation to HQ & power users | `legacy-hq`, `legacy-power-user`, `legacy-sa` | Salary visibility and payroll release without HR decision | Explicit HR grants first, then `sa_retire_legacy_compat_role` per role (P3) |
| Payroll maker = checker | `approve/route.ts` only records `approved_by`; S&A SoD is enforced on *assignments* | One person can calculate and approve if they hold both keys | Transaction-level check `calculated_by <> approver` in the approval function (P6) |
| HR Permissions screen implies authority | HR Settings | Mis-administration | Read-only S&A panel (P3) |
| MSS approval by an archived manager | direct reports keep `manager_user_id` | Requests stuck / approved by wrong person | P5a/P5b |

## 5. Safe migration strategy

Follows the S&A finalization model (no new privilege, nothing deleted, every step reversible).

1. **Measure (P0, read-only).** On production: `select permission_key, mode from sa_migration_modes where permission_key like 'hr.%'`; `legacy_authorization.read_only`; `sa_shadow_parity_summary` for `hr.*`; `sa_legacy_compat_overview()` / `sa_legacy_cutover_impact(null)` filtered to `hr.%` (needs #6/#9 applied). Output: per-key parity and the would-lose list.
2. **Remove misleading surfaces (P3a, app only).** HR Permissions → read-only S&A panel; API writes → 410; readiness/AI checks re-pointed to S&A. No access change.
3. **Explicit grants (P3b, owner via People & Access).** For each person in the would-lose list who genuinely needs HR access, grant the narrowest standard policy (HR & Payroll viewer/preparer/approver, MSS, Compensation Viewer). Never Full Access as a blanket replacement.
4. **Make the app gates explicit (P3c, code).** Replace every `() => true` with either a named legacy evaluator that reproduces the historical rule exactly, or no legacy evaluator once the key is NEW_ENFORCED. Remove inline `role_level` checks in HR routes. `nav-access.ts:119` follows the same rule.
5. **Flip per key, in waves (P3d, owner).** SHADOW → NEW_ENFORCED via `sa_set_migration_mode`, lowest risk first: `hr.module.view`, `hr.employee.view`, `hr.settings.manage` → `hr.attendance.manage`, `hr.leave.approve` → `hr.compensation.*`, `hr.payroll.*`. Gate each wave on zero unexplained parity mismatches for 7 days. LEGACY_RETIRED last.
6. **Retire compat policies for HR keys (P3e, owner).** `sa_retire_legacy_compat_role('legacy-power-user', …)` and `legacy-hq` once step 3 leaves no unwanted `would_lose` for `hr.*`. `legacy-sa` last (it also carries `security.*`).
7. **RLS legacy branches (P3f).** Once a key is NEW_ENFORCED everywhere, the `sa_rls_gate` legacy branch is inert; leave the policy text unchanged until LEGACY_RETIRED, then simplify in one migration per table family.

### Rollback

| Step | Rollback |
|---|---|
| 2, 4 | Revert the commit (no data change) |
| 3 | Revoke the new grant (People & Access; audited) |
| 5 | `sa_set_migration_mode(null, key, 'SHADOW', reason)` |
| 6 | `sa_restore_legacy_compat_role(role_key, reason)` (instant, audited) |
| 7 | Re-apply the previous policy definitions (kept in the migration header) |

### Acceptance criteria

- No HR screen or API writes `hr_access_*`; HR Permissions shows S&A holders read-only.
- `grep "() => true" app/api/hr` returns 0; no `role_level` in HR routes except identity protections.
- Every `hr.*` key on production is NEW_ENFORCED or LEGACY_RETIRED; parity log shows 0 unexplained mismatches for the last wave.
- `sa_legacy_cutover_impact` shows no `hr.*` permission held only through a compatibility policy.
- Route-coverage test passes with the new keys.

### Tests

- Unit: `hrAccess` (no default `canManageHr` when key is NEW_ENFORCED), `nav-access.test.ts`, `route-coverage` gate, `HrLandingView.access.test.tsx`, `pages.access.test.tsx`.
- Route tests per family: denied without key, allowed with key, cross-organization 404 (pattern from `route.identity.test.ts`).
- SQL replica (pattern `supabase/tests/security/sa_legacy_cutover/`): HR keys before/after compat retirement, Root continuity, RLS helper parity.
