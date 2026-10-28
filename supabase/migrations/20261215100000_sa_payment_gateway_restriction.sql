-- ============================================================================
-- Security & Access — Payment Gateway administration leaves Customer & Growth Full Access
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database.
--
-- Finding (S&A finalization audit, 2026-10-23):
--   payment_gateway_settings (provider secret keys, live/sandbox switch) is gated in RLS by ecommerce.channel.manage
--   (20260928120000). customer-growth-full-access (20261009100000) lists ecommerce.channel.manage, so every holder of
--   the ordinary Customer & Growth module policy can read and change payment provider credentials. The brief requires
--   Payment Gateway configuration to be a separate privileged permission, never implied by ordinary E-Commerce access.
--
-- Change:
--   1. New Standard Policy 'ecommerce-payment-gateway-administrator' (HQ, internal accounts): ecommerce.channel.manage
--      only. Assigned to nobody.
--   2. ecommerce.channel.manage is removed from customer-growth-full-access through the owner-only, audited
--      sa_narrow_standard_policy() (20261110100000) and recorded as a reviewed exclusion (drift stays clean).
--   3. Current Customer & Growth Full Access holders are NOT transferred to the new policy: their gateway access came
--      from the module bundle, which is exactly the unintended access this closes. Each removal is audited per holder
--      (assignment.profile_changed). An administrator grants 'E-Commerce Payment Gateway Administrator' explicitly
--      to whoever should configure payment providers. Root Access is unaffected (global, every active permission).
--   The application already decides the Payment Gateway screens on ecommerce.channel.manage (nav-access.ts), so no
--   code deployment has to precede or follow this migration.
--
-- Not changed: permission keys, migration modes, the RLS gate, compatibility (legacy-*) roles, other policies.
-- Note: legacy-sa still lists ecommerce.channel.manage (its compatibility rule); see 20261215110000 for the legacy
-- cutover controls.
--
-- Order: requires 20261009100000 + 20261110100000 (sa_narrow_standard_policy, excluded_keys). Repeat-safe.
--
-- Rollback:
--   update public.sa_standard_policy_coverage set excluded_keys = array_remove(excluded_keys, 'ecommerce.channel.manage')
--    where role_key = 'customer-growth-full-access';
--   select public.sa_extend_standard_policy('customer-growth-full-access', array['ecommerce.channel.manage'],
--     'Rollback of 20261215100000: payment gateway administration back in Customer & Growth Full Access');
--   -- then revoke any assignment of the new policy in People & Access and delete it as the owner:
--   -- delete from public.sa_business_roles where role_key = 'ecommerce-payment-gateway-administrator' and source = 'template';
--   (Audit rows stay: they record what happened.)
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.sa_narrow_standard_policy(text,text[],text)') is null then
    raise exception 'sa_prerequisite_missing: sa_narrow_standard_policy (20261110100000)';
  end if;
  if not exists (select 1 from public.sa_permissions where permission_key = 'ecommerce.channel.manage' and status = 'active') then
    raise exception 'sa_prerequisite_missing: permission ecommerce.channel.manage';
  end if;
  if not exists (select 1 from public.sa_business_roles where role_key = 'customer-growth-full-access' and source = 'template') then
    raise exception 'sa_prerequisite_missing: customer-growth-full-access (20261009100000)';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. The dedicated policy (explicit list; not assigned to anyone)
-- ---------------------------------------------------------------------------
do $seed$
declare
  v_role uuid;
  v_existing text;
begin
  select b.source into v_existing from public.sa_business_roles b where b.role_key = 'ecommerce-payment-gateway-administrator';
  if v_existing is not null and v_existing <> 'template' then
    raise exception 'sa_group_policy_key_conflict: ecommerce-payment-gateway-administrator already exists as a non-standard role';
  end if;
  insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
  values ('ecommerce-payment-gateway-administrator', 'E-Commerce Payment Gateway Administrator',
          'Privileged: configures checkout payment providers (provider credentials, sandbox/live). Kept out of Customer & Growth Full Access and E-Commerce Administrator. Grant only to administrators responsible for payment configuration.',
          'template', 'active', array['internal'], array['HQ'])
  on conflict (role_key) do nothing
  returning id into v_role;
  if v_role is null then return; end if;   -- already present: never modified or expanded here

  insert into public.sa_business_role_permissions(role_id, permission_id)
  select v_role, p.id from public.sa_permissions p where p.permission_key = 'ecommerce.channel.manage' and p.status = 'active';
  insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
  values (v_role, 'ecommerce-payment-gateway-administrator', 'customer_growth', array['ecommerce'], array['ecommerce.channel.manage']);
  perform public.sa_log_access_change(null, 'access_profile.standard_seeded', null, 'sa_business_role', v_role::text,
    jsonb_build_object('role_key', 'ecommerce-payment-gateway-administrator', 'module', 'customer_growth', 'permission_count', 1),
    'Standard group policy seeded (not assigned to anyone)', 'system');
end $seed$;

-- ---------------------------------------------------------------------------
-- 2. Report, then remove the key from Customer & Growth Full Access (audited per holder by the function)
-- ---------------------------------------------------------------------------
do $narrow$
declare
  v_holders integer;
  v_result jsonb;
begin
  select count(distinct h.user_id) into v_holders
  from public.sa_business_roles b
  cross join lateral public.sa_profile_active_holders(b.id) h
  where b.role_key = 'customer-growth-full-access' and b.source = 'template'
    and exists (select 1 from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
                where rp.role_id = b.id and p.permission_key = 'ecommerce.channel.manage');
  raise notice 'customer-growth-full-access holders losing ecommerce.channel.manage through this policy: %', v_holders;
  v_result := public.sa_narrow_standard_policy('customer-growth-full-access', array['ecommerce.channel.manage'],
    'Payment Gateway administration is granted only through E-Commerce Payment Gateway Administrator, never through Customer & Growth Full Access (20261215100000).');
  raise notice 'sa_narrow_standard_policy: %', v_result;
end $narrow$;

update public.sa_business_roles
   set description = 'Every Customer & Growth permission: CRM, loyalty and rewards, messaging and support (including support administration), RoadTour, marketing and campaigns, the outdoor store and e-commerce. Payment Gateway configuration is a separate policy (E-Commerce Payment Gateway Administrator).',
       updated_at = now(), updated_by = null
 where role_key = 'customer-growth-full-access' and source = 'template'
   and description not like '%Payment Gateway configuration is a separate policy%';

-- ---------------------------------------------------------------------------
-- 3. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare v_bad text;
begin
  -- No module Full Access policy (and no E-Commerce Administrator) holds payment gateway administration.
  select string_agg(b.role_key, ', ') into v_bad
  from public.sa_business_roles b join public.sa_business_role_permissions rp on rp.role_id = b.id
  join public.sa_permissions p on p.id = rp.permission_id
  where b.source = 'template' and p.permission_key = 'ecommerce.channel.manage'
    and b.role_key <> 'ecommerce-payment-gateway-administrator';
  if v_bad is not null then raise exception 'postcondition: standard policies still hold ecommerce.channel.manage: %', v_bad; end if;

  if (select array_agg(p.permission_key order by p.permission_key) from public.sa_business_roles b
      join public.sa_business_role_permissions rp on rp.role_id = b.id join public.sa_permissions p on p.id = rp.permission_id
      where b.role_key = 'ecommerce-payment-gateway-administrator' and b.source = 'template' and b.status = 'active')
     is distinct from array['ecommerce.channel.manage'] then
    raise exception 'postcondition: ecommerce-payment-gateway-administrator permission set differs';
  end if;

  if exists (select 1 from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
             where b.role_key = 'ecommerce-payment-gateway-administrator') then
    raise exception 'postcondition: a migration must not assign ecommerce-payment-gateway-administrator';
  end if;

  if exists (select 1 from public.sa_standard_policy_drift() d
             where d.role_key = 'customer-growth-full-access' and 'ecommerce.channel.manage' = any(d.catalogue_not_covered)) then
    raise exception 'postcondition: drift still reports ecommerce.channel.manage for customer-growth-full-access';
  end if;
end $post$;
