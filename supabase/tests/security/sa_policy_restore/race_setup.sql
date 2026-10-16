-- One revoked grant two administrators will race to restore (u32, finance-viewer, HQ).
update public.sa_role_assignments set status = 'revoked' where user_id = saf.u(32) and role_id = saf.role('finance-viewer') and status <> 'revoked';
create table saf.race(id uuid);
insert into saf.race select saf.grant_id(23, 32, 'finance-viewer', 1, 1);
select saf.expect(saf.revoke(23, (select id from saf.race)) = 'OK', 'race: revoke');
create function saf.race_id() returns uuid language sql stable as $$ select id from saf.race $$;
-- A fresh revoked grant for the second race (restore vs. ordinary grant).
create function saf.race_reset() returns void language plpgsql as $$ begin
  update public.sa_role_assignments set status = 'revoked' where user_id = saf.u(32) and role_id = saf.role('finance-viewer') and status <> 'revoked';
  delete from saf.race;
  insert into saf.race select saf.grant_id(23, 32, 'finance-viewer', 1, 1);
  perform saf.expect(saf.revoke(23, (select id from saf.race)) = 'OK', 'race: revoke');
end $$;
grant execute on all functions in schema saf to public;
grant all on table saf.race to public;
