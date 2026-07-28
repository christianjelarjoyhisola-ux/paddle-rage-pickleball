-- Strict, service-role-only finalization for dedicated GCash receipt parsing.
-- OCR happens in the Edge Function. This transaction independently locks the
-- complete booking scope, validates the canonical stored payment rows, claims
-- the payment reference through the existing settled-row trigger, and records
-- the immutable audit entry.

begin;

create or replace function public.finalize_gcash_receipt_auto_approval(
  p_booking_ref text,
  p_booking_refs text[],
  p_lease_key text,
  p_lease_token uuid,
  p_gcash_reference text,
  p_payment_status text,
  p_receipt_image_url text,
  p_receipt_image_hash text,
  p_receipt_phash text,
  p_receipt_flags text[],
  p_receipt_extracted jsonb,
  p_receipt_confidence numeric,
  p_receipt_verified_at timestamptz,
  p_raw_ocr_text text
)
returns table (
  booking_ref text,
  booking_status text,
  booking_payment_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_booking public.bookings%rowtype;
  lease_row public.receipt_verification_leases%rowtype;
  actual_refs text[];
  expected_refs text[];
  observed_group_ref text;
  logical_booking_key text;
  normalized_reference text :=
    regexp_replace(coalesce(p_gcash_reference, ''), '[^0-9]', '', 'g');
  invalid_rows integer;
  updated_count integer;
  non_host_rows integer;
  paid_amount numeric;
  expected_total numeric;
  expected_due numeric;
begin
  if nullif(trim(coalesce(p_booking_ref, '')), '') is null then
    raise exception 'Booking reference is required.' using errcode = '22023';
  end if;
  if coalesce(p_receipt_image_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid checkpoint image hash is required.'
      using errcode = '22023';
  end if;
  if normalized_reference !~ '^[0-9]{13}$' then
    raise exception 'The GCash reference must contain exactly 13 digits.'
      using errcode = '22023';
  end if;
  if p_payment_status is null
     or p_payment_status not in ('paid', 'downpayment_paid') then
    raise exception 'Invalid automatic payment status.' using errcode = '22023';
  end if;
  if cardinality(coalesce(p_receipt_flags, array[]::text[])) <> 0 then
    raise exception 'Flagged GCash evidence requires manual review.'
      using errcode = '22023';
  end if;
  if p_receipt_confidence is null
     or p_receipt_confidence < 0.90
     or p_receipt_confidence > 1 then
    raise exception 'High-confidence GCash OCR evidence is required.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_receipt_extracted) <> 'object' then
    raise exception 'Structured GCash parser evidence is required.'
      using errcode = '22023';
  end if;
  if coalesce(p_receipt_extracted->>'provider', '') <> 'gcash'
     or coalesce(p_receipt_extracted->>'parserVersion', '') <> 'gcash_v1' then
    raise exception 'Dedicated GCash parser evidence is required.'
      using errcode = '22023';
  end if;
  if regexp_replace(coalesce(p_receipt_extracted->>'ref', ''), '[^0-9]', '', 'g')
       <> normalized_reference
     or coalesce(p_receipt_extracted#>>'{gcash,reference,source}', '')
       <> 'ref_label'
     or coalesce(p_receipt_extracted#>>'{gcash,reference,confidence}', '')
       <> 'high'
     or coalesce(p_receipt_extracted#>>'{gcash,reference,typedMatch}', '')
       <> 'match' then
    raise exception 'Exact labeled GCash reference evidence is required.'
      using errcode = '22023';
  end if;
  if coalesce(p_receipt_extracted#>>'{gcash,amount,reliable}', '') <> 'true'
     or coalesce(p_receipt_extracted#>>'{gcash,amount,ambiguous}', '') <> 'false'
     or coalesce(
       p_receipt_extracted#>>'{gcash,amount,conflictingPrimaryAmounts}',
       ''
     ) <> 'false' then
    raise exception 'Unambiguous GCash amount evidence is required.'
      using errcode = '22023';
  end if;
  if coalesce(
       p_receipt_extracted#>>'{gcash,timestamp,completeness}',
       ''
     ) <> 'date_time'
     or coalesce(p_receipt_extracted->>'receiptAgeMinutes', '')
       !~ '^-?[0-9]+([.][0-9]+)?$' then
    raise exception 'GCash timestamp is outside the payment window.'
      using errcode = '22023';
  end if;
  if (p_receipt_extracted->>'receiptAgeMinutes')::numeric < -2
     or (p_receipt_extracted->>'receiptAgeMinutes')::numeric > 15 then
    raise exception 'GCash timestamp is outside the payment window.'
      using errcode = '22023';
  end if;
  if coalesce(
       p_receipt_extracted#>>'{gcash,recipientComparison,phone}',
       ''
     ) <> 'exact'
     or coalesce(
       p_receipt_extracted#>>'{gcash,recipientComparison,name}',
       ''
     ) = 'mismatch' then
    raise exception 'Exact GCash recipient phone evidence is required.'
      using errcode = '22023';
  end if;
  if coalesce(
       p_receipt_extracted#>>'{gcash,indicators,classification}',
       ''
     ) <> 'gcash'
     or coalesce(
       p_receipt_extracted#>>'{gcash,indicators,sentViaGcash}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{gcash,indicators,totalAmountSent}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{gcash,indicators,referenceLabel}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{gcash,indicators,amountLabel}',
       ''
     ) <> 'true'
     or coalesce(p_receipt_extracted->>'ocrProvider', '')
       <> 'google_vision'
     or coalesce(p_receipt_extracted->>'ocrConfidenceSource', '')
       <> 'native' then
    raise exception 'Complete GCash receipt-layout evidence is required.'
      using errcode = '22023';
  end if;
  if coalesce(p_receipt_extracted->>'autoPaymentStatus', '')
       <> p_payment_status then
    raise exception 'Automatic payment classification changed.'
      using errcode = '22023';
  end if;
  if coalesce(p_receipt_extracted->>'amount', '') !~ '^[0-9]+([.][0-9]+)?$' then
    raise exception 'A reliable parsed GCash amount is required.'
      using errcode = '22023';
  end if;
  paid_amount := (p_receipt_extracted->>'amount')::numeric;

  select nullif(trim(coalesce(b.booking_group_ref, '')), '')
    into observed_group_ref
    from public.bookings b
   where b.ref = p_booking_ref;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  logical_booking_key := coalesce(observed_group_ref, p_booking_ref);
  if trim(coalesce(p_lease_key, '')) <> logical_booking_key then
    raise exception 'Receipt verification lease does not match this booking.'
      using errcode = '40001';
  end if;

  if observed_group_ref is not null then
    -- Public group inserts take this same advisory lock. Acquiring it before
    -- row locks prevents a new sibling from appearing after the group snapshot
    -- and gives every finalizer the same deterministic lock order.
    perform pg_advisory_xact_lock(
      hashtextextended(
        'paddle-rage-public-booking-group:' || observed_group_ref,
        0
      )
    );
  end if;

  select leases.*
    into lease_row
    from public.receipt_verification_leases leases
   where leases.booking_key = logical_booking_key
   for update;
  if not found
     or lease_row.claim_token is distinct from p_lease_token
     or lease_row.lease_expires_at <= clock_timestamp() then
    raise exception 'Receipt verification lease is stale.'
      using errcode = '40001';
  end if;

  if observed_group_ref is null then
    select b.*
      into target_booking
      from public.bookings b
     where b.ref = p_booking_ref
     for update;
    if not found
       or nullif(trim(coalesce(target_booking.booking_group_ref, '')), '')
         is not null then
      raise exception 'Booking scope changed during receipt verification.'
        using errcode = '40001';
    end if;
    actual_refs := array[p_booking_ref];
  else
    perform 1
      from public.bookings b
     where b.booking_group_ref = observed_group_ref
     order by b.ref
     for update;

    select b.*
      into target_booking
      from public.bookings b
     where b.ref = p_booking_ref;
    if not found
       or nullif(trim(coalesce(target_booking.booking_group_ref, '')), '')
         is distinct from observed_group_ref then
      raise exception 'Booking scope changed during receipt verification.'
        using errcode = '40001';
    end if;

    select array_agg(b.ref order by b.ref)
      into actual_refs
      from public.bookings b
     where b.booking_group_ref = observed_group_ref;
  end if;

  select array_agg(candidate order by candidate)
    into expected_refs
    from (
      select distinct unnest(coalesce(p_booking_refs, array[]::text[])) candidate
    ) refs;

  if actual_refs is null
     or expected_refs is null
     or actual_refs is distinct from expected_refs
     or not (p_booking_ref = any(actual_refs)) then
    raise exception 'Booking group changed during receipt verification.'
      using errcode = '40001';
  end if;

  select
    count(*) filter (
      where lower(trim(coalesce(b.payment_method, ''))) <> 'gcash'
         or regexp_replace(coalesce(b.gcash_ref, ''), '[^0-9]', '', 'g')
              <> normalized_reference
         or b.status not in ('verifying', 'pending')
         or b.payment_status not in ('unpaid', 'pending', 'for_verification')
         or b.total is null
         or b.total < 0
         or b.downpayment is null
         or b.downpayment < 0
         or b.receipt_image_hash is distinct from p_receipt_image_hash
         or b.receipt_status <> 'manual_review'
    ),
    count(*) filter (where b.host_booking is distinct from true),
    round(coalesce(sum(b.total), 0)::numeric, 2),
    round(coalesce(sum(b.downpayment), 0)::numeric, 2)
    into invalid_rows, non_host_rows, expected_total, expected_due
    from public.bookings b
   where b.ref = any(actual_refs);

  if invalid_rows <> 0 then
    raise exception 'Booking payment state changed during receipt verification.'
      using errcode = '40001';
  end if;
  if expected_total <= 0
     or expected_due <= 0
     or expected_due > expected_total + 0.01 then
    raise exception 'Stored booking payment amounts require manual review.'
      using errcode = '22023';
  end if;

  if p_payment_status = 'paid' then
    if abs(expected_due - expected_total) > 0.01 then
      raise exception 'Stored booking amount is not a full payment.'
        using errcode = '22023';
    end if;
    if abs(paid_amount - expected_total) > 0.01 then
      raise exception 'Parsed amount does not match the full booking total.'
        using errcode = '22023';
    end if;
  else
    if non_host_rows <> 0 then
      raise exception 'Only host court reservations may carry a balance.'
        using errcode = '22023';
    end if;
    if expected_due >= expected_total - 0.01 then
      raise exception 'A balance payment must be lower than the booking total.'
        using errcode = '22023';
    end if;
    if abs(paid_amount - expected_due) > 0.01 then
      raise exception 'Parsed amount does not match the host amount due.'
        using errcode = '22023';
    end if;
  end if;

  update public.bookings b
     set status = 'confirmed',
         payment_status = p_payment_status,
         paid_at = coalesce(p_receipt_verified_at, clock_timestamp()),
         receipt_image_url = p_receipt_image_url,
         receipt_image_hash = p_receipt_image_hash,
         receipt_phash = p_receipt_phash,
         receipt_status = 'auto_approved',
         receipt_flags = coalesce(p_receipt_flags, array[]::text[]),
         receipt_extracted = p_receipt_extracted,
         receipt_confidence = p_receipt_confidence,
         receipt_verified_at =
           coalesce(p_receipt_verified_at, clock_timestamp())
   where b.ref = any(actual_refs);

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(actual_refs) then
    raise exception 'Automatic settlement did not update the complete booking group.'
      using errcode = '40001';
  end if;

  insert into public.receipt_verifications (
    booking_ref,
    result,
    flags,
    extracted,
    confidence,
    image_hash,
    phash,
    raw_ocr_text
  ) values (
    p_booking_ref,
    'auto_approved',
    coalesce(p_receipt_flags, array[]::text[]),
    p_receipt_extracted,
    p_receipt_confidence,
    p_receipt_image_hash,
    p_receipt_phash,
    p_raw_ocr_text
  );

  delete from public.receipt_verification_leases leases
   where leases.booking_key = logical_booking_key
     and leases.claim_token = p_lease_token;
  if not found then
    raise exception 'Receipt verification lease changed before commit.'
      using errcode = '40001';
  end if;

  return query
  select b.ref, b.status, b.payment_status
    from public.bookings b
   where b.ref = any(actual_refs)
   order by b.ref;
end;
$$;

-- Manual review and proven-duplicate rejection use the same lease/group
-- fencing as automatic approval. This prevents a stale OCR worker from
-- overwriting a newer receipt or cancelling only part of a grouped booking.
create or replace function public.finalize_gcash_receipt_review(
  p_booking_ref text,
  p_booking_refs text[],
  p_lease_key text,
  p_lease_token uuid,
  p_gcash_reference text,
  p_result text,
  p_receipt_image_url text,
  p_receipt_image_hash text,
  p_receipt_phash text,
  p_receipt_flags text[],
  p_receipt_extracted jsonb,
  p_receipt_confidence numeric,
  p_receipt_verified_at timestamptz,
  p_raw_ocr_text text
)
returns table (
  booking_ref text,
  booking_status text,
  booking_payment_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_booking public.bookings%rowtype;
  lease_row public.receipt_verification_leases%rowtype;
  actual_refs text[];
  expected_refs text[];
  observed_group_ref text;
  logical_booking_key text;
  ledger_claim_scope text;
  normalized_reference text :=
    regexp_replace(coalesce(p_gcash_reference, ''), '[^0-9]', '', 'g');
  invalid_rows integer;
  updated_count integer;
  non_host_rows integer;
  expected_total numeric;
  expected_due numeric;
  paid_amount numeric;
  duplicate_owned_elsewhere boolean := false;
begin
  if nullif(trim(coalesce(p_booking_ref, '')), '') is null then
    raise exception 'Booking reference is required.' using errcode = '22023';
  end if;
  if p_result is null
     or p_result not in ('manual_review', 'rejected') then
    raise exception 'Invalid GCash review result.' using errcode = '22023';
  end if;
  if coalesce(p_receipt_image_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid checkpoint image hash is required.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_receipt_extracted) <> 'object'
     or coalesce(p_receipt_extracted->>'provider', '') <> 'gcash'
     or coalesce(p_receipt_extracted->>'parserVersion', '') <> 'gcash_v1' then
    raise exception 'Dedicated GCash parser evidence is required.'
      using errcode = '22023';
  end if;

  select nullif(trim(coalesce(b.booking_group_ref, '')), '')
    into observed_group_ref
    from public.bookings b
   where b.ref = p_booking_ref;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  logical_booking_key := coalesce(observed_group_ref, p_booking_ref);
  ledger_claim_scope := case
    when observed_group_ref is null then 'booking'
    else 'booking_group'
  end;
  if trim(coalesce(p_lease_key, '')) <> logical_booking_key then
    raise exception 'Receipt verification lease does not match this booking.'
      using errcode = '40001';
  end if;

  if observed_group_ref is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'paddle-rage-public-booking-group:' || observed_group_ref,
        0
      )
    );
  end if;

  select leases.*
    into lease_row
    from public.receipt_verification_leases leases
   where leases.booking_key = logical_booking_key
   for update;
  if not found
     or lease_row.claim_token is distinct from p_lease_token
     or lease_row.lease_expires_at <= clock_timestamp() then
    raise exception 'Receipt verification lease is stale.'
      using errcode = '40001';
  end if;

  if observed_group_ref is null then
    select b.*
      into target_booking
      from public.bookings b
     where b.ref = p_booking_ref
     for update;
    if not found
       or nullif(trim(coalesce(target_booking.booking_group_ref, '')), '')
         is not null then
      raise exception 'Booking scope changed during receipt verification.'
        using errcode = '40001';
    end if;
    actual_refs := array[p_booking_ref];
  else
    perform 1
      from public.bookings b
     where b.booking_group_ref = observed_group_ref
     order by b.ref
     for update;

    select b.*
      into target_booking
      from public.bookings b
     where b.ref = p_booking_ref;
    if not found
       or nullif(trim(coalesce(target_booking.booking_group_ref, '')), '')
         is distinct from observed_group_ref then
      raise exception 'Booking scope changed during receipt verification.'
        using errcode = '40001';
    end if;

    select array_agg(b.ref order by b.ref)
      into actual_refs
      from public.bookings b
     where b.booking_group_ref = observed_group_ref;
  end if;

  select array_agg(candidate order by candidate)
    into expected_refs
    from (
      select distinct unnest(coalesce(p_booking_refs, array[]::text[])) candidate
    ) refs;

  if actual_refs is null
     or expected_refs is null
     or actual_refs is distinct from expected_refs
     or not (p_booking_ref = any(actual_refs)) then
    raise exception 'Booking group changed during receipt verification.'
      using errcode = '40001';
  end if;

  select
    count(*) filter (
      where lower(trim(coalesce(b.payment_method, ''))) <> 'gcash'
         or regexp_replace(coalesce(b.gcash_ref, ''), '[^0-9]', '', 'g')
              <> normalized_reference
         or b.status not in ('verifying', 'pending')
         or b.payment_status not in ('unpaid', 'pending', 'for_verification')
         or b.total is null
         or b.total < 0
         or b.downpayment is null
         or b.downpayment < 0
         or b.receipt_image_hash is distinct from p_receipt_image_hash
         or b.receipt_status <> 'manual_review'
    ),
    count(*) filter (where b.host_booking is distinct from true),
    round(coalesce(sum(b.total), 0)::numeric, 2),
    round(coalesce(sum(b.downpayment), 0)::numeric, 2)
    into invalid_rows, non_host_rows, expected_total, expected_due
    from public.bookings b
   where b.ref = any(actual_refs);

  if invalid_rows <> 0 then
    raise exception 'Booking payment state changed during receipt verification.'
      using errcode = '40001';
  end if;

  if p_result = 'rejected' then
    if normalized_reference !~ '^[0-9]{13}$'
       or not ('DUPLICATE_REF' = any(coalesce(p_receipt_flags, array[]::text[])))
       or cardinality(coalesce(p_receipt_flags, array[]::text[])) <> 1
       or coalesce(p_receipt_extracted->>'ocrConfidence', '')
         !~ '^[0-9]+([.][0-9]+)?$'
       or coalesce(
         p_receipt_extracted#>>'{gcash,reference,source}',
         ''
       ) <> 'ref_label'
       or coalesce(
         p_receipt_extracted#>>'{gcash,reference,confidence}',
         ''
       ) <> 'high'
       or coalesce(
         p_receipt_extracted#>>'{gcash,reference,typedMatch}',
         ''
       ) <> 'match'
       or regexp_replace(
         coalesce(p_receipt_extracted->>'ref', ''),
         '[^0-9]',
         '',
         'g'
       ) <> normalized_reference
       or coalesce(
         p_receipt_extracted#>>'{gcash,amount,reliable}',
         ''
       ) <> 'true'
       or coalesce(
         p_receipt_extracted#>>'{gcash,amount,ambiguous}',
         ''
       ) <> 'false'
       or coalesce(
         p_receipt_extracted#>>'{gcash,amount,conflictingPrimaryAmounts}',
         ''
       ) <> 'false'
       or coalesce(
         p_receipt_extracted#>>'{gcash,timestamp,completeness}',
         ''
       ) <> 'date_time'
       or coalesce(p_receipt_extracted->>'receiptAgeMinutes', '')
         !~ '^-?[0-9]+([.][0-9]+)?$'
       or coalesce(
         p_receipt_extracted#>>'{gcash,recipientComparison,phone}',
         ''
       ) <> 'exact'
       or coalesce(
         p_receipt_extracted#>>'{gcash,recipientComparison,name}',
         ''
       ) = 'mismatch'
       or coalesce(
         p_receipt_extracted#>>'{gcash,indicators,classification}',
         ''
       ) <> 'gcash'
       or coalesce(
         p_receipt_extracted#>>'{gcash,indicators,sentViaGcash}',
         ''
       ) <> 'true'
       or coalesce(
         p_receipt_extracted#>>'{gcash,indicators,totalAmountSent}',
         ''
       ) <> 'true'
       or coalesce(
         p_receipt_extracted#>>'{gcash,indicators,referenceLabel}',
         ''
       ) <> 'true'
       or coalesce(
         p_receipt_extracted#>>'{gcash,indicators,amountLabel}',
         ''
       ) <> 'true'
       or coalesce(p_receipt_extracted->>'ocrProvider', '')
         <> 'google_vision'
       or coalesce(p_receipt_extracted->>'ocrConfidenceSource', '')
         <> 'native'
       or coalesce(p_receipt_extracted->>'amount', '')
         !~ '^[0-9]+([.][0-9]+)?$' then
      raise exception 'A duplicate GCash reference was not proven.'
        using errcode = '22023';
    end if;

    if (p_receipt_extracted->>'ocrConfidence')::numeric < 0.90
       or (p_receipt_extracted->>'ocrConfidence')::numeric > 1 then
      raise exception 'A duplicate GCash reference was not proven.'
        using errcode = '22023';
    end if;

    if (p_receipt_extracted->>'receiptAgeMinutes')::numeric < -2
       or (p_receipt_extracted->>'receiptAgeMinutes')::numeric > 15 then
      raise exception 'A duplicate GCash reference was not proven.'
        using errcode = '22023';
    end if;

    paid_amount := (p_receipt_extracted->>'amount')::numeric;
    if expected_total <= 0
       or expected_due <= 0
       or expected_due > expected_total + 0.01
       or abs(paid_amount - expected_due) > 0.01
       or (
         abs(expected_due - expected_total) <= 0.01
         and coalesce(p_receipt_extracted->>'autoPaymentStatus', '') <> 'paid'
       )
       or (
         expected_due < expected_total - 0.01
         and (
           non_host_rows <> 0
           or coalesce(
             p_receipt_extracted->>'autoPaymentStatus',
             ''
           ) <> 'downpayment_paid'
         )
       ) then
      raise exception 'A duplicate GCash reference was not proven.'
        using errcode = '22023';
    end if;

    select exists (
      select 1
        from public.used_gcash_refs ledger
       where ledger.gcash_ref = normalized_reference
         and (
           ledger.claim_scope is distinct from ledger_claim_scope
           or ledger.claim_owner_id is distinct from logical_booking_key
         )
    )
      into duplicate_owned_elsewhere;
    if not duplicate_owned_elsewhere then
      raise exception 'A duplicate GCash reference was not proven.'
        using errcode = '22023';
    end if;
  end if;

  update public.bookings b
     set status = case
           when p_result = 'rejected' then 'cancelled'
           else 'pending'
         end,
         payment_status = case
           when p_result = 'rejected' then 'rejected'
           else 'for_verification'
         end,
         receipt_image_url = p_receipt_image_url,
         receipt_image_hash = p_receipt_image_hash,
         receipt_phash = p_receipt_phash,
         receipt_status = p_result,
         receipt_flags = coalesce(p_receipt_flags, array[]::text[]),
         receipt_extracted = p_receipt_extracted,
         receipt_confidence = p_receipt_confidence,
         receipt_verified_at =
           coalesce(p_receipt_verified_at, clock_timestamp())
   where b.ref = any(actual_refs);

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(actual_refs) then
    raise exception 'GCash review did not update the complete booking group.'
      using errcode = '40001';
  end if;

  insert into public.receipt_verifications (
    booking_ref,
    result,
    flags,
    extracted,
    confidence,
    image_hash,
    phash,
    raw_ocr_text
  ) values (
    p_booking_ref,
    p_result,
    coalesce(p_receipt_flags, array[]::text[]),
    p_receipt_extracted,
    p_receipt_confidence,
    p_receipt_image_hash,
    p_receipt_phash,
    p_raw_ocr_text
  );

  delete from public.receipt_verification_leases leases
   where leases.booking_key = logical_booking_key
     and leases.claim_token = p_lease_token;
  if not found then
    raise exception 'Receipt verification lease changed before commit.'
      using errcode = '40001';
  end if;

  return query
  select b.ref, b.status, b.payment_status
    from public.bookings b
   where b.ref = any(actual_refs)
   order by b.ref;
end;
$$;

revoke all on function public.finalize_gcash_receipt_auto_approval(
  text, text[], text, uuid, text, text, text, text, text, text[], jsonb, numeric,
  timestamptz, text
) from public, anon, authenticated;

grant execute on function public.finalize_gcash_receipt_auto_approval(
  text, text[], text, uuid, text, text, text, text, text, text[], jsonb, numeric,
  timestamptz, text
) to service_role;

revoke all on function public.finalize_gcash_receipt_review(
  text, text[], text, uuid, text, text, text, text, text, text[], jsonb,
  numeric, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.finalize_gcash_receipt_review(
  text, text[], text, uuid, text, text, text, text, text, text[], jsonb,
  numeric, timestamptz, text
) to service_role;

commit;
