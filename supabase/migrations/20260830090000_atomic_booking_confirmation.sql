-- Confirm one booking (or every sibling in its booking group) as one
-- authenticated, idempotent financial transaction.  Browser callers receive
-- only the transition outcome; the existing booking read API remains the
-- canonical source for the refreshed aggregate.

begin;

create or replace function public.confirm_booking_transaction(
  p_booking_ref text
)
returns table (
  transitioned boolean,
  booking_ref text,
  booking_status text,
  booking_payment_status text,
  booking_refs text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_ref text := nullif(trim(coalesce(p_booking_ref, '')), '');
  observed_group_ref text;
  logical_booking_key text;
  target_booking public.bookings%rowtype;
  actual_refs text[];
  status_values text[];
  payment_status_values text[];
  host_values boolean[];
  method_values text[];
  reference_values text[];
  current_booking_status text;
  current_payment_status text;
  payment_method_value text;
  payment_reference_key text;
  target_payment_status text;
  target_is_host boolean;
  is_digital_payment boolean := false;
  invalid_amount_rows integer := 0;
  full_amount_rows integer := 0;
  partial_amount_rows integer := 0;
  receipt_image_rows integer := 0;
  distinct_receipt_images integer := 0;
  distinct_receipt_hashes integer := 0;
  expected_total numeric := 0;
  expected_due numeric := 0;
  confirmation_time timestamptz := clock_timestamp();
  updated_count integer := 0;
  did_transition boolean := false;
begin
  if requested_ref is null then
    raise exception 'A booking reference is required.' using errcode = '22023';
  end if;

  -- current_account_role() only returns roles for active accounts.
  if not public.has_account_role(array['owner', 'court_owner', 'staff']) then
    raise exception 'Only an active owner, court owner, or staff account can confirm a booking payment.'
      using errcode = '42501';
  end if;

  select nullif(trim(coalesce(b.booking_group_ref, '')), '')
    into observed_group_ref
    from public.bookings b
   where b.ref = requested_ref;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  logical_booking_key := coalesce(observed_group_ref, requested_ref);

  -- Earned-fee transitions take this shared lock in their trigger.  Taking it
  -- before booking row locks preserves the exclusive remittance/void lock
  -- order and avoids a row-lock/advisory-lock deadlock.
  perform pg_advisory_xact_lock_shared(
    hashtextextended('paddle-rage-pickleball-booking-fee-remittance', 0)
  );

  if observed_group_ref is not null then
    -- Public group insertion and receipt finalization use this same lock.  It
    -- prevents the normal booking path from adding a sibling while the group
    -- snapshot is being confirmed.
    perform pg_advisory_xact_lock(
      hashtextextended(
        'paddle-rage-public-booking-group:' || observed_group_ref,
        0
      )
    );
  end if;

  -- Serializes repeat clicks even for an ungrouped booking.  The state is
  -- always re-read after this lock, so the second caller observes the first
  -- caller's committed result and returns transitioned=false.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'paddle-rage-booking-confirmation:' || logical_booking_key,
      0
    )
  );

  if observed_group_ref is null then
    select b.*
      into target_booking
      from public.bookings b
     where b.ref = requested_ref
     for update;
    if not found
       or nullif(trim(coalesce(target_booking.booking_group_ref, '')), '')
         is not null then
      raise exception 'Booking scope changed while confirmation was starting.'
        using errcode = '40001';
    end if;
    actual_refs := array[target_booking.ref];
  else
    -- Deterministic row order keeps concurrent group operations from taking
    -- sibling locks in different orders.
    perform 1
      from public.bookings b
     where b.booking_group_ref = observed_group_ref
     order by b.ref
     for update;

    select b.*
      into target_booking
      from public.bookings b
     where b.ref = requested_ref;
    if not found
       or nullif(trim(coalesce(target_booking.booking_group_ref, '')), '')
         is distinct from observed_group_ref then
      raise exception 'Booking scope changed while confirmation was starting.'
        using errcode = '40001';
    end if;

    select array_agg(b.ref order by b.ref)
      into actual_refs
      from public.bookings b
     where b.booking_group_ref = observed_group_ref;
  end if;

  if actual_refs is null
     or cardinality(actual_refs) = 0
     or not (requested_ref = any(actual_refs)) then
    raise exception 'The logical booking has no confirmable rows.'
      using errcode = '40001';
  end if;

  select
    array_agg(distinct lower(trim(coalesce(b.status, '')))),
    array_agg(distinct lower(trim(coalesce(b.payment_status, '')))),
    array_agg(distinct coalesce(b.host_booking, false)),
    array_agg(distinct lower(trim(coalesce(b.payment_method, ''))))
    into status_values, payment_status_values, host_values, method_values
    from public.bookings b
   where b.ref = any(actual_refs);

  if cardinality(status_values) <> 1 then
    raise exception 'Grouped booking statuses are mixed. Review the booking details before confirming.'
      using errcode = '22023';
  end if;
  if cardinality(payment_status_values) <> 1 then
    raise exception 'Grouped payment statuses are mixed. Review the payment details before confirming.'
      using errcode = '22023';
  end if;
  if cardinality(host_values) <> 1 then
    raise exception 'Grouped booking ownership types are mixed. Review the booking details before confirming.'
      using errcode = '22023';
  end if;
  if cardinality(method_values) <> 1 then
    raise exception 'Grouped payment methods are mixed. Review the payment details before confirming.'
      using errcode = '22023';
  end if;

  current_booking_status := status_values[1];
  current_payment_status := payment_status_values[1];
  target_is_host := host_values[1];
  payment_method_value := method_values[1];

  if current_booking_status in ('cancelled', 'completed', 'forfeited') then
    raise exception 'This booking is already in a terminal state and cannot be confirmed.'
      using errcode = '22023';
  end if;
  if current_booking_status not in ('pending', 'verifying', 'confirmed') then
    raise exception 'This booking is not ready for confirmation.'
      using errcode = '22023';
  end if;
  if current_payment_status in ('failed', 'rejected', 'deposit_retained') then
    raise exception 'This payment is already rejected or otherwise terminal.'
      using errcode = '22023';
  end if;
  if payment_method_value not in ('cash', 'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb') then
    raise exception 'This payment method cannot use one-tap confirmation.'
      using errcode = '22023';
  end if;
  is_digital_payment := payment_method_value <> 'cash';

  if is_digital_payment
     and current_payment_status not in ('for_verification', 'paid', 'downpayment_paid') then
    raise exception 'This digital payment is not ready for confirmation.'
      using errcode = '22023';
  elsif not is_digital_payment
     and current_payment_status not in ('unpaid', 'pending', 'paid', 'downpayment_paid') then
    raise exception 'This cash booking payment state is not ready for confirmation.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.bookings b
     where b.ref = any(actual_refs)
       and lower(trim(coalesce(b.email, ''))) = 'reserve@hold.internal'
  ) then
    raise exception 'This reservation hold has not been completed by the customer.'
      using errcode = '22023';
  end if;

  -- The normalizer enforces each provider's reference format.  Every sibling
  -- must point at the same canonical payment claim.
  if is_digital_payment then
    select array_agg(
             distinct public.normalize_payment_reference_key(
               lower(trim(coalesce(b.payment_method, ''))),
               b.gcash_ref
             )
           )
      into reference_values
      from public.bookings b
     where b.ref = any(actual_refs);
    if cardinality(reference_values) <> 1 or reference_values[1] is null then
      raise exception 'The payment reference is missing or inconsistent across this booking.'
        using errcode = '22023';
    end if;
    payment_reference_key := reference_values[1];
  end if;

  select
    count(*) filter (
      where b.total is null
         or b.total <= 0
         or (b.downpayment is not null and b.downpayment <= 0)
         or (b.downpayment is not null and b.downpayment > b.total + 0.01)
         or (target_is_host and b.downpayment is null)
    ),
    count(*) filter (
      where b.downpayment is not null
        and abs(b.downpayment - b.total) <= 0.01
    ),
    count(*) filter (
      where b.downpayment is not null
        and b.downpayment < b.total - 0.01
    ),
    count(*) filter (
      where nullif(trim(coalesce(b.receipt_image_url, '')), '') is not null
    ),
    count(distinct nullif(trim(coalesce(b.receipt_image_url, '')), '')),
    count(distinct nullif(trim(coalesce(b.receipt_image_hash, '')), '')),
    round(coalesce(sum(b.total), 0)::numeric, 2),
    round(coalesce(sum(coalesce(b.downpayment, b.total)), 0)::numeric, 2)
    into invalid_amount_rows, full_amount_rows, partial_amount_rows,
         receipt_image_rows, distinct_receipt_images,
         distinct_receipt_hashes, expected_total, expected_due
    from public.bookings b
   where b.ref = any(actual_refs);

  if invalid_amount_rows <> 0
     or expected_total <= 0
     or expected_due <= 0
     or expected_due > expected_total + 0.01 then
    raise exception 'Stored booking payment amounts require manual review.'
      using errcode = '22023';
  end if;

  if not is_digital_payment
     and current_payment_status in ('unpaid', 'pending') then
    -- Confirming a cash reservation books the court but does not fabricate a
    -- payment.  Keep its existing unpaid/pending state and leave paid_at null.
    target_payment_status := current_payment_status;
  elsif target_is_host then
    if full_amount_rows = cardinality(actual_refs) then
      target_payment_status := 'paid';
    elsif partial_amount_rows = cardinality(actual_refs) then
      -- Recompute the server-authoritative host reservation amount.  This
      -- prevents a dashboard write from turning an arbitrary underpayment into
      -- an accepted partial payment.
      if exists (
        select 1
          from public.bookings b
         where b.ref = any(actual_refs)
           and abs(
             b.downpayment - round(
               least(
                 greatest(public.calculate_booking_service_fee(b.slots), 0),
                 b.total
               ) + (
                 b.total - least(
                   greatest(public.calculate_booking_service_fee(b.slots), 0),
                   b.total
                 )
               ) * 0.25,
               2
             )
           ) > 0.01
      ) then
        raise exception 'The host reservation payment is lower than the required amount.'
          using errcode = '22023';
      end if;
      target_payment_status := 'downpayment_paid';
    else
      raise exception 'Grouped host payment amounts are mixed. Review the payment details before confirming.'
        using errcode = '22023';
    end if;
  else
    if full_amount_rows <> cardinality(actual_refs)
       or abs(expected_due - expected_total) > 0.01 then
      raise exception 'Regular bookings require full payment before confirmation.'
        using errcode = '22023';
    end if;
    target_payment_status := 'paid';
  end if;

  if current_payment_status in ('paid', 'downpayment_paid')
     and current_payment_status <> target_payment_status then
    raise exception 'The settled payment state does not match the stored amount.'
      using errcode = '22023';
  end if;
  if current_booking_status = 'confirmed'
     and current_payment_status <> target_payment_status then
    raise exception 'The confirmed booking has an inconsistent payment state.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.bookings b
     where b.ref = any(actual_refs)
       and lower(trim(coalesce(b.receipt_status, 'none'))) = 'rejected'
  ) then
    raise exception 'The receipt is rejected and cannot be confirmed.'
      using errcode = '22023';
  end if;
  if exists (
    select 1
      from public.bookings b
      cross join lateral unnest(coalesce(b.receipt_flags, array[]::text[])) flag
     where b.ref = any(actual_refs)
       and upper(trim(flag)) ~ '^DUPLICATE_'
  ) then
    raise exception 'The receipt contains proven duplicate evidence and cannot be confirmed.'
      using errcode = '23505';
  end if;
  if distinct_receipt_images > 1 or distinct_receipt_hashes > 1 then
    raise exception 'Grouped receipt evidence is inconsistent. Review the payment details before confirming.'
      using errcode = '22023';
  end if;
  if is_digital_payment
     and current_payment_status = 'for_verification'
     and receipt_image_rows = 0 then
    raise exception 'A receipt image is required before confirming this payment.'
      using errcode = '22023';
  end if;

  -- Catch duplicate references on unresolved booking rows before the ledger is
  -- claimed.  The claim below additionally protects against paid Open Play and
  -- host-session payments, including a concurrent claimant.
  if is_digital_payment then
    if exists (
      select 1
        from public.bookings other_booking
       where not (other_booking.ref = any(actual_refs))
         and lower(trim(coalesce(other_booking.payment_method, ''))) in
           ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb')
         and (
           case
             when lower(trim(other_booking.payment_method)) = 'gcash' then
               regexp_replace(coalesce(other_booking.gcash_ref, ''), '[^0-9]', '', 'g')
             else lower(trim(other_booking.payment_method)) || ':' ||
               upper(regexp_replace(coalesce(other_booking.gcash_ref, ''), '[^A-Za-z0-9]', '', 'g'))
           end
         ) = payment_reference_key
    ) then
      raise exception 'This payment reference is also attached to another booking.'
        using errcode = '23505';
    end if;

    perform public.claim_payment_reference(
      payment_method_value,
      target_booking.gcash_ref,
      case when observed_group_ref is null then 'booking' else 'booking_group' end,
      logical_booking_key,
      requested_ref
    );
  end if;

  if current_booking_status = 'confirmed'
     and current_payment_status = target_payment_status then
    return query
    select false, requested_ref, 'confirmed'::text,
           target_payment_status, actual_refs;
    return;
  end if;

  update public.bookings b
     set status = 'confirmed',
         payment_status = target_payment_status,
         paid_at = case
           when target_payment_status in ('paid', 'downpayment_paid')
             then coalesce(b.paid_at, confirmation_time)
           else b.paid_at
         end
   where b.ref = any(actual_refs)
     and b.status = current_booking_status
     and b.payment_status = current_payment_status;

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(actual_refs) then
    raise exception 'Booking state changed before the complete group could be confirmed.'
      using errcode = '40001';
  end if;
  did_transition := updated_count > 0;

  return query
  select did_transition, requested_ref, 'confirmed'::text,
         target_payment_status, actual_refs;
end;
$$;

revoke all on function public.confirm_booking_transaction(text)
  from public, anon, authenticated;
grant execute on function public.confirm_booking_transaction(text)
  to authenticated;

comment on function public.confirm_booking_transaction(text) is
  'Atomically confirms one submitted booking or every sibling in its logical group. Digital payments settle after evidence checks; cash keeps its existing payment state. Active dashboard roles only; idempotent on repeat calls.';

notify pgrst, 'reload schema';

commit;
