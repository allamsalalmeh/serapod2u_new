-- Test helpers (schema pht). Synthetic ids only.
create schema if not exists pht;

create or replace function pht.o(n int) returns uuid language sql immutable as
$$ select ('0000000a-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pht.u(n int) returns uuid language sql immutable as
$$ select ('0000000b-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;

create or replace function pht.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAILED: %', p_msg; end if;
  raise notice 'ok - %', p_msg;
end $$;

-- Runs p_sql and returns NULL on success or the SQLSTATE + message of the error.
create or replace function pht.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;

-- Sorted permission keys of a standard policy.
create or replace function pht.perms(p_role text) returns text[] language sql stable as $$
  select coalesce(array_agg(p.permission_key order by p.permission_key), '{}')
  from public.sa_business_roles b join public.sa_business_role_permissions rp on rp.role_id = b.id
  join public.sa_permissions p on p.id = rp.permission_id where b.role_key = p_role
$$;

-- Does user n hold permission k in organization 1 through the canonical S&A evaluation?
create or replace function pht.has(n int, k text, org int default 1) returns boolean language sql stable as $$
  select public.sa_actor_has_permission(pht.u(n), k, jsonb_build_object('organization_id', pht.o(org)))
$$;

-- Active assignment of role r for user n.
create or replace function pht.assignment(n int, r text) returns public.sa_role_assignments language sql stable as $$
  select a.* from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
  where a.user_id = pht.u(n) and b.role_key = r and a.status = 'active' limit 1
$$;

create or replace function pht.audit(p_action text) returns bigint language sql stable as $$
  select count(*) from public.sa_access_change_log where action = p_action
$$;
