\set VERBOSITY verbose
-- Canonical execute re-checks the target after taking the per-identity advisory
-- lock: a second request for the same identity must not act again.
\set uid :uid
\set reqid :reqid
begin;
set local lock_timeout = '5s';
select pg_advisory_xact_lock(hashtextextended('identity_deletion:' || :'uid', 0));
select count(*) as remaining from users where id = :'uid' \gset
\if :remaining
  select 1 from users where id = :'uid' for update;
  select 1 from hr_employees where user_id = :'uid' for update;
  lock table hr_employees in share mode;
  delete from hr_employees where user_id = :'uid';
  delete from users where id = :'uid';
  insert into identity_deletion_requests(request_id, target_user_id, status) values (:'reqid', :'uid', 'completed');
  commit;
\else
  \echo 'identity_deletion_target_not_found'
  rollback;
\endif
