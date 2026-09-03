-- Explicit, audited reassignment of a genuine digital payment from a cancelled
-- booking to the replacement booking created by the same player.
--
-- A cancelled row remains part of the anti-replay history.  Nothing in this
-- migration weakens the ordinary confirmation collision checks.  The only way
-- to change a claimed receipt's logical owner is this narrow transaction.

begin;

-- --------------------------------------------------------------------------
-- 1. Immutable transfer audit and durable booking linkage
-- --------------------------------------------------------------------------

create table if not exists public.booking_payment_transfers (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  source_booking_ref text not null,
  source_booking_group_ref text,
  target_booking_ref text not null,
  target_booking_group_ref text,
  source_booking_refs text[] not null,
  target_booking_refs text[] not null,
  payment_method text not null,
  payment_reference_key text not null,
  evidence_ledger_keys text[] not null,
  amount numeric(12,2) not null,
  source_payment_status text not null,
  target_payment_status text not null,
  reason text not null,
  no_refund_confirmed boolean not null,
  actor_user_id uuid not null,
  actor_role text not null,
  created_at timestamptz not null default now(),
  constraint booking_payment_transfers_distinct_booking_check
    check (source_booking_ref <> target_booking_ref),
  constraint booking_payment_transfers_refs_check
    check (
      cardinality(source_booking_refs) > 0
      and cardinality(target_booking_refs) > 0
      and source_booking_ref = any(source_booking_refs)
      and target_booking_ref = any(target_booking_refs)
      and not (source_booking_refs && target_booking_refs)
    ),
  constraint booking_payment_transfers_method_check
    check (payment_method in (
      'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'
    )),
  constraint booking_payment_transfers_reference_check
    check (char_length(payment_reference_key) between 4 and 240),
  constraint booking_payment_transfers_evidence_check
    check (cardinality(evidence_ledger_keys) > 0),
  constraint booking_payment_transfers_amount_check
    check (amount > 0),
  constraint booking_payment_transfers_source_status_check
    check (source_payment_status in (
      'unpaid', 'for_verification', 'paid', 'downpayment_paid'
    )),
  constraint booking_payment_transfers_target_status_check
    check (target_payment_status in ('paid', 'downpayment_paid')),
  constraint booking_payment_transfers_reason_check
    check (
      char_length(reason) between 10 and 1000
      and reason !~ '[[:cntrl:]]'
    ),
  constraint booking_payment_transfers_no_refund_check
    check (no_refund_confirmed),
  constraint booking_payment_transfers_actor_role_check
    check (actor_role in ('owner', 'court_owner'))
);

create index if not exists idx_booking_payment_transfers_source
  on public.booking_payment_transfers (
    coalesce(source_booking_group_ref, source_booking_ref),
    created_at desc
  );
create index if not exists idx_booking_payment_transfers_target
  on public.booking_payment_transfers (
    coalesce(target_booking_group_ref, target_booking_ref),
    created_at desc
  );
create index if not exists idx_booking_payment_transfers_reference
  on public.booking_payment_transfers (payment_reference_key, created_at desc);

-- One cancelled payment and one replacement booking may participate in only
-- one transfer. Chained or split transfers need a separate finance workflow.
create unique index if not exists uq_booking_payment_transfers_source_owner
  on public.booking_payment_transfers (
    coalesce(source_booking_group_ref, source_booking_ref)
  );
create unique index if not exists uq_booking_payment_transfers_target_owner
  on public.booking_payment_transfers (
    coalesce(target_booking_group_ref, target_booking_ref)
  );

alter table public.booking_payment_transfers enable row level security;

drop policy if exists booking_payment_transfers_read_roles
  on public.booking_payment_transfers;
create policy booking_payment_transfers_read_roles
  on public.booking_payment_transfers
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.accounts account
      where account.id = auth.uid()
        and account.status = 'active'
        and account.role in ('owner', 'court_owner', 'staff')
    )
  );

revoke all on table public.booking_payment_transfers
  from public, anon, authenticated;
grant select on table public.booking_payment_transfers to authenticated;
grant all on table public.booking_payment_transfers to service_role;

create or replace function public.prevent_booking_payment_transfer_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'Booking payment transfer audits are immutable.'
    using errcode = '42501';
end;
$$;

drop trigger if exists z99_prevent_booking_payment_transfer_mutation
  on public.booking_payment_transfers;
create trigger z99_prevent_booking_payment_transfer_mutation
before update or delete on public.booking_payment_transfers
for each row execute function public.prevent_booking_payment_transfer_mutation();

revoke all on function public.prevent_booking_payment_transfer_mutation()
  from public, anon, authenticated;

comment on table public.booking_payment_transfers is
  'Append-only audit for an owner-approved, no-refund reassignment of one digital payment from a cancelled booking to its replacement.';

alter table public.bookings
  add column if not exists payment_transfer_id uuid
    references public.booking_payment_transfers(id) on delete restrict,
  add column if not exists payment_reassigned_from_ref text,
  add column if not exists payment_reassigned_to_ref text;

alter table public.bookings
  drop constraint if exists bookings_payment_transfer_link_check;
alter table public.bookings
  add constraint bookings_payment_transfer_link_check
  check (
    (
      payment_transfer_id is null
      and payment_reassigned_from_ref is null
      and payment_reassigned_to_ref is null
    )
    or (
      payment_transfer_id is not null
      and num_nonnulls(
        payment_reassigned_from_ref,
        payment_reassigned_to_ref
      ) = 1
      and (
        (
          payment_reassigned_to_ref is not null
          and status = 'cancelled'
        )
        or (
          payment_reassigned_from_ref is not null
          and status in ('confirmed', 'completed', 'cancelled')
        )
      )
    )
  );

create index if not exists idx_bookings_payment_transfer_id
  on public.bookings(payment_transfer_id)
  where payment_transfer_id is not null;

create or replace function public.guard_booking_payment_transfer_linkage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  expected_transfer_id text := nullif(trim(coalesce(current_setting(
    'paddle_rage.booking_payment_transfer_id',
    true
  ), '')), '');
  valid_transfer_link boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.payment_transfer_id is not null
       or new.payment_reassigned_from_ref is not null
       or new.payment_reassigned_to_ref is not null then
      raise exception 'Booking payment transfer links are server-managed.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.payment_transfer_id is not null
     and (
       (
         old.payment_reassigned_to_ref is not null
         and new.status <> 'cancelled'
       )
       or (
         old.payment_reassigned_from_ref is not null
         and new.status not in ('confirmed', 'completed', 'cancelled')
       )
     ) then
    raise exception 'A payment-transferred booking cannot re-enter an active or forfeited reservation state.'
      using errcode = '42501';
  end if;

  if new.payment_transfer_id is not distinct from old.payment_transfer_id
     and new.payment_reassigned_from_ref is not distinct from old.payment_reassigned_from_ref
     and new.payment_reassigned_to_ref is not distinct from old.payment_reassigned_to_ref then
    return new;
  end if;

  if old.payment_transfer_id is not null
     or expected_transfer_id is null
     or new.payment_transfer_id::text is distinct from expected_transfer_id then
    raise exception 'Booking payment transfer links are immutable and server-managed.'
      using errcode = '42501';
  end if;

  select exists (
    select 1
    from public.booking_payment_transfers transfer
    where transfer.id = new.payment_transfer_id
      and (
        (
          new.ref = any(transfer.source_booking_refs)
          and new.payment_reassigned_from_ref is null
          and new.payment_reassigned_to_ref = transfer.target_booking_ref
        )
        or (
          new.ref = any(transfer.target_booking_refs)
          and new.payment_reassigned_from_ref = transfer.source_booking_ref
          and new.payment_reassigned_to_ref is null
        )
      )
  ) into valid_transfer_link;
  if not valid_transfer_link then
    raise exception 'Booking payment transfer link does not match its immutable audit.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists a15_guard_booking_payment_transfer_linkage
  on public.bookings;
create trigger a15_guard_booking_payment_transfer_linkage
before insert or update of
  payment_transfer_id,
  payment_reassigned_from_ref,
  payment_reassigned_to_ref,
  status
on public.bookings
for each row execute function public.guard_booking_payment_transfer_linkage();

revoke all on function public.guard_booking_payment_transfer_linkage()
  from public, anon, authenticated;

create or replace function public.guard_booking_payment_transfer_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.payment_transfer_id is not null then
    raise exception 'A booking linked to an immutable payment transfer cannot be deleted.'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

drop trigger if exists a16_guard_booking_payment_transfer_delete
  on public.bookings;
create trigger a16_guard_booking_payment_transfer_delete
before delete on public.bookings
for each row execute function public.guard_booking_payment_transfer_delete();

revoke all on function public.guard_booking_payment_transfer_delete()
  from public, anon, authenticated;

comment on function public.guard_booking_payment_transfer_delete() is
  'Preserves both booking sides of an immutable payment-transfer audit.';

comment on column public.bookings.payment_transfer_id is
  'Immutable link to the audited payment move that involved this booking.';
comment on column public.bookings.payment_reassigned_from_ref is
  'Cancelled booking reference whose genuine payment was assigned to this replacement.';
comment on column public.bookings.payment_reassigned_to_ref is
  'Replacement booking reference that received this cancelled booking payment.';

-- --------------------------------------------------------------------------
-- 2. Narrow, atomic no-refund transfer
-- --------------------------------------------------------------------------

create or replace function public.transfer_cancelled_booking_payment(
  p_source_booking_ref text,
  p_target_booking_ref text,
  p_reason text,
  p_no_refund_confirmed boolean,
  p_idempotency_key uuid
)
returns table (
  transitioned boolean,
  transfer_id uuid,
  source_booking_ref text,
  target_booking_ref text,
  target_booking_status text,
  target_payment_status text,
  source_booking_refs text[],
  target_booking_refs text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_requested text := nullif(trim(coalesce(p_source_booking_ref, '')), '');
  v_target_requested text := nullif(trim(coalesce(p_target_booking_ref, '')), '');
  v_reason text := nullif(trim(regexp_replace(
    left(coalesce(p_reason, ''), 1000),
    '[[:cntrl:]]',
    ' ',
    'g'
  )), '');
  v_actor_role text := public.current_account_role();
  v_existing public.booking_payment_transfers%rowtype;
  v_source_anchor public.bookings%rowtype;
  v_target_anchor public.bookings%rowtype;
  v_source_group_ref text;
  v_target_group_ref text;
  v_source_key text;
  v_target_key text;
  v_source_scope text;
  v_target_scope text;
  v_source_refs text[];
  v_target_refs text[];
  v_all_refs text[];
  v_source_statuses text[];
  v_target_statuses text[];
  v_source_payment_statuses text[];
  v_target_payment_statuses text[];
  v_source_methods text[];
  v_target_methods text[];
  v_source_hosts boolean[];
  v_target_hosts boolean[];
  v_source_host_ids text[];
  v_target_host_ids text[];
  v_source_emails text[];
  v_target_emails text[];
  v_source_names text[];
  v_target_names text[];
  v_source_contacts text[];
  v_target_contacts text[];
  v_source_reference_keys text[];
  v_target_reference_keys text[];
  v_source_status text;
  v_target_status text;
  v_source_payment_status text;
  v_target_old_payment_status text;
  v_method text;
  v_reference_key text;
  v_source_host boolean;
  v_target_host boolean;
  v_source_total numeric;
  v_target_total numeric;
  v_source_amount numeric;
  v_target_amount numeric;
  v_source_row_count integer;
  v_target_row_count integer;
  v_source_invalid_amount_count integer;
  v_source_paid_at_count integer;
  v_source_fee_earned_count integer;
  v_target_invalid_amount_count integer;
  v_target_full_count integer;
  v_target_partial_count integer;
  v_target_payment_status text;
  v_source_signatures text[];
  v_target_signatures text[];
  v_source_hash text;
  v_target_hash text;
  v_source_phash text;
  v_target_phash text;
  v_source_hash_count integer;
  v_target_hash_count integer;
  v_source_phash_count integer;
  v_target_phash_count integer;
  v_evidence_keys text[];
  v_evidence_key text;
  v_evidence_provider text;
  v_evidence_provider_count integer;
  v_incumbent_scope text;
  v_incumbent_owner text;
  v_incumbent_provider text;
  v_ledger_found boolean;
  v_transfer_id uuid := gen_random_uuid();
  v_paid_at timestamptz;
  v_transfer_time timestamptz := clock_timestamp();
  v_updated_count integer;
  v_lock_key text;
begin
  if auth.uid() is null
     or v_actor_role not in ('owner', 'court_owner') then
    raise exception 'Only an active owner or court owner can move a cancelled booking payment.'
      using errcode = '42501';
  end if;
  if v_source_requested is null or v_target_requested is null then
    raise exception 'Both source and target booking references are required.'
      using errcode = '22023';
  end if;
  if v_source_requested = v_target_requested then
    raise exception 'Source and target bookings must be different.'
      using errcode = '22023';
  end if;
  if char_length(coalesce(v_reason, '')) < 10 then
    raise exception 'A payment move reason of at least 10 characters is required.'
      using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    raise exception 'A payment move idempotency key is required.'
      using errcode = '22023';
  end if;
  if not coalesce(p_no_refund_confirmed, false) then
    raise exception 'Confirm that no refund was issued before moving this payment.'
      using errcode = '22023';
  end if;

  -- Freeze remittance preparation and payment confirmation before inspecting
  -- either logical booking. This also makes fee reassignment cutoff-safe.
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-pickleball-booking-fee-remittance', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-booking-payment-transfer-idempotency:' || p_idempotency_key::text, 0)
  );

  select transfer.*
    into v_existing
    from public.booking_payment_transfers transfer
   where transfer.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.source_booking_ref <> v_source_requested
       or v_existing.target_booking_ref <> v_target_requested
       or v_existing.reason <> v_reason
       or not v_existing.no_refund_confirmed then
      raise exception 'This idempotency key was already used for a different payment move.'
        using errcode = '22023';
    end if;
    return query
    select
      false,
      v_existing.id,
      v_existing.source_booking_ref,
      v_existing.target_booking_ref,
      'confirmed'::text,
      v_existing.target_payment_status,
      v_existing.source_booking_refs,
      v_existing.target_booking_refs;
    return;
  end if;

  select b.* into v_source_anchor
    from public.bookings b
   where b.ref = v_source_requested;
  if not found then
    raise exception 'Source booking not found.' using errcode = 'P0002';
  end if;
  select b.* into v_target_anchor
    from public.bookings b
   where b.ref = v_target_requested;
  if not found then
    raise exception 'Replacement booking not found.' using errcode = 'P0002';
  end if;

  v_source_group_ref := nullif(trim(coalesce(v_source_anchor.booking_group_ref, '')), '');
  v_target_group_ref := nullif(trim(coalesce(v_target_anchor.booking_group_ref, '')), '');
  v_source_key := coalesce(v_source_group_ref, v_source_requested);
  v_target_key := coalesce(v_target_group_ref, v_target_requested);
  if v_source_key = v_target_key then
    raise exception 'Source and target must be different logical bookings.'
      using errcode = '22023';
  end if;

  -- Match the existing rejection lock order (rejection, then public group) and
  -- take every two-booking lock in lexical order to avoid inverse acquisition.
  for v_lock_key in
    select lock_value
      from unnest(array[v_source_key, v_target_key]) lock_value
     order by lock_value
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'paddle-rage-booking-payment-rejection:' || v_lock_key,
      0
    ));
  end loop;

  for v_lock_key in
    select lock_value
      from unnest(array_remove(array[v_source_group_ref, v_target_group_ref], null)) lock_value
     order by lock_value
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'paddle-rage-public-booking-group:' || v_lock_key,
      0
    ));
  end loop;

  for v_lock_key in
    select lock_value
      from unnest(array[v_source_key, v_target_key]) lock_value
     order by lock_value
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'paddle-rage-booking-confirmation:' || v_lock_key,
      0
    ));
    perform pg_advisory_xact_lock(hashtextextended(
      'paddle-rage-booking-payment-transfer:' || v_lock_key,
      0
    ));
  end loop;

  -- Re-read after all operation locks. Group membership is then frozen by the
  -- same public-group locks used by the booking submit/finalization paths.
  select b.* into v_source_anchor
    from public.bookings b
   where b.ref = v_source_requested
   for update;
  if not found
     or nullif(trim(coalesce(v_source_anchor.booking_group_ref, '')), '')
       is distinct from v_source_group_ref then
    raise exception 'Source booking scope changed while the payment move was starting.'
      using errcode = '40001';
  end if;
  select b.* into v_target_anchor
    from public.bookings b
   where b.ref = v_target_requested
   for update;
  if not found
     or nullif(trim(coalesce(v_target_anchor.booking_group_ref, '')), '')
       is distinct from v_target_group_ref then
    raise exception 'Replacement booking scope changed while the payment move was starting.'
      using errcode = '40001';
  end if;

  if v_source_group_ref is null then
    v_source_refs := array[v_source_requested];
  else
    select array_agg(b.ref order by b.ref)
      into v_source_refs
      from public.bookings b
     where b.booking_group_ref = v_source_group_ref;
  end if;
  if v_target_group_ref is null then
    v_target_refs := array[v_target_requested];
  else
    select array_agg(b.ref order by b.ref)
      into v_target_refs
      from public.bookings b
     where b.booking_group_ref = v_target_group_ref;
  end if;
  if v_source_refs is null or v_target_refs is null
     or not (v_source_requested = any(v_source_refs))
     or not (v_target_requested = any(v_target_refs))
     or v_source_refs && v_target_refs then
    raise exception 'Booking group membership changed while the payment move was starting.'
      using errcode = '40001';
  end if;

  v_all_refs := v_source_refs || v_target_refs;
  perform 1
    from public.bookings b
   where b.ref = any(v_all_refs)
   order by b.ref
   for update;

  select
    array_agg(distinct lower(trim(coalesce(b.status, '')))),
    array_agg(distinct lower(trim(coalesce(b.payment_status, '')))),
    array_agg(distinct lower(trim(coalesce(b.payment_method, '')))),
    array_agg(distinct coalesce(b.host_booking, false)),
    array_agg(distinct coalesce(b.host_user_id::text, '')),
    array_agg(distinct lower(trim(coalesce(b.email, '')))),
    array_agg(distinct lower(regexp_replace(trim(coalesce(b.full_name, '')), '\s+', ' ', 'g'))),
    array_agg(distinct regexp_replace(coalesce(b.contact_number, ''), '[^0-9]', '', 'g')),
    array_agg(distinct public.normalize_payment_reference_key(
      lower(trim(coalesce(b.payment_method, ''))),
      b.gcash_ref
    ))
    into
      v_source_statuses,
      v_source_payment_statuses,
      v_source_methods,
      v_source_hosts,
      v_source_host_ids,
      v_source_emails,
      v_source_names,
      v_source_contacts,
      v_source_reference_keys
    from public.bookings b
   where b.ref = any(v_source_refs);

  select
    array_agg(distinct lower(trim(coalesce(b.status, '')))),
    array_agg(distinct lower(trim(coalesce(b.payment_status, '')))),
    array_agg(distinct lower(trim(coalesce(b.payment_method, '')))),
    array_agg(distinct coalesce(b.host_booking, false)),
    array_agg(distinct coalesce(b.host_user_id::text, '')),
    array_agg(distinct lower(trim(coalesce(b.email, '')))),
    array_agg(distinct lower(regexp_replace(trim(coalesce(b.full_name, '')), '\s+', ' ', 'g'))),
    array_agg(distinct regexp_replace(coalesce(b.contact_number, ''), '[^0-9]', '', 'g')),
    array_agg(distinct public.normalize_payment_reference_key(
      lower(trim(coalesce(b.payment_method, ''))),
      b.gcash_ref
    ))
    into
      v_target_statuses,
      v_target_payment_statuses,
      v_target_methods,
      v_target_hosts,
      v_target_host_ids,
      v_target_emails,
      v_target_names,
      v_target_contacts,
      v_target_reference_keys
    from public.bookings b
   where b.ref = any(v_target_refs);

  if cardinality(v_source_statuses) <> 1
     or v_source_statuses[1] <> 'cancelled' then
    raise exception 'The source booking must remain completely cancelled.'
      using errcode = '22023';
  end if;
  if cardinality(v_source_payment_statuses) <> 1
     or v_source_payment_statuses[1] not in
       ('unpaid', 'for_verification', 'paid', 'downpayment_paid') then
    raise exception 'The cancelled source must contain one reviewable or accepted payment.'
      using errcode = '22023';
  end if;
  if cardinality(v_target_statuses) <> 1
     or v_target_statuses[1] not in ('pending', 'verifying') then
    raise exception 'The replacement booking is no longer awaiting confirmation.'
      using errcode = '22023';
  end if;
  if cardinality(v_target_payment_statuses) <> 1
     or v_target_payment_statuses[1] <> 'for_verification' then
    raise exception 'The replacement payment must still be For Verification.'
      using errcode = '22023';
  end if;
  if cardinality(v_source_methods) <> 1
     or cardinality(v_target_methods) <> 1
     or v_source_methods[1] is distinct from v_target_methods[1]
     or v_source_methods[1] not in
       ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb') then
    raise exception 'Source and replacement payment providers must match.'
      using errcode = '22023';
  end if;
  if cardinality(v_source_reference_keys) <> 1
     or cardinality(v_target_reference_keys) <> 1
     or v_source_reference_keys[1] is distinct from v_target_reference_keys[1] then
    raise exception 'Source and replacement payment references must match exactly.'
      using errcode = '22023';
  end if;

  v_source_status := v_source_statuses[1];
  v_target_status := v_target_statuses[1];
  v_source_payment_status := v_source_payment_statuses[1];
  v_target_old_payment_status := v_target_payment_statuses[1];
  v_method := v_source_methods[1];
  v_reference_key := v_source_reference_keys[1];
  v_source_host := v_source_hosts[1];
  v_target_host := v_target_hosts[1];
  v_source_scope := case when v_source_group_ref is null then 'booking' else 'booking_group' end;
  v_target_scope := case when v_target_group_ref is null then 'booking' else 'booking_group' end;

  if cardinality(v_source_hosts) <> 1
     or cardinality(v_target_hosts) <> 1
     or v_source_host is distinct from v_target_host
     or cardinality(v_source_host_ids) <> 1
     or cardinality(v_target_host_ids) <> 1
     or v_source_host_ids[1] is distinct from v_target_host_ids[1] then
    raise exception 'Source and replacement booking ownership must match.'
      using errcode = '22023';
  end if;
  if cardinality(v_source_emails) <> 1
     or cardinality(v_target_emails) <> 1
     or nullif(v_source_emails[1], '') is null
     or v_source_emails[1] is distinct from v_target_emails[1]
     or cardinality(v_source_names) <> 1
     or cardinality(v_target_names) <> 1
     or nullif(v_source_names[1], '') is null
     or v_source_names[1] is distinct from v_target_names[1]
     or cardinality(v_source_contacts) <> 1
     or cardinality(v_target_contacts) <> 1
     or v_source_contacts[1] is distinct from v_target_contacts[1] then
    raise exception 'Source and replacement must belong to the same player.'
      using errcode = '22023';
  end if;

  select
    count(*)::integer,
    count(*) filter (
      where b.total is null
         or b.total <= 0
         or b.downpayment is null
         or b.downpayment <= 0
         or b.downpayment > b.total + 0.01
    )::integer,
    round(coalesce(sum(b.total), 0)::numeric, 2),
    round(coalesce(sum(b.downpayment), 0)::numeric, 2),
    min(b.paid_at),
    count(b.paid_at)::integer,
    count(b.booking_fee_earned_at)::integer
    into
      v_source_row_count,
      v_source_invalid_amount_count,
      v_source_total,
      v_source_amount,
      v_paid_at,
      v_source_paid_at_count,
      v_source_fee_earned_count
    from public.bookings b
   where b.ref = any(v_source_refs);

  select
    count(*)::integer,
    count(*) filter (
      where b.total is null
         or b.total <= 0
         or b.downpayment is null
         or b.downpayment <= 0
         or b.downpayment > b.total + 0.01
    )::integer,
    count(*) filter (where abs(b.downpayment - b.total) <= 0.01)::integer,
    count(*) filter (where b.downpayment < b.total - 0.01)::integer,
    round(coalesce(sum(b.total), 0)::numeric, 2),
    round(coalesce(sum(b.downpayment), 0)::numeric, 2)
    into
      v_target_row_count,
      v_target_invalid_amount_count,
      v_target_full_count,
      v_target_partial_count,
      v_target_total,
      v_target_amount
    from public.bookings b
   where b.ref = any(v_target_refs);

  if v_source_invalid_amount_count <> 0
     or v_target_invalid_amount_count <> 0
     or v_source_row_count <> v_target_row_count
     or v_source_total is distinct from v_target_total
     or v_source_amount is distinct from v_target_amount then
    raise exception 'Source and replacement payment amounts or group sizes do not match.'
      using errcode = '22023';
  end if;

  select array_agg(signature order by signature)
    into v_source_signatures
    from (
      select concat_ws('|',
        round(b.total::numeric, 2)::text,
        round(b.downpayment::numeric, 2)::text,
        coalesce(b.duration, cardinality(b.slots), 0)::text,
        cardinality(coalesce(b.slots, array[]::text[]))::text,
        coalesce(round(b.booking_fee_amount_snapshot::numeric, 2)::text, ''),
        coalesce(round(b.booking_fee_rate_snapshot::numeric, 2)::text, ''),
        coalesce(b.booking_fee_type_snapshot, ''),
        coalesce(b.booking_fee_units_snapshot::text, ''),
        coalesce(b.booking_fee_ledger_eligible_snapshot, false)::text
      ) as signature
      from public.bookings b
      where b.ref = any(v_source_refs)
    ) source_financial_rows;

  select array_agg(signature order by signature)
    into v_target_signatures
    from (
      select concat_ws('|',
        round(b.total::numeric, 2)::text,
        round(b.downpayment::numeric, 2)::text,
        coalesce(b.duration, cardinality(b.slots), 0)::text,
        cardinality(coalesce(b.slots, array[]::text[]))::text,
        coalesce(round(b.booking_fee_amount_snapshot::numeric, 2)::text, ''),
        coalesce(round(b.booking_fee_rate_snapshot::numeric, 2)::text, ''),
        coalesce(b.booking_fee_type_snapshot, ''),
        coalesce(b.booking_fee_units_snapshot::text, ''),
        coalesce(b.booking_fee_ledger_eligible_snapshot, false)::text
      ) as signature
      from public.bookings b
      where b.ref = any(v_target_refs)
    ) target_financial_rows;

  if v_source_signatures is distinct from v_target_signatures then
    raise exception 'Source and replacement court-hour and fee snapshots do not match.'
      using errcode = '22023';
  end if;

  if v_target_full_count = v_target_row_count then
    v_target_payment_status := 'paid';
  elsif v_target_host
        and v_target_partial_count = v_target_row_count then
    if exists (
      select 1
      from public.bookings b
      where b.ref = any(v_target_refs)
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
      raise exception 'The replacement host payment is lower than the required amount.'
        using errcode = '22023';
    end if;
    v_target_payment_status := 'downpayment_paid';
  else
    raise exception 'The replacement payment amount cannot be accepted as stored.'
      using errcode = '22023';
  end if;

  if v_source_payment_status in ('paid', 'downpayment_paid')
     and v_source_payment_status <> v_target_payment_status then
    raise exception 'The accepted source payment state does not match the replacement amount.'
      using errcode = '22023';
  end if;
  if v_source_payment_status in ('paid', 'downpayment_paid')
     and (
       v_paid_at is null
       or v_source_paid_at_count <> v_source_row_count
       or v_source_fee_earned_count <> v_source_row_count
     ) then
    raise exception 'The accepted source payment has no durable paid timestamp.'
      using errcode = '22023';
  end if;
  -- A legacy dashboard cancellation could leave a genuinely accepted payment
  -- labelled unpaid. Admit that historical shape only when every source row has
  -- both server-earned fee evidence and a paid timestamp; ledger ownership is
  -- independently required below before anything is changed.
  if v_source_payment_status = 'unpaid'
     and (
       v_paid_at is null
       or v_source_paid_at_count <> v_source_row_count
       or v_source_fee_earned_count <> v_source_row_count
     ) then
    raise exception 'An unpaid cancelled source lacks durable prior-acceptance evidence.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.bookings b
    where b.ref = any(v_all_refs)
      and (
        b.payment_transfer_id is not null
        or b.payment_reassigned_from_ref is not null
        or b.payment_reassigned_to_ref is not null
        or lower(trim(coalesce(b.receipt_status, 'none'))) = 'rejected'
      )
  ) then
    raise exception 'A previously transferred or rejected receipt cannot be moved.'
      using errcode = '22023';
  end if;

  select
    min(nullif(trim(b.receipt_image_hash), '')),
    count(distinct nullif(trim(b.receipt_image_hash), ''))::integer,
    min(nullif(trim(b.receipt_phash), '')),
    count(distinct nullif(trim(b.receipt_phash), ''))::integer
    into
      v_source_hash,
      v_source_hash_count,
      v_source_phash,
      v_source_phash_count
    from public.bookings b
   where b.ref = any(v_source_refs);
  select
    min(nullif(trim(b.receipt_image_hash), '')),
    count(distinct nullif(trim(b.receipt_image_hash), ''))::integer,
    min(nullif(trim(b.receipt_phash), '')),
    count(distinct nullif(trim(b.receipt_phash), ''))::integer
    into
      v_target_hash,
      v_target_hash_count,
      v_target_phash,
      v_target_phash_count
    from public.bookings b
   where b.ref = any(v_target_refs);

  if v_source_hash_count > 1 or v_target_hash_count > 1
     or v_source_phash_count > 1 or v_target_phash_count > 1
     or not (
       (
         v_source_hash is not null
         and v_target_hash is not null
         and v_source_hash = v_target_hash
       )
       or (
         v_source_phash is not null
         and v_target_phash is not null
         and v_source_phash = v_target_phash
       )
     ) then
    raise exception 'Source and replacement must contain the same stored receipt evidence.'
      using errcode = '22023';
  end if;

  -- Any balance-payment attempt introduces a second financial instrument and
  -- makes an initial-payment move ambiguous, even if that attempt later failed.
  if exists (
    select 1
    from public.host_booking_balance_payments balance_payment
    where balance_payment.booking_ref = any(v_all_refs)
       or balance_payment.booking_refs && v_all_refs
       or balance_payment.booking_group_ref in (v_source_group_ref, v_target_group_ref)
  ) then
    raise exception 'A booking with Payment 2 or balance history cannot move its initial payment.'
      using errcode = '22023';
  end if;

  -- A prepared, submitted, released, or settled remittance is permanent. The
  -- move is intentionally limited to fees that have never entered a batch.
  if exists (
    select 1
    from public.booking_fee_remittance_items item
    where item.booking_ref = any(v_all_refs)
  ) or exists (
    select 1
    from public.bookings b
    where b.ref = any(v_all_refs)
      and (b.weekly_fee_id is not null or b.billed_at is not null)
  ) or exists (
    select 1
    from public.weekly_fees fee
    where exists (
      select 1
      from unnest(v_all_refs) booking_ref_value
      where coalesce(fee.billed_refs, '[]'::jsonb)
        @> jsonb_build_array(booking_ref_value)
    )
  ) then
    raise exception 'A remitted or prepared booking payment cannot be moved.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.booking_payment_transfers transfer
    where transfer.source_booking_refs && v_all_refs
       or transfer.target_booking_refs && v_all_refs
  ) then
    raise exception 'One of these bookings already has payment transfer history.'
      using errcode = '22023';
  end if;

  -- Do not let a deliberately supplied source/target pair hide a third booking
  -- or another product flow that already carries the same typed reference.
  if exists (
    select 1
    from public.bookings other_booking
    where not (other_booking.ref = any(v_all_refs))
      and lower(trim(coalesce(other_booking.payment_method, ''))) = v_method
      and (
        case
          when v_method = 'gcash' then
            regexp_replace(coalesce(other_booking.gcash_ref, ''), '[^0-9]', '', 'g')
          else v_method || ':' || upper(regexp_replace(
            coalesce(other_booking.gcash_ref, ''),
            '[^A-Za-z0-9]',
            '',
            'g'
          ))
        end
      ) = v_reference_key
  ) or exists (
    select 1
    from public.open_play_registrations registration
    where lower(trim(coalesce(registration.payment_method, ''))) = v_method
      and (
        case
          when v_method = 'gcash' then
            regexp_replace(coalesce(registration.gcash_ref, ''), '[^0-9]', '', 'g')
          else v_method || ':' || upper(regexp_replace(
            coalesce(registration.gcash_ref, ''),
            '[^A-Za-z0-9]',
            '',
            'g'
          ))
        end
      ) = v_reference_key
  ) or exists (
    select 1
    from public.open_play_host_session_registrations registration
    where lower(trim(coalesce(registration.payment_method, ''))) = v_method
      and (
        case
          when v_method = 'gcash' then
            regexp_replace(coalesce(registration.gcash_ref, ''), '[^0-9]', '', 'g')
          else v_method || ':' || upper(regexp_replace(
            coalesce(registration.gcash_ref, ''),
            '[^A-Za-z0-9]',
            '',
            'g'
          ))
        end
      ) = v_reference_key
  ) or exists (
    select 1
    from public.host_booking_balance_payments balance_payment
    where lower(trim(coalesce(balance_payment.payment_provider, ''))) = v_method
      and public.normalize_payment_reference_key(
        balance_payment.payment_provider,
        balance_payment.payment_reference
      ) = v_reference_key
  ) then
    raise exception 'This payment reference is also attached to a third payment.'
      using errcode = '23505';
  end if;

  -- Use every canonical and payment-rail replay key emitted for either copy of
  -- the same receipt. Flags and verification rows remain untouched.
  select array_agg(distinct evidence.ledger_key order by evidence.ledger_key)
    into v_evidence_keys
    from (
      select v_reference_key as ledger_key, v_method as provider_key
      union all
      select keys.ledger_key, lower(keys.provider_key)
      from public.bookings b
      cross join lateral public.payment_review_ledger_keys(
        coalesce(b.receipt_extracted, '{}'::jsonb),
        v_method,
        b.gcash_ref
      ) keys
      where b.ref = any(v_all_refs)
    ) evidence
   where nullif(trim(coalesce(evidence.ledger_key, '')), '') is not null;

  if v_evidence_keys is null
     or not (v_reference_key = any(v_evidence_keys)) then
    raise exception 'The stored receipt has no canonical payment evidence.'
      using errcode = '22023';
  end if;

  foreach v_evidence_key in array v_evidence_keys
  loop
    if char_length(v_evidence_key) > 240 then
      raise exception 'The stored receipt contains an invalid replay key.'
        using errcode = '22023';
    end if;

    select
      min(evidence.provider_key),
      count(distinct evidence.provider_key)::integer
      into v_evidence_provider, v_evidence_provider_count
      from (
        select v_method as provider_key
        where v_evidence_key = v_reference_key
        union all
        select lower(keys.provider_key)
        from public.bookings b
        cross join lateral public.payment_review_ledger_keys(
          coalesce(b.receipt_extracted, '{}'::jsonb),
          v_method,
          b.gcash_ref
        ) keys
        where b.ref = any(v_all_refs)
          and keys.ledger_key = v_evidence_key
      ) evidence;
    if v_evidence_provider_count <> 1
       or nullif(trim(coalesce(v_evidence_provider, '')), '') is null
       or char_length(v_evidence_provider) > 80 then
      raise exception 'The stored receipt has inconsistent replay-key providers.'
        using errcode = '22023';
    end if;

    v_incumbent_scope := null;
    v_incumbent_owner := null;
    v_incumbent_provider := null;
    select ledger.claim_scope, ledger.claim_owner_id, ledger.provider
      into v_incumbent_scope, v_incumbent_owner, v_incumbent_provider
      from public.used_gcash_refs ledger
     where ledger.gcash_ref = v_evidence_key
     for update;
    v_ledger_found := found;

    if not v_ledger_found then
      -- An already-accepted source must own the canonical typed reference.
      -- Older confirmations did not always claim later-added OCR/rail keys, so
      -- an unclaimed auxiliary key may be completed here. A third-party owner
      -- remains a hard collision in the branch below.
      if v_evidence_key = v_reference_key
         and v_source_payment_status in ('unpaid', 'paid', 'downpayment_paid') then
        raise exception 'The accepted source does not own its canonical payment reference.'
          using errcode = '22023';
      end if;
      insert into public.used_gcash_refs (
        gcash_ref,
        booking_ref,
        provider,
        claim_scope,
        claim_owner_id
      ) values (
        v_evidence_key,
        v_target_requested,
        v_evidence_provider,
        v_target_scope,
        v_target_key
      )
      on conflict (gcash_ref) do nothing;

      select ledger.claim_scope, ledger.claim_owner_id, ledger.provider
        into v_incumbent_scope, v_incumbent_owner, v_incumbent_provider
        from public.used_gcash_refs ledger
       where ledger.gcash_ref = v_evidence_key
       for update;
      if not found
         or v_incumbent_scope is distinct from v_target_scope
         or v_incumbent_owner is distinct from v_target_key then
        raise exception 'This receipt or payment-rail reference belongs to another payment.'
          using errcode = '23505';
      end if;
    elsif v_incumbent_scope = v_source_scope
          and v_incumbent_owner = v_source_key then
      if lower(trim(coalesce(v_incumbent_provider, ''))) is distinct from
         lower(trim(v_evidence_provider)) then
        raise exception 'The source payment ledger provider is inconsistent.'
          using errcode = '22023';
      end if;
      update public.used_gcash_refs ledger
         set booking_ref = v_target_requested,
             claim_scope = v_target_scope,
             claim_owner_id = v_target_key
       where ledger.gcash_ref = v_evidence_key
         and ledger.claim_scope = v_source_scope
         and ledger.claim_owner_id = v_source_key;
      if not found then
        raise exception 'The payment reference owner changed during transfer.'
          using errcode = '40001';
      end if;
    else
      raise exception 'This receipt or payment-rail reference belongs to another payment.'
        using errcode = '23505';
    end if;
  end loop;

  insert into public.booking_payment_transfers (
    id,
    idempotency_key,
    source_booking_ref,
    source_booking_group_ref,
    target_booking_ref,
    target_booking_group_ref,
    source_booking_refs,
    target_booking_refs,
    payment_method,
    payment_reference_key,
    evidence_ledger_keys,
    amount,
    source_payment_status,
    target_payment_status,
    reason,
    no_refund_confirmed,
    actor_user_id,
    actor_role,
    created_at
  ) values (
    v_transfer_id,
    p_idempotency_key,
    v_source_requested,
    v_source_group_ref,
    v_target_requested,
    v_target_group_ref,
    v_source_refs,
    v_target_refs,
    v_method,
    v_reference_key,
    v_evidence_keys,
    v_target_amount,
    v_source_payment_status,
    v_target_payment_status,
    v_reason,
    true,
    auth.uid(),
    v_actor_role,
    v_transfer_time
  );

  perform set_config(
    'paddle_rage.booking_payment_transfer_id',
    v_transfer_id::text,
    true
  );

  update public.bookings b
     set payment_transfer_id = v_transfer_id,
         payment_reassigned_to_ref = v_target_requested
   where b.ref = any(v_source_refs)
     and b.status = v_source_status
     and b.payment_status = v_source_payment_status
     and b.payment_transfer_id is null;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> cardinality(v_source_refs) then
    raise exception 'Source booking state changed before the transfer could commit.'
      using errcode = '40001';
  end if;

  update public.bookings b
     set status = 'confirmed',
         payment_status = v_target_payment_status,
         paid_at = coalesce(v_paid_at, v_transfer_time),
         payment_transfer_id = v_transfer_id,
         payment_reassigned_from_ref = v_source_requested
   where b.ref = any(v_target_refs)
     and b.status = v_target_status
     and b.payment_status = v_target_old_payment_status
     and b.payment_transfer_id is null;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> cardinality(v_target_refs) then
    raise exception 'Replacement booking state changed before the transfer could commit.'
      using errcode = '40001';
  end if;

  return query
  select
    true,
    v_transfer_id,
    v_source_requested,
    v_target_requested,
    'confirmed'::text,
    v_target_payment_status,
    v_source_refs,
    v_target_refs;
end;
$$;

revoke all on function public.transfer_cancelled_booking_payment(
  text, text, text, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.transfer_cancelled_booking_payment(
  text, text, text, boolean, uuid
) to authenticated;

comment on function public.transfer_cancelled_booking_payment(
  text, text, text, boolean, uuid
) is
  'Atomically moves one matching digital receipt claim from a complete cancelled booking to the same player replacement, confirms the replacement, and records a permanent no-refund audit. Active owner/court-owner only.';

-- --------------------------------------------------------------------------
-- 3. Count exactly one platform allocation after a transfer
-- --------------------------------------------------------------------------

-- The cancelled source keeps its immutable earned timestamp and receipt facts.
-- The replacement earns its own immutable timestamp when confirmed above. This
-- canonical query excludes only the transferred-out source, so the target is
-- the single unclaimed fee while every original financial fact remains intact.
create or replace function public.booking_fee_unclaimed_rows()
returns table (
  booking_ref text,
  booking_group_ref text,
  booking_created_at timestamptz,
  fee_earned_at timestamptz,
  court_id text,
  court_name text,
  booking_date date,
  host_booking boolean,
  created_via text,
  fee_amount numeric,
  fee_rate numeric,
  fee_type text,
  fee_units numeric,
  fee_snapshot_source text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    b.ref,
    b.booking_group_ref,
    b.created_at,
    b.booking_fee_earned_at,
    b.court_id,
    b.court_name,
    b.date,
    coalesce(b.host_booking, false),
    b.created_via,
    b.booking_fee_amount_snapshot,
    b.booking_fee_rate_snapshot,
    b.booking_fee_type_snapshot,
    b.booking_fee_units_snapshot,
    b.booking_fee_snapshot_source
  from public.bookings b
  where b.booking_fee_earned_at is not null
    and b.booking_fee_amount_snapshot is not null
    and b.booking_fee_amount_snapshot > 0
    and b.booking_fee_rate_snapshot is not null
    and b.booking_fee_type_snapshot in ('flat', 'per_hour')
    and b.booking_fee_units_snapshot is not null
    and b.booking_fee_snapshot_source is not null
    and b.booking_fee_ledger_eligible_snapshot
    and b.weekly_fee_id is null
    and b.billed_at is null
    and not exists (
      select 1
      from public.weekly_fees wf
      where wf.status = 'paid'
        and coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(b.ref)
    )
    and not exists (
      select 1
      from public.booking_fee_remittance_items item
      where item.booking_ref = b.ref
        and item.released_at is null
    )
    and not exists (
      select 1
      from public.booking_payment_transfers transfer
      where b.ref = any(transfer.source_booking_refs)
    )
  order by b.booking_fee_earned_at, b.created_at, b.ref
$$;

comment on function public.booking_fee_unclaimed_rows() is
  'Returns unclaimed immutable booking-fee snapshots, excluding only audited transferred-out source rows so a moved payment creates exactly one platform allocation.';

notify pgrst, 'reload schema';

commit;
