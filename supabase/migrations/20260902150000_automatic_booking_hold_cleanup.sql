-- Prevent temporary checkout locks from remaining in the booking ledger.
--
-- Checkout placeholders protect a slot from double booking while the player
-- completes the form. They are not customer bookings. Release a token-owned
-- placeholder immediately, and remove abandoned groups after a conservative
-- 30-minute cleanup grace. Court capacity still releases at 15 minutes.

begin;

-- Only a row that still has the exact server-created placeholder identity and
-- absolutely no customer, receipt, settlement, or notification evidence may be
-- hard-released. Keep this predicate deliberately stricter than the UI filter.
create or replace function public.is_evidence_free_booking_hold(
  p_booking public.bookings
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    lower(btrim(coalesce((p_booking).email, ''))) = 'reserve@hold.internal'
    and lower(btrim(coalesce((p_booking).full_name, ''))) in ('reserving...', 'reserving…')
    and btrim(coalesce((p_booking).contact_number, '')) = '00000000000'
    and (p_booking).status in ('verifying', 'pending', 'cancelled')
    and coalesce((p_booking).payment_status, 'unpaid') in
      ('unpaid', 'pending', 'for_verification', 'rejected')
    and nullif(btrim(coalesce((p_booking).payment_provider, '')), '') is null
    and nullif(btrim(coalesce((p_booking).payment_session_id, '')), '') is null
    and nullif(btrim(coalesce((p_booking).payment_checkout_url, '')), '') is null
    and nullif(btrim(coalesce((p_booking).payment_flow, '')), '') is null
    and nullif(btrim(coalesce((p_booking).gcash_ref, '')), '') is null
    -- Public customer holds are created through submit-public-booking, which
    -- stamps the authoritative full total into downpayment before any customer
    -- details or payment evidence exist. Authenticated host holds remain null
    -- until they are finalized. Accept only those two canonical hold shapes.
    and (
      (
        coalesce((p_booking).created_via, '') = 'customer'
        and not coalesce((p_booking).host_booking, false)
        and (p_booking).host_user_id is null
        and (p_booking).created_by_user_id is null
        and (p_booking).total is not null
        and (p_booking).downpayment = (p_booking).total
        and (
          (p_booking).customer_access_token_hash is null
          or lower((p_booking).customer_access_token_hash) ~ '^[0-9a-f]{64}$'
        )
      )
      or (
        coalesce((p_booking).created_via, '') = 'host'
        and coalesce((p_booking).host_booking, false)
        and (p_booking).host_user_id is not null
        and (p_booking).created_by_user_id = (p_booking).host_user_id
        and coalesce((p_booking).created_by_role, '') = 'host'
        and (p_booking).customer_access_token_hash is null
        and (p_booking).downpayment is null
      )
    )
    and (p_booking).paid_at is null
    and (p_booking).balance_due_at is null
    and (p_booking).forfeited_at is null
    and nullif(btrim(coalesce((p_booking).forfeiture_reason, '')), '') is null
    and nullif(btrim(coalesce((p_booking).receipt_image_url, '')), '') is null
    and nullif(btrim(coalesce((p_booking).receipt_image_hash, '')), '') is null
    and nullif(btrim(coalesce((p_booking).receipt_phash, '')), '') is null
    and (
      lower(btrim(coalesce((p_booking).receipt_status, 'none'))) = 'none'
      or (
        (p_booking).status = 'cancelled'
        and (p_booking).payment_status = 'rejected'
        and lower(btrim(coalesce((p_booking).receipt_status, 'none'))) = 'rejected'
      )
    )
    and coalesce(cardinality((p_booking).receipt_flags), 0) = 0
    and (p_booking).receipt_extracted is null
    and (p_booking).receipt_confidence is null
    and (p_booking).receipt_verified_at is null
    and (p_booking).booking_fee_earned_at is null
    and (p_booking).billed_at is null
    and (p_booking).weekly_fee_id is null
    and nullif(btrim(coalesce((p_booking).confirmation_email_id, '')), '') is null
    and (p_booking).confirmation_email_sent_at is null
    and nullif(btrim(coalesce((p_booking).confirmation_email_last_event, '')), '') is null
    and (p_booking).confirmation_email_claim_token is null
    and (p_booking).confirmation_email_claim_expires_at is null,
    false
  )
$$;

revoke all on function public.is_evidence_free_booking_hold(public.bookings)
  from public, anon, authenticated, service_role;

-- Receipt/audit rows can be committed before the corresponding booking update.
-- Treat any related durable record as evidence and fail closed for the group.
create or replace function public.booking_hold_group_has_no_durable_evidence(
  p_refs text[],
  p_group_key text
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select
    not exists (
      select 1 from public.receipt_verifications evidence
       where evidence.booking_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
    )
    and not exists (
      select 1 from public.used_gcash_refs evidence
       where evidence.booking_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
          or evidence.claim_owner_id = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
    )
    and not exists (
      select 1 from public.payment_sessions evidence
       where evidence.booking_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
    )
    and not exists (
      select 1 from public.receipt_verification_leases evidence
       where evidence.booking_key = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
         and evidence.lease_expires_at > now()
    )
    and not exists (
      select 1 from public.payment_review_decisions evidence
       where evidence.booking_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
          or evidence.booking_group_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
    )
    and not exists (
      select 1 from public.host_booking_balance_payments evidence
       where evidence.booking_key = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
          or evidence.booking_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
          or evidence.booking_group_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
          or evidence.booking_refs && array_append(coalesce(p_refs, array[]::text[]), p_group_key)
    )
    and not exists (
      select 1 from public.booking_balance_notifications evidence
       where evidence.booking_key = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
          or evidence.booking_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
    )
    and not exists (
      select 1 from public.booking_fee_remittance_items evidence
       where evidence.booking_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
          or evidence.booking_group_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
    )
    and not exists (
      select 1 from public.booking_fee_adjustments evidence
       where evidence.booking_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
          or evidence.booking_group_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
    )
    and not exists (
      select 1 from public.booking_fee_adjustment_applications evidence
       where evidence.booking_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
          or evidence.booking_group_ref = any(array_append(coalesce(p_refs, array[]::text[]), p_group_key))
    )
$$;

revoke all on function public.booking_hold_group_has_no_durable_evidence(text[], text)
  from public, anon, authenticated, service_role;

-- Receipt verification claims and hold deletion share this short transaction
-- mutex. Cleanup skips a group while a claim is being created, then rechecks
-- the durable lease row after acquiring the mutex.
create or replace function public.lock_receipt_verification_lease_key()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if nullif(btrim(coalesce(new.booking_key, '')), '') is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'paddle-rage-receipt-verification-lease:' || btrim(new.booking_key),
      0
    ));
  end if;
  return new;
end;
$$;

revoke all on function public.lock_receipt_verification_lease_key()
  from public, anon, authenticated, service_role;

drop trigger if exists a00_lock_receipt_verification_lease_key
  on public.receipt_verification_leases;
create trigger a00_lock_receipt_verification_lease_key
before insert or update on public.receipt_verification_leases
for each row execute function public.lock_receipt_verification_lease_key();

create or replace function public.release_public_booking_hold(
  p_ref text,
  p_access_token text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  account_role text;
  requested_ref text := nullif(trim(coalesce(p_ref, '')), '');
  token_hash text;
  token_mode boolean := false;
  observed_group_ref text;
  group_key text;
  group_refs text[];
  locked_refs text[];
  group_count integer;
  group_safe boolean := false;
  cleanup_tx_started timestamptz := transaction_timestamp();
begin
  if request_role not in ('anon', 'authenticated') then
    raise exception 'This endpoint is only for booking clients.' using errcode = '42501';
  end if;
  if requested_ref is null or length(requested_ref) > 100 then
    raise exception 'Booking reference is invalid.' using errcode = '22023';
  end if;

  if nullif(p_access_token, '') is not null then
    if length(p_access_token) < 32 or length(p_access_token) > 256 then
      raise exception 'Booking access token is invalid.' using errcode = '42501';
    end if;
    token_hash := encode(extensions.digest(p_access_token, 'sha256'), 'hex');
    token_mode := true;
  elsif request_role <> 'authenticated' then
    raise exception 'Booking access token is invalid.' using errcode = '42501';
  end if;

  -- Resolve without a row lock, then use the same group mutex as public insert
  -- and receipt finalizers. Ungrouped rows receive their own release mutex.
  select nullif(trim(coalesce(booking.booking_group_ref, '')), '')
    into observed_group_ref
    from public.bookings booking
   where booking.ref = requested_ref;
  if not found then
    raise exception 'Booking hold was not found or the access token is invalid.' using errcode = '42501';
  end if;
  group_key := coalesce(observed_group_ref, requested_ref);

  if not pg_try_advisory_xact_lock(hashtextextended(
    case
      when observed_group_ref is not null
        then 'paddle-rage-public-booking-group:' || group_key
      else 'paddle-rage-booking-hold-ref:' || group_key
    end,
    0
  )) then
    raise exception 'Booking hold is changing. Please try again.' using errcode = '40001';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended(
    'paddle-rage-receipt-verification-lease:' || group_key,
    0
  )) then
    raise exception 'Booking receipt processing is starting. Please try again.' using errcode = '40001';
  end if;

  delete from public.receipt_verification_leases lease
   where lease.booking_key = group_key
     and lease.lease_expires_at <= clock_timestamp();

  select array_agg(locked.ref order by locked.ref)
    into locked_refs
    from (
      select booking.ref
        from public.bookings booking
       where coalesce(nullif(trim(coalesce(booking.booking_group_ref, '')), ''), booking.ref) = group_key
       order by booking.ref
       for update skip locked
    ) locked;

  select count(*)::integer, array_agg(booking.ref order by booking.ref)
    into group_count, group_refs
    from public.bookings booking
   where coalesce(nullif(trim(coalesce(booking.booking_group_ref, '')), ''), booking.ref) = group_key;

  if group_count = 0
     or coalesce(array_length(locked_refs, 1), 0) <> group_count
     or requested_ref <> all(coalesce(group_refs, array[]::text[])) then
    raise exception 'Booking hold is changing. Please try again.' using errcode = '40001';
  end if;

  if token_mode then
    select bool_and(
        coalesce(
        booking.customer_access_token_hash is not null
        and booking.customer_access_token_hash = token_hash
        and not coalesce(booking.host_booking, false)
        and booking.host_user_id is null
        and coalesce(booking.created_via, '') = 'customer'
        and booking.created_by_user_id is null
        and public.is_evidence_free_booking_hold(booking),
        false
        )
      )
      into group_safe
      from public.bookings booking
     where booking.ref = any(group_refs);
  else
    account_role := public.current_account_role();
    if account_role = 'host' then
      select bool_and(
          coalesce(
          coalesce(booking.host_booking, false)
          and booking.host_user_id = auth.uid()
          and booking.created_by_user_id = auth.uid()
          and coalesce(booking.created_via, '') = 'host'
          and coalesce(booking.created_by_role, '') = 'host'
          and booking.customer_access_token_hash is null
          and public.is_evidence_free_booking_hold(booking),
          false
          )
        )
        into group_safe
        from public.bookings booking
       where booking.ref = any(group_refs);
    elsif account_role in ('owner', 'court_owner', 'staff') then
      select bool_and(
          coalesce(
          not coalesce(booking.host_booking, false)
          and booking.host_user_id is null
          and coalesce(booking.created_via, '') = 'customer'
          and booking.created_by_user_id is null
          and booking.customer_access_token_hash is null
          and public.is_evidence_free_booking_hold(booking),
          false
          )
        )
        into group_safe
        from public.bookings booking
       where booking.ref = any(group_refs);
    else
      raise exception 'Booking hold was not found or the client is not authorized.' using errcode = '42501';
    end if;
  end if;

  if not coalesce(group_safe, false)
     or not public.booking_hold_group_has_no_durable_evidence(group_refs, group_key) then
    raise exception 'Only an evidence-free temporary hold can be released.' using errcode = '42501';
  end if;

  -- Release every sibling atomically. The existing delete trigger retains a
  -- snapshot first; remove only those exact transaction-local placeholder
  -- artifacts so ephemeral holds never pollute Deleted Bookings.
  delete from public.bookings booking where booking.ref = any(group_refs);

  delete from public.deleted_booking_archive archive
   where archive.booking_ref = any(group_refs)
     and archive.source = 'trigger'
     and archive.recovery_status = 'deleted'
     and archive.deleted_at = cleanup_tx_started
     and lower(btrim(coalesce(archive.original_booking->>'email', ''))) = 'reserve@hold.internal'
     and lower(btrim(coalesce(archive.original_booking->>'full_name', ''))) in ('reserving...', 'reserving…')
     and btrim(coalesce(archive.original_booking->>'contact_number', '')) = '00000000000';

  return requested_ref;
end;
$$;

revoke all on function public.release_public_booking_hold(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.release_public_booking_hold(text, text)
  to anon, authenticated;

create or replace function public.purge_expired_booking_holds()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  candidate record;
  group_refs text[];
  locked_refs text[];
  group_count integer;
  safe_count integer;
  affected_count integer;
  purged_count integer := 0;
  cutoff timestamptz := clock_timestamp() - interval '30 minutes';
  cleanup_tx_started timestamptz := transaction_timestamp();
begin
  -- Cap every run and choose only groups whose current rows are uniformly old,
  -- placeholder-only, and evidence-free. The checks are repeated after locks.
  for candidate in
    select grouped.group_key, grouped.refs
      from (
        select
          coalesce(nullif(booking.booking_group_ref, ''), booking.ref) as group_key,
          array_agg(booking.ref order by booking.ref) as refs,
          min(booking.created_at) as oldest_at,
          bool_and(
            booking.created_at is not null
            and booking.created_at <= cutoff
            and public.is_evidence_free_booking_hold(booking)
          ) as rows_safe
        from public.bookings booking
        group by coalesce(nullif(booking.booking_group_ref, ''), booking.ref)
      ) grouped
     where grouped.rows_safe
       and public.booking_hold_group_has_no_durable_evidence(grouped.refs, grouped.group_key)
     order by grouped.oldest_at, grouped.group_key
     limit 500
  loop
    if not pg_try_advisory_xact_lock(hashtextextended(
      case
        when exists (
          select 1
            from public.bookings grouped_booking
           where grouped_booking.booking_group_ref = candidate.group_key
        ) then 'paddle-rage-public-booking-group:' || candidate.group_key
        else 'paddle-rage-booking-hold-ref:' || candidate.group_key
      end,
      0
    )) then
      continue;
    end if;

    if not pg_try_advisory_xact_lock(hashtextextended(
      'paddle-rage-receipt-verification-lease:' || candidate.group_key,
      0
    )) then
      continue;
    end if;

    delete from public.receipt_verification_leases lease
     where lease.booking_key = candidate.group_key
       and lease.lease_expires_at <= clock_timestamp();

    select array_agg(locked.ref order by locked.ref)
      into locked_refs
      from (
        select booking.ref
          from public.bookings booking
         where coalesce(nullif(booking.booking_group_ref, ''), booking.ref) = candidate.group_key
         order by booking.ref
         for update skip locked
      ) locked;

    select
      count(*)::integer,
      count(*) filter (
        where booking.created_at is not null
          and booking.created_at <= cutoff
          and public.is_evidence_free_booking_hold(booking)
      )::integer,
      array_agg(booking.ref order by booking.ref)
      into group_count, safe_count, group_refs
      from public.bookings booking
     where coalesce(nullif(booking.booking_group_ref, ''), booking.ref) = candidate.group_key;

    -- If another transaction owns even one sibling, skip the entire group.
    if group_count = 0
       or coalesce(array_length(locked_refs, 1), 0) <> group_count
       or safe_count <> group_count
       or not public.booking_hold_group_has_no_durable_evidence(group_refs, candidate.group_key) then
      continue;
    end if;

    delete from public.bookings booking where booking.ref = any(group_refs);
    get diagnostics affected_count = row_count;
    purged_count := purged_count + affected_count;

    delete from public.deleted_booking_archive archive
     where archive.booking_ref = any(group_refs)
       and archive.source = 'trigger'
       and archive.recovery_status = 'deleted'
       and archive.deleted_at = cleanup_tx_started
       and lower(btrim(coalesce(archive.original_booking->>'email', ''))) = 'reserve@hold.internal'
       and lower(btrim(coalesce(archive.original_booking->>'full_name', ''))) in ('reserving...', 'reserving…')
       and btrim(coalesce(archive.original_booking->>'contact_number', '')) = '00000000000';
  end loop;

  return purged_count;
end;
$$;

revoke all on function public.purge_expired_booking_holds()
  from public, anon, authenticated;
grant execute on function public.purge_expired_booking_holds()
  to service_role;

comment on function public.release_public_booking_hold(text, text) is
  'Atomic hard release for a bearer-owned or active-account-owned evidence-free temporary checkout hold.';
comment on function public.purge_expired_booking_holds() is
  'Deletes up to 500 uniformly abandoned placeholder groups after a 30-minute evidence-safe grace.';

-- Expiration applies only to placeholder identity. A genuine customer booking
-- that remains verifying during slow receipt processing must keep its slot.
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
      and lower(btrim(coalesce(booking_status, ''))) = 'verifying'
      and lower(btrim(coalesce(booking_email, ''))) = 'reserve@hold.internal'
      and lower(btrim(coalesce(booking_full_name, ''))) in ('reserving...', 'reserving…')
      then false
    else true
  end
$$;

comment on function public.booking_occupies_slot(text, text, text, timestamptz) is
  'Canonical occupancy predicate: terminal bookings and placeholder identities older than 15 minutes do not reserve capacity; genuine verifying bookings remain occupied.';

revoke all on function public.booking_occupies_slot(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.booking_occupies_slot(text, text, text, timestamptz)
  to anon, authenticated, service_role;

-- A placeholder-to-customer identity update can change an expired non-occupying
-- hold into an occupying genuine booking without changing its court, date,
-- status, ref, or slots. Recheck that transition under the canonical slot
-- advisory locks so it cannot race a new booking at the 15-minute boundary.
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
     and new.slots is not distinct from old.slots
     and new.email is not distinct from old.email
     and new.full_name is not distinct from old.full_name
     and new.created_at is not distinct from old.created_at then
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
  'Serializes occupying booking writes, including placeholder-to-customer identity transitions.';

create extension if not exists pg_cron;

do $$
declare
  existing_job bigint;
begin
  select jobid
    into existing_job
    from cron.job
   where jobname = 'cleanup-expired-booking-holds'
   limit 1;
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
  perform cron.schedule(
    'cleanup-expired-booking-holds',
    '*/5 * * * *',
    $job$select public.purge_expired_booking_holds();$job$
  );
end;
$$;

-- Clean only candidates that satisfy the hardened 30-minute group predicate.
select public.purge_expired_booking_holds();

notify pgrst, 'reload schema';

commit;
