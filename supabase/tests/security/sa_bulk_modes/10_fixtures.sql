-- Fixtures: a "stock count" style group of 30 permissions (26 NEW_ENFORCED + 4 SHADOW, all ready),
-- one not-ready permission, an unrelated finance permission, and the security.permission.manage permission.
insert into public.users(id, is_active) values
  ('00000000-0000-0000-0000-000000000001', true),   -- admin (legacy super admin)
  ('00000000-0000-0000-0000-000000000002', true),   -- plain user, no authority
  ('00000000-0000-0000-0000-000000000003', false);  -- inactive admin
insert into public.saf_legacy_admins values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000003');

insert into public.sa_permissions(permission_key)
  select 'inventory.sc' || lpad(i::text, 2, '0') || '.view' from generate_series(1, 30) i;
insert into public.sa_permissions(permission_key) values ('inventory.notready.view'), ('finance.ledger.view'), ('security.permission.manage'), ('inventory.solo.view');
insert into public.sa_migration_modes(permission_key, mode)
  select 'inventory.sc' || lpad(i::text, 2, '0') || '.view', case when i <= 26 then 'NEW_ENFORCED' else 'SHADOW' end from generate_series(1, 30) i;
insert into public.sa_migration_modes(permission_key, mode) values
  ('inventory.notready.view', 'SHADOW'), ('finance.ledger.view', 'SHADOW'), ('security.permission.manage', 'SHADOW'), ('inventory.solo.view', 'SHADOW');
insert into public.sa_enforcement_readiness(permission_key)
  select 'inventory.sc' || lpad(i::text, 2, '0') || '.view' from generate_series(1, 30) i;
insert into public.sa_enforcement_readiness(permission_key) values ('finance.ledger.view'), ('security.permission.manage'), ('inventory.solo.view');

create function saf.grp() returns text[] language sql stable as $$
  select array_agg('inventory.sc' || lpad(i::text, 2, '0') || '.view' order by i) from generate_series(1, 30) i $$;
create function saf.modes(p_keys text[]) returns jsonb language sql stable as $$
  select jsonb_object_agg(permission_key, mode) from public.sa_migration_modes where permission_key = any(p_keys) $$;
create function saf.audit_rows(p_action text default 'migration_mode.changed') returns bigint language sql stable as $$
  select count(*) from public.sa_access_change_log where action = p_action $$;
