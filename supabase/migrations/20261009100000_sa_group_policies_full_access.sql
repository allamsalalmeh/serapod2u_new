-- ============================================================================
-- Security & Access — Group Policies: module-wide "Full Access" standard
-- policies, and delegated (non-level-1) Security & Access administration
-- ----------------------------------------------------------------------------
-- A Group Policy IS a business role (sa_business_roles; "Access Profile" was the
-- earlier user-facing name). There is no second authorization engine: evaluation,
-- assignments, scopes, SoD and the audit log are the existing ones.
--
-- 1. Standard Full Access policies (source 'template' = protected, copy-only)
--    One per top-level business module of the shared taxonomy
--    (app/src/lib/security-access/modules.ts): Supply Chain, Customer & Growth,
--    HR & Payroll, Finance, Security & Access, Platform & Settings. Reporting is
--    a single shared analytics permission and is not a module.
--      * Every currently registered permission of the module, as an EXPLICIT
--        reviewed list (no wildcard, no runtime inheritance), including delete,
--        reset, cancel, reverse and override permissions.
--      * Internal accounts only (partner accounts may never hold HR, security,
--        platform user/data or finance data permissions, and a full policy is not
--        a partner policy): applicable_account_types = {internal}.
--      * Sensitive (security.*, hr.data.reset, finance.data.reset,
--        platform.data.destructive): the existing rules apply unchanged — not
--        assignable at user creation (assign in People & Access), SoD enforced,
--        HR reset still requires the central Super Admin as well.
--      * Existing narrower profiles are untouched. Seeding is repeat-safe: a
--        policy that already exists is never modified, never expanded and never
--        re-seeded, and nothing is assigned to anyone.
--      * The policy's explicit coverage is recorded (sa_standard_policy_coverage).
--        Permissions registered later are NOT added: sa_standard_policy_drift()
--        lists them, and sa_extend_standard_policy() (owner only, reviewed
--        migration) adds explicit keys with a reason, a holder SoD check and a
--        per-holder audit row.
--
-- 2. Delegated Security & Access administration
--    Every S&A governance function authorizes through sa_assert_actor_permission
--    (security.* permissions): while a permission is on a legacy migration mode
--    the legacy rule decides, and that rule is the central Super Admin (level 1)
--    only. An explicitly authorized administrator could therefore never use an
--    assigned S&A capability until each permission was moved to a new-model
--    mode. This migration:
--      * adds sa_settings 'security_access.delegated_administration' (default
--        FALSE = no behaviour change). When true, a security.* permission is also
--        allowed by an explicit, in-scope S&A assignment while its mode is still
--        legacy. Legacy-level-1 behaviour is unchanged (union, never narrower).
--      * evaluates security.* permissions in the administrator's own
--        organization when no context is given (same trusted context as
--        20261008100000), instead of an empty context that no scoped assignment
--        can match.
--      * lets the directory (sa_authorized_organizations) follow the same rule.
--      * keeps grant authority inside what the actor holds: for a non-level-1
--        actor, (a) a role containing a sensitive permission can be granted only
--        if the actor holds that permission in the target organization, (b) every
--        scope must lie in an organization where the actor holds the grant
--        authority (organization-independent typed scopes are level-1 only),
--        (c) a custom profile can contain a sensitive permission only if the
--        actor holds it. Self-assignment, SoD, membership, applicability,
--        audit (real actor) and lockout guards in the existing functions are
--        untouched; HR reset is untouched.
--
-- No migration mode, legacy level, role or assignment is changed or created.
-- Not applied by this change. Additive (create or replace / if not exists).
--
-- Rollback: drop the three guard triggers and the coverage table/functions;
-- restore sa_assert_actor_permission (20260928100000) and
-- sa_authorized_organizations (20261005100000); delete the setting; unassigned
-- standard policies may be deleted by the owner (assigned ones cannot).
-- Requires: 20261005110000_sa_access_profiles.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Setting + helpers
-- ---------------------------------------------------------------------------
insert into public.sa_settings(setting_key, setting_value, description)
values ('security_access.delegated_administration', 'false'::jsonb,
        'When true, an explicitly assigned Security & Access capability works for a non-level-1 administrator even while the permission is still on a legacy migration mode. Default false.')
on conflict (setting_key) do nothing;

create or replace function public.sa_delegated_administration_enabled()
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select public.sa_setting_bool('security_access.delegated_administration', false)
$$;
revoke all on function public.sa_delegated_administration_enabled() from public, anon, authenticated;
grant execute on function public.sa_delegated_administration_enabled() to service_role;

-- Same function as 20261008100000 (kept identical so this migration has no ordering dependency on it).
create or replace function public.sa_actor_org_context(p_actor uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((select jsonb_build_object('organization_id', u.organization_id) from public.users u where u.id = p_actor and u.organization_id is not null), '{}'::jsonb)
$$;
revoke all on function public.sa_actor_org_context(uuid) from public, anon, authenticated;
grant execute on function public.sa_actor_org_context(uuid) to service_role;

-- Does the actor hold the permission through an active explicit assignment? With an organization the
-- full scope-aware evaluation applies; without one, any active assignment of a role that contains it.
create or replace function public.sa_actor_holds_permission(p_actor uuid, p_key text, p_org uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case when p_org is not null
    then public.sa_actor_has_permission(p_actor, p_key, jsonb_build_object('organization_id', p_org))
    else exists (
      select 1 from public.sa_role_assignments a
      join public.sa_organization_memberships m on m.id = a.membership_id and m.status = 'active'
        and (m.effective_from is null or m.effective_from <= now()) and (m.effective_until is null or m.effective_until > now())
      join public.sa_business_roles br on br.id = a.role_id and br.status = 'active'
      join public.sa_business_role_permissions rp on rp.role_id = br.id
      join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active' and p.permission_key = p_key
      where a.user_id = p_actor and a.status = 'active'
        and (a.effective_from is null or a.effective_from <= now()) and (a.effective_until is null or a.effective_until > now()))
  end
$$;
revoke all on function public.sa_actor_holds_permission(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.sa_actor_holds_permission(uuid,text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Governance authorization: legacy level 1, or (delegation on) an explicit in-scope assignment
-- ---------------------------------------------------------------------------
create or replace function public.sa_assert_actor_permission(p_actor uuid, p_permission text, p_context jsonb, p_legacy boolean)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_ctx jsonb := coalesce(p_context, '{}'::jsonb);
begin
  if p_actor is null then raise exception 'sa_actor_required' using errcode = '42501'; end if;
  if not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then
    raise exception 'sa_actor_inactive' using errcode = '42501';
  end if;
  -- Security administration is evaluated in a real organization: the administrator's own when none is given.
  if p_permission like 'security.%' and v_ctx = '{}'::jsonb then v_ctx := public.sa_actor_org_context(p_actor); end if;
  if public.sa_is_new_authoritative(p_permission) then
    if not public.sa_actor_has_permission(p_actor, p_permission, v_ctx) then
      raise exception 'sa_authorization_required' using errcode = '42501', detail = p_permission;
    end if;
  elsif not coalesce(p_legacy, false) then
    -- Legacy rule says no. Delegated administration (opt-in): an explicit assignment in scope also counts.
    if not (p_permission like 'security.%'
            and public.sa_delegated_administration_enabled()
            and public.sa_actor_has_permission(p_actor, p_permission, v_ctx)) then
      raise exception 'sa_authorization_required' using errcode = '42501', detail = p_permission;
    end if;
  end if;
end $$;
revoke all on function public.sa_assert_actor_permission(uuid,text,jsonb,boolean) from public, anon, authenticated;

-- Directory scope: legacy level 1 sees every organization; with delegation on, an explicit assignment
-- limits a non-level-1 administrator to its authorized organizations (same rule as the new modes).
create or replace function public.sa_authorized_organizations(p_actor uuid, p_permission text)
returns table(organization_id uuid)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_permission is null or p_permission not in ('security.access.view', 'security.role.assign') then
    raise exception 'sa_directory_permission_invalid';
  end if;
  if p_actor is null or not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then return; end if;

  if not public.sa_is_new_authoritative(p_permission) then
    if public.sa_legacy_is_super_admin(p_actor) then
      return query select o.id from public.organizations o;
      return;
    end if;
    if not public.sa_delegated_administration_enabled() then return; end if;
  end if;

  return query
  with recursive base(id) as (
    select m.organization_id from public.sa_organization_memberships m
    where m.user_id = p_actor and m.status = 'active'
      and (m.effective_from is null or m.effective_from <= now()) and (m.effective_until is null or m.effective_until > now())
  ), down(id, depth) as (
    select id, 0 from base
    union
    select o.id, d.depth + 1 from public.organizations o join down d on o.parent_org_id = d.id where d.depth < 10
  )
  select distinct d.id from down d
  where public.sa_actor_has_permission(p_actor, p_permission, jsonb_build_object('organization_id', d.id));
end $$;
revoke all on function public.sa_authorized_organizations(uuid,text) from public, anon, authenticated;
grant execute on function public.sa_authorized_organizations(uuid,text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Grant-authority guards (non-level-1 actors only; level 1 behaves exactly as before)
--    Every grant writes the real actor into updated_by / created_by, so the guards sit on the tables
--    and cover the manual grant, the access-request approval and the profile publication paths.
-- ---------------------------------------------------------------------------
create or replace function public.sa_assignment_grant_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_actor uuid := new.updated_by; v_org uuid; v_key text;
begin
  if v_actor is null or new.status <> 'active' or new.source not in ('manual', 'access_request') then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'active' and old.role_id = new.role_id and old.membership_id = new.membership_id
     and old.source = new.source and old.effective_from is not distinct from new.effective_from
     and old.effective_until is not distinct from new.effective_until then return new; end if;
  if public.sa_legacy_is_super_admin(v_actor) then return new; end if;
  select m.organization_id into v_org from public.sa_organization_memberships m where m.id = new.membership_id;
  for v_key in
    select p.permission_key from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
    where rp.role_id = new.role_id and public.sa_permission_is_sensitive(p.permission_key) order by p.permission_key
  loop
    if not public.sa_actor_holds_permission(v_actor, v_key, v_org) then
      raise exception 'sa_grant_beyond_authority: %', v_key using errcode = '42501',
        hint = 'An administrator can grant a sensitive permission only while holding it in that organization.';
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.sa_assignment_grant_guard() from public, anon, authenticated;
drop trigger if exists sa_assignment_grant_guard on public.sa_role_assignments;
create trigger sa_assignment_grant_guard before insert or update on public.sa_role_assignments
  for each row execute function public.sa_assignment_grant_guard();

create or replace function public.sa_assignment_scope_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_actor uuid := new.created_by; v_source text; v_org uuid;
begin
  if v_actor is null then return new; end if;
  select a.source into v_source from public.sa_role_assignments a where a.id = new.assignment_id;
  if v_source is null or v_source not in ('manual', 'access_request') then return new; end if;
  if public.sa_legacy_is_super_admin(v_actor) then return new; end if;
  select sd.organization_id into v_org from public.sa_scope_definitions sd where sd.id = new.scope_id;
  if v_org is null
     or not (public.sa_actor_has_permission(v_actor, 'security.role.assign', jsonb_build_object('organization_id', v_org))
          or public.sa_actor_has_permission(v_actor, 'security.access_request.approve', jsonb_build_object('organization_id', v_org))) then
    raise exception 'sa_grant_scope_beyond_authority' using errcode = '42501',
      hint = 'A scope can be granted only inside an organization where you hold the grant authority; organization-independent scopes are granted by a central Super Admin.';
  end if;
  return new;
end $$;
revoke all on function public.sa_assignment_scope_guard() from public, anon, authenticated;
drop trigger if exists sa_assignment_scope_guard on public.sa_assignment_scopes;
create trigger sa_assignment_scope_guard before insert on public.sa_assignment_scopes
  for each row execute function public.sa_assignment_scope_guard();

create or replace function public.sa_role_permission_grant_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_key text; v_source text;
begin
  if new.created_by is null then return new; end if;
  select r.source into v_source from public.sa_business_roles r where r.id = new.role_id;
  if v_source is distinct from 'new' then return new; end if;
  if public.sa_legacy_is_super_admin(new.created_by) then return new; end if;
  select p.permission_key into v_key from public.sa_permissions p where p.id = new.permission_id;
  if public.sa_permission_is_sensitive(v_key) and not public.sa_actor_holds_permission(new.created_by, v_key, null) then
    raise exception 'sa_profile_beyond_authority: %', v_key using errcode = '42501',
      hint = 'A custom policy can contain a sensitive permission only if you hold it yourself.';
  end if;
  return new;
end $$;
revoke all on function public.sa_role_permission_grant_guard() from public, anon, authenticated;
drop trigger if exists sa_role_permission_grant_guard on public.sa_business_role_permissions;
create trigger sa_role_permission_grant_guard before insert on public.sa_business_role_permissions
  for each row execute function public.sa_role_permission_grant_guard();

create or replace function public.sa_profile_draft_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_actor uuid := coalesce(new.updated_by, new.created_by); v_key text;
begin
  if v_actor is null or public.sa_legacy_is_super_admin(v_actor) then return new; end if;
  for v_key in select k from unnest(new.permission_keys) k where public.sa_permission_is_sensitive(k) order by k loop
    if not public.sa_actor_holds_permission(v_actor, v_key, null) then
      raise exception 'sa_profile_beyond_authority: %', v_key using errcode = '42501',
        hint = 'A custom policy can contain a sensitive permission only if you hold it yourself.';
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.sa_profile_draft_guard() from public, anon, authenticated;
drop trigger if exists sa_profile_draft_guard on public.sa_access_profile_drafts;
create trigger sa_profile_draft_guard before insert or update of permission_keys on public.sa_access_profile_drafts
  for each row execute function public.sa_profile_draft_guard();

-- ---------------------------------------------------------------------------
-- 4. Standard policy coverage record
-- ---------------------------------------------------------------------------
create table if not exists public.sa_standard_policy_coverage (
  role_id uuid primary key references public.sa_business_roles(id) on delete cascade,
  role_key text not null unique,
  module_id text not null,
  module_prefixes text[] not null,
  coverage_version integer not null default 1,
  permission_keys text[] not null,
  seeded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.sa_standard_policy_coverage enable row level security;
alter table public.sa_standard_policy_coverage force row level security;
revoke all on table public.sa_standard_policy_coverage from public, anon, authenticated, service_role;
grant select on table public.sa_standard_policy_coverage to service_role;
comment on table public.sa_standard_policy_coverage is
  'Explicit permission coverage recorded when a standard module policy was seeded or extended. Never read by authorization.';

-- ---------------------------------------------------------------------------
-- 5. Seed (repeat-safe; reviewed explicit lists; fails loudly instead of omitting a key)
-- ---------------------------------------------------------------------------
do $seed$
declare
  r record;
  v_role uuid;
  v_missing text[];
  v_existing text;
begin
  for r in select * from (values
  ('supply-chain-full-access', 'Supply Chain Full Access', 'supply_chain', 'Every Supply Chain permission: orders and documents, stock count, stock transfer, inventory, warehouse, manufacturing, product catalogue and QR & traceability, including cancel, reverse and adjustment operations. Each operation keeps its own guards (for example the order maker/checker rule).',
   array['inventory','manufacturing','product','qr','supply_chain','warehouse'],
   array['inventory.adjustment.post','inventory.opening_balance.manage','inventory.report.view','inventory.return.manage','inventory.return.request','inventory.stock_config.manage','inventory.stock_count.create','inventory.stock_count.post','inventory.stock_count.verify','inventory.stock_count.view','inventory.transfer.approve','inventory.transfer.cancel','inventory.transfer.dispatch','inventory.transfer.receive','inventory.transfer.request','inventory.transfer.view','manufacturing.adjustment.administer','manufacturing.adjustment.manage','manufacturing.production.manage','manufacturing.scan.reverse','product.catalog.manage','product.catalog.view','qr.batch.manage','supply_chain.document.acknowledge','supply_chain.document.manage','supply_chain.order.approve','supply_chain.order.cancel','supply_chain.order.create','warehouse.receipt.post','warehouse.shipment.manage']),
  ('customer-growth-full-access', 'Customer & Growth Full Access', 'customer_growth', 'Every Customer & Growth permission: CRM, loyalty and rewards, messaging and support (including support administration), RoadTour, marketing and campaigns, the outdoor store and e-commerce.',
   array['customer','ecommerce','marketing','roadtour'],
   array['customer.banner.manage','customer.campaign.manage','customer.consumer.view','customer.crm.view','customer.loyalty.adjust','customer.messaging.manage','customer.program.manage','customer.redemption.manage','customer.report.view','customer.reward.manage','customer.shop.manage','customer.support.administer','customer.support.manage','ecommerce.channel.manage','ecommerce.module.view','ecommerce.order.manage','ecommerce.outdoor.operate','ecommerce.store.manage','marketing.module.view','roadtour.campaign.manage','roadtour.kpi.manage','roadtour.report.view','roadtour.visit.manage']),
  ('hr-payroll-full-access', 'HR & Payroll Full Access', 'hr_payroll', 'Every HR & Payroll permission, including the HR data reset permission. HR reset additionally requires a central Super Admin; holding this policy never bypasses that rule or the payroll separation-of-duties checks.',
   array['hr'],
   array['hr.ai.use','hr.analytics.view','hr.attendance.manage','hr.benefits.manage','hr.compensation.manage','hr.compensation.view','hr.contract.manage','hr.contract.view','hr.data.reset','hr.employee.manage','hr.employee.view','hr.employee.view_internal','hr.expense.manage','hr.learning.manage','hr.leave.approve','hr.module.view','hr.onboarding.manage','hr.payroll.approve','hr.payroll.prepare','hr.payroll.release','hr.payroll.view','hr.performance.manage','hr.policy.manage','hr.recruitment.manage','hr.self_service.use','hr.settings.manage']),
  ('finance-full-access', 'Finance Full Access', 'finance', 'Every Finance permission, including payment approval and the Finance data reset permission. Finance operations keep their own approval and separation-of-duties rules.',
   array['finance'],
   array['finance.account.manage','finance.cash.view','finance.data.reset','finance.journal.post','finance.ledger.view','finance.module.view','finance.payable.view','finance.payment.approve','finance.payroll_integration.manage','finance.receivable.view','finance.reconciliation.perform','finance.report.view_sensitive','finance.settings.manage']),
  ('security-access-full-access', 'Security & Access Full Access', 'security_access', 'Every Security & Access permission: view and administer Security & Access, group policies, assignments, scopes, migration modes, governance, access requests and reviews, delegations, audit and service identities. Assignments are limited by the administrator''s own grant authority; emergency access stays unavailable until MFA step-up exists.',
   array['security'],
   array['security.access.view','security.access_request.approve','security.access_review.manage','security.audit.view','security.delegation.manage','security.emergency_access.grant','security.permission.manage','security.policy.manage','security.role.assign','security.role.manage','security.scope.manage','security.service_identity.manage']),
  ('platform-settings-full-access', 'Platform & Settings Full Access', 'platform_settings', 'Every Platform & Settings permission: identity, user administration, notifications, integrations and settings, organizations and the destructive data permission. Destructive and delete operations keep their own guards.',
   array['platform'],
   array['platform.data.destructive','platform.identity.delete','platform.identity.disable','platform.identity.view','platform.identity_access.manage','platform.notification_monitor.view','platform.organization.manage','platform.settings.manage','platform.user.manage','platform.user.profile_edit'])
  ) as t(role_key, name, module_id, description, module_prefixes, permission_keys)
  loop
    v_role := null;
    select array_agg(k order by k) into v_missing from unnest(r.permission_keys) k
    where not exists (select 1 from public.sa_permissions p where p.permission_key = k and p.status = 'active');
    if v_missing is not null then
      raise exception 'sa_group_policy_permission_missing: % (%)', r.role_key, array_to_string(v_missing, ', ')
        using hint = 'Apply the migrations that register these permissions first. Nothing is omitted silently.';
    end if;
    select b.source into v_existing from public.sa_business_roles b where b.role_key = r.role_key;
    if v_existing is not null and v_existing <> 'template' then
      raise exception 'sa_group_policy_key_conflict: % already exists as a non-standard role', r.role_key;
    end if;

    insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
    values (r.role_key, r.name, r.description, 'template', 'active', array['internal'], '{}')
    on conflict (role_key) do nothing
    returning id into v_role;

    -- Already present: never modified, never expanded, never re-recorded here.
    continue when v_role is null;

    insert into public.sa_business_role_permissions(role_id, permission_id)
    select v_role, p.id from public.sa_permissions p where p.permission_key = any(r.permission_keys) and p.status = 'active';
    insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
    values (v_role, r.role_key, r.module_id, r.module_prefixes, (select array_agg(k order by k) from unnest(r.permission_keys) k));
    perform public.sa_log_access_change(null, 'access_profile.standard_seeded', null, 'sa_business_role', v_role::text,
      jsonb_build_object('role_key', r.role_key, 'module', r.module_id, 'permission_count', cardinality(r.permission_keys)),
      'Standard Full Access group policy seeded (not assigned to anyone)', 'system');
  end loop;
end $seed$;

-- ---------------------------------------------------------------------------
-- 6. Controlled update process: drift report + owner-only explicit extension
-- ---------------------------------------------------------------------------
-- Catalogue permissions of the policy's module that are NOT in its recorded coverage (informational only;
-- nothing is granted), plus any difference between the recorded and the live permission set.
create or replace function public.sa_standard_policy_drift()
returns table(role_key text, module_id text, recorded_count integer, live_count integer,
              catalogue_not_covered text[], live_not_recorded text[], recorded_not_live text[])
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select c.role_key, c.module_id, cardinality(c.permission_keys),
    (select count(*)::integer from public.sa_business_role_permissions rp where rp.role_id = c.role_id),
    coalesce((select array_agg(p.permission_key order by p.permission_key) from public.sa_permissions p
              where p.status = 'active' and p.module = any(c.module_prefixes) and not (p.permission_key = any(c.permission_keys))), '{}'),
    coalesce((select array_agg(p.permission_key order by p.permission_key) from public.sa_business_role_permissions rp
              join public.sa_permissions p on p.id = rp.permission_id where rp.role_id = c.role_id and not (p.permission_key = any(c.permission_keys))), '{}'),
    coalesce((select array_agg(k order by k) from unnest(c.permission_keys) k
              where not exists (select 1 from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
                                where rp.role_id = c.role_id and p.permission_key = k)), '{}')
  from public.sa_standard_policy_coverage c order by c.role_key
$$;
revoke all on function public.sa_standard_policy_drift() from public, anon, authenticated;
grant execute on function public.sa_standard_policy_drift() to service_role;

-- Adds explicit permissions to a standard policy. Callable only by the database owner (reviewed migration):
-- not granted to any API role. Requires a reason, refuses a key outside the module, refuses an enforce-level
-- SoD conflict for any current holder, and writes one audit row per holder.
create or replace function public.sa_extend_standard_policy(p_role_key text, p_keys text[], p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_cov public.sa_standard_policy_coverage;
  v_keys text[];
  v_new text[];
  v_bad text;
  v_blocking text;
  v_holder record;
begin
  if p_reason is null or length(btrim(p_reason)) < 10 then raise exception 'sa_reason_required'; end if;
  select * into v_cov from public.sa_standard_policy_coverage where role_key = p_role_key for update;
  if not found then raise exception 'sa_profile_not_found'; end if;
  select coalesce(array_agg(distinct k order by k), '{}') into v_keys from unnest(coalesce(p_keys, '{}')) k;
  select k into v_bad from unnest(v_keys) k
  where not exists (select 1 from public.sa_permissions p where p.permission_key = k and p.status = 'active') limit 1;
  if v_bad is not null then raise exception 'sa_profile_invalid_permission: %', v_bad; end if;
  select k into v_bad from unnest(v_keys) k
  where not (split_part(k, '.', 1) = any(v_cov.module_prefixes)) limit 1;
  if v_bad is not null then raise exception 'sa_group_policy_outside_module: %', v_bad; end if;
  select coalesce(array_agg(k order by k), '{}') into v_new from unnest(v_keys) k where not (k = any(v_cov.permission_keys));
  if cardinality(v_new) = 0 then return jsonb_build_object('added', '[]'::jsonb, 'unchanged', true); end if;

  with holders as (select distinct user_id from public.sa_profile_active_holders(v_cov.role_id)),
  before_set as (
    select hh.user_id, p.permission_key from holders hh
    join public.sa_role_assignments a on a.user_id = hh.user_id and a.status = 'active' and (a.effective_until is null or a.effective_until > now())
    join public.sa_business_role_permissions rp on rp.role_id = a.role_id join public.sa_permissions p on p.id = rp.permission_id),
  after_set as (select user_id, permission_key from before_set union select hh.user_id, k from holders hh, unnest(v_new) k)
  select string_agg(distinct x.rule_key, ', ') into v_blocking from (
    select r.rule_key, hh.user_id from public.sa_sod_rules r cross join holders hh
    where public.sa_sod_rule_active(r) and r.rule_kind = 'permission_conflict' and r.enforcement = 'enforce'
      and not public.sa_sod_has_mitigation(r.id, hh.user_id)
      and exists (select 1 from after_set s where s.user_id = hh.user_id and s.permission_key = r.left_key)
      and exists (select 1 from after_set s where s.user_id = hh.user_id and s.permission_key = r.right_key)
      and not (exists (select 1 from before_set s where s.user_id = hh.user_id and s.permission_key = r.left_key)
               and exists (select 1 from before_set s where s.user_id = hh.user_id and s.permission_key = r.right_key))
  ) x;
  if v_blocking is not null then raise exception 'sa_profile_holder_conflict: %', v_blocking using errcode = '42501'; end if;

  insert into public.sa_business_role_permissions(role_id, permission_id)
  select v_cov.role_id, p.id from public.sa_permissions p where p.permission_key = any(v_new) and p.status = 'active';
  update public.sa_standard_policy_coverage set permission_keys = (select array_agg(k order by k) from unnest(permission_keys || v_new) k),
    coverage_version = coverage_version + 1, updated_at = now() where role_id = v_cov.role_id;
  update public.sa_business_roles set version = version + 1, updated_at = now() where id = v_cov.role_id;
  perform public.sa_log_access_change(null, 'access_profile.standard_extended', null, 'sa_business_role', v_cov.role_id::text,
    jsonb_build_object('role_key', p_role_key, 'added', to_jsonb(v_new), 'coverage_version', v_cov.coverage_version + 1), btrim(p_reason), 'system');
  for v_holder in select * from public.sa_profile_active_holders(v_cov.role_id) loop
    perform public.sa_log_access_change(null, 'assignment.profile_changed', v_holder.user_id, 'sa_role_assignment', v_holder.assignment_id::text,
      jsonb_build_object('role_id', v_cov.role_id, 'added', to_jsonb(v_new), 'removed', '[]'::jsonb, 'organization_id', v_holder.organization_id), btrim(p_reason), 'system');
  end loop;
  return jsonb_build_object('added', to_jsonb(v_new), 'unchanged', false);
end $$;
revoke all on function public.sa_extend_standard_policy(text,text[],text) from public, anon, authenticated, service_role;
