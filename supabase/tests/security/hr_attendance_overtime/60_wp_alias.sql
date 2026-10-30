-- Optional Wave 3 correction 20261224100000 (WP holiday alias). DISPOSABLE replica only.
do $t$
declare d date := hw3.mon() + 9;   -- Wednesday of the following week (d+1…d+3 = Thu, Fri, Sat)
begin
  insert into public.hr_public_holidays(id, organization_id, name, date, is_recurring, state)
  values (hlc.x(1005), hlc.o(1), 'W3 Federal Territory Day', d, false, 'WP') on conflict do nothing;
  insert into public.hr_employee_statutory_profiles(user_id, organization_id, work_state) values (hlc.u(22), hlc.o(1), 'KUL')
  on conflict (user_id) do update set work_state = 'KUL';
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(22), d) = 'public_holiday', 'WP1 a ''WP'' holiday applies to a Kuala Lumpur employee');
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(1), d) = 'normal', 'WP2 it does not apply to a Selangor employee');
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(2), d) = 'normal', 'WP3 nor to an employee without a work state');
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(1), hw3.mon() + 3) = 'public_holiday', 'WP4 existing Selangor holiday unchanged');
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(2), hw3.mon() + 2) = 'public_holiday', 'WP5 national holiday unchanged');
  -- 2026-10-26: the three Federal Territories (KUL, LBN, PJY) share 'WP' holidays but keep their own calendars.
  insert into public.hr_employee_statutory_profiles(user_id, organization_id, work_state) values (hlc.u(20), hlc.o(1), 'LBN')
  on conflict (user_id) do update set work_state = 'LBN';
  insert into public.hr_employee_statutory_profiles(user_id, organization_id, work_state) values (hlc.u(21), hlc.o(1), 'PJY')
  on conflict (user_id) do update set work_state = 'PJY';
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(20), d) = 'public_holiday', 'WP7 a ''WP'' holiday applies to a Labuan employee');
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(21), d) = 'public_holiday', 'WP8 a ''WP'' holiday applies to a Putrajaya employee');
  insert into public.hr_public_holidays(id, organization_id, name, date, is_recurring, state)
  values (hlc.x(1006), hlc.o(1), 'W3 Labuan-only holiday', d + 1, false, 'Labuan'),
         (hlc.x(1007), hlc.o(1), 'W3 Putrajaya-only holiday', d + 2, false, 'W.P. Putrajaya'),
         (hlc.x(1008), hlc.o(1), 'W3 KL-only holiday', d + 3, false, 'Wilayah Persekutuan Kuala Lumpur') on conflict do nothing;
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(20), d + 1) = 'public_holiday'
                     and public.hr_att_day_type(hlc.o(1), hlc.u(22), d + 1) <> 'public_holiday'
                     and public.hr_att_day_type(hlc.o(1), hlc.u(21), d + 1) <> 'public_holiday', 'WP9 a Labuan holiday applies only in Labuan');
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(21), d + 2) = 'public_holiday'
                     and public.hr_att_day_type(hlc.o(1), hlc.u(22), d + 2) <> 'public_holiday'
                     and public.hr_att_day_type(hlc.o(1), hlc.u(20), d + 2) <> 'public_holiday', 'WP10 a ''W.P. Putrajaya'' holiday applies only in Putrajaya');
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(22), d + 3) = 'public_holiday'
                     and public.hr_att_day_type(hlc.o(1), hlc.u(20), d + 3) <> 'public_holiday'
                     and public.hr_att_day_type(hlc.o(1), hlc.u(21), d + 3) <> 'public_holiday', 'WP11 a Kuala Lumpur holiday applies only in Kuala Lumpur');
  perform hlc.expect(public.hr_att_day_type(hlc.o(1), hlc.u(1), d + 1) <> 'public_holiday'
                     and public.hr_att_day_type(hlc.o(1), hlc.u(2), d + 2) <> 'public_holiday', 'WP12 territory holidays never reach Selangor or employees without a work state');
  perform hlc.expect(not has_function_privilege('authenticated', 'public.hr_att_day_type(uuid,uuid,date)', 'execute')
                     and not has_function_privilege('service_role', 'public.hr_att_day_type(uuid,uuid,date)', 'execute'), 'WP6 helper still sealed');
end $t$;
