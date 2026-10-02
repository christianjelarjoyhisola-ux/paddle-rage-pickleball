begin;
alter table public.open_play_host_applications add column if not exists reapplied_from uuid references public.open_play_host_applications(id);
create unique index if not exists host_application_one_current_email on public.open_play_host_applications(lower(trim(email))) where status in ('pending','approved');
create or replace function public.resubmit_host_application(p_previous uuid,p_user uuid,p_record jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare previous public.open_play_host_applications%rowtype; candidate public.open_play_host_applications%rowtype; login auth.users%rowtype; new_id uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service only' using errcode='42501'; end if;
 select * into previous from public.open_play_host_applications where id=p_previous for update;
 select * into login from auth.users where id=p_user;
 if previous.id is null or previous.status<>'rejected' or previous.host_user_id is distinct from p_user
    or lower(trim(previous.email)) is distinct from lower(login.email) or login.email_confirmed_at is null
    or coalesce(login.raw_user_meta_data->>'role','')<>'host'
    or coalesce(login.raw_app_meta_data->>'role','authenticated') not in ('authenticated','host') then
   raise exception 'A verified rejected host account is required' using errcode='42501';
 end if;
 if exists(select 1 from public.accounts where (id=p_user or lower(email)=lower(login.email) or lower(username)=lower(login.email)) and (id<>p_user or role<>'host' or status<>'suspended')) then
   raise exception 'Account is not eligible for reapplication' using errcode='42501';
 end if;
 if exists(select 1 from public.open_play_host_applications where lower(trim(email))=lower(login.email) and status in ('pending','approved')) then
   raise exception 'An application is already pending or approved' using errcode='23505';
 end if;
 candidate:=jsonb_populate_record(null::public.open_play_host_applications,p_record);
 insert into public.open_play_host_applications(id,host_user_id,full_name,contact_number,email,gcash_number,valid_id_file_name,valid_id_file_type,valid_id_file_size,valid_id_path,preferred_schedule,notes,status,email_verified_at,created_at,reapplied_from)
 values(candidate.id,p_user,candidate.full_name,candidate.contact_number,lower(login.email),candidate.gcash_number,candidate.valid_id_file_name,candidate.valid_id_file_type,candidate.valid_id_file_size,candidate.valid_id_path,candidate.preferred_schedule,candidate.notes,'pending',login.email_confirmed_at,now(),previous.id)
 returning id into new_id;
 return jsonb_build_object('id',new_id);
end $$;
revoke all on function public.resubmit_host_application(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.resubmit_host_application(uuid,uuid,jsonb) to service_role;

create table public.host_reapplication_recovery_limits (
 user_id uuid primary key references auth.users(id) on delete cascade,
 window_start timestamptz not null default now(), last_requested_at timestamptz not null default now(), attempts integer not null default 1
);
alter table public.host_reapplication_recovery_limits enable row level security;
revoke all on public.host_reapplication_recovery_limits from anon,authenticated;
create function public.claim_host_reapplication_recovery(p_user uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare claimed uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service only' using errcode='42501';end if;
 if not exists(select 1 from open_play_host_applications a join auth.users u on u.id=a.host_user_id where a.host_user_id=p_user and a.status='rejected' and lower(a.email)=lower(u.email) and u.email_confirmed_at is not null and u.raw_user_meta_data->>'role'='host')
 or exists(select 1 from accounts where id=p_user and role<>'host') then return false;end if;
 insert into public.host_reapplication_recovery_limits as l(user_id) values(p_user)
 on conflict(user_id) do update set window_start=case when l.window_start<=now()-interval '24 hours' then now() else l.window_start end,
 attempts=case when l.window_start<=now()-interval '24 hours' then 1 else l.attempts+1 end,last_requested_at=now()
 where l.last_requested_at<=now()-interval '5 minutes' and (l.window_start<=now()-interval '24 hours' or l.attempts<5)
 returning user_id into claimed;
 return claimed is not null;
end $$;
revoke all on function public.claim_host_reapplication_recovery(uuid) from public,anon,authenticated;
grant execute on function public.claim_host_reapplication_recovery(uuid) to service_role;

commit;
