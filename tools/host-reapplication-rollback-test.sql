-- Execute only inside a rollback transaction after the reapplication migration.
select set_config('request.jwt.claim.role','service_role',true);
do $test$
declare old public.open_play_host_applications%rowtype; result jsonb; record jsonb; verified timestamptz; account_before jsonb; account_after jsonb;
begin
 select * into old from public.open_play_host_applications where status='rejected' and host_user_id is not null order by created_at desc limit 1;
 if old.id is null then raise exception 'Missing rejected test context'; end if;
 select to_jsonb(a) into account_before from accounts a where id=old.host_user_id;
 record:=to_jsonb(old)||jsonb_build_object('id',gen_random_uuid(),'status','approved','review_note','Injected review');
 select email_confirmed_at into verified from auth.users where id=old.host_user_id;
 update auth.users set email_confirmed_at=null where id=old.host_user_id;
 begin
  perform resubmit_host_application(old.id,old.host_user_id,record);
  raise exception 'Unverified identity accepted';
 exception when insufficient_privilege then null;
 end;
 update auth.users set email_confirmed_at=coalesce(verified,now()) where id=old.host_user_id;
 delete from host_reapplication_recovery_limits where user_id=old.host_user_id;
 if not claim_host_reapplication_recovery(old.host_user_id) then raise exception 'Recovery denied';end if;
 if claim_host_reapplication_recovery(old.host_user_id) then raise exception 'Recovery not throttled';end if;
 result:=resubmit_host_application(old.id,old.host_user_id,record);
 if not exists(select 1 from open_play_host_applications where id=(result->>'id')::uuid and status='pending' and email_verified_at is not null and reapplied_from=old.id and review_note is null) then raise exception 'New application incorrect'; end if;
 if not exists(select 1 from open_play_host_applications where id=old.id and status='rejected' and review_note is not distinct from old.review_note) then raise exception 'History overwritten';end if;
 select to_jsonb(a) into account_after from accounts a where id=old.host_user_id;
 if account_before is distinct from account_after then raise exception 'Account access changed';end if;
 begin
  perform resubmit_host_application(old.id,old.host_user_id,record||jsonb_build_object('id',gen_random_uuid()));
  raise exception 'Duplicate accepted';
 exception when unique_violation then null;
 end;
 perform set_config('request.jwt.claim.role','authenticated',true);
 begin
  perform resubmit_host_application(old.id,old.host_user_id,record);
  raise exception 'Public RPC allowed';
 exception when insufficient_privilege then null;
 end;
end $test$;
