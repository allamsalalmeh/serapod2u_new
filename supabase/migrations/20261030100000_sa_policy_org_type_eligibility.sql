-- ============================================================================
-- Security & Access — Organization-aware Group Policy eligibility
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database, so
-- nothing here has been run against a real database (throwaway PostgreSQL 17 with the real S&A migrations:
-- supabase/tests/security/sa_policy_eligibility/run.sh).
--
-- Findings (2026-10-11 audit of staging, read-only):
--   * Eligibility metadata already existed (sa_business_roles.applicable_org_types / applicable_account_types, 20261005110000)
--     but an EMPTY list meant "any organization". 42 of 51 policies had no list, so e.g. Warehouse Manager, Order Approver
--     or any Finance clerk policy was grantable to a Distributor or Shop membership through sa_assign_role.
--   * sa_profile_applicable was checked only by sa_assign_role and sa_assign_initial_profiles. Access-request approval
--     (sa_decide_access_request → sa_create_assignment_internal) and a re-grant of a revoked row did not check it.
--   * sa_org_account_type classified every non-partner type as 'internal', so END_USER (consumers) and INDEP organizations
--     silently counted as HQ staff; WH (HQ-owned warehouse sites) was never classified explicitly.
--   * Custom policy "supply-chain-full-access-custom-manufacture" declares account type internal AND organization type MFG
--     (a contradiction: MFG is a partner type) — it is grantable nowhere, before and after this migration. Not changed.
--
-- What this adds
--   1. sa_org_type_eligibility — explicit classification of every organization type: HQ, WH = internal; MFG, DIST, SHOP =
--      partner; END_USER, INDEP = not_assignable. A type missing from the table is not assignable (fail closed).
--   2. sa_permission_hq_only(key) — permissions that only internal (HQ / WH) memberships may hold: the existing
--      sa_permission_forbidden_for_partner list (hr.*, security.*, platform.user.*, platform.data.*, finance.data.*) plus
--      the whole Finance module (the company ledger) and the whole Platform module (system administration).
--      sa_permission_allowed_for_org_type(key, type): internal types accept any permission; Distributor / Shop accept any
--      permission that is not HQ-only; a Manufacturer accepts only manufacturing.* (same rule as the application's
--      recipient-eligibility.ts since 20261010100000).
--   3. sa_policy_org_type_ineligibility(role, org_type) — THE eligibility rule, returning null (eligible) or a reason:
--        org_type_not_assignable | policy_unclassified | org_type_not_eligible | account_type_not_eligible |
--        permission_incompatible:<key> | policy_not_found
--      An empty applicable_org_types list is now "unclassified" = eligible NOWHERE (no longer "anywhere").
--      sa_profile_applicable(role, org) keeps its signature and delegates to it, so sa_assign_role and (through it)
--      sa_assign_initial_profiles inherit the rule unchanged.
--   4. sa_assignment_eligibility_guard (BEFORE INSERT/UPDATE on sa_role_assignments) — every ADMINISTRATOR grant (source
--      manual or access_request) that becomes active, or moves to another policy / membership, is checked against the
--      target MEMBERSHIP's organization type — never the grantor's. It takes a share lock on the policy row so a
--      concurrent eligibility change and a grant serialize. Covers Add User, Edit User, People & Access, direct API calls,
--      access-request approval and re-granting a revoked row. Lifecycle sources (backfill / derived) and Root Access
--      (sa_root_access_grants, a separate table) are not touched.
--   5. Eligibility changes of a policy (sa_business_roles BEFORE UPDATE OF applicable_org_types / applicable_account_types):
--      every listed type must be a classified, assignable type; a type ADDED must be compatible with every permission of
--      the policy; a custom policy cannot be narrowed while an administrator grant in a type it would exclude is active
--      (sa_profile_eligibility_has_holders); every change is written to sa_access_change_log
--      (access_profile.eligibility_changed, before/after).
--   6. Custom drafts (sa_access_profile_drafts): listed types must be classified and assignable and compatible with the
--      drafted permissions; a draft cannot be submitted or published without at least one organization type
--      (sa_profile_org_types_required). Saving an incomplete draft stays possible.
--   7. Standard policy classification — fills applicable_org_types ONLY where it is empty (never overwrites an explicit
--      list, never touches custom policies). Conservative: every policy whose partner use is not an approved business
--      decision is HQ-only; see docs/security/GROUP_POLICY_ORG_TYPE_ELIGIBILITY.md for the matrix and open decisions.
--   8. Read-only reports for service_role: sa_policy_eligibility_catalogue() and sa_policy_eligibility_audit()
--      (active grants whose membership type is no longer eligible). Nothing is revoked or rewritten.
--
-- What this does NOT change
--   * No existing assignment, scope or audit row is modified; incompatible existing grants stay active (report only).
--   * No migration mode, enforcement-readiness row, Root Access grant or legacy compatibility role.
--   * Grantor authority (security.role.assign, sensitive-permission guard, scope guard), separation of duties and the
--     duplicate-grant rule are unchanged and still checked separately.
--
-- Order: requires 20261005110000, 20261009100000, 20261015100000, 20261020100000. Independent of 20261026100000+ (Root
-- Access) and 20261028100000 (Order Creator, whose HQ/DIST/SHOP list is kept as is). Repeat-safe.
--
-- Rollback (in order):
--   drop trigger if exists sa_assignment_eligibility_guard on public.sa_role_assignments;
--   drop trigger if exists sa_business_role_eligibility_guard on public.sa_business_roles;
--   drop trigger if exists sa_profile_draft_eligibility_guard on public.sa_access_profile_drafts;
--   re-run the sa_profile_applicable definition of 20261005110000;
--   drop function if exists public.sa_policy_eligibility_audit(), public.sa_policy_eligibility_catalogue(),
--     public.sa_assignment_eligibility_guard(), public.sa_business_role_eligibility_guard(),
--     public.sa_profile_draft_eligibility_guard(), public.sa_policy_org_type_ineligibility(uuid,text),
--     public.sa_permission_allowed_for_org_type(text,text), public.sa_permission_hq_only(text);
--   drop table if exists public.sa_org_type_eligibility;
--   The filled applicable_org_types lists may stay (with the old function, a non-empty list only narrows); to restore the
--   exact previous metadata set them back to '{}' for the role keys listed in section 7.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Organization type classification
-- ---------------------------------------------------------------------------
create table if not exists public.sa_org_type_eligibility (
  org_type_code text primary key check (org_type_code = upper(org_type_code)),
  eligibility_class text not null check (eligibility_class in ('internal', 'partner', 'not_assignable')),
  description text not null,
  updated_at timestamptz not null default now()
);
alter table public.sa_org_type_eligibility enable row level security;
alter table public.sa_org_type_eligibility force row level security;
revoke all on table public.sa_org_type_eligibility from public, anon, authenticated, service_role;
grant select on table public.sa_org_type_eligibility to service_role;
comment on table public.sa_org_type_eligibility is
  'Explicit Group Policy eligibility class of every organization type. A type that is not listed cannot receive Group Policies.';

insert into public.sa_org_type_eligibility(org_type_code, eligibility_class, description) values
  ('HQ',       'internal',       'Headquarters staff.'),
  ('WH',       'internal',       'HQ-owned warehouse site. Eligible only for policies that list WH explicitly; never implied by HQ.'),
  ('MFG',      'partner',        'Manufacturer partner. Manufacturing-only permissions.'),
  ('DIST',     'partner',        'Distributor partner.'),
  ('SHOP',     'partner',        'Shop partner.'),
  ('END_USER', 'not_assignable', 'End users / consumers (store shoppers). Never receive Group Policies.'),
  ('INDEP',    'not_assignable', 'Independent portal users. Never receive Group Policies until a classification is approved.')
on conflict (org_type_code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Permission compatibility per organization type
-- ---------------------------------------------------------------------------
create or replace function public.sa_permission_hq_only(p_key text)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select public.sa_permission_forbidden_for_partner(p_key) or p_key like 'finance.%' or p_key like 'platform.%'
$$;
revoke all on function public.sa_permission_hq_only(text) from public, anon, authenticated;
grant execute on function public.sa_permission_hq_only(text) to service_role;

create or replace function public.sa_permission_allowed_for_org_type(p_key text, p_org_type text)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((
    select case c.eligibility_class
             when 'internal' then true
             when 'partner' then not public.sa_permission_hq_only(p_key)
                                 and (c.org_type_code <> 'MFG' or p_key like 'manufacturing.%')
             else false end
    from public.sa_org_type_eligibility c where c.org_type_code = upper(btrim(coalesce(p_org_type, '')))), false)
$$;
revoke all on function public.sa_permission_allowed_for_org_type(text, text) from public, anon, authenticated;
grant execute on function public.sa_permission_allowed_for_org_type(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The eligibility rule
-- ---------------------------------------------------------------------------
create or replace function public.sa_policy_org_type_ineligibility(p_role uuid, p_org_type text)
returns text language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_type text := upper(btrim(coalesce(p_org_type, '')));
  v_class text;
  v_role record;
  v_bad text;
begin
  select r.applicable_org_types, r.applicable_account_types into v_role from public.sa_business_roles r where r.id = p_role;
  if not found then return 'policy_not_found'; end if;
  select c.eligibility_class into v_class from public.sa_org_type_eligibility c where c.org_type_code = v_type;
  if v_class is null or v_class = 'not_assignable' then return 'org_type_not_assignable'; end if;
  if cardinality(v_role.applicable_org_types) = 0 then return 'policy_unclassified'; end if;
  if not (v_type = any(v_role.applicable_org_types)) then return 'org_type_not_eligible'; end if;
  if cardinality(v_role.applicable_account_types) > 0 and not (v_class = any(v_role.applicable_account_types)) then
    return 'account_type_not_eligible';
  end if;
  select p.permission_key into v_bad
  from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
  where rp.role_id = p_role and not public.sa_permission_allowed_for_org_type(p.permission_key, v_type)
  order by p.permission_key limit 1;
  if v_bad is not null then return 'permission_incompatible:' || v_bad; end if;
  return null;
end $$;
revoke all on function public.sa_policy_org_type_ineligibility(uuid, text) from public, anon, authenticated;
grant execute on function public.sa_policy_org_type_ineligibility(uuid, text) to service_role;
comment on function public.sa_policy_org_type_ineligibility(uuid, text) is
  'Null when the Group Policy may be granted to a membership of that organization type, else the reason. Missing metadata is never unrestricted.';

-- Same signature as 20261005110000; every caller (sa_assign_role, and sa_assign_initial_profiles through it) inherits the rule.
create or replace function public.sa_profile_applicable(p_role uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select public.sa_policy_org_type_ineligibility(p_role, (select o.org_type_code from public.organizations o where o.id = p_org)) is null
$$;
revoke all on function public.sa_profile_applicable(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Every administrator grant is checked against the TARGET membership
-- ---------------------------------------------------------------------------
create or replace function public.sa_assignment_eligibility_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_type text; v_reason text;
begin
  if new.status <> 'active' or new.source not in ('manual', 'access_request') then return new; end if;
  -- An existing active grant whose policy and membership do not change (dates, notes) is not a new grant.
  if tg_op = 'UPDATE' and old.status = 'active' and old.role_id = new.role_id and old.membership_id = new.membership_id
     and old.source in ('manual', 'access_request') then return new; end if;
  -- Serializes with a concurrent eligibility change of the same policy (sa_business_role_eligibility_guard runs under the row's update lock).
  perform 1 from public.sa_business_roles r where r.id = new.role_id for share;
  select o.org_type_code into v_type
  from public.sa_organization_memberships m join public.organizations o on o.id = m.organization_id
  where m.id = new.membership_id;
  v_reason := public.sa_policy_org_type_ineligibility(new.role_id, v_type);
  if v_reason is not null then
    raise exception 'sa_profile_not_applicable: %', v_reason using errcode = '42501',
      hint = 'The Group Policy is not eligible for the organization type of this membership.';
  end if;
  return new;
end $$;
revoke all on function public.sa_assignment_eligibility_guard() from public, anon, authenticated;
drop trigger if exists sa_assignment_eligibility_guard on public.sa_role_assignments;
create trigger sa_assignment_eligibility_guard before insert or update on public.sa_role_assignments
  for each row execute function public.sa_assignment_eligibility_guard();

-- ---------------------------------------------------------------------------
-- 5. Changing a policy's eligibility
-- ---------------------------------------------------------------------------
create or replace function public.sa_business_role_eligibility_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_type text; v_key text; v_holders integer;
begin
  if old.applicable_org_types is not distinct from new.applicable_org_types
     and old.applicable_account_types is not distinct from new.applicable_account_types then return new; end if;
  if new.source = 'legacy' then return new; end if;
  for v_type in select unnest(new.applicable_org_types) loop
    if not exists (select 1 from public.sa_org_type_eligibility c where c.org_type_code = v_type and c.eligibility_class <> 'not_assignable') then
      raise exception 'sa_profile_org_type_invalid: %', v_type using hint = 'Only classified, assignable organization types can be listed.';
    end if;
  end loop;
  -- A type that is ADDED must suit every permission of the policy (no broadening of HQ-only permissions to partners).
  for v_type in select unnest(new.applicable_org_types) except select unnest(old.applicable_org_types) loop
    select p.permission_key into v_key
    from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
    where rp.role_id = new.id and not public.sa_permission_allowed_for_org_type(p.permission_key, v_type)
    order by p.permission_key limit 1;
    if v_key is not null then
      raise exception 'sa_profile_org_type_incompatible: % for %', v_key, v_type using errcode = '42501';
    end if;
  end loop;
  -- A custom policy is not narrowed under an administrator grant it would make ineligible (revoke or move it first).
  if new.source = 'new' then
    select count(*) into v_holders
    from public.sa_role_assignments a
    join public.sa_organization_memberships m on m.id = a.membership_id
    join public.organizations o on o.id = m.organization_id
    where a.role_id = new.id and a.status = 'active' and (a.effective_until is null or a.effective_until > now())
      and a.source in ('manual', 'access_request')
      and (cardinality(new.applicable_org_types) = 0 or not (upper(o.org_type_code) = any(new.applicable_org_types))
           or (cardinality(new.applicable_account_types) > 0
               and not (coalesce((select c.eligibility_class from public.sa_org_type_eligibility c where c.org_type_code = upper(o.org_type_code)), '') = any(new.applicable_account_types))));
    if v_holders > 0 then
      raise exception 'sa_profile_eligibility_has_holders: %', v_holders using errcode = '42501',
        hint = 'Active grants in organization types this change would exclude must be revoked first.';
    end if;
  end if;
  perform public.sa_log_access_change(new.updated_by, 'access_profile.eligibility_changed', null, 'sa_business_role', new.id::text,
    jsonb_build_object('role_key', new.role_key,
                       'org_types_before', to_jsonb(old.applicable_org_types), 'org_types_after', to_jsonb(new.applicable_org_types),
                       'account_types_before', to_jsonb(old.applicable_account_types), 'account_types_after', to_jsonb(new.applicable_account_types)),
    null, case when new.updated_by is null then 'system' else 'user' end);
  return new;
end $$;
revoke all on function public.sa_business_role_eligibility_guard() from public, anon, authenticated;
drop trigger if exists sa_business_role_eligibility_guard on public.sa_business_roles;
create trigger sa_business_role_eligibility_guard before update of applicable_org_types, applicable_account_types on public.sa_business_roles
  for each row execute function public.sa_business_role_eligibility_guard();

-- ---------------------------------------------------------------------------
-- 6. Custom policy drafts
-- ---------------------------------------------------------------------------
create or replace function public.sa_profile_draft_eligibility_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_type text; v_key text;
begin
  if new.status = 'discarded' then return new; end if;
  for v_type in select unnest(new.applicable_org_types) loop
    if not exists (select 1 from public.sa_org_type_eligibility c where c.org_type_code = v_type and c.eligibility_class <> 'not_assignable') then
      raise exception 'sa_profile_org_type_invalid: %', v_type using hint = 'Only classified, assignable organization types can be listed.';
    end if;
    select k into v_key from unnest(new.permission_keys) k where not public.sa_permission_allowed_for_org_type(k, v_type) order by k limit 1;
    if v_key is not null then
      raise exception 'sa_profile_org_type_incompatible: % for %', v_key, v_type using errcode = '42501';
    end if;
  end loop;
  if new.status in ('in_review', 'published') and cardinality(new.applicable_org_types) = 0 then
    raise exception 'sa_profile_org_types_required' using hint = 'Choose the organization types this policy may be granted to.';
  end if;
  return new;
end $$;
revoke all on function public.sa_profile_draft_eligibility_guard() from public, anon, authenticated;
drop trigger if exists sa_profile_draft_eligibility_guard on public.sa_access_profile_drafts;
create trigger sa_profile_draft_eligibility_guard before insert or update on public.sa_access_profile_drafts
  for each row execute function public.sa_profile_draft_eligibility_guard();

-- ---------------------------------------------------------------------------
-- 7. Standard policy classification (fills empty lists only; custom policies untouched)
--    Partner use is enabled only where it is an approved decision (order-creator, Manufacturer policies — already set).
-- ---------------------------------------------------------------------------
do $classify$
declare r record;
begin
  for r in
    select * from (values
      -- Security & Access, identity and platform administration
      ('access-reviewer', array['HQ']), ('security-administrator', array['HQ']), ('security-access-full-access', array['HQ']),
      ('identity-administrator', array['HQ']), ('user-password-administrator', array['HQ']), ('profile-administrator', array['HQ']),
      ('platform-settings-full-access', array['HQ']), ('system-log-viewer', array['HQ']), ('notification-monitor-viewer', array['HQ']),
      -- HR and payroll (ESS stays HQ-only, as decided in 20261014100000)
      ('employee-self-service', array['HQ']), ('hr-manager', array['HQ']), ('hr-payroll-full-access', array['HQ']),
      ('hr-data-reset-administrator', array['HQ']), ('hr-internal-directory-viewer', array['HQ']),
      ('payroll-officer', array['HQ']), ('payroll-approver', array['HQ']), ('payroll-finance-approver', array['HQ']),
      -- Finance (the company ledger)
      ('finance-admin', array['HQ']), ('finance-full-access', array['HQ']), ('finance-gl-clerk', array['HQ']),
      ('finance-ar-clerk', array['HQ']), ('finance-ap-clerk', array['HQ']), ('finance-viewer', array['HQ']),
      ('finance-statement-approver', array['HQ']), ('finance-statement-preparer', array['HQ']), ('payment-approver', array['HQ']),
      -- Customer & Growth, Marketing, E-Commerce (cross-shop administration)
      ('customer-growth-full-access', array['HQ']), ('customer-report-viewer', array['HQ']), ('customer-messaging-manager', array['HQ']),
      ('support-inbox-administrator', array['HQ']), ('storefront-banner-manager', array['HQ']), ('loyalty-administrator', array['HQ']),
      ('roadtour-manager', array['HQ']), ('crm-viewer', array['HQ']), ('marketing-viewer', array['HQ']),
      ('ecommerce-viewer', array['HQ']), ('ecommerce-administrator', array['HQ']), ('outdoor-store-operator', array['HQ']),
      -- Supply Chain (partner use pending approval — see the eligibility document)
      ('supply-chain-full-access', array['HQ']), ('adjustment-administrator', array['HQ']), ('order-approver', array['HQ']),
      ('catalog-viewer', array['HQ']),
      ('warehouse-operator', array['HQ', 'WH']), ('warehouse-manager', array['HQ', 'WH'])
    ) as t(role_key, org_types)
  loop
    -- updated_by = null: the change is recorded as a system (migration) change, never attributed to the last editor.
    update public.sa_business_roles b set applicable_org_types = r.org_types::text[], updated_at = now(), updated_by = null
    where b.role_key = r.role_key and b.source = 'template' and cardinality(b.applicable_org_types) = 0;
  end loop;
end $classify$;

-- ---------------------------------------------------------------------------
-- 8. Read-only reports
-- ---------------------------------------------------------------------------
create or replace function public.sa_policy_eligibility_catalogue()
returns table(role_id uuid, role_key text, name text, policy_kind text, status text, org_types text[], account_types text[],
              eligible_org_types text[], ineligible jsonb)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select r.id, r.role_key, r.name, case r.source when 'template' then 'standard' else 'custom' end, r.status,
         r.applicable_org_types, r.applicable_account_types,
         coalesce((select array_agg(c.org_type_code order by c.org_type_code) from public.sa_org_type_eligibility c
                   where public.sa_policy_org_type_ineligibility(r.id, c.org_type_code) is null), '{}'),
         coalesce((select jsonb_object_agg(c.org_type_code, public.sa_policy_org_type_ineligibility(r.id, c.org_type_code))
                   from public.sa_org_type_eligibility c
                   where c.eligibility_class <> 'not_assignable' and public.sa_policy_org_type_ineligibility(r.id, c.org_type_code) is not null), '{}'::jsonb)
  from public.sa_business_roles r where r.source <> 'legacy'
  order by r.role_key
$$;
revoke all on function public.sa_policy_eligibility_catalogue() from public, anon, authenticated;
grant execute on function public.sa_policy_eligibility_catalogue() to service_role;

-- Active grants whose membership organization type is not eligible under today's rule. Report only: nothing is revoked.
create or replace function public.sa_policy_eligibility_audit()
returns table(assignment_id uuid, user_id uuid, email text, role_key text, policy_kind text, assignment_source text,
              organization_id uuid, organization_name text, org_type text, reason text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select a.id, a.user_id, u.email, r.role_key, case r.source when 'template' then 'standard' when 'legacy' then 'compatibility' else 'custom' end,
         a.source, o.id, o.org_name, o.org_type_code, public.sa_policy_org_type_ineligibility(r.id, o.org_type_code)
  from public.sa_role_assignments a
  join public.sa_business_roles r on r.id = a.role_id
  join public.sa_organization_memberships m on m.id = a.membership_id
  join public.organizations o on o.id = m.organization_id
  left join public.users u on u.id = a.user_id
  where a.status = 'active' and (a.effective_until is null or a.effective_until > now()) and r.source <> 'legacy'
    and public.sa_policy_org_type_ineligibility(r.id, o.org_type_code) is not null
  order by r.role_key, o.org_type_code, u.email
$$;
revoke all on function public.sa_policy_eligibility_audit() from public, anon, authenticated;
grant execute on function public.sa_policy_eligibility_audit() to service_role;
