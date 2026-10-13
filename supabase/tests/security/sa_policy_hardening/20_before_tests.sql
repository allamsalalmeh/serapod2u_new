-- Negative control: the staging schema + configuration BEFORE 20261110100000.
select pht.expect('finance.data.reset' = any(pht.perms('finance-full-access')), 'before: Finance Full Access holds finance.data.reset');
select pht.expect(pht.perms('platform-settings-full-access') @> array['platform.data.destructive','platform.identity.delete'], 'before: Platform Full Access holds destructive + identity delete');
select pht.expect('hr.data.reset' = any(pht.perms('hr-payroll-full-access')), 'before: HR Full Access holds hr.data.reset');
select pht.expect(pht.has(1, 'finance.data.reset'), 'before: user 1 resets finance through Full Access');
select pht.expect(pht.has(9, 'finance.data.reset') is false, 'before: user 9 holds nothing');
select pht.expect(not exists (select 1 from public.sa_business_roles where role_key in
  ('finance-data-reset-administrator','platform-data-maintenance-administrator','warehouse-receiving-dispatch',
   'hr-leave-attendance-administrator','hr-records-officer','reporting-viewer')), 'before: the six new policies do not exist');
select pht.expect((select string_agg(enforcement, ',' order by rule_key) from public.sa_sod_rules
  where rule_key in ('payment-request-maker-checker','payroll-prepare-approve')) = 'monitor,monitor', 'before: both maker/checker rules monitor');
select pht.expect(pht.try($$select public.sa_enforce_same_document_sod('payroll-prepare-approve', 'run-0', pht.u(6), array[pht.u(6)])$$) is null,
  'before: approving one''s own payroll run is only recorded (monitor)');
select pht.expect(position('payroll-prepare-approve' in (select prosrc from pg_proc where proname = 'sa_payroll_run_transition_guard')) > 0,
  'staging payroll status trigger calls the payroll maker/checker');
select pht.expect(position('payment-request-maker-checker' in (select prosrc from pg_proc where proname = 'approve_payment_request')) > 0,
  'staging approve_payment_request calls the payment maker/checker');
select pht.expect((select count(*) from public.sa_standard_policy_dependency_gaps()) = 0, 'before: no standard policy dependency gaps');
