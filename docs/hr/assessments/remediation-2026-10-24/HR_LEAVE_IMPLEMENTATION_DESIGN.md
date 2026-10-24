# HR — Leave Management Implementation Design (Task C)

Branch `Enhancement03` @ `82da8cd0` · design only, nothing implemented · 2026-10-24.

Goal: one server-side, S&A-enforced leave workflow (apply → approve/reject → balance ledger → cancellation → year-end carry-forward), reusing the existing `hr_leave_*` tables, the MSS direct-report model and the controlled-action pattern already proven in `hr_employee_registration_*` (database-owned functions, preview token, `request_id` idempotency, append-only audit).

---

## 1. Current state (verified)

| Area | What exists | Defect |
|---|---|---|
| Tables | `hr_leave_types`, `hr_leave_requests`, `hr_leave_approvals`, `hr_leave_balances` (unique emp+type+year), `hr_approval_chains` + `hr_approval_chain_steps`, `hr_delegation_rules`, `hr_public_holidays` (`state` text), `hr_attendance_policies.workdays` | No status CHECK on requests; balances are mutable counters with no history |
| RLS | `sa_rls_gate('hr.leave.approve', …)` on all four tables | **INSERT any employee/any status; employee can UPDATE own status (self-approval); org-wide SELECT** (L1–L3) |
| Guards | `hr_require_onboarded_hr_leave_requests` (BEFORE INSERT) | Good — keep |
| Admin UI | `HrLeaveTypesView`, `HrLeaveRequestsView` → `SupabaseLeaveRepository` (client-direct writes); `HrLeaveApprovalFlowView` → **`MockLeaveRepository`** | Approval writes status only; no balance change; chain UI is fake |
| ESS UI | `HrMobileLeave.tsx` client-direct insert/update | Type list empty (`is_active` column does not exist); day count ignores rest days/holidays; "manager" sees **all** org pending requests; approve = status flip |
| MSS | `GET /api/hr/mss/leave` (direct reports via `hr_employees.manager_user_id`, `hr.mss.leave_view`) | Read-only; `hr.mss.leave_approve` key exists but no action uses it |
| Payroll | — | Unpaid leave never reaches payroll |
| Seeds | `config/audit` `default_leave_types` | Writes non-existent `default_days`; flat 14-day annual leave contradicts statute |

## 2. Design principles

1. **The database owns every state transition.** Server routes authenticate, resolve the actor, and call `security definer` functions executable only by `service_role` (pattern of `hr_employee_registration_execute`). Authorization is re-decided inside the function with `sa_evaluate_permission`.
2. **Balances are derived from an append-only ledger.** `hr_leave_balances` remains as a read model (refreshed by the same transaction) so existing readers (`HrMobileHome`, assistant tools) keep working.
3. **No client-direct writes** to any `hr_leave_*` table after P4; RLS keeps only narrowed SELECT.
4. **Organization comes from the loaded row, never the request** (`hrCanIn` semantics).
5. **Never self-approve; never approve for an archived approver.**

## 3. Data model changes (migration `2026122x…_hr_leave_workflow.sql`, after the P2 guard)

### 3.1 Reused tables — additive changes only

| Table | Change | Reason |
|---|---|---|
| `hr_leave_types` | add `entitlement_basis text check in ('statutory_ea','fixed','none')`, `counts_rest_days boolean default false`, `counts_public_holidays boolean default false`, `allow_negative boolean default false`, `max_negative_days numeric`, `is_unpaid boolean generated always as (not is_paid_leave) stored`, `requires_medical_cert boolean`; keep `entitlement_tiers`, `carry_forward`, `pro_rata` JSON but **validate shape** with a CHECK function (camelCase keys `maxDays`, `expiryMonths`) | Server needs explicit counting rules; fixes `max_days` vs `maxDays` drift |
| `hr_leave_requests` | add CHECK `status in ('draft','pending','approved','rejected','cancelled','cancellation_pending')`; add `working_days numeric(6,2)` (server-computed, authoritative), `quote_snapshot jsonb` (day-by-day breakdown incl. skipped holidays), `leave_year int`, `request_key uuid unique` (idempotency), `cancel_reason`, `cancelled_by`, `decided_step int`, `version int default 0` | Authoritative day count; idempotency; optimistic concurrency |
| `hr_leave_approvals` | add `status text check in ('pending','approved','rejected','skipped','reassigned','expired')`, `delegated_from uuid`, `resolved_by_rule text`; unique `(request_id, level)` | Multi-level chain with delegation audit |
| `hr_leave_balances` | becomes a projection: `entitled, taken, pending, carried_forward, adjustment` recomputed from the ledger inside each transaction; add `refreshed_at` | Existing readers unchanged |
| `hr_public_holidays` | add `scope text check in ('national','state')`, `observed_date date` (replacement day when on rest day), `source text`, unique `(organization_id, date, coalesce(state,''))` | Correct state handling; fixes the `category` insert failure |
| `hr_approval_chain_steps` | no change (already: `level`, `role`, `custom_approver_id`, `auto_approve_after_hours`, `can_delegate`) | Reuse |
| `hr_delegation_rules` | add unique partial index (one active rule per delegator per date range overlap check via exclusion constraint) | Reuse |

### 3.2 New tables

```sql
hr_leave_ledger (
  id uuid pk, organization_id uuid not null, employee_id uuid not null references users(id),
  leave_type_id uuid not null, leave_year int not null,
  entry_type text not null check (entry_type in
    ('entitlement','proration_adjustment','carry_forward_in','carry_forward_expiry',
     'taken','taken_reversal','pending_hold','pending_release',
     'manual_adjustment','encashment','forfeiture')),
  quantity numeric(6,2) not null,          -- signed
  effective_date date not null,
  request_id uuid null references hr_leave_requests(id),
  run_id uuid null,                         -- year-close / entitlement run
  reason text, actor_id uuid not null, created_at timestamptz default now()
)  -- append-only (hr_reject_append_only trigger, same as other audit tables); RLS forced; no API-role grants

hr_leave_runs (
  id uuid pk, organization_id uuid, run_type text check in ('entitlement_grant','year_close'),
  leave_year int, status text, preview_token text, request_id uuid unique,
  summary jsonb, actor_id uuid, created_at timestamptz
)  -- idempotent batch runs, append-only
```

Add `hr_leave_ledger` and `hr_leave_runs` to the HR Data Management reset allowlist (category *Leave*), and to the permanent-deletion dependency classification (`identity_deletion_category`) as **BLOCKING** history.

## 4. Business rules (Malaysia, Employment Act 1955 as amended 2022) — configurable defaults

| Rule | Default | Source / note |
|---|---|---|
| Annual leave | < 2 yrs: 8 days; 2–< 5 yrs: 12; ≥ 5 yrs: 16 (s.60E); prorated for incomplete year of service | Seed as `entitlement_tiers` on `ANNUAL` |
| Sick leave (no hospitalisation) | 14 / 18 / 22 days by same service bands; hospitalisation up to 60 days in aggregate (s.60F) | Model as `SICK` + `HOSPITALISATION` with shared cap check |
| Maternity | 98 consecutive days (s.37, 2022 amendment) | Counts calendar days |
| Paternity | 7 consecutive days, married male, ≥ 12 months service, up to 5 confinements (s.60FA) | Needs gender/marital master data (P5c) |
| Public holidays | 11 gazetted days per year incl. the 5 compulsory ones (s.60D); a holiday on a rest day is replaced by the next working day | `observed_date` |
| Rest days / working days | From `hr_attendance_policies.workdays`; half-day = 0.5 | |
| Carry forward | Per type `carry_forward.maxDays`, expiry `expiryMonths` after year end | Year-close run |
| Encashment of untaken annual leave on termination | Supported as ledger `encashment` feeding final pay (P6) | Confirm policy with counsel before enabling |

Rules are seeded as **defaults per organization**, editable under `hr.leave.manage`. Statutory minima are enforced as a floor when `entitlement_basis = 'statutory_ea'`.

## 5. Database functions (all `security definer`, `set search_path = pg_catalog, pg_temp`, execute granted to `service_role` only)

| Function | Purpose | Authorization inside |
|---|---|---|
| `hr_leave_quote(p_employee, p_type, p_start, p_end, p_half_day, p_half_period)` → jsonb | Day-by-day breakdown: workdays, rest days, holidays (national + employee organization's state via `organizations.state_id`), resulting `working_days`, balance before/after, warnings (notice, max consecutive, attachment, gender) | none (pure), called by the others |
| `hr_leave_apply(p_actor, p_payload, p_request_key)` | Validates via quote, overlap check against pending/approved, onboarding guard, creates request (`pending` or `approved` when `requires_approval=false`), creates approval steps from the chain, writes `pending_hold` ledger | own record: `hr.self_service.use`; on behalf: `hr.leave.manage` |
| `hr_leave_decide(p_actor, p_request_id, p_action, p_comment, p_expected_version, p_request_key)` | Approves/rejects the **current** step. Final approval: `pending_release` + `taken` ledger; reject: `pending_release` | step role `direct_manager`: actor must be the resolved approver **and** hold `hr.mss.leave_approve`; `hr_manager`: `hr.leave.approve`; delegated: delegate must hold the same key; **actor ≠ employee always** |
| `hr_leave_cancel(p_actor, p_request_id, p_reason, p_request_key)` | `pending` → `cancelled` (+`pending_release`); `approved` with start in future → `cancellation_pending` (re-enters chain) or direct cancel by HR; approved and (partly) taken → HR only, `taken_reversal` for untaken days | employee own / `hr.leave.manage` |
| `hr_leave_adjust(p_actor, p_employee, p_type, p_year, p_qty, p_reason, p_request_key)` | Manual adjustment (reason ≥ 10 chars) | `hr.leave.manage`; actor ≠ employee |
| `hr_leave_entitlement_preview/execute(p_actor, p_org, p_year, …)` | Grants yearly entitlement + proration from `hire_date` (confirmed only) and service tiers; idempotent per employee/type/year | `hr.leave.manage` |
| `hr_leave_year_close_preview/execute(p_actor, p_org, p_year, p_preview_token, p_request_key)` | Carry forward up to cap into `year+1`, schedule expiry, forfeit remainder; one run per org/year | `hr.leave.manage` |
| `hr_leave_expire_carry_forward(p_as_of)` | Daily job (cron lease pattern in `lib/cron/lease.ts`) posting `carry_forward_expiry` | system |
| `hr_leave_unpaid_days(p_org, p_period_start, p_period_end)` → set | Approved unpaid leave days per employee for payroll | `hr.payroll.prepare` |
| `hr_leave_reassign_pending(p_actor, p_from_user, p_to_user)` | Moves pending steps of an archived/departed approver | `hr.leave.approve` (also called by P5b archive hardening) |

Approver resolution order for `direct_manager`: active delegation of the manager (`hr_delegation_rules`, date-bounded) → `hr_employees.manager_user_id` (same source MSS uses) → if manager archived/inactive or missing: escalate to the chain's next step or the `hr_manager` step. Auto-approve/escalation after `auto_approve_after_hours` / `escalation_hours` by the same cron job; auto-approval is **off by default**.

Concurrency: `pg_advisory_xact_lock(hash('hr_leave:'||employee))` around apply/decide/cancel/adjust; `FOR UPDATE` on the request; `p_expected_version` optimistic check; `lock_timeout 5s`.

## 6. RLS after P4

| Table | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| `hr_leave_requests`, `hr_leave_approvals` | own rows; direct reports (`hr_employees.manager_user_id = auth.uid()` and `hr.mss.leave_view`); `hr.leave.view` / `hr.leave.approve` holders in org | **none** for `authenticated` (functions only) |
| `hr_leave_balances`, `hr_leave_ledger` | own; direct reports (MSS); `hr.leave.view` | none |
| `hr_leave_types`, `hr_public_holidays` | org members (needed by ESS) | none (functions / `hr.leave.manage`, `hr.settings.manage` routes via service role) |

## 7. API surface (`/api/hr/leave/*`, all `noStore`, actor from session)

| Route | Method | Key | Calls |
|---|---|---|---|
| `/types` | GET | org member | read |
| `/types`, `/types/[id]` | POST/PATCH | `hr.leave.manage` | validated upsert (service role) |
| `/quote` | POST | own: `hr.self_service.use` | `hr_leave_quote` |
| `/requests` | GET `?scope=my|team|all` | my: ESS; team: `hr.mss.leave_view`; all: `hr.leave.view` | read |
| `/requests` | POST | ESS / `hr.leave.manage` | `hr_leave_apply` |
| `/requests/[id]/decision` | POST | `hr.mss.leave_approve` or `hr.leave.approve` | `hr_leave_decide` |
| `/requests/[id]/cancel` | POST | own / `hr.leave.manage` | `hr_leave_cancel` |
| `/balances` | GET `?employee=` | own / MSS / `hr.leave.view` | read |
| `/adjustments` | POST | `hr.leave.manage` | `hr_leave_adjust` |
| `/runs/entitlement`, `/runs/year-close` | POST preview / execute | `hr.leave.manage` | run functions |
| `/calendar` | GET | own / MSS team / `hr.leave.view` | read (team calendar) |
| `/approval-chains`, `/delegations` | GET/POST/DELETE | `hr.leave.manage`; own delegation: ESS + `hr.mss.leave_approve` | service role |

Register all routes in `lib/security-access/route-coverage.ts`; new destinations `hr/leave/balances`, `hr/leave/calendar`, `hr/team-leave` (exists) wired in `nav-access.ts`.

## 8. UI reuse

| Component | Change |
|---|---|
| `modules/hr/leave/types.ts` | Keep domain types; add `quote`, ledger entry types |
| `modules/hr/leave/repository.ts` | Delete `MockLeaveRepository`; `ILeaveRepository` gets an `ApiLeaveRepository` (fetch `/api/hr/leave/*`) |
| `supabaseRepository.ts` | Remove (or keep read-only for one release behind a flag) |
| `HrLeaveTypesView`, `HrLeaveRequestsView` | Switch to `ApiLeaveRepository`; show server quote and chain progress |
| `HrLeaveApprovalFlowView` | Real chains/delegations via API; hidden in P2 until then |
| `HrMobileLeave` | Use `/quote` + `/requests`; team tab uses `/requests?scope=team` (direct reports only); approve via `/decision` |
| `HrManagerWorkspaceView` | Add approve/reject on `hr/team-leave` |
| `assistant/tools.ts` | Read balances via the projection (unchanged columns) |

## 9. Payroll integration

`hr_leave_unpaid_days()` returns approved unpaid working days per employee within the payroll period (split across periods by date). P6 deducts `basic / working_days_in_month × unpaid_days` (formula configurable; EA uses ordinary rate of pay for deductions). Approved leave crossing a locked payroll period cannot be cancelled without HR (`payroll_locked` blocker) — the cancellation creates a `taken_reversal` that P6 picks up as an adjustment in the next run.

## 10. Phase breakdown

| Sub-phase | Scope | Migration | Acceptance |
|---|---|---|---|
| **P2 (containment)** | Trigger `hr_leave_requests_transition_guard`: INSERT only `employee_id = auth.uid()` (or `hr.leave.approve` holder) with status `draft|pending`; status → `approved/rejected` only when actor ≠ employee and (`sa_rls_gate('hr.leave.approve')` or actor is the employee's `hr_employees.manager_user_id`); narrow SELECT to own / direct reports / `hr.leave.approve`. Fix `HrMobileLeave` type query (`status='active'`), restrict team tab to direct reports. Hide Approval Flow nav entry. | `20261219100000_hr_leave_containment_guard.sql` | Self-approval and impersonated insert refused (SQL replica); ESS can apply; manager can still approve direct reports |
| **P4a** | Data model + functions + ledger + RLS lockdown | `2026122x_hr_leave_workflow.sql` | All transitions only via functions; replica tests green |
| **P4b** | API + UI switch + MSS approval | none | No `from('hr_leave_` writes in `app/src` (grep gate) |
| **P4c** | Entitlement + year-close runs + expiry job + statutory seeds | small seed migration | Year-close idempotent; balances = ledger sum for every employee |

## 11. Risks

| Risk | Mitigation |
|---|---|
| Existing leave rows violate the new status CHECK | Pre-migration diagnostic; map unknown statuses; CHECK added `not valid` then `validate` after cleanup |
| Existing `hr_leave_balances` numbers vs ledger | Opening-balance migration writes one `entitlement`/`manual_adjustment` ledger row per balance row (reason "opening balance"), so projection equals today's numbers |
| RLS tightening breaks current screens before P4b ships | P2 keeps manager approval possible for direct reports; full lockdown only in P4a together with the API |
| State holidays need employee work location | Use organization `state_id` first; per-employee work state later (P5c) |
| Hire dates not confirmed (`hire_date_confirmed=false` for legacy rows) | Entitlement run reports them as blockers instead of guessing |

## 12. Tests

- SQL replica (`supabase/tests/security/hr_leave_workflow/`): self-approval refused; cross-org refused; manager of another team refused; archived approver skipped; idempotent apply/decide; concurrent decide (two sessions) → one wins; cancel paths; ledger sum = projection; year-close twice = once; onboarding guard still fires.
- Unit: quote engine (rest days, half days, state holidays, replacement holiday, cross-year request split, maternity calendar days), entitlement tiers and proration rounding.
- Route tests: each route denied/allowed/cross-org (pattern `route.identity.test.ts`).
- Component: `HrMobileLeave` (types load, quote shown), `HrLeaveRequestsView` uses API, Approval Flow no mock import (static test).

## 13. Rollback

- P2: drop the trigger and restore the previous policy definitions (kept verbatim in the migration header).
- P4a: functions/tables are additive; rollback = revoke service-role execute, restore P2 policies, keep ledger for audit. Requests created through the API remain valid rows of the original table.
- P4b: revert UI commit (repository swap is one import per view).
