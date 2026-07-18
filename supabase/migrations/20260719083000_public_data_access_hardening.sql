-- Protect customer/financial data while preserving the public availability UI.
--
-- Key design decisions:
--   * Anonymous clients can read only non-PII booking/open-play columns.
--   * Full rows are visible only to active dashboard roles, or to the host that
--     owns a host booking.
--   * Anonymous hold updates require a 256-bit bearer token. Only its SHA-256
--     digest is stored in the database.
--   * Anonymous inserts are canonicalized before RLS evaluates them so price,
--     ownership, audit, and payment-approval fields cannot be forged.
--   * Open-play OCR results submitted by a browser are never trusted as a
--     payment approval. Digital receipts enter manual review unless a trusted
--     service-role function later verifies and updates the row.

begin;

create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------------------
-- Recoverable, rate-limited host email verification
-- --------------------------------------------------------------------------

alter table public.open_play_host_applications
  add column if not exists verification_email_sent_at timestamptz,
  add column if not exists verification_email_resend_count integer default 0;

update public.open_play_host_applications
   set verification_email_resend_count = 0
 where verification_email_resend_count is null;

alter table public.open_play_host_applications
  alter column verification_email_resend_count set default 0,
  alter column verification_email_resend_count set not null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.open_play_host_applications'::regclass
       and conname = 'open_play_host_applications_verification_resend_count_check'
  ) then
    alter table public.open_play_host_applications
      add constraint open_play_host_applications_verification_resend_count_check
      check (verification_email_resend_count between 0 and 10);
  end if;
end;
$$;

-- Only one non-rejected application may reserve an email at a time. Rejected
-- applicants can submit a fresh application without retaining a stale lock.
create unique index if not exists uq_open_play_host_applications_active_email
  on public.open_play_host_applications (lower(email))
  where status <> 'rejected';

-- --------------------------------------------------------------------------
-- Unambiguous, cross-flow payment-reference ledger ownership
-- --------------------------------------------------------------------------

alter table public.used_gcash_refs
  add column if not exists claim_scope text,
  add column if not exists claim_owner_id text;

-- Before this migration only persisted court bookings could claim this
-- ledger. Preserve their visible booking_ref while recording an explicit
-- owner scope/id. Grouped bookings share one logical claim owner.
update public.used_gcash_refs ledger
   set claim_scope = case
         when nullif(trim(coalesce(b.booking_group_ref, '')), '') is not null
           then 'booking_group'
         else 'booking'
       end,
       claim_owner_id = coalesce(
         nullif(trim(coalesce(b.booking_group_ref, '')), ''),
         b.ref
       )
  from public.bookings b
 where b.ref = ledger.booking_ref
   and (ledger.claim_scope is null or ledger.claim_owner_id is null);

update public.used_gcash_refs
   set claim_scope = coalesce(nullif(trim(claim_scope), ''), 'booking'),
       claim_owner_id = coalesce(nullif(trim(claim_owner_id), ''), booking_ref)
 where claim_scope is null
    or claim_owner_id is null
    or trim(claim_scope) = ''
    or trim(claim_owner_id) = '';

alter table public.used_gcash_refs
  alter column claim_scope set default 'booking',
  alter column claim_scope set not null,
  alter column claim_owner_id set not null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.used_gcash_refs'::regclass
       and conname = 'used_gcash_refs_claim_scope_check'
  ) then
    alter table public.used_gcash_refs
      add constraint used_gcash_refs_claim_scope_check
      check (claim_scope in ('booking', 'booking_group', 'open_play', 'host_session'));
  end if;
end;
$$;

comment on column public.used_gcash_refs.claim_scope is
  'Logical owner type for an immutable payment-reference claim.';
comment on column public.used_gcash_refs.claim_owner_id is
  'Owner identifier within claim_scope; booking groups share their group reference.';

create table if not exists public.notification_event_claims (
  event_key text primary key,
  event_type text not null,
  subject_type text not null,
  subject_id text not null,
  claimed_at timestamptz not null default now(),
  constraint notification_event_claims_key_check
    check (length(event_key) between 8 and 200),
  constraint notification_event_claims_subject_check
    check (length(subject_type) between 2 and 40 and length(subject_id) between 1 and 150)
);

alter table public.notification_event_claims enable row level security;
drop policy if exists notification_event_claims_no_access
  on public.notification_event_claims;
create policy notification_event_claims_no_access
  on public.notification_event_claims
  for all
  to anon, authenticated
  using (false)
  with check (false);

create or replace function public.prepare_payment_reference_ledger_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  booking_group_owner text;
begin
  -- Compatibility for a briefly older verifier during a rolling deployment:
  -- its insert supplies booking_ref but not the new ownership columns.
  if nullif(trim(coalesce(new.claim_scope, '')), '') is null
     or nullif(trim(coalesce(new.claim_owner_id, '')), '') is null then
    select nullif(trim(coalesce(b.booking_group_ref, '')), '')
      into booking_group_owner
      from public.bookings b
     where b.ref = new.booking_ref
     limit 1;
  end if;
  new.claim_scope := coalesce(
    nullif(trim(new.claim_scope), ''),
    case when booking_group_owner is not null then 'booking_group' else 'booking' end
  );
  new.claim_owner_id := coalesce(
    nullif(trim(new.claim_owner_id), ''),
    booking_group_owner,
    nullif(trim(new.booking_ref), '')
  );
  return new;
end;
$$;

drop trigger if exists a00_prepare_payment_reference_ledger_owner
  on public.used_gcash_refs;
create trigger a00_prepare_payment_reference_ledger_owner
before insert on public.used_gcash_refs
for each row execute function public.prepare_payment_reference_ledger_owner();

create or replace function public.normalize_payment_reference_key(
  p_provider text,
  p_typed_reference text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  provider_value text := lower(trim(coalesce(p_provider, '')));
  normalized_value text;
begin
  if provider_value = 'cash' then
    return null;
  end if;
  if provider_value not in ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb') then
    raise exception 'Unsupported digital payment provider.' using errcode = '22023';
  end if;

  normalized_value := case
    when provider_value = 'gcash' then
      regexp_replace(coalesce(p_typed_reference, ''), '[^0-9]', '', 'g')
    else
      upper(regexp_replace(coalesce(p_typed_reference, ''), '[^A-Za-z0-9]', '', 'g'))
  end;

  if normalized_value = '' then
    raise exception 'A payment reference is required before confirming payment.' using errcode = '22023';
  end if;

  -- Match the browser/verifier validation for providers with a fixed format.
  if provider_value = 'gcash' and normalized_value !~ '^[0-9]{13}$' then
    raise exception 'The GCash reference must contain exactly 13 digits.' using errcode = '22023';
  elsif provider_value = 'bdopay' and normalized_value !~ '^BN[0-9]{16}$' then
    raise exception 'The BDO Pay reference is invalid.' using errcode = '22023';
  elsif provider_value = 'maya' and normalized_value !~ '^[A-Z0-9]{12}$' then
    raise exception 'The Maya reference is invalid.' using errcode = '22023';
  elsif provider_value = 'bpi' and normalized_value !~ '^[0-9]{10,20}$' then
    raise exception 'The BPI confirmation number is invalid.' using errcode = '22023';
  end if;

  return case
    when provider_value = 'gcash' then normalized_value
    else provider_value || ':' || normalized_value
  end;
end;
$$;

create or replace function public.claim_payment_reference(
  p_provider text,
  p_typed_reference text,
  p_claim_scope text,
  p_claim_owner_id text,
  p_owner_display_ref text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  provider_value text := lower(trim(coalesce(p_provider, '')));
  scope_value text := lower(trim(coalesce(p_claim_scope, '')));
  owner_value text := nullif(trim(coalesce(p_claim_owner_id, '')), '');
  display_value text := nullif(trim(coalesce(p_owner_display_ref, '')), '');
  claim_key text;
  incumbent_scope text;
  incumbent_owner text;
begin
  if provider_value = 'cash' then
    return null;
  end if;
  if scope_value not in ('booking', 'booking_group', 'open_play', 'host_session')
     or owner_value is null
     or display_value is null then
    raise exception 'Payment-reference claim ownership is invalid.' using errcode = '22023';
  end if;

  claim_key := public.normalize_payment_reference_key(provider_value, p_typed_reference);

  insert into public.used_gcash_refs (
    gcash_ref,
    booking_ref,
    provider,
    claim_scope,
    claim_owner_id
  ) values (
    claim_key,
    display_value,
    provider_value,
    scope_value,
    owner_value
  )
  on conflict (gcash_ref) do nothing;

  select ledger.claim_scope, ledger.claim_owner_id
    into incumbent_scope, incumbent_owner
    from public.used_gcash_refs ledger
   where ledger.gcash_ref = claim_key;

  if incumbent_scope is distinct from scope_value
     or incumbent_owner is distinct from owner_value then
    raise exception 'This payment reference has already been used for another payment.'
      using errcode = '23505';
  end if;

  return claim_key;
end;
$$;

-- A public payment path is usable only when an administrator explicitly
-- enables it and configures a real recipient identity/destination. This keeps
-- stale flags or partially-saved settings from exposing placeholder payment
-- instructions to customers.
create or replace function public.public_payment_method_ready(p_method text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  method_value text := lower(trim(coalesce(p_method, '')));
  method_enabled boolean;
  has_recipient_name boolean;
  has_destination boolean;
begin
  select trim(coalesce(s.value, '')) = '1'
    into method_enabled
    from public.settings s
   where s.key = 'payment_method_' || method_value
   limit 1;

  if not coalesce(method_enabled, false) then
    return false;
  end if;
  if method_value = 'cash' then
    return true;
  end if;

  if method_value in ('gcash', 'bdopay', 'maya', 'bpi') then
    select exists (
      select 1 from public.settings s
       where s.key = any(array[
         method_value || '_merchant_name',
         'payment_merchant_name',
         'gcash_merchant_name'
       ])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_recipient_name;
    select exists (
      select 1 from public.settings s
       where s.key = any(array[
         method_value || '_merchant_number',
         method_value || '_qr_image',
         'gcash_merchant_number',
         'gcash_qr_image'
       ])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_destination;
  elsif method_value in ('gotyme', 'pnb') then
    select exists (
      select 1 from public.settings s
       where s.key = method_value || '_merchant_name'
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_recipient_name;
    select exists (
      select 1 from public.settings s
       where s.key = any(array[
         method_value || '_merchant_number',
         method_value || '_qr_image'
       ])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_destination;
  else
    return false;
  end if;

  return coalesce(has_recipient_name, false)
     and coalesce(has_destination, false);
end;
$$;

revoke all on function public.public_payment_method_ready(text)
  from public, anon, authenticated;
grant execute on function public.public_payment_method_ready(text)
  to service_role;

alter table public.bookings
  add column if not exists customer_access_token_hash text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.bookings'::regclass
       and conname = 'bookings_customer_access_token_hash_check'
  ) then
    alter table public.bookings
      add constraint bookings_customer_access_token_hash_check
      check (
        customer_access_token_hash is null
        or customer_access_token_hash ~ '^[0-9a-f]{64}$'
      );
  end if;
end;
$$;

comment on column public.bookings.customer_access_token_hash is
  'SHA-256 digest of the random browser token required to update an anonymous booking hold. Never expose this column through the API.';

-- --------------------------------------------------------------------------
-- Canonical public booking inserts
-- --------------------------------------------------------------------------

create or replace function public.prepare_public_booking_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  is_public_submission boolean :=
    coalesce(current_setting('paddle_rage.public_booking_submission', true), '') = 'on'
    or request_role = 'anon';
  authoritative_court_name text;
  authoritative_rate numeric;
  court_blocked boolean;
  court_total numeric;
  service_fee numeric;
  first_hour integer;
  last_hour integer;
begin
  if not is_public_submission then
    return new;
  end if;

  if nullif(trim(coalesce(new.ref, '')), '') is null
     or length(new.ref) > 100 then
    raise exception 'A valid booking reference is required.' using errcode = '22023';
  end if;

  if nullif(trim(coalesce(new.full_name, '')), '') is null
     or length(trim(new.full_name)) > 150 then
    raise exception 'A valid customer name is required.' using errcode = '22023';
  end if;

  if length(coalesce(new.contact_number, '')) > 40
     or length(coalesce(new.email, '')) > 254
     or length(coalesce(new.gcash_ref, '')) > 100 then
    raise exception 'Booking contact or payment reference is too long.' using errcode = '22023';
  end if;

  if new.date is null
     or new.date < current_date
     or new.date > current_date + 366 then
    raise exception 'Booking date is outside the allowed reservation window.' using errcode = '22023';
  end if;

  if new.slots is null
     or coalesce(cardinality(new.slots), 0) = 0
     or cardinality(new.slots) > 24 then
    raise exception 'Booking must contain valid time slots.' using errcode = '22023';
  end if;

  if (
    select count(distinct slot_value)
      from unnest(new.slots) as slot_value
  ) <> cardinality(new.slots) then
    raise exception 'Booking time slots cannot contain duplicates.' using errcode = '22023';
  end if;
  if exists (
    select 1
      from unnest(new.slots) as slot_value
     where slot_value !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
  ) then
    raise exception 'Booking time slots are invalid.' using errcode = '22023';
  end if;

  if new.customer_access_token_hash is null
     or new.customer_access_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A secure booking access token is required.' using errcode = '42501';
  end if;

  new.booking_group_ref := nullif(trim(coalesce(new.booking_group_ref, '')), '');
  if new.booking_group_ref is not null then
    if length(new.booking_group_ref) > 100 then
      raise exception 'Booking group reference is too long.' using errcode = '22023';
    end if;

    -- Every row in a browser-created group must share the same access-token
    -- digest. This prevents a caller from attaching its row to another
    -- customer's group and causing a service-role receipt update to fan out to
    -- the victim's bookings. The advisory lock closes the first-row race.
    perform pg_advisory_xact_lock(
      hashtextextended('paddle-rage-public-booking-group:' || new.booking_group_ref, 0)
    );
    if exists (
      select 1
        from public.bookings existing
       where existing.booking_group_ref = new.booking_group_ref
         and existing.customer_access_token_hash is distinct from new.customer_access_token_hash
    ) then
      raise exception 'Booking group does not belong to this reservation.' using errcode = '42501';
    end if;
  end if;

  select c.name, c.rate, c.blocked
    into authoritative_court_name, authoritative_rate, court_blocked
    from public.courts c
   where c.id = new.court_id
   limit 1;

  if not found then
    raise exception 'Booking court was not found.' using errcode = '22023';
  end if;
  if coalesce(court_blocked, false) then
    raise exception 'This court is not currently available for booking.' using errcode = '22023';
  end if;

  if lower(coalesce(new.payment_method, 'cash')) not in
     ('cash', 'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb') then
    raise exception 'Unsupported payment method.' using errcode = '22023';
  end if;

  court_total := public.calculate_booking_court_total(new.court_id, new.slots);
  service_fee := public.calculate_booking_service_fee(new.slots);

  -- Serialize the database conflict check for one court/date. The legacy
  -- overlap trigger remains the final check, while this lock closes its
  -- concurrent check-then-insert race.
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-booking:' || new.court_id || ':' || new.date::text, 0)
  );

  select min(slot_value::integer), max(slot_value::integer)
    into first_hour, last_hour
    from unnest(new.slots) as slot_value;

  -- Values below are authoritative regardless of what the browser supplied.
  new.full_name := trim(new.full_name);
  new.court_name := authoritative_court_name;
  new.rate := authoritative_rate;
  new.duration := cardinality(new.slots);
  new.total := round(court_total + service_fee, 2);
  new.start_time := format(
    '%s:00 %s',
    case when first_hour % 12 = 0 then 12 else first_hour % 12 end,
    case when first_hour < 12 then 'AM' else 'PM' end
  );
  new.end_time := format(
    '%s:00 %s',
    case when (last_hour + 1) % 12 = 0 then 12 else (last_hour + 1) % 12 end,
    case when ((last_hour + 1) % 24) < 12 then 'AM' else 'PM' end
  );
  if new.downpayment is not null and not (
    abs(new.downpayment - new.total) <= 0.01
    or abs(new.downpayment - (new.total / 2)) <= 0.01
    or abs(new.downpayment - round(new.total / 2)) <= 0.01
    or abs(
      new.downpayment - round(
        least(greatest(coalesce(new.booking_fee_amount_snapshot, 0), 0), new.total)
        + ((new.total - least(greatest(coalesce(new.booking_fee_amount_snapshot, 0), 0), new.total)) * 0.50),
        2
      )
    ) <= 0.01
  ) then
    raise exception 'The requested payment amount is invalid.' using errcode = '22023';
  end if;
  new.created_at := clock_timestamp();
  new.host_booking := false;
  new.host_user_id := null;
  new.host_name := null;
  new.host_email := null;
  new.created_via := 'customer';
  new.created_by_user_id := null;
  new.created_by_role := null;
  new.created_by_name := null;
  new.created_by_email := null;
  new.payment_method := lower(coalesce(new.payment_method, 'cash'));
  new.received_account := case
    when new.payment_method = 'cash' then 'cash'
    else 'gcash'
  end;
  new.payment_flow := case
    when new.payment_flow is null then null
    else new.payment_method
  end;
  new.payment_provider := null;
  new.payment_session_id := null;
  new.payment_checkout_url := null;
  new.paid_at := null;
  new.balance_due_at := null;
  new.forfeited_at := null;
  new.forfeiture_reason := null;
  new.receipt_image_url := null;
  new.receipt_image_hash := null;
  new.receipt_phash := null;
  new.receipt_status := 'none';
  new.receipt_flags := '{}'::text[];
  new.receipt_extracted := null;
  new.receipt_confidence := null;
  new.receipt_verified_at := null;
  new.billed_at := null;
  new.weekly_fee_id := null;
  new.confirmation_email_id := null;
  new.confirmation_email_sent_at := null;
  new.confirmation_email_last_event := null;
  -- Every browser-created row begins as a short-lived, unpaid hold. Neither
  -- the Edge payload nor a service-role caller may create a permanent pending
  -- blocker. Only the token-authorized finalizer or receipt verifier can move
  -- this row to its next canonical state.
  new.status := 'verifying';
  new.payment_status := 'unpaid';

  -- The existing fee-snapshot trigger runs after this alphabetically and
  -- stamps the immutable platform fee. The existing RLS policy then validates
  -- full/partial downpayments against the authoritative total.
  return new;
end;
$$;

drop trigger if exists a00_prepare_public_booking_insert on public.bookings;
create trigger a00_prepare_public_booking_insert
before insert on public.bookings
for each row execute function public.prepare_public_booking_insert();

-- Public booking holds are created only by the Turnstile-protected Edge
-- Function. The function accepts a small atomic group so a multi-court hold
-- never consumes several challenge tokens or leaves a partially-created set.
create or replace function public.submit_public_booking_holds(
  p_bookings jsonb,
  p_access_token_hash text
)
returns table (booking_ref text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  booking_payload jsonb;
  inserted_ref text;
begin
  if request_role <> 'service_role' then
    raise exception 'Public booking holds must pass through the protected booking service.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_bookings) <> 'array'
     or jsonb_array_length(p_bookings) < 1
     or jsonb_array_length(p_bookings) > 8 then
    raise exception 'A booking request must contain between one and eight items.' using errcode = '22023';
  end if;
  if coalesce(p_access_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'A secure booking access token is required.' using errcode = '42501';
  end if;

  perform set_config('paddle_rage.public_booking_submission', 'on', true);

  for booking_payload in
    select value from jsonb_array_elements(p_bookings)
  loop
    if jsonb_typeof(booking_payload) <> 'object' then
      raise exception 'Each booking item must be an object.' using errcode = '22023';
    end if;

    insert into public.bookings (
      ref,
      booking_group_ref,
      full_name,
      contact_number,
      email,
      court_id,
      court_name,
      date,
      slots,
      start_time,
      end_time,
      duration,
      rate,
      total,
      payment_method,
      received_account,
      payment_flow,
      payment_status,
      gcash_ref,
      downpayment,
      status,
      created_at,
      customer_access_token_hash
    ) values (
      booking_payload->>'ref',
      nullif(trim(coalesce(booking_payload->>'booking_group_ref', '')), ''),
      booking_payload->>'full_name',
      nullif(trim(coalesce(booking_payload->>'contact_number', '')), ''),
      nullif(trim(coalesce(booking_payload->>'email', '')), ''),
      booking_payload->>'court_id',
      booking_payload->>'court_name',
      (booking_payload->>'date')::date,
      array(
        select jsonb_array_elements_text(coalesce(booking_payload->'slots', '[]'::jsonb))
      ),
      booking_payload->>'start_time',
      booking_payload->>'end_time',
      nullif(booking_payload->>'duration', '')::numeric,
      nullif(booking_payload->>'rate', '')::numeric,
      nullif(booking_payload->>'total', '')::numeric,
      lower(coalesce(nullif(booking_payload->>'payment_method', ''), 'cash')),
      lower(coalesce(nullif(booking_payload->>'received_account', ''), 'cash')),
      nullif(booking_payload->>'payment_flow', ''),
      'unpaid',
      nullif(trim(coalesce(booking_payload->>'gcash_ref', '')), ''),
      nullif(booking_payload->>'downpayment', '')::numeric,
      'verifying',
      clock_timestamp(),
      p_access_token_hash
    )
    returning public.bookings.ref into inserted_ref;

    booking_ref := inserted_ref;
    return next;
  end loop;
end;
$$;

-- Availability is also exposed as an RPC so an authenticated host can paint
-- all occupied slots without receiving another customer's private columns.
-- (A host's full own-booking history still uses the host-specific RLS policy.)
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
    and b.status not in ('cancelled', 'forfeited')
    and (b.status <> 'verifying' or b.created_at > now() - interval '15 minutes')
  order by b.created_at desc
$$;

-- A customer can recover/check only a hold for which this browser possesses
-- the bearer token. The response intentionally omits PII and all receipt
-- evidence; form values are restored from the browser's own resume draft.
create or replace function public.get_public_booking_by_ref(
  p_ref text,
  p_access_token text
)
returns table (
  ref text,
  court_id text,
  court_name text,
  date date,
  slots text[],
  start_time text,
  end_time text,
  duration numeric,
  rate numeric,
  total numeric,
  payment_status text,
  status text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    b.ref,
    b.court_id,
    b.court_name,
    b.date,
    b.slots,
    b.start_time,
    b.end_time,
    b.duration,
    b.rate,
    b.total,
    b.payment_status,
    b.status,
    b.created_at
  from public.bookings b
  where coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), '')) = 'anon'
    and length(coalesce(p_access_token, '')) between 32 and 256
    and b.ref = trim(coalesce(p_ref, ''))
    and b.customer_access_token_hash = encode(extensions.digest(p_access_token, 'sha256'), 'hex')
  limit 1
$$;

-- --------------------------------------------------------------------------
-- Token-authorized anonymous hold finalization
-- --------------------------------------------------------------------------

create or replace function public.update_public_booking_hold(
  p_ref text,
  p_access_token text,
  p_updates jsonb
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.bookings%rowtype;
  requested_key text;
  token_hash text;
  requested_downpayment numeric;
  effective_payment_method text;
begin
  if coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), '')) <> 'anon' then
    raise exception 'This endpoint is only for anonymous customer holds.' using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(p_updates, '{}'::jsonb)) <> 'object' then
    raise exception 'Booking updates must be a JSON object.' using errcode = '22023';
  end if;

  if length(coalesce(p_access_token, '')) < 32
     or length(coalesce(p_access_token, '')) > 256 then
    raise exception 'Booking access token is invalid.' using errcode = '42501';
  end if;

  for requested_key in
    select jsonb_object_keys(coalesce(p_updates, '{}'::jsonb))
  loop
    if requested_key <> all(array[
      'full_name',
      'contact_number',
      'email',
      'payment_method',
      'payment_flow',
      'gcash_ref',
      'downpayment',
      'payment_status',
      'status'
    ]) then
      raise exception 'Booking field % cannot be updated by a public client.', requested_key
        using errcode = '42501';
    end if;
  end loop;

  token_hash := encode(extensions.digest(p_access_token, 'sha256'), 'hex');

  select b.*
    into target
    from public.bookings b
   where b.ref = trim(coalesce(p_ref, ''))
   for update;

  if not found
     or target.customer_access_token_hash is null
     or target.customer_access_token_hash <> token_hash then
    raise exception 'Booking hold was not found or the access token is invalid.' using errcode = '42501';
  end if;

  if target.status <> 'verifying'
     or target.created_at is null
     or target.created_at <= now() - interval '15 minutes'
     or coalesce(target.host_booking, false)
     or target.host_user_id is not null
     or target.created_via <> 'customer'
     or target.created_by_user_id is not null then
    raise exception 'Booking hold has expired or cannot be changed by this client.' using errcode = '42501';
  end if;

  if p_updates ? 'full_name' and (
    nullif(trim(coalesce(p_updates->>'full_name', '')), '') is null
    or length(trim(p_updates->>'full_name')) > 150
  ) then
    raise exception 'A valid customer name is required.' using errcode = '22023';
  end if;

  if length(coalesce(p_updates->>'contact_number', '')) > 40
     or length(coalesce(p_updates->>'email', '')) > 254
     or length(coalesce(p_updates->>'gcash_ref', '')) > 100 then
    raise exception 'Booking contact or payment reference is too long.' using errcode = '22023';
  end if;

  if p_updates ? 'payment_method'
     and lower(coalesce(p_updates->>'payment_method', '')) not in
       ('cash', 'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb') then
    raise exception 'Unsupported payment method.' using errcode = '22023';
  end if;

  effective_payment_method := lower(coalesce(
    nullif(p_updates->>'payment_method', ''),
    target.payment_method,
    'cash'
  ));
  if not public.public_payment_method_ready(effective_payment_method) then
    raise exception 'This payment method is not currently enabled.' using errcode = '23514';
  end if;

  if p_updates ? 'downpayment' then
    if coalesce(p_updates->>'downpayment', '') !~ '^[0-9]+([.][0-9]{1,2})?$' then
      raise exception 'The requested payment amount is invalid.' using errcode = '22023';
    end if;
    requested_downpayment := (p_updates->>'downpayment')::numeric;
    if not (
      abs(requested_downpayment - target.total) <= 0.01
      or abs(requested_downpayment - (target.total / 2)) <= 0.01
      or abs(requested_downpayment - round(target.total / 2)) <= 0.01
      or abs(
        requested_downpayment - round(
          least(greatest(coalesce(target.booking_fee_amount_snapshot, 0), 0), target.total)
          + ((target.total - least(greatest(coalesce(target.booking_fee_amount_snapshot, 0), 0), target.total)) * 0.50),
          2
        )
      ) <= 0.01
    ) then
      raise exception 'The requested payment amount is invalid.' using errcode = '22023';
    end if;
  end if;

  if p_updates ? 'status'
     and coalesce(p_updates->>'status', '') not in ('verifying', 'pending', 'cancelled') then
    raise exception 'Booking status cannot be approved by a public client.' using errcode = '42501';
  end if;

  if p_updates ? 'payment_status'
     and coalesce(p_updates->>'payment_status', '') not in
       ('unpaid', 'pending', 'for_verification', 'rejected') then
    raise exception 'Payment status cannot be approved by a public client.' using errcode = '42501';
  end if;

  if coalesce(p_updates->>'status', target.status) = 'pending'
     and effective_payment_method <> 'cash'
     and target.receipt_image_url is null then
    raise exception 'A digital booking cannot become pending before its receipt is stored.' using errcode = '42501';
  end if;

  update public.bookings b
     set full_name = case
           when p_updates ? 'full_name' then trim(p_updates->>'full_name')
           else b.full_name
         end,
         contact_number = case
           when p_updates ? 'contact_number' then nullif(trim(p_updates->>'contact_number'), '')
           else b.contact_number
         end,
         email = case
           when p_updates ? 'email' then nullif(trim(p_updates->>'email'), '')
           else b.email
         end,
         payment_method = case
           when p_updates ? 'payment_method' then lower(p_updates->>'payment_method')
           else b.payment_method
         end,
         received_account = case
           when p_updates ? 'payment_method' then
             case when lower(p_updates->>'payment_method') = 'cash' then 'cash' else 'gcash' end
           else b.received_account
         end,
         payment_flow = case
           when p_updates ? 'payment_flow' then
             case
               when nullif(trim(p_updates->>'payment_flow'), '') is null then null
               when p_updates ? 'payment_method' then lower(p_updates->>'payment_method')
               else b.payment_method
             end
           else b.payment_flow
         end,
         gcash_ref = case
           when p_updates ? 'gcash_ref' then nullif(trim(p_updates->>'gcash_ref'), '')
           else b.gcash_ref
         end,
         downpayment = case
           when p_updates ? 'downpayment' then (p_updates->>'downpayment')::numeric
           else b.downpayment
         end,
         payment_status = case
           when p_updates ? 'payment_status' then p_updates->>'payment_status'
           else b.payment_status
         end,
         status = case
           when p_updates ? 'status' then p_updates->>'status'
           else b.status
         end
   where b.ref = target.ref
   returning b.* into target;

  return target.ref;
end;
$$;

-- --------------------------------------------------------------------------
-- Canonical public open-play registrations
-- --------------------------------------------------------------------------

create or replace function public.prepare_public_open_play_registration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  is_public_submission boolean :=
    coalesce(current_setting('paddle_rage.public_open_play_registration', true), '') = 'on'
    or request_role = 'anon'
    or (
      request_role = 'authenticated'
      and public.current_account_role() = 'host'
    );
  authoritative_court_name text;
  court_blocked boolean;
  requested_receipt_status text := lower(coalesce(new.receipt_status, 'none'));
  open_play_config_text text;
  open_play_config jsonb;
  configured_days jsonb;
  configured_dates jsonb;
  configured_courts jsonb;
  session_start integer;
  session_end integer;
  open_play_fee_text text;
  open_play_fee numeric := 100;
  service_fee_text text;
  service_fee numeric := 0;
  payment_acceptance_mode text;
  canonical_payment_type text;
  canonical_total numeric;
  configured_max_players integer := 40;
  active_registrations integer;
  ph_now timestamp := timezone('Asia/Manila', now());
begin
  if not is_public_submission then
    return new;
  end if;

  if nullif(trim(coalesce(new.full_name, '')), '') is null
     or length(trim(new.full_name)) > 150 then
    raise exception 'A valid player name is required.' using errcode = '22023';
  end if;

  if new.date is null
     or new.date < current_date
     or new.date > current_date + 366 then
    raise exception 'Open-play date or time is invalid.' using errcode = '22023';
  end if;

  select s.value
    into open_play_config_text
    from public.settings s
   where s.key = 'open_play_config'
   limit 1;

  begin
    open_play_config := open_play_config_text::jsonb;
  exception when others then
    open_play_config := null;
  end;

  if open_play_config is null
     or jsonb_typeof(open_play_config) <> 'object'
     or lower(coalesce(open_play_config->>'enabled', 'false')) not in ('true', '1') then
    raise exception 'Open Play is not currently accepting registrations.' using errcode = '23514';
  end if;

  if trim(coalesce(open_play_config->>'start', '')) !~ '^[0-9]+$'
     or trim(coalesce(open_play_config->>'end', '')) !~ '^[0-9]+$' then
    raise exception 'Open-play schedule is not configured correctly.' using errcode = '23514';
  end if;

  session_start := trim(open_play_config->>'start')::integer;
  session_end := trim(open_play_config->>'end')::integer;
  if session_start < 0
     or session_start > 23
     or session_end < 1
     or session_end > 24
     or session_end <= session_start
     or new.hour is distinct from session_start then
    raise exception 'This is not an active Open Play session.' using errcode = '23514';
  end if;

  configured_days := case
    when jsonb_typeof(open_play_config->'days') = 'array' then open_play_config->'days'
    else '[]'::jsonb
  end;
  configured_dates := case
    when jsonb_typeof(open_play_config->'specificDates') = 'array' then open_play_config->'specificDates'
    else '[]'::jsonb
  end;
  configured_courts := case
    when jsonb_typeof(open_play_config->'courtIds') = 'array' then open_play_config->'courtIds'
    else '[]'::jsonb
  end;

  if not (
    exists (
      select 1
        from jsonb_array_elements_text(configured_days) day_value
       where day_value.value ~ '^[0-6]$'
         and day_value.value::integer = extract(dow from new.date)::integer
    )
    or exists (
      select 1
        from jsonb_array_elements_text(configured_dates) date_value
       where date_value.value = new.date::text
    )
  ) then
    raise exception 'Open Play is not enabled on this date.' using errcode = '23514';
  end if;

  if jsonb_array_length(configured_courts) > 0
     and not exists (
       select 1
         from jsonb_array_elements_text(configured_courts) court_value
        where court_value.value = new.court_id
     ) then
    raise exception 'This court is not enabled for Open Play.' using errcode = '23514';
  end if;

  if new.date = ph_now::date
     and session_end <= extract(hour from ph_now) then
    raise exception 'This Open Play session has already ended.' using errcode = '23514';
  end if;

  select c.name, c.blocked
    into authoritative_court_name, court_blocked
    from public.courts c
   where c.id = new.court_id
   limit 1;

  if not found then
    raise exception 'Open-play court was not found.' using errcode = '22023';
  end if;
  if coalesce(court_blocked, false) then
    raise exception 'This court is not currently available.' using errcode = '22023';
  end if;

  if lower(coalesce(new.payment_method, 'cash')) not in
     ('cash', 'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb') then
    raise exception 'Unsupported payment method.' using errcode = '22023';
  end if;

  new.payment_method := lower(coalesce(new.payment_method, 'cash'));
  if not public.public_payment_method_ready(new.payment_method) then
    raise exception 'This payment method is not currently enabled.' using errcode = '23514';
  end if;

  select s.value
    into payment_acceptance_mode
    from public.settings s
   where s.key = 'payment_acceptance_mode'
   limit 1;
  payment_acceptance_mode := lower(trim(coalesce(payment_acceptance_mode, 'both')));
  canonical_payment_type := case payment_acceptance_mode
    when 'downpayment_only' then '50%'
    when 'full_payment_only' then '100%'
    else new.payment_type
  end;
  if coalesce(canonical_payment_type, '') not in ('50%', '100%') then
    raise exception 'Open-play payment type is invalid.' using errcode = '22023';
  end if;

  if length(coalesce(new.gcash_ref, '')) > 100
     or length(coalesce(new.time_label, '')) > 100 then
    raise exception 'Open-play payment reference or time label is too long.' using errcode = '22023';
  end if;

  if lower(coalesce(new.payment_method, 'cash')) <> 'cash' then
    if nullif(trim(coalesce(new.gcash_ref, '')), '') is null then
      raise exception 'A payment reference is required.' using errcode = '22023';
    end if;
    if new.receipt_image_url is null
       or new.receipt_image_url !~ '^[A-Za-z0-9._-]+/[0-9a-fA-F]{64}[.](jpg|jpeg|png|webp)$' then
      raise exception 'A verified receipt upload path is required.' using errcode = '22023';
    end if;
    if not exists (
      select 1
        from storage.objects receipt_object
       where receipt_object.bucket_id = 'receipts'
         and receipt_object.name = new.receipt_image_url
    ) then
      raise exception 'The uploaded receipt could not be found.' using errcode = 'P0002';
    end if;
    perform pg_advisory_xact_lock(
      hashtextextended('paddle-rage-public-receipt-path:' || new.receipt_image_url, 0)
    );
    if exists (
      select 1 from public.bookings b
       where b.receipt_image_url = new.receipt_image_url
      union all
      select 1 from public.open_play_registrations r
       where r.receipt_image_url = new.receipt_image_url
      union all
      select 1 from public.open_play_host_session_registrations hr
       where hr.receipt_image_url = new.receipt_image_url
    ) then
      raise exception 'This receipt upload has already been used.' using errcode = '23505';
    end if;
  end if;

  open_play_fee_text := open_play_config->>'fee';
  if trim(coalesce(open_play_fee_text, '')) !~ '^[0-9]+([.][0-9]+)?$' then
    select s.value
      into open_play_fee_text
      from public.settings s
     where s.key = 'open_play_fee'
     limit 1;
  end if;
  if trim(coalesce(open_play_fee_text, '')) ~ '^[0-9]+([.][0-9]+)?$' then
    open_play_fee := trim(open_play_fee_text)::numeric;
  end if;
  if open_play_fee < 0 or open_play_fee > 10000 then
    raise exception 'Open-play fee configuration is invalid.' using errcode = '23514';
  end if;

  select s.value
    into service_fee_text
    from public.settings s
   where s.key in ('maintenance_fee', 'service_fee_rate', 'booking_fee')
     and s.value is not null
   order by case s.key
     when 'maintenance_fee' then 1
     when 'service_fee_rate' then 2
     else 3
   end
   limit 1;
  if trim(coalesce(service_fee_text, '')) ~ '^[0-9]+([.][0-9]+)?$' then
    service_fee := trim(service_fee_text)::numeric;
  end if;
  if service_fee < 0 or service_fee > 10000 then
    raise exception 'Open-play service fee configuration is invalid.' using errcode = '23514';
  end if;

  if trim(coalesce(open_play_config->>'maxPlayers', '')) ~ '^[0-9]+$' then
    configured_max_players := trim(open_play_config->>'maxPlayers')::integer;
  end if;
  if configured_max_players < 1 or configured_max_players > 1000 then
    raise exception 'Open-play capacity configuration is invalid.' using errcode = '23514';
  end if;

  canonical_total := round(open_play_fee + service_fee, 2);
  new.payment_type := canonical_payment_type;
  new.amount := case
    when canonical_payment_type = '100%' then canonical_total
    else round(canonical_total / 2, 2)
  end;

  -- Serialize all registrations for one court/date before checking capacity.
  -- Rejected browser pre-checks are retained for audit but never consume space.
  if requested_receipt_status <> 'rejected' then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'paddle-rage-open-play-registration:' || new.date::text || ':' || new.court_id,
        0
      )
    );
    select count(*)::integer
      into active_registrations
      from public.open_play_registrations existing
     where existing.date = new.date
       and existing.court_id = new.court_id
       and coalesce(existing.payment_status, 'pending') <> 'rejected';
    if active_registrations >= configured_max_players then
      raise exception 'This Open Play session is already full.' using errcode = '23514';
    end if;
  end if;

  new.full_name := trim(new.full_name);
  new.court_name := authoritative_court_name;
  new.hour := session_start;
  new.time_label := format(
    '%s:00 %s - %s:00 %s',
    case when session_start % 12 = 0 then 12 else session_start % 12 end,
    case when session_start < 12 then 'AM' else 'PM' end,
    case when session_end % 12 = 0 then 12 else session_end % 12 end,
    case when (session_end % 24) < 12 then 'AM' else 'PM' end
  );
  new.created_at := clock_timestamp();

  -- A browser may report that its pre-check rejected a receipt; that state
  -- cannot consume capacity or approve money. Every other digital receipt is
  -- deliberately queued for trusted/manual review.
  if requested_receipt_status = 'rejected' then
    new.payment_status := 'rejected';
    new.receipt_status := 'rejected';
  elsif new.payment_method = 'cash' then
    new.payment_status := 'pending';
    new.receipt_status := 'none';
    new.receipt_image_url := null;
  else
    new.payment_status := 'pending';
    new.receipt_status := 'manual_review';
  end if;

  -- OCR conclusions are server-owned. Preserve only the private object path;
  -- a trusted verifier/admin can later attach authoritative evidence.
  new.receipt_image_hash := null;
  new.receipt_phash := null;
  new.receipt_flags := '{}'::text[];
  new.receipt_extracted := null;
  new.receipt_confidence := null;
  new.receipt_verified_at := null;

  return new;
end;
$$;

drop trigger if exists a00_prepare_public_open_play_registration
  on public.open_play_registrations;
create trigger a00_prepare_public_open_play_registration
before insert on public.open_play_registrations
for each row execute function public.prepare_public_open_play_registration();

create or replace function public.submit_public_open_play_registration(
  p_full_name text,
  p_court_id text,
  p_date date,
  p_hour integer,
  p_payment_type text,
  p_payment_method text,
  p_gcash_ref text,
  p_receipt_image_url text,
  p_client_receipt_status text default 'none'
)
returns table (
  id bigint,
  court_id text,
  court_name text,
  date date,
  hour integer,
  time_label text,
  payment_type text,
  payment_method text,
  payment_status text,
  amount numeric,
  receipt_status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted public.open_play_registrations%rowtype;
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
begin
  if request_role <> 'service_role' then
    raise exception 'Public open-play registration must pass through the protected registration service.' using errcode = '42501';
  end if;

  -- Authenticated operators may also use the public booking page. Mark this
  -- insert so the trigger applies the same canonical public-payment rules.
  perform set_config('paddle_rage.public_open_play_registration', 'on', true);

  insert into public.open_play_registrations (
    full_name,
    court_id,
    date,
    hour,
    time_label,
    payment_type,
    payment_method,
    gcash_ref,
    payment_status,
    amount,
    receipt_image_url,
    receipt_status
  ) values (
    p_full_name,
    p_court_id,
    p_date,
    p_hour,
    null,
    p_payment_type,
    p_payment_method,
    p_gcash_ref,
    'pending',
    0,
    p_receipt_image_url,
    p_client_receipt_status
  )
  returning * into inserted;

  return query
  select
    inserted.id,
    inserted.court_id,
    inserted.court_name,
    inserted.date,
    inserted.hour,
    inserted.time_label,
    inserted.payment_type,
    inserted.payment_method,
    inserted.payment_status,
    inserted.amount,
    inserted.receipt_status,
    inserted.created_at;
end;
$$;

create or replace function public.get_public_open_play_counts(
  p_date date,
  p_court_id text default null
)
returns table (
  court_id text,
  registration_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.court_id, count(*)::bigint as registration_count
    from public.open_play_registrations r
   where p_date is not null
     and p_date >= current_date - 1
     and p_date <= current_date + 366
     and r.date = p_date
     and (nullif(trim(coalesce(p_court_id, '')), '') is null or r.court_id = p_court_id)
     and coalesce(r.payment_status, 'pending') <> 'rejected'
   group by r.court_id
   order by r.court_id
$$;

-- --------------------------------------------------------------------------
-- Host-created Open Play: authoritative public registration
-- --------------------------------------------------------------------------

create or replace function public.prepare_public_host_session_registration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  is_public_submission boolean :=
    coalesce(current_setting('paddle_rage.public_host_session_registration', true), '') = 'on'
    or request_role = 'anon';
  target_session public.open_play_host_sessions%rowtype;
  active_registrations integer;
  requested_receipt_status text := lower(coalesce(new.receipt_status, 'none'));
  ph_now timestamp := timezone('Asia/Manila', now());
begin
  if not is_public_submission then
    return new;
  end if;

  if nullif(trim(coalesce(new.full_name, '')), '') is null
     or length(trim(new.full_name)) > 150
     or length(coalesce(new.contact_number, '')) > 40
     or length(coalesce(new.gcash_ref, '')) > 100 then
    raise exception 'Host-session registration details are invalid.' using errcode = '22023';
  end if;

  if new.session_id is null then
    raise exception 'A host session is required.' using errcode = '22023';
  end if;

  -- Registration and capacity evaluation for one session are serialized.
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-host-session-registration:' || new.session_id::text, 0)
  );

  select s.*
    into target_session
    from public.open_play_host_sessions s
   where s.id = new.session_id
   for share;

  if not found or target_session.status <> 'published' then
    raise exception 'This host session is not accepting registrations.' using errcode = '22023';
  end if;

  if target_session.date < ph_now::date
     or (
       target_session.date = ph_now::date
       and target_session.end_hour <= extract(hour from ph_now)
     ) then
    raise exception 'This host session has already ended.' using errcode = '22023';
  end if;

  if target_session.fee_per_player <= 0 or requested_receipt_status <> 'rejected' then
    select count(*)::integer
      into active_registrations
      from public.open_play_host_session_registrations r
     where r.session_id = target_session.id
       and coalesce(r.payment_status, 'pending') <> 'rejected';

    if active_registrations >= target_session.max_players then
      raise exception 'This host session is already full.' using errcode = '23514';
    end if;
  end if;

  new.full_name := trim(new.full_name);
  new.amount := target_session.fee_per_player;
  new.created_at := clock_timestamp();
  new.updated_at := new.created_at;

  if target_session.fee_per_player <= 0 then
    new.payment_method := 'cash';
    new.gcash_ref := null;
    new.payment_status := 'paid';
    new.receipt_image_url := null;
    new.receipt_status := 'none';
  else
    new.payment_method := lower(coalesce(new.payment_method, ''));
    if new.payment_method not in ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb') then
      raise exception 'A supported digital payment method is required.' using errcode = '22023';
    end if;
    if not public.public_payment_method_ready(new.payment_method) then
      raise exception 'This payment method is not currently enabled.' using errcode = '23514';
    end if;
    if nullif(trim(coalesce(new.gcash_ref, '')), '') is null then
      raise exception 'A payment reference is required.' using errcode = '22023';
    end if;
    if new.receipt_image_url is null
       or new.receipt_image_url !~ '^[A-Za-z0-9._-]+/[0-9a-fA-F]{64}[.](jpg|jpeg|png|webp)$' then
      raise exception 'A verified receipt upload path is required.' using errcode = '22023';
    end if;
    if not exists (
      select 1
        from storage.objects receipt_object
       where receipt_object.bucket_id = 'receipts'
         and receipt_object.name = new.receipt_image_url
    ) then
      raise exception 'The uploaded receipt could not be found.' using errcode = 'P0002';
    end if;
    perform pg_advisory_xact_lock(
      hashtextextended('paddle-rage-public-receipt-path:' || new.receipt_image_url, 0)
    );
    if exists (
      select 1 from public.bookings b
       where b.receipt_image_url = new.receipt_image_url
      union all
      select 1 from public.open_play_registrations r
       where r.receipt_image_url = new.receipt_image_url
      union all
      select 1 from public.open_play_host_session_registrations hr
       where hr.receipt_image_url = new.receipt_image_url
    ) then
      raise exception 'This receipt upload has already been used.' using errcode = '23505';
    end if;

    if requested_receipt_status = 'rejected' then
      new.payment_status := 'rejected';
      new.receipt_status := 'rejected';
    else
      -- Browser-supplied OCR conclusions can never approve a payment.
      new.payment_status := 'pending';
      new.receipt_status := 'manual_review';
    end if;
  end if;

  new.receipt_image_hash := null;
  new.receipt_phash := null;
  new.receipt_flags := '{}'::text[];
  new.receipt_extracted := null;
  new.receipt_confidence := null;
  new.receipt_verified_at := null;

  return new;
end;
$$;

drop trigger if exists a00_prepare_public_host_session_registration
  on public.open_play_host_session_registrations;
create trigger a00_prepare_public_host_session_registration
before insert on public.open_play_host_session_registrations
for each row execute function public.prepare_public_host_session_registration();

create or replace function public.submit_public_host_session_registration(
  p_session_id uuid,
  p_full_name text,
  p_contact_number text,
  p_payment_method text,
  p_gcash_ref text,
  p_receipt_image_url text,
  p_client_receipt_status text default 'none'
)
returns table (
  id uuid,
  session_id uuid,
  payment_status text,
  amount numeric,
  receipt_status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted public.open_play_host_session_registrations%rowtype;
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
begin
  if request_role <> 'service_role' then
    raise exception 'Public host-session registration must pass through the protected registration service.' using errcode = '42501';
  end if;

  perform set_config('paddle_rage.public_host_session_registration', 'on', true);

  insert into public.open_play_host_session_registrations (
    session_id,
    full_name,
    contact_number,
    payment_method,
    gcash_ref,
    payment_status,
    amount,
    receipt_image_url,
    receipt_status
  ) values (
    p_session_id,
    p_full_name,
    p_contact_number,
    p_payment_method,
    p_gcash_ref,
    'pending',
    0,
    p_receipt_image_url,
    p_client_receipt_status
  )
  returning * into inserted;

  return query
  select
    inserted.id,
    inserted.session_id,
    inserted.payment_status,
    inserted.amount,
    inserted.receipt_status,
    inserted.created_at;
end;
$$;

create or replace function public.count_open_play_host_session_registrations(p_session_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
    from public.open_play_host_session_registrations r
    join public.open_play_host_sessions s on s.id = r.session_id
   where r.session_id = p_session_id
     and s.status = 'published'
     and coalesce(r.payment_status, 'pending') <> 'rejected'
$$;

create or replace function public.get_public_open_play_host_sessions(
  p_session_id uuid default null
)
returns table (
  id uuid,
  host_name text,
  title text,
  date date,
  start_hour integer,
  end_hour integer,
  court_ids text[],
  court_names text[],
  max_players integer,
  fee_per_player numeric,
  status text,
  notes text,
  payment_instructions text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.id,
    s.host_name,
    s.title,
    s.date,
    s.start_hour,
    s.end_hour,
    s.court_ids,
    s.court_names,
    s.max_players,
    s.fee_per_player,
    s.status,
    s.notes,
    s.payment_instructions,
    s.created_at,
    s.updated_at
  from public.open_play_host_sessions s
  where s.status = 'published'
    and s.date >= current_date
    and s.date <= current_date + 366
    and (p_session_id is null or s.id = p_session_id)
  order by s.date, s.start_hour
$$;

create or replace function public.claim_booking_reference_when_settled()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  method_value text := lower(coalesce(nullif(trim(new.payment_method), ''), 'cash'));
  owner_scope text := case
    when nullif(trim(coalesce(new.booking_group_ref, '')), '') is not null
      then 'booking_group'
    else 'booking'
  end;
  owner_id text := coalesce(
    nullif(trim(coalesce(new.booking_group_ref, '')), ''),
    new.ref
  );
begin
  if new.payment_status not in ('paid', 'downpayment_paid', 'deposit_retained')
     or method_value = 'cash' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.payment_status in ('paid', 'downpayment_paid', 'deposit_retained')
     and lower(coalesce(nullif(trim(old.payment_method), ''), 'cash')) = method_value
     and old.gcash_ref is not distinct from new.gcash_ref
     and old.booking_group_ref is not distinct from new.booking_group_ref then
    return new;
  end if;

  perform public.claim_payment_reference(
    method_value,
    new.gcash_ref,
    owner_scope,
    owner_id,
    new.ref
  );
  return new;
end;
$$;

drop trigger if exists z90_claim_booking_reference_when_settled
  on public.bookings;
create trigger z90_claim_booking_reference_when_settled
before insert or update of payment_status, payment_method, gcash_ref, booking_group_ref
on public.bookings
for each row execute function public.claim_booking_reference_when_settled();

create or replace function public.claim_open_play_reference_when_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  method_value text := lower(coalesce(nullif(trim(new.payment_method), ''), 'cash'));
begin
  if new.payment_status <> 'paid' or method_value = 'cash' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.payment_status = 'paid'
     and lower(coalesce(nullif(trim(old.payment_method), ''), 'cash')) = method_value
     and old.gcash_ref is not distinct from new.gcash_ref then
    return new;
  end if;

  perform public.claim_payment_reference(
    method_value,
    new.gcash_ref,
    'open_play',
    new.id::text,
    'op:' || new.id::text
  );
  return new;
end;
$$;

drop trigger if exists z90_claim_open_play_reference_when_paid
  on public.open_play_registrations;
create trigger z90_claim_open_play_reference_when_paid
before insert or update of payment_status, payment_method, gcash_ref
on public.open_play_registrations
for each row execute function public.claim_open_play_reference_when_paid();

create or replace function public.claim_host_session_reference_when_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  method_value text := lower(coalesce(nullif(trim(new.payment_method), ''), 'cash'));
begin
  if new.payment_status <> 'paid' or method_value = 'cash' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.payment_status = 'paid'
     and lower(coalesce(nullif(trim(old.payment_method), ''), 'cash')) = method_value
     and old.gcash_ref is not distinct from new.gcash_ref then
    return new;
  end if;

  perform public.claim_payment_reference(
    method_value,
    new.gcash_ref,
    'host_session',
    new.id::text,
    'hs:' || new.id::text
  );
  return new;
end;
$$;

drop trigger if exists z90_claim_host_session_reference_when_paid
  on public.open_play_host_session_registrations;
create trigger z90_claim_host_session_reference_when_paid
before insert or update of payment_status, payment_method, gcash_ref
on public.open_play_host_session_registrations
for each row execute function public.claim_host_session_reference_when_paid();

-- Backfill ledger ownership in deterministic flow order. Existing booking
-- claims win; any duplicate paid row aborts the migration for manual review
-- instead of silently overwriting the incumbent financial owner.
do $$
declare
  claim_row record;
begin
  for claim_row in
    select
      b.ref,
      b.booking_group_ref,
      b.payment_method,
      b.gcash_ref
    from public.bookings b
    where b.payment_status in ('paid', 'downpayment_paid', 'deposit_retained')
      and lower(coalesce(b.payment_method, 'cash')) in
        ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb')
      and nullif(trim(coalesce(b.gcash_ref, '')), '') is not null
    order by b.created_at, b.ref
  loop
    perform public.claim_payment_reference(
      claim_row.payment_method,
      claim_row.gcash_ref,
      case
        when nullif(trim(coalesce(claim_row.booking_group_ref, '')), '') is not null
          then 'booking_group'
        else 'booking'
      end,
      coalesce(
        nullif(trim(coalesce(claim_row.booking_group_ref, '')), ''),
        claim_row.ref
      ),
      claim_row.ref
    );
  end loop;

  for claim_row in
    select r.id, r.payment_method, r.gcash_ref
    from public.open_play_registrations r
    where r.payment_status = 'paid'
      and lower(coalesce(r.payment_method, 'cash')) in
        ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb')
      and nullif(trim(coalesce(r.gcash_ref, '')), '') is not null
    order by r.created_at, r.id
  loop
    perform public.claim_payment_reference(
      claim_row.payment_method,
      claim_row.gcash_ref,
      'open_play',
      claim_row.id::text,
      'op:' || claim_row.id::text
    );
  end loop;

  for claim_row in
    select r.id, r.payment_method, r.gcash_ref
    from public.open_play_host_session_registrations r
    where r.payment_status = 'paid'
      and lower(coalesce(r.payment_method, 'cash')) in
        ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb')
      and nullif(trim(coalesce(r.gcash_ref, '')), '') is not null
    order by r.created_at, r.id
  loop
    perform public.claim_payment_reference(
      claim_row.payment_method,
      claim_row.gcash_ref,
      'host_session',
      claim_row.id::text,
      'hs:' || claim_row.id::text
    );
  end loop;
end;
$$;

-- --------------------------------------------------------------------------
-- RLS: private rows for operators; non-PII availability for the public
-- --------------------------------------------------------------------------

alter table public.bookings enable row level security;
alter table public.open_play_registrations enable row level security;
alter table public.receipt_verifications enable row level security;
alter table public.open_play_host_sessions enable row level security;
alter table public.open_play_host_session_registrations enable row level security;

drop policy if exists bookings_select_public on public.bookings;
drop policy if exists bookings_select_public_availability on public.bookings;

drop policy if exists bookings_select_dashboard_roles on public.bookings;
create policy bookings_select_dashboard_roles
  on public.bookings
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner', 'staff']));

drop policy if exists bookings_select_host_own on public.bookings;
create policy bookings_select_host_own
  on public.bookings
  for select
  to authenticated
  using (
    public.current_account_role() = 'host'
    and coalesce(host_booking, false)
    and (host_user_id = auth.uid() or created_by_user_id = auth.uid())
  );

drop policy if exists bookings_insert_public on public.bookings;

-- Direct anonymous UPDATE is intentionally removed. The RPC above checks the
-- per-booking token, locks the target row, and permits only customer fields.
drop policy if exists bookings_update_public_hold on public.bookings;

drop policy if exists open_play_select_public on public.open_play_registrations;
drop policy if exists open_play_select_public_capacity on public.open_play_registrations;
create policy open_play_select_public_capacity
  on public.open_play_registrations
  for select
  to anon
  using (
    date >= current_date - 1
    and date <= current_date + 366
    and coalesce(payment_status, 'pending') <> 'rejected'
  );

drop policy if exists open_play_select_dashboard_roles on public.open_play_registrations;
create policy open_play_select_dashboard_roles
  on public.open_play_registrations
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner', 'staff']));

-- Anonymous writes go through submit_public_open_play_registration so callers
-- receive the canonical saved status and cannot pass server-owned OCR fields.
drop policy if exists open_play_insert_public on public.open_play_registrations;

drop policy if exists open_play_insert_dashboard_roles on public.open_play_registrations;
create policy open_play_insert_dashboard_roles
  on public.open_play_registrations
  for insert
  to authenticated
  with check (public.has_account_role(array['owner', 'court_owner', 'staff']));

drop policy if exists open_play_insert_host_public on public.open_play_registrations;
create policy open_play_insert_host_public
  on public.open_play_registrations
  for insert
  to authenticated
  with check (
    public.current_account_role() = 'host'
    and date >= current_date
    and date <= current_date + 366
    and created_at > now() - interval '2 minutes'
    and created_at <= now() + interval '1 minute'
    and payment_status in ('pending', 'rejected')
    and receipt_status in ('none', 'manual_review', 'rejected')
    and receipt_extracted is null
    and receipt_confidence is null
    and receipt_verified_at is null
  );

drop policy if exists open_play_host_session_registrations_insert_public
  on public.open_play_host_session_registrations;
drop policy if exists open_play_host_session_registrations_insert_roles
  on public.open_play_host_session_registrations;
create policy open_play_host_session_registrations_insert_roles
  on public.open_play_host_session_registrations
  for insert
  to authenticated
  with check (
    public.has_account_role(array['owner', 'court_owner'])
    or exists (
      select 1
        from public.open_play_host_sessions s
       where s.id = session_id
         and public.current_account_role() = 'host'
         and s.host_user_id = auth.uid()
    )
  );

drop policy if exists open_play_host_sessions_select_public
  on public.open_play_host_sessions;
drop policy if exists open_play_host_sessions_select_dashboard_roles
  on public.open_play_host_sessions;
create policy open_play_host_sessions_select_dashboard_roles
  on public.open_play_host_sessions
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists open_play_host_sessions_select_host_own
  on public.open_play_host_sessions;
create policy open_play_host_sessions_select_host_own
  on public.open_play_host_sessions
  for select
  to authenticated
  using (
    public.current_account_role() = 'host'
    and host_user_id = auth.uid()
  );

drop policy if exists receipt_verifications_select_admin on public.receipt_verifications;
create policy receipt_verifications_select_admin
  on public.receipt_verifications
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner', 'staff']));

-- --------------------------------------------------------------------------
-- Table/function grants are part of the boundary. RLS limits rows; these
-- column grants prevent an anonymous PostgREST/realtime client from requesting
-- PII even for a row that is legitimately visible for availability.
-- --------------------------------------------------------------------------

revoke all on table public.bookings from public, anon;
grant select, insert, update, delete on table public.bookings to authenticated;

revoke all on table public.open_play_registrations from public, anon;
grant select (
  court_id,
  date,
  payment_status
) on public.open_play_registrations to anon;
grant select, insert, update, delete on table public.open_play_registrations to authenticated;

revoke all on table public.open_play_host_sessions from public, anon;
grant select, insert, update, delete on table public.open_play_host_sessions to authenticated;

revoke all on table public.open_play_host_session_registrations from public, anon;
grant select, insert, update on table public.open_play_host_session_registrations to authenticated;

-- Host applications are created only by the hostname/action-bound Turnstile
-- Edge Function. Keep review access for authenticated dashboard roles, but
-- remove the legacy browser-to-table insertion path for every client role.
drop policy if exists open_play_host_applications_insert_public
  on public.open_play_host_applications;
revoke insert on table public.open_play_host_applications
  from public, anon, authenticated;

revoke all on table public.receipt_verifications from public, anon, authenticated;
grant select on table public.receipt_verifications to authenticated;

revoke all on table public.used_gcash_refs from public, anon, authenticated;
revoke all on table public.notification_event_claims from public, anon, authenticated;

revoke all on function public.prepare_public_booking_insert()
  from public, anon, authenticated;
revoke all on function public.submit_public_booking_holds(jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_public_booking_holds(jsonb, text)
  to service_role;
revoke all on function public.prepare_payment_reference_ledger_owner()
  from public, anon, authenticated;
revoke all on function public.normalize_payment_reference_key(text, text)
  from public, anon, authenticated;
revoke all on function public.claim_payment_reference(text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.claim_booking_reference_when_settled()
  from public, anon, authenticated;
revoke all on function public.claim_open_play_reference_when_paid()
  from public, anon, authenticated;
revoke all on function public.claim_host_session_reference_when_paid()
  from public, anon, authenticated;
revoke all on function public.prepare_public_open_play_registration()
  from public, anon, authenticated;
revoke all on function public.prepare_public_host_session_registration()
  from public, anon, authenticated;
revoke all on function public.get_public_booking_availability(date, text)
  from public, anon, authenticated;
grant execute on function public.get_public_booking_availability(date, text)
  to anon, authenticated;
revoke all on function public.get_public_booking_by_ref(text, text)
  from public, anon, authenticated;
grant execute on function public.get_public_booking_by_ref(text, text)
  to anon;
revoke all on function public.get_public_open_play_counts(date, text)
  from public, anon, authenticated;
grant execute on function public.get_public_open_play_counts(date, text)
  to anon, authenticated;
revoke all on function public.submit_public_open_play_registration(text, text, date, integer, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_public_open_play_registration(text, text, date, integer, text, text, text, text, text)
  to service_role;
revoke all on function public.submit_public_host_session_registration(uuid, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_public_host_session_registration(uuid, text, text, text, text, text, text)
  to service_role;
revoke all on function public.count_open_play_host_session_registrations(uuid)
  from public, anon, authenticated;
grant execute on function public.count_open_play_host_session_registrations(uuid)
  to anon, authenticated;
revoke all on function public.get_public_open_play_host_sessions(uuid)
  from public, anon, authenticated;
grant execute on function public.get_public_open_play_host_sessions(uuid)
  to anon, authenticated;
revoke all on function public.update_public_booking_hold(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_public_booking_hold(text, text, jsonb)
  to anon;

notify pgrst, 'reload schema';

commit;
