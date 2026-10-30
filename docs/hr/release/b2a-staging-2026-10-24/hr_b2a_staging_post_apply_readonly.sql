-- ============================================================================
-- Serapod2U HR — B2A post-apply verification (READ-ONLY, owner-run, STAGING)
-- Target migration: supabase/migrations/20261219100000_hr_leave_containment_guard.sql
--   repo file sha256 caace5b1f35bbf946fec011c9eea7befe24769c1e8556bc986d5c8b7a2888a6d (Enhancement03 @ b6b78002, untracked)
-- Prepared 2026-10-24. Not part of the repository (verification-only task).
--
-- HOW TO RUN (psql only; as the database owner / a BYPASSRLS role so counts are not hidden by RLS):
--   psql "<STAGING connection>" -X -v env=staging -v ON_ERROR_STOP=0 \
--        -f hr_b2a_staging_post_apply_readonly.sql > b2a_staging_post_apply.txt 2>&1
--
-- SAFETY
--   * One READ ONLY transaction, ended with ROLLBACK; ON_ERROR_ROLLBACK isolates each statement.
--   * No CREATE/ALTER/INSERT/UPDATE/DELETE, no temp tables, no SET ROLE, no JWT/user impersonation.
--   * Application functions called: ONLY public.sa_evaluate_permission_core (STABLE; pure SELECTs in the
--     2026-10-16 snapshot) and public.sa_org_ancestry, in sections F/G, to measure who CAN approve.
--     The read-only transaction makes any unexpected write fail instead of happening.
--   * Output: catalog facts, hashes and aggregate counts per organization id. No names, emails, reasons.
-- ============================================================================
\set QUIET on
\set ON_ERROR_ROLLBACK on
\pset footer off
\if :{?env}
\else
  \echo 'ABORT: pass -v env=staging'
  \quit
\endif

begin transaction read only;
set local statement_timeout = '120s';
set local lock_timeout = '3s';

\echo '=== 0. ENVIRONMENT / ROLE ==='
select :'env' as declared_env, current_database() as db, now() as checked_at, inet_server_addr() as server_addr,
       split_part(version(), ' on ', 1) as server_version;
select (select count(*) from public.organizations) as organizations, (select count(*) from public.users) as users;
select current_user as role, r.rolsuper, r.rolbypassrls, current_setting('transaction_read_only') as read_only
from pg_roles r where r.rolname = current_user;
-- Manual psql application normally leaves no row here (expected: false); recorded for completeness.
select exists (select 1 from supabase_migrations.schema_migrations where version = '20261219100000') as recorded_in_schema_migrations;

\echo '=== A. FUNCTIONS: presence, security, config, owner, body hash vs repository ==='
select e.fn, e.args,
       p.oid is not null                                   as present,
       p.prosecdef                                         as security_definer,
       e.expect_definer,
       p.provolatile                                       as volatility,
       p.proconfig                                         as config,
       pg_get_userbyid(p.proowner)                         as owner,
       md5(p.prosrc)                                       as body_md5,
       e.expected_md5,
       md5(p.prosrc) = e.expected_md5                      as body_matches_repo
from (values
  ('hr_leave_actor_has_explicit',   'p_permission text, p_context jsonb',                 true,  '7bcb926cf2e33c0925e968332c5b3019'),
  ('hr_leave_hr_authority',         'p_org uuid',                                         true,  '359155ef9ca66b8cc6bc561ab0e81c35'),
  ('hr_leave_manager_authority',    'p_org uuid, p_employee uuid, p_permission text',     true,  '0441753761e0b23f096fda94443a5859'),
  ('hr_leave_can_view',             'p_org uuid, p_employee uuid',                        true,  '1d1a1a077de99de78e38c028fca7d928'),
  ('hr_leave_can_decide',           'p_org uuid, p_employee uuid',                        true,  '3677e218d208dfb2e16958fad1840665'),
  ('hr_leave_decider_authority',    'p_org uuid, p_employee uuid',                        true,  'f0b4b62b36825afab0d59212e4a14792'),
  ('hr_leave_requests_guard',       '',                                                   false, '4c948c9011fc260123828364bdfed6ce'),
  ('hr_leave_requests_record_event','',                                                   true,  'c99dd26b7143be57698eef8595471f17'),
  ('hr_leave_containment_review',   'p_org uuid',                                         true,  '97f36a074dcf1f97e01b0c9c630a3d43')
) as e(fn, args, expect_definer, expected_md5)
left join pg_proc p on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
                   and pg_get_function_arguments(p.oid) = e.args
order by e.fn;
-- body_matches_repo = false on hr_leave_actor_has_explicit only => the header SAFE ROLLBACK is in place.
-- Any other false => staging runs a different version of the file than the repository.

\echo '=== B. FUNCTION EXECUTE GRANTS (expected: helpers+review: anon=f, authenticated=t, service_role=t; guard/recorder: all f) ==='
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_grant
from pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('hr_leave_actor_has_explicit','hr_leave_hr_authority','hr_leave_manager_authority','hr_leave_can_view',
                    'hr_leave_can_decide','hr_leave_decider_authority','hr_leave_requests_guard',
                    'hr_leave_requests_record_event','hr_leave_containment_review')
order by 1;

\echo '=== C. TRIGGERS on leave tables and events table (expected tgenabled = O) ==='
select tgrelid::regclass as tbl, tgname, tgenabled, tgfoid::regproc as fn,
       case when (tgtype & 2) = 2 then 'BEFORE' else 'AFTER' end as timing,
       (tgtype & 4) = 4 as on_insert, (tgtype & 16) = 16 as on_update, (tgtype & 8) = 8 as on_delete, (tgtype & 32) = 32 as on_truncate
from pg_trigger
where not tgisinternal and tgrelid in ('public.hr_leave_requests'::regclass, 'public.hr_leave_approvals'::regclass,
                                       'public.hr_leave_balances'::regclass, 'public.hr_leave_request_events'::regclass)
order by 1, 2;
select current_setting('session_replication_role') as session_replication_role;   -- 'origin' expected (replica would skip triggers)

\echo '=== D. RLS: table flags and every policy on the three leave tables (expected: exactly 6 *_b2a_* policies) ==='
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c where c.relnamespace = 'public'::regnamespace
  and c.relname in ('hr_leave_requests','hr_leave_approvals','hr_leave_balances','hr_leave_types','hr_leave_request_events')
order by 1;
select tablename, policyname, cmd, permissive, roles, qual, with_check
from pg_policies where schemaname = 'public'
  and tablename in ('hr_leave_requests','hr_leave_approvals','hr_leave_balances','hr_leave_request_events')
order by tablename, cmd, policyname;
select count(*) filter (where policyname like '%\_b2a\_%') as b2a_policies,
       count(*) filter (where policyname not like '%\_b2a\_%') as other_policies
from pg_policies where schemaname = 'public' and tablename in ('hr_leave_requests','hr_leave_approvals','hr_leave_balances');
-- table-level grants (RLS still decides; DELETE has no policy so it is refused)
select t.tbl,
       has_table_privilege('anon', t.tbl, 'SELECT') as anon_select,
       has_table_privilege('authenticated', t.tbl, 'SELECT') as auth_select,
       has_table_privilege('authenticated', t.tbl, 'INSERT') as auth_insert,
       has_table_privilege('authenticated', t.tbl, 'UPDATE') as auth_update,
       has_table_privilege('authenticated', t.tbl, 'DELETE') as auth_delete,
       has_table_privilege('service_role', t.tbl, 'SELECT') as svc_select
from (values ('public.hr_leave_requests'), ('public.hr_leave_approvals'), ('public.hr_leave_balances'),
             ('public.hr_leave_request_events')) t(tbl);
-- expected for hr_leave_request_events: every column false (no API grants)

\echo '=== E. AUDIT TABLE, CONSTRAINTS, RESET SCOPE ==='
select a.attname, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull
from pg_attribute a where a.attrelid = 'public.hr_leave_request_events'::regclass and a.attnum > 0 and not a.attisdropped
order by a.attnum;
select conname, contype, pg_get_constraintdef(oid) as def
from pg_constraint where conrelid = 'public.hr_leave_request_events'::regclass order by 1;     -- expect pk + 2 checks, no 'f'
select conname, pg_get_constraintdef(oid) as def
from pg_constraint where conrelid = 'public.hr_leave_requests'::regclass and contype = 'c';    -- expect NO hr_leave_requests_status_chk
select * from public.hr_reset_scope where table_name like 'hr\_leave%' order by table_name;   -- expect events row: not_in_scope / keep
select authority, action, count(*) as events, min(occurred_at) as first_at, max(occurred_at) as last_at
from public.hr_leave_request_events group by 1, 2 order by 1, 2;                               -- any row = live writes since apply

\echo '=== E2. IDENTITY COMPATIBILITY MARKERS ==='
select p.proname, pg_get_functiondef(p.oid) like '%hr_leave_request_events%' as mentions_events_table
from pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('identity_deletion_plan','hr_employee_registration_plan','hr_reset_plan') order by 1;
-- person-column scan used by identity deletion (regex copied from 20261216100000); expected: 0 rows for the events table
select a.attname from pg_attribute a
where a.attrelid = 'public.hr_leave_request_events'::regclass and a.attnum > 0 and not a.attisdropped
  and a.atttypid = 'uuid'::regtype
  and (a.attname ~ '(user_id|_by|actor_id|employee_id|employment_id|_user)$' or a.attname in ('consumer_id','owner_id'));

\echo '=== F. AUTHORIZATION INVENTORY (counts only) ==='
select permission_key, status from public.sa_permissions
where permission_key in ('hr.leave.approve','hr.mss.leave_approve','hr.mss.leave_view') order by 1;
select p.permission_key,
       count(distinct a.user_id) filter (where b.source = 'legacy')  as holders_legacy_compat,
       count(distinct a.user_id) filter (where b.source <> 'legacy') as holders_explicit,
       count(distinct a.user_id) filter (where b.source = 'legacy' and not exists (
         select 1 from public.sa_role_assignments a2
         join public.sa_business_roles b2 on b2.id = a2.role_id and b2.status = 'active' and b2.source <> 'legacy'
         join public.sa_business_role_permissions rp2 on rp2.role_id = b2.id
         where a2.user_id = a.user_id and a2.status = 'active' and rp2.permission_id = p.id
           and (a2.effective_until is null or a2.effective_until > now()))) as holders_legacy_only
from public.sa_role_assignments a
join public.sa_business_roles b on b.id = a.role_id and b.status = 'active'
join public.sa_business_role_permissions rp on rp.role_id = b.id
join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active'
where a.status = 'active' and (a.effective_until is null or a.effective_until > now())
  and p.permission_key in ('hr.leave.approve','hr.mss.leave_approve','hr.mss.leave_view')
group by p.permission_key order by 1;
select count(*) as active_root_access_grants from public.sa_root_access_grants
where status = 'active' and (effective_until is null or effective_until > now());
-- explicit assignments of the standard policies named in the staging plan (S2)
select b.role_key, b.source, count(distinct a.user_id) as active_holders
from public.sa_business_roles b
left join public.sa_role_assignments a on a.role_id = b.id and a.status = 'active'
  and (a.effective_until is null or a.effective_until > now())
where b.role_key in ('hr-leave-attendance-administrator','hr-payroll-full-access','manager-self-service')
group by b.role_key, b.source order by 1;

\echo '=== G. EFFECTIVE B2A AUTHORITY PER ORGANIZATION (strict = B2A rule; any = what a legacy-counting rule would allow) ==='
-- G1. HR approvers per organization that has leave data
with orgs as (select distinct organization_id as org from public.hr_leave_requests
              union select distinct organization_id from public.hr_employees where onboarding_status = 'completed'),
cand as (select distinct a.user_id from public.sa_role_assignments a
         join public.sa_business_roles b on b.id = a.role_id and b.status = 'active'
         join public.sa_business_role_permissions rp on rp.role_id = b.id
         join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active' and p.permission_key = 'hr.leave.approve'
         where a.status = 'active' and (a.effective_until is null or a.effective_until > now())
         union select g.user_id from public.sa_root_access_grants g
         where g.status = 'active' and (g.effective_until is null or g.effective_until > now())),
ev as (select o.org, c.user_id,
              public.sa_evaluate_permission_core(c.user_id, 'hr.leave.approve', jsonb_build_object('organization_id', o.org), false, false) as v
       from orgs o cross join cand c
       join public.users u on u.id = c.user_id and u.is_active is true and coalesce(u.account_status, 'ACTIVE') <> 'ARCHIVED')
select org,
       count(*) filter (where v->>'decision' = 'ALLOW') as hr_any,
       count(*) filter (where v->>'reason_code' = 'ALLOWED_BY_ROOT_ACCESS') as hr_root,
       count(*) filter (where v->>'reason_code' = 'ALLOWED_BY_ASSIGNMENT' and exists (
         select 1 from jsonb_array_elements(coalesce(v->'matched_assignments','[]'::jsonb)) m
         join public.sa_business_roles br on br.id = nullif(m->>'roleId','')::uuid
         where br.status = 'active' and br.source <> 'legacy')) as hr_explicit_non_root
from ev group by org order by org;

-- G2. Reporting lines and manager MSS authority (one row per employee with a manager), aggregated per organization
with lines as (
  select e.organization_id as org, e.user_id as emp, e.manager_user_id as mgr
  from public.hr_employees e
  where e.onboarding_status = 'completed' and e.manager_user_id is not null and e.manager_user_id <> e.user_id),
chk as (
  select l.*,
         exists (select 1 from public.users m where m.id = l.mgr and m.is_active is true
                 and coalesce(m.account_status,'ACTIVE') <> 'ARCHIVED') as mgr_active,
         exists (select 1 from public.hr_employees me where me.user_id = l.mgr and me.onboarding_status = 'completed'
                 and me.organization_id = any(public.sa_org_ancestry(l.org))) as mgr_onboarded_in_tree,
         public.sa_evaluate_permission_core(l.mgr, 'hr.mss.leave_approve',
           jsonb_build_object('organization_id', l.org, 'owner_user_id', l.emp), false, false) as v
  from lines l)
select org,
       (select count(*) from public.hr_employees x where x.organization_id = c.org and x.onboarding_status = 'completed') as onboarded_employees,
       count(*) as employees_with_manager,
       count(distinct mgr) as managers,
       count(*) filter (where not mgr_active) as manager_inactive_or_archived,
       count(*) filter (where not mgr_onboarded_in_tree) as manager_not_onboarded_in_tree,
       count(*) filter (where v->>'decision' = 'ALLOW') as mss_approve_any,
       count(*) filter (where mgr_active and mgr_onboarded_in_tree and (v->>'reason_code' = 'ALLOWED_BY_ROOT_ACCESS' or (
         v->>'reason_code' = 'ALLOWED_BY_ASSIGNMENT' and exists (
           select 1 from jsonb_array_elements(coalesce(v->'matched_assignments','[]'::jsonb)) m
           join public.sa_business_roles br on br.id = nullif(m->>'roleId','')::uuid
           where br.status = 'active' and br.source <> 'legacy')))) as mss_approve_strict,
       count(distinct v->>'reason_code') filter (where v->>'decision' <> 'ALLOW') as distinct_deny_reasons,
       string_agg(distinct v->>'reason_code', ', ') as reason_codes
from chk c group by org order by org;

-- G3. PENDING requests that NO ONE can decide under the B2A rule (the operational blocker)
with pend as (select id, organization_id as org, employee_id as emp from public.hr_leave_requests where status = 'pending'),
cand as (select distinct a.user_id from public.sa_role_assignments a
         join public.sa_business_roles b on b.id = a.role_id and b.status = 'active'
         join public.sa_business_role_permissions rp on rp.role_id = b.id
         join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active' and p.permission_key = 'hr.leave.approve'
         where a.status = 'active' and (a.effective_until is null or a.effective_until > now())
         union select g.user_id from public.sa_root_access_grants g
         where g.status = 'active' and (g.effective_until is null or g.effective_until > now())),
x as (
  select pd.*,
    exists (select 1 from cand c
            join public.users u on u.id = c.user_id and u.is_active is true and coalesce(u.account_status,'ACTIVE') <> 'ARCHIVED'
            cross join lateral (select public.sa_evaluate_permission_core(c.user_id,'hr.leave.approve',
                                  jsonb_build_object('organization_id', pd.org), false, false) as v) e
            where c.user_id <> pd.emp and (e.v->>'reason_code' = 'ALLOWED_BY_ROOT_ACCESS' or (e.v->>'reason_code' = 'ALLOWED_BY_ASSIGNMENT'
              and exists (select 1 from jsonb_array_elements(coalesce(e.v->'matched_assignments','[]'::jsonb)) m
                          join public.sa_business_roles br on br.id = nullif(m->>'roleId','')::uuid
                          where br.status = 'active' and br.source <> 'legacy')))) as hr_strict,
    exists (select 1 from cand c
            join public.users u on u.id = c.user_id and u.is_active is true
            cross join lateral (select public.sa_evaluate_permission_core(c.user_id,'hr.leave.approve',
                                  jsonb_build_object('organization_id', pd.org), false, false) as v) e
            where c.user_id <> pd.emp and e.v->>'decision' = 'ALLOW') as hr_any,
    exists (select 1 from public.hr_employees e
            join public.users m on m.id = e.manager_user_id and m.is_active is true and coalesce(m.account_status,'ACTIVE') <> 'ARCHIVED'
            cross join lateral (select public.sa_evaluate_permission_core(e.manager_user_id,'hr.mss.leave_approve',
                                  jsonb_build_object('organization_id', pd.org, 'owner_user_id', pd.emp), false, false) as v) ev
            where e.user_id = pd.emp and e.organization_id = pd.org and e.onboarding_status = 'completed'
              and e.manager_user_id <> pd.emp
              and exists (select 1 from public.hr_employees me where me.user_id = e.manager_user_id and me.onboarding_status = 'completed'
                          and me.organization_id = any(public.sa_org_ancestry(pd.org)))
              and (ev.v->>'reason_code' = 'ALLOWED_BY_ROOT_ACCESS' or (ev.v->>'reason_code' = 'ALLOWED_BY_ASSIGNMENT'
                and exists (select 1 from jsonb_array_elements(coalesce(ev.v->'matched_assignments','[]'::jsonb)) m
                            join public.sa_business_roles br on br.id = nullif(m->>'roleId','')::uuid
                            where br.status = 'active' and br.source <> 'legacy')))) as mgr_strict
  from pend pd)
select org, count(*) as pending,
       count(*) filter (where hr_strict) as decidable_by_explicit_hr,
       count(*) filter (where mgr_strict) as decidable_by_direct_manager,
       count(*) filter (where not hr_strict and not mgr_strict) as blocked_no_decider,
       count(*) filter (where not hr_strict and not mgr_strict and hr_any) as blocked_but_legacy_would_allow
from x group by org order by org;

-- G4. Completed employment records in an organization other than users.organization_id. By the Identity Stage 2
--     design (20260929150000) the CURRENT employment is the record in users.organization_id; records elsewhere are
--     former-employment history and must not accept new leave. Expected: 0 on production; any row here is a
--     staging data-quality item for the Identity workstream (PMS: "staging has two organization mismatches").
select e.organization_id as employment_org, count(*) as onboarded_employees_with_other_home_org
from public.hr_employees e join public.users u on u.id = e.user_id
where e.onboarding_status = 'completed' and u.organization_id is distinct from e.organization_id
group by 1 order by 1;

\echo '=== H. HISTORICAL ROWS (aggregate; same definitions as hr_leave_containment_review) ==='
select organization_id as org, status, count(*) as requests,
       count(*) filter (where approved_by is not null and approved_by = employee_id) as self_approved,
       count(*) filter (where status in ('approved','rejected') and approved_by is null) as decided_without_approver,
       count(*) filter (where status not in ('draft','pending','approved','rejected','cancelled')) as unknown_status
from public.hr_leave_requests group by 1, 2 order by 1, 2;

\echo '=== END (rolled back) ==='
rollback;
