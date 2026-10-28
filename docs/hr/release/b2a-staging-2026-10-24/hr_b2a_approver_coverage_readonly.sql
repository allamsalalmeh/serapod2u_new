-- ============================================================================
-- Serapod2U HR — B2A approver coverage worklist (READ-ONLY, owner-run, STAGING first)
-- Purpose: name the MINIMUM explicit S&A grants needed so that genuine leave approvers keep working under B2A.
--   It does NOT grant anything. It never proposes "every legacy holder": only people who actually decided leave
--   recently or who are recorded as someone's direct manager.
-- Output contains user ids, names and organization ids: keep it local (outside the repository), do not share.
--
--   ssh ... "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' serapod-stg-db \
--            psql -U postgres -d supabase -X -v ON_ERROR_STOP=0 -f -" < hr_b2a_approver_coverage_readonly.sql > coverage.txt
-- Uses public.sa_evaluate_permission_core (STABLE, read-only) inside a READ ONLY transaction.
-- ============================================================================
\set QUIET on
\set ON_ERROR_ROLLBACK on
\pset footer off
begin transaction read only;
set local statement_timeout = '120s';
set local lock_timeout = '3s';

\echo '=== W1. HR approver candidates: decided leave in the last 365 days, and their current B2A status ==='
-- grant needed = 'hr-leave-attendance-administrator' (explicit, organization-scoped to the HQ) when strict_hr is false
with deciders as (
  select r.approved_by as user_id, r.organization_id as org, count(*) as decisions, max(coalesce(r.approved_at, r.updated_at)) as last_decision
  from public.hr_leave_requests r
  where r.status in ('approved', 'rejected') and r.approved_by is not null and r.approved_by <> r.employee_id
    and coalesce(r.approved_at, r.updated_at) >= now() - interval '365 days'
  group by 1, 2),
ev as (
  select d.*, public.sa_evaluate_permission_core(d.user_id, 'hr.leave.approve', jsonb_build_object('organization_id', d.org), false, false) as v
  from deciders d)
select ev.user_id, u.full_name, u.is_active, coalesce(u.account_status, 'ACTIVE') as account_status, ev.org, o.org_name,
       ev.decisions, ev.last_decision::date,
       (select count(*) from public.hr_employees e where e.manager_user_id = ev.user_id and e.onboarding_status = 'completed') as direct_reports,
       ev.v->>'decision' as hr_any_decision, ev.v->>'reason_code' as reason_code,
       (ev.v->>'reason_code' = 'ALLOWED_BY_ROOT_ACCESS' or (ev.v->>'reason_code' = 'ALLOWED_BY_ASSIGNMENT' and exists (
          select 1 from jsonb_array_elements(coalesce(ev.v->'matched_assignments','[]'::jsonb)) m
          join public.sa_business_roles br on br.id = nullif(m->>'roleId','')::uuid
          where br.status = 'active' and br.source <> 'legacy'))) as strict_hr
from ev
join public.users u on u.id = ev.user_id
left join public.organizations o on o.id = ev.org
order by strict_hr, ev.org, ev.decisions desc;

\echo '=== W2. Direct managers (reporting lines) and their B2A manager status ==='
-- grant needed = 'manager-self-service' (explicit) when strict_mss is false and the line is genuine
with lines as (
  select e.organization_id as org, e.manager_user_id as mgr, count(*) as reports, min(e.user_id::text)::uuid as sample_report
  from public.hr_employees e
  where e.onboarding_status = 'completed' and e.manager_user_id is not null and e.manager_user_id <> e.user_id
  group by 1, 2),
ev as (
  select l.*, public.sa_evaluate_permission_core(l.mgr, 'hr.mss.leave_approve',
           jsonb_build_object('organization_id', l.org, 'owner_user_id', l.sample_report), false, false) as v
  from lines l)
select ev.mgr as manager_user_id, u.full_name, u.is_active, coalesce(u.account_status, 'ACTIVE') as account_status,
       ev.org, o.org_name, ev.reports,
       exists (select 1 from public.hr_employees me where me.user_id = ev.mgr and me.onboarding_status = 'completed'
               and me.organization_id = any(public.sa_org_ancestry(ev.org))) as manager_onboarded_in_tree,
       ev.v->>'decision' as mss_any_decision, ev.v->>'reason_code' as reason_code,
       (ev.v->>'reason_code' = 'ALLOWED_BY_ROOT_ACCESS' or (ev.v->>'reason_code' = 'ALLOWED_BY_ASSIGNMENT' and exists (
          select 1 from jsonb_array_elements(coalesce(ev.v->'matched_assignments','[]'::jsonb)) m
          join public.sa_business_roles br on br.id = nullif(m->>'roleId','')::uuid
          where br.status = 'active' and br.source <> 'legacy'))) as strict_mss,
       (select count(*) from public.hr_leave_requests r join public.hr_employees e2 on e2.user_id = r.employee_id
         and e2.organization_id = r.organization_id and e2.manager_user_id = ev.mgr
        where r.status = 'pending' and r.organization_id = ev.org) as pending_from_reports
from ev
join public.users u on u.id = ev.mgr
left join public.organizations o on o.id = ev.org
order by strict_mss, pending_from_reports desc, ev.reports desc;

\echo '=== W3. Legacy-only holders of hr.leave.approve who did NOT decide leave in 365 days (do not grant by default) ==='
select a.user_id, u.full_name, count(*) as legacy_assignments
from public.sa_role_assignments a
join public.sa_business_roles b on b.id = a.role_id and b.status = 'active' and b.source = 'legacy'
join public.sa_business_role_permissions rp on rp.role_id = b.id
join public.sa_permissions p on p.id = rp.permission_id and p.permission_key = 'hr.leave.approve' and p.status = 'active'
join public.users u on u.id = a.user_id
where a.status = 'active' and (a.effective_until is null or a.effective_until > now())
  and not exists (select 1 from public.hr_leave_requests r where r.approved_by = a.user_id
                  and coalesce(r.approved_at, r.updated_at) >= now() - interval '365 days')
group by 1, 2 order by 2;

\echo '=== END (rolled back) ==='
rollback;
