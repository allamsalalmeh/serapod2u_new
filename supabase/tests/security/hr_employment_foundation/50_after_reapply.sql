-- After re-applying 20261221100000 following the rollback rehearsal: enforcement is back, history continues.
do $t$
declare n bigint; v_no int;
begin
  perform hlc.expect(exists (select 1 from pg_trigger where tgname = 'hr_employees_lifecycle_guard')
                     and exists (select 1 from pg_trigger where tgname = 'hr_employees_record_version'), 'RA1 triggers re-installed');
  select max(version_no) into v_no from public.hr_employee_versions where employment_ref = hlc.x(105);
  update public.hr_employees set probation_end = date '2027-02-28' where user_id = hlc.u(5);
  perform hlc.expect((select max(version_no) from public.hr_employee_versions where employment_ref = hlc.x(105)) = v_no + 1,
                     'RA2 history numbering continues after re-apply (no second baseline)');
  begin
    update public.hr_employees set manager_user_id = hlc.u(10) where user_id = hlc.u(5);
    perform hlc.expect(false, 'RA3 must fail');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_manager_outside_company', 'RA3 manager validation enforced again (' || sqlerrm || ')');
  end;
end $t$;
