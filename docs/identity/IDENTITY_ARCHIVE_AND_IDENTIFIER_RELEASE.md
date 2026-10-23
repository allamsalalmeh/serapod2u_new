# Archive & Revoke Access, and email/phone release (Issue 1B + 1C)

Branch `Enhancement03`, 2026-10-24. Complements `PERMANENT_IDENTITY_DELETION.md` (Issue 1).

## A. Audit (before)

| Question | Finding | Evidence |
|---|---|---|
| Archive behaviour | `identity_set_account_status(…,'ARCHIVED')` sets `account_status`, `is_active=false`; the users trigger runs `sa_sync_user_lifecycle` (leaver): assignments `revoked` with `effective_until`, memberships `inactive`, delegations/requests/emergency grants revoked | staging schema; `lib/identity/removal-authorization.ts` (old `archiveIdentityKeepingIdentifiers`) |
| Can an archived account still sign in? | Only a best-effort GoTrue ban (`ban_duration 876000h`) after the DB commit; failure was logged and ignored | `lib/identity/provisioning.ts:281` |
| Do existing sessions keep working? | **Yes** — `auth.sessions` / `auth.refresh_tokens` were never touched; recovery / magic-link tokens stayed valid | negative control `identity_archive_release/20_before_tests.sql` |
| S&A after archive | No effective permission: `sa_evaluate_permission_core` denies inactive actors (`ACCOUNT_INACTIVE`) | staging function |
| HR lists | Archived people stayed in Onboarded / Awaiting onboarding (anchor kept `onboarding_status`, `status='active'`) | `HrPeopleView` filtered by onboarding only |
| Email/phone | Reserved forever; `identity_resolve` → `IDENTITY_ARCHIVED` | `20260929160000_identity_stage2_archive_keeps_identifiers.sql` |
| Historical names | History joins `public.users.full_name` by UUID; users read policies have no status filter → archived names keep resolving | `pg_policy` on `users` |
| Reactivation | `identity_set_account_status(…,'ACTIVE')` (platform.identity.delete) | — |
| New person with old identifier | Impossible (reserved), so never mis-matched — but also never reusable | — |

## B. Design

Account state (`users.account_status`), employment state (`hr_employees.status/end_date`) and HR registration
(`hr_employees.onboarding_status`) stay separate. **ARCHIVED** = former user.

- **Delete Permanently** (Issue 1): only when no protected dependency exists.
- **Archive & Revoke Access** (`identity_archive_execute`, one DB transaction): employment ended (`resigned`/`terminated`,
  `end_date`), `identity_set_account_status(…,'ARCHIVED')` (re-asserts platform.identity.delete + Root rules → S&A leaver sync),
  `identity_revoke_login` (auth ban +100y, sessions/refresh tokens incl. session-less, one-time tokens, recovery/confirmation
  tokens cleared, unused app OTP codes invalidated), Telegram links off, optional release. Post-conditions verified or everything
  rolls back. UUID, name, employee number and every reference unchanged.
- **Release Email & Phone** (`identity_release_identifiers`, archived only): originals → `identity_identifier_releases`
  (RLS, no API role); `public.users.email` → `archived+<uuid>@released.invalid` (NOT NULL/unique, RFC 2606), phone NULL;
  `auth.users` email/phone likewise, password cleared, `auth.identities` deleted (no Google/OAuth sign-in).
- **Resolver**: a released identifier returns `IDENTITY_PREVIOUSLY_RELEASED` (+ `released_user_ids`) instead of `NO_MATCH`.
  Add User stops and asks *same person* (reactivate) vs *different person* (`releasedIdentifierDecision:'new_person'` → new
  login + new UUID, decision recorded in `identity_conflicts`). Consumer self-sign-up treats it as a new person; HR lookup and
  imports block with an explanation.
- **Rehire**: reactivation (`identity_set_account_status` ARCHIVED→ACTIVE) restores released identifiers (fails closed with
  `identity_released_identifier_taken` if someone else owns them) and lifts the ban; revoked S&A grants are **not** restored.
- **Authority**: same as permanent deletion — explicit `platform.identity.delete` in the target org (+ `hr.employee.delete` from
  HR), no delegation; protections SELF, active Root Access, Super Admin, dominance, last HQ administrator. Not tied to HR go-live.
- **Records**: `identity_lifecycle_actions` (append-only; completed + blocked), `sa_access_change_log` entries
  (`identity.status_changed`, `identity.identifiers_released`, `identity.reactivated`, `lifecycle.leaver`).

## C. Implementation

- `supabase/migrations/20261217100000_identity_archive_identifier_release.sql`
- `app/src/lib/identity/archive.ts`, `app/src/app/api/identity/archive/route.ts` (GET preview, POST archive|release)
- `app/src/components/identity/ArchiveIdentityDialog.tsx` (shared); `PermanentDeleteDialog` offers it when deletion is blocked
- User Management: *Current / Archived (former) / All* view (default current; totals follow), Archived badge, archive / release /
  reactivate actions, released-identifier decision dialog; the OTP dialog is no longer used in the UI.
- HR → Employees: *Former employees* tab; archived people never in Onboarded/Awaiting; manager picker excludes them; row menu
  Archive & Revoke Access / Release Email & Phone / Delete Employee Permanently.
- `archiveIdentityKeepingIdentifiers` (OTP API route) now runs the canonical archive.
- `lib/identity/resolution.ts`, `provisioning.ts`, `actions.ts` (decision + consumer sign-up), route coverage.

## D–E. Identifier reuse and history

See tests `supabase/tests/security/identity_archive_release/30_after_tests.sql`: history fingerprint (orders, stock movement,
document, GL journal, leave, payroll, SoD, assignments) identical before/after archive, release and a new registration with the
released email; all names still resolve to the archived person; new person has a new UUID and no grants/employee number/HR history.

## F. Tests (local PG17 replica from the 2026-10-22 staging schema dump; no staging access)

- `identity_archive_release/run.sh`: negative control + 75 assertions incl. two concurrency races and the PostgREST path.
- Regression on the patched schema: permanent delete 80/80, HR controlled delete 69/69.
- `identity_foundation` suite not runnable on the current schema (expects the September all-SHADOW baseline; fails identically
  before and after).

## G. Migrations (apply by hand, owner role, in order; NOT applied anywhere)

1. `20261214100000_hr_employee_controlled_delete.sql`
2. `20261216100000_identity_permanent_deletion.sql`
3. `20261217100000_identity_archive_identifier_release.sql`

**Version clash:** an untracked file from other work, `20261216100000_sa_legacy_preview_scope_coverage.sql`, has the same
version as step 2 — rename one before using the Supabase CLI.

## H. Localhost UAT (after applying; localhost = STAGING database — synthetic accounts only)

1. Add User `uat-former-1@example.test` (+ phone), sign in once in another browser, create a draft order with it.
2. User Management → trash icon → blocked (orders) → *Archive & Revoke Access instead* → reason, type the email, confirm.
   The other browser's next request should be signed out (GoTrue refuses a token whose session row was deleted —
   `session_not_found`; **verify this in UAT**, it was not testable without a live GoTrue); the user leaves *Current users* and appears under *Archived*; HR shows them
   under *Former employees*; the order still shows their name.
3. Archived view → unlock icon → *Release Email & Phone*.
4. Add User again with `uat-former-1@example.test` → decision dialog → *Different person* → a new account (new ID) with no access.
5. Read-only check: `select id, email, account_status from users where full_name ilike 'uat-former%';` and
   `select status, details from identity_lifecycle_actions where target_user_id = '<old id>';`.

## Risks / open items

- User pickers outside HR/UM that list users without a status filter may still show archived people (they cannot act: S&A denies
  inactive actors). Not exhaustively audited.
- A JWT issued before archive stays cryptographically valid until expiry, but GoTrue rejects it once its session row is gone; any
  code path that trusts a JWT without calling GoTrue (`getUser`) would accept it until expiry.
- UM archive no longer uses the WhatsApp/SMS OTP in the UI (same safeguards as permanent delete: explicit S&A + reason + typed
  confirmation); the OTP API routes still work and use the canonical archive.
- `before_image`/release snapshot keep the former person's contact details (restricted tables) as audit evidence.
