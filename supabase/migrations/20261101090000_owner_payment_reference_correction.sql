-- Owner correction of a mistyped digital payment reference.
--
-- A player sometimes types a reference that differs from the one printed on
-- the receipt. When the mistyped value happens to belong to another payment,
-- confirmation is correctly blocked as a duplicate, yet the receipt itself is
-- valid. This migration lets the system owner or court owner replace the typed
-- reference with the one on the receipt, without weakening duplicate
-- protection:
--
--   * only pending, for-verification digital bookings with a receipt image;
--   * the corrected value must match the reference the receipt scanner read;
--     when the scan is missing or disagrees, only the system owner may proceed
--     and must explicitly acknowledge it;
--   * a receipt whose scan shows the very reference being replaced is a real
--     duplicate and can never be corrected away;
--   * the corrected reference must not belong to any other booking,
--     registration or ledger claim;
--   * the booking is NOT confirmed here. The normal confirmation transaction
--     still claims the corrected reference and every receipt replay key.
--
-- Every correction is written to an append-only audit table.

begin;

create table if not exists public.booking_payment_reference_corrections (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  booking_key text not null,
  booking_refs text[] not null,
  payment_method text not null,
  previous_reference text not null,
  previous_reference_key text,
  corrected_reference text not null,
  corrected_reference_key text not null,
  receipt_reference text,
  receipt_reference_matched boolean not null,
  scan_override boolean not null default false,
  reason text not null,
  actor_user_id uuid not null,
  actor_role text not null,
  created_at timestamptz not null default now(),
  constraint booking_payment_reference_corrections_refs_check
    check (cardinality(booking_refs) between 1 and 50),
  constraint booking_payment_reference_corrections_reason_check
    check (char_length(reason) between 10 and 500),
  constraint booking_payment_reference_corrections_role_check
    check (actor_role in ('owner', 'court_owner')),
  constraint booking_payment_reference_corrections_override_check
    check (not scan_override or actor_role = 'owner')
);

create index if not exists booking_payment_reference_corrections_booking_key_idx
  on public.booking_payment_reference_corrections (booking_key, created_at desc);
create index if not exists booking_payment_reference_corrections_refs_idx
  on public.booking_payment_reference_corrections using gin (booking_refs);

alter table public.booking_payment_reference_corrections enable row level security;

drop policy if exists booking_payment_reference_corrections_owner_read
  on public.booking_payment_reference_corrections;
create policy booking_payment_reference_corrections_owner_read
  on public.booking_payment_reference_corrections
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

revoke all on public.booking_payment_reference_corrections from public, anon;
revoke insert, update, delete, truncate
  on public.booking_payment_reference_corrections from authenticated;
grant select on public.booking_payment_reference_corrections to authenticated;

create or replace function public.prevent_payment_reference_correction_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Payment reference correction audits are immutable.'
    using errcode = '42501';
end;
$$;

drop trigger if exists z99_prevent_payment_reference_correction_mutation
  on public.booking_payment_reference_corrections;
create trigger z99_prevent_payment_reference_correction_mutation
before update or delete on public.booking_payment_reference_corrections
for each row execute function public.prevent_payment_reference_correction_mutation();

drop trigger if exists z99_prevent_payment_reference_correction_truncate
  on public.booking_payment_reference_corrections;
create trigger z99_prevent_payment_reference_correction_truncate
before truncate on public.booking_payment_reference_corrections
for each statement execute function public.prevent_payment_reference_correction_mutation();

-- Same comparison key that confirm_booking_transaction uses for its
-- "also attached to another booking" check, but never raises: legacy rows may
-- hold malformed references and must simply fail to match.
create or replace function public.payment_reference_collision_key(
  p_provider text,
  p_reference text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when lower(trim(coalesce(p_provider, ''))) not in (
      'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'unionbank',
      'pnb', 'rcbc'
    ) then null
    when lower(trim(p_provider)) = 'gcash' then
      nullif(regexp_replace(coalesce(p_reference, ''), '[^0-9]', '', 'g'), '')
    when nullif(regexp_replace(coalesce(p_reference, ''), '[^A-Za-z0-9]', '', 'g'), '') is null
      then null
    else lower(trim(p_provider)) || ':' ||
      upper(regexp_replace(coalesce(p_reference, ''), '[^A-Za-z0-9]', '', 'g'))
  end
$$;

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
          'The receipt scan did not read a reference. Reread the receipt, or ask the system owner to correct it with a scan override.'
        else
          format('The receipt scan read %s, which does not match the corrected reference. Check the receipt image again.', v_receipt_ref)
      end using errcode = '22023';
    end if;
    if v_actor_role <> 'owner' then
      raise exception 'Only the system owner can correct a reference that the receipt scan did not confirm.'
        using errcode = '42501';
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
         ) || array[case when v_override then 'REF_CORRECTED_SCAN_OVERRIDE' else 'REF_CORRECTED' end]
   where b.ref = any(v_refs)
     and lower(trim(coalesce(b.payment_status, ''))) = 'for_verification';
  get diagnostics v_updated = row_count;
  if v_updated <> cardinality(v_refs) then
    raise exception 'Booking changed while correcting the reference. Refresh and try again.'
      using errcode = '40001';
  end if;

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
revoke all on function public.payment_reference_collision_key(text, text) from public, anon;
grant execute on function public.payment_reference_collision_key(text, text) to authenticated;

commit;
