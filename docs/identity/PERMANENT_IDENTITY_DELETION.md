# Permanent identity deletion (pre-go-live clean-up)

Branch `Enhancement03`, 2026-10-23. One canonical deletion behind **User Management → Delete User** and
**HR → People → Employees → Delete Employee Permanently**.

## 1. Audit findings (before this change)

| | User Management "Delete User" | HR "Delete Employee" (20261214100000) |
|---|---|---|
| Code | `/api/admin/delete-user-otp/request` + `/verify-and-delete` (OTP); dead `deleteUserWithAuth` server action | `/api/hr/employees/registration` → `hr_employee_registration_execute` |
| Effect | Hard delete **only** when `identity_history_references()` is empty, otherwise archive. Every internal employee has `hr_employees.user_id`, which that function counts as HR history → **employees were always archived, never deleted**. | Onboarding-state change only: `completed`/`reset` → `pending`. No row is deleted; login, `public.users`, anchor, S&A assignments stay. |
| Defects | Hard-delete branch deleted `audit_logs`, re-assigned `orders`/`documents` to the admin, nulled approvers, and ran `public.users` delete and `auth.admin.deleteUser` as two calls (auth failure still returned success). `deleteUserWithAuth` had the same issues. | — |

**Why pending employees had no Delete:** both the UI (`HrPeopleView` showed the item only for `onboarding_status !== 'pending'`)
and the database (`NOT_REGISTERED` blocker: the action's purpose is "→ pending", and pending has nowhere to go). It was a
deliberate rule of a *registration* action, not a permission gate.

## 2. Design

- `supabase/migrations/20261216100000_identity_permanent_deletion.sql` — `identity_deletion_plan / _preview / _execute /
  _actor_check / _record_auth_check`, durable append-only `identity_deletion_requests`, and `identity_history_delete_guard`
  now also passes the delete issued by an executing request (same transaction only).
- `app/src/lib/identity/permanent-deletion.ts` + `GET|POST /api/identity/permanent-delete` (`entry=user_management|hr`).
- `app/src/components/identity/PermanentDeleteDialog.tsx` used by both UIs.

**Authorization (database, every call):** explicit `platform.identity.delete` in the target's organization
(`sa_evaluate_permission(..., false)`: assignment or Root Access, no delegation, no role-level evaluator). From HR also
`hr.employee.delete`, and only for people with an employment record. `hr.employee.manage`, HR & Payroll Full Access and
`hr.employee.delete` alone are refused. Today holders of `platform.identity.delete` are: `legacy-sa` compat role (Super Admins)
and the unassigned break-glass `platform-data-maintenance-administrator`; Root Access holders implicitly.

**Protections:** own account; any Root Access grant on the target; Super Admin target unless actor is Super Admin/Root;
target the actor does not dominate (`sa_actor_dominates`); last active HQ Admin/Super Admin of an org; HR live
(`hr_go_live_state.phase = 'live'`) — applies only to identities with an employment record.

**Atomicity:** on this deployment GoTrue's `auth.users` is in the same Postgres. `auth.users` (+ cascading identities,
sessions, refresh tokens, MFA), `public.users` and `hr_employees` are deleted in **one transaction** with the dependency
re-check, under advisory + row locks and SHARE locks on FK-less person tables. Any failure rolls everything back. After commit
the server asks GoTrue (`auth.admin.getUserById`); if the login still exists it calls `auth.admin.deleteUser` and re-checks;
unverified → HTTP 502 `AUTH_CLEANUP_REQUIRED`, never success. Retrying with the same `request_id` is idempotent
(replays the recorded outcome, re-runs the verification).

## 3. Dependency matrix

Discovered at preview **and** execution from `pg_constraint` (staging schema 2026-10-22: 324 FKs to `public.users`
[56 CASCADE, 73 SET NULL, 195 NO ACTION/RESTRICT], 53 public FKs to `auth.users`, 6 to `hr_employees`; ~80 FK-less person columns).

FK references by category (replica): other 66, supply_chain 57, security_access 46, loyalty 27, commission 27, finance 26,
hr_other 26, performance 25, roadtour_operations 20, notifications_messaging 19, hr_attendance 13, audit 9, compensation 7,
payroll 6, hr_leave 4, hr_documents 3, positions 1.

| Class | What | Rule |
|---|---|---|
| **CLEANUP** (explicit allowlist) | `hr_employees.user_id` (anchor), `sa_organization_memberships`, `sa_role_assignments` (+ CASCADE `sa_assignment_scopes`), `hr_access_group_members`, `account_scope_audit_log`, `telegram_links`, `telegram_link_tokens`, `serapp_user_presence`, `message_notifications`, `support_thread_reads`, `support_thread_participants`, `admin_whatsapp_identities` | identity-owned; every row copied into `identity_deletion_requests.before_image` first |
| **RETAINED** (FK-less append-only logs) | `sa_authorization_decisions`, `sa_access_change_log`, `hr_employee_onboarding_log`, `hr_employee_registration_actions`, `hr_profile_edit_audit`, `hr_kpi_audit_log`, `hr_position_audit_events`, `hr_commission_audit_log`, `hr_reset_runs`, `hr_reset_restorations`, `destructive_ops_audit_log`, `identity_conflicts`, `notification_events`, `auth_verification_codes`, `legacy_config_cutover_snapshot` | untouched (no FK → stays valid); the deletion record maps the id to name/email |
| **BLOCKING** | every other FK to identity/login/employment (CASCADE would erase, SET NULL would erase attribution), every other FK-less person column (e.g. `stock_count_sessions.created_by`, `order_status_events.actor_id`, `payroll_payment_batches.*`), rows of others pointing at a cleanup row with SET NULL/NO ACTION (e.g. `sa_access_review_items.assignment_id`), direct reports (`users`/`hr_employees.manager_user_id`), HR rows held by an unrestored `hr_reset_snapshots` run, Root Access grants | nothing re-assigned or nulled; preview explains, UM offers *Archive instead* |
| **REQUIRES REVIEW** | Supabase Storage objects (avatars) owned by the person (no FK; left in place); points/loyalty ledgers now block (previous consumer hard delete removed them) | see risks |

## 4. Migration (owner applies by hand; NOT applied anywhere)

Order: `20261214100000_hr_employee_controlled_delete.sql` (prerequisite, unapplied on staging as of 2026-10-22) →
`20261216100000_identity_permanent_deletion.sql`. Single-statement / DO blocks only (no cross-statement state). Run as the
database owner (must be able to `DELETE` from `auth.users`; the prerequisite check refuses otherwise). Idempotent; changes no
mode and grants nothing.

## 5. Localhost UAT (only after the migration is applied — localhost uses the STAGING database)

Prerequisite: tester holds Root Access, or `platform.identity.delete` (+ `hr.employee.delete` for HR) in the target org.
Create disposable people first (Add User / Add Employee) with an email like `uat-delete-1@example.test`; do not use real staff.

1. **User Management:** Administration → User Management → trash icon on the test user → dialog shows name, email/phone,
   organization, employee number/status, what is deleted/kept → enter reason, type the shown email, tick the box →
   *Delete permanently* → toast "Deleted permanently"; the row and the total disappear.
2. **HR:** HR → People → Employees → Awaiting onboarding (pending) or Onboarded → ⋯ → *Delete Employee Permanently* → same flow;
   the person leaves the list and the onboarding counts drop.
3. **Verify (SQL editor, read-only):**
   `select (select count(*) from auth.users where id = '<id>') auth, (select count(*) from public.users where id = '<id>') users,
   (select count(*) from public.hr_employees where user_id = '<id>') hr;` → `0|0|0`;
   `select status, auth_verification, cleanup from identity_deletion_requests where target_user_id = '<id>';` → `completed | verified_absent`.
   Sign-in with the deleted account fails.
4. **Blocked case:** a user who created an order → dialog lists *Supply Chain records (orders.created_by)*; Delete stays disabled;
   *Archive instead* opens the OTP archive flow.

## 6. Tests run

- Replica (local PG17 from the 2026-10-22 staging schema dump, disposable `ph_test_*`):
  `supabase/tests/security/identity_permanent_delete/run.sh` — negative control + 92 assertions incl. two-session concurrency and
  the PostgREST path (authenticator → service_role). HR controlled-delete suite with the new migration applied: 69/69.
- Vitest: new route (11) + HR UI (5) tests; updated archive/OTP/actions tests; full suite 6306 passed, 1 unrelated failure
  (`orders/[orderId]/ship-metrics` schema snapshot lacks `v_stock_movements_display`).

## 7. Risks / open items

- `/api/admin/bulk-delete-users` (guarded staging tool, env-gated, no UI) was rebuilt on the canonical service: body
  `{ userIds, reason, confirmation: "DELETE <n> USERS" }`, max 500, each account previewed and deleted in its own transaction
  (3 at a time), blocked/unauthorized accounts reported and kept. It no longer deletes `audit_logs`, re-assigns orders or calls
  `auth.admin.deleteUser` directly.
- User Management permanent deletion no longer uses the WhatsApp/SMS OTP (OTP now protects archive only); it relies on explicit
  S&A authority + reason + typed confirmation + server re-check.
- `before_image` keeps the deleted person's profile row (PII) as audit evidence; no credentials.
- Consumers with loyalty ledgers (points, redemptions) are now blocked instead of hard-deleted.
- Holders: `legacy-sa` compat role grants `platform.identity.delete` to Super Admins until it is retired.
