-- Run together with the migration in ONE transaction (psql -1): the policy text is not the expected staging text,
-- so the migration must raise and roll everything back, including this tamper.
alter policy orgs_insert_admin on public.organizations with check ((is_hq_admin() OR is_super_admin()));
