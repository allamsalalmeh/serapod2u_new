# Root Access (Full System Administrator)

Platform & Security → Security & Access → People & Access.

## What it is

Root Access is an explicitly assigned, independently revocable, **system-level privilege** held by a person. It is not a
Group Policy, a role or a permission key. It is stored in `public.sa_root_access_grants`. A grant is active only while all
of these hold: `status = 'active'`, the grant has not expired, and the account (`users.is_active`) is active.

While it is active, the canonical evaluator (`sa_evaluate_permission` → `sa_evaluate_permission_core`) returns **ALLOW**
with reason `ALLOWED_BY_ROOT_ACCESS` for:

- every permission present in `sa_permissions` with status `active`. Permissions added later are covered automatically.
  Unknown and deprecated keys are not covered.
- every real organization: HQ, branches, warehouses, distributors, manufacturers and shops. A forged organization id is
  not covered.

Legacy level 1 / Super Admin accounts are **not** converted, and level 1 is never authority to grant Root Access.

## Where it applies

| Path | Root Access | Notes |
|---|---|---|
| API routes (`authorize` / `requireAuthorization`), navigation (`explainMany`) | Yes, in New Access Active / Legacy Retired | Unchanged mode contract: in Legacy Enforced / Monitoring the legacy rule keeps deciding and Root is only logged as the shadow comparison. This prevents escalation through modes. |
| RLS (`sa_rls_gate*`, `sa_cached_actor_allows`), RPC backstop (`sa_require_operation`) | Yes, same modes | Through `sa_actor_has_permission`. |
| Governance assertions (`sa_assert_actor_permission`), grant ceiling (`sa_actor_holds_permission`) | Yes | A Root Administrator can grant any Group Policy in any organization. Organization-independent scopes are allowed too (`sa_assignment_scope_guard`). |
| List scope (`sa_readable_organizations`), S&A directory (`sa_authorized_organizations`) | All organizations | |
| Target protection (`sa_actor_dominates`; User Management edit; `/api/user/update-profile`) | A Root account can be changed, password-reset or deleted only by another Root Administrator | Covers the login phone (synced to Supabase Auth), status, role, organization and profile. |
| HR data reset (`hr_reset_authorize`) | **No bypass** | Still requires a legacy Super Admin, the go-live phase and the confirmation phrase. |
| Confirmation phrases, OTP, preview tokens, approval-amount policies, emergency-access MFA step-up, SoD at grant time | **No bypass** | These are extra verification steps on top of the permission. |

On staging (read-only check, 2026-10-08), all 101 permission keys used by the 536 enterprise API routes are Legacy
Retired. Root Access therefore reaches every enterprise route as soon as the migration is applied.
`security.emergency_access.grant` is still in Monitoring, so the legacy Super Admin rule keeps deciding it.

### Known gaps (reported, not bypassed)

1. **Legacy-only checks that never call the evaluator** do not see Root Access. Examples:
   - `hr_reset_authorize` (intentional).
   - The level-based rule inside the identity functions: "cannot assign a role above your own level"
     (`identity_admin_update_access`). A Root Administrator who is not level 1 cannot give someone a level 1 role.
   - Any page or component that still checks `role_level` directly.
2. **Database-level target protection for account edits.** The identity functions (`identity_admin_update_access`,
   `identity_set_account_status`) do not know Root Access. The guard is enforced in the two application entry points.
   A future migration should add `sa_actor_dominates` or a Root check inside those functions.
3. **Legacy-mode target protection.** While `platform.identity.delete` or `platform.identity_access.manage` is in Legacy
   Enforced / Monitoring, delete and password reset use the legacy level rule. Both are Legacy Retired on staging.
4. **Server trust boundary.** As with every governance function, `p_actor` comes from the application server (service
   role). A leaked service-role key could name a Root Administrator as the actor. It cannot bootstrap, because that
   requires the database owner.

## Who can grant and revoke

All changes go through `sa_grant_root_access` / `sa_revoke_root_access` (service role only; the route is
`POST /api/security-access/root-access`). The database decides every change. Each change is serialized by one advisory
lock.

- **Actor:** an active Root Administrator only.
- **Self-service:** no self-grant and no self-revoke.
- **Last administrator:** the last active Root Administrator cannot be revoked. Two administrators revoking each other at
  the same moment cannot both succeed; this is tested with two concurrent sessions.
- **Target:** an active account with an active HQ membership (internal staff).
- **Reason:** 10–500 characters.
- **Expiry:** optional; at least 15 minutes ahead.
- **Confirmation:** the grant requires typing `GRANT ROOT ACCESS`.
- **Idempotency:** a request key makes a retry return the original grant.
- **Revocation:** ends Root Access only. Group Policies and all other access stay as they were.
- **Audit:** every change is recorded in `sa_access_change_log` with actor, target, time, reason and scope `global`:
  - `root_access.granted`, `root_access.revoked`, `root_access.expired`, `root_access.bootstrapped`
  - `root_access.grant_denied` and `root_access.revoke_denied`, for refused or unauthorized attempts, including forged
    actor ids.
- **API roles:** none can write the table, and `authenticated` / `anon` cannot read it. History rows are immutable,
  even for the owner.

## Rollout (manual)

1. Apply prerequisites, in order, if they are not yet applied in the environment: `20261009100000`, `20261011100000`,
   `20261024100000` (and whatever those require).
2. Apply `supabase/migrations/20261026100000_sa_root_access.sql` as the database owner. It is idempotent and safe to run
   statement by statement.
3. Bootstrap the first Root Administrator by hand, as the database owner, in the SQL editor. This works only while no
   active Root Administrator exists:
   ```sql
   select public.sa_bootstrap_root_access('<user uuid>', 'Initial Root Administrator approved by <who>, ticket <ref>');
   ```
   The target must be an active HQ staff account. Then grant at least one more Root Administrator from People & Access,
   so that one can revoke the other.
4. Release the application. The Root option appears only when the migration is present and the viewer is a Root
   Administrator. Before the migration is applied, the screen shows no Root option and no badges.
5. Keep running governance maintenance (`sa_governance_maintenance`); it records `root_access.expired`. The evaluator
   already ignores an expired grant at the moment it lapses.

**Recovery:** if the last Root Administrator's account is deactivated or their grant expires, there is no active Root
Administrator, so step 3 works again. Reactivating a deactivated account restores its unrevoked grant.

## Tests

- `supabase/tests/security/sa_root_access/run.sh <disposable sa_prof_test* database>` runs on a throwaway PostgreSQL 17
  with the REAL S&A migrations. It covers:
  - privileges, bootstrap, grant and revoke refusals, idempotency, and evaluation across modules and organizations
  - future and deprecated permissions, forged organizations, RLS gate and RPC backstop
  - legacy-mode no-escalation, directory and list scope, ceilings and target protection
  - immediate revocation (Group Policies kept), expiry and maintenance, immutability
  - a 588-cell regression grid for non-root users, concurrent mutual revocation, and deactivation with recovery bootstrap
- Vitest:
  - `lib/security-access/root-access.test.ts`: mode matrix, read model, migration lock-step
  - `app/api/security-access/root-access/route.test.ts`
  - `components/security-access/RootAccess.test.tsx`
  - `app/api/user/update-profile/route.root-protection.test.ts`
  - the Root target protection cases in `lib/actions.security.test.ts`
