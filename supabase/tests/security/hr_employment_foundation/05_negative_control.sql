-- Negative control: on the schema WITHOUT 20261221100000 the gaps this migration closes must be reproducible.
-- Everything runs in one transaction that is rolled back.
begin;
do $t$
begin
  perform hlc.expect(to_regclass('public.hr_employee_versions') is null, 'N0 Wave 2 is not installed on this replica');
  update public.hr_employees set manager_user_id = hlc.u(12) where user_id = hlc.u(1);
  perform hlc.expect((select manager_user_id from public.hr_employees where user_id = hlc.u(1)) = hlc.u(12),
                     'N1 gap reproduced: an archived former employee can be made a manager');
  update public.hr_employees set manager_user_id = hlc.u(10) where user_id = hlc.u(2);
  perform hlc.expect((select manager_user_id from public.hr_employees where user_id = hlc.u(2)) = hlc.u(10),
                     'N2 gap reproduced: a manager from another company can be assigned');
  update public.hr_employees set department_id = null, employment_type = 'Contract', status = 'active' where user_id = hlc.u(12);
  perform hlc.expect((select status from public.hr_employees where user_id = hlc.u(12)) = 'active',
                     'N3 gap reproduced: an archived former employee can be silently re-employed');
  insert into public.hr_employee_compensation(organization_id, employee_id, pay_type, basic_salary, effective_date, status)
  values (hlc.o(1), hlc.u(1), 'monthly', 1, date '2026-01-01', 'active'), (hlc.o(1), hlc.u(1), 'monthly', 2, date '2026-02-01', 'active');
  perform hlc.expect((select count(*) from public.hr_employee_compensation where employee_id = hlc.u(1) and status = 'active') >= 2,
                     'N4 gap reproduced: overlapping active salaries are accepted');
  update public.hr_employees set status = 'resigned' where user_id = hlc.u(5);
  perform hlc.expect((select end_date from public.hr_employees where user_id = hlc.u(5)) is null,
                     'N5 gap reproduced: ending employment leaves no end date');
end $t$;
rollback;
