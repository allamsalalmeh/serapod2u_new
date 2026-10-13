# Group Policies, module Full Access policies and delegated S&A administration

Branch: `issues-fixing-oct2`. Migration (left **unapplied**, requires `20261005110000_sa_access_profiles.sql`):
`supabase/migrations/20261009100000_sa_group_policies_full_access.sql`.

## 1. Terminology

"Access Profile" is now **Group Policy** everywhere a person reads it (Security & Access, Add User, the grant form,
holders, dialogs, access requests, error messages). Internals are unchanged: a Group Policy is still a business role
(`sa_business_roles`), the API is still `/api/security-access/profiles`, `ProfileSummary`, `sa_*_access_profile` functions.
There is no second authorization engine.

## 2. Standard Full Access policies

One protected standard policy (`source = 'template'`, copy-only, internal accounts only) per top-level business module of
the shared taxonomy. Each holds **every registered permission of the module as an explicit key** (no wildcard, no
inheritance), including cancel / reverse / adjustment / delete / reset / override permissions.

| Policy (`role_key`) | Permissions | Sensitive (post-creation assignment only) |
|---|---|---|
| Supply Chain Full Access (`supply-chain-full-access`) | **30** | no — assignable at user creation |
| Customer & Growth Full Access (`customer-growth-full-access`) | **23** | no — assignable at user creation |
| HR & Payroll Full Access (`hr-payroll-full-access`) | **26** (incl. `hr.data.reset`) | yes |
| Finance Full Access (`finance-full-access`) | **13** (incl. `finance.payment.approve`, `finance.data.reset`) | yes |
| Security & Access Full Access (`security-access-full-access`) | **12** (every `security.*`) | yes |
| Platform & Settings Full Access (`platform-settings-full-access`) | **10** (incl. `platform.data.destructive`, `platform.identity.delete`) | yes |

Total 114 of the 115 registered permissions; `reporting.analytics.view` is a single shared analytics permission, not a
module, so it has no Full Access policy (assign it through a custom policy).

Existing policies were inspected and kept: none is module-complete (`security-administrator` has 10 of 12 S&A
permissions — no `security.access_review.manage` / `security.emergency_access.grant`; `finance-admin` has 11 of 13 — no
payment approval / data reset; `hr-manager` 16 of 26; `warehouse-*`, `qr-batch-operator`, … are narrower by design).
They are untouched and shown under "Narrower policies".

Seeding: explicit reviewed lists, fails loudly if a key is not registered (never silently omits), refuses a pre-existing
non-standard role with the same key, **never** modifies, expands or re-records a policy that already exists, assigns
nobody, changes no mode. Coverage is recorded in `sa_standard_policy_coverage`. Permissions registered later are **not**
added: `sa_standard_policy_drift()` reports them (shown in Group Policies as "N newer permission(s) not included") and the
owner-only `sa_extend_standard_policy(role_key, keys[], reason)` (not granted to any API role; used from a reviewed
migration) adds explicit keys with a reason, a module check, a holder-SoD check and one audit row per holder.

### What "Full Access" does not do
It does not bypass backend rules. Verified by tests: scope is required (`sa_scope_required`), the policy is internal-only
(`sa_profile_not_applicable` for a manufacturer organization), self-assignment is refused, SoD is evaluated, membership /
HR / ESS are never created, `hr.data.reset` still needs the central Super Admin as well (untouched,
`hr_reset_requires_super_admin`), emergency access stays unavailable until MFA exists, and operation guards such as the
order maker/checker rule stay at the operation.

### Exact conflicts / limits to know before assigning
1. **Add User**: HR, Finance, Security & Access and Platform & Settings Full Access contain security, reset or destructive
   permissions, so the existing provisioning rule (`sa_profile_sensitive_not_initial`) refuses them at creation. They are
   assigned afterwards in Security & Access → People & Access (the Add User picker now says so and lists them). Supply Chain
   and Customer & Growth Full Access are offered in Add User.
2. **SoD**: `payroll-prepare-release` (`hr.payroll.prepare` vs `hr.payroll.release`, currently *monitor*) overlaps inside
   HR Full Access: it assigns today and records an `allowed_monitor` row on every assignment; if an administrator switches
   that rule to *enforce*, HR Full Access is refused with `sod_violation: payroll-prepare-release` until a mitigation exists.
   `security-admin-vs-payment-approval` (monitor) applies to anyone holding S&A and Finance Full Access together. The
   same-document rules (order maker/checker = enforce) apply per transaction.
3. **Sidebar/module visibility** for modules other than S&A is unchanged: it still follows the legacy role rule until the
   permissions of that module are moved to a new-model mode (existing mode semantics). Assigning a Full Access policy
   grants the explicit permissions to the S&A engine; it does not by itself reveal a menu entry that the legacy rule hides.
4. Not assigned to anyone, and not applied to staging or production.

## 3. Security & Access as its own group

`modules.ts` now has **Security & Access** (`security_access`, every `security.*`) and **Platform & Settings**
(`platform_settings`, every `platform.*`), replacing "Platform & Security". Areas under Security & Access: Access
Administration, Migration Modes, Security Governance, Review & Audit, Technical Access. All consumers read the one taxonomy
(Group Policies, Migration Modes, Permission Catalogue, selectors, decision log, service identities). Permission keys are
unchanged. Bulk-mode group ids are request-time ids only; the old `platform_security[/area]` id still resolves to exactly
its previous permission boundary (`resolveGroup` alias) for open pages and recorded batch history. The Notification Types
page keeps one section for its four categories, now named Platform & Settings.

## 4. Delegated (non-level-1) Security & Access administration

### Gate inventory (everything that decided "level 1 only")
| Layer | Gate | Change |
|---|---|---|
| Sidebar `Sidebar.tsx` | menu rule `allowedOrgTypes: HQ` + legacy `manage_authorization` | explicit holder of `security.access.view` is shown the entry (`useSaExplicitAccess`: S&A ALLOW and (enforced or delegation on)); backend still decides |
| Page `app/security-access/_lib.ts` | `security.access.view` with legacy evaluator `manage_authorization` | evaluator = `legacyOrDelegatedSecurityAccess` |
| API routes `requireSecurityActor` / `actorAlsoHolds` (every S&A administration route) | same legacy evaluator while the mode is legacy | same evaluator |
| Add User `listInitialAccessRoles` | `security.role.assign` with legacy evaluator | same evaluator |
| DB `sa_assert_actor_permission` (role assign/revoke, scope, access request, delegation, review, policy, modes, profile manager) | while a `security.*` mode is legacy: `sa_legacy_is_super_admin` (level 1) only | additionally allows an explicit in-scope assignment when `security_access.delegated_administration` = true; empty context now means the actor's own organization (the 20261008 fix, for every security.* check) |
| DB `sa_authorized_organizations` (directory) | level 1 sees all, everyone else none while legacy | with the setting on, descendants-or-self of the actor's authorized memberships |
| Left as is | `hr.data.reset` (level 1 **and** explicit permission), `platform.identity.delete` / archive (level 1), `legacy_authorization`, `platform.user.manage` for creating the person | untouched |

The setting `security_access.delegated_administration` is seeded **false**: until it is switched on nothing changes for
anyone. It only widens a legacy evaluator (a union): level-1 behaviour is identical in both states (tested).

### Bounds on a delegated administrator (database triggers; level 1 is unchanged)
* Real actor on every grant (`updated_by` / `created_by`), audit rows name them. Self-assignment, self-approval, SoD,
  membership, applicability and the bulk-mode lockout guard run exactly as before (all re-tested).
* A role containing a **sensitive** permission (`security.*`, `hr.data.reset`, `finance.data.reset`,
  `platform.data.destructive`) can be granted only if the actor holds that permission in the target organization
  (`sa_grant_beyond_authority`). So a delegated S&A administrator can grant Security & Access Full Access onward but can
  never grant HR / Finance / Platform Full Access, or anything with a reset, unless they hold it. Non-sensitive policies
  are grantable inside the actor's own authority (organization subtree) as before.
* Every scope must lie in an organization where the actor holds the grant authority; organization-independent typed scopes
  (territory, campaign) stay level-1 only (`sa_grant_scope_beyond_authority`).
* A custom policy can contain a sensitive permission only if the actor holds it (`sa_profile_beyond_authority`), on the
  draft, the direct role editor and on publication.

### Blockers and exact rollout steps for non-level-1 administration (nothing here was done)
Blockers: (a) the setting is off; (b) the first Security & Access Full Access assignment has to be made by a level-1
administrator (an administrator cannot grant to themselves and cannot grant a sensitive policy they do not hold);
(c) the person needs an active business membership and a scope (HQ organization scope for HQ-wide administration);
(d) organization-independent scopes, HR reset, identity delete remain level 1; (e) creating the *person* (Add User) still
needs `platform.user.manage`, which is outside S&A.

1. Review and apply `20261009100000_sa_group_policies_full_access.sql` to **staging** (after the earlier S&A migrations).
   Check `select * from sa_standard_policy_drift();` is empty and the counts above hold.
2. As level 1: People & Access → grant **Security & Access Full Access** to the intended administrator, HQ membership,
   HQ organization scope (a narrower scope limits them to that subtree).
3. Switch the setting on (reviewed, audited statement, staging first):
   `update sa_settings set setting_value = 'true'::jsonb where setting_key = 'security_access.delegated_administration';`
   (Alternative without the setting: move each `security.*` permission to NEW_ENFORCED/LEGACY_RETIRED in Migration Modes
   once it is enforcement-ready — the existing path; then the new model already decides.)
4. As the delegated administrator: the Security & Access entry appears; confirm People & Access shows only authorized
   organizations, a grant in scope works, a grant of HR/Finance Full Access is refused, a grant outside scope is refused.
5. Roll back by setting the value back to `'false'` (instant); the level-1 path is unaffected.

## 5. Tests

* Isolated SQL (`supabase/tests/security/sa_group_policies/run.sh <sa_prof_test* DB url>`; real S&A migrations on stand-in
  tables, throwaway PG17; `supabase/tests/` is gitignored — force-add): coverage and module boundaries, sensitive
  permissions retained, protection, Copy & Customize, scoped assignment, applicability/provisioning, SoD, idempotency
  (second run + removed permission not re-added + key conflict refused), future catalogue additions, extension function,
  non-level-1 administration (flag off vs on), grant/scope/profile bounds, self-grant, SoD, access-request approval,
  lockout, legacy admin unchanged. The existing `sa_profiles` and `sa_mode_actor_ctx` suites also pass with the new
  migration applied.
* Vitest: `group-policies`, `delegation`, `useSaExplicitAccess`, `GroupPolicyFullAccess`, Add User policies, selector note,
  taxonomy / rollout / notification updates, coverage audit (parses the Full Access seed).
