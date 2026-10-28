\set VERBOSITY verbose
\set uid :uid
\set reqid :reqid
\set sleep :sleep
begin;
set local lock_timeout = '5s';
select pg_advisory_xact_lock(hashtextextended('identity_deletion:' || :'uid', 0));
select 1 from users where id = :'uid' for update;
select 1 from hr_employees where user_id = :'uid' for update;
update hr_employees set status = 'resigned', end_date = current_date, updated_at = now() where user_id = :'uid';
update users set account_status = 'ARCHIVED', updated_at = now() where id = :'uid';
insert into identity_lifecycle_actions(request_id, actor_id, target_user_id, action, status)
values (:'reqid', '00000000-0000-0000-0000-000000000090', :'uid', 'archive', 'completed');
select pg_sleep(:sleep);
commit;
