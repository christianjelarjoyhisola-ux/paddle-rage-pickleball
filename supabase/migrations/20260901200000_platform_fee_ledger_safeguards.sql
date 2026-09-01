-- ============================================================================
-- Platform allocation ledger safeguards
--
-- * Pins the private allocation at PHP 10 per booked court-hour for new rows.
-- * Keeps historical booking snapshots untouched and immutable.
-- * Adds an owner-only, append-only credit/debit adjustment ledger for fees that
--   already reached a submitted/settled remittance.
-- * Applies unclaimed adjustments to the next exact-cutoff remittance only when
--   the net amount payable is positive; excess credit carries forward.
-- * Prevents an earned per-hour snapshot from being invalidated by a duration
--   change while still allowing a same-duration date/time reschedule.
-- * Excludes released booking rows from payable metrics while retaining explicit
--   released-row audit metrics.
-- ============================================================================

begin;

-- This changes only the policy used by future inserts. Existing immutable
-- booking_fee_*_snapshot values are deliberately not rewritten.
insert into public.settings (key, value, updated_at)
values
  ('maintenance_fee', '10', now()),
  ('fee_type', 'per_hour', now())
on conflict (key) do update
set value = excluded.value,
    updated_at = excluded.updated_at;

-- --------------------------------------------------------------------------
-- 1. Paid-duration safeguard
-- --------------------------------------------------------------------------

create or replace function public.guard_earned_booking_fee_units()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A same-duration move changes the slot values but not their count and is
  -- safe. A longer/shorter paid booking would make its immutable fee snapshot
  -- disagree with the reservation and must use an explicit adjustment instead.
  if coalesce(old.booking_fee_earned_at, new.booking_fee_earned_at) is not null
     and coalesce(old.booking_fee_type_snapshot, new.booking_fee_type_snapshot) = 'per_hour'
     and (
       coalesce(cardinality(new.slots), 0)
         is distinct from coalesce(cardinality(old.slots), 0)
       or new.duration is distinct from old.duration
     ) then
    raise exception
      'A paid booking cannot change duration or booked court-hours. Keep the same duration or record an auditable platform-fee adjustment.'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists z30_guard_earned_booking_fee_units on public.bookings;
create trigger z30_guard_earned_booking_fee_units
before update of slots, duration, status, payment_status on public.bookings
for each row execute function public.guard_earned_booking_fee_units();

revoke all on function public.guard_earned_booking_fee_units()
  from public, anon, authenticated;

comment on function public.guard_earned_booking_fee_units() is
  'Allows same-duration paid reschedules but blocks changes that would invalidate immutable per-court-hour platform allocation snapshots.';

-- --------------------------------------------------------------------------
-- 2. Permanent adjustment ledger and remittance applications
-- --------------------------------------------------------------------------

create table if not exists public.booking_fee_adjustments (
  id uuid primary key default gen_random_uuid(),
  adjustment_ref text not null unique,
  booking_ref text not null,
  booking_group_ref text,
  source_remittance_id uuid not null
    references public.booking_fee_remittances(id) on delete restrict,
  adjustment_type text not null,
  amount numeric(12,2) not null,
  reason text not null,
  source_fee_amount numeric(12,2) not null,
  source_fee_earned_at timestamptz not null,
  effective_at timestamptz not null,
  created_by_user_id uuid not null,
  created_by_email text,
  created_by_role text not null default 'owner',
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint booking_fee_adjustments_type_check
    check (adjustment_type in (
      'refund_credit',
      'duplicate_credit',
      'correction_credit',
      'correction_debit'
    )),
  constraint booking_fee_adjustments_amount_check
    check (
      amount <> 0
      and (
        (adjustment_type in ('refund_credit', 'duplicate_credit', 'correction_credit') and amount < 0)
        or (adjustment_type = 'correction_debit' and amount > 0)
      )
    ),
  constraint booking_fee_adjustments_source_amount_check
    check (source_fee_amount >= 0),
  constraint booking_fee_adjustments_reason_check
    check (length(trim(reason)) between 3 and 500),
  constraint booking_fee_adjustments_actor_check
    check (created_by_role = 'owner'),
  constraint booking_fee_adjustments_idempotency_check
    check (length(trim(idempotency_key)) between 8 and 128)
);

create unique index if not exists booking_fee_adjustments_idempotency_uq
  on public.booking_fee_adjustments (created_by_user_id, idempotency_key);
create index if not exists idx_booking_fee_adjustments_booking
  on public.booking_fee_adjustments (booking_ref, effective_at, id);
create index if not exists idx_booking_fee_adjustments_effective
  on public.booking_fee_adjustments (effective_at, id);

create table if not exists public.booking_fee_adjustment_applications (
  id uuid primary key default gen_random_uuid(),
  remittance_id uuid not null
    references public.booking_fee_remittances(id) on delete restrict,
  adjustment_id uuid not null
    references public.booking_fee_adjustments(id) on delete restrict,
  adjustment_ref text not null,
  booking_ref text not null,
  booking_group_ref text,
  source_remittance_id uuid not null
    references public.booking_fee_remittances(id) on delete restrict,
  adjustment_type text not null,
  amount numeric(12,2) not null,
  reason text not null,
  effective_at timestamptz not null,
  released_at timestamptz,
  released_by_user_id uuid,
  release_reason text,
  created_at timestamptz not null default now(),
  constraint booking_fee_adjustment_applications_amount_check
    check (amount <> 0),
  constraint booking_fee_adjustment_applications_type_check
    check (adjustment_type in (
      'refund_credit',
      'duplicate_credit',
      'correction_credit',
      'correction_debit'
    )),
  constraint booking_fee_adjustment_applications_release_check
    check (
      (released_at is null and released_by_user_id is null and release_reason is null)
      or (released_at is not null and release_reason is not null)
    )
);

create unique index if not exists booking_fee_adjustment_applications_active_uq
  on public.booking_fee_adjustment_applications (adjustment_id)
  where released_at is null;
create index if not exists idx_booking_fee_adjustment_applications_remittance
  on public.booking_fee_adjustment_applications (remittance_id, effective_at, id);

comment on table public.booking_fee_adjustments is
  'Append-only, system-owner-created signed corrections to an already submitted or settled booking-fee line. Credits are negative; debits are positive.';
comment on table public.booking_fee_adjustment_applications is
  'Immutable snapshots of adjustments applied to an exact-cutoff remittance. Release fields are used only when that remittance is cancelled.';

create or replace function public.prevent_booking_fee_adjustment_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Platform-fee adjustments are permanent and cannot be changed or deleted.'
    using errcode = '22000';
end;
$$;

drop trigger if exists trg_no_update_booking_fee_adjustments
  on public.booking_fee_adjustments;
create trigger trg_no_update_booking_fee_adjustments
before update on public.booking_fee_adjustments
for each row execute function public.prevent_booking_fee_adjustment_change();

drop trigger if exists trg_no_delete_booking_fee_adjustments
  on public.booking_fee_adjustments;
create trigger trg_no_delete_booking_fee_adjustments
before delete on public.booking_fee_adjustments
for each row execute function public.prevent_booking_fee_adjustment_change();

create or replace function public.guard_booking_fee_adjustment_application_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.remittance_id is distinct from old.remittance_id
     or new.adjustment_id is distinct from old.adjustment_id
     or new.adjustment_ref is distinct from old.adjustment_ref
     or new.booking_ref is distinct from old.booking_ref
     or new.booking_group_ref is distinct from old.booking_group_ref
     or new.source_remittance_id is distinct from old.source_remittance_id
     or new.adjustment_type is distinct from old.adjustment_type
     or new.amount is distinct from old.amount
     or new.reason is distinct from old.reason
     or new.effective_at is distinct from old.effective_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Applied platform-fee adjustment snapshots are immutable.'
      using errcode = '22000';
  end if;

  if old.released_at is not null and row(
       new.released_at, new.released_by_user_id, new.release_reason
     ) is distinct from row(
       old.released_at, old.released_by_user_id, old.release_reason
     ) then
    raise exception 'Released platform-fee adjustments cannot be changed.'
      using errcode = '22000';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_booking_fee_adjustment_application_update
  on public.booking_fee_adjustment_applications;
create trigger trg_guard_booking_fee_adjustment_application_update
before update on public.booking_fee_adjustment_applications
for each row execute function public.guard_booking_fee_adjustment_application_update();

drop trigger if exists trg_no_delete_booking_fee_adjustment_applications
  on public.booking_fee_adjustment_applications;
create trigger trg_no_delete_booking_fee_adjustment_applications
before delete on public.booking_fee_adjustment_applications
for each row execute function public.prevent_booking_fee_remittance_ledger_delete();

create or replace function public.release_booking_fee_adjustments_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update public.booking_fee_adjustment_applications a
       set released_at = coalesce(new.cancelled_at, clock_timestamp()),
           released_by_user_id = new.cancelled_by_user_id,
           release_reason = coalesce(
             nullif(trim(new.cancellation_reason), ''),
             'Remittance cancelled'
           )
     where a.remittance_id = new.id
       and a.released_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_release_booking_fee_adjustments_on_cancel
  on public.booking_fee_remittances;
create trigger trg_release_booking_fee_adjustments_on_cancel
after update of status on public.booking_fee_remittances
for each row execute function public.release_booking_fee_adjustments_on_cancel();

create or replace function public.booking_fee_unclaimed_adjustments()
returns table (
  adjustment_id uuid,
  adjustment_ref text,
  booking_ref text,
  booking_group_ref text,
  source_remittance_id uuid,
  adjustment_type text,
  amount numeric,
  reason text,
  effective_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    a.id,
    a.adjustment_ref,
    a.booking_ref,
    a.booking_group_ref,
    a.source_remittance_id,
    a.adjustment_type,
    a.amount,
    a.reason,
    a.effective_at
  from public.booking_fee_adjustments a
  where not exists (
    select 1
      from public.booking_fee_adjustment_applications x
     where x.adjustment_id = a.id
       and x.released_at is null
  )
  order by a.effective_at, a.id
$$;

revoke all on function public.prevent_booking_fee_adjustment_change()
  from public, anon, authenticated;
revoke all on function public.guard_booking_fee_adjustment_application_update()
  from public, anon, authenticated;
revoke all on function public.release_booking_fee_adjustments_on_cancel()
  from public, anon, authenticated;
revoke all on function public.booking_fee_unclaimed_adjustments()
  from public, anon, authenticated;

-- The caller supplies a positive magnitude; the server owns the sign so credit
-- and debit semantics cannot be accidentally reversed by a client.
create or replace function public.create_booking_fee_adjustment(
  p_booking_ref text,
  p_adjustment_type text,
  p_amount numeric,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  account_email text;
  booking_key text := trim(coalesce(p_booking_ref, ''));
  adjustment_kind text := lower(trim(coalesce(p_adjustment_type, '')));
  magnitude numeric := round(abs(coalesce(p_amount, 0)), 2);
  signed_amount numeric;
  source_item public.booking_fee_remittance_items%rowtype;
  source_group_ref text;
  prior_adjustments numeric := 0;
  adjustment_id uuid := gen_random_uuid();
  generated_ref text;
  effective_time timestamptz;
  existing public.booking_fee_adjustments%rowtype;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role <> 'owner' then
    raise exception 'Only the active system owner may create a platform-fee adjustment.'
      using errcode = '42501';
  end if;

  if booking_key = '' then
    raise exception 'A booking reference is required.' using errcode = '22023';
  end if;
  if adjustment_kind not in (
    'refund_credit',
    'duplicate_credit',
    'correction_credit',
    'correction_debit'
  ) then
    raise exception 'Unsupported platform-fee adjustment type.' using errcode = '22023';
  end if;
  if magnitude <= 0 then
    raise exception 'Adjustment amount must be greater than zero.' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'An adjustment reason between 3 and 500 characters is required.'
      using errcode = '22023';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 128 then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;

  signed_amount := case
    when adjustment_kind = 'correction_debit' then magnitude
    else -magnitude
  end;

  select a.* into existing
    from public.booking_fee_adjustments a
   where a.created_by_user_id = auth.uid()
     and a.idempotency_key = trim(p_idempotency_key)
   limit 1;
  if found then
    if existing.booking_ref <> booking_key
       or existing.adjustment_type <> adjustment_kind
       or existing.amount <> signed_amount
       or existing.reason <> trim(p_reason) then
      raise exception 'This idempotency key was already used for a different platform-fee adjustment.'
        using errcode = '22023';
    end if;
    return to_jsonb(existing);
  end if;

  -- Serialize adjustment effective times against exact remittance cutoffs.
  perform pg_advisory_xact_lock_shared(
    hashtextextended('paddle-rage-pickleball-booking-fee-remittance', 0)
  );

  -- Different idempotency keys for the same booking must not race past the
  -- cumulative over-credit check.
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-booking-fee-adjustment:' || booking_key, 0)
  );

  select i.*
    into source_item
    from public.booking_fee_remittance_items i
    join public.booking_fee_remittances r on r.id = i.remittance_id
   where i.booking_ref = booking_key
     and i.released_at is null
     and r.status in ('submitted', 'partially_settled', 'settled')
   order by r.prepared_at desc, i.created_at desc
   limit 1;
  if not found then
    raise exception
      'A platform-fee adjustment is allowed only after this booking fee reached a submitted or settled remittance. Cancel/void an unpaid prepared batch instead.'
      using errcode = '22023';
  end if;

  select coalesce(round(sum(a.amount), 2), 0)
    into prior_adjustments
    from public.booking_fee_adjustments a
   where a.booking_ref = booking_key;

  if round(source_item.fee_amount + prior_adjustments + signed_amount, 2) < 0 then
    raise exception
      'Credits for booking % cannot exceed its original platform allocation plus prior debit corrections.',
      booking_key
      using errcode = '22023';
  end if;

  select b.booking_group_ref into source_group_ref
    from public.bookings b
   where b.ref = booking_key
   limit 1;
  source_group_ref := coalesce(source_group_ref, source_item.booking_group_ref);

  select a.email into account_email
    from public.accounts a
   where a.id = auth.uid()
   limit 1;

  effective_time := clock_timestamp();
  generated_ref := 'ADJ-' || to_char(timezone('Asia/Manila', effective_time), 'YYYYMMDD') || '-' ||
    upper(substr(replace(adjustment_id::text, '-', ''), 1, 8));

  insert into public.booking_fee_adjustments (
    id,
    adjustment_ref,
    booking_ref,
    booking_group_ref,
    source_remittance_id,
    adjustment_type,
    amount,
    reason,
    source_fee_amount,
    source_fee_earned_at,
    effective_at,
    created_by_user_id,
    created_by_email,
    created_by_role,
    idempotency_key
  ) values (
    adjustment_id,
    generated_ref,
    booking_key,
    source_group_ref,
    source_item.remittance_id,
    adjustment_kind,
    signed_amount,
    trim(p_reason),
    source_item.fee_amount,
    source_item.fee_earned_at,
    effective_time,
    auth.uid(),
    account_email,
    account_role,
    trim(p_idempotency_key)
  )
  returning * into existing;

  return to_jsonb(existing);
exception
  when unique_violation then
    select a.* into existing
      from public.booking_fee_adjustments a
     where a.created_by_user_id = auth.uid()
       and a.idempotency_key = trim(p_idempotency_key)
     limit 1;
    if found then
      if existing.booking_ref <> booking_key
         or existing.adjustment_type <> adjustment_kind
         or existing.amount <> signed_amount
         or existing.reason <> trim(p_reason) then
        raise exception 'This idempotency key was already used for a different platform-fee adjustment.'
          using errcode = '22023';
      end if;
      return to_jsonb(existing);
    end if;
    raise;
end;
$$;

revoke all on function public.create_booking_fee_adjustment(text, text, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.create_booking_fee_adjustment(text, text, numeric, text, text)
  to authenticated;

comment on function public.create_booking_fee_adjustment(text, text, numeric, text, text) is
  'System-owner-only append operation for refund, duplicate, or correction entries after the original booking fee reached a submitted/settled remittance. The server derives the signed amount and prevents over-crediting.';

-- --------------------------------------------------------------------------
-- 3. Exact-cutoff preparation with adjustment carry-forward
-- --------------------------------------------------------------------------

create or replace function public.prepare_booking_fee_remittance(
  p_idempotency_key text,
  p_owner_override boolean default false,
  p_override_due_on date default null,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  account_email text;
  existing_id uuid;
  new_id uuid := gen_random_uuid();
  cutoff_time timestamptz;
  local_date date;
  current_month_due date;
  due_on date;
  item_count integer := 0;
  adjustment_count integer := 0;
  gross_booking_amount numeric := 0;
  adjustment_amount numeric := 0;
  total_due numeric := 0;
  coverage_start timestamptz;
  adjustment_start timestamptz;
  generated_ref text;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can prepare a remittance.'
      using errcode = '42501';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 128 then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;
  if coalesce(p_owner_override, false) and account_role <> 'owner' then
    raise exception 'Only the system owner may override the due schedule.'
      using errcode = '42501';
  end if;
  if coalesce(p_owner_override, false)
     and length(trim(coalesce(p_override_reason, ''))) < 3 then
    raise exception 'An owner override reason is required.' using errcode = '22023';
  end if;

  select r.id into existing_id
    from public.booking_fee_remittances r
   where r.prepared_by_user_id = auth.uid()
     and r.prepare_idempotency_key = trim(p_idempotency_key)
   limit 1;
  if existing_id is not null then
    return public.get_booking_fee_remittance_detail(existing_id);
  end if;

  -- Fee earning and adjustment creation take the matching shared lock. This
  -- exclusive lock therefore freezes both ledgers at one exact server cutoff.
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-pickleball-booking-fee-remittance', 0)
  );

  select r.id into existing_id
    from public.booking_fee_remittances r
   where r.prepared_by_user_id = auth.uid()
     and r.prepare_idempotency_key = trim(p_idempotency_key)
   limit 1;
  if existing_id is not null then
    return public.get_booking_fee_remittance_detail(existing_id);
  end if;

  cutoff_time := clock_timestamp();
  local_date := timezone('Asia/Manila', cutoff_time)::date;
  current_month_due := make_date(
    extract(year from local_date)::integer,
    extract(month from local_date)::integer,
    14
  );

  if not coalesce(p_owner_override, false) and local_date >= current_month_due then
    select r.id into existing_id
      from public.booking_fee_remittances r
     where r.scope_key = 'venue'
       and r.cycle_due_on = current_month_due
       and r.status <> 'cancelled'
     limit 1;
    if existing_id is not null then
      return public.get_booking_fee_remittance_detail(existing_id);
    end if;
  end if;

  due_on := case
    when coalesce(p_owner_override, false)
      then coalesce(p_override_due_on, public.booking_fee_next_due_on(cutoff_time))
    else public.booking_fee_next_due_on(cutoff_time)
  end;

  if not coalesce(p_owner_override, false) and local_date < due_on then
    raise exception 'The next remittance may be prepared on or after % (Asia/Manila).', due_on
      using errcode = '22023';
  end if;

  select
    coalesce((
      select round(sum(u.fee_amount), 2)
        from public.booking_fee_unclaimed_rows() u
       where u.fee_earned_at <= cutoff_time
    ), 0),
    coalesce((
      select round(sum(a.amount), 2)
        from public.booking_fee_unclaimed_adjustments() a
       where a.effective_at <= cutoff_time
    ), 0)
    into gross_booking_amount, adjustment_amount;

  total_due := round(gross_booking_amount + adjustment_amount, 2);
  if total_due <= 0 then
    raise exception
      'There is no positive platform allocation ready to remit. Any unused credit will carry forward automatically.'
      using errcode = '22023';
  end if;

  select r.id into existing_id
    from public.booking_fee_remittances r
   where r.scope_key = 'venue'
     and r.cycle_due_on = due_on
     and r.status <> 'cancelled'
   limit 1;
  if existing_id is not null then
    return public.get_booking_fee_remittance_detail(existing_id);
  end if;

  select a.email into account_email
    from public.accounts a
   where a.id = auth.uid()
   limit 1;

  generated_ref := 'REM-' || to_char(due_on, 'YYYYMMDD') || '-' ||
    upper(substr(replace(new_id::text, '-', ''), 1, 8));

  insert into public.booking_fee_remittances (
    id,
    remittance_ref,
    cycle_due_on,
    cutoff_at,
    status,
    prepared_at,
    prepared_by_user_id,
    prepared_by_email,
    prepared_by_role,
    prepare_idempotency_key,
    owner_override,
    owner_override_reason
  ) values (
    new_id,
    generated_ref,
    due_on,
    cutoff_time,
    'prepared',
    cutoff_time,
    auth.uid(),
    account_email,
    account_role,
    trim(p_idempotency_key),
    coalesce(p_owner_override, false),
    case when coalesce(p_owner_override, false) then trim(p_override_reason) end
  );

  insert into public.booking_fee_remittance_items (
    remittance_id,
    booking_ref,
    booking_group_ref,
    booking_created_at,
    fee_earned_at,
    court_id,
    court_name,
    booking_date,
    host_booking,
    created_via,
    fee_amount,
    fee_rate,
    fee_type,
    fee_units,
    fee_snapshot_source
  )
  select
    new_id,
    u.booking_ref,
    u.booking_group_ref,
    u.booking_created_at,
    u.fee_earned_at,
    u.court_id,
    u.court_name,
    u.booking_date,
    u.host_booking,
    u.created_via,
    round(u.fee_amount, 2),
    round(u.fee_rate, 2),
    u.fee_type,
    u.fee_units,
    u.fee_snapshot_source
  from public.booking_fee_unclaimed_rows() u
  where u.fee_earned_at <= cutoff_time
  order by u.fee_earned_at, u.booking_created_at, u.booking_ref
  on conflict (booking_ref) where released_at is null do nothing;

  insert into public.booking_fee_adjustment_applications (
    remittance_id,
    adjustment_id,
    adjustment_ref,
    booking_ref,
    booking_group_ref,
    source_remittance_id,
    adjustment_type,
    amount,
    reason,
    effective_at
  )
  select
    new_id,
    a.adjustment_id,
    a.adjustment_ref,
    a.booking_ref,
    a.booking_group_ref,
    a.source_remittance_id,
    a.adjustment_type,
    round(a.amount, 2),
    a.reason,
    a.effective_at
  from public.booking_fee_unclaimed_adjustments() a
  where a.effective_at <= cutoff_time
  order by a.effective_at, a.adjustment_id
  on conflict (adjustment_id) where released_at is null do nothing;

  select
    count(*)::integer,
    coalesce(round(sum(i.fee_amount), 2), 0),
    min(i.fee_earned_at)
    into item_count, gross_booking_amount, coverage_start
    from public.booking_fee_remittance_items i
   where i.remittance_id = new_id
     and i.released_at is null;

  select
    count(*)::integer,
    coalesce(round(sum(a.amount), 2), 0),
    min(a.effective_at)
    into adjustment_count, adjustment_amount, adjustment_start
    from public.booking_fee_adjustment_applications a
   where a.remittance_id = new_id
     and a.released_at is null;

  total_due := round(gross_booking_amount + adjustment_amount, 2);
  if total_due <= 0 then
    raise exception
      'The exact cutoff produced no positive payable balance; adjustment credit remains available for a future remittance.'
      using errcode = '22023';
  end if;

  coverage_start := case
    when coverage_start is null then adjustment_start
    when adjustment_start is null then coverage_start
    else least(coverage_start, adjustment_start)
  end;

  update public.booking_fee_remittances r
     set bookings_count = item_count,
         amount_due = total_due,
         coverage_start_at = coverage_start,
         status = 'prepared',
         settled_at = null
   where r.id = new_id;

  insert into public.booking_fee_remittance_events (
    remittance_id, event_type, actor_user_id, actor_role, event_at, metadata
  ) values (
    new_id,
    'prepared',
    auth.uid(),
    account_role,
    cutoff_time,
    jsonb_build_object(
      'cycle_due_on', due_on,
      'cutoff_at', cutoff_time,
      'bookings_count', item_count,
      'gross_booking_fee_amount', gross_booking_amount,
      'adjustment_count', adjustment_count,
      'adjustment_amount', adjustment_amount,
      'amount_due', total_due,
      'owner_override', coalesce(p_owner_override, false)
    )
  );

  return public.get_booking_fee_remittance_detail(new_id);
end;
$$;

revoke all on function public.prepare_booking_fee_remittance(text, boolean, date, text)
  from public, anon, authenticated;
grant execute on function public.prepare_booking_fee_remittance(text, boolean, date, text)
  to authenticated;

comment on function public.prepare_booking_fee_remittance(text, boolean, date, text) is
  'Atomically freezes every unclaimed earned fee and unapplied signed adjustment through one exact server cutoff. Credit carries forward until the net payable is positive.';

-- --------------------------------------------------------------------------
-- 4. Payable summaries (active rows only) plus explicit release audit metrics
-- --------------------------------------------------------------------------

create or replace function public.booking_fee_remittance_summary_json(
  p_remittance_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with all_item_rows as materialized (
    select
      i.booking_ref,
      case
        when nullif(btrim(i.booking_group_ref), '') is not null
          then 'group:' || btrim(i.booking_group_ref)
        else 'booking:' || i.booking_ref
      end as reservation_key,
      i.fee_type,
      i.fee_rate,
      i.fee_units,
      i.fee_amount,
      i.released_at
    from public.booking_fee_remittance_items i
    where i.remittance_id = p_remittance_id
  ),
  item_rows as materialized (
    select * from all_item_rows where released_at is null
  ),
  audit_metrics as (
    select
      count(*)::integer as booking_rows_count,
      count(distinct i.reservation_key)::integer as reservation_count,
      coalesce(
        round(sum(i.fee_units) filter (where i.fee_type = 'per_hour'), 2),
        0::numeric
      ) as billable_hours,
      (count(*) filter (where i.fee_type = 'flat'))::integer as flat_fee_booking_count,
      coalesce(round(sum(i.fee_amount), 2), 0::numeric) as base_fee_amount
    from item_rows i
  ),
  released_metrics as (
    select
      count(*)::integer as booking_rows_count,
      count(distinct i.reservation_key)::integer as reservation_count,
      coalesce(
        round(sum(i.fee_units) filter (where i.fee_type = 'per_hour'), 2),
        0::numeric
      ) as billable_hours,
      coalesce(round(sum(i.fee_amount), 2), 0::numeric) as fee_amount
    from all_item_rows i
    where i.released_at is not null
  ),
  rate_breakdown as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'fee_type', x.fee_type,
          'fee_rate', x.fee_rate,
          'booking_count', x.item_count,
          'item_count', x.item_count,
          'booking_rows_count', x.item_count,
          'reservation_count', x.reservation_count,
          'fee_units', x.fee_units,
          'unit_count', x.fee_units,
          'billable_hours', x.billable_hours,
          'court_hours', x.billable_hours,
          'flat_fee_booking_count', x.flat_fee_booking_count,
          'amount', x.amount
        )
        order by x.sort_order, x.fee_rate
      ),
      '[]'::jsonb
    ) as rows
    from (
      select
        i.fee_type,
        i.fee_rate,
        count(*)::integer as item_count,
        count(distinct i.reservation_key)::integer as reservation_count,
        round(sum(i.fee_units), 2) as fee_units,
        coalesce(
          round(sum(i.fee_units) filter (where i.fee_type = 'per_hour'), 2),
          0::numeric
        ) as billable_hours,
        (count(*) filter (where i.fee_type = 'flat'))::integer as flat_fee_booking_count,
        round(sum(i.fee_amount), 2) as amount,
        case i.fee_type when 'per_hour' then 1 else 2 end as sort_order
      from item_rows i
      group by i.fee_type, i.fee_rate
    ) x
  ),
  active_adjustments as materialized (
    select a.amount
      from public.booking_fee_adjustment_applications a
     where a.remittance_id = p_remittance_id
       and a.released_at is null
  ),
  adjustment_metrics as (
    select
      count(*)::integer as adjustment_count,
      coalesce(round(sum(a.amount), 2), 0::numeric) as adjustment_amount
    from active_adjustments a
  ),
  released_adjustment_metrics as (
    select
      count(*)::integer as adjustment_count,
      coalesce(round(sum(a.amount), 2), 0::numeric) as adjustment_amount
    from public.booking_fee_adjustment_applications a
    where a.remittance_id = p_remittance_id
      and a.released_at is not null
  )
  select jsonb_build_object(
    'id', r.id,
    'remittance_ref', r.remittance_ref,
    'cycle_due_on', r.cycle_due_on,
    'coverage_start_at', r.coverage_start_at,
    'cutoff_at', r.cutoff_at,
    'status', r.status,
    'currency', r.currency,
    'bookings_count', m.booking_rows_count,
    'booking_rows_count', m.booking_rows_count,
    'reservation_count', m.reservation_count,
    'billable_hours', m.billable_hours,
    'court_hours', m.billable_hours,
    'flat_fee_booking_count', m.flat_fee_booking_count,
    'fee_breakdown', rb.rows,
    'rate_type_breakdown', rb.rows,
    'base_fee_amount', m.base_fee_amount,
    'adjustment_count', am.adjustment_count,
    'adjustment_amount', am.adjustment_amount,
    'calculated_amount_due', round(m.base_fee_amount + am.adjustment_amount, 2),
    'released_booking_rows_count', rm.booking_rows_count,
    'released_reservation_count', rm.reservation_count,
    'released_billable_hours', rm.billable_hours,
    'released_booking_fee_amount', rm.fee_amount,
    'released_adjustment_count', ram.adjustment_count,
    'released_adjustment_amount', ram.adjustment_amount,
    'reconciliation_matches_header', (
      r.status = 'cancelled'
      or round(m.base_fee_amount + am.adjustment_amount, 2) = r.amount_due
    ),
    'amount_due', r.amount_due,
    'amount_settled', r.amount_settled,
    'remaining_balance', case
      when r.status = 'cancelled' then 0::numeric
      else greatest(round(r.amount_due - r.amount_settled, 2), 0)
    end,
    'prepared_at', r.prepared_at,
    'prepared_by_user_id', r.prepared_by_user_id,
    'prepared_by_email', r.prepared_by_email,
    'prepared_by_role', r.prepared_by_role,
    'owner_override', r.owner_override,
    'owner_override_reason', r.owner_override_reason,
    'last_submitted_at', r.last_submitted_at,
    'settled_at', r.settled_at,
    'cancelled_at', r.cancelled_at,
    'cancellation_reason', r.cancellation_reason,
    'latest_payment', (
      select jsonb_build_object(
        'id', p.id,
        'amount_submitted', p.amount_submitted,
        'amount_accepted', p.amount_accepted,
        'payment_method', p.payment_method,
        'payment_reference', p.payment_reference,
        'proof_path', p.proof_path,
        'note', p.note,
        'status', p.status,
        'submitted_at', p.submitted_at,
        'submitted_by_user_id', p.submitted_by_user_id,
        'submitted_by_email', p.submitted_by_email,
        'reviewed_at', p.reviewed_at,
        'reviewed_by_user_id', p.reviewed_by_user_id,
        'review_note', p.review_note
      )
      from public.booking_fee_remittance_payments p
      where p.remittance_id = r.id
      order by p.submitted_at desc, p.id desc
      limit 1
    ),
    'is_overdue', (
      r.status not in ('settled', 'cancelled')
      and timezone('Asia/Manila', now())::date > r.cycle_due_on
    ),
    'created_at', r.created_at,
    'updated_at', r.updated_at
  )
  from public.booking_fee_remittances r
  cross join audit_metrics m
  cross join released_metrics rm
  cross join rate_breakdown rb
  cross join adjustment_metrics am
  cross join released_adjustment_metrics ram
  where r.id = p_remittance_id
$$;

revoke all on function public.booking_fee_remittance_summary_json(uuid)
  from public, anon, authenticated;

comment on function public.booking_fee_remittance_summary_json(uuid) is
  'Builds payable metrics from active booking and adjustment rows only, while exposing released rows separately for permanent audit.';

create or replace function public.get_booking_fee_remittance_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  server_now timestamptz := clock_timestamp();
  local_date date;
  next_due date;
  accumulated_count integer := 0;
  accumulated_reservation_count integer := 0;
  accumulated_billable_hours numeric := 0;
  accumulated_flat_fee_booking_count integer := 0;
  accumulated_rate_type_breakdown jsonb := '[]'::jsonb;
  gross_booking_amount numeric := 0;
  adjustment_count integer := 0;
  adjustment_amount numeric := 0;
  net_accumulated numeric := 0;
  accumulated_start timestamptz;
  adjustment_start timestamptz;
  open_rows jsonb := '[]'::jsonb;
  open_remaining numeric := 0;
  settled_total numeric := 0;
  last_settled jsonb;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view remittances.'
      using errcode = '42501';
  end if;

  local_date := timezone('Asia/Manila', server_now)::date;
  next_due := public.booking_fee_next_due_on(server_now);

  with unclaimed as materialized (
    select
      u.*,
      case
        when nullif(btrim(u.booking_group_ref), '') is not null
          then 'group:' || btrim(u.booking_group_ref)
        else 'booking:' || u.booking_ref
      end as reservation_key
    from public.booking_fee_unclaimed_rows() u
  )
  select
    count(*)::integer,
    count(distinct u.reservation_key)::integer,
    coalesce(
      round(sum(u.fee_units) filter (where u.fee_type = 'per_hour'), 2),
      0::numeric
    ),
    (count(*) filter (where u.fee_type = 'flat'))::integer,
    coalesce(round(sum(u.fee_amount), 2), 0::numeric),
    min(u.fee_earned_at),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'fee_type', x.fee_type,
          'fee_rate', x.fee_rate,
          'booking_count', x.item_count,
          'item_count', x.item_count,
          'booking_rows_count', x.item_count,
          'reservation_count', x.reservation_count,
          'fee_units', x.fee_units,
          'unit_count', x.fee_units,
          'billable_hours', x.billable_hours,
          'court_hours', x.billable_hours,
          'flat_fee_booking_count', x.flat_fee_booking_count,
          'amount', x.amount
        )
        order by x.sort_order, x.fee_rate
      )
      from (
        select
          b.fee_type,
          b.fee_rate,
          count(*)::integer as item_count,
          count(distinct b.reservation_key)::integer as reservation_count,
          round(sum(b.fee_units), 2) as fee_units,
          coalesce(
            round(sum(b.fee_units) filter (where b.fee_type = 'per_hour'), 2),
            0::numeric
          ) as billable_hours,
          (count(*) filter (where b.fee_type = 'flat'))::integer as flat_fee_booking_count,
          round(sum(b.fee_amount), 2) as amount,
          case b.fee_type when 'per_hour' then 1 else 2 end as sort_order
        from unclaimed b
        group by b.fee_type, b.fee_rate
      ) x
    ), '[]'::jsonb)
    into
      accumulated_count,
      accumulated_reservation_count,
      accumulated_billable_hours,
      accumulated_flat_fee_booking_count,
      gross_booking_amount,
      accumulated_start,
      accumulated_rate_type_breakdown
    from unclaimed u;

  select
    count(*)::integer,
    coalesce(round(sum(a.amount), 2), 0::numeric),
    min(a.effective_at)
    into adjustment_count, adjustment_amount, adjustment_start
    from public.booking_fee_unclaimed_adjustments() a;

  net_accumulated := round(gross_booking_amount + adjustment_amount, 2);
  accumulated_start := case
    when accumulated_start is null then adjustment_start
    when adjustment_start is null then accumulated_start
    else least(accumulated_start, adjustment_start)
  end;

  select
    coalesce(
      jsonb_agg(
        public.booking_fee_remittance_summary_json(r.id)
        order by r.cycle_due_on, r.prepared_at
      ),
      '[]'::jsonb
    ),
    coalesce(sum(greatest(r.amount_due - r.amount_settled, 0)), 0)
    into open_rows, open_remaining
    from public.booking_fee_remittances r
   where r.status not in ('settled', 'cancelled');

  select public.booking_fee_remittance_summary_json(r.id)
    into last_settled
    from public.booking_fee_remittances r
   where r.status = 'settled'
   order by r.settled_at desc nulls last, r.prepared_at desc
   limit 1;

  select coalesce(round(sum(r.amount_settled), 2), 0)
    into settled_total
    from public.booking_fee_remittances r
   where r.status <> 'cancelled';

  return jsonb_build_object(
    'server_now', server_now,
    'timezone', 'Asia/Manila',
    'role', account_role,
    'next_due_on', next_due,
    'can_prepare', local_date >= next_due and net_accumulated > 0,
    'can_owner_override', account_role = 'owner',
    'accumulated', jsonb_build_object(
      'bookings_count', accumulated_count,
      'booking_rows_count', accumulated_count,
      'reservation_count', accumulated_reservation_count,
      'billable_hours', accumulated_billable_hours,
      'court_hours', accumulated_billable_hours,
      'flat_fee_booking_count', accumulated_flat_fee_booking_count,
      'fee_breakdown', accumulated_rate_type_breakdown,
      'rate_type_breakdown', accumulated_rate_type_breakdown,
      'gross_booking_fee_amount', gross_booking_amount,
      'adjustment_count', adjustment_count,
      'adjustment_amount', adjustment_amount,
      'net_amount', net_accumulated,
      'credit_carryforward', greatest(-net_accumulated, 0),
      'amount', greatest(net_accumulated, 0),
      'coverage_start_at', accumulated_start
    ),
    'open_remaining_balance', round(open_remaining, 2),
    'total_outstanding_balance', round(open_remaining + greatest(net_accumulated, 0), 2),
    'accepted_total', settled_total,
    'settled_total', settled_total,
    'open_remittances', open_rows,
    'last_settled', last_settled
  );
end;
$$;

revoke all on function public.get_booking_fee_remittance_dashboard()
  from public, anon, authenticated;
grant execute on function public.get_booking_fee_remittance_dashboard()
  to authenticated;

comment on function public.get_booking_fee_remittance_dashboard() is
  'Returns authoritative active fee, signed adjustment, carry-forward credit, open remittance, and settlement metrics for owners.';

create or replace function public.get_booking_fee_remittance_detail(
  p_remittance_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  header jsonb;
  items jsonb;
  adjustments jsonb;
  payments jsonb;
  events jsonb;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view remittances.'
      using errcode = '42501';
  end if;

  header := public.booking_fee_remittance_summary_json(p_remittance_id);
  if header is null then
    raise exception 'Remittance not found.' using errcode = 'P0002';
  end if;

  -- Retain released rows in detail for audit. Summary metrics above use only
  -- released_at IS NULL rows for the payable formula.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'booking_ref', i.booking_ref,
    'booking_group_ref', i.booking_group_ref,
    'booking_created_at', i.booking_created_at,
    'fee_earned_at', i.fee_earned_at,
    'court_id', i.court_id,
    'court_name', i.court_name,
    'booking_date', i.booking_date,
    'host_booking', i.host_booking,
    'created_via', i.created_via,
    'fee_amount', i.fee_amount,
    'fee_rate', i.fee_rate,
    'fee_type', i.fee_type,
    'fee_units', i.fee_units,
    'fee_snapshot_source', i.fee_snapshot_source,
    'released_at', i.released_at,
    'release_reason', i.release_reason
  ) order by i.fee_earned_at, i.booking_ref), '[]'::jsonb)
  into items
  from public.booking_fee_remittance_items i
  where i.remittance_id = $1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id,
    'adjustment_id', x.adjustment_id,
    'adjustment_ref', x.adjustment_ref,
    'booking_ref', x.booking_ref,
    'booking_group_ref', x.booking_group_ref,
    'source_remittance_id', x.source_remittance_id,
    'adjustment_type', x.adjustment_type,
    'amount', x.amount,
    'reason', x.reason,
    'effective_at', x.effective_at,
    'released_at', x.released_at,
    'release_reason', x.release_reason
  ) order by x.effective_at, x.id), '[]'::jsonb)
  into adjustments
  from public.booking_fee_adjustment_applications x
  where x.remittance_id = $1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'amount_submitted', p.amount_submitted,
    'amount_accepted', p.amount_accepted,
    'payment_method', p.payment_method,
    'payment_reference', p.payment_reference,
    'proof_path', p.proof_path,
    'note', p.note,
    'status', p.status,
    'submitted_at', p.submitted_at,
    'submitted_by_user_id', p.submitted_by_user_id,
    'submitted_by_email', p.submitted_by_email,
    'reviewed_at', p.reviewed_at,
    'reviewed_by_user_id', p.reviewed_by_user_id,
    'review_note', p.review_note
  ) order by p.submitted_at, p.id), '[]'::jsonb)
  into payments
  from public.booking_fee_remittance_payments p
  where p.remittance_id = $1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'payment_id', e.payment_id,
    'event_type', e.event_type,
    'actor_user_id', e.actor_user_id,
    'actor_role', e.actor_role,
    'event_at', e.event_at,
    'metadata', e.metadata
  ) order by e.event_at, e.id), '[]'::jsonb)
  into events
  from public.booking_fee_remittance_events e
  where e.remittance_id = $1;

  return jsonb_build_object(
    'remittance', header,
    'items', items,
    'adjustments', adjustments,
    'payments', payments,
    'events', events
  );
end;
$$;

revoke all on function public.get_booking_fee_remittance_detail(uuid)
  from public, anon, authenticated;
grant execute on function public.get_booking_fee_remittance_detail(uuid)
  to authenticated;

comment on function public.get_booking_fee_remittance_detail(uuid) is
  'Returns permanent booking lines, signed adjustment lines, proof attempts, and audit events; released rows remain visible but do not affect payable summaries.';

-- Keep owner void/delete compatible with batches that contain signed adjustment
-- applications. A positive adjustment-only batch remains payable; a zero or
-- credit-only result is dissolved so every remaining line safely returns to the
-- next cycle.
create or replace function public.void_delete_booking_group(
  p_booking_ref text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.bookings%rowtype;
  group_key text;
  refs text[];
  affected_ids uuid[];
  void_time timestamptz := clock_timestamp();
  deleted_count integer := 0;
  released_count integer := 0;
  dissolved_item_count integer := 0;
  dissolved_adjustment_count integer := 0;
  affected_row_count integer := 0;
  voided_fee numeric(12,2) := 0;
  rid uuid;
  remaining_count integer;
  remaining_booking_due numeric(12,2);
  remaining_adjustment_due numeric(12,2);
  remaining_due numeric(12,2);
begin
  if public.current_account_role() <> 'owner' then
    raise exception 'Only the active System Owner can void and delete a booking.'
      using errcode = '42501';
  end if;
  if length(trim(coalesce(p_booking_ref, ''))) = 0 then
    raise exception 'A booking reference is required.' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A void reason of at least 3 characters is required.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-pickleball-booking-fee-remittance', 0)
  );

  select * into target
    from public.bookings
   where ref = trim(p_booking_ref)
   for update;
  if not found then
    raise exception 'Booking % was not found.', trim(p_booking_ref)
      using errcode = 'P0002';
  end if;

  group_key := coalesce(nullif(target.booking_group_ref, ''), target.ref);
  select
    array_agg(b.ref order by b.ref),
    coalesce(sum(
      case
        when b.booking_fee_earned_at is not null
          then greatest(coalesce(b.booking_fee_amount_snapshot, 0), 0)
        else 0
      end
    ), 0)
    into refs, voided_fee
    from public.bookings b
   where coalesce(nullif(b.booking_group_ref, ''), b.ref) = group_key;

  perform 1 from public.bookings b where b.ref = any(refs) for update;

  if exists (
    select 1
      from public.bookings b
      join public.weekly_fees wf
        on wf.status = 'paid'
       and (
         wf.id = b.weekly_fee_id
         or coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(b.ref)
       )
     where b.ref = any(refs)
  ) then
    raise exception 'This booking fee is already in a paid legacy statement and cannot be void-deleted.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.booking_fee_remittance_items i
      join public.booking_fee_remittances r on r.id = i.remittance_id
     where i.booking_ref = any(refs)
       and i.released_at is null
       and (r.status not in ('prepared', 'payment_rejected') or r.amount_settled <> 0)
  ) then
    raise exception 'This booking fee has a submitted or settled remittance. Apply a credit adjustment instead of deleting financial history.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.booking_fee_remittance_items i
      join public.booking_fee_remittance_payments p on p.remittance_id = i.remittance_id
     where i.booking_ref = any(refs)
       and i.released_at is null
       and p.status in ('pending', 'accepted', 'partially_accepted')
  ) then
    raise exception 'A pending or accepted remittance payment prevents this booking from being void-deleted.'
      using errcode = '22023';
  end if;

  select array_agg(distinct i.remittance_id)
    into affected_ids
    from public.booking_fee_remittance_items i
   where i.booking_ref = any(refs)
     and i.released_at is null;

  update public.booking_fee_remittance_items i
     set released_at = void_time,
         released_by_user_id = auth.uid(),
         release_reason = 'Booking voided by System Owner: ' || trim(p_reason)
   where i.booking_ref = any(refs)
     and i.released_at is null;
  get diagnostics released_count = row_count;

  if affected_ids is not null then
    foreach rid in array affected_ids loop
      select
        count(*)::integer,
        coalesce(round(sum(i.fee_amount), 2), 0)
        into remaining_count, remaining_booking_due
        from public.booking_fee_remittance_items i
       where i.remittance_id = rid
         and i.released_at is null;

      select coalesce(round(sum(a.amount), 2), 0)
        into remaining_adjustment_due
        from public.booking_fee_adjustment_applications a
       where a.remittance_id = rid
         and a.released_at is null;

      remaining_due := round(remaining_booking_due + remaining_adjustment_due, 2);

      if remaining_due <= 0 then
        update public.booking_fee_remittance_items i
           set released_at = void_time,
               released_by_user_id = auth.uid(),
               release_reason = 'Remittance dissolved after booking void left no positive payable balance: ' || trim(p_reason)
         where i.remittance_id = rid
           and i.released_at is null;
        get diagnostics affected_row_count = row_count;
        dissolved_item_count := dissolved_item_count + affected_row_count;

        update public.booking_fee_adjustment_applications a
           set released_at = void_time,
               released_by_user_id = auth.uid(),
               release_reason = 'Remittance dissolved after booking void left no positive payable balance: ' || trim(p_reason)
         where a.remittance_id = rid
           and a.released_at is null;
        get diagnostics affected_row_count = row_count;
        dissolved_adjustment_count := dissolved_adjustment_count + affected_row_count;

        update public.booking_fee_remittances r
           set bookings_count = 0,
               amount_due = 0,
               status = 'cancelled',
               cancelled_at = void_time,
               cancelled_by_user_id = auth.uid(),
               cancellation_reason = 'No positive payable balance after System Owner booking void: ' || trim(p_reason),
               cancel_idempotency_key = 'void-' || rid::text
         where r.id = rid;
      else
        update public.booking_fee_remittances r
           set bookings_count = remaining_count,
               amount_due = remaining_due
         where r.id = rid;
      end if;
    end loop;
  end if;

  perform set_config('app.owner_void_reason', trim(p_reason), true);
  perform set_config('app.owner_void_booking', 'on', true);
  delete from public.bookings b where b.ref = any(refs);
  get diagnostics deleted_count = row_count;

  return jsonb_build_object(
    'booking_ref', trim(p_booking_ref),
    'group_key', group_key,
    'deleted_count', deleted_count,
    'released_remittance_items', released_count,
    'dissolved_remittance_items', dissolved_item_count,
    'dissolved_adjustments', dissolved_adjustment_count,
    'voided_fee_amount', voided_fee,
    'reason', trim(p_reason)
  );
end;
$$;

revoke all on function public.void_delete_booking_group(text, text)
  from public, anon;
grant execute on function public.void_delete_booking_group(text, text)
  to authenticated;

comment on function public.void_delete_booking_group(text, text) is
  'System-owner correction flow that recalculates prepared remittances from active booking items plus active signed adjustments; non-positive batches are dissolved and carried forward safely.';

-- --------------------------------------------------------------------------
-- 5. Fixed policy audit and strict access
-- --------------------------------------------------------------------------

create table if not exists public.booking_fee_policy_history (
  policy_key text primary key,
  fee_type text not null,
  fee_rate numeric(12,2) not null,
  effective_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  source text not null,
  notes text,
  constraint booking_fee_policy_history_type_check check (fee_type = 'per_hour'),
  constraint booking_fee_policy_history_rate_check check (fee_rate = 10),
  constraint booking_fee_policy_history_source_check check (length(trim(source)) >= 3)
);

insert into public.booking_fee_policy_history (
  policy_key, fee_type, fee_rate, effective_at, source, notes
) values (
  'paddle-rage-platform-allocation-v1',
  'per_hour',
  10,
  clock_timestamp(),
  'database_migration',
  'PHP 10 per booked court-hour, included inside the player-facing court price. Historical booking snapshots remain unchanged.'
)
on conflict (policy_key) do nothing;

create or replace function public.prevent_booking_fee_policy_history_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Platform allocation policy history is append-only and cannot be changed or deleted.'
    using errcode = '22000';
end;
$$;

drop trigger if exists trg_no_update_booking_fee_policy_history
  on public.booking_fee_policy_history;
create trigger trg_no_update_booking_fee_policy_history
before update on public.booking_fee_policy_history
for each row execute function public.prevent_booking_fee_policy_history_change();

drop trigger if exists trg_no_delete_booking_fee_policy_history
  on public.booking_fee_policy_history;
create trigger trg_no_delete_booking_fee_policy_history
before delete on public.booking_fee_policy_history
for each row execute function public.prevent_booking_fee_policy_history_change();

create or replace function public.guard_fixed_booking_fee_policy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.key in ('maintenance_fee', 'fee_type') then
      raise exception 'The platform allocation policy is fixed at PHP 10 per booked court-hour and cannot be deleted.'
        using errcode = '22023';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and old.key in ('maintenance_fee', 'fee_type')
     and new.key is distinct from old.key then
    raise exception 'The platform allocation policy key cannot be renamed.'
      using errcode = '22023';
  end if;

  if new.key not in ('maintenance_fee', 'fee_type') then
    return new;
  end if;

  if new.key = 'maintenance_fee'
     and (
       trim(coalesce(new.value, '')) !~ '^[0-9]+([.][0-9]+)?$'
       or round(trim(new.value)::numeric, 2) <> 10
     ) then
    raise exception 'The platform allocation is fixed at PHP 10 per booked court-hour.'
      using errcode = '22023';
  end if;

  if new.key = 'fee_type'
     and lower(trim(coalesce(new.value, ''))) <> 'per_hour' then
    raise exception 'The platform allocation type is fixed at per_hour.'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_fixed_booking_fee_policy on public.settings;
create trigger trg_guard_fixed_booking_fee_policy
before insert or update or delete on public.settings
for each row execute function public.guard_fixed_booking_fee_policy();

comment on function public.guard_fixed_booking_fee_policy() is
  'Prevents UI or direct-client settings changes from silently replacing the approved PHP 10 per-court-hour policy. A future policy change requires an explicit audited migration.';

alter table public.booking_fee_adjustments enable row level security;
alter table public.booking_fee_adjustment_applications enable row level security;
alter table public.booking_fee_policy_history enable row level security;

drop policy if exists booking_fee_adjustments_select_roles
  on public.booking_fee_adjustments;
create policy booking_fee_adjustments_select_roles
  on public.booking_fee_adjustments
  for select to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists booking_fee_adjustment_applications_select_roles
  on public.booking_fee_adjustment_applications;
create policy booking_fee_adjustment_applications_select_roles
  on public.booking_fee_adjustment_applications
  for select to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists booking_fee_policy_history_select_roles
  on public.booking_fee_policy_history;
create policy booking_fee_policy_history_select_roles
  on public.booking_fee_policy_history
  for select to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

revoke all on table public.booking_fee_adjustments
  from public, anon, authenticated;
revoke all on table public.booking_fee_adjustment_applications
  from public, anon, authenticated;
revoke all on table public.booking_fee_policy_history
  from public, anon, authenticated;

grant select on table public.booking_fee_adjustments to authenticated;
grant select on table public.booking_fee_adjustment_applications to authenticated;
grant select on table public.booking_fee_policy_history to authenticated;

revoke all on function public.guard_fixed_booking_fee_policy()
  from public, anon, authenticated;
revoke all on function public.prevent_booking_fee_policy_history_change()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
