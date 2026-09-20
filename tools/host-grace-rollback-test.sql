-- Run after the migration inside a transaction, then ROLLBACK. No customer rows are edited.
do $$
declare owner_id uuid; court text; result jsonb; rejected boolean; start_at timestamptz;
begin
  select id into owner_id from public.accounts where role='owner' and status='active' limit 1;
  if owner_id is null then raise exception 'Owner test identity unavailable'; end if;
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  select court_id into court from public.bookings where court_id is not null limit 1;
  insert into public.bookings(ref,booking_group_ref,full_name,court_id,court_name,date,slots,start_time,end_time,duration,rate,total,downpayment,host_booking,status,payment_status,forfeited_at,forfeiture_reason)
  values ('GRACE-ROLLBACK-A','GRACE-ROLLBACK','Rollback test',court,'Test',current_date+90,array['07:00'],'07:00','08:00',1,400,400,100,true,'forfeited','deposit_retained',now(),'Test forfeiture'),
         ('GRACE-ROLLBACK-B','GRACE-ROLLBACK','Rollback test',court,'Test',current_date+91,array['07:00'],'07:00','08:00',1,400,400,100,true,'forfeited','deposit_retained',now(),'Test forfeiture');
  result := public.reopen_forfeited_host_booking('GRACE-ROLLBACK','Customer requested another chance');
  if jsonb_array_length(result->'refs') <> 2 then raise exception 'Group not atomic'; end if;
  if (select count(*) from public.bookings where booking_group_ref='GRACE-ROLLBACK' and status='confirmed' and payment_status='downpayment_paid' and downpayment=100 and balance_due_at > now()+interval '23 hours') <> 2 then raise exception 'Deposit or deadline failure'; end if;
  update public.bookings set balance_due_at=now()+interval '10 days', balance_grace_granted_at=null where ref='GRACE-ROLLBACK-A';
  if exists(select 1 from public.bookings where ref='GRACE-ROLLBACK-A' and (balance_due_at > now()+interval '25 hours' or balance_grace_granted_at is null)) then raise exception 'Client override accepted'; end if;
  update public.bookings set status='forfeited',payment_status='deposit_retained' where booking_group_ref='GRACE-ROLLBACK';
  rejected := false;
  begin perform public.reopen_forfeited_host_booking('GRACE-ROLLBACK-B','Second extension must fail'); exception when others then
    if sqlerrm not like '%one-time extension%' then raise; end if; rejected:=true; end;
  if not rejected then raise exception 'Repeat extension accepted'; end if;

  -- A released slot claimed by another booking must block the entire group.
  insert into public.bookings(ref,full_name,court_id,court_name,date,slots,start_time,end_time,duration,rate,total,downpayment,host_booking,status,payment_status)
  values ('GRACE-CONFLICT','Test',court,'Test',current_date+92,array['07:00'],'07:00','08:00',1,400,400,100,true,'forfeited','deposit_retained'),
         ('GRACE-OCCUPIED','Test',court,'Test',current_date+92,array['07:00'],'07:00','08:00',1,400,400,400,true,'confirmed','paid');
  rejected:=false;
  begin perform public.reopen_forfeited_host_booking('GRACE-CONFLICT','Conflicting slot must fail'); exception when others then
    if sqlerrm not like '%booked again%' then raise; end if; rejected:=true; end;
  if not rejected then raise exception 'Occupied slot reopened'; end if;
  if exists(select 1 from public.host_booking_grace_audit where booking_key='GRACE-CONFLICT') then raise exception 'Rejected action consumed extension'; end if;

  -- Earlier play time caps the extension instead of granting time after play starts.
  start_at := date_trunc('hour',now()) + interval '2 hours';
  insert into public.bookings(ref,full_name,court_id,court_name,date,slots,start_time,end_time,duration,rate,total,downpayment,host_booking,status,payment_status)
  values ('GRACE-CAPPED','Test',court,'Test',(start_at at time zone 'Asia/Manila')::date,
    array[to_char(start_at at time zone 'Asia/Manila','HH24:MI')],to_char(start_at at time zone 'Asia/Manila','HH24:MI'),
    to_char((start_at+interval '1 hour') at time zone 'Asia/Manila','HH24:MI'),1,400,400,100,true,'forfeited','deposit_retained');
  -- Cancel only our fixture if its time happens to overlap real bookings: this test should fail safely rather than modify them.
  result := public.reopen_forfeited_host_booking('GRACE-CAPPED','Cap deadline at play start');
  if (result->>'balanceDueAt')::timestamptz <> start_at then raise exception 'Deadline not capped'; end if;
  update public.host_booking_grace_audit set deadline_at=now()-interval '1 minute' where booking_key='GRACE-CAPPED';
  update public.bookings set balance_due_at=now() where ref='GRACE-CAPPED';
  perform set_config('request.jwt.claim.role','service_role',true);
  result:=public.forfeit_overdue_host_booking('GRACE-CAPPED');
  if (result->>'changed')::integer <> 1 then raise exception 'Expired grace did not forfeit'; end if;
  if not exists(select 1 from public.bookings where ref='GRACE-CAPPED' and status='forfeited' and downpayment=100 and payment_status='deposit_retained') then raise exception 'Reforfeiture damaged deposit'; end if;
end $$;
