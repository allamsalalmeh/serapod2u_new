-- ISOLATED DATABASE ONLY. Creates synthetic schema fixtures; never run on shared staging.
\set ON_ERROR_STOP on
create role anon;
create role authenticated;
create role service_role;
create function public.fixture_id(text) returns uuid language sql immutable as $$ select md5($1)::uuid $$;
create table public.users(id uuid primary key,email text,role_code text,is_active boolean);
create table public.sa_business_roles(id uuid primary key,role_key text,source text,status text);
create table public.sa_permissions(id uuid primary key,permission_key text,audit_sensitivity text,status text);
create table public.sa_business_role_permissions(role_id uuid,permission_id uuid);
create table public.sa_organization_memberships(id uuid primary key,organization_id uuid,status text,effective_from timestamptz,effective_until timestamptz);
create table public.sa_role_assignments(id uuid primary key,user_id uuid,membership_id uuid,role_id uuid,status text,effective_from timestamptz,effective_until timestamptz);
create table public.sa_scope_definitions(id uuid primary key,scope_type text,scope_value text,status text);
create table public.sa_assignment_scopes(assignment_id uuid,scope_id uuid);
create function public.sa_actor_is_root(uuid) returns boolean language sql stable as $$ select $1=public.fixture_id('root') $$;
-- Existing signature, matching the already-applied dependency. Actual tested implementation is the migration below.
create function public.sa_legacy_cutover_impact(text default null)
returns table(user_id uuid,email text,role_code text,compat_role_key text,assignment_id uuid,organization_id uuid,permission_key text,sensitive boolean,covered_by text[],root_access boolean,would_lose boolean)
language sql stable as $$ select null::uuid,null::text,null::text,null::text,null::uuid,null::uuid,null::text,null::boolean,null::text[],null::boolean,null::boolean where false $$;
\ir ../../migrations/20261216100000_sa_legacy_preview_scope_coverage.sql
insert into public.sa_business_roles values
 (fixture_id('legacy'),'legacy-user','legacy','active'),(fixture_id('replacement'),'ordinary-viewer','new','active'),(fixture_id('retired'),'retired-viewer','new','deprecated'),(fixture_id('retired-legacy'),'legacy-shop','legacy','deprecated');
insert into public.sa_permissions values (fixture_id('permission'),'supply_chain.order.view','ordinary','active');
insert into public.sa_business_role_permissions select id,fixture_id('permission') from public.sa_business_roles;
insert into public.sa_scope_definitions values
 (fixture_id('org-scope'),'organization','org-a','active'),(fixture_id('narrow'),'warehouse','wh-a','active'),(fixture_id('other'),'organization','org-b','active'),(fixture_id('inactive-scope'),'organization','org-a','inactive');
insert into public.users
select fixture_id(x),x||'@fixture.invalid','USER',x<>'inactive-user'
from unnest(array['covered','narrow','wrong-org','expired','revoked','retired-policy','inactive-scope','inactive-member','inactive-user','root','retired-legacy','multiple-scopes']) x;
insert into public.sa_organization_memberships
select fixture_id(email||'-membership'),fixture_id('org-a'),case when email like 'inactive-member@%' then 'inactive' else 'active' end,null,null from public.users;
insert into public.sa_role_assignments
select fixture_id(u.email||'-legacy'),u.id,m.id,case when u.email like 'retired-legacy@%' then fixture_id('retired-legacy') else fixture_id('legacy') end,'active',null,null
from public.users u join public.sa_organization_memberships m on m.id=fixture_id(u.email||'-membership');
insert into public.sa_assignment_scopes select a.id,fixture_id('org-scope') from public.sa_role_assignments a;
insert into public.sa_assignment_scopes select a.id,fixture_id('narrow') from public.sa_role_assignments a join public.users u on u.id=a.user_id where u.email like 'multiple-scopes@%';
insert into public.sa_role_assignments
select fixture_id(u.email||'-replacement'),u.id,m.id,case when u.email like 'retired-policy@%' then fixture_id('retired') else fixture_id('replacement') end,
 case when u.email like 'revoked@%' then 'revoked' else 'active' end,null,case when u.email like 'expired@%' then now()-interval '1 hour' else null end
from public.users u join public.sa_organization_memberships m on m.id=fixture_id(u.email||'-membership');
insert into public.sa_assignment_scopes
select a.id,fixture_id(case when u.email like 'narrow@%' then 'narrow' when u.email like 'wrong-org@%' then 'other' when u.email like 'inactive-scope@%' then 'inactive-scope' else 'org-scope' end)
from public.sa_role_assignments a join public.users u on u.id=a.user_id where a.id=fixture_id(u.email||'-replacement');
do $$ declare n integer; begin
 select count(*) into n from public.sa_legacy_cutover_impact('legacy-user');
 if n<>9 then raise exception 'Expected 9 active users/policies in preview, got %',n; end if;
 if exists(select 1 from public.sa_legacy_cutover_impact('legacy-user') where email in ('covered@fixture.invalid','root@fixture.invalid') and would_lose) then raise exception 'Equivalent scope or Root Access incorrectly lost'; end if;
 select count(*) into n from public.sa_legacy_cutover_impact('legacy-user') where would_lose;
 if n<>7 then raise exception 'Expected 7 proven replacement gaps, got %',n; end if;
 if not exists(select 1 from public.sa_legacy_cutover_impact('legacy-user') where email='multiple-scopes@fixture.invalid' and would_lose) then raise exception 'Partial scope replacement incorrectly counted'; end if;
 if has_function_privilege('authenticated','public.sa_legacy_cutover_impact(text)','execute') or has_function_privilege('anon','public.sa_legacy_cutover_impact(text)','execute') then raise exception 'Preview exposed'; end if;
 if not has_function_privilege('service_role','public.sa_legacy_cutover_impact(text)','execute') then raise exception 'Service preview missing'; end if;
 if public.sa_legacy_preview_version()<>'20261216100000' then raise exception 'Version missing'; end if;
end $$;
select 'PASS: scope containment, inactive/expired/revoked/retired exclusions, Root separation, and RPC privilege boundaries' as result;
