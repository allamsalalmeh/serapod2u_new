-- Negative control: staging schema + 20261214100000 + 20261216100000, WITHOUT 20261217100000.
-- The archive that existed: identity_set_account_status(..., 'ARCHIVED') by Root (28).
select ipd.expect(to_regprocedure('public.identity_archive_execute(uuid,uuid,text,uuid,text,text,text,boolean,text)') is null, 'before: no Archive & Revoke Access operation');
select public.identity_set_account_status(ipd.u(28), ipd.u(33), 'ARCHIVED', 'before-test archive');
select ipd.expect((select account_status from public.users where id = ipd.u(33)) = 'ARCHIVED', 'before: the status change itself works');
select ipd.expect(exists (select 1 from auth.sessions where user_id = ipd.u(33)) and exists (select 1 from auth.refresh_tokens where user_id = ipd.u(33)::text),
  'before: archived identity KEEPS its sessions and refresh tokens (still usable until they expire)');
select ipd.expect((select banned_until from auth.users where id = ipd.u(33)) is null, 'before: no login ban in the database (only a best-effort GoTrue call afterwards)');
select ipd.expect((select hr.onboarding_status = 'completed' and hr.status = 'active' from public.hr_employees hr where hr.user_id = ipd.u(33)),
  'before: the HR anchor stays "active / onboarded" → still listed as a current employee');
select ipd.expect(public.identity_resolve('ipd-33@example.test', null)->>'outcome' = 'IDENTITY_ARCHIVED', 'before: the email stays reserved forever (no release)');
-- put 33 back for the after tests (Root reactivation)
select public.identity_set_account_status(ipd.u(28), ipd.u(33), 'ACTIVE', 'before-test reactivation');
