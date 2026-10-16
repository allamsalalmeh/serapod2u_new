-- Negative control on the UNPATCHED schema (before 20261108100000): there is no restore of an administrator grant, and
-- granting the policy again overwrites the revoked row, so Access history loses it. Rolled back: changes nothing.
begin;
select saf.expect(to_regprocedure('public.sa_restore_policy_grant(uuid,uuid)') is null, 'before: no restore function');
do $t$ declare v_first uuid; v_again uuid; begin
  v_first := saf.grant_id(23, 32, 'order-approver', 1, 1);
  perform saf.expect(saf.revoke(23, v_first) = 'OK', 'before: revoke');
  perform saf.expect(saf.try(format($q$select public.sa_restore_assignment(%L, %L, 'Bring it back please')$q$, saf.u(23), v_first)) like 'sa_assignment_not_restorable%',
    'before: the automatic-access restore refuses an administrator grant');
  v_again := saf.grant_id(23, 32, 'order-approver', 1, 1);
  perform saf.expect(v_again = v_first, 'before: granting again REUSES the revoked row (history overwritten)');
  perform saf.expect((select count(*) from public.sa_role_assignments where user_id = saf.u(32) and role_id = saf.role('order-approver')) = 1, 'before: one row ever per identity');
end $t$;
rollback;
