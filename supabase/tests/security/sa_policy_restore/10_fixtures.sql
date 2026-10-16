-- Isolated One-click Restore fixtures (never real data). Builds on the sa_policy_eligibility fixtures:
--   o1 HQ (scope s1) | u1 legacy Super Admin | u23 Root Administrator | u3 plain HQ member (no authority)
--   u6, u32 HQ employees (recipients)
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;

-- Identity columns the restore rule reads (stand-ins; the platform users table has them).
alter table public.users add column if not exists employment_status text, add column if not exists account_status text;
update public.users set account_scope = 'portal', employment_status = 'active', account_status = 'ACTIVE';

-- A custom HQ policy whose definition changes while a grant of it is revoked (current permissions apply on restore).
insert into public.sa_business_roles(id, role_key, name, source, status, applicable_account_types, applicable_org_types) values
  ('00000000-0000-0000-0016-000000000001', 'sapr-custom', 'Restore suite custom policy', 'new', 'active', '{}', array['HQ']),
  ('00000000-0000-0000-0016-000000000002', 'sapr-retire', 'Restore suite policy to retire', 'new', 'active', '{}', array['HQ']),
  ('00000000-0000-0000-0016-000000000003', 'sapr-narrow', 'Restore suite policy to narrow', 'new', 'active', '{}', array['HQ']);
insert into public.sa_business_role_permissions(role_id, permission_id)
  select r.id, p.id from public.sa_business_roles r, public.sa_permissions p
  where r.role_key in ('sapr-custom', 'sapr-retire', 'sapr-narrow') and p.permission_key = 'inventory.stock_count.view';

create function saf.grant_id(actor int, target int, role_key text, org int, scope int, until timestamptz default null) returns uuid language sql as $$
  select public.sa_assign_role(saf.u(actor), saf.u(target), saf.role(role_key), saf.o(org), array[saf.s(scope)], null, until, null) $$;
create function saf.revoke(actor int, assignment uuid) returns text language sql as $$
  select saf.try(format($q$select public.sa_revoke_assignment(%L, %L, 'No longer needed (restore suite)')$q$, saf.u(actor), assignment)) $$;
create function saf.restore(actor int, assignment uuid) returns text language sql as $$
  select saf.try(format($q$select public.sa_restore_policy_grant(%L, %L)$q$, saf.u(actor), assignment)) $$;
create function saf.live(target int, role_key text) returns setof public.sa_role_assignments language sql stable as $$
  select * from public.sa_role_assignments where user_id = saf.u(target) and role_id = saf.role(role_key) and status = 'active' $$;
create function saf.n_live(target int, role_key text) returns bigint language sql stable as $$ select count(*) from saf.live(target, role_key) $$;
-- Every stored attribute of one assignment and its scopes (to prove a row was not touched).
create function saf.row_text(assignment uuid) returns text language sql stable as $$
  select (select to_jsonb(a) - 'restored_from_assignment_id' from public.sa_role_assignments a where a.id = assignment)::text || '|' ||
         coalesce((select string_agg(scope_id::text, ',' order by scope_id) from public.sa_assignment_scopes where assignment_id = assignment), '') $$;
grant execute on all functions in schema saf to public;
