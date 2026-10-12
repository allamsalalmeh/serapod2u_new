-- After 20261108100000 (applied twice). Numbers refer to the required test scenarios.
select saf.expect(not exists (select 1 from pg_constraint where conname = 'sa_role_assignments_user_id_role_id_membership_id_key'), 'old one-row-ever constraint dropped');
select saf.expect(exists (select 1 from pg_indexes where indexname = 'sa_role_assignments_live_identity_uidx'), 'live-identity index present');

-- 1–4, 12. Successful restore of a revoked grant.
create table saf.t1 as select saf.grant_id(23, 6, 'sapr-custom', 1, 1) as original;
select saf.expect(saf.revoke(23, (select original from saf.t1)) = 'OK', 'revoke the grant');
select saf.expect(public.sa_policy_restore_blocker((select original from saf.t1)) is null, 'an explicitly revoked grant is restorable');
alter table saf.t1 add column before_text text;
update saf.t1 set before_text = saf.row_text(original);
-- 4. The policy definition changes while the grant is revoked.
insert into public.sa_business_role_permissions(role_id, permission_id)
  select saf.role('sapr-custom'), id from public.sa_permissions where permission_key = 'inventory.stock_count.create';
select saf.expect(saf.restore(1, (select original from saf.t1)) = 'OK', '1: an authorized administrator restores the grant');
do $t$ declare t saf.t1 := (select t from saf.t1 t); n public.sa_role_assignments; g public.sa_access_change_log; r public.sa_access_change_log; begin
  select * into n from public.sa_role_assignments where restored_from_assignment_id = t.original;
  perform saf.expect(n.id is not null and n.id <> t.original and n.status = 'active' and n.source = 'manual', '1: a NEW active grant');
  -- 2. The revoked grant is unchanged.
  perform saf.expect(saf.row_text(t.original) = t.before_text, '2: the original revoked row and its scopes are unchanged');
  perform saf.expect((select status from public.sa_role_assignments where id = t.original) = 'revoked', '2: original stays revoked');
  -- 3. Same policy, membership and scopes.
  perform saf.expect(n.role_id = saf.role('sapr-custom') and n.membership_id = (select membership_id from public.sa_role_assignments where id = t.original)
    and (select array_agg(scope_id) from public.sa_assignment_scopes where assignment_id = n.id) = array[saf.s(1)], '3: same policy, membership and scope');
  perform saf.expect(n.effective_until is null and n.created_by = saf.u(1) and n.updated_by = saf.u(1), '3: no end date (as the original), restoring administrator recorded');
  -- 4. Current policy permissions apply (including the one added while revoked).
  perform saf.expect(public.sa_evaluate_permission(saf.u(6), 'inventory.stock_count.create', jsonb_build_object('organization_id', saf.o(1)))->>'decision' = 'ALLOW',
    '4: a permission added to the policy after the revoke is granted by the restored grant');
  -- 12. Audit: the new grant and the original are both traceable.
  select * into g from public.sa_access_change_log where entity_type = 'sa_role_assignment' and entity_id = n.id::text and action = 'assignment.granted';
  perform saf.expect(g.actor_id = saf.u(1) and g.actor_kind = 'user' and g.target_user_id = saf.u(6) and g.details->>'action_type' = 'policy_restore'
    and g.details->>'restored_from_assignment_id' = t.original::text and g.details->>'organization_id' = saf.o(1)::text
    and g.details->'scope_ids' = jsonb_build_array(saf.s(1)) and g.reason like 'Restored revoked grant ' || t.original || '. Group Policy "Restore suite custom policy" granted to u6@dev.com%',
    '12: assignment.granted on the new grant: actor, target, action_type, original id, organization, scope: ' || coalesce(g.reason, '<null>'));
  select * into r from public.sa_access_change_log where entity_type = 'sa_role_assignment' and entity_id = t.original::text and action = 'policy_restore';
  perform saf.expect(r.actor_id = saf.u(1) and r.target_user_id = saf.u(6) and r.occurred_at is not null and r.details->>'restored_assignment_id' = n.id::text
    and r.details->>'original_assignment_id' = t.original::text and r.details->>'role_id' = saf.role('sapr-custom')::text
    and r.details->>'membership_id' = n.membership_id::text and r.details->'scope_ids' = jsonb_build_array(saf.s(1)), '12: policy_restore on the original: ids, actor, policy, scope');
end $t$;

-- 5. Duplicate: the same revoked grant again, and a revoked grant while the policy is already held.
select saf.expect(saf.restore(23, (select original from saf.t1)) like 'sa_restore_already_restored%', '5: a restored grant cannot be restored twice');
select saf.expect(saf.n_live(6, 'sapr-custom') = 1, '5: still exactly one live grant');
create table saf.t5(a uuid, b uuid);
insert into saf.t5(a) select saf.grant_id(23, 32, 'sapr-custom', 1, 1);
select saf.expect(saf.revoke(23, (select a from saf.t5)) = 'OK', 'revoke');
update saf.t5 set b = saf.grant_id(23, 32, 'sapr-custom', 1, 1);
select saf.expect((select b <> a from saf.t5) and (select status from public.sa_role_assignments where id = (select a from saf.t5)) = 'revoked',
  'granting again after a revoke adds a new row; the revoked one stays in history');
select saf.expect(public.sa_policy_restore_blocker((select a from saf.t5)) = 'sa_role_already_held'
  and saf.restore(1, (select a from saf.t5)) like 'sa_role_already_held%', '5: refused while an equivalent grant is active');
select saf.expect(saf.revoke(23, (select b from saf.t5)) = 'OK', 'revoke the newer one');
select saf.expect(public.sa_policy_restore_blocker((select a from saf.t5)) = 'sa_restore_superseded', '5: an older revoked grant replaced by a newer one is not offered');
select saf.expect(public.sa_policy_restore_blocker((select b from saf.t5)) is null, 'the newest revoked grant is restorable');

-- 6. Unauthorized administrator and self-restore.
create table saf.t6 as select saf.grant_id(23, 32, 'order-approver', 1, 1) as id;
select saf.expect(saf.revoke(23, (select id from saf.t6)) = 'OK', 'revoke');
select saf.expect(saf.restore(3, (select id from saf.t6)) like '%sa_authorization_required%', '6: an administrator without security.role.assign is refused');
select saf.expect(saf.restore(32, (select id from saf.t6)) like 'sa_self_assignment_prohibited%', '6: nobody restores their own grant');
select saf.expect(saf.n_live(32, 'order-approver') = 0 and not exists (select 1 from public.sa_role_assignments where restored_from_assignment_id = (select id from saf.t6)), '6: refusals change nothing');

-- 7. Inactive policy.
do $t$ declare a uuid := saf.grant_id(23, 32, 'sapr-retire', 1, 1); begin
  perform saf.expect(saf.revoke(23, a) = 'OK', 'revoke');
  update public.sa_business_roles set status = 'deprecated' where role_key = 'sapr-retire';
  perform saf.expect(public.sa_policy_restore_blocker(a) = 'sa_role_not_assignable' and saf.restore(1, a) like 'sa_role_not_assignable%', '7: a deprecated policy is not restored');
end $t$;

-- 8. Inactive person.
do $t$ declare a uuid := saf.grant_id(23, 32, 'finance-viewer', 1, 1); begin
  perform saf.expect(saf.revoke(23, a) = 'OK', 'revoke');
  update public.users set is_active = false where id = saf.u(32);
  perform saf.expect(saf.restore(1, a) like 'sa_target_inactive%', '8: an inactive person is refused');
  update public.users set is_active = true, account_status = 'SUSPENDED' where id = saf.u(32);
  perform saf.expect(saf.restore(1, a) like 'sa_target_inactive%', '8: a suspended person is refused');
  update public.users set account_status = 'ACTIVE' where id = saf.u(32);
  -- 9. Scope no longer valid / organization type no longer eligible / membership ended.
  update public.sa_scope_definitions set status = 'deprecated' where id = saf.s(1);
  -- (Deprecating the HQ scope also removes the administrators' own HQ authority, so the restore itself fails earlier.)
  perform saf.expect(public.sa_policy_restore_blocker(a) = 'sa_scope_outside_membership' and saf.restore(1, a) <> 'OK', '9: a deprecated scope is refused');
  update public.sa_scope_definitions set status = 'active' where id = saf.s(1);
  update public.sa_organization_memberships set status = 'inactive' where user_id = saf.u(32) and organization_id = saf.o(1);
  perform saf.expect(saf.restore(1, a) like 'sa_membership_required%', '9: an ended membership is refused');
  update public.sa_organization_memberships set status = 'active' where user_id = saf.u(32) and organization_id = saf.o(1);
  perform saf.expect(public.sa_policy_restore_blocker(a) is null, 'restorable again once everything is valid');
end $t$;
do $t$ declare a uuid := saf.grant_id(23, 32, 'sapr-narrow', 1, 1); begin
  perform saf.expect(saf.revoke(23, a) = 'OK', 'revoke');
  update public.sa_business_roles set applicable_org_types = array['DIST'] where role_key = 'sapr-narrow';
  perform saf.expect(public.sa_policy_restore_blocker(a) = 'sa_profile_not_applicable' and saf.restore(1, a) like 'sa_profile_not_applicable%', '9: a policy no longer eligible for the organization type is refused');
end $t$;

-- 10. Temporary grants: the end date is kept, never extended; an ended one is refused.
do $t$ declare a uuid; v_until timestamptz := date_trunc('second', now() + interval '3 days'); n public.sa_role_assignments; begin
  a := saf.grant_id(23, 6, 'order-approver', 1, 1, v_until);
  perform saf.expect(saf.revoke(23, a) = 'OK', 'revoke a temporary grant');
  perform saf.expect((select effective_until from public.sa_role_assignments where id = a) < v_until, 'the revoke cut the validity short');
  perform saf.expect(saf.restore(1, a) = 'OK', '10: a temporary grant still inside its validity is restored');
  select * into n from public.sa_role_assignments where restored_from_assignment_id = a;
  perform saf.expect(n.effective_until = v_until, '10: with its ORIGINAL end date (not extended, not open-ended)');
end $t$;
create table saf.t10 as select saf.grant_id(23, 32, 'warehouse-manager', 1, 1, now() + interval '2 seconds') as id;
select saf.expect(saf.revoke(23, (select id from saf.t10)) = 'OK', 'revoke a short temporary grant');
