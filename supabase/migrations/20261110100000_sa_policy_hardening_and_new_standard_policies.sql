-- ============================================================================
-- Security & Access — Standard Policy hardening + four new Standard Policies
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database.
-- Proven on a throwaway PostgreSQL 17 built from a read-only staging schema dump + S&A configuration rows:
-- supabase/tests/security/sa_policy_hardening/run.sh.
--
-- Decisions (business owner, 2026-10-13; docs/security/HR_GROUPING_AND_STANDARD_POLICY_ROADMAP.md):
--
--   1. Destructive operations leave the module Full Access policies and live only in dedicated break-glass policies.
--        hr.data.reset                                    HR & Payroll Full Access        → HR Data Reset Administrator (exists)
--        finance.data.reset                               Finance Full Access             → Finance Data Reset Administrator (new)
--        platform.data.destructive, platform.identity.delete
--                                                         Platform & Settings Full Access → Platform Data Maintenance Administrator (new)
--      Nobody loses access: every CURRENT active holder of a Full Access policy that still contains the key first
--      receives the matching break-glass policy (same membership, same scopes, same dates; audited as
--      assignment.granted with transferred_from), then the keys are removed through the new owner-only
--      sa_narrow_standard_policy() (audited access_profile.standard_narrowed + assignment.profile_changed per holder).
--      sa_standard_policy_coverage.excluded_keys records the reviewed exclusion, so sa_standard_policy_drift() does not
--      report the keys as "catalogue not covered" again.
--      Staging (read-only, 2026-10-13): 1 holder of Finance Full Access, 1 holder of Platform & Settings Full Access,
--      0 holders of HR & Payroll Full Access.
--
--   2. Maker/checker: payroll-prepare-approve and payment-request-maker-checker move from monitor to ENFORCE.
--      Both are same-document rules already wired into the workflow (sa_payroll_run_transition_guard,
--      approve_payment_request → sa_enforce_same_document_sod). Staging has 0 recorded same-document violations for
--      either rule and 0 SoD mitigations, so no existing document is blocked. Holding both permissions stays possible;
--      only approving one's own run / request is refused (a mitigation still allows it, audited).
--
--   3. Four new Standard Policies (existing permission keys only, assigned to nobody):
--        warehouse-receiving-dispatch      HQ, WH  warehouse.receipt.post, warehouse.shipment.manage, inventory.stock.view,
--                                                  supply_chain.order.view, supply_chain.document.acknowledge
--        hr-leave-attendance-administrator HQ      hr.module.view, hr.employee.view, hr.attendance.manage, hr.leave.approve,
--                                                  hr.expense.manage
--        hr-records-officer                HQ      hr.module.view, hr.employee.view, hr.employee.manage, hr.contract.view,
--                                                  hr.contract.manage, hr.onboarding.manage, hr.recruitment.manage
--        reporting-viewer                  HQ      reporting.analytics.view
--      plus the two break-glass policies of decision 1 (finance-data-reset-administrator, platform-data-maintenance-administrator).
--
--   4. Supporting reads are declared for every approval / maintenance operation that has a view permission
--      (sa_permission_dependencies). Declarative only; no decision reads it. Every standard policy already satisfies
--      them (post-condition).
--
-- Not changed: permission keys, migration modes, compatibility (legacy-*) roles, custom policies, scopes, evaluator,
-- RLS. Note for reviewers: compatibility roles legacy-sa / legacy-hq / legacy-power-user hold finance.data.reset through
-- its compatibility rule (role level <= 20); that is reported separately, not changed here.
--
-- Order: requires 20261009100000 (coverage, drift, sa_extend_standard_policy), 20261030100000 (eligibility),
-- 20261031100000 (inventory.stock.view), 20261101100000 (supply_chain.order.view, sa_permission_dependencies),
-- 20261003100000 (hr.data.reset + hr-data-reset-administrator). Repeat-safe.
--
-- Rollback (in this order):
--   * policies: re-add the keys with sa_extend_standard_policy('<full access>', array[...], '<reason>') after
--     `update public.sa_standard_policy_coverage set excluded_keys = '{}' where role_key = '<full access>'`;
--   * SoD:   update public.sa_sod_rules set enforcement = 'monitor', updated_at = now()
--            where rule_key in ('payroll-prepare-approve','payment-request-maker-checker');
--   * new policies: revoke their assignments in People & Access, then delete them as the owner
--     (role_key in the six keys above); dependencies: delete the rows inserted in section 7;
--   * functions/column: drop function public.sa_narrow_standard_policy(text,text[],text); restore
--     sa_standard_policy_drift() from 20261009100000; alter table public.sa_standard_policy_coverage drop column excluded_keys.
--   (The audit rows stay: they record what happened.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $pre$
declare v_missing text;
begin
  if to_regclass('public.sa_standard_policy_coverage') is null or to_regprocedure('public.sa_extend_standard_policy(text,text[],text)') is null then
    raise exception 'sa_prerequisite_missing: standard policy coverage (20261009100000)';
  end if;
  if to_regclass('public.sa_org_type_eligibility') is null then
    raise exception 'sa_prerequisite_missing: org-type eligibility (20261030100000)';
  end if;
  if to_regclass('public.sa_permission_dependencies') is null then
    raise exception 'sa_prerequisite_missing: sa_permission_dependencies (20261101100000)';
  end if;
  select string_agg(k, ', ' order by k) into v_missing from unnest(array[
    'hr.data.reset','finance.data.reset','platform.data.destructive','platform.identity.delete',
    'warehouse.receipt.post','warehouse.shipment.manage','inventory.stock.view','supply_chain.order.view','supply_chain.document.acknowledge',
    'hr.module.view','hr.employee.view','hr.attendance.manage','hr.leave.approve','hr.expense.manage','hr.employee.manage',
    'hr.contract.view','hr.contract.manage','hr.onboarding.manage','hr.recruitment.manage','reporting.analytics.view',
    'hr.payroll.view','hr.payroll.prepare','hr.payroll.approve','hr.payroll.release','finance.payable.view','finance.payment.approve',
    'hr.commission.view','hr.commission.manage','hr.commission.approve','hr.mss.leave_view','hr.mss.leave_approve']) k
  where not exists (select 1 from public.sa_permissions p where p.permission_key = k and p.status = 'active');
  if v_missing is not null then raise exception 'sa_prerequisite_missing: permissions %', v_missing; end if;
  if not exists (select 1 from public.sa_business_roles where role_key = 'hr-data-reset-administrator' and source = 'template') then
    raise exception 'sa_prerequisite_missing: hr-data-reset-administrator (20261003100000)';
  end if;
  if (select count(*) from public.sa_sod_rules where rule_key in ('payroll-prepare-approve','payment-request-maker-checker')
      and rule_kind = 'same_document') <> 2 then
    raise exception 'sa_prerequisite_missing: SoD rules payroll-prepare-approve / payment-request-maker-checker';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Reviewed exclusions in the coverage record, and a drift report that honours them
-- ---------------------------------------------------------------------------
alter table public.sa_standard_policy_coverage add column if not exists excluded_keys text[] not null default '{}';
comment on column public.sa_standard_policy_coverage.excluded_keys is
  'Module permissions deliberately NOT in this standard policy (reviewed migration, e.g. destructive operations moved to a break-glass policy). Never read by authorization.';

-- Same result columns as 20261009100000; catalogue_not_covered now skips the reviewed exclusions.
create or replace function public.sa_standard_policy_drift()
returns table(role_key text, module_id text, recorded_count integer, live_count integer,
              catalogue_not_covered text[], live_not_recorded text[], recorded_not_live text[])
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select c.role_key, c.module_id, cardinality(c.permission_keys),
    (select count(*)::integer from public.sa_business_role_permissions rp where rp.role_id = c.role_id),
    coalesce((select array_agg(p.permission_key order by p.permission_key) from public.sa_permissions p
              where p.status = 'active' and p.module = any(c.module_prefixes) and not (p.permission_key = any(c.permission_keys))
                and not (p.permission_key = any(c.excluded_keys))), '{}'),
    coalesce((select array_agg(p.permission_key order by p.permission_key) from public.sa_business_role_permissions rp
              join public.sa_permissions p on p.id = rp.permission_id where rp.role_id = c.role_id and not (p.permission_key = any(c.permission_keys))), '{}'),
    coalesce((select array_agg(k order by k) from unnest(c.permission_keys) k
              where not exists (select 1 from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
                                where rp.role_id = c.role_id and p.permission_key = k)), '{}')
  from public.sa_standard_policy_coverage c order by c.role_key
$$;
revoke all on function public.sa_standard_policy_drift() from public, anon, authenticated;
grant execute on function public.sa_standard_policy_drift() to service_role;

-- ---------------------------------------------------------------------------
-- 2. Controlled narrowing of a standard policy (owner only; the counterpart of sa_extend_standard_policy)
--    Removes explicit keys, records them as reviewed exclusions, bumps the versions and writes one audit row for the
--    policy plus one per active holder. It never revokes an assignment and never touches another policy, so a holder
--    who also holds the key through another policy keeps it.
-- ---------------------------------------------------------------------------
create or replace function public.sa_narrow_standard_policy(p_role_key text, p_keys text[], p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_cov public.sa_standard_policy_coverage;
  v_keys text[];
  v_removed text[];
  v_holder record;
begin
  if p_reason is null or length(btrim(p_reason)) < 10 then raise exception 'sa_reason_required'; end if;
  select * into v_cov from public.sa_standard_policy_coverage where role_key = p_role_key for update;
  if not found then raise exception 'sa_profile_not_found'; end if;
  if not exists (select 1 from public.sa_business_roles where id = v_cov.role_id and source = 'template') then
    raise exception 'sa_profile_not_standard: %', p_role_key;
  end if;
  select coalesce(array_agg(distinct k order by k), '{}') into v_keys from unnest(coalesce(p_keys, '{}')) k;
  select coalesce(array_agg(p.permission_key order by p.permission_key), '{}') into v_removed
  from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
  where rp.role_id = v_cov.role_id and p.permission_key = any(v_keys);

  -- Always record the exclusion (repeat-safe), even when the live mapping no longer holds the key.
  update public.sa_standard_policy_coverage set
    permission_keys = coalesce((select array_agg(k order by k) from unnest(permission_keys) k where not (k = any(v_keys))), '{}'),
    excluded_keys = (select coalesce(array_agg(distinct k order by k), '{}') from unnest(excluded_keys || v_keys) k),
    coverage_version = coverage_version + case when cardinality(v_removed) > 0 then 1 else 0 end,
    updated_at = case when cardinality(v_removed) > 0 then now() else updated_at end
  where role_id = v_cov.role_id;
  if cardinality(v_removed) = 0 then return jsonb_build_object('removed', '[]'::jsonb, 'unchanged', true); end if;

  delete from public.sa_business_role_permissions rp using public.sa_permissions p
  where rp.role_id = v_cov.role_id and p.id = rp.permission_id and p.permission_key = any(v_removed);
  update public.sa_business_roles set version = version + 1, updated_at = now(), updated_by = null where id = v_cov.role_id;
  perform public.sa_log_access_change(null, 'access_profile.standard_narrowed', null, 'sa_business_role', v_cov.role_id::text,
    jsonb_build_object('role_key', p_role_key, 'removed', to_jsonb(v_removed), 'coverage_version', v_cov.coverage_version + 1), btrim(p_reason), 'system');
  for v_holder in select * from public.sa_profile_active_holders(v_cov.role_id) loop
    perform public.sa_log_access_change(null, 'assignment.profile_changed', v_holder.user_id, 'sa_role_assignment', v_holder.assignment_id::text,
      jsonb_build_object('role_id', v_cov.role_id, 'added', '[]'::jsonb, 'removed', to_jsonb(v_removed), 'organization_id', v_holder.organization_id),
      btrim(p_reason), 'system');
  end loop;
  return jsonb_build_object('removed', to_jsonb(v_removed), 'unchanged', false);
end $$;
revoke all on function public.sa_narrow_standard_policy(text,text[],text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. New Standard Policies (explicit lists; not assigned to anyone by this section)
-- ---------------------------------------------------------------------------
do $seed$
declare
  r record;
  v_role uuid;
  v_existing text;
begin
  for r in select * from (values
    ('finance-data-reset-administrator', 'Finance Data Reset Administrator', 'finance', array['finance'], array['HQ'],
     'Break-glass: resets the accounting data of an organization (destructive; environment-gated). Kept out of Finance Full Access. Grant only for a planned reset, preferably with an end date.',
     array['finance.data.reset']),
    ('platform-data-maintenance-administrator', 'Platform Data Maintenance Administrator', 'platform_settings', array['platform'], array['HQ'],
     'Break-glass: runs destructive data maintenance (environment-gated) and archives identities (terminal; history is preserved). Kept out of Platform & Settings Full Access. Grant only for planned maintenance, preferably with an end date.',
     array['platform.data.destructive','platform.identity.delete']),
    ('warehouse-receiving-dispatch', 'Warehouse Receiving & Dispatch', 'supply_chain', array['warehouse','inventory','supply_chain'], array['HQ','WH'],
     'Receives goods into the warehouse and starts, scans, confirms, completes and cancels shipments. Includes the reads the work needs: stock on hand, the orders being received or shipped, and acknowledging their documents. No order creation or approval, stock adjustment, transfer approval, QR batch or product administration.',
     array['warehouse.receipt.post','warehouse.shipment.manage','inventory.stock.view','supply_chain.order.view','supply_chain.document.acknowledge']),
    ('hr-leave-attendance-administrator', 'Leave & Attendance Administrator', 'hr_payroll', array['hr'], array['HQ'],
     'Organization-wide leave and attendance: approves or rejects leave and manages leave configuration, attendance policy, shifts, corrections, overtime, timesheets and expense claims. Reads the employee directory. No employee master data, contracts, payroll or compensation. Line managers use Manager Self-Service for their own team.',
     array['hr.module.view','hr.employee.view','hr.attendance.manage','hr.leave.approve','hr.expense.manage']),
    ('hr-records-officer', 'Recruitment & Employee Records Officer', 'hr_payroll', array['hr'], array['HQ'],
     'Recruitment (job postings, applicants, interviews, offers), onboarding, employee master data and positions, and employment contracts. No payroll, compensation, leave approval or HR settings.',
     array['hr.module.view','hr.employee.view','hr.employee.manage','hr.contract.view','hr.contract.manage','hr.onboarding.manage','hr.recruitment.manage']),
    ('reporting-viewer', 'Reporting Viewer', 'reporting', array['reporting'], array['HQ'],
     'Views cross-module business analytics. Read only. Module-specific reports (finance, inventory, customer, RoadTour, commission) keep their own permissions.',
     array['reporting.analytics.view'])
  ) as t(role_key, name, module_id, prefixes, org_types, description, perms)
  loop
    select b.source into v_existing from public.sa_business_roles b where b.role_key = r.role_key;
    if v_existing is not null and v_existing <> 'template' then
      raise exception 'sa_group_policy_key_conflict: % already exists as a non-standard role', r.role_key;
    end if;
    insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
    values (r.role_key, r.name, r.description, 'template', 'active', array['internal'], r.org_types)
    on conflict (role_key) do nothing
    returning id into v_role;
    continue when v_role is null;   -- already present: never modified or expanded here

    insert into public.sa_business_role_permissions(role_id, permission_id)
    select v_role, p.id from public.sa_permissions p where p.permission_key = any(r.perms) and p.status = 'active';
    if (select count(*) from public.sa_business_role_permissions where role_id = v_role) <> cardinality(r.perms) then
      raise exception 'sa_group_policy_permission_missing: % (%)', r.role_key, array_to_string(r.perms, ', ');
    end if;
    insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
    values (v_role, r.role_key, r.module_id, r.prefixes, (select array_agg(k order by k) from unnest(r.perms) k));
    perform public.sa_log_access_change(null, 'access_profile.standard_seeded', null, 'sa_business_role', v_role::text,
      jsonb_build_object('role_key', r.role_key, 'module', r.module_id, 'permission_count', cardinality(r.perms)),
      'Standard group policy seeded (not assigned to anyone)', 'system');
  end loop;

  -- HR Data Reset Administrator predates the coverage record (20261003100000): record its live set once.
  insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
  select b.id, b.role_key, 'hr_payroll', array['hr'],
         (select coalesce(array_agg(p.permission_key order by p.permission_key), '{}') from public.sa_business_role_permissions rp
          join public.sa_permissions p on p.id = rp.permission_id where rp.role_id = b.id)
  from public.sa_business_roles b where b.role_key = 'hr-data-reset-administrator'
  on conflict do nothing;
end $seed$;

-- ---------------------------------------------------------------------------
-- 4. Current Full Access holders keep the destructive permission through its break-glass policy
--    Only while the Full Access policy still contains the key (a re-run, or a Full Access grant made after this
--    migration, receives nothing). Same membership, scopes and dates as the Full Access assignment.
-- ---------------------------------------------------------------------------
do $transfer$
declare
  r record;
  v_target uuid;
  v_new uuid;
  v_reason constant text := 'Destructive permission moved out of Full Access into a break-glass policy (20261110100000); existing holder keeps it.';
begin
  for r in
    select distinct on (a.id, t.target_key) a.id as assignment_id, a.user_id, a.membership_id, a.effective_from, a.effective_until,
           fa.role_key as from_key, t.target_key, m.organization_id
    from (values ('hr-payroll-full-access', 'hr.data.reset', 'hr-data-reset-administrator'),
                 ('finance-full-access', 'finance.data.reset', 'finance-data-reset-administrator'),
                 ('platform-settings-full-access', 'platform.data.destructive', 'platform-data-maintenance-administrator'),
                 ('platform-settings-full-access', 'platform.identity.delete', 'platform-data-maintenance-administrator')) t(fa_key, perm, target_key)
    join public.sa_business_roles fa on fa.role_key = t.fa_key and fa.source = 'template'
    join public.sa_business_role_permissions rp on rp.role_id = fa.id
    join public.sa_permissions p on p.id = rp.permission_id and p.permission_key = t.perm
    join public.sa_role_assignments a on a.role_id = fa.id and a.status = 'active'
      and (a.effective_until is null or a.effective_until > now())
    join public.sa_organization_memberships m on m.id = a.membership_id
    order by a.id, t.target_key
  loop
    select id into v_target from public.sa_business_roles where role_key = r.target_key and source = 'template';
    if exists (select 1 from public.sa_role_assignments x where x.user_id = r.user_id and x.role_id = v_target
               and x.membership_id = r.membership_id and x.status <> 'revoked') then
      raise notice 'kept: % already has % on this membership (assignment of % not copied)', r.user_id, r.target_key, r.from_key;
      continue;
    end if;
    insert into public.sa_role_assignments(user_id, role_id, membership_id, status, effective_from, effective_until,
                                           assignment_reason, source, created_by, updated_by)
    values (r.user_id, v_target, r.membership_id, 'active', r.effective_from, r.effective_until, v_reason, 'manual', null, null)
    returning id into v_new;
    insert into public.sa_assignment_scopes(assignment_id, scope_id, created_by)
    select v_new, s.scope_id, null from public.sa_assignment_scopes s where s.assignment_id = r.assignment_id
    on conflict do nothing;
    perform public.sa_log_access_change(null, 'assignment.granted', r.user_id, 'sa_role_assignment', v_new::text,
      jsonb_build_object('role_id', v_target, 'role_key', r.target_key, 'organization_id', r.organization_id,
                         'scope_ids', (select coalesce(jsonb_agg(s.scope_id), '[]'::jsonb) from public.sa_assignment_scopes s where s.assignment_id = v_new),
                         'effective_from', r.effective_from, 'effective_until', r.effective_until, 'source', 'manual',
                         'transferred_from', jsonb_build_object('assignment_id', r.assignment_id, 'role_key', r.from_key)),
      v_reason, 'system');
  end loop;
end $transfer$;

-- ---------------------------------------------------------------------------
-- 5. Remove the destructive permissions from the module Full Access policies
-- ---------------------------------------------------------------------------
select public.sa_narrow_standard_policy('hr-payroll-full-access', array['hr.data.reset'],
  'Destructive HR data reset is granted only through HR Data Reset Administrator (break-glass), never through Full Access.');
select public.sa_narrow_standard_policy('finance-full-access', array['finance.data.reset'],
  'Destructive accounting reset is granted only through Finance Data Reset Administrator (break-glass), never through Full Access.');
select public.sa_narrow_standard_policy('platform-settings-full-access', array['platform.data.destructive','platform.identity.delete'],
  'Destructive data maintenance and identity archiving are granted only through Platform Data Maintenance Administrator (break-glass).');

update public.sa_business_roles set description = v.description, updated_at = now(), updated_by = null
from (values
  ('hr-payroll-full-access', 'Every HR & Payroll permission except the destructive HR data reset (HR Data Reset Administrator). Manager Self-Service, the Manager Compensation Viewer and Staff Sales Commission are separate policies. Payroll keeps its maker/checker rule: nobody approves a payroll run they calculated.'),
  ('finance-full-access', 'Every Finance permission, including payment approval, except the destructive accounting reset (Finance Data Reset Administrator). Finance operations keep their own approval and separation-of-duties rules: nobody approves a payment request they raised.'),
  ('platform-settings-full-access', 'Every Platform & Settings permission: identity, user administration, notifications, integrations and settings, and organizations. Destructive data maintenance and identity archiving are in Platform Data Maintenance Administrator.')
) v(role_key, description)
where public.sa_business_roles.role_key = v.role_key and public.sa_business_roles.source = 'template'
  and public.sa_business_roles.description is distinct from v.description;

-- ---------------------------------------------------------------------------
-- 6. Maker/checker: monitor → enforce (audited once per rule that changes)
-- ---------------------------------------------------------------------------
do $sod$
declare r record;
begin
  for r in update public.sa_sod_rules set enforcement = 'enforce', updated_at = now(), updated_by = null
           where rule_key in ('payroll-prepare-approve', 'payment-request-maker-checker') and enforcement <> 'enforce'
           returning id, rule_key
  loop
    perform public.sa_log_access_change(null, 'sod.rule_enforcement_changed', null, 'sa_sod_rule', r.id::text,
      jsonb_build_object('rule_key', r.rule_key, 'from', 'monitor', 'to', 'enforce'),
      'Business owner decision 2026-10-13: the maker of a payroll run / payment request may not approve the same document.', 'system');
  end loop;
end $sod$;

-- ---------------------------------------------------------------------------
-- 7. Declared supporting reads (declarative; mirrored in app/src/lib/security-access/policy-dependencies.ts)
-- ---------------------------------------------------------------------------
insert into public.sa_permission_dependencies(permission_key, requires_key, reason) values
  ('hr.payroll.prepare', 'hr.payroll.view', 'A payroll officer opens the payroll run they calculate.'),
  ('hr.payroll.approve', 'hr.payroll.view', 'An approver opens the calculated payroll run before approving it.'),
  ('hr.payroll.release', 'hr.payroll.view', 'A finance approver opens the approved payroll run before releasing it to the ledger.'),
  ('finance.payment.approve', 'finance.payable.view', 'A payment approver opens the payable and its payment request before approving it.'),
  ('hr.commission.manage', 'hr.commission.view', 'A commission administrator works on the commission records they maintain.'),
  ('hr.commission.approve', 'hr.commission.view', 'A commission approver opens the commission before approving it.'),
  ('hr.mss.leave_approve', 'hr.mss.leave_view', 'A line manager opens the team leave request before deciding it.'),
  ('hr.leave.approve', 'hr.employee.view', 'An HR leave approver identifies the employee whose leave is decided.'),
  ('hr.employee.manage', 'hr.employee.view', 'A records officer opens the employee record they maintain.'),
  ('hr.contract.manage', 'hr.contract.view', 'A records officer opens the contract they maintain.'),
  ('warehouse.shipment.manage', 'supply_chain.order.view', 'A dispatcher opens the order being shipped.')
on conflict (permission_key, requires_key) do nothing;

-- ---------------------------------------------------------------------------
-- 8. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare v_bad text;
begin
  select string_agg(b.role_key || ':' || p.permission_key, ', ') into v_bad
  from public.sa_business_roles b join public.sa_business_role_permissions rp on rp.role_id = b.id
  join public.sa_permissions p on p.id = rp.permission_id
  where b.role_key like '%-full-access' and b.source = 'template'
    and p.permission_key in ('hr.data.reset','finance.data.reset','platform.data.destructive','platform.identity.delete');
  if v_bad is not null then raise exception 'postcondition: Full Access still holds destructive permissions: %', v_bad; end if;

  select string_agg(t.role_key, ', ') into v_bad from (values
    ('finance-data-reset-administrator', array['finance.data.reset']),
    ('platform-data-maintenance-administrator', array['platform.data.destructive','platform.identity.delete']),
    ('warehouse-receiving-dispatch', array['inventory.stock.view','supply_chain.document.acknowledge','supply_chain.order.view','warehouse.receipt.post','warehouse.shipment.manage']),
    ('hr-leave-attendance-administrator', array['hr.attendance.manage','hr.employee.view','hr.expense.manage','hr.leave.approve','hr.module.view']),
    ('hr-records-officer', array['hr.contract.manage','hr.contract.view','hr.employee.manage','hr.employee.view','hr.module.view','hr.onboarding.manage','hr.recruitment.manage']),
    ('reporting-viewer', array['reporting.analytics.view'])) t(role_key, perms)
  where (select array_agg(p.permission_key order by p.permission_key) from public.sa_business_roles b
         join public.sa_business_role_permissions rp on rp.role_id = b.id join public.sa_permissions p on p.id = rp.permission_id
         where b.role_key = t.role_key and b.source = 'template' and b.status = 'active') is distinct from t.perms;
  if v_bad is not null then raise exception 'postcondition: policy permission set differs: %', v_bad; end if;

  -- The only assignments of the new policies are the break-glass transfers of section 4.
  if exists (select 1 from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
             where b.role_key in ('warehouse-receiving-dispatch','hr-leave-attendance-administrator','hr-records-officer','reporting-viewer')) then
    raise exception 'postcondition: a new functional policy must not be assigned by a migration';
  end if;

  -- Nobody who held a destructive permission through Full Access lost it.
  select string_agg(distinct a.user_id::text || ':' || t.perm, ', ') into v_bad
  from (values ('finance-full-access', 'finance.data.reset'), ('platform-settings-full-access', 'platform.data.destructive'),
               ('platform-settings-full-access', 'platform.identity.delete'), ('hr-payroll-full-access', 'hr.data.reset')) t(fa_key, perm)
  join public.sa_business_roles fa on fa.role_key = t.fa_key
  join public.sa_role_assignments a on a.role_id = fa.id and a.status = 'active' and (a.effective_until is null or a.effective_until > now())
  where exists (select 1 from public.sa_access_change_log l where l.action = 'assignment.granted'
                and l.details -> 'transferred_from' ->> 'assignment_id' = a.id::text)
    and not exists (select 1 from public.sa_role_assignments x
                    join public.sa_business_role_permissions rp on rp.role_id = x.role_id
                    join public.sa_permissions p on p.id = rp.permission_id and p.permission_key = t.perm
                    where x.user_id = a.user_id and x.membership_id = a.membership_id and x.status = 'active');
  if v_bad is not null then raise exception 'postcondition: holder lost a destructive permission: %', v_bad; end if;

  if exists (select 1 from public.sa_sod_rules where rule_key in ('payroll-prepare-approve','payment-request-maker-checker') and enforcement <> 'enforce') then
    raise exception 'postcondition: maker/checker rules must enforce';
  end if;

  select string_agg(role_key || ':' || permission_key || '→' || requires_key, ', ') into v_bad from public.sa_standard_policy_dependency_gaps();
  if v_bad is not null then raise exception 'postcondition: standard policy supporting-read gaps: %', v_bad; end if;

  select string_agg(d.role_key || ':' || array_to_string(d.catalogue_not_covered, '/'), ', ') into v_bad
  from public.sa_standard_policy_drift() d
  where d.role_key in ('hr-payroll-full-access','finance-full-access','platform-settings-full-access')
    and d.catalogue_not_covered && array['hr.data.reset','finance.data.reset','platform.data.destructive','platform.identity.delete'];
  if v_bad is not null then raise exception 'postcondition: drift still reports the reviewed exclusions: %', v_bad; end if;
end $post$;
