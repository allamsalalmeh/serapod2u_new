-- Negative control: BEFORE the fix. The route's decision (organization context) allows the administrator,
-- but the database re-check with an empty context denies them -> "Forbidden".
select saf.expect(public.sa_actor_has_permission(saf.u(1), 'security.permission.manage', jsonb_build_object('organization_id', saf.o(1))),
  'route-style decision (with organization) allows the org-scoped admin');
select saf.expect(not public.sa_actor_has_permission(saf.u(1), 'security.permission.manage', '{}'::jsonb), 'empty context is DENY / MISSING_CONTEXT');
select saf.expect(saf.try($q$select * from public.sa_preview_bulk_migration_mode(saf.u(1), array['inventory.stock_count.view'], 'LEGACY_RETIRED')$q$) = 'sa_authorization_required',
  'DEFECT REPRODUCED: preview denies the allowed administrator');
select saf.expect(saf.try($q$select public.sa_set_migration_mode(saf.u(1), 'inventory.stock_count.create', 'SHADOW', 'reason long enough')$q$) = 'sa_authorization_required',
  'DEFECT REPRODUCED: the single-permission change is denied the same way');
