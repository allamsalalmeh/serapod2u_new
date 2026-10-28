\set VERBOSITY verbose
-- Same as delete_tx.sql, but holds the SHARE lock briefly so two overlapping
-- transactions are guaranteed to reach the cleanup DELETE together (the race
-- that made the production failure intermittent).
\set uid :uid
\set reqid :reqid
begin;
set local lock_timeout = '5s';
select pg_advisory_xact_lock(hashtextextended('identity_deletion:' || :'uid', 0));
select 1 from users where id = :'uid' for update;
select 1 from hr_employees where user_id = :'uid' for update;
lock table hr_employees in share mode;
select pg_sleep(1);
delete from hr_employees where user_id = :'uid';
delete from users where id = :'uid';
insert into identity_deletion_requests(request_id, target_user_id, status) values (:'reqid', :'uid', 'completed');
commit;
