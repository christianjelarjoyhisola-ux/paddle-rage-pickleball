-- Release abandoned public booking placeholders consistently.
--
-- A receipt-review safeguard added in 20260901090000 converted an anonymous
-- placeholder cancellation into a permanent pending/manual-review booking.
-- Those rows were hidden from the admin booking list but still occupied slots
-- in public availability and in the database conflict guard.

create or replace function public.booking_occupies_slot(
  booking_status text,
  booking_email text,
  booking_full_name text,
  booking_created_at timestamptz
)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when lower(btrim(coalesce(booking_status, ''))) in ('cancelled', 'forfeited')
      then false
    when booking_created_at is not null
      and booking_created_at <= now() - interval '15 minutes'
      and (
        lower(btrim(coalesce(booking_status, ''))) = 'verifying'
        or lower(btrim(coalesce(booking_email, ''))) = 'reserve@hold.internal'
        or lower(btrim(coalesce(booking_full_name, ''))) like 'reserving%'
      )
      then false
    else true
  end
$$;

comment on function public.booking_occupies_slot(text, text, text, timestamptz) is
  'Canonical occupancy predicate: terminal bookings and temporary holds older than 15 minutes do not reserve court capacity.';

revoke all on function public.booking_occupies_slot(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.booking_occupies_slot(text, text, text, timestamptz)
  to anon, authenticated, service_role;

create or replace function public.prevent_automatic_booking_rejection()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  method_value text := lower(trim(coalesce(new.payment_method, 'cash')));
  actor_role text := public.current_account_role();
  digital_payment boolean := method_value in (
    'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'
  );
  active_submission boolean := tg_op = 'INSERT' or (
    old.status in ('verifying', 'pending')
    and old.payment_status in ('unpaid', 'pending', 'for_verification')
  );
  placeholder_hold boolean :=
    lower(trim(coalesce(new.email, ''))) = 'reserve@hold.internal'
    or lower(trim(coalesce(new.full_name, ''))) like 'reserving%';
begin
  if method_value in ('gotyme', 'maribank') then
    new.received_account := 'gcash';
  end if;

  -- Placeholder rows use GCash only as an insert-time default. They do not
  -- represent a submitted payment and must be allowed to expire normally.
  if placeholder_hold then
    return new;
  end if;

  if digital_payment
     and active_submission
     and actor_role not in ('owner', 'court_owner')
     and (
       new.receipt_status = 'rejected'
       or new.payment_status = 'rejected'
     ) then
    new.status := 'pending';
    new.payment_status := 'for_verification';
    new.receipt_status := 'manual_review';
    new.receipt_flags := public.automatic_rejection_review_flags(
      new.receipt_flags
    );
    new.paid_at := case when tg_op = 'UPDATE' then old.paid_at else null end;
  end if;
  return new;
end;
$$;

-- The payment-decision guard must also permit an evidence-free placeholder to
-- move to its terminal rejected state. Genuine customer payments still pass
-- through the original role guard.
drop trigger if exists y90_guard_booking_payment_decision_role
  on public.bookings;
create trigger y90_guard_booking_payment_decision_role
before update of payment_status, payment_method, receipt_status, receipt_flags
on public.bookings
for each row
when (
  not (
    (
      lower(btrim(coalesce(new.email, ''))) = 'reserve@hold.internal'
      or lower(btrim(coalesce(new.full_name, ''))) like 'reserving%'
    )
    and new.status in ('cancelled', 'forfeited')
    and new.receipt_image_url is null
    and new.receipt_image_hash is null
    and nullif(btrim(coalesce(new.gcash_ref, '')), '') is null
  )
)
execute function public.guard_digital_payment_decision_role();

create or replace function public.get_public_booking_availability(
  p_date date default null,
  p_court_id text default null
)
returns table (
  court_id text,
  court_name text,
  date date,
  slots text[],
  status text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    b.court_id,
    b.court_name,
    b.date,
    b.slots,
    b.status,
    b.created_at
  from public.bookings b
  where b.date >= current_date - 1
    and b.date <= current_date + 366
    and (p_date is null or b.date = p_date)
    and (nullif(trim(coalesce(p_court_id, '')), '') is null or b.court_id = p_court_id)
    and public.booking_occupies_slot(b.status, b.email, b.full_name, b.created_at)
  order by b.created_at desc
$$;

create or replace function public.prevent_double_booking()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  lock_slot text;
begin
  if tg_op = 'UPDATE'
     and new.court_id is not distinct from old.court_id
     and new.date is not distinct from old.date
     and new.status is not distinct from old.status
     and new.ref is not distinct from old.ref
     and new.slots is not distinct from old.slots then
    return new;
  end if;

  if not public.booking_occupies_slot(
    new.status, new.email, new.full_name, new.created_at
  ) then
    return new;
  end if;

  for lock_slot in
    select distinct requested.slot_value
    from unnest(coalesce(new.slots, '{}'::text[])) as requested(slot_value)
    order by requested.slot_value
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(
        'paddle-rage-booking-slot|' || coalesce(new.court_id::text, '') || '|' ||
        coalesce(new.date::text, '') || '|' || lock_slot,
        0
      )
    );
  end loop;

  if exists (
    select 1
    from public.bookings booking
    where booking.court_id = new.court_id
      and booking.date = new.date
      and booking.ref <> new.ref
      and booking.slots && new.slots
      and public.booking_occupies_slot(
        booking.status,
        booking.email,
        booking.full_name,
        booking.created_at
      )
  ) then
    raise exception 'One or more time slots are already booked for this court and date.';
  end if;

  return new;
end;
$$;

comment on function public.prevent_double_booking() is
  'Serializes active Paddle Rage booking writes and ignores expired temporary placeholders.';

-- Repair only unambiguously abandoned, evidence-free placeholders. Keep all
-- rows that contain a payment reference or stored receipt for owner review.
update public.bookings booking
set status = 'cancelled',
    payment_status = 'rejected',
    receipt_status = 'rejected'
where booking.status in ('verifying', 'pending')
  and booking.created_at is not null
  and booking.created_at <= now() - interval '15 minutes'
  and (
    lower(btrim(coalesce(booking.email, ''))) = 'reserve@hold.internal'
    or lower(btrim(coalesce(booking.full_name, ''))) like 'reserving%'
  )
  and booking.receipt_image_url is null
  and booking.receipt_image_hash is null
  and nullif(btrim(coalesce(booking.gcash_ref, '')), '') is null;

notify pgrst, 'reload schema';
