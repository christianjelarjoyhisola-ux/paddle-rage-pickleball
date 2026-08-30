-- Keep a submitted host balance receipt visible and immutable until an owner
-- records the audited decision. The balance-payment service uses service_role
-- for approval/rejection; ordinary dashboard updates must not bypass it.

create or replace function public.protect_pending_host_balance_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed boolean := true;
begin
  if tg_op = 'UPDATE' then
    v_changed :=
      old.status is distinct from new.status or
      old.payment_status is distinct from new.payment_status or
      old.date is distinct from new.date or
      old.start_time is distinct from new.start_time or
      old.end_time is distinct from new.end_time or
      old.duration is distinct from new.duration or
      old.slots is distinct from new.slots or
      old.court_id is distinct from new.court_id or
      old.court_name is distinct from new.court_name or
      old.total is distinct from new.total or
      old.downpayment is distinct from new.downpayment or
      old.balance_due_at is distinct from new.balance_due_at or
      old.booking_group_ref is distinct from new.booking_group_ref or
      old.host_booking is distinct from new.host_booking;
  end if;

  if v_changed
     and auth.role() is distinct from 'service_role'
     and exists (
       select 1
       from public.host_booking_balance_payments payment
       where payment.status = 'pending_review'
         and (
           old.ref = payment.booking_ref or
           old.ref = payment.booking_group_ref or
           old.ref = payment.booking_key or
           old.ref = any(coalesce(payment.booking_refs, array[]::text[])) or
           (
             old.booking_group_ref is not null and (
               old.booking_group_ref = payment.booking_ref or
               old.booking_group_ref = payment.booking_group_ref or
               old.booking_group_ref = payment.booking_key or
               old.booking_group_ref = any(coalesce(payment.booking_refs, array[]::text[]))
             )
           )
         )
     ) then
    raise exception 'Resolve the pending host balance receipt before changing or deleting this booking.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.protect_pending_host_balance_booking()
  from public, anon, authenticated;

drop trigger if exists protect_pending_host_balance_booking
  on public.bookings;
create trigger protect_pending_host_balance_booking
before update or delete on public.bookings
for each row
execute function public.protect_pending_host_balance_booking();

comment on function public.protect_pending_host_balance_booking() is
  'Prevents dashboard mutations, reschedules, forfeitures, and deletes while an audited host balance receipt awaits owner review.';

-- Serialize reminder claims with receipt submission by locking the same active
-- balance-payment row first. If submission won the lock, the reminder is not
-- claimed; if the reminder won, its claim was authorized before submission.
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
  booking_count integer;
  booking_payable boolean;
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

  perform 1
  from public.host_booking_balance_payments payment
  where (
      payment.booking_key in (p_booking_key, p_booking_ref) or
      payment.booking_ref in (p_booking_key, p_booking_ref) or
      payment.booking_group_ref in (p_booking_key, p_booking_ref) or
      p_booking_key = any(coalesce(payment.booking_refs, array[]::text[])) or
      p_booking_ref = any(coalesce(payment.booking_refs, array[]::text[]))
    )
  order by payment.id
  for update;

  if exists (
    select 1
    from public.host_booking_balance_payments payment
    where payment.status = 'pending_review'
      and (
        payment.booking_key in (p_booking_key, p_booking_ref) or
        payment.booking_ref in (p_booking_key, p_booking_ref) or
        payment.booking_group_ref in (p_booking_key, p_booking_ref) or
        p_booking_key = any(coalesce(payment.booking_refs, array[]::text[])) or
        p_booking_ref = any(coalesce(payment.booking_refs, array[]::text[]))
      )
  ) then
    return jsonb_build_object(
      'acquired', false,
      'id', null,
      'reason', 'balance_pending_review',
      'leaseExpiresAt', null
    );
  end if;

  if exists (
    select 1
    from public.host_booking_balance_payments payment
    where payment.status = 'approved'
      and (
        payment.booking_key in (p_booking_key, p_booking_ref) or
        payment.booking_ref in (p_booking_key, p_booking_ref) or
        payment.booking_group_ref in (p_booking_key, p_booking_ref) or
        p_booking_key = any(coalesce(payment.booking_refs, array[]::text[])) or
        p_booking_ref = any(coalesce(payment.booking_refs, array[]::text[]))
      )
  ) then
    return jsonb_build_object(
      'acquired', false,
      'id', null,
      'reason', 'balance_already_paid',
      'leaseExpiresAt', null
    );
  end if;

  -- Keep the same payment-row -> booking-row lock order as balance submission
  -- and approval. Revalidate the canonical group inside this transaction so a
  -- stale Edge Function snapshot cannot lease a reminder after settlement.
  perform 1
  from public.bookings booking
  where booking.ref in (p_booking_key, p_booking_ref)
     or booking.booking_group_ref in (p_booking_key, p_booking_ref)
  order by booking.ref
  for update;

  select
    count(*)::integer,
    bool_and(
      coalesce(booking.host_booking, false)
      and case
        when p_event_type = 'forfeited' then
          booking.status = 'forfeited'
          and booking.payment_status = 'deposit_retained'
        else
          booking.status = 'confirmed'
          and booking.payment_status = 'downpayment_paid'
          and booking.balance_due_at is not null
          and booking.balance_due_at > clock_timestamp()
      end
    )
  into booking_count, booking_payable
  from public.bookings booking
  where booking.ref in (p_booking_key, p_booking_ref)
     or booking.booking_group_ref in (p_booking_key, p_booking_ref);

  if booking_count = 0 or not coalesce(booking_payable, false) then
    return jsonb_build_object(
      'acquired', false,
      'id', null,
      'reason', 'booking_not_payable',
      'leaseExpiresAt', null
    );
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

comment on function public.claim_booking_balance_notification(text, text, text, text, boolean, integer) is
  'Atomically leases a balance notice after locking payment history and revalidating the canonical booking group.';

-- The Admin Bookings view invalidates its pending-payment cache from Realtime.
-- Supabase does not automatically publish newly created tables in every project.
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'host_booking_balance_payments'
  ) then
    alter publication supabase_realtime
      add table public.host_booking_balance_payments;
  end if;
end;
$$;
