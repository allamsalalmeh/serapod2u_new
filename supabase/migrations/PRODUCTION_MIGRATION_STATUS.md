# Production migration status

**Living document.** Update it in the same commit as every new migration, and again whenever a migration is applied to staging or production (see [How to update this file](#how-to-update-this-file)).

Last updated: **2026-10-02 00:45 MYT (+08:00)** — released: `origin/main` = `87873e58` (PR #64), deployed to production and healthy; staging = main.

Original full audit: 2026-10-01 15:07 MYT at `2961c21a` (read-only; every row below up to `20260930100000` comes from it unless the change log says otherwise).

This report records **database state**, not merely whether a file is present on a Git branch.

## Current pending list

| Order | Migration | Staging | Production |
|---|---|---|---|
| 1 | `20261003100000_hr_onboarding_state_and_data_reset.sql` | Pending | Pending |

**No migration is pending** on staging or production (verification query: the first nine `true` on both, 2026-10-02; the three `_sms` checks `true` on both, 2026-10-02 10:35).

## Executive result

- **Production pending:** none. `20260911120000`, `20260911130000`, `20260911140000` (notification-type SMS channels from the `sms-dynamic-enhancement` merge) were applied and verified on production 2026-10-02 10:35. All S&A migrations through `20261001140000` verified on production 2026-10-02 (nine `true`); the earlier owner-reported rows were confirmed by a direct read-only verification. `20260930100000`, `20261001100000` and `20261001120000` were applied to production on 2026-10-01 (reported by the owner; confirm with the verification query below — not yet independently re-read).
- **Partial, drifted, or unknown migrations requiring investigation:** none in the migration set below.
- Production and staging do **not** have a Supabase schema-migration ledger (`supabase_migrations.schema_migrations`) in the application database. `public.migration_history` is business data-import history and is not a schema ledger. Applied status therefore means that the migration's material effects, postconditions, or a later superseding definition were verified read-only.
- The two different files with version `20260928100000` were checked independently. Both sets of effects exist on both databases. The duplicate version remains an operational hazard for any filename/version-based runner and must not be “fixed” by renaming either file during this release.

## Database and deployment identity

| Environment | Verified host identity | Database identity | Deployed application revision |
|---|---|---|---|
| Production | KVM8, hostname `srv1871914`, container `serapod-prd-db` | database `supabase`, PostgreSQL 17.6 | image tag `1671bd79...`, matching `origin/main` (Stage 2D/restore application code not yet promoted to main) |
| Staging / localhost data | KVM2, hostname `mail`, container `serapod-stg-db` | database `supabase`, PostgreSQL 17.6 | staging image tag `b1b4c29c...` (verified 2026-10-01), matching `origin/staging` before the legacy-guest commit; localhost uses this same DB |

The initially tempting `postgres` database is not the application database. All object and invariant checks below were run against `supabase`, inside read-only transactions. No credentials, connection strings, private keys, or user-identifying result rows are recorded here.

## Status vocabulary and evidence

- **Verified applied:** the intended durable objects/invariants are present.
- **Verified applied; superseded:** the older migration ran functionally, but a later migration owns the current definition. The current end-state was checked; byte-for-byte equality to the older definition is neither expected nor required.
- **Verified pending:** required effects are absent and the later staging environment demonstrates the expected effects.
- **Partial/drifted/unknown:** some effects are absent/inconsistent, or evidence is insufficient.

Principal evidence used across the table:

- Current S&A foundation: `sa_permissions`, eleven governance/lifecycle tables, enforcement-readiness data, `sa_evaluate_permission`, scopes, modes, assignments, and audit data exist on both DBs.
- Storage boundary: private `documents` and `order-documents` buckets and five document storage policies exist on both DBs; no anonymous payment-request read policy remains.
- Audit survivability: audited user foreign keys targeted by the migrations are no longer delete-blocking; audit rows survive identity deletion.
- Identity closure: five identity columns, `identity_conflicts`, six core identity functions, four sync/guard triggers, three API guards, the canonical-staff marker, HR employment facts and two HR sync triggers exist on both DBs.
- Identity Stage 2 postconditions: archive/reactivation marker, identifier-sync function, two unique normalized identifier indexes, suspension-preservation definition, and zero unexplained email/phone drift on both DBs.
- Consumer reward ledger: idempotency table and both server-only functions exist; the unsafe consumer insert policy is absent on both DBs.
- Recent compatibility effects: online-shop warehouse column and supporting objects; Outdoor message table, SMS-template column, and allowed update-kind constraint exist on both DBs.
- Stage 2D: staging has all four expected function overloads/helpers and all thirteen permissions in `SHADOW`, with zero readable-organization/invariant mismatches. Production has zero Stage 2D functions and zero Stage 2D permissions.

## Migration-by-migration audit

| Version and canonical filename | Purpose | Staging | Production | Evidence / dependency / current-code note |
|---|---|---|---|---|
| `20260911120000_password_reset_otp_sms_channel.sql` | Offer SMS beside email for the consumer password-reset OTP | **Verified applied** (2026-10-02: `["email","sms"]`, sort 25) | **Verified applied** (2026-10-02 10:35, after row backup: `{email,sms}`, sort 25) | Upsert of one `notification_types` row; organization `notification_settings` are untouched, so delivery stays email until an administrator selects SMS. The application's `REQUIRED_NOTIFICATION_TYPES` upsert writes the same values. Idempotent. |
| `20260911130000_registration_otp_sms_channel.sql` | Offer SMS beside email for the consumer registration OTP | **Verified applied** (2026-10-02: `["email","sms"]`, sort 24) | **Verified applied** (2026-10-02 10:35: `{email,sms}`, sort 24; was sort 26) | As above; with SMS selected the account's email is not verified by the OTP (phone only). Idempotent. |
| `20260911140000_user_created_sms_channel.sql` | Offer SMS for User Account Created; `is_system=false`, sort 14 | **Verified applied** (2026-10-02: `["email","sms"]`, not system, sort 14) | **Verified applied** (2026-10-02 10:35: `{email,sms}`, not system, sort 14; was system, sort 10) | `is_system` only drives the "System" badge in Notification Types. Does not change `default_enabled`. Idempotent. |
| `20260926200000_phase0a_identity_containment.sql` | Contain direct identity/profile writes and establish guarded identity synchronization | Verified applied; superseded | Verified applied; superseded | Protected identity columns and current guard/sync triggers exist. Later Identity Foundation migrations intentionally replace parts of the original definitions. Prerequisite for Phase 0B and Identity Foundation. |
| `20260927100000_phase0b_privileged_rpc_containment.sql` | Restrict privileged RPC execution and classify browser/server/public callers | Verified applied; superseded | Verified applied; superseded | Current grants and server-authoritative paths reflect the containment end-state; later S&A and reward migrations replace selected functions. Must precede later S&A enforcement. |
| `20260927110000_phase0b_sensitive_tables_hr_rls.sql` | Close sensitive-table and HR/consumer RLS exposure | Verified applied; superseded | Verified applied; superseded | RLS/policy end-state and service-only sensitive paths are present; later migrations intentionally refine selected policies. |
| `20260927120000_phase0b_public_pii_ecommerce_qr.sql` | Remove public PII/QR mutation paths and constrain ecommerce/QR access | Verified applied; superseded | Verified applied; superseded | Unsafe anonymous paths checked by the containment contracts are absent; later customer/reward policies supersede selected definitions. |
| `20260927130000_phase0b_points_company_scope_fix.sql` | Correct points/redemption company scoping | Verified applied; superseded | Verified applied; superseded | Current server-authoritative reward path and company-scoped policies/functions incorporate this constraint. Must precede the secure reward ledger. |
| `20260927140000_sa_wave1_foundation.sql` | Create memberships, roles, permissions, assignments, scopes, modes, and authorization decisions | Verified applied | Verified applied | Foundation tables, RLS, modes, assignments, scopes, indexes, and evaluator are present. |
| `20260927150000_sa_wave1_readiness.sql` | Add guarded evaluation/readiness support and initial mode controls | Verified applied; superseded | Verified applied; superseded | Readiness catalogue and current mode-setting/evaluation definitions exist; final-wave migrations extend them. |
| `20260927160000_stock_count_session_integrity.sql` | Enforce stock-count session/posting integrity | Verified applied | Verified applied | Current stock-count enforcement is catalogued as S&A-ready and the related contract tests pass. This remains an earlier prerequisite rather than a pending S&A migration. |
| `20260928100000_sa_final_governance_foundation.sql` | Add governance, requests, delegations, reviews, SoD, service identities, grant/revoke APIs, and settings | Verified applied | Verified applied | Independently checked despite the version collision: eleven S&A governance/lifecycle tables and governance functions/settings are present. Grant/revoke and SoD definitions match the final-wave design. |
| `20260928100000_outdoor_product_shipping.sql` | Add Outdoor product shipping attributes and validation | Verified applied | Verified applied | Independently checked despite the version collision: all three product shipping columns and the validation constraint exist. |
| `20260928110000_sa_final_finance_hr_lifecycle.sql` | Add Finance/HR catalogue, lifecycle sync, derived memberships/assignments, and leaver handling | Verified applied; superseded | Verified applied; superseded | Lifecycle functions, HR facts, memberships, derived assignments, and invariants exist. Identity Stage 2 later replaces employment/archive/suspension behavior. |
| `20260928120000_sa_final_modules_supply_chain.sql` | Extend module permissions and supply-chain database backstops | Verified applied | Verified applied | Permission catalogue/readiness and route/API contract coverage include the supply-chain operations; current DB backstops exist. |
| `20260928130000_sa_final_legacy_retirement_support.sql` | Register enforcement readiness, retention, legacy retirement controls, and final-wave backstops | Verified applied | Verified applied | Readiness catalogue, retention/mode controls, and `legacy_authorization` setting exist. Production remains mostly legacy/shadow by policy; that is rollout state, not a missing migration. |
| `20260928150000_documents_payment_request_read_boundary.sql` | Close anonymous and cross-tenant payment-request document reads | Verified applied | Verified applied | Anonymous payment-request policy count is zero; tenant-authorized replacement behavior is present. |
| `20260928160000_sa_audit_history_survives_user_deletion.sql` | Preserve S&A audit/history when a user is deleted | Verified applied | Verified applied | Target audit foreign keys no longer block/delete history. |
| `20260928170000_documents_storage_private_boundary.sql` | Make document buckets private and tenant-authorized | Verified applied | Verified applied | Both buckets are private and five document storage policies exist. The stash copy differs from the tracked file only in comments, not executable SQL. |
| `20260928180000_legacy_signature_private_access.sql` | Preserve authorized legacy signature access after storage privatization | Verified applied | Verified applied | Current private storage policy set includes the legacy-signature compatibility path; later portable postcondition changes do not alter the access boundary. |
| `20260929100000_sa_decisions_history_survives_user_deletion.sql` | Preserve authorization-decision history after identity deletion | Verified applied | Verified applied | Decision/audit user references use history-preserving behavior; current decision logs are populated. |
| `20260929110000_identity_foundation.sql` | Establish canonical identity facts, principal type, resolver, conflicts, and protected provisioning APIs | Verified applied; superseded | Verified applied; superseded | Five identity columns, conflict table, core functions/triggers and API guards exist. Later Stage 1/2 migrations own current definitions. |
| `20260929120000_identity_protected_fields_guard.sql` | Guard protected identity/employment/access fields and define archive-vs-delete safety | Verified applied; superseded | Verified applied; superseded | Protected-field guard and reference classification are present; later HR-source migration refines the guard. |
| `20260929130000_consumer_reward_secure_ledger.sql` | Make consumer reward collection/redemption atomic, idempotent, and service-only | Verified applied | Verified applied | `consumer_reward_requests` plus two reward functions exist; unsafe reward insert policy count is zero. |
| `20260929140000_identity_stage1_closure.sql` | Close Stage 1 identity gaps, canonical staff, and consumer/enterprise separation | Verified applied; superseded | Verified applied; superseded | Canonical-staff marker and current resolver/guards exist. Production has zero consumer/store identities in active enterprise RBAC. Staging's three diagnostic hits are portal/internal identities with legacy `GUEST` codes, not store-scope consumers. |
| `20260929150000_identity_stage2_hr_employment_source.sql` | Make `hr_employees` authoritative for employment facts | Verified applied | Verified applied | Five HR employment columns and two sync triggers exist. Production has zero HR organization/scope mismatches; staging has two organization mismatches and one HR-linked non-portal user requiring staging-data review, not migration re-execution. |
| `20260929160000_identity_stage2_archive_keeps_identifiers.sql` | Preserve identifiers on archive and provide controlled reactivation | Verified applied | Verified applied | Archive/reactivation current definition marker is present on both DBs. |
| `20260929170000_identity_stage2_identifier_drift_sync.sql` | Align profile identifiers with login identifiers and record collisions/skips | Verified applied | Verified applied | Owner-only sync function exists. Exact migration postconditions report zero unexplained email drift and zero unexplained phone drift on both DBs; raw drift counters include allowed collision/unverified categories and are not evidence of failure. |
| `20260929180000_identity_stage2_identifier_uniqueness.sql` | Enforce normalized email and verified-phone uniqueness | Verified applied | Verified applied | Both expected unique indexes exist; verified duplicate-phone groups are zero. |
| `20260929190000_identity_stage2_suspension_preserves_access.sql` | Suspend assignments for restoration rather than permanently revoking them | Verified applied | Verified applied | Current lifecycle definition contains suspension-preservation behavior; lifecycle invariants are zero. |
| `20260929200000_storefront_online_shop_warehouse.sql` | Add the online-shop warehouse relationship and supporting objects | Verified applied | Verified applied | Warehouse column plus two supporting objects exist. Additive and compatible with current main/staging. |
| `20260929210000_outdoor_customer_message_settings.sql` | Add Outdoor customer-message settings | Verified applied | Verified applied | Settings table exists. |
| `20260929220000_outdoor_customer_sms_templates.sql` | Add Outdoor customer SMS template configuration | Verified applied | Verified applied | SMS-template column exists. |
| `20260929230000_outdoor_admin_updates_offer_kinds.sql` | Extend allowed Outdoor admin-update/offer kinds | Verified applied | Verified applied | Updated kind constraint exists. |
| `20260930100000_sa_stage2d_deferred_closure.sql` | Add readable-organization scope, actor dominance, thirteen deferred permissions/roles, and guarded backfill | **Verified applied** | **Verified applied** (2026-10-02 direct verification) | Staging: four expected function signatures/helpers, thirteen `SHADOW` permissions and holders, correct grants, zero readable-organization/invariant mismatches. Production was verified pending at the 15:07 audit and applied afterwards by the owner. Requires the S&A final wave and Identity Stage 2 through `20260929190000`. Keep all thirteen keys in `SHADOW`. |
| `20261001100000_sa_restore_overridden_automatic_access.sql` | Restore path for automatic/legacy access an administrator revoked (`sa_restore_assignment`, `sa_restorable_assignments`, `sa_assignment_overridden_source`; revoke records `previous_source`) | **Verified applied** (2026-10-01: three functions present, service_role-only execute, revoke definition records `previous_source`) | **Verified applied** (2026-10-02 direct verification) | Replica test `supabase/tests/security/sa_restore/restore_overridden_automatic_access.sql` (22 assertions; unpatched schema fails). Idempotent. Compatible with the older main application (only adds functions and extra audit detail). |
| `20261001120000_sa_remove_legacy_guest_compat_role.sql` | Delete the `legacy-guest` compatibility role and its assignments; `sa_refresh_compat_role` never (re)creates a role for `GUEST` | **Verified applied** (2026-10-01 20:20: verification query all `true`; one assignment removed and audited, `role.deleted` logged, zero GUEST identities holding a compatibility role) | **Verified applied** (2026-10-02 direct verification) | Replica test `supabase/tests/security/sa_restore/remove_legacy_guest_compat_role.sql` (15 assertions, includes the refusal path and a `read_only=false` production simulation); negative control: a plain delete is re-created by the next lifecycle sync. Refuses to run while an access request/review item references the role. GUEST identities lose `inventory.transfer.cancel` (already `NEW_ENFORCED` on staging). Idempotent. |
| `20261001130000_sa_grant_keeps_automatic_access.sql` | A grant/approval never takes over automatic access (`sa_role_already_held`); access requests for an already-held role are refused | **Verified applied** (2026-10-01 23:15: verification query all eight `true`) | **Verified applied** (2026-10-02, after backup) | Staging UAT bug: re-granting an automatically held role converted it into a temporary manual grant. Replica test `supabase/tests/security/sa_restore/grant_keeps_automatic_access.sql` (9 assertions; unpatched schema fails as negative control). Idempotent. Compatible with older application code (only adds an error for a case the new UI no longer offers). |
| `20261001140000_orders_approve_creator_only_rule.sql` | Order approval: creator can never approve; no approver-above-creator level comparison (S&A decides where enforced, legacy = Manager level or above) | **Verified applied** | **Verified applied** (2026-10-02; SECURITY DEFINER, search_path and grants unchanged) | Owner decision 2026-10-01. Patches the live `orders_approve` in place (one known line; refuses if absent; idempotent) because its body carries runtime-injected guard lines. Replica: applied twice, S&A guard and SECURITY DEFINER/grants kept, refuses an unexpected body. Staging: verified applied 2026-10-01 (verification query nine `true`). Production precondition verified read-only 2026-10-02 00:10 (expected line, S&A guard, maker-checker present). Ship with the matching Orders screen change. |
| `20261003100000_hr_onboarding_state_and_data_reset.sql` | HR onboarding state on `hr_employees` (owned by HR onboarding functions; automatic anchors start `pending`), Add Employee onboarding functions, operational guard (no new attendance/leave/payroll rows for employees awaiting onboarding), HR pre-go-live state, `hr.data.reset` (SHADOW; DB always requires Super Admin + explicit grant), allowlisted reset with preview token, idempotency key, snapshot and permanent audit | **Pending** | **Pending** | Legacy rule: every existing `hr_employees` row becomes `completed` / `legacy_backfill` (HR lists unchanged; no mass reset); `hire_date_confirmed = false`. Seeds `pre_go_live` for organizations with employment records. Replica-tested (isolated PG 17.6 fixture: `supabase/tests/security/hr_onboarding_reset`, 89 checks; applied twice). Apply before deploying the matching HR application change (the HR people list falls back to the old query if the columns are missing). Executes no reset. |

## Applying a pending migration

Apply nothing merely because it is absent from a history table (there is no schema ledger). For each pending migration:

1. Re-run read-only prerequisite/invariant diagnostics on the target database.
2. Use the canonical file at the approved release SHA; never the stash or a copy beside the canonical migrations.
3. Take the normal backup/rollback precautions and capture before/after evidence.
4. Apply staging first, then production, as one transaction (`psql -v ON_ERROR_STOP=1 --single-transaction`), or paste the whole file in one SQL-editor run (files avoid session temp tables for that reason).
5. Run the verification query below, then update this file.

### Verification query (read-only; run on staging or production)

```sql
select 'stage2d_readable_orgs' as check, exists (select 1 from pg_proc where proname = 'sa_readable_organizations') as ok
union all select 'stage2d_dominance', exists (select 1 from pg_proc where proname = 'sa_actor_dominates')
union all select 'restore_fn', exists (select 1 from pg_proc where proname = 'sa_restore_assignment')
union all select 'restore_fn_service_only', not has_function_privilege('authenticated', 'public.sa_restore_assignment(uuid,uuid,text)', 'execute')
union all select 'revoke_records_previous_source', pg_get_functiondef('public.sa_revoke_assignment'::regproc) like '%previous_source%'
union all select 'legacy_guest_removed', not exists (select 1 from public.sa_business_roles where role_key = 'legacy-guest')
union all select 'guest_refresh_guard', pg_get_functiondef('public.sa_refresh_compat_role'::regproc) like '%GUEST carries no authority%'
union all select 'grant_keeps_automatic', pg_get_functiondef('public.sa_create_assignment_internal'::regproc) like '%sa_role_already_held%'
union all select 'orders_creator_only_rule', pg_get_functiondef('public.orders_approve(uuid)'::regprocedure) like '%approval-rule:creator-only%'
union all select 'password_reset_otp_sms', exists (select 1 from public.notification_types where event_code = 'password_reset_otp' and 'sms' = any(available_channels))
union all select 'registration_otp_sms', exists (select 1 from public.notification_types where event_code = 'registration_otp' and 'sms' = any(available_channels))
union all select 'user_created_sms', exists (select 1 from public.notification_types where event_code = 'user_created' and 'sms' = any(available_channels) and is_system = false);
```

All rows must be `true` once every migration listed here is applied (`grant_keeps_automatic` stays `false` until `20261001130000`; the three `_sms` rows stay `false` until `20260911120000`–`20260911140000`).

## Partial, drifted, or unknown requiring investigation

**No migration in the audited set is classified partial, drifted, or unknown.** The following are data/readiness findings, not missing migrations:

- Staging has two `hr_employees` organization mismatches and one HR-linked non-portal identity.
- Staging has three portal/internal identities with legacy role code `GUEST` carrying active RBAC; two are derived-only QA identities and `allam@serapod.com` also has a manual `security-administrator` assignment ("just for test", granted 2026-09-28). Owner approved revoking it on 2026-10-01; **still active at 20:04 MYT**. `20261001120000` removes their `legacy-guest` compatibility role. Production has none.
- Staging Stage 2D evidence is insufficient for enforcement: eleven of thirteen keys had no observed decisions in the reviewed 48-hour window. `platform.notification_monitor.view` has 209 historical `LEGACY_ALLOW_NEW_DENY` decisions (last seen 2026-09-29 17:05 MYT), and `ecommerce.outdoor.operate` has five (last seen 2026-09-29 19:22 MYT), followed by four matching allows and one matching deny for Outdoor. These modes should remain `SHADOW` pending representative UAT and a clean agreed observation window.
- ~~Three `inventory.report.view` `MISSING_CONTEXT` decisions while `NEW_ENFORCED`~~ — **fixed** in `86b1429e` (default guard now gives warehouse-organization members warehouse context; application change, no migration). Zero `MISSING_CONTEXT` decisions since deployment.

## Stash and rerun considerations

The single stash contains thirteen migration files from `20260928150000` through `20260929190000` (excluding `20260929140000`). Twelve are byte-identical to the tracked staging files. `20260928170000_documents_storage_private_boundary.sql` differs only in comments. The stash is therefore preservation evidence, **not** a migration source and not safe to drop until the user authorizes cleanup.

Rerunning older files is unsafe without a migration-specific review even when they contain `IF EXISTS`/`IF NOT EXISTS`: several migrations change policies, grants, triggers, function bodies, modes, or data backfills. Later definitions intentionally supersede earlier ones, and the missing ledger cannot prove execution order. In particular:

- never execute either `20260928100000` file based solely on the duplicate version ambiguity;
- do not rerun identity drift/backfill migrations to “repair history”;
- do not treat a current function-definition difference as evidence that its earlier migration is missing;
- do not insert synthetic rows into a schema-history table as part of this assessment.

## Report/tooling safety

The repository's `.gitignore` explicitly re-includes `supabase/migrations/**/*.md`, so this report is versionable (it is **not** silently ignored by Git). Supabase migration discovery and the repository's migration references target `.sql` files; this `.md` file is not runnable migration input. No copied runnable SQL was placed beside the canonical migrations.

## How to update this file

- **New migration:** in the same commit, add a row to the audit table and to *Current pending list* (Staging/Production = Pending), with its replica test and any ordering dependency.
- **Applied:** change the cell to `Verified applied` (with the date and the evidence you read) or `Applied <date> (owner-reported)` when someone else ran it; remove it from *Current pending list*; add a change-log line.
- **Verification:** extend the verification query with one boolean per new migration.
- Never record credentials, connection strings or user-identifying rows here.

## Change log

| Date (MYT) | Change |
|---|---|
| 2026-10-01 15:07 | Full read-only audit at `2961c21a`: production pending exactly `20260930100000`. |
| 2026-10-01 ~15:30 | `origin/staging` → `6cdcf81e` (main→staging ancestry merge, tree unchanged) → `b1b4c29c` (warehouse context fix + restore feature). Added `20261001100000`. |
| 2026-10-01 afternoon | Owner applied `20261001100000` to staging (verified 20:04: functions, grants, revoke definition) and `20260930100000` + `20261001100000` to production (owner-reported). |
| 2026-10-01 20:10 | Added `20261001120000_sa_remove_legacy_guest_compat_role.sql` (owner request: delete `legacy-guest`). Pending on both. |
| 2026-10-01 20:20 | Owner applied `20261001120000` to staging; verified (all seven checks `true`). |
| 2026-10-01 20:45 | Owner applied `20261001120000` to production (owner-reported). Nothing pending on either database. |
| 2026-10-01 22:40 | Added `20261001130000_sa_grant_keeps_automatic_access.sql` (UAT fix). Pending on both. |
| 2026-10-01 23:15 | Owner applied `20261001130000` to staging; verified (eight checks `true`). Production pending. |
| 2026-10-02 00:40 | **Production release.** Backup `/root/backups/serapod-prd-pre-sa-release-20261001-1540.dump` (KVM8, 137 MB, 409 tables). Applied `20261001130000`, `20261001140000`; verification nine `true`. HR/Finance cleanup on production: 1 GL journal, 3 lines, 1 posting removed (staging already clean). PR #64 merged (`main` = `87873e58`), production deployed and healthy. |
| 2026-10-02 00:10 | Production read-only (direct): seven checks `true`; `orders_approve` precondition holds; 111 SHADOW / 3 LEGACY_ENFORCED, legacy not locked; 54 active portal users all with membership + compatibility role; HR/Finance real-use signals all 0 (cleanup would remove 1 GL journal, 3 lines, 1 posting). Staging: `20261001140000` verified (nine `true`). |
| 2026-10-03 | Added `20261003100000_hr_onboarding_state_and_data_reset.sql` (HR onboarding state + pre-go-live HR Data Management). Pending on both. No reset executed anywhere. |
| 2026-10-02 10:35 | Production: backed up the three `notification_types` rows (`/root/backups/notification_types-pre-sms-channels-20261002-0228.csv`, KVM8), applied `20260911120000`–`20260911140000` in one transaction; three `_sms` checks `true`. Organization `notification_settings` unchanged (password reset and registration stay email). |
| 2026-10-02 10:30 | Merged `sms-dynamic-enhancement` into staging: added `20260911120000`, `20260911130000`, `20260911140000` (notification-type rows only). Staging already has all three (read 2026-10-02); production pending. Verification query extended with three `_sms` checks. |
| 2026-10-01 23:45 | Added `20261001140000_orders_approve_creator_only_rule.sql` (owner decision). Pending on both. Data scripts (not migrations): `supabase/diagnostics/hr_finance_inventory_readonly.sql`, `supabase/operations/hr_finance_test_data_cleanup.sql`. |
