-- Staff Sales Commission fixtures (synthetic, never real data). Runs on a disposable commission_test* database restored
-- from a schema-only staging dump + the S&A catalogue (see run.sh), with the REAL user lifecycle, S&A evaluator and
-- orders triggers. Ids: 00000000-0000-0000-00cN-...
do $g$ begin if current_database() !~ '^commission_test' then raise exception 'Refusing: not a disposable commission_test* database'; end if; end $g$;

create schema if not exists hct;
create or replace function hct.u(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-00c1-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hct.o(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-00c2-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hct.b(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-00c3-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hct.p(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-00c4-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hct.ord(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-00c5-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hct.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception 'ASSERTION FAILED: %', p_msg; end if; end $$;
-- Run SQL as a PostgREST caller (role authenticated + JWT claims). Returns 'OK' or the error message.
create or replace function hct.as_user(p_uid uuid, p_sql text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p_uid)::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    execute p_sql;
    perform set_config('role', 'none', true); perform set_config('request.jwt.claims', '', true);
    return 'OK';
  exception when others then
    perform set_config('role', 'none', true); perform set_config('request.jwt.claims', '', true);
    return sqlerrm;
  end;
end $$;
create or replace function hct.val_as(p_uid uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p_uid)::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    execute p_sql into v;
  exception when others then v := 'ERROR: ' || sqlerrm;
  end;
  perform set_config('role', 'none', true); perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
grant usage on schema hct to public;
grant execute on all functions in schema hct to public;

-- Two companies. o1 HQ (Serapod), o2 its distributor, o9 another company's HQ.
insert into public.organizations(id, org_type_code, org_code, org_name) values (hct.o(1), 'HQ', 'HCTHQ', 'Commission HQ');
insert into public.organizations(id, org_type_code, org_code, org_name, parent_org_id) values (hct.o(2), 'DIST', 'HCTD1', 'Commission Distributor', hct.o(1));
insert into public.organizations(id, org_type_code, org_code, org_name) values (hct.o(9), 'HQ', 'HCTHQ9', 'Other Company HQ');

-- People (all internal employees of o1 unless noted):
--   1 HR commission administrator  2 commission approver (management)  3 report viewer (finance)
--   4 employee Fakhrul (no access)  5 employee Siti (no access)          6 HQ admin level 10, no commission grant
--   7 legacy Super Admin level 1, no commission grant                    8 other company's commission administrator (o9)
--   9 holds BOTH administrator and approver policies                     10 employee not onboarded
insert into auth.users(id, email) select hct.u(n), 'hct' || n || '@dev.com' from generate_series(1, 10) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope) values
  (hct.u(1), 'hct1@dev.com', 'Hana HR', 'GUEST', hct.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hct.u(2), 'hct2@dev.com', 'Malik Manager', 'GUEST', hct.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hct.u(3), 'hct3@dev.com', 'Farah Finance', 'GUEST', hct.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hct.u(4), 'hct4@dev.com', 'Mohamad Fakhrul Aiman Bin Zamri', 'GUEST', hct.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hct.u(5), 'hct5@dev.com', 'Siti Production', 'GUEST', hct.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hct.u(6), 'hct6@dev.com', 'HQ Admin', 'HQ', hct.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hct.u(7), 'hct7@dev.com', 'Legacy Super Admin', 'SA', hct.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hct.u(8), 'hct8@dev.com', 'Other HR', 'GUEST', hct.o(9), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hct.u(9), 'hct9@dev.com', 'Dual Role', 'GUEST', hct.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hct.u(10), 'hct10@dev.com', 'Not Onboarded', 'GUEST', hct.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal');

-- Departments (grouping comes from HR data, not hardcoded teams).
insert into public.departments(id, organization_id, dept_code, dept_name) values
  ('00000000-0000-0000-00c6-000000000001', hct.o(1), 'HCT-SALES', 'Serapod Team'),
  ('00000000-0000-0000-00c6-000000000002', hct.o(1), 'HCT-PROD', 'Production Staff');
-- Onboarding is completed by the HR onboarding flow in reality; this disposable fixture bypasses its guard.
alter table public.hr_employees disable trigger hr_employees_onboarding_guard;
update public.hr_employees set onboarding_status = 'completed', department_id = '00000000-0000-0000-00c6-000000000001', hire_date = '2024-01-01'
 where user_id in (hct.u(4), hct.u(9), hct.u(1), hct.u(2));
update public.hr_employees set onboarding_status = 'completed', department_id = '00000000-0000-0000-00c6-000000000002', hire_date = '2024-01-01'
 where user_id = hct.u(5);
alter table public.hr_employees enable trigger hr_employees_onboarding_guard;

create or replace function hct.emp(n int) returns uuid language sql stable as $$ select id from public.hr_employees where user_id = hct.u(n) $$;
grant execute on function hct.emp(int) to public;

-- Standard policies, assigned explicitly (lifecycle created the memberships).
insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason)
select x.u, b.id, m.id, 'active', 'manual', 'commission test fixture'
from (values (hct.u(1), 'commission-administrator'), (hct.u(2), 'commission-approver'), (hct.u(3), 'commission-report-viewer'),
             (hct.u(8), 'commission-administrator'), (hct.u(9), 'commission-administrator'), (hct.u(9), 'commission-approver')) x(u, k)
join public.sa_business_roles b on b.role_key = x.k
join public.sa_organization_memberships m on m.user_id = x.u and m.status = 'active';
-- As the Grant flow does: each manual grant is scoped to the holder's own organization.
insert into public.sa_assignment_scopes(assignment_id, scope_id)
select a.id, d.id from public.sa_role_assignments a
join public.sa_organization_memberships m on m.id = a.membership_id
join public.sa_scope_definitions d on d.organization_id = m.organization_id and d.scope_type = 'organization' and d.scope_value = m.organization_id::text
where a.source = 'manual' and a.assignment_reason = 'commission test fixture';

-- Catalogue: Cellera has TWO brands (Hero, Zero); Ellbow; Sera Outdoor; and a brand mapped to no Business Unit.
insert into public.product_categories(id, category_code, category_name) values ('00000000-0000-0000-00c7-000000000001', 'HCTCAT', 'HCT Category');
insert into public.brands(id, brand_code, brand_name) values
  (hct.b(1), 'HCT-CEL-H', 'Cellera Hero'), (hct.b(2), 'HCT-CEL-Z', 'Cellera Zero'), (hct.b(3), 'HCT-ELL', 'Ellbow'),
  (hct.b(4), 'HCT-SER', 'Sera Outdoor'), (hct.b(5), 'HCT-UNM', 'Unmapped Brand');
insert into public.products(id, category_id, brand_id, product_code, product_name)
select hct.p(n), '00000000-0000-0000-00c7-000000000001', hct.b(n), 'HCT-P' || n, 'HCT Product ' || n from generate_series(1, 5) n;
insert into public.product_variants(id, product_id, variant_code, variant_name)
select hct.p(n), hct.p(n), 'HCT-V' || n, 'HCT Variant ' || n from generate_series(1, 5) n;

-- Unrelated orders triggers (inventory allocation, notifications, warehouse guard, messaging timeline) are disabled in
-- this disposable database only; the status ledger trigger and the order-date/insert triggers stay on.
alter table public.orders disable trigger on_order_status_change;
alter table public.orders disable trigger trg_order_cancellation;
alter table public.orders disable trigger trigger_order_status_notification;
alter table public.orders disable trigger trg_orders_fulfillment_warehouse_guard;
alter table public.orders disable trigger trg_messaging_order_submit_timeline;

-- Helper: create a D2H order (distributor o2 buys from HQ o1) with lines (brand n → value), as draft.
create or replace function hct.new_order(p_n int, p_type text, p_lines jsonb) returns uuid language plpgsql as $$
declare l jsonb;
begin
  insert into public.orders(id, order_no, order_type, company_id, buyer_org_id, seller_org_id, status, created_by, order_date)
  values (hct.ord(p_n), 'HCT-SO' || lpad(p_n::text, 3, '0'), p_type::public.order_type, hct.o(1),
          case when p_type = 'H2M' then hct.o(1) else hct.o(2) end, case when p_type = 'H2M' then hct.o(2) else hct.o(1) end,
          'draft', hct.u(6), date '2026-09-20');
  for l in select * from jsonb_array_elements(p_lines) loop
    insert into public.order_items(order_id, product_id, variant_id, qty, unit_price, company_id)
    values (hct.ord(p_n), hct.p((l->>'brand')::int), hct.p((l->>'brand')::int), coalesce((l->>'qty')::int, 1), (l->>'price')::numeric, hct.o(1));
  end loop;
  return hct.ord(p_n);
end $$;
-- Workflow-equivalent transitions (orders_approve sets approved_at = now(); the instant is supplied here).
create or replace function hct.submit(p_n int) returns void language sql as $$ update public.orders set status = 'submitted' where id = hct.ord(p_n) $$;
create or replace function hct.approve(p_n int, p_at timestamptz) returns void language sql as $$
  update public.orders set status = 'approved', approved_by = hct.u(6), approved_at = p_at where id = hct.ord(p_n) $$;
create or replace function hct.set_status(p_n int, p_status text) returns void language sql as $$
  update public.orders set status = p_status::public.order_status where id = hct.ord(p_n) $$;
