-- Staff Sales Commission scenarios. Each block raises 'ASSERTION FAILED: …' on the first wrong result.
\set ON_ERROR_STOP 1

-- ── 1/2. Cycle boundaries and Malaysia timezone ─────────────────────────────
do $t$
declare b record;
begin
  select * into b from public.hr_commission_cycle_bounds('2026-10-01', 28);
  perform hct.expect(b.start_at = timestamptz '2026-09-28 00:00:00+08', 'Oct cycle starts 28 Sep 00:00 MYT');
  perform hct.expect(b.end_at = timestamptz '2026-10-28 00:00:00+08', 'Oct cycle ends (exclusive) 28 Oct 00:00 MYT');
  perform hct.expect(b.start_at = timestamptz '2026-09-27 16:00:00+00', 'MYT start is 16:00 UTC the previous day');
  select * into b from public.hr_commission_cycle_bounds('2026-01-01', 28);
  perform hct.expect(b.start_at = timestamptz '2025-12-28 00:00:00+08', 'January cycle crosses the year');
  select * into b from public.hr_commission_cycle_bounds('2026-02-01', 1);
  perform hct.expect(b.start_at = timestamptz '2026-02-01 00:00+08' and b.end_at = timestamptz '2026-03-01 00:00+08', 'calendar month');
  -- Brief examples: 27 Sep → September, 28 Sep → October, 27 Oct → October, 29 Oct → November.
  perform hct.expect(public.hr_commission_period_for('2026-09-27 23:59:59.999+08', 28) = '2026-09-01', '27 Sep 23:59:59 MYT → Sep');
  perform hct.expect(public.hr_commission_period_for('2026-09-28 00:00:00+08', 28) = '2026-10-01', '28 Sep 00:00 MYT → Oct');
  perform hct.expect(public.hr_commission_period_for('2026-10-27 12:00+08', 28) = '2026-10-01', '27 Oct → Oct');
  perform hct.expect(public.hr_commission_period_for('2026-10-29 09:00+08', 28) = '2026-11-01', '29 Oct → Nov');
  -- 27 Sep 17:00 UTC is already 28 Sep 01:00 in Kuala Lumpur.
  perform hct.expect(public.hr_commission_period_for('2026-09-27 17:00:00+00', 28) = '2026-10-01', 'UTC instant judged in MYT');
  perform hct.expect(public.hr_commission_period_for('2026-12-29 10:00+08', 28) = '2027-01-01', 'Dec 29 → next year Jan');
  -- Rounding rule (half away from zero, 2 dp) on the brief's example.
  perform hct.expect(round(1607784.00 * 0.120 / 100, 2) = 1929.34, 'RM1,607,784.00 × 0.120% = RM1,929.34');
  perform hct.expect(round(750.00 * 0.25 / 100, 2) = 1.88, '1.875 rounds to 1.88');
  perform hct.expect(round(-750.00 * 0.25 / 100, 2) = -1.88, '-1.875 rounds to -1.88');
  raise notice 'PASS 1-2 cycle boundaries, timezone, rounding';
end $t$;

-- ── 15. Authorization: nobody holds commission access implicitly ───────────
do $t$
declare a jsonb;
begin
  a := hct.val_as(hct.u(6), 'select public.hr_commission_my_access()')::jsonb;
  perform hct.expect(not (a->>'hr.commission.view')::boolean and not (a->>'reporting.commission.view')::boolean, 'HQ admin level 10 has no commission access by default: ' || a::text);
  a := hct.val_as(hct.u(7), 'select public.hr_commission_my_access()')::jsonb;
  perform hct.expect(not (a->>'hr.commission.view')::boolean, 'legacy Super Admin without a grant has no commission access in S&A mode: ' || a::text);
  a := hct.val_as(hct.u(4), 'select public.hr_commission_my_access()')::jsonb;
  perform hct.expect(not (a->>'hr.commission.view')::boolean and not (a->>'reporting.commission.view')::boolean, 'employee has none');
  a := hct.val_as(hct.u(1), 'select public.hr_commission_my_access()')::jsonb;
  perform hct.expect((a->>'hr.commission.manage')::boolean and not (a->>'hr.commission.approve')::boolean, 'administrator manages, cannot approve: ' || a::text);
  a := hct.val_as(hct.u(2), 'select public.hr_commission_my_access()')::jsonb;
  perform hct.expect((a->>'hr.commission.approve')::boolean and not (a->>'hr.commission.manage')::boolean, 'approver approves, cannot manage');
  a := hct.val_as(hct.u(3), 'select public.hr_commission_my_access()')::jsonb;
  perform hct.expect((a->>'reporting.commission.export')::boolean and not (a->>'hr.commission.view')::boolean, 'report viewer');
  perform hct.expect(hct.as_user(hct.u(6), $$select public.hr_commission_save_business_unit(null, 'CELLERA', 'Cellera', null, true, 'setup test')$$) like '%sa_authorization_required%', 'HQ admin cannot create BU');
  perform hct.expect(hct.as_user(hct.u(3), $$select public.hr_commission_save_business_unit(null, 'CELLERA', 'Cellera', null, true, 'setup test')$$) like '%sa_authorization_required%', 'report viewer cannot create BU');
  perform hct.expect(hct.as_user(hct.u(1), $$insert into public.hr_commission_business_units(company_id, code, name) values ('00000000-0000-0000-00c2-000000000001', 'X1', 'Direct')$$) like '%permission denied%', 'no direct DML for authenticated');
  raise notice 'PASS 15 default-deny authorization';
end $t$;

-- ── Setup by the administrator: Business Units, brand mapping, eligibility, rate requests ──
do $t$
begin
  perform hct.expect(hct.as_user(hct.u(1), $$select public.hr_commission_save_business_unit(null, 'CELLERA', 'Cellera', null, true, 'initial setup')$$) = 'OK', 'create Cellera');
  perform hct.expect(hct.as_user(hct.u(1), $$select public.hr_commission_save_business_unit(null, 'ELLBOW', 'Ellbow', null, true, 'initial setup')$$) = 'OK', 'create Ellbow');
  perform hct.expect(hct.as_user(hct.u(1), $$select public.hr_commission_save_business_unit(null, 'SERA_OUTDOOR', 'Sera Outdoor', null, true, 'initial setup')$$) = 'OK', 'create Sera Outdoor');
  perform hct.expect(hct.as_user(hct.u(8), $$select public.hr_commission_save_business_unit(null, 'CELLERA', 'Other Co Cellera', null, true, 'initial setup')$$) = 'OK', 'other company has its own BU namespace');
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_map_brand((select id from public.hr_commission_business_units where code='CELLERA' and company_id=%L), %L, '2026-08-01', 'brand map')$$, hct.o(1), hct.b(1))) = 'OK', 'map Cellera Hero');
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_map_brand((select id from public.hr_commission_business_units where code='CELLERA' and company_id=%L), %L, '2026-08-01', 'brand map')$$, hct.o(1), hct.b(2))) = 'OK', 'map Cellera Zero');
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_map_brand((select id from public.hr_commission_business_units where code='ELLBOW' and company_id=%L), %L, '2026-08-01', 'brand map')$$, hct.o(1), hct.b(3))) = 'OK', 'map Ellbow');
  -- A brand belongs to one BU at a time.
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_map_brand((select id from public.hr_commission_business_units where code='ELLBOW' and company_id=%L), %L, '2026-09-01', 'brand map')$$, hct.o(1), hct.b(1))) like '%no_overlap%', 'brand cannot map to two BUs on the same day');

  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_set_eligibility(%L, true, 'sales team member')$$, hct.emp(4))) = 'OK', 'Fakhrul eligible');
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_set_eligibility(%L, true, 'production staff')$$, hct.emp(5))) = 'OK', 'Siti eligible');
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_set_eligibility(%L, true, 'not onboarded')$$, hct.emp(10))) like '%hr_onboarding_pending%', 'not-onboarded employee refused');
  perform hct.expect(hct.as_user(hct.u(8), format($$select public.hr_commission_set_eligibility(%L, true, 'cross company')$$, hct.emp(4))) like '%sa_authorization_required%', 'other company cannot touch our employee');

  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_request_rate(%L, (select id from public.hr_commission_business_units where code='CELLERA' and company_id=%L), 0.12000, '2026-08-01', null, 'initial rate')$$, hct.emp(4), hct.o(1))) = 'OK', 'request Fakhrul Cellera');
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_request_rate(%L, (select id from public.hr_commission_business_units where code='ELLBOW' and company_id=%L), 0.05, '2026-08-01', null, 'initial rate')$$, hct.emp(4), hct.o(1))) = 'OK', 'request Fakhrul Ellbow');
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_request_rate(%L, (select id from public.hr_commission_business_units where code='CELLERA' and company_id=%L), 0.22780, '2026-08-01', null, 'initial rate')$$, hct.emp(5), hct.o(1))) = 'OK', 'request Siti Cellera');
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_request_rate(%L, (select id from public.hr_commission_business_units where code='CELLERA' and company_id=%L), 0.123456, '2026-08-01', null, 'too precise')$$, hct.emp(5), hct.o(1))) like '%hr_commission_rate_invalid%', 'more than 5 decimals refused');
  perform hct.expect((select count(*) from public.hr_employee_commission_rules) = 0, 'requests are not effective rules');
  raise notice 'PASS setup: BUs, brand mapping, eligibility, rate requests';
end $t$;

-- ── 7/8. Rate approval: maker-checker, multiple BUs, effective-dated change ──
do $t$
declare r uuid;
begin
  -- The administrator lacks approve; the dual-role holder approves nothing they requested.
  select id into r from public.hr_employee_commission_rule_requests where employee_id = hct.emp(4) order by requested_at limit 1;
  perform hct.expect(hct.as_user(hct.u(1), format('select public.hr_commission_decide_rule_request(%L, true, null)', r)) like '%sa_authorization_required%', 'administrator cannot approve');
  for r in select id from public.hr_employee_commission_rule_requests where status = 'pending' loop
    perform hct.expect(hct.as_user(hct.u(2), format('select public.hr_commission_decide_rule_request(%L, true, %L)', r, 'approved')) = 'OK', 'approver approves rate');
  end loop;
  perform hct.expect((select count(*) from public.hr_employee_commission_rules where employee_id = hct.emp(4)) = 2, 'Fakhrul has two BU rates');
  perform hct.expect((select rate_percent from public.hr_employee_commission_rules where employee_id = hct.emp(5)) = 0.22780, 'Siti 0.22780% kept exactly');

  -- Dual-role user requests a change, then cannot approve it.
  perform hct.expect(hct.as_user(hct.u(9), format($$select public.hr_commission_request_rate(%L, (select id from public.hr_commission_business_units where code='CELLERA' and company_id=%L), 0.25, '2026-10-20', null, 'promotion to senior')$$, hct.emp(5), hct.o(1))) = 'OK', 'dual-role request');
  select id into r from public.hr_employee_commission_rule_requests where status = 'pending' and requested_by = hct.u(9);
  perform hct.expect(hct.as_user(hct.u(9), format('select public.hr_commission_decide_rule_request(%L, true, null)', r)) like '%sod_violation%', 'requester never approves own request');
  perform hct.expect(hct.as_user(hct.u(2), format('select public.hr_commission_decide_rule_request(%L, true, %L)', r, 'ok')) = 'OK', 'other approver approves');
  perform hct.expect((select effective_to from public.hr_employee_commission_rules where employee_id = hct.emp(5) and rate_percent = 0.22780) = '2026-10-19', 'previous rate closed the day before');
  -- Fakhrul Cellera from 1 Jan 2027 = 0.150% (brief example).
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_request_rate(%L, (select id from public.hr_commission_business_units where code='CELLERA' and company_id=%L), 0.15, '2027-01-01', null, 'annual review 2027')$$, hct.emp(4), hct.o(1))) = 'OK', '2027 request');
  select id into r from public.hr_employee_commission_rule_requests where status = 'pending';
  perform hct.expect(hct.as_user(hct.u(2), format('select public.hr_commission_decide_rule_request(%L, true, %L)', r, 'ok')) = 'OK', 'approve 2027');
  perform hct.expect((select effective_to from public.hr_employee_commission_rules where employee_id = hct.emp(4) and rate_percent = 0.12) = '2026-12-31', '0.120% effective until 31 Dec 2026');
  -- A second rate starting on the same date is an overlap, never silently merged.
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_request_rate(%L, (select id from public.hr_commission_business_units where code='CELLERA' and company_id=%L), 0.2, '2027-01-01', null, 'duplicate rate')$$, hct.emp(4), hct.o(1))) = 'OK', 'overlapping request recorded');
  select id into r from public.hr_employee_commission_rule_requests where status = 'pending';
  perform hct.expect(hct.as_user(hct.u(2), format('select public.hr_commission_decide_rule_request(%L, true, null)', r)) like '%hr_commission_rate_overlap%', 'overlap refused');
  perform hct.expect(hct.as_user(hct.u(2), format('select public.hr_commission_decide_rule_request(%L, false, %L)', r, 'duplicate of approved rate')) = 'OK', 'reject with reason');
  -- Employee concerned never approves their own rate (Siti given approver for this check would still be refused).
  raise notice 'PASS 7-8 multiple BU rates, effective-dated changes, maker-checker';
end $t$;

-- ── Orders (synthetic). Approval instants are what orders_approve writes. ──
select hct.new_order(1, 'D2H', '[{"brand":1,"price":1000.00}]');                         -- Sep 27 → September
select hct.new_order(2, 'D2H', '[{"brand":1,"price":1607784.00}]');                      -- Sep 28 00:00 → October
select hct.new_order(3, 'D2H', '[{"brand":2,"price":500.00},{"brand":3,"price":2000.00},{"brand":5,"price":300.00}]'); -- mixed BU, Oct 27 23:59:59
select hct.new_order(4, 'D2H', '[{"brand":1,"price":999.00}]');                          -- Oct 29 → November
select hct.new_order(5, 'D2H', '[{"brand":1,"price":7777.00}]');                         -- approved Oct, cancelled before calc
select hct.new_order(6, 'D2H', '[{"brand":1,"price":8888.00}]');                         -- submitted only
select hct.new_order(9, 'D2H', '[{"brand":3,"price":400.00}]');                          -- approved Oct 2, reverted, re-approved Nov 3
select hct.new_order(10, 'H2M', '[{"brand":1,"price":5555.00}]');                        -- H2M: not commissionable
select hct.new_order(11, 'D2H', '[{"brand":1,"qty":5,"price":50.00}]');                  -- Oct 21, then warehouse_packed
select hct.submit(n) from unnest(array[1,2,3,4,5,6,9,10,11]) n;
select hct.approve(1, '2026-09-27 15:00+08');
select hct.approve(2, '2026-09-28 00:00:00+08');
select hct.approve(3, '2026-10-27 23:59:59+08');
select hct.approve(4, '2026-10-29 09:00+08');
select hct.approve(5, '2026-10-10 10:00+08'); select hct.set_status(5, 'cancelled');
select hct.approve(9, '2026-10-02 10:00+08'); select hct.submit(9); select hct.approve(9, '2026-11-03 10:00+08');
select hct.approve(10, '2026-10-05 10:00+08');
select hct.approve(11, '2026-10-21 10:00+08'); select hct.set_status(11, 'warehouse_packed');
-- Legacy orders (approved before the ledger existed): SO007 has a recorded approved_at, SO008 has none.
alter table public.orders disable trigger order_status_events_capture;
select hct.new_order(7, 'D2H', '[{"brand":1,"price":100.00}]');
select hct.new_order(8, 'D2H', '[{"brand":1,"price":4444.00}]');
update public.orders set status = 'approved', approved_at = '2026-10-05 10:00+08', order_date = '2026-10-05' where id = hct.ord(7);
update public.orders set status = 'approved', approved_at = null, order_date = '2026-10-06' where id = hct.ord(8);
alter table public.orders enable trigger order_status_events_capture;

-- ── 3/6. Approval ledger: first approval, repeated approvals, provenance ──
do $t$
declare a record;
begin
  perform hct.expect((select count(*) from public.order_status_events where order_id = hct.ord(9) and to_status = 'approved') = 2, 'both approvals of SO009 recorded');
  perform hct.expect((select count(*) from public.order_status_events where order_id = hct.ord(9) and is_first_approval) = 1, 'exactly one first approval');
  select * into a from public.order_first_approval(hct.ord(9));
  perform hct.expect(a.approved_at = timestamptz '2026-10-02 10:00+08' and a.source = 'approval_event', 'SO009 first approval is 2 Oct, not the re-approval');
  perform hct.expect((select approved_at from public.orders where id = hct.ord(9)) = timestamptz '2026-11-03 10:00+08', 'orders.approved_at holds the latest approval');
  select * into a from public.order_first_approval(hct.ord(7));
  perform hct.expect(a.approved_at = timestamptz '2026-10-05 10:00+08' and a.source = 'recorded_approved_at', 'legacy recorded timestamp, labelled');
  select * into a from public.order_first_approval(hct.ord(8));
  perform hct.expect(a.approved_at is null and a.source = 'unavailable', 'no timestamp is invented');
  select * into a from public.order_first_approval(hct.ord(6));
  perform hct.expect(a.source = 'unavailable', 'submitted order has no approval');
  perform hct.expect(hct.as_user(hct.u(1), 'select count(*) from public.order_status_events') like '%permission denied%', 'ledger not readable by API roles');
  begin
    update public.order_status_events set occurred_at = now() where order_id = hct.ord(9);
    raise exception 'ASSERTION FAILED: ledger update allowed';
  exception when others then
    perform hct.expect(sqlerrm like '%append_only%', 'ledger append-only: ' || sqlerrm);
  end;
  raise notice 'PASS 3,6 approval ledger';
end $t$;

-- ── 1-4,9,10. Calculate October ─────────────────────────────────────────────
do $t$
declare c public.hr_commission_cycles; v numeric;
begin
  perform hct.expect(hct.as_user(hct.u(1), $$select public.hr_commission_ensure_cycle('2026-10-01')$$) = 'OK', 'ensure Oct');
  select * into c from public.hr_commission_cycles where company_id = hct.o(1) and period_month = '2026-10-01';
  perform hct.expect(c.start_at = timestamptz '2026-09-28 00:00+08' and c.end_at = timestamptz '2026-10-28 00:00+08', 'persisted boundaries');
  perform hct.expect(c.label = 'October 2026 Commission Cycle', 'label: ' || c.label);
  perform hct.expect(hct.as_user(hct.u(1), format('select public.hr_commission_calculate(%L)', c.id)) = 'OK', 'calculate Oct');
  select * into c from public.hr_commission_cycles where id = c.id;
  -- Sources: SO002 (Sep 28 00:00), SO003 ×3 lines, SO007 legacy, SO009 (first approval Oct 2), SO011 (warehouse_packed).
  -- Excluded: SO001 (Sep), SO004 (Nov), SO005 cancelled, SO006 submitted, SO008 no timestamp, SO010 H2M.
  perform hct.expect((select count(*) from public.hr_commission_sources where cycle_id = c.id) = 7, 'source lines: ' || (select count(*) from public.hr_commission_sources where cycle_id = c.id));
  perform hct.expect(not exists (select 1 from public.hr_commission_sources where cycle_id = c.id and order_id in (hct.ord(1), hct.ord(4), hct.ord(5), hct.ord(6), hct.ord(8), hct.ord(10))), 'exclusions');
  perform hct.expect((select approval_source from public.hr_commission_sources where cycle_id = c.id and order_id = hct.ord(7)) = 'recorded_approved_at', 'legacy provenance kept on the source');
  -- Eligible sales = Cellera 1,607,784 + 500 + 100 + 250 ; Ellbow 2,000 + 400 ; unmapped 300 excluded.
  perform hct.expect(c.eligible_sales = 1611034.00, 'eligible sales ' || c.eligible_sales);
  perform hct.expect((select sum(line_value) from public.hr_commission_sources where cycle_id = c.id and business_unit_code = 'CELLERA') = 1608634.00, 'Cellera sales (two brands)');
  perform hct.expect((select sum(line_value) from public.hr_commission_sources where cycle_id = c.id and business_unit_code = 'ELLBOW') = 2400.00, 'Ellbow sales');
  -- Items.
  perform hct.expect((select commission_amount from public.hr_commission_items where cycle_id = c.id and employee_id = hct.emp(4) and business_unit_code = 'CELLERA') = 1930.36, 'Fakhrul Cellera 1,608,634 × 0.120%');
  perform hct.expect((select commission_amount from public.hr_commission_items where cycle_id = c.id and employee_id = hct.emp(4) and business_unit_code = 'ELLBOW') = 1.20, 'Fakhrul Ellbow 2,400 × 0.050%');
  -- Siti: rate change on 20 Oct splits Cellera into two items.
  perform hct.expect((select count(*) from public.hr_commission_items where cycle_id = c.id and employee_id = hct.emp(5)) = 2, 'Siti rate split');
  perform hct.expect((select commission_amount from public.hr_commission_items where cycle_id = c.id and employee_id = hct.emp(5) and rate_percent = 0.22780) = 3662.76, 'Siti 1,607,884 × 0.22780%');
  perform hct.expect((select commission_amount from public.hr_commission_items where cycle_id = c.id and employee_id = hct.emp(5) and rate_percent = 0.25) = 1.88, 'Siti 750 × 0.25% = 1.875 → 1.88');
  perform hct.expect((select commission_raw from public.hr_commission_items where cycle_id = c.id and employee_id = hct.emp(5) and rate_percent = 0.25) = 1.875, 'raw kept exactly');
  perform hct.expect(c.total_commission = 1930.36 + 1.20 + 3662.76 + 1.88, 'total ' || c.total_commission);
  perform hct.expect(c.eligible_employee_count = 2, 'eligible employees');
  perform hct.expect((select department_name from public.hr_commission_items where cycle_id = c.id and employee_id = hct.emp(5) limit 1) = 'Production Staff', 'department snapshot');
  -- Flags.
  perform hct.expect(exists (select 1 from public.hr_commission_review_flags where cycle_id = c.id and flag_type = 'unattributed_brand' and order_id = hct.ord(3)), 'unattributed brand flagged');
  perform hct.expect(exists (select 1 from public.hr_commission_review_flags where cycle_id = c.id and flag_type = 'approval_timestamp_missing' and order_id = hct.ord(8)), 'missing timestamp flagged');
  -- 11. Recalculation is deterministic and versioned.
  v := c.total_commission;
  perform hct.expect(hct.as_user(hct.u(1), format('select public.hr_commission_calculate(%L)', c.id)) = 'OK', 'recalculate');
  select * into c from public.hr_commission_cycles where id = c.id;
  perform hct.expect(c.calc_version = 2 and c.total_commission = v and (select count(*) from public.hr_commission_sources where cycle_id = c.id) = 7, 'recalc idempotent');
  perform hct.expect((select count(*) from public.hr_commission_calc_runs where cycle_id = c.id) = 2, 'calc runs kept');
  raise notice 'PASS 1-4,9-11 October calculation';
end $t$;

-- ── 12/13. September: approve, lock, immutability, cancellation after lock ──
do $t$
declare s public.hr_commission_cycles; o public.hr_commission_cycles; r text;
begin
  perform hct.expect(hct.as_user(hct.u(9), $$select public.hr_commission_ensure_cycle('2026-09-01')$$) = 'OK', 'ensure Sep');
  select * into s from public.hr_commission_cycles where company_id = hct.o(1) and period_month = '2026-09-01';
  select * into o from public.hr_commission_cycles where company_id = hct.o(1) and period_month = '2026-10-01';
  perform hct.expect(s.end_at = o.start_at, 'September ends exactly where October starts');
  perform hct.expect(hct.as_user(hct.u(9), format('select public.hr_commission_calculate(%L)', s.id)) = 'OK', 'calc Sep');
  perform hct.expect(hct.as_user(hct.u(9), format('select public.hr_commission_submit_cycle(%L, null)', s.id)) = 'OK', 'submit Sep');
  perform hct.expect(hct.as_user(hct.u(9), format('select public.hr_commission_approve_cycle(%L, true, null)', s.id)) like '%sod_violation%', 'calculator cannot approve');
  perform hct.expect(hct.as_user(hct.u(1), format('select public.hr_commission_approve_cycle(%L, true, null)', s.id)) like '%sa_authorization_required%', 'administrator cannot approve');
  r := hct.as_user(hct.u(2), format('select public.hr_commission_approve_cycle(%L, true, %L)', s.id, 'checked'));
  perform hct.expect(r = 'OK', 'approver approves Sep: ' || r);
  perform hct.expect((select count(*) from public.hr_commission_source_claims where cycle_id = s.id) = 1, 'SO001 line claimed');
  perform hct.expect(hct.as_user(hct.u(2), format('select public.hr_commission_lock_cycle(%L, null)', s.id)) = 'OK', 'lock');
  select * into s from public.hr_commission_cycles where id = s.id;
  perform hct.expect(s.status = 'locked' and s.total_commission = 1.20 + 2.28, 'Sep locked: ' || s.total_commission);
  -- Locked immutability: no recalc, no direct edits even by the database owner.
  perform hct.expect(hct.as_user(hct.u(1), format('select public.hr_commission_calculate(%L)', s.id)) like '%finalized%', 'no recalculation of a locked cycle');
  begin update public.hr_commission_items set commission_amount = 999 where cycle_id = s.id; raise exception 'ASSERTION FAILED: item edit allowed';
  exception when others then perform hct.expect(sqlerrm like '%finalized%', 'item frozen: ' || sqlerrm); end;
  begin update public.hr_commission_cycles set total_commission = 0 where id = s.id; raise exception 'ASSERTION FAILED: cycle edit allowed';
  exception when others then perform hct.expect(sqlerrm like '%finalized%', 'cycle frozen: ' || sqlerrm); end;
  begin update public.hr_commission_cycles set end_at = end_at + interval '1 day' where id = s.id; raise exception 'ASSERTION FAILED: boundary edit allowed';
  exception when others then perform hct.expect(sqlerrm like '%immutable%', 'boundaries frozen'); end;
  begin delete from public.hr_commission_sources where cycle_id = s.id; raise exception 'ASSERTION FAILED: source delete allowed';
  exception when others then perform hct.expect(sqlerrm like '%finalized%', 'sources frozen'); end;
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_request_adjustment(%L, null, %L, 10, 'late bonus', null, null)$$, hct.emp(4), s.id)) like '%finalized%', 'no adjustment into a locked cycle');
  -- A rate cannot be ended before a date a final cycle paid on (SO001, 27 Sep).
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_request_rule_end((select id from public.hr_employee_commission_rules where employee_id=%L and rate_percent=0.12), '2026-09-01', 'end early test')$$, hct.emp(4))) = 'OK', 'end request recorded');
  perform hct.expect(hct.as_user(hct.u(2), $$select public.hr_commission_decide_rule_request((select id from public.hr_employee_commission_rule_requests where status='pending' and kind='end_rule'), true, null)$$) like '%rule_used_by_final_cycle%', 'paid history protected');
  perform hct.expect(hct.as_user(hct.u(2), $$select public.hr_commission_decide_rule_request((select id from public.hr_employee_commission_rule_requests where status='pending' and kind='end_rule'), false, 'would rewrite paid history')$$) = 'OK', 'rejected');
  raise notice 'PASS 12 approval, lock and immutability';
end $t$;

do $t$
declare o public.hr_commission_cycles; n int;
begin
  -- 13. SO001 (paid in locked September) is cancelled now.
  perform hct.set_status(1, 'cancelled');
  select * into o from public.hr_commission_cycles where company_id = hct.o(1) and period_month = '2026-10-01';
  perform hct.expect(hct.as_user(hct.u(1), format('select public.hr_commission_calculate(%L)', o.id)) = 'OK', 'recalc Oct');
  perform hct.expect((select count(*) from public.hr_commission_adjustments where target_cycle_id = o.id and kind = 'cancellation_reversal' and status = 'pending') = 2, 'one reversal per paid item');
  perform hct.expect((select sum(amount) from public.hr_commission_adjustments where target_cycle_id = o.id and kind = 'cancellation_reversal') = -3.48, 'reversal amounts -1.20 and -2.28');
  perform hct.expect((select total_commission from public.hr_commission_cycles where company_id = hct.o(1) and period_month = '2026-09-01') = 3.48, 'locked September not mutated');
  -- 14. Duplicate prevention across repeated recalculations.
  perform hct.expect(hct.as_user(hct.u(1), format('select public.hr_commission_calculate(%L)', o.id)) = 'OK', 'recalc again');
  perform hct.expect((select count(*) from public.hr_commission_adjustments where kind = 'cancellation_reversal') = 2, 'no duplicate reversals');
  -- Decisions: requester/employee cannot decide; approver decides.
  perform hct.expect(hct.as_user(hct.u(1), $$select public.hr_commission_decide_adjustment((select id from public.hr_commission_adjustments where kind='cancellation_reversal' order by amount limit 1), true, null)$$) like '%sa_authorization_required%', 'administrator cannot decide');
  perform hct.expect(hct.as_user(hct.u(2), $$select public.hr_commission_decide_adjustment((select id from public.hr_commission_adjustments where kind='cancellation_reversal' order by amount limit 1), true, 'reverse')$$) = 'OK', 'approve reversal');
  perform hct.expect(hct.as_user(hct.u(2), $$select public.hr_commission_decide_adjustment((select id from public.hr_commission_adjustments where kind='cancellation_reversal' and status='pending'), false, 'already recovered in cash')$$) = 'OK', 'reject reversal with reason');
  perform hct.expect(hct.as_user(hct.u(1), format('select public.hr_commission_calculate(%L)', o.id)) = 'OK', 'recalc after decisions');
  perform hct.expect((select count(*) from public.hr_commission_adjustments where kind = 'cancellation_reversal') = 2, 'rejected reversal is not recreated');
  -- Manual adjustments: mandatory reason, maker-checker.
  perform hct.expect(hct.as_user(hct.u(9), format($$select public.hr_commission_request_adjustment(%L, null, %L, 50.00, 'x', null, null)$$, hct.emp(4), o.id)) like '%check%', 'reason required');
  perform hct.expect(hct.as_user(hct.u(9), format($$select public.hr_commission_request_adjustment(%L, null, %L, 50.00, 'Q3 target bonus top-up', null, null)$$, hct.emp(4), o.id)) = 'OK', 'positive manual adjustment');
  perform hct.expect(hct.as_user(hct.u(9), $$select public.hr_commission_decide_adjustment((select id from public.hr_commission_adjustments where kind='manual'), true, null)$$) like '%sod_violation%', 'own adjustment refused');
  perform hct.expect(hct.as_user(hct.u(2), $$select public.hr_commission_decide_adjustment((select id from public.hr_commission_adjustments where kind='manual'), true, 'ok')$$) = 'OK', 'approved by another');
  select * into o from public.hr_commission_cycles where id = o.id;
  perform hct.expect(o.total_adjustments = 50.00 - 2.28 and o.net_commission = o.total_commission + o.total_adjustments, 'open cycle totals include approved adjustments: ' || o.total_adjustments);
  begin update public.hr_commission_adjustments set amount = 1 where kind = 'manual'; raise exception 'ASSERTION FAILED: decided adjustment edited';
  exception when others then perform hct.expect(sqlerrm like '%immutable%', 'decided adjustment frozen'); end;
  -- October has not ended in real time; approval waits for the boundary.
  if now() < o.end_at then
    perform hct.expect(hct.as_user(hct.u(1), format('select public.hr_commission_submit_cycle(%L, null)', o.id)) = 'OK', 'submit Oct');
    perform hct.expect(hct.as_user(hct.u(2), format('select public.hr_commission_approve_cycle(%L, true, null)', o.id)) like '%not_ended%', 'cannot approve before cycle end');
    perform hct.expect(hct.as_user(hct.u(2), format('select public.hr_commission_return_cycle(%L, %L)', o.id, 'needs another look')) = 'OK', 'return to calculated');
  end if;
  raise notice 'PASS 13-14 cancellation after lock, reversals, manual adjustments';
end $t$;

-- ── 5. Approved-then-cancelled before approval of the cycle blocks finalization ──
do $t$
declare n public.hr_commission_cycles;
begin
  perform hct.expect(hct.as_user(hct.u(1), $$select public.hr_commission_ensure_cycle('2026-11-01')$$) = 'OK', 'ensure Nov');
  select * into n from public.hr_commission_cycles where company_id = hct.o(1) and period_month = '2026-11-01';
  perform hct.expect(n.start_at = timestamptz '2026-10-28 00:00+08', 'Nov contiguous');
  perform hct.expect(hct.as_user(hct.u(1), format('select public.hr_commission_calculate(%L)', n.id)) = 'OK', 'calc Nov');
  perform hct.expect((select count(*) from public.hr_commission_sources where cycle_id = n.id and order_id = hct.ord(4)) = 1, 'SO004 (29 Oct) in November');
  perform hct.expect(not exists (select 1 from public.hr_commission_sources where order_id = hct.ord(9) and cycle_id = n.id), 'SO009 re-approval does not create a second commission');
  -- Settings may not rewrite generated months; a later month is accepted.
  perform hct.expect(hct.as_user(hct.u(1), $$select public.hr_commission_save_settings('2026-11-01', 'calendar_month', 1, null, null, null, 'switch')$$) like '%overlap_existing_cycles%', 'settings cannot change generated cycles');
  perform hct.expect(hct.as_user(hct.u(1), $$select public.hr_commission_save_settings('2027-01-01', 'custom', 30, null, null, null, 'bad day')$$) like '%check%', 'start day above 28 refused');
  perform hct.expect(hct.as_user(hct.u(1), $$select public.hr_commission_save_settings('2027-01-01', 'custom', 28, null, array['approved','submitted'], null, 'bad statuses')$$) like '%check%', 'submitted can never be eligible');
  perform hct.expect(hct.as_user(hct.u(1), $$select public.hr_commission_save_settings('2027-01-01', 'calendar_month', 1, null, null, null, 'calendar from 2027')$$) = 'OK', 'future settings version');
  perform hct.expect((select settings_snapshot->>'source' from public.hr_commission_cycles where id = n.id) = 'default', 'existing cycle keeps its snapshot');
  raise notice 'PASS 5 contiguity, settings versioning';
end $t$;

-- ── 15. RLS: company isolation and permission-specific reads ──
do $t$
begin
  perform hct.expect(hct.val_as(hct.u(6), 'select count(*) from public.hr_commission_cycles') = '0', 'HQ admin reads no cycles');
  perform hct.expect(hct.val_as(hct.u(4), 'select count(*) from public.hr_commission_items') = '0', 'employee cannot read compensation (own or others)');
  perform hct.expect(hct.val_as(hct.u(8), 'select count(*) from public.hr_commission_cycles') = '0', 'other company reads none of ours');
  perform hct.expect(hct.val_as(hct.u(8), 'select count(*) from public.hr_commission_business_units') = '1', 'other company reads its own BU');
  perform hct.expect(hct.val_as(hct.u(3), 'select count(*) from public.hr_commission_cycles')::int = 3, 'report viewer reads cycles');
  perform hct.expect(hct.val_as(hct.u(3), 'select count(*) from public.hr_employee_commission_rules') = '0', 'report viewer cannot read rate administration');
  perform hct.expect(hct.val_as(hct.u(1), 'select count(*) from public.hr_employee_commission_rules')::int >= 4, 'HR reads rates');
  perform hct.expect(hct.val_as(hct.u(1), 'select count(*) from public.hr_commission_audit_log')::int > 10, 'audit trail readable by HR');
  perform hct.expect(hct.val_as(hct.u(3), 'select count(*) from public.hr_commission_audit_log') = '0', 'audit not readable by reporting');
  raise notice 'PASS 15 RLS';
end $t$;

-- ── 18. Payroll readiness without live payroll ──
do $t$
declare s public.hr_commission_cycles; runs int := (select count(*) from public.hr_payroll_runs); items int := (select count(*) from public.hr_payroll_run_items); gl int := (select count(*) from public.gl_journals);
begin
  select * into s from public.hr_commission_cycles where company_id = hct.o(1) and period_month = '2026-09-01';
  perform hct.expect(hct.as_user(hct.u(1), format($$select public.hr_commission_mark_payroll_ready(%L, '2026-10-01', '2026-10-31', null)$$, s.id)) like '%sa_authorization_required%', 'administrator cannot release to payroll');
  perform hct.expect(hct.as_user(hct.u(2), format($$select public.hr_commission_mark_payroll_ready(%L, '2026-10-01', '2026-10-31', 'October payroll')$$, s.id)) = 'OK', 'payroll ready');
  perform hct.expect((select count(*) from public.hr_commission_payroll_transfers where cycle_id = s.id) = 2, 'one transfer per employee');
  perform hct.expect((select sum(net_commission) from public.hr_commission_payroll_transfers where cycle_id = s.id) = 3.48, 'net matches locked ledger');
  perform hct.expect((select bool_and(transfer_status = 'prepared' and payroll_run_id is null and payroll_run_item_id is null and gl_journal_id is null and payroll_component_code = 'COMMISSION') from public.hr_commission_payroll_transfers), 'prepared only');
  perform hct.expect((select count(*) from public.hr_payroll_runs) = runs and (select count(*) from public.hr_payroll_run_items) = items and (select count(*) from public.gl_journals) = gl, 'no payroll run, item or journal created');
  perform hct.expect(hct.as_user(hct.u(2), format($$select public.hr_commission_mark_payroll_ready(%L, '2026-10-01', '2026-10-31', null)$$, s.id)) like '%not_locked%', 'not repeatable');
  begin update public.hr_commission_payroll_transfers set net_commission = 0; raise exception 'ASSERTION FAILED: transfer edited';
  exception when others then perform hct.expect(sqlerrm like '%immutable%', 'transfer frozen'); end;
  raise notice 'PASS 18 payroll readiness';
end $t$;

-- ── 15c. Privileged-read audit and exactly-once claims ──
do $t$
begin
  perform hct.expect(hct.as_user(hct.u(3), $$select public.hr_commission_log_access('report_viewed', 'commission_cycle', null, '{}')$$) = 'OK', 'report viewer view logged');
  perform hct.expect(hct.as_user(hct.u(3), $$select public.hr_commission_log_access('report_exported', 'commission_cycle', null, '{}')$$) = 'OK', 'export logged for export holder');
  perform hct.expect(hct.as_user(hct.u(2), $$select public.hr_commission_log_access('report_exported', 'commission_cycle', null, '{}')$$) like '%sa_authorization_required%', 'approver without export permission cannot export');
  perform hct.expect(hct.as_user(hct.u(4), $$select public.hr_commission_log_access('report_viewed', 'commission_cycle', null, '{}')$$) like '%sa_authorization_required%', 'employee cannot read reports');
  perform hct.expect(hct.as_user(hct.u(3), $$select public.hr_commission_log_access('anything', 'x', null, '{}')$$) like '%action_invalid%', 'fixed vocabulary');
  perform hct.expect((select count(*) from public.hr_commission_audit_log where action like 'access.%') = 2, 'two access rows');
  begin
    insert into public.hr_commission_source_claims(order_item_id, order_id, cycle_id, source_id)
    select order_item_id, order_id, cycle_id, source_id from public.hr_commission_source_claims limit 1;
    raise exception 'ASSERTION FAILED: a line was claimed twice';
  exception when others then perform hct.expect(sqlerrm not like 'ASSERTION%', 'an order line is claimed at most once: ' || sqlerrm); end;
  perform hct.expect((select count(*) from public.hr_commission_sources s join public.orders o on o.id = s.order_id where o.order_type <> 'D2H') = 0, 'only D2H lines anywhere in the ledger (H2M never)');
  raise notice 'PASS 15c access audit, exactly-once claims, D2H only';
end $t$;

-- ── 15b. Environments where HR is still on legacy authorization (SHADOW): Super Admin of the same company only ──
update public.sa_migration_modes set mode = 'SHADOW' where permission_key = any(public.hr_commission_permission_keys());
do $t$
begin
  perform hct.expect((hct.val_as(hct.u(7), 'select public.hr_commission_my_access()')::jsonb->>'hr.commission.approve')::boolean, 'legacy: Super Admin of the company');
  perform hct.expect(not (hct.val_as(hct.u(6), 'select public.hr_commission_my_access()')::jsonb->>'hr.commission.view')::boolean, 'legacy: HQ admin level 10 still denied');
  perform hct.expect(not (hct.val_as(hct.u(1), 'select public.hr_commission_my_access()')::jsonb->>'hr.commission.view')::boolean, 'legacy: an unenforced S&A grant does not decide');
  perform hct.expect(hct.val_as(hct.u(7), 'select count(*) from public.hr_commission_cycles where company_id = ''00000000-0000-0000-00c2-000000000009''') = '0', 'legacy: Super Admin sees no other company');
  raise notice 'PASS 15b legacy-mode fallback';
end $t$;
update public.sa_migration_modes set mode = 'NEW_ENFORCED' where permission_key = any(public.hr_commission_permission_keys());

\echo ALL HR COMMISSION TESTS PASSED
