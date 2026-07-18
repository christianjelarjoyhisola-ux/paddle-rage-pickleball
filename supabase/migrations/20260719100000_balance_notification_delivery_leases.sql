-- Prevent overlapping cron and administrator runs from sending the same host
-- balance notification concurrently. The unique booking/event row is also the
-- lease record; INSERT ... ON CONFLICT serializes every claimant in Postgres.

begin;

alter table public.booking_balance_notifications
  add column if not exists delivery_lease_token uuid,
  add column if not exists delivery_lease_expires_at timestamptz;

-- Preserve a short lease for a deployment already in flight. Old abandoned
-- pending rows remain immediately reclaimable once their historical timeout
-- has elapsed.
update public.booking_balance_notifications
   set last_attempt_at = coalesce(last_attempt_at, created_at, now()),
       delivery_lease_token = coalesce(delivery_lease_token, gen_random_uuid()),
       delivery_lease_expires_at = coalesce(
         delivery_lease_expires_at,
         coalesce(last_attempt_at, created_at, now()) + interval '10 minutes'
       )
 where status = 'pending'
   and (delivery_lease_token is null or delivery_lease_expires_at is null);

update public.booking_balance_notifications
   set delivery_lease_token = null,
       delivery_lease_expires_at = null
 where status <> 'pending'
   and (delivery_lease_token is not null or delivery_lease_expires_at is not null);

alter table public.booking_balance_notifications
  drop constraint if exists booking_balance_notifications_lease_pair_check;

alter table public.booking_balance_notifications
  add constraint booking_balance_notifications_lease_pair_check
  check (
    (
      status = 'pending'
      and delivery_lease_token is not null
      and delivery_lease_expires_at is not null
      and last_attempt_at is not null
      and delivery_lease_expires_at > last_attempt_at
    )
    or (
      status <> 'pending'
      and delivery_lease_token is null
      and delivery_lease_expires_at is null
    )
  );

create index if not exists idx_booking_balance_notifications_active_lease
  on public.booking_balance_notifications(delivery_lease_expires_at)
  where status = 'pending';

create or replace function public.claim_booking_balance_notification(
  p_booking_key text,
  p_booking_ref text,
  p_event_type text,
  p_recipient_email text,
  p_force boolean default false,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lease_token uuid := gen_random_uuid();
  lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 300), 900));
  claimed public.booking_balance_notifications%rowtype;
  current_notice public.booking_balance_notifications%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the balance processor may claim notifications.' using errcode = '42501';
  end if;

  p_booking_key := trim(coalesce(p_booking_key, ''));
  p_booking_ref := trim(coalesce(p_booking_ref, ''));
  p_event_type := trim(coalesce(p_event_type, ''));
  p_recipient_email := lower(trim(coalesce(p_recipient_email, '')));

  if p_booking_key = '' or length(p_booking_key) > 160 then
    raise exception 'Invalid booking notification key.' using errcode = '22023';
  end if;
  if p_booking_ref = '' or length(p_booking_ref) > 160 then
    raise exception 'Invalid booking reference.' using errcode = '22023';
  end if;
  if p_event_type not in ('reminder_3d', 'reminder_2d', 'reminder_1d', 'forfeited', 'manual') then
    raise exception 'Invalid balance notification event.' using errcode = '22023';
  end if;
  if p_recipient_email = '' or length(p_recipient_email) > 254 then
    raise exception 'Invalid notification recipient.' using errcode = '22023';
  end if;

  insert into public.booking_balance_notifications as notice (
    booking_key,
    booking_ref,
    event_type,
    recipient_email,
    status,
    attempt_count,
    error_message,
    last_attempt_at,
    delivery_lease_token,
    delivery_lease_expires_at
  ) values (
    p_booking_key,
    p_booking_ref,
    p_event_type,
    p_recipient_email,
    'pending',
    1,
    null,
    now(),
    lease_token,
    now() + make_interval(secs => lease_seconds)
  )
  on conflict (booking_key, event_type) do update
     set booking_ref = excluded.booking_ref,
         recipient_email = excluded.recipient_email,
         status = 'pending',
         attempt_count = notice.attempt_count + 1,
         error_message = null,
         last_attempt_at = excluded.last_attempt_at,
         delivery_lease_token = excluded.delivery_lease_token,
         delivery_lease_expires_at = excluded.delivery_lease_expires_at
   where notice.status = 'failed'
      or (
        notice.status = 'pending'
        and coalesce(notice.delivery_lease_expires_at, '-infinity'::timestamptz) <= now()
      )
      or (coalesce(p_force, false) and notice.status = 'sent')
  returning notice.* into claimed;

  if claimed.id is not null then
    return jsonb_build_object(
      'acquired', true,
      'id', claimed.id,
      'claimToken', claimed.delivery_lease_token,
      'attemptCount', claimed.attempt_count,
      'leaseExpiresAt', claimed.delivery_lease_expires_at
    );
  end if;

  select *
    into current_notice
    from public.booking_balance_notifications
   where booking_key = p_booking_key
     and event_type = p_event_type;

  return jsonb_build_object(
    'acquired', false,
    'id', current_notice.id,
    'reason', case
      when current_notice.status = 'sent' then 'already_sent'
      when current_notice.status = 'pending' then 'lease_active'
      else 'not_claimed'
    end,
    'leaseExpiresAt', current_notice.delivery_lease_expires_at
  );
end;
$$;

revoke all on function public.claim_booking_balance_notification(
  text, text, text, text, boolean, integer
) from public, anon, authenticated;
grant execute on function public.claim_booking_balance_notification(
  text, text, text, text, boolean, integer
) to service_role;

create or replace function public.finish_booking_balance_notification(
  p_notification_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  completed_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the balance processor may finish notifications.' using errcode = '42501';
  end if;
  if p_notification_id is null or p_claim_token is null then
    raise exception 'A notification id and claim token are required.' using errcode = '22023';
  end if;
  if p_outcome not in ('sent', 'failed') then
    raise exception 'Invalid notification outcome.' using errcode = '22023';
  end if;
  if p_outcome = 'sent' and trim(coalesce(p_provider_message_id, '')) = '' then
    raise exception 'A provider message id is required for a sent notice.' using errcode = '22023';
  end if;

  update public.booking_balance_notifications
     set status = p_outcome,
         provider_message_id = case
           when p_outcome = 'sent' then left(trim(p_provider_message_id), 512)
           else provider_message_id
         end,
         sent_at = case when p_outcome = 'sent' then now() else sent_at end,
         error_message = case
           when p_outcome = 'failed' then left(coalesce(p_error_message, 'Email provider request failed'), 2000)
           else null
         end,
         delivery_lease_token = null,
         delivery_lease_expires_at = null
   where id = p_notification_id
     and status = 'pending'
     and delivery_lease_token = p_claim_token
  returning id into completed_id;

  return completed_id is not null;
end;
$$;

revoke all on function public.finish_booking_balance_notification(
  uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.finish_booking_balance_notification(
  uuid, uuid, text, text, text
) to service_role;

comment on function public.claim_booking_balance_notification(text, text, text, text, boolean, integer)
  is 'Atomically acquires a bounded single-sender lease for one booking balance event.';
comment on function public.finish_booking_balance_notification(uuid, uuid, text, text, text)
  is 'Finalizes a balance notice only when the caller still owns its delivery lease.';

notify pgrst, 'reload schema';

commit;
