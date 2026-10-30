-- Negative control on the unpatched staging schema: why a row delete is unsafe, and that the new API is absent.
select hed.expect(to_regprocedure('public.hr_employee_registration_execute(uuid,uuid,uuid,text,uuid,text,text)') is null,
  'before: no individual registration delete function exists');
select hed.expect(not exists (select 1 from public.sa_permissions where permission_key = 'hr.employee.delete'),
  'before: hr.employee.delete is not registered');

begin;
delete from public.hr_employees where user_id = hed.u(3) and organization_id = hed.o(1);
-- Any later change of an employment column on the identity (here: department) …
update public.users set department_id = hed.x(2) where id = hed.u(3);
select hed.expect(exists (select 1 from public.hr_employees where user_id = hed.u(3) and organization_id = hed.o(1)),
  'before: deleting the employment row is undone - identity_users_forward_employment recreates it');
select hed.expect((select employee_no from public.hr_employees where user_id = hed.u(3)) <> 900003,
  'before: the recreated anchor gets a NEW employee number (original 900003 lost)');
select hed.expect((select employee_no from public.users where id = hed.u(3)) <> 900003,
  'before: users.employee_no projection is overwritten with the new number');
rollback;

-- Identity delete would cascade HR history away (FKs ON DELETE CASCADE): checked from the catalogue, not executed.
select hed.expect((select count(*) from pg_constraint c join pg_class t on t.oid = c.conrelid
                   where c.contype = 'f' and c.confrelid = 'public.users'::regclass and c.confdeltype = 'c' and t.relname like 'hr\_%') >= 20,
  'before: >= 20 HR foreign keys to users are ON DELETE CASCADE (identity delete is never an option)');
