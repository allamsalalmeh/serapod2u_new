# Bulk employee removal — permanent delete & archive (Issue 1E)

Branch `Enhancement03`, 2026-10-24. Builds on `PERMANENT_IDENTITY_DELETION.md` (Issue 1) and
`IDENTITY_ARCHIVE_AND_IDENTIFIER_RELEASE.md` (Issues 1B/1C). No database migration is required.

## A. Audit findings

| Question | Finding |
|---|---|
| Row selection | `HrPeopleView` already keeps `selectedUsers: Set<string>` fed by the existing row checkboxes. `toggleSelectAll` selects the current tab + search + department + status list; switching tabs clears it. There is no pagination. |
| Persistence across filters | Selection survives filtering/sorting; the toolbar always reports the full selected count and the dialog resolves every selected UUID to its name, so a filtered-out selection is still visible. Row checkboxes for former employees are disabled. |
| Existing bulk edit | The same contextual toolbar updates department/position/manager for the selection (`applyBulkUpdate`). Removal is added to this toolbar; the three-dot row menu stays single-target. |
| Single-user delete | `/api/identity/permanent-delete` → `deletionPreview`/`deletionExecute` → `identity_deletion_preview/_execute`. DB decides `platform.identity.delete` + `hr.employee.delete` (entry `hr`), protections, dependency blockers, preview token, phrase, request-id idempotency, durable record, then the server verifies the auth login is gone. |
| Single-user archive | `/api/identity/archive` → `archivePreview`/`archiveExecute` → `identity_archive_preview/_execute`. One transaction: employment end (resigned/terminated), ARCHIVED status (S&A leaver sync revokes assignments/memberships/delegations), login ban, sessions/refresh/one-time tokens revoked, optional identifier release. UUID and history kept. |
| Preview tokens | md5 state fingerprints produced by the database (`identity_deletion_plan` / `identity_archive_plan`). Execute refuses when the state no longer matches (`stale`). |
| Idempotency | `request_id` is unique in `identity_deletion_requests` / `identity_lifecycle_actions`; a repeat by the same actor for the same target returns the recorded outcome. |
| Existing bulk tool | `/api/admin/bulk-delete-users` is a staging-only streamed tool behind `assertDestructiveOpsAllowed` (env + `platform.data.destructive`); it already loops `deletionPreview`/`deletionExecute`. It is not exposed to HR and is unchanged. |
| Permissions | Hard delete and archive both need explicit `platform.identity.delete` in the target's organization; the HR entry point additionally requires `hr.employee.delete`. No new permission was introduced. |
| Counts | `HrPeopleView` derives Onboarded / Awaiting onboarding / Former from `users.account_status` + `hr_employees.onboarding_status` over rows joined to `hr_employees`; archived = Former, hard-deleted = no row at all. |
| Organization boundary | `identity_deletion_authorize` decides in the **target's** organization. The bulk contract additionally pins the actor's own organization (loaded server-side) and masks/rejects any target outside it. |

## B. Design

```
checkbox selection (existing)
        │
        ▼
POST /api/hr/employees/bulk-removal/preview     read-only, per identity:
        │   deletionPreview(entry=hr) + archivePreview(entry=hr)
        │   → DELETE_ELIGIBLE | ARCHIVE_ELIGIBLE | BLOCKED | UNVERIFIED
        ▼
review screen: per-employee operation, employment outcome, identifier release
        │
        ▼
POST /api/hr/employees/bulk-removal/plan        fresh previews + plan validation
        │   → server phrase "REMOVE n EMPLOYEES", plan reference, 10-minute expiry,
        │     signed token: actor, organization, request id, exact UUIDs,
        │     each action, each target's preview-state hash, plan fingerprint
        ▼
typed phrase (no extra checkbox)
        │
        ▼
POST /api/hr/employees/bulk-removal             verify signature/actor/org/request id/
        │   phrase/fingerprint → re-preview every target (state must match) →
        │   guardActor again → strictly serial per-identity execute → bounded BUSY retry
        ▼
per-employee results (deleted / archived / blocked / failed / stale) + summary
```

- **No parallel engine.** Every mutation is `deletionExecute` or `archiveExecute` (entry `hr`); the DB re-authorizes,
  re-checks protections and dependencies under locks, verifies the per-target preview token, writes the audit record.
- **No silent substitution.** A delete request for a person the DB blocks is a *problem* in the plan step
  (`PLAN_NOT_ALLOWED`); the UI offers Archive & Revoke Access as a separate, explicitly chosen option.
- **No fallback.** A failed/blocked permanent deletion is reported as failed/blocked; an archive is never attempted.
- **Idempotency.** The batch `request_id` is server-generated at the plan step; each target's canonical request id is
  `HMAC(secret, "identity-bulk-removal|batch|user|action")` formatted as a UUID. A retry of the same batch replays the
  recorded per-identity outcome instead of acting twice.
- **Stale / changed.** If any target's preview-state hash or allowed action changed after review, the whole batch is
  refused before the first mutation (`PREVIEW_STALE` / `PLAN_NOT_ALLOWED`) and must be reviewed again.
- **Partial results.** Each target is its own transaction; one failure never rolls back or blocks another. The response
  carries `summary` + `results` and `success` is `true` only when every planned identity reached its confirmed outcome.
- **Serial destructive execution (Issue 1F).** One canonical transaction at a time; see section H for the proven
  same-batch lock conflict this removes.

## C. Security

- Session actor only; the organization comes from the actor's `users` row, never from the request body.
- Actor must be active, in that organization, and pass the database's `identity_deletion_actor_check` (HR entry) before
  any preview is read.
- Every target's organization must equal that organization (from the preview payloads); otherwise it is blocked and its
  identity details are masked.
- The signed token is HMAC-SHA256 bound to actor + organization + batch request id + exact UUIDs + actions +
  preview-state hashes + phrase; tampering, replay for another actor/org, plan edits and expiry are all refused.
  Secret: `IDENTITY_BULK_REMOVAL_SECRET` (falls back to `SUPABASE_SERVICE_ROLE_KEY`); missing secret fails closed.
- The typed phrase is a UX confirmation, not the security boundary; the per-identity database preview tokens and
  re-checks are.
- Root Access, Super Admin, dominance, self, last administrator, HR go-live, direct reports and protected
  history blockers are enforced by the existing database functions unchanged. Last-admin protection also blocks archive.
- Reason: required (≥10 chars) only when the plan contains a permanent deletion (canonical rule); optional for archive.
  An empty reason is stored as empty, never fabricated.
- Identifier release defaults to on only where the preview says it is possible; the administrator can opt out per employee
  or for the batch. Release keeps the history under the archived UUID and prevents identifier inheritance.
- The staging-only `/api/admin/bulk-delete-users` guard is untouched and not used by this feature.

## D. SQL

**No migration is required.** The feature uses the already-installed canonical functions and audit tables:

- `identity_deletion_preview`, `identity_deletion_execute`, `identity_deletion_actor_check`
  (`supabase/migrations/20261216100000_identity_permanent_deletion.sql`)
- `identity_archive_preview`, `identity_archive_execute` (`20261217100000_identity_archive_identifier_release.sql`,
  optional-reason version `20261218100000_identity_archive_optional_reason.sql`)
- durable records `identity_deletion_requests`, `identity_lifecycle_actions`, `destructive_ops_audit_log`

Prerequisites are unchanged: those migrations applied, `platform.identity.delete` and `hr.employee.delete` present in
`sa_permissions`, and the caller granted both in the organization. No staging/production DDL was executed.

## E. Local UAT (disposable identities only)

The local `.env.local` points at the shared staging database. **Do not run the execute step against it.** Use a local
Supabase instance with synthetic people, or stop after step 4 (read-only preview) on staging.

1. Sign in as an administrator who holds `platform.identity.delete` + `hr.employee.delete` in the organization.
2. Create three disposable employees (test emails you own; no real data) with a mix of situations: one clean identity,
   one with a linked business record (make it archive-only), one protected (e.g. an account holding Root Access).
3. Open `/hr/people/employees`. Tick one row → toolbar shows `1 employee selected`, `Clear selection`, `Remove Selected`.
   Tick two more → count updates. Untick → count updates. Click the header checkbox → every selectable row in the current
   filtered list is selected (the former-employees tab cannot be selected).
4. Click **Remove Selected**. Confirm the preview lists all three with their classification, organization, employment
   status, blockers and the history note. Nothing is changed yet (rows and counts unchanged; Cancel works).
5. Choose Permanent deletion for the clean identity, Archive & Revoke for the history-linked one, Skip the protected one.
   Set the employment outcome (Resigned/Terminated), leave identifier release on where allowed.
6. Click **Review confirmation**. The confirmation screen shows the plan reference, the counts, the exact phrase
   `REMOVE 2 EMPLOYEES`, the optional/required reason state and every employee with its operation. Type the phrase and
   submit. Expect per-user results (deleted, archived) and any failure called out.
7. Verify: the hard-deleted person is gone from Onboarded, Awaiting and Former and from User Management; the archived
   person is in Former employees, cannot sign in, has no effective S&A access, keeps UUID/employee number/history; the
   protected person is untouched. Counts refresh without a page reload. Blocked/failed selections remain selected.
8. Confirm the single-employee three-dot menu still works: Delete Employee Permanently, Archive & Revoke Access,
   Release Email & Phone.


## F. Tests (executed locally)

- `src/lib/identity/bulk-removal-plan.test.ts` — 21 tests: classification, phrase, signed token/tamper/expiry, plan
  fingerprint, per-target request ids, plan validation, summary.
- `src/lib/identity/bulk-removal.test.ts` — 26 tests: mixed classification, unverified, cross-organization masked,
  permission/org refusal, confirmation contract binding, delete-not-allowed refusal, phrase mismatch, plan change,
  stale state, optional archive reason, mixed execution, blocked identity, no archive fallback, idempotent retry,
  re-authorization at execution, foreign actor/org token rejection, serial execution, transient conflict retry,
  persistent conflict, unconfirmed auth cleanup, no retry for blockers/stale.
- `src/app/api/hr/employees/bulk-removal/route.test.ts` — 9 tests: unauthenticated refusal, server-derived organization,
  status mapping, plan problems, execution, mixed results not reported as success, audit rows, unconfirmed 500.
- `src/components/identity/BulkRemovalDialog.test.tsx` — 8 tests: per-target plan/blockers, constrained actions,
  exact phrase, default/opt-out identifier release, optional archive reason, employment outcome, blocked-only,
  mixed result rendering, stale re-review, transient-conflict retry.
- `src/components/hr/HrPeopleView.bulkRemoval.test.tsx` — 3 tests: toolbar/count/clear, select-all scope and former
  exclusion, end-to-end removal refresh (deleted row absent from Former, counts updated).
- Regression: `npx vitest run src/components/hr src/components/identity src/lib/identity src/app/api/hr/employees src/app/api/identity src/app/api/admin/bulk-delete-users src/lib/security-access/route-coverage.test.ts` → 38 files, 379 tests passed.
- Full suite: 648 passed / 1 failed (649 files); 6460 passed / 1 failed (6467 tests). The remaining failure is
  pre-existing and unrelated: `orders/[orderId]/ship-metrics` (its staging schema snapshot lacks
  `v_stock_movements_display`).
- Isolated PostgreSQL 17 lock regression (`supabase/tests/identity/bulk_removal_locking/run.sh`) → 4/4 PASS.
- TypeScript: `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` reports no error in the new/changed files; the
  repository's pre-existing `.next/dev/types` parse errors and unrelated route typing errors remain (unchanged).

## G. Files

| File | Change |
|---|---|
| `app/src/lib/identity/bulk-removal-plan.ts` | New: pure classification, phrase, plan fingerprint, signed token, per-target request id, validation, summaries |
| `app/src/lib/identity/bulk-removal-labels.ts` | New: client-safe labels |
| `app/src/lib/identity/bulk-removal.ts` | New: org-scoped preview, confirmation contract, bounded execution through the canonical services |
| `app/src/app/api/hr/employees/bulk-removal/preview/route.ts` | New: read-only eligibility preview |
| `app/src/app/api/hr/employees/bulk-removal/plan/route.ts` | New: plan validation + confirmation token |
| `app/src/app/api/hr/employees/bulk-removal/route.ts` | New: batch execution + audit |
| `app/src/components/identity/BulkRemovalDialog.tsx` | New: review → confirm → results dialog |
| `app/src/components/hr/HrPeopleView.tsx` | Toolbar Remove Selected / Clear selection, select-all semantics, dialog wiring, refresh/clear |
| `app/src/lib/identity/archive.ts` | Typed `organization_id` already present in the archive preview payload |
| `app/src/lib/security-access/route-coverage.ts` | Classified the three new routes (ENTERPRISE, canonical permissions) |
| tests above | New |
| `docs/identity/BULK_EMPLOYEE_REMOVAL.md` | This document |


## H. Issue 1F — intermittent failures: root cause and fix

### Proven root cause

The canonical permanent deletion does two things in one transaction
(`20261216100000_identity_permanent_deletion.sql`):

1. `identity_deletion_plan` adds **every** `public` table with a person-shaped UUID column without a single-column FK to
   `lock_tables`. `hr_employees` qualifies through `onboarded_by` / `onboarding_reset_by` (no FK), and
   `identity_lifecycle_actions` through `actor_id` / `target_user_id` (no FK).
2. `identity_deletion_execute` takes `LOCK TABLE … IN SHARE MODE` on those tables, then **deletes from
   `hr_employees`** in the same transaction (row/table lock upgrade to `ROW EXCLUSIVE`), and inserts into
   `identity_lifecycle_actions`-adjacent audit tables.

`SHARE` conflicts with `ROW EXCLUSIVE`, and no two transactions can hold `SHARE` while both waiting to upgrade it.
The previous bulk orchestrator executed up to **3** canonical removals in parallel. Therefore:

| Same-batch combination | PostgreSQL outcome | Mapped by `permanent-deletion.ts` |
|---|---|---|
| Delete ‖ Delete | Both hold `SHARE` on `hr_employees`, both request `ROW EXCLUSIVE` for the cleanup `DELETE` → **deadlock**, SQLSTATE **40P01**; one transaction aborts | `BUSY` → “This person’s records are being changed right now.” |
| Delete ‖ Archive | Archive `UPDATE hr_employees` / `INSERT identity_lifecycle_actions` holds `ROW EXCLUSIVE`; the delete’s `LOCK TABLE … SHARE` waits on the 5s `lock_timeout` → **55P03** | same `BUSY` message |
| Archive ‖ Archive | Different rows, no table-level `SHARE` locks → succeeds | — |

This is why the reported batch had 5 archives succeed while 2 permanent deletions failed, and why the failure was
intermittent (it depends on whether two destructive transactions overlap). It is a conflict **created by the batch**, not
a change to the target.

### Evidence

- Isolated disposable PostgreSQL 17 cluster, schema mirroring the canonical lock structure
  (`supabase/tests/identity/bulk_removal_locking/`):
  - two concurrent deletions → `ERROR: 40P01: deadlock detected` at `DELETE FROM hr_employees`; one committed,
    the other fully rolled back (3 of 4 users remained, 1 deletion record);
  - deletion next to an archive → `ERROR: 55P03: canceling statement due to lock timeout` at
    `LOCK TABLE hr_employees IN SHARE MODE`; archive committed;
  - serial deletions → both commit, no orphan rows;
  - two overlapping requests for one identity → the advisory lock serializes them, the second finds the target gone
    and writes no duplicate deletion record.
  - runner: `./supabase/tests/identity/bulk_removal_locking/run.sh` → `RESULT: PASS` (4/4).
- Read-only staging audit (`destructive_ops_audit_log`): the reported batch is recorded as
  `9 planned, 2 deleted, 5 archived, 2 failed`; an earlier batch shows `3 planned, 1 failed`.
- Read-only staging check of the two failed accounts: both still `account_status = ACTIVE`, `is_active = true` with
  unchanged `updated_at`; no deletion record. Their transactions rolled back completely; they are unchanged and safe to
  retry. Nothing was retried, archived or deleted during this investigation.

### Fix (application-only; no migration)

1. **Serial destructive execution** — `EXECUTION_CONCURRENCY = 1`; previews remain parallel (4) because they are
   read-only. This removes same-batch deadlocks/timeouts without touching canonical locks or checks.
2. **Narrow retry for proven transaction aborts** — only `BUSY` (lock timeout/deadlock) is retried, at most twice with
   300 ms / 900 ms backoff, with the **same** per-target request id and preview token. The canonical function re-checks
   authorization, dependencies and the preview token on every attempt. Authorization denials, blockers, stale previews,
   invalid confirmations, `AUTH_CLEANUP_REQUIRED` and unknown failures are never retried.
3. **Accurate outcomes** — new `conflict` (transient, unchanged, `retryable: true`) and `unconfirmed`
   (`AUTH_CLEANUP_REQUIRED`; records may be deleted but login removal was not verified; never auto-retried). `complete`
   is false unless every planned identity was deleted/archived.
4. **Safe retry in the UI** — “Retry unchanged employees (n)” only appears for backend-marked retryable results, keeps
   that employee’s reviewed operation/outcome/release choice, re-runs the authoritative preview and requires a new
   server phrase and confirmation token. Unconfirmed results are never retried automatically.
5. No archive substitution and no weakening of preview tokens, permissions, Root/Super Admin/last-admin/HR-live
   protections or audit records.

### Issue 1F test results

- `src/lib/identity/bulk-removal.test.ts` — 26 tests, including serialization (max in-flight = 1), BUSY→success retry
  with identical request id, persistent BUSY → `conflict` + `retryable` + no archive fallback, `AUTH_CLEANUP_REQUIRED`
  → `unconfirmed` and no retry, blocked/stale never retried.
- `src/lib/identity/bulk-removal-plan.test.ts` — 21 tests (summary now separates conflict/unconfirmed).
- `src/app/api/hr/employees/bulk-removal/route.test.ts` — 9 tests.
- `src/components/identity/BulkRemovalDialog.test.tsx` — 8 tests, including conflict rendering and a retry that
  re-previews only the unchanged employee while preserving its operation.
- `src/components/hr/HrPeopleView.bulkRemoval.test.tsx` — 3 tests.
- Isolated PostgreSQL lock regression — 4/4 PASS (see above).

