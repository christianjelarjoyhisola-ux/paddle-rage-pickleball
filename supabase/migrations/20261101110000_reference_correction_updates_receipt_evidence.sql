-- Fix: a corrected booking could still not be confirmed.
--
-- The receipt verifier stores the player's typed reference in
-- receipt_extracted.submittedReference. When the receipt parser emits no
-- evidence keys (for example the receipt is not really from the selected
-- provider), confirmation claims that stored copy instead. After an owner
-- correction it still held the mistyped reference, which belongs to another
-- payment, so Confirm Payment failed with "already linked to another payment".
--
-- This migration
--   1. makes correct_booking_payment_reference keep submittedReference in step
--      with the corrected reference (original kept as
--      submittedReferenceBeforeCorrection) and verify up front that every
--      receipt identifier can be claimed, so a correction never leaves a
--      booking stuck;
--   2. repairs bookings that were already corrected and are still pending.

begin;

create or replace function public.correct_booking_payment_reference(
  p_booking_ref text,
  p_corrected_reference text,
  p_reason text,
  p_scan_override boolean,
  p_idempotency_key uuid
)
returns table (
  transitioned boolean,
  correction_id uuid,
  booking_ref text,
  booking_refs text[],
  previous_reference text,
  corrected_reference text,
  receipt_reference text,
  receipt_reference_matched boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested_ref text := nullif(trim(coalesce(p_booking_ref, '')), '');
  v_reason text := nullif(trim(regexp_replace(
    left(coalesce(p_reason, ''), 500),
    '[[:cntrl:]]',
    ' ',
    'g'
  )), '');
  v_actor_role text := public.current_account_role();
  v_actor_id uuid := auth.uid();
  v_existing public.booking_payment_reference_corrections%rowtype;
  v_anchor public.bookings%rowtype;
  v_group_ref text;
  v_booking_key text;
  v_refs text[];
  v_row_count integer;
  v_methods text[];
  v_method text;
  v_typed_refs text[];
  v_previous text;
  v_previous_key text;
  v_corrected_key text;
  v_corrected_display text;
  v_receipt_refs text[];
  v_receipt_ref text;
  v_receipt_key text;
  v_matched boolean := false;
  v_override boolean := coalesce(p_scan_override, false);
  v_flags_to_clear text[] := array['DUPLICATE_REF', 'POSSIBLE_DUPLICATE_REF', 'REF_MISMATCH'];
  v_correction_id uuid := gen_random_uuid();
  v_updated integer;
  v_evidence record;
  v_claim_scope text;
begin
  if v_actor_id is null or v_actor_role not in ('owner', 'court_owner') then
    raise exception 'Only an active system owner or court owner can correct a payment reference.'
      using errcode = '42501';
  end if;
  if v_requested_ref is null then
    raise exception 'A booking reference is required.' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_corrected_reference, '')), '') is null then
    raise exception 'Enter the reference exactly as it appears on the receipt.'
      using errcode = '22023';
  end if;
  if char_length(coalesce(v_reason, '')) < 10 then
    raise exception 'A correction reason of at least 10 characters is required.'
      using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    raise exception 'A correction idempotency key is required.' using errcode = '22023';
  end if;

  select nullif(trim(coalesce(b.booking_group_ref, '')), '')
    into v_group_ref
    from public.bookings b
   where b.ref = v_requested_ref;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;
  v_booking_key := coalesce(v_group_ref, v_requested_ref);

  -- Serialize with confirmation, rejection and receipt verification of the
  -- same logical booking.
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-public-booking-group:' || v_booking_key, 0)
  );

  select c.* into v_existing
    from public.booking_payment_reference_corrections c
   where c.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.booking_key is distinct from v_booking_key then
      raise exception 'This correction request was already used for another booking.'
        using errcode = '22023';
    end if;
    return query
    select false, v_existing.id, v_requested_ref, v_existing.booking_refs,
           v_existing.previous_reference, v_existing.corrected_reference,
           v_existing.receipt_reference, v_existing.receipt_reference_matched;
    return;
  end if;

  perform 1
    from public.bookings b
   where b.ref = v_requested_ref
      or (v_group_ref is not null and b.booking_group_ref = v_group_ref)
   order by b.ref
   for update;

  select b.* into v_anchor from public.bookings b where b.ref = v_requested_ref;

  select array_agg(b.ref order by b.ref),
         count(*),
         array_agg(distinct lower(trim(coalesce(b.payment_method, '')))),
         array_agg(distinct coalesce(b.gcash_ref, ''))
    into v_refs, v_row_count, v_methods, v_typed_refs
    from public.bookings b
   where b.ref = v_requested_ref
      or (v_group_ref is not null and b.booking_group_ref = v_group_ref);

  if v_row_count < 1 or v_row_count > 50 then
    raise exception 'The booking has an invalid number of rows.' using errcode = '22023';
  end if;
  if cardinality(v_methods) <> 1 then
    raise exception 'Grouped payment methods are mixed. Review the booking first.'
      using errcode = '22023';
  end if;
  v_method := v_methods[1];
  if v_method not in (
    'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'unionbank', 'pnb', 'rcbc'
  ) then
    raise exception 'Only digital payments have a reference to correct.'
      using errcode = '22023';
  end if;
  if cardinality(v_typed_refs) <> 1 then
    raise exception 'Grouped payment references are inconsistent. Review the booking first.'
      using errcode = '22023';
  end if;
  v_previous := v_typed_refs[1];

  if exists (
    select 1 from public.bookings b
     where b.ref = any(v_refs)
       and (
         lower(trim(coalesce(b.status, ''))) not in ('pending', 'verifying')
         or lower(trim(coalesce(b.payment_status, ''))) <> 'for_verification'
       )
  ) then
    raise exception 'Only a pending payment awaiting verification can have its reference corrected.'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from public.bookings b
     where b.ref = any(v_refs)
       and lower(trim(coalesce(b.receipt_status, ''))) = 'rejected'
  ) then
    raise exception 'This receipt was rejected and its reference cannot be corrected.'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from public.bookings b
     where b.ref = any(v_refs)
       and (b.payment_transfer_id is not null
            or b.payment_reassigned_from_ref is not null
            or b.payment_reassigned_to_ref is not null)
  ) then
    raise exception 'Moved payments cannot have their reference corrected.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.bookings b
     where b.ref = any(v_refs)
       and nullif(trim(coalesce(b.receipt_image_url, '')), '') is not null
  ) then
    raise exception 'A receipt image is required before correcting the reference.'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from public.receipt_verification_leases l
     where l.booking_key = v_booking_key
       and l.lease_expires_at > now()
  ) then
    raise exception 'The receipt is still being checked. Try again in a minute.'
      using errcode = '40001';
  end if;

  -- Validates provider-specific format (13-digit GCash, BN… BDO Pay, etc.).
  v_corrected_key := public.normalize_payment_reference_key(v_method, p_corrected_reference);
  v_corrected_display := case
    when v_method = 'gcash' then regexp_replace(p_corrected_reference, '[^0-9]', '', 'g')
    else upper(regexp_replace(p_corrected_reference, '[^A-Za-z0-9]', '', 'g'))
  end;
  v_previous_key := public.payment_reference_collision_key(v_method, v_previous);

  if v_previous_key is not distinct from v_corrected_key then
    raise exception 'The corrected reference is the same as the one already saved.'
      using errcode = '22023';
  end if;

  -- What did the receipt scanner read?
  select array_agg(distinct nullif(trim(b.receipt_extracted->>'ref'), ''))
           filter (where nullif(trim(b.receipt_extracted->>'ref'), '') is not null)
    into v_receipt_refs
    from public.bookings b
   where b.ref = any(v_refs);
  if cardinality(coalesce(v_receipt_refs, array[]::text[])) > 1 then
    raise exception 'Grouped receipt scans disagree. Reread the receipt before correcting.'
      using errcode = '22023';
  end if;
  v_receipt_ref := v_receipt_refs[1];
  v_receipt_key := public.payment_reference_collision_key(v_method, v_receipt_ref);

  if v_receipt_key is not null and v_receipt_key = v_previous_key then
    raise exception 'The receipt itself shows the reference already in use. This is a real duplicate and cannot be corrected.'
      using errcode = '23505';
  end if;

  v_matched := v_receipt_key is not null and v_receipt_key = v_corrected_key;
  if not v_matched then
    if not v_override then
      raise exception '%', case
        when v_receipt_key is null then
          'The receipt scan did not read a reference. Check the receipt image, then tick "I checked the receipt image" to save it.'
        else
          format('The receipt scan read %s, which does not match. If the receipt image shows your reference, tick "I checked the receipt image" to save it.', v_receipt_ref)
      end using errcode = '22023';
    end if;
  else
    v_override := false;
  end if;

  -- The corrected reference must be free everywhere.
  if exists (
    select 1 from public.bookings other_booking
     where not (other_booking.ref = any(v_refs))
       and public.payment_reference_collision_key(
             other_booking.payment_method, other_booking.gcash_ref
           ) = v_corrected_key
  ) then
    raise exception 'The corrected reference is already attached to another booking.'
      using errcode = '23505';
  end if;
  if exists (
    select 1 from public.open_play_registrations r
     where public.payment_reference_collision_key(r.payment_method, r.gcash_ref) = v_corrected_key
  ) or exists (
    select 1 from public.open_play_host_session_registrations r
     where public.payment_reference_collision_key(r.payment_method, r.gcash_ref) = v_corrected_key
  ) then
    raise exception 'The corrected reference is already attached to an Open Play registration.'
      using errcode = '23505';
  end if;
  if exists (
    select 1 from public.used_gcash_refs ledger
     where ledger.gcash_ref = v_corrected_key
       and not (
         ledger.claim_scope = case when v_group_ref is null then 'booking' else 'booking_group' end
         and ledger.claim_owner_id = v_booking_key
       )
  ) then
    raise exception 'The corrected reference has already been used for another payment.'
      using errcode = '23505';
  end if;

  update public.bookings b
     set gcash_ref = v_corrected_display,
         receipt_flags = (
           select coalesce(array_agg(flag order by ord), array[]::text[])
             from unnest(coalesce(b.receipt_flags, array[]::text[]))
                    with ordinality as existing(flag, ord)
            where not (upper(trim(flag)) = any(v_flags_to_clear))
              and upper(trim(flag)) not in ('REF_CORRECTED', 'REF_CORRECTED_SCAN_OVERRIDE')
         ) || array[case when v_override then 'REF_CORRECTED_SCAN_OVERRIDE' else 'REF_CORRECTED' end],
         -- Confirmation falls back to this stored copy of the typed reference
         -- when the receipt parser emitted no evidence keys. Keep it in step
         -- with the correction, and keep the original for the audit trail.
         receipt_extracted = case
           when jsonb_typeof(b.receipt_extracted) = 'object' then
             b.receipt_extracted || jsonb_build_object(
               'submittedReference', v_corrected_display,
               'submittedReferenceBeforeCorrection', coalesce(
                 b.receipt_extracted->'submittedReferenceBeforeCorrection',
                 b.receipt_extracted->'submittedReference',
                 to_jsonb(v_previous)
               )
             )
           else b.receipt_extracted
         end
   where b.ref = any(v_refs)
     and lower(trim(coalesce(b.payment_status, ''))) = 'for_verification';
  get diagnostics v_updated = row_count;
  if v_updated <> cardinality(v_refs) then
    raise exception 'Booking changed while correcting the reference. Refresh and try again.'
      using errcode = '40001';
  end if;

  -- Prove now that Confirm Payment will be able to claim every receipt
  -- identifier, so a corrected booking never gets stuck. Any collision here is
  -- the receipt image itself belonging to another payment.
  v_claim_scope := case when v_group_ref is null then 'booking' else 'booking_group' end;
  for v_evidence in
    select distinct keys.ledger_key
      from public.bookings b
      cross join lateral public.payment_review_ledger_keys(
        coalesce(b.receipt_extracted, '{}'::jsonb), v_method, b.gcash_ref
      ) keys
     where b.ref = any(v_refs)
  loop
    if exists (
      select 1 from public.used_gcash_refs ledger
       where ledger.gcash_ref = v_evidence.ledger_key
         and not (ledger.claim_scope = v_claim_scope and ledger.claim_owner_id = v_booking_key)
    ) then
      raise exception 'This receipt is already linked to another payment (receipt identifier %). This looks like a real duplicate receipt, so the reference cannot be corrected.',
        v_evidence.ledger_key using errcode = '23505';
    end if;
  end loop;

  insert into public.booking_payment_reference_corrections (
    id, idempotency_key, booking_key, booking_refs, payment_method,
    previous_reference, previous_reference_key,
    corrected_reference, corrected_reference_key,
    receipt_reference, receipt_reference_matched, scan_override,
    reason, actor_user_id, actor_role
  ) values (
    v_correction_id, p_idempotency_key, v_booking_key, v_refs, v_method,
    v_previous, v_previous_key,
    v_corrected_display, v_corrected_key,
    v_receipt_ref, v_matched, v_override,
    v_reason, v_actor_id, v_actor_role
  );

  return query
  select true, v_correction_id, v_requested_ref, v_refs,
         v_previous, v_corrected_display, v_receipt_ref, v_matched;
end;
$$;


revoke all on function public.correct_booking_payment_reference(text, text, text, boolean, uuid)
  from public, anon;
grant execute on function public.correct_booking_payment_reference(text, text, text, boolean, uuid)
  to authenticated;

-- Repair pending bookings corrected before this fix.
update public.bookings b
   set receipt_extracted = b.receipt_extracted || jsonb_build_object(
         'submittedReference', b.gcash_ref,
         'submittedReferenceBeforeCorrection', coalesce(
           b.receipt_extracted->'submittedReferenceBeforeCorrection',
           b.receipt_extracted->'submittedReference'
         )
       )
  from (
    select distinct on (r.ref) r.ref, c.corrected_reference
      from public.booking_payment_reference_corrections c
      cross join lateral unnest(c.booking_refs) as r(ref)
     order by r.ref, c.created_at desc
  ) latest
 where b.ref = latest.ref
   and b.gcash_ref = latest.corrected_reference
   and lower(coalesce(b.payment_status, '')) = 'for_verification'
   and jsonb_typeof(b.receipt_extracted) = 'object'
   and b.receipt_extracted ? 'submittedReference'
   and b.receipt_extracted->>'submittedReference' is distinct from b.gcash_ref;

commit;
