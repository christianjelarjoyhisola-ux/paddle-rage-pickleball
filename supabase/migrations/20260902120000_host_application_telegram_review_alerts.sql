-- A verified pending host application is itself the durable notification
-- outbox row. Telegram delivery is best-effort and never rolls back signup or
-- email verification.

alter table public.open_play_host_applications
  add column if not exists email_verified_at timestamptz,
  add column if not exists telegram_notification_sent_at timestamptz,
  add column if not exists telegram_notification_attempts integer not null default 0,
  add column if not exists telegram_notification_last_error text,
  add column if not exists telegram_notification_next_attempt_at timestamptz;

-- Preserve already-confirmed applicants during a rolling deployment. Their
-- pending applications enter the same durable queue and will be delivered by
-- the next verification callback or owner Host Center refresh.
update public.open_play_host_applications h
   set email_verified_at = coalesce(h.email_verified_at, u.email_confirmed_at),
       telegram_notification_next_attempt_at = coalesce(
         h.telegram_notification_next_attempt_at,
         now()
       )
  from auth.users u
 where h.host_user_id = u.id
   and h.status = 'pending'
   and h.email_verified_at is null
   and u.email_confirmed_at is not null
   and lower(h.email) = lower(u.email);

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.open_play_host_applications'::regclass
       and conname = 'open_play_host_applications_telegram_attempts_check'
  ) then
    alter table public.open_play_host_applications
      add constraint open_play_host_applications_telegram_attempts_check
      check (telegram_notification_attempts between 0 and 20);
  end if;
end $$;

create index if not exists idx_host_applications_pending_telegram
  on public.open_play_host_applications (telegram_notification_next_attempt_at, created_at)
  where status = 'pending'
    and email_verified_at is not null
    and telegram_notification_sent_at is null
    and telegram_notification_attempts < 20;

create or replace function public.mark_host_application_email_verified(
  p_host_user_id uuid,
  p_email text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  application_id uuid;
begin
  update public.open_play_host_applications
     set email_verified_at = coalesce(email_verified_at, now()),
         telegram_notification_next_attempt_at = coalesce(
           telegram_notification_next_attempt_at,
           now()
         )
   where host_user_id = p_host_user_id
     and lower(email) = lower(trim(p_email))
     and status = 'pending'
  returning id into application_id;

  return application_id;
end;
$$;

revoke all on function public.mark_host_application_email_verified(uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_host_application_email_verified(uuid, text)
  to service_role;

comment on function public.mark_host_application_email_verified(uuid, text) is
  'Service-only transition that records verified email ownership and makes one pending host-review Telegram alert eligible for delivery.';
