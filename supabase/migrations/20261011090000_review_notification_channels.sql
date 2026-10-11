begin;
create table public.review_notification_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('email','push')),
  target_key text not null,
  destination jsonb not null default '{}',
  enabled boolean not null default true,
  last_test_at timestamptz,
  last_sent_at timestamptz,
  last_error text,
  unique(user_id,channel,target_key)
);
create table public.review_notification_email_changes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  next_send_at timestamptz not null,
  attempts integer not null default 0
);
create table public.review_notification_deliveries (
  target_id uuid not null references public.review_notification_targets(id) on delete cascade,
  kind text not null,
  subject_id text not null,
  pending_since timestamptz not null,
  lease_token uuid,
  next_attempt_at timestamptz not null,
  last_sent_at timestamptz,
  primary key(target_id,kind,subject_id,pending_since)
);
alter table public.review_notification_targets enable row level security;
alter table public.review_notification_email_changes enable row level security;
alter table public.review_notification_deliveries enable row level security;
revoke all on public.review_notification_targets,public.review_notification_email_changes,public.review_notification_deliveries from public,anon,authenticated;
grant all on public.review_notification_targets,public.review_notification_email_changes,public.review_notification_deliveries to service_role;

create function public.begin_review_email_verification(p_user uuid,p_email text,p_hash text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into public.review_notification_email_changes as e(user_id,email,code_hash,expires_at,next_send_at)
  values(p_user,p_email,p_hash,now()+interval '10 minutes',now()+interval '1 minute')
  on conflict(user_id) do update set email=p_email,code_hash=p_hash,expires_at=now()+interval '10 minutes',next_send_at=now()+interval '1 minute',attempts=0
  where e.next_send_at<=now();
  return found;
end $$;
create function public.confirm_review_email(p_user uuid,p_hash text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.review_notification_email_changes;
begin
  select * into e from public.review_notification_email_changes where user_id=p_user for update;
  if not found or e.expires_at<=now() or e.attempts>=5 then return false; end if;
  update public.review_notification_email_changes set attempts=attempts+1 where user_id=p_user;
  if e.code_hash<>p_hash then return false; end if;
  insert into public.review_notification_targets(user_id,channel,target_key,destination)
  values(p_user,'email','email',jsonb_build_object('email',e.email))
  on conflict(user_id,channel,target_key) do update set destination=excluded.destination,enabled=true,last_error=null;
  delete from public.review_notification_email_changes where user_id=p_user;
  return true;
end $$;
create function public.due_review_notifications()
returns table(target_id uuid,kind text,subject_id text,pending_since timestamptz)
language sql security definer set search_path=public,pg_temp as $$
  select t.id,c.kind,c.subject_id,c.pending_since
  from public.review_notification_targets t
  join public.accounts a on a.id=t.user_id and a.status='active' and a.role in ('owner','court_owner','staff')
  cross join public.payment_review_reminder_candidates c
  left join public.review_notification_deliveries d on (d.target_id,d.kind,d.subject_id,d.pending_since)=(t.id,c.kind,c.subject_id,c.pending_since)
  where t.enabled and coalesce(d.next_attempt_at,'-infinity'::timestamptz)<=now()
  order by coalesce(d.next_attempt_at,'-infinity'::timestamptz),c.pending_since,t.id limit 30
$$;
create function public.claim_review_notification(p_target uuid,p_kind text,p_subject text,p_since timestamptz)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare token uuid:=gen_random_uuid(); claimed uuid;
begin
  if not exists(select 1 from public.review_notification_targets t join public.accounts a on a.id=t.user_id
    where t.id=p_target and t.enabled and a.status='active' and a.role in ('owner','court_owner','staff'))
    or not exists(select 1 from public.payment_review_reminder_candidates c where (c.kind,c.subject_id,c.pending_since)=(p_kind,p_subject,p_since)) then return null; end if;
  insert into public.review_notification_deliveries as d(target_id,kind,subject_id,pending_since,lease_token,next_attempt_at)
  values(p_target,p_kind,p_subject,p_since,token,now()+interval '5 minutes')
  on conflict(target_id,kind,subject_id,pending_since) do update set lease_token=token,next_attempt_at=now()+interval '5 minutes'
  where d.next_attempt_at<=now() returning lease_token into claimed;
  return claimed;
end $$;
create function public.finish_review_notification(p_target uuid,p_kind text,p_subject text,p_since timestamptz,p_token uuid,p_sent boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.review_notification_deliveries set lease_token=null,
    last_sent_at=case when p_sent then now() else last_sent_at end,
    next_attempt_at=now()+case when p_sent then interval '1 hour' else interval '5 minutes' end
  where (target_id,kind,subject_id,pending_since,lease_token)=(p_target,p_kind,p_subject,p_since,p_token);
  return found;
end $$;
create function public.claim_review_notification_test(p_target uuid,p_user uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update public.review_notification_targets set last_test_at=now() where id=p_target and user_id=p_user and enabled
 and (last_test_at is null or last_test_at<now()-interval '1 minute');
 return found;
end $$;
revoke all on function public.begin_review_email_verification(uuid,text,text),public.confirm_review_email(uuid,text),public.due_review_notifications(),public.claim_review_notification(uuid,text,text,timestamptz),public.finish_review_notification(uuid,text,text,timestamptz,uuid,boolean),public.claim_review_notification_test(uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_review_email_verification(uuid,text,text),public.confirm_review_email(uuid,text),public.due_review_notifications(),public.claim_review_notification(uuid,text,text,timestamptz),public.finish_review_notification(uuid,text,text,timestamptz,uuid,boolean),public.claim_review_notification_test(uuid,uuid) to service_role;
commit;
