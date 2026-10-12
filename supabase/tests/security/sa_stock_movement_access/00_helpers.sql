-- Test helpers (schema smt). Synthetic ids only: org n = 0000000a-0000-0000-0000-00000000000n style.
create schema if not exists smt;
grant usage on schema smt to authenticated, anon, service_role;

create or replace function smt.o(n int) returns uuid language sql immutable as
$$ select ('0000000a-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function smt.u(n int) returns uuid language sql immutable as
$$ select ('0000000b-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function smt.m(n int) returns uuid language sql immutable as
$$ select ('0000000c-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;

create or replace function smt.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAILED: %', p_msg; end if;
  raise notice 'ok - %', p_msg;
end $$;

-- Runs p_sql and returns NULL on success or the SQLSTATE + message of the error.
create or replace function smt.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;

-- Count of rows a query returns.
create or replace function smt.n(p_sql text) returns bigint language plpgsql as $$
declare v bigint;
begin
  execute format('select count(*) from (%s) q', p_sql) into v;
  return v;
end $$;

-- Sorted movement ids (as m-numbers) a query returns, e.g. '1,2,5'.
create or replace function smt.ids(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute format('select coalesce(string_agg((right(id::text, 12))::int::text, '','' order by (right(id::text, 12))::int), '''') from (%s) q', p_sql) into v;
  return v;
end $$;

-- PostgREST request context for user n (call, then SET ROLE authenticated in the same transaction).
create or replace function smt.as_user(n int) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', smt.u(n), 'role', 'authenticated')::text, true),
         set_config('request.jwt.claim.sub', '', true);
$$;
create or replace function smt.as_service() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true),
         set_config('request.jwt.claim.sub', '', true);
$$;

grant execute on all functions in schema smt to authenticated, anon, service_role;
