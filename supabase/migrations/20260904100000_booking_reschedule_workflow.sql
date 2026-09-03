-- Durable guest reschedule requests.
--
-- A request never edits or reserves the live booking schedule.  Only an
-- authenticated owner/court owner can approve it, and approval re-validates
-- the immutable snapshot plus every destination slot under transaction locks.
-- Customer payment fields and booking references are deliberately untouched.

begin;

create table if not exists public.booking_reschedule_requests (
  id uuid primary key default gen_random_uuid(),
  anchor_booking_ref text not null,
  booking_group_ref text,
  booking_family_key text not null,
  selected_booking_refs text[] not null,
  customer_name text not null,
  customer_email text not null,
  old_snapshot jsonb not null,
  requested_snapshot jsonb not null,
  status text not null default 'pending',
  note text,
  acknowledged_no_refund boolean not null,
  acknowledged_slot_not_held boolean not null,
  reviewed_by_user_id uuid,
  reviewed_by_role text,
  decision_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  withdrawn_at timestamptz,
  conflicted_at timestamptz,
  superseded_at timestamptz,
  constraint booking_reschedule_requests_status_check check (
    status in (
      'pending', 'approved', 'rejected', 'withdrawn', 'conflicted', 'superseded'
    )
  ),
  constraint booking_reschedule_requests_family_check check (
    char_length(booking_family_key) between 3 and 160
  ),
  constraint booking_reschedule_requests_refs_check check (
    cardinality(selected_booking_refs) between 1 and 8
  ),
  constraint booking_reschedule_requests_email_check check (
    customer_email = lower(btrim(customer_email))
    and char_length(customer_email) between 3 and 254
  ),
  constraint booking_reschedule_requests_name_check check (
    char_length(btrim(customer_name)) between 1 and 150
  ),
  constraint booking_reschedule_requests_note_check check (
    note is null or char_length(note) <= 500
  ),
  constraint booking_reschedule_requests_snapshot_check check (
    jsonb_typeof(old_snapshot) = 'object'
    and jsonb_typeof(requested_snapshot) = 'object'
    and jsonb_typeof(old_snapshot->'items') = 'array'
    and jsonb_typeof(requested_snapshot->'items') = 'array'
  ),
  constraint booking_reschedule_requests_ack_check check (
    acknowledged_no_refund and acknowledged_slot_not_held
  ),
  constraint booking_reschedule_requests_review_role_check check (
    reviewed_by_role is null or reviewed_by_role in ('owner', 'court_owner')
  ),
  constraint booking_reschedule_requests_terminal_time_check check (
    (status <> 'approved' or approved_at is not null)
    and (status <> 'rejected' or rejected_at is not null)
    and (status <> 'withdrawn' or withdrawn_at is not null)
    and (status <> 'conflicted' or conflicted_at is not null)
    and (status <> 'superseded' or superseded_at is not null)
  )
);

comment on table public.booking_reschedule_requests is
  'Private reschedule workflow state. Old/requested schedule snapshots are immutable; only status/decision metadata may transition once from pending.';

create table if not exists public.booking_reschedule_request_items (
  request_id uuid not null
    references public.booking_reschedule_requests(id) on delete restrict,
  booking_ref text not null,
  booking_family_key text not null,
  old_court_id text not null,
  old_court_name text,
  old_date date not null,
  old_slots text[] not null,
  old_start_time text,
  old_end_time text,
  old_duration numeric not null,
  old_rate numeric,
  old_total numeric,
  old_status text not null,
  old_schedule_fingerprint text not null,
  requested_date date not null,
  requested_slots text[] not null,
  requested_start_time text not null,
  requested_end_time text not null,
  requested_duration numeric not null,
  requested_rate numeric,
  requested_total numeric,
  created_at timestamptz not null default now(),
  primary key (request_id, booking_ref),
  constraint booking_reschedule_items_fingerprint_check check (
    old_schedule_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint booking_reschedule_items_duration_check check (
    old_duration > 0
    and requested_duration = old_duration
    and cardinality(old_slots) = old_duration
    and cardinality(requested_slots) = requested_duration
  ),
  constraint booking_reschedule_items_court_price_check check (
    requested_rate is not distinct from old_rate
    and requested_total is not distinct from old_total
  )
);

comment on table public.booking_reschedule_request_items is
  'Immutable per-booking old and requested schedules. Court, duration, rate, and total remain identical.';

-- This narrow assignment table makes the no-overlapping-pending-request rule
-- a database uniqueness guarantee without mutating historical item rows.
create table if not exists public.booking_reschedule_active_items (
  booking_ref text primary key,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  constraint booking_reschedule_active_item_request_fk
    foreign key (request_id, booking_ref)
    references public.booking_reschedule_request_items(request_id, booking_ref)
    on delete restrict
);

create table if not exists public.booking_reschedule_events (
  id bigserial primary key,
  request_id uuid not null
    references public.booking_reschedule_requests(id) on delete restrict,
  event_type text not null,
  from_status text,
  to_status text not null,
  actor_type text not null,
  actor_user_id uuid,
  actor_role text,
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint booking_reschedule_events_type_check check (
    event_type in (
      'submitted', 'approved', 'rejected', 'withdrawn', 'conflicted',
      'superseded'
    )
  ),
  constraint booking_reschedule_events_status_check check (
    (from_status is null or from_status in (
      'pending', 'approved', 'rejected', 'withdrawn', 'conflicted', 'superseded'
    ))
    and to_status in (
      'pending', 'approved', 'rejected', 'withdrawn', 'conflicted', 'superseded'
    )
  ),
  constraint booking_reschedule_events_actor_check check (
    actor_type in ('guest', 'operator', 'system')
    and (actor_role is null or actor_role in ('owner', 'court_owner', 'system'))
  ),
  constraint booking_reschedule_events_details_check check (
    jsonb_typeof(details) = 'object'
  )
);

comment on table public.booking_reschedule_events is
  'Append-only audit history for every reschedule request transition.';

create table if not exists public.booking_reschedule_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.booking_reschedule_requests(id) on delete restrict,
  event_id bigint not null
    references public.booking_reschedule_events(id) on delete restrict,
  notification_kind text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_reschedule_outbox_kind_check check (
    notification_kind in (
      'customer_request_received', 'admin_review_needed',
      'customer_approved', 'customer_rejected', 'customer_withdrawn',
      'customer_conflicted'
    )
  ),
  constraint booking_reschedule_outbox_status_check check (
    status in ('pending', 'processing', 'sent', 'failed', 'cancelled')
  ),
  constraint booking_reschedule_outbox_attempts_check check (
    attempts between 0 and 20
  ),
  constraint booking_reschedule_outbox_lease_check check (
    (status = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'processing' and lease_token is null and lease_expires_at is null)
  ),
  constraint booking_reschedule_outbox_sent_check check (
    status <> 'sent' or sent_at is not null
  ),
  constraint booking_reschedule_outbox_cancelled_check check (
    status <> 'cancelled' or cancelled_at is not null
  ),
  constraint booking_reschedule_outbox_unique
    unique (request_id, event_id, notification_kind)
);

comment on table public.booking_reschedule_notification_outbox is
  'Private retryable outbox; notification failure never rolls back the request or an approved schedule move.';

create table if not exists public.booking_reschedule_notification_recipients (
  notification_id uuid not null
    references public.booking_reschedule_notification_outbox(id) on delete restrict,
  recipient_key text not null,
  attempts integer not null default 0,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (notification_id, recipient_key),
  constraint booking_reschedule_recipient_key_check check (
    recipient_key ~ '^[0-9a-f]{64}$'
  ),
  constraint booking_reschedule_recipient_attempts_check check (
    attempts between 0 and 20
  )
);

comment on table public.booking_reschedule_notification_recipients is
  'Per-Telegram-recipient delivery progress keyed by an Edge-computed HMAC-SHA256 fingerprint. Raw chat ids are never stored.';

create index if not exists idx_booking_reschedule_requests_status_created
  on public.booking_reschedule_requests(status, created_at desc);
create index if not exists idx_booking_reschedule_requests_family_created
  on public.booking_reschedule_requests(booking_family_key, created_at desc);
create unique index if not exists booking_reschedule_one_pending_family_uq
  on public.booking_reschedule_requests(booking_family_key)
  where status = 'pending';
create index if not exists idx_booking_reschedule_events_request_created
  on public.booking_reschedule_events(request_id, created_at, id);
create index if not exists idx_booking_reschedule_outbox_claim
  on public.booking_reschedule_notification_outbox(available_at, created_at)
  where status in ('pending', 'failed', 'processing') and attempts < 20;

alter table public.booking_reschedule_requests enable row level security;
alter table public.booking_reschedule_request_items enable row level security;
alter table public.booking_reschedule_active_items enable row level security;
alter table public.booking_reschedule_events enable row level security;
alter table public.booking_reschedule_notification_outbox enable row level security;
alter table public.booking_reschedule_notification_recipients enable row level security;

-- No browser role receives direct table privileges.  Every read/mutation goes
-- through the purpose-specific SECURITY DEFINER RPCs below.
revoke all on table public.booking_reschedule_requests
  from public, anon, authenticated, service_role;
revoke all on table public.booking_reschedule_request_items
  from public, anon, authenticated, service_role;
revoke all on table public.booking_reschedule_active_items
  from public, anon, authenticated, service_role;
revoke all on table public.booking_reschedule_events
  from public, anon, authenticated, service_role;
revoke all on table public.booking_reschedule_notification_outbox
  from public, anon, authenticated, service_role;
revoke all on table public.booking_reschedule_notification_recipients
  from public, anon, authenticated, service_role;
revoke all on sequence public.booking_reschedule_events_id_seq
  from public, anon, authenticated, service_role;

create or replace function public.guard_booking_reschedule_request_history()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Reschedule request history cannot be deleted.'
      using errcode = '42501';
  end if;

  if new.id is distinct from old.id
     or new.anchor_booking_ref is distinct from old.anchor_booking_ref
     or new.booking_group_ref is distinct from old.booking_group_ref
     or new.booking_family_key is distinct from old.booking_family_key
     or new.selected_booking_refs is distinct from old.selected_booking_refs
     or new.customer_name is distinct from old.customer_name
     or new.customer_email is distinct from old.customer_email
     or new.old_snapshot is distinct from old.old_snapshot
     or new.requested_snapshot is distinct from old.requested_snapshot
     or new.note is distinct from old.note
     or new.acknowledged_no_refund is distinct from old.acknowledged_no_refund
     or new.acknowledged_slot_not_held is distinct from old.acknowledged_slot_not_held
     or new.created_at is distinct from old.created_at then
    raise exception 'Reschedule request evidence is immutable.'
      using errcode = '42501';
  end if;

  if old.status <> 'pending'
     or new.status not in (
       'approved', 'rejected', 'withdrawn', 'conflicted', 'superseded'
     ) then
    raise exception 'Invalid reschedule request transition.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists z90_guard_booking_reschedule_request_history
  on public.booking_reschedule_requests;
create trigger z90_guard_booking_reschedule_request_history
before update or delete on public.booking_reschedule_requests
for each row execute function public.guard_booking_reschedule_request_history();

create or replace function public.deny_booking_reschedule_audit_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Reschedule audit rows are append-only.' using errcode = '42501';
end;
$$;

drop trigger if exists z90_deny_booking_reschedule_item_mutation
  on public.booking_reschedule_request_items;
create trigger z90_deny_booking_reschedule_item_mutation
before update or delete on public.booking_reschedule_request_items
for each row execute function public.deny_booking_reschedule_audit_mutation();

drop trigger if exists z90_deny_booking_reschedule_event_mutation
  on public.booking_reschedule_events;
create trigger z90_deny_booking_reschedule_event_mutation
before update or delete on public.booking_reschedule_events
for each row execute function public.deny_booking_reschedule_audit_mutation();

drop trigger if exists z90_deny_booking_reschedule_request_truncate
  on public.booking_reschedule_requests;
create trigger z90_deny_booking_reschedule_request_truncate
before truncate on public.booking_reschedule_requests
for each statement execute function public.deny_booking_reschedule_audit_mutation();

drop trigger if exists z90_deny_booking_reschedule_item_truncate
  on public.booking_reschedule_request_items;
create trigger z90_deny_booking_reschedule_item_truncate
before truncate on public.booking_reschedule_request_items
for each statement execute function public.deny_booking_reschedule_audit_mutation();

drop trigger if exists z90_deny_booking_reschedule_event_truncate
  on public.booking_reschedule_events;
create trigger z90_deny_booking_reschedule_event_truncate
before truncate on public.booking_reschedule_events
for each statement execute function public.deny_booking_reschedule_audit_mutation();

create or replace function public.booking_reschedule_operator_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select account.role
  from public.accounts account
  where account.id = auth.uid()
    and account.status = 'active'
    and account.role in ('owner', 'court_owner')
  limit 1
$$;

create or replace function public.booking_reschedule_hour_label(p_hour integer)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select to_char(
    time '00:00' + ((coalesce(p_hour, 0) % 24 + 24) % 24) * interval '1 hour',
    'FMHH12:MI AM'
  )
$$;

create or replace function public.booking_reschedule_schedule_fingerprint(
  p_court_id text,
  p_date date,
  p_slots text[],
  p_duration numeric,
  p_rate numeric,
  p_total numeric,
  p_status text
)
returns text
language sql
immutable
security definer
set search_path = public, extensions, pg_temp
as $$
  select encode(
    extensions.digest(
      concat_ws(
        E'\x1f',
        coalesce(p_court_id, ''),
        coalesce(p_date::text, ''),
        coalesce(array_to_string(p_slots, E'\x1e'), ''),
        coalesce(p_duration::text, ''),
        coalesce(p_rate::text, ''),
        coalesce(p_total::text, ''),
        coalesce(p_status, '')
      ),
      'sha256'
    ),
    'hex'
  )
$$;

revoke all on function public.booking_reschedule_operator_role()
  from public, anon, authenticated;
revoke all on function public.booking_reschedule_hour_label(integer)
  from public, anon, authenticated;
revoke all on function public.booking_reschedule_schedule_fingerprint(
  text, date, text[], numeric, numeric, numeric, text
) from public, anon, authenticated;

create or replace function public.booking_reschedule_guest_context(
  p_ref text,
  p_email text,
  p_access_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  requested_ref text := upper(btrim(coalesce(p_ref, '')));
  requested_email text := lower(btrim(coalesce(p_email, '')));
  token_hash text;
  anchor record;
  family_key text;
  family_refs text[];
  family_count integer;
  matching_count integer;
  latest_booking_date date;
  earliest_booking_created_at timestamptz;
begin
  if requested_ref !~ '^PB-[A-Z0-9_-]{3,76}$'
     or char_length(requested_email) < 3
     or char_length(requested_email) > 254
     or requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or coalesce(p_access_token, '') !~ '^[0-9a-fA-F]{64}$' then
    return null;
  end if;

  token_hash := encode(extensions.digest(p_access_token, 'sha256'), 'hex');

  select
    booking.ref,
    nullif(btrim(booking.booking_group_ref), '') as group_ref,
    booking.full_name
  into anchor
  from public.bookings booking
  where booking.customer_access_token_hash = token_hash
    and lower(btrim(coalesce(booking.email, ''))) = requested_email
    and (
      upper(booking.ref) = requested_ref
      or upper(coalesce(booking.booking_group_ref, '')) = requested_ref
      or upper(coalesce(booking.booking_group_ref, '')) = requested_ref || '-G'
      or regexp_replace(
        upper(coalesce(booking.booking_group_ref, '')), '-G$', ''
      ) = requested_ref
    )
  order by
    case when upper(booking.ref) = requested_ref then 0 else 1 end,
    booking.created_at,
    booking.ref
  limit 1;

  if anchor.ref is null then
    return null;
  end if;

  family_key := coalesce(anchor.group_ref, anchor.ref);

  select
    count(*)::integer,
    count(*) filter (
      where booking.customer_access_token_hash = token_hash
        and lower(btrim(coalesce(booking.email, ''))) = requested_email
    )::integer,
    array_agg(booking.ref order by booking.ref)
  into family_count, matching_count, family_refs
  from public.bookings booking
  where (
    anchor.group_ref is null and booking.ref = anchor.ref
  ) or (
    anchor.group_ref is not null and booking.booking_group_ref = anchor.group_ref
  );

  -- Refuse a malformed or mixed-identity group instead of returning a partial
  -- family to either the guest UI or a mutation RPC.
  if family_count < 1
     or family_count > 8
     or matching_count <> family_count then
    return null;
  end if;

  select max(booking.date), min(booking.created_at)
  into latest_booking_date, earliest_booking_created_at
  from public.bookings booking
  where booking.ref = any(family_refs)
    and booking.customer_access_token_hash = token_hash
    and lower(btrim(coalesce(booking.email, ''))) = requested_email;

  -- Match the existing Manage Booking proof lifetime: the browser token is
  -- useful around the visit and for short-term support, never as a permanent
  -- public booking-history credential.
  if latest_booking_date is null
     or latest_booking_date < (
       timezone('Asia/Manila', now())::date - 7
     )
     or earliest_booking_created_at is null
     or earliest_booking_created_at < now() - interval '400 days' then
    return null;
  end if;

  return jsonb_build_object(
    'anchorRef', anchor.ref,
    'bookingGroupRef', anchor.group_ref,
    'familyKey', family_key,
    'bookingRefs', to_jsonb(family_refs),
    'customerName', anchor.full_name,
    'customerEmail', requested_email,
    'tokenHash', token_hash
  );
end;
$$;

revoke all on function public.booking_reschedule_guest_context(text, text, text)
  from public, anon, authenticated;

create or replace function public.booking_reschedule_schedule_available(
  p_court_id text,
  p_date date,
  p_slots text[],
  p_exclude_refs text[] default '{}'::text[]
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  ph_now timestamp := timezone('Asia/Manila', statement_timestamp());
  ph_today date := ph_now::date;
  open_hour_text text;
  close_hour_text text;
  open_hour integer;
  close_hour integer;
  maintenance_text text;
  maintenance_config jsonb;
  maintenance_rules jsonb := '[]'::jsonb;
  maintenance_rule jsonb;
  slot_hour integer;
  rule_start integer;
  rule_end integer;
  rule_mode text;
  rule_matches boolean;
begin
  if nullif(btrim(coalesce(p_court_id, '')), '') is null
     or p_date is null
     or p_date < greatest(date '2026-09-19', ph_today)
     or p_date > ph_today + 366
     or coalesce(cardinality(p_slots), 0) < 1
     or cardinality(p_slots) > 24
     or exists (
       select 1 from unnest(coalesce(p_slots, '{}'::text[])) slot(value)
       where slot.value !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
     )
     or (
       select count(distinct slot.value)
       from unnest(coalesce(p_slots, '{}'::text[])) slot(value)
     ) <> cardinality(p_slots) then
    return false;
  end if;

  if not exists (
    select 1
    from public.courts court
    where court.id = p_court_id
      and coalesce(court.blocked, false) = false
  ) then
    return false;
  end if;

  select setting.value into open_hour_text
  from public.settings setting where setting.key = 'open_hour' limit 1;
  select setting.value into close_hour_text
  from public.settings setting where setting.key = 'close_hour' limit 1;

  if btrim(coalesce(open_hour_text, '')) !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
     or btrim(coalesce(close_hour_text, '')) !~ '^(?:[1-9]|1[0-9]|2[0-4])$' then
    raise exception 'Court operating hours are not configured correctly.'
      using errcode = '23514';
  end if;
  open_hour := btrim(open_hour_text)::integer;
  close_hour := btrim(close_hour_text)::integer;
  if close_hour <= open_hour
     or exists (
       select 1 from unnest(p_slots) slot(value)
       where slot.value::integer < open_hour
          or slot.value::integer >= close_hour
     ) then
    return false;
  end if;

  if exists (
    select 1 from public.blocked_dates blocked where blocked.date = p_date
  ) then
    return false;
  end if;

  if p_date = ph_today and exists (
    select 1 from unnest(p_slots) slot(value)
    where slot.value::integer <= extract(hour from ph_now)::integer
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.bookings occupied
    where occupied.court_id = p_court_id
      and occupied.date = p_date
      and not (occupied.ref = any(coalesce(p_exclude_refs, '{}'::text[])))
      and occupied.slots && p_slots
      and public.booking_occupies_slot(
        occupied.status,
        occupied.email,
        occupied.full_name,
        occupied.created_at
      )
  ) then
    return false;
  end if;

  select setting.value into maintenance_text
  from public.settings setting
  where setting.key = 'maintenance_config'
  limit 1;

  begin
    maintenance_config := coalesce(maintenance_text, '{"rules":[]}')::jsonb;
  exception when others then
    raise exception 'Maintenance schedule is not configured correctly.'
      using errcode = '23514';
  end;

  if jsonb_typeof(maintenance_config) <> 'object' then
    raise exception 'Maintenance schedule is not configured correctly.'
      using errcode = '23514';
  end if;
  if maintenance_config ? 'rules'
     and jsonb_typeof(maintenance_config->'rules') <> 'array' then
    raise exception 'Maintenance schedule is not configured correctly.'
      using errcode = '23514';
  elsif jsonb_typeof(maintenance_config->'rules') = 'array' then
    maintenance_rules := maintenance_config->'rules';
  elsif maintenance_config <> '{}'::jsonb then
    maintenance_rules := jsonb_build_array(maintenance_config);
  end if;

  for maintenance_rule in
    select rule.value from jsonb_array_elements(maintenance_rules) rule(value)
  loop
    if jsonb_typeof(maintenance_rule) <> 'object'
       or lower(coalesce(maintenance_rule->>'enabled', 'false'))
          not in ('true', '1', 'false', '0')
       or btrim(coalesce(maintenance_rule->>'start', ''))
          !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
       or btrim(coalesce(maintenance_rule->>'end', ''))
          !~ '^(?:[0-9]|1[0-9]|2[0-4])$'
       or (
         maintenance_rule ? 'courtIds'
         and jsonb_typeof(maintenance_rule->'courtIds') <> 'array'
       )
       or lower(coalesce(maintenance_rule->>'mode', 'specific'))
          not in ('specific', 'weekly', 'monthly') then
      raise exception 'Maintenance schedule is not configured correctly.'
        using errcode = '23514';
    end if;

    if lower(coalesce(maintenance_rule->>'enabled', 'false'))
       not in ('true', '1') then
      continue;
    end if;

    if jsonb_typeof(maintenance_rule->'courtIds') = 'array'
       and jsonb_array_length(maintenance_rule->'courtIds') > 0
       and not exists (
         select 1
         from jsonb_array_elements_text(maintenance_rule->'courtIds') configured(id)
         where configured.id = p_court_id
       ) then
      continue;
    end if;

    rule_mode := lower(coalesce(maintenance_rule->>'mode', 'specific'));
    rule_matches := false;
    if rule_mode = 'specific' then
      if jsonb_typeof(maintenance_rule->'dates') is distinct from 'array' then
        raise exception 'Maintenance schedule is not configured correctly.'
          using errcode = '23514';
      end if;
      rule_matches := exists (
        select 1
        from jsonb_array_elements_text(maintenance_rule->'dates') configured(value)
        where configured.value = p_date::text
      );
    elsif rule_mode = 'weekly' then
      if jsonb_typeof(maintenance_rule#>'{recurring,days}') is distinct from 'array'
         or exists (
           select 1
           from jsonb_array_elements_text(
             maintenance_rule#>'{recurring,days}'
           ) configured(value)
           where configured.value !~ '^[0-6]$'
         ) then
        raise exception 'Maintenance schedule is not configured correctly.'
          using errcode = '23514';
      end if;
      rule_matches := exists (
        select 1
        from jsonb_array_elements_text(
          maintenance_rule#>'{recurring,days}'
        ) configured(value)
        where configured.value::integer = extract(dow from p_date)::integer
      );
    else
      if btrim(coalesce(maintenance_rule#>>'{recurring,day}', ''))
         !~ '^(?:[1-9]|[12][0-9]|3[01])$' then
        raise exception 'Maintenance schedule is not configured correctly.'
          using errcode = '23514';
      end if;
      rule_matches :=
        btrim(maintenance_rule#>>'{recurring,day}')::integer =
        extract(day from p_date)::integer;
    end if;

    if not rule_matches then
      continue;
    end if;

    rule_start := btrim(maintenance_rule->>'start')::integer;
    rule_end := btrim(maintenance_rule->>'end')::integer;
    if rule_start = rule_end then
      continue;
    end if;

    for slot_hour in
      select slot.value::integer from unnest(p_slots) slot(value)
    loop
      if (rule_start < rule_end and slot_hour >= rule_start and slot_hour < rule_end)
         or (
           rule_start > rule_end
           and (slot_hour >= rule_start or slot_hour < rule_end)
         ) then
        return false;
      end if;
    end loop;
  end loop;

  return true;
end;
$$;

revoke all on function public.booking_reschedule_schedule_available(
  text, date, text[], text[]
) from public, anon, authenticated;

insert into public.settings (key, value, updated_at)
values
  ('reschedule_cutoff_hours', '24', now()),
  ('reschedule_submission_cooldown_seconds', '15', now())
on conflict (key) do nothing;

create or replace function public.booking_reschedule_request_payload(
  p_request_id uuid,
  p_include_private boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  request_row public.booking_reschedule_requests%rowtype;
  old_schedule jsonb;
  notification_summary jsonb;
  payload jsonb;
begin
  select request.* into request_row
  from public.booking_reschedule_requests request
  where request.id = p_request_id;

  if request_row.id is null then
    return null;
  end if;

  old_schedule := request_row.old_snapshot;
  if not p_include_private then
    old_schedule := jsonb_set(
      old_schedule,
      '{items}',
      coalesce((
        select jsonb_agg(item.value - 'scheduleFingerprint')
        from jsonb_array_elements(request_row.old_snapshot->'items') item(value)
      ), '[]'::jsonb)
    );
  end if;

  select jsonb_build_object(
    'pending', count(*) filter (where outbox.status = 'pending'),
    'processing', count(*) filter (where outbox.status = 'processing'),
    'sent', count(*) filter (where outbox.status = 'sent'),
    'failed', count(*) filter (where outbox.status = 'failed'),
    'cancelled', count(*) filter (where outbox.status = 'cancelled'),
    'retryable', count(*) filter (
      where outbox.status in ('pending', 'failed')
        and outbox.attempts < 20
    ),
    'exhausted', count(*) filter (
      where outbox.status = 'failed'
        and outbox.attempts >= 20
    )
  ) into notification_summary
  from public.booking_reschedule_notification_outbox outbox
  where outbox.request_id = request_row.id;

  payload := jsonb_build_object(
    'id', request_row.id,
    'bookingRef', request_row.anchor_booking_ref,
    'bookingGroupRef', request_row.booking_group_ref,
    'itemRefs', to_jsonb(request_row.selected_booking_refs),
    'status', request_row.status,
    'note', request_row.note,
    'requestedDate', request_row.requested_snapshot->>'requestedDate',
    'requestedSlots', request_row.requested_snapshot->'requestedSlots',
    'oldSchedule', old_schedule,
    'requestedSchedule', request_row.requested_snapshot,
    'acknowledgements', jsonb_build_object(
      'noRefund', request_row.acknowledged_no_refund,
      'slotNotHeld', request_row.acknowledged_slot_not_held
    ),
    'decision', jsonb_build_object(
      'reason', request_row.decision_reason,
      'reviewedAt', request_row.reviewed_at
    ),
    'createdAt', request_row.created_at,
    'updatedAt', request_row.updated_at,
    'canWithdraw', request_row.status = 'pending'
  );

  if p_include_private then
    payload := payload || jsonb_build_object(
      'customer', jsonb_build_object(
        'name', request_row.customer_name,
        'email', request_row.customer_email
      ),
      'decision', jsonb_build_object(
        'reason', request_row.decision_reason,
        'reviewedAt', request_row.reviewed_at,
        'reviewedByRole', request_row.reviewed_by_role
      ),
      'canApprove', request_row.status = 'pending',
      'canReject', request_row.status = 'pending',
      'currentItems', request_row.old_snapshot->'items',
      'requestedItems', request_row.requested_snapshot->'items',
      'notification', notification_summary
    );
  end if;

  return payload;
end;
$$;

revoke all on function public.booking_reschedule_request_payload(uuid, boolean)
  from public, anon, authenticated;

create or replace function public.booking_reschedule_cancel_stale_notifications(
  p_request_id uuid,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cancelled_count integer;
begin
  update public.booking_reschedule_notification_outbox outbox
  set status = 'cancelled',
      cancelled_at = clock_timestamp(),
      lease_token = null,
      lease_expires_at = null,
      last_error = left(
        coalesce(nullif(btrim(p_reason), ''), 'Lifecycle changed before delivery.'),
        500
      ),
      updated_at = clock_timestamp()
  where outbox.request_id = p_request_id
    and outbox.notification_kind in (
      'customer_request_received', 'admin_review_needed'
    )
    and outbox.status in ('pending', 'failed', 'processing');
  get diagnostics cancelled_count = row_count;
  return cancelled_count;
end;
$$;

revoke all on function public.booking_reschedule_cancel_stale_notifications(
  uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.get_public_booking_reschedule_state(
  p_ref text,
  p_email text,
  p_access_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  guest_context jsonb;
  family_refs text[];
  family_key text;
  latest_request_id uuid;
  booking_items jsonb;
  cutoff_text text;
  cutoff_hours integer := 24;
  earliest_start timestamptz;
  confirmed_count integer;
  booking_count integer;
begin
  guest_context := public.booking_reschedule_guest_context(
    p_ref, p_email, p_access_token
  );
  if guest_context is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  select array_agg(value order by value)
  into family_refs
  from jsonb_array_elements_text(guest_context->'bookingRefs') value;
  family_key := guest_context->>'familyKey';

  select setting.value into cutoff_text
  from public.settings setting
  where setting.key = 'reschedule_cutoff_hours'
  limit 1;
  if btrim(coalesce(cutoff_text, '24')) ~ '^\d{1,3}$' then
    cutoff_hours := greatest(1, least(btrim(coalesce(cutoff_text, '24'))::integer, 720));
  end if;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'ref', booking.ref,
      'courtId', booking.court_id,
      'courtName', booking.court_name,
      'date', booking.date,
      'slots', to_jsonb(booking.slots),
      'startTime', booking.start_time,
      'endTime', booking.end_time,
      'duration', booking.duration,
      'rate', booking.rate,
      'total', booking.total,
      'status', booking.status,
      'paymentStatus', booking.payment_status
    ) order by booking.court_name, booking.ref), '[]'::jsonb),
    min(public.booking_start_at_ph(booking.date, booking.start_time, booking.slots)),
    count(*) filter (where booking.status = 'confirmed')::integer,
    count(*)::integer
  into booking_items, earliest_start, confirmed_count, booking_count
  from public.bookings booking
  where booking.ref = any(family_refs);

  select request.id into latest_request_id
  from public.booking_reschedule_requests request
  where request.booking_family_key = family_key
    and request.selected_booking_refs <@ family_refs
  order by request.created_at desc, request.id desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'booking', jsonb_build_object(
      'ref', guest_context->>'anchorRef',
      'bookingGroupRef', guest_context->>'bookingGroupRef',
      'status', case
        when confirmed_count = booking_count then 'confirmed'
        else 'mixed'
      end,
      'items', booking_items,
      'reschedule', jsonb_build_object(
        'eligible', booking_count > 0
          and confirmed_count = booking_count
          and earliest_start > now() + make_interval(hours => cutoff_hours),
        'cutoffHours', cutoff_hours,
        'earliestStart', earliest_start,
        'slotIsHeldWhilePending', false,
        'refundAvailable', false
      )
    ),
    'request', case
      when latest_request_id is null then null
      else public.booking_reschedule_request_payload(latest_request_id, false)
    end
  );
end;
$$;

revoke all on function public.get_public_booking_reschedule_state(text, text, text)
  from public, anon, authenticated;
grant execute on function public.get_public_booking_reschedule_state(text, text, text)
  to anon, authenticated, service_role;

comment on function public.get_public_booking_reschedule_state(text, text, text) is
  'Returns only guest-safe booking/reschedule state after ref, normalized email, and original-device token all match.';

create or replace function public.get_public_booking_reschedule_options(
  p_ref text,
  p_email text,
  p_access_token text,
  p_item_refs text[],
  p_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  guest_context jsonb;
  family_refs text[];
  selected_refs text[];
  normalized_refs text[];
  cutoff_text text;
  cutoff_hours integer := 24;
  earliest_start timestamptz;
  booking_count integer;
  confirmed_count integer;
  common_duration integer;
  duration_variants integer;
  selected_court_count integer;
  open_hour_text text;
  close_hour_text text;
  open_hour integer;
  close_hour integer;
  slot_hour integer;
  option_start integer;
  option_slots text[];
  slot_available boolean;
  option_available boolean;
  item record;
  items_payload jsonb := '[]'::jsonb;
  slots_payload jsonb := '[]'::jsonb;
  options_payload jsonb := '[]'::jsonb;
begin
  guest_context := public.booking_reschedule_guest_context(
    p_ref, p_email, p_access_token
  );
  if guest_context is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  select array_agg(value order by value)
  into family_refs
  from jsonb_array_elements_text(guest_context->'bookingRefs') value;

  if coalesce(cardinality(p_item_refs), 0) < 1
     or cardinality(p_item_refs) > 8
     or exists (
       select 1 from unnest(coalesce(p_item_refs, '{}'::text[])) requested(ref)
       where nullif(btrim(requested.ref), '') is null
     ) then
    raise exception 'Select between one and eight booking items.'
      using errcode = '22023';
  end if;
  select array_agg(distinct btrim(requested.ref) order by btrim(requested.ref))
  into normalized_refs
  from unnest(p_item_refs) requested(ref);
  if cardinality(normalized_refs) <> cardinality(p_item_refs)
     or not normalized_refs <@ family_refs then
    raise exception 'Booking selection is invalid.' using errcode = '22023';
  end if;
  selected_refs := normalized_refs;

  select setting.value into cutoff_text
  from public.settings setting
  where setting.key = 'reschedule_cutoff_hours'
  limit 1;
  if btrim(coalesce(cutoff_text, '24')) ~ '^\d{1,3}$' then
    cutoff_hours := greatest(1, least(btrim(coalesce(cutoff_text, '24'))::integer, 720));
  end if;

  select
    min(public.booking_start_at_ph(booking.date, booking.start_time, booking.slots)),
    count(*)::integer,
    count(*) filter (where booking.status = 'confirmed')::integer,
    count(distinct cardinality(booking.slots))::integer,
    min(cardinality(booking.slots))::integer,
    count(distinct booking.court_id)::integer
  into earliest_start, booking_count, confirmed_count, duration_variants,
       common_duration, selected_court_count
  from public.bookings booking
  where booking.ref = any(selected_refs);

  if booking_count <> cardinality(selected_refs)
     or confirmed_count <> booking_count
     or duration_variants <> 1
     or selected_court_count <> booking_count
     or common_duration < 1
     or earliest_start <= now() + make_interval(hours => cutoff_hours) then
    return jsonb_build_object('ok', false, 'code', 'RESCHEDULE_NOT_ELIGIBLE');
  end if;

  if p_date is null
     or p_date < greatest(date '2026-09-19', timezone('Asia/Manila', now())::date)
     or p_date > timezone('Asia/Manila', now())::date + 366 then
    raise exception 'Requested date is outside the available booking window.'
      using errcode = '22023';
  end if;

  select setting.value into open_hour_text
  from public.settings setting where setting.key = 'open_hour' limit 1;
  select setting.value into close_hour_text
  from public.settings setting where setting.key = 'close_hour' limit 1;
  if btrim(coalesce(open_hour_text, '')) !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
     or btrim(coalesce(close_hour_text, '')) !~ '^(?:[1-9]|1[0-9]|2[0-4])$' then
    raise exception 'Court operating hours are not configured correctly.'
      using errcode = '23514';
  end if;
  open_hour := btrim(open_hour_text)::integer;
  close_hour := btrim(close_hour_text)::integer;

  for item in
    select booking.ref, booking.court_id, booking.court_name,
           cardinality(booking.slots) as duration
    from public.bookings booking
    where booking.ref = any(selected_refs)
    order by booking.court_name, booking.ref
  loop
    items_payload := items_payload || jsonb_build_array(jsonb_build_object(
      'ref', item.ref,
      'courtId', item.court_id,
      'courtName', item.court_name,
      'duration', item.duration
    ));
  end loop;

  for slot_hour in open_hour..(close_hour - 1)
  loop
    slot_available := true;
    for item in
      select booking.court_id
      from public.bookings booking
      where booking.ref = any(selected_refs)
      order by booking.court_id
    loop
      if not public.booking_reschedule_schedule_available(
        item.court_id, p_date, array[slot_hour::text], selected_refs
      ) then
        slot_available := false;
        exit;
      end if;
    end loop;

    slots_payload := slots_payload || jsonb_build_array(jsonb_build_object(
      'hour', slot_hour,
      'label', public.booking_reschedule_hour_label(slot_hour)
        || '–' || public.booking_reschedule_hour_label(slot_hour + 1),
      'startTime', public.booking_reschedule_hour_label(slot_hour),
      'endTime', public.booking_reschedule_hour_label(slot_hour + 1),
      'available', slot_available
    ));
  end loop;

  if close_hour - common_duration >= open_hour then
    for option_start in open_hour..(close_hour - common_duration)
    loop
      select array_agg(hour_value::text order by hour_value)
      into option_slots
      from generate_series(
        option_start, option_start + common_duration - 1
      ) hour_value;

      option_available := true;
      for item in
        select booking.court_id
        from public.bookings booking
        where booking.ref = any(selected_refs)
        order by booking.court_id
      loop
        if not public.booking_reschedule_schedule_available(
          item.court_id, p_date, option_slots, selected_refs
        ) then
          option_available := false;
          exit;
        end if;
      end loop;

      options_payload := options_payload || jsonb_build_array(jsonb_build_object(
        'date', p_date,
        'startTime', public.booking_reschedule_hour_label(option_start),
        'endTime', public.booking_reschedule_hour_label(
          option_start + common_duration
        ),
        'slots', to_jsonb(option_slots),
        'available', option_available
      ));
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'date', p_date,
    'duration', common_duration,
    'items', items_payload,
    'slots', slots_payload,
    'options', options_payload,
    'slotIsHeldWhilePending', false
  );
end;
$$;

revoke all on function public.get_public_booking_reschedule_options(
  text, text, text, text[], date
) from public, anon, authenticated;
grant execute on function public.get_public_booking_reschedule_options(
  text, text, text, text[], date
) to anon, authenticated, service_role;

comment on function public.get_public_booking_reschedule_options(
  text, text, text, text[], date
) is 'Returns guest-safe, non-holding destination windows for selected booking-family items after original-device proof.';

create or replace function public.submit_public_booking_reschedule_request(
  p_ref text,
  p_email text,
  p_access_token text,
  p_item_refs text[],
  p_requested_date date,
  p_requested_slots text[],
  p_note text,
  p_acknowledged_no_refund boolean,
  p_acknowledged_slot_not_held boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  guest_context jsonb;
  locked_context jsonb;
  family_refs text[];
  selected_refs text[];
  normalized_refs text[];
  requested_slots text[];
  family_key text;
  anchor_ref text;
  group_ref text;
  customer_name text;
  customer_email text;
  cutoff_text text;
  cutoff_hours integer := 24;
  cooldown_text text;
  cooldown_seconds integer := 15;
  latest_submission_at timestamptz;
  earliest_start timestamptz;
  booking_count integer;
  confirmed_count integer;
  duration_variants integer;
  common_duration integer;
  selected_court_count integer;
  min_requested_hour integer;
  max_requested_hour integer;
  requested_start_time text;
  requested_end_time text;
  unchanged_count integer;
  old_snapshot jsonb;
  requested_snapshot jsonb;
  existing_pending public.booking_reschedule_requests%rowtype;
  superseded_event_id bigint;
  new_request_id uuid;
  new_event_id bigint;
  item record;
  clean_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not coalesce(p_acknowledged_no_refund, false)
     or not coalesce(p_acknowledged_slot_not_held, false) then
    raise exception 'Both reschedule acknowledgements are required.'
      using errcode = '22023';
  end if;
  if clean_note is not null and char_length(clean_note) > 500 then
    raise exception 'Reschedule note is too long.' using errcode = '22023';
  end if;

  guest_context := public.booking_reschedule_guest_context(
    p_ref, p_email, p_access_token
  );
  if guest_context is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  select array_agg(value order by value)
  into family_refs
  from jsonb_array_elements_text(guest_context->'bookingRefs') value;

  if coalesce(cardinality(p_item_refs), 0) < 1
     or cardinality(p_item_refs) > 8
     or exists (
       select 1 from unnest(coalesce(p_item_refs, '{}'::text[])) requested(ref)
       where nullif(btrim(requested.ref), '') is null
     ) then
    raise exception 'Select between one and eight booking items.'
      using errcode = '22023';
  end if;
  select array_agg(distinct btrim(requested.ref) order by btrim(requested.ref))
  into normalized_refs
  from unnest(p_item_refs) requested(ref);
  if cardinality(normalized_refs) <> cardinality(p_item_refs)
     or not normalized_refs <@ family_refs then
    raise exception 'Booking selection is invalid.' using errcode = '22023';
  end if;
  selected_refs := normalized_refs;

  if p_requested_date is null
     or coalesce(cardinality(p_requested_slots), 0) < 1
     or cardinality(p_requested_slots) > 24
     or exists (
       select 1 from unnest(coalesce(p_requested_slots, '{}'::text[])) slot(value)
       where btrim(slot.value) !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
     ) then
    raise exception 'Requested schedule is invalid.' using errcode = '22023';
  end if;

  select array_agg(normalized.value order by normalized.value::integer)
  into requested_slots
  from (
    select distinct btrim(slot.value) as value
    from unnest(p_requested_slots) slot(value)
  ) normalized;
  if cardinality(requested_slots) <> cardinality(p_requested_slots) then
    raise exception 'Requested slots cannot contain duplicates.'
      using errcode = '22023';
  end if;

  select min(slot.value::integer), max(slot.value::integer)
  into min_requested_hour, max_requested_hour
  from unnest(requested_slots) slot(value);
  if max_requested_hour - min_requested_hour + 1 <> cardinality(requested_slots) then
    raise exception 'Requested time slots must be consecutive.'
      using errcode = '22023';
  end if;

  family_key := guest_context->>'familyKey';
  anchor_ref := guest_context->>'anchorRef';
  group_ref := nullif(guest_context->>'bookingGroupRef', '');
  customer_name := guest_context->>'customerName';
  customer_email := guest_context->>'customerEmail';

  -- Serialize every request mutation in a booking family.  The active-item
  -- primary key remains the final cross-transaction uniqueness guarantee.
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-reschedule-family|' || family_key, 0)
  );

  perform booking.ref
  from public.bookings booking
  where booking.ref = any(selected_refs)
  order by booking.ref
  for update;

  -- Re-authenticate after the locks so a concurrent ownership/schedule change
  -- cannot be authorized using an earlier observation.
  locked_context := public.booking_reschedule_guest_context(
    p_ref, p_email, p_access_token
  );
  if locked_context is null
     or locked_context->>'familyKey' <> family_key
     or not selected_refs <@ array(
       select value
       from jsonb_array_elements_text(locked_context->'bookingRefs') value
     ) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_CHANGED');
  end if;

  select request.* into existing_pending
  from public.booking_reschedule_requests request
  where request.booking_family_key = family_key
    and request.status = 'pending'
  for update;

  -- A network retry of the exact same content is a read of the already-saved
  -- request, not a replacement and not another notification event.
  if existing_pending.id is not null
     and existing_pending.selected_booking_refs = selected_refs
     and existing_pending.requested_snapshot->>'requestedDate' =
         p_requested_date::text
     and array(
       select value
       from jsonb_array_elements_text(
         existing_pending.requested_snapshot->'requestedSlots'
       ) value
     ) = requested_slots
     and existing_pending.note is not distinct from clean_note then
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'request', public.booking_reschedule_request_payload(
        existing_pending.id, false
      )
    );
  end if;

  select setting.value into cooldown_text
  from public.settings setting
  where setting.key = 'reschedule_submission_cooldown_seconds'
  limit 1;
  if btrim(coalesce(cooldown_text, '15')) ~ '^\d{1,3}$' then
    cooldown_seconds := greatest(
      5,
      least(btrim(coalesce(cooldown_text, '15'))::integer, 300)
    );
  end if;
  select max(request.created_at) into latest_submission_at
  from public.booking_reschedule_requests request
  where request.booking_family_key = family_key;
  if latest_submission_at is not null
     and latest_submission_at >
         now() - make_interval(secs => cooldown_seconds) then
    return jsonb_build_object(
      'ok', false,
      'code', 'TOO_MANY_REQUESTS',
      'message', format(
        'Please wait %s seconds before changing this request again.',
        cooldown_seconds
      ),
      'retryAfterSeconds', cooldown_seconds
    );
  end if;

  select setting.value into cutoff_text
  from public.settings setting
  where setting.key = 'reschedule_cutoff_hours'
  limit 1;
  if btrim(coalesce(cutoff_text, '24')) ~ '^\d{1,3}$' then
    cutoff_hours := greatest(1, least(btrim(coalesce(cutoff_text, '24'))::integer, 720));
  end if;

  select
    min(public.booking_start_at_ph(booking.date, booking.start_time, booking.slots)),
    count(*)::integer,
    count(*) filter (where booking.status = 'confirmed')::integer,
    count(distinct cardinality(booking.slots))::integer,
    min(cardinality(booking.slots))::integer,
    count(distinct booking.court_id)::integer,
    count(*) filter (
      where booking.date = p_requested_date
        and booking.slots = requested_slots
    )::integer
  into earliest_start, booking_count, confirmed_count, duration_variants,
       common_duration, selected_court_count, unchanged_count
  from public.bookings booking
  where booking.ref = any(selected_refs);

  if booking_count <> cardinality(selected_refs)
     or confirmed_count <> booking_count
     or duration_variants <> 1
     or selected_court_count <> booking_count
     or common_duration < 1
     or earliest_start <= now() + make_interval(hours => cutoff_hours) then
    return jsonb_build_object('ok', false, 'code', 'RESCHEDULE_NOT_ELIGIBLE');
  end if;
  if common_duration <> cardinality(requested_slots) then
    raise exception 'The new schedule must keep the same duration.'
      using errcode = '22023';
  end if;
  if unchanged_count = booking_count then
    raise exception 'Choose a schedule different from the current booking.'
      using errcode = '22023';
  end if;

  requested_start_time := public.booking_reschedule_hour_label(min_requested_hour);
  requested_end_time := public.booking_reschedule_hour_label(max_requested_hour + 1);

  for item in
    select booking.ref, booking.court_id
    from public.bookings booking
    where booking.ref = any(selected_refs)
    order by booking.court_id, booking.ref
  loop
    if not public.booking_reschedule_schedule_available(
      item.court_id, p_requested_date, requested_slots, selected_refs
    ) then
      return jsonb_build_object('ok', false, 'code', 'SLOT_UNAVAILABLE');
    end if;
  end loop;

  select jsonb_build_object(
    'bookingRef', anchor_ref,
    'bookingGroupRef', group_ref,
    'capturedAt', statement_timestamp(),
    'items', jsonb_agg(jsonb_build_object(
      'ref', booking.ref,
      'courtId', booking.court_id,
      'courtName', booking.court_name,
      'date', booking.date,
      'slots', to_jsonb(booking.slots),
      'startTime', booking.start_time,
      'endTime', booking.end_time,
      'duration', coalesce(booking.duration, cardinality(booking.slots)),
      'rate', booking.rate,
      'total', booking.total,
      'status', booking.status,
      'scheduleFingerprint', public.booking_reschedule_schedule_fingerprint(
        booking.court_id,
        booking.date,
        booking.slots,
        coalesce(booking.duration, cardinality(booking.slots)),
        booking.rate,
        booking.total,
        booking.status
      )
    ) order by booking.court_name, booking.ref)
  ) into old_snapshot
  from public.bookings booking
  where booking.ref = any(selected_refs);

  select jsonb_build_object(
    'requestedDate', p_requested_date,
    'requestedSlots', to_jsonb(requested_slots),
    'startTime', requested_start_time,
    'endTime', requested_end_time,
    'duration', common_duration,
    'items', jsonb_agg(jsonb_build_object(
      'ref', booking.ref,
      'courtId', booking.court_id,
      'courtName', booking.court_name,
      'date', p_requested_date,
      'slots', to_jsonb(requested_slots),
      'startTime', requested_start_time,
      'endTime', requested_end_time,
      'duration', common_duration,
      'rate', booking.rate,
      'total', booking.total
    ) order by booking.court_name, booking.ref)
  ) into requested_snapshot
  from public.bookings booking
  where booking.ref = any(selected_refs);

  -- Replacement is intentionally delayed until every new choice above has
  -- passed authentication, eligibility, duration, and availability checks.
  -- Any later exception rolls the whole transaction back, restoring the old
  -- pending request and its active-item assignments automatically.
  if existing_pending.id is not null then
    update public.booking_reschedule_requests request
    set status = 'superseded',
        decision_reason = 'Replaced by a newer player reschedule request.',
        superseded_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where request.id = existing_pending.id;

    perform public.booking_reschedule_cancel_stale_notifications(
      existing_pending.id,
      'Cancelled because the player replaced this request.'
    );

    delete from public.booking_reschedule_active_items active_item
    where active_item.request_id = existing_pending.id;

    insert into public.booking_reschedule_events (
      request_id, event_type, from_status, to_status, actor_type, reason,
      details
    ) values (
      existing_pending.id,
      'superseded',
      'pending',
      'superseded',
      'guest',
      'Replaced by a newer player reschedule request.',
      jsonb_build_object('replacementPending', true)
    ) returning id into superseded_event_id;
  end if;

  insert into public.booking_reschedule_requests (
    anchor_booking_ref,
    booking_group_ref,
    booking_family_key,
    selected_booking_refs,
    customer_name,
    customer_email,
    old_snapshot,
    requested_snapshot,
    status,
    note,
    acknowledged_no_refund,
    acknowledged_slot_not_held
  ) values (
    anchor_ref,
    group_ref,
    family_key,
    selected_refs,
    customer_name,
    customer_email,
    old_snapshot,
    requested_snapshot,
    'pending',
    clean_note,
    true,
    true
  ) returning id into new_request_id;

  insert into public.booking_reschedule_request_items (
    request_id,
    booking_ref,
    booking_family_key,
    old_court_id,
    old_court_name,
    old_date,
    old_slots,
    old_start_time,
    old_end_time,
    old_duration,
    old_rate,
    old_total,
    old_status,
    old_schedule_fingerprint,
    requested_date,
    requested_slots,
    requested_start_time,
    requested_end_time,
    requested_duration,
    requested_rate,
    requested_total
  )
  select
    new_request_id,
    booking.ref,
    family_key,
    booking.court_id,
    booking.court_name,
    booking.date,
    booking.slots,
    booking.start_time,
    booking.end_time,
    coalesce(booking.duration, cardinality(booking.slots)),
    booking.rate,
    booking.total,
    booking.status,
    public.booking_reschedule_schedule_fingerprint(
      booking.court_id,
      booking.date,
      booking.slots,
      coalesce(booking.duration, cardinality(booking.slots)),
      booking.rate,
      booking.total,
      booking.status
    ),
    p_requested_date,
    requested_slots,
    requested_start_time,
    requested_end_time,
    common_duration,
    booking.rate,
    booking.total
  from public.bookings booking
  where booking.ref = any(selected_refs)
  order by booking.ref;

  insert into public.booking_reschedule_active_items (booking_ref, request_id)
  select booking_ref, new_request_id
  from public.booking_reschedule_request_items
  where request_id = new_request_id
  order by booking_ref;

  insert into public.booking_reschedule_events (
    request_id, event_type, from_status, to_status, actor_type, details
  ) values (
    new_request_id,
    'submitted',
    null,
    'pending',
    'guest',
    jsonb_build_object(
      'itemRefs', to_jsonb(selected_refs),
      'slotHeld', false,
      'noRefundAcknowledged', true
    )
  ) returning id into new_event_id;

  insert into public.booking_reschedule_notification_outbox (
    request_id, event_id, notification_kind
  ) values
    (new_request_id, new_event_id, 'customer_request_received'),
    (new_request_id, new_event_id, 'admin_review_needed');

  return jsonb_build_object(
    'ok', true,
    'request', public.booking_reschedule_request_payload(new_request_id, false)
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_ALREADY_PENDING');
end;
$$;

revoke all on function public.submit_public_booking_reschedule_request(
  text, text, text, text[], date, text[], text, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.submit_public_booking_reschedule_request(
  text, text, text, text[], date, text[], text, boolean, boolean
) to anon, authenticated, service_role;

comment on function public.submit_public_booking_reschedule_request(
  text, text, text, text[], date, text[], text, boolean, boolean
) is 'Creates an immutable, non-holding reschedule request after guest proof and authoritative availability validation; the live booking is not changed.';

create or replace function public.withdraw_public_booking_reschedule_request(
  p_ref text,
  p_email text,
  p_access_token text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  guest_context jsonb;
  family_refs text[];
  family_key text;
  request_row public.booking_reschedule_requests%rowtype;
  event_id bigint;
begin
  guest_context := public.booking_reschedule_guest_context(
    p_ref, p_email, p_access_token
  );
  if guest_context is null or p_request_id is null then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  end if;

  select array_agg(value order by value)
  into family_refs
  from jsonb_array_elements_text(guest_context->'bookingRefs') value;
  family_key := guest_context->>'familyKey';

  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-reschedule-family|' || family_key, 0)
  );

  select request.* into request_row
  from public.booking_reschedule_requests request
  where request.id = p_request_id
    and request.booking_family_key = family_key
    and request.selected_booking_refs <@ family_refs
  for update;

  if request_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  end if;
  if request_row.status = 'withdrawn' then
    return jsonb_build_object(
      'ok', true,
      'request', public.booking_reschedule_request_payload(request_row.id, false)
    );
  end if;
  if request_row.status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'code', 'REQUEST_NOT_PENDING',
      'request', public.booking_reschedule_request_payload(request_row.id, false)
    );
  end if;

  update public.booking_reschedule_requests request
  set status = 'withdrawn',
      updated_at = clock_timestamp(),
      withdrawn_at = clock_timestamp(),
      decision_reason = 'Withdrawn by the player before review.'
  where request.id = request_row.id;

  perform public.booking_reschedule_cancel_stale_notifications(
    request_row.id,
    'Cancelled because the player withdrew this request.'
  );

  delete from public.booking_reschedule_active_items active_item
  where active_item.request_id = request_row.id;

  insert into public.booking_reschedule_events (
    request_id, event_type, from_status, to_status, actor_type, reason
  ) values (
    request_row.id,
    'withdrawn',
    'pending',
    'withdrawn',
    'guest',
    'Withdrawn by the player before review.'
  ) returning id into event_id;

  insert into public.booking_reschedule_notification_outbox (
    request_id, event_id, notification_kind
  ) values (
    request_row.id, event_id, 'customer_withdrawn'
  );

  return jsonb_build_object(
    'ok', true,
    'request', public.booking_reschedule_request_payload(request_row.id, false)
  );
end;
$$;

revoke all on function public.withdraw_public_booking_reschedule_request(
  text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.withdraw_public_booking_reschedule_request(
  text, text, text, uuid
) to anon, authenticated, service_role;

comment on function public.withdraw_public_booking_reschedule_request(
  text, text, text, uuid
) is 'Withdraws only the caller-token booking-family pending request; the original booking schedule remains unchanged.';

create or replace function public.list_booking_reschedule_requests(
  p_status text default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text := public.booking_reschedule_operator_role();
  requested_status text := nullif(lower(btrim(coalesce(p_status, ''))), '');
  safe_limit integer := greatest(1, least(coalesce(p_limit, 100), 200));
  requests_payload jsonb;
  pending_requests_payload jsonb;
  history_requests_payload jsonb;
  counts_payload jsonb;
begin
  if actor_role is null then
    raise exception 'An active owner or court owner account is required.'
      using errcode = '42501';
  end if;
  if requested_status is not null
     and requested_status <> 'all'
     and requested_status not in (
       'pending', 'approved', 'rejected', 'withdrawn', 'conflicted', 'superseded'
     ) then
    raise exception 'Invalid reschedule request status.' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'pending', count(*) filter (where request.status = 'pending'),
    'approved', count(*) filter (where request.status = 'approved'),
    'rejected', count(*) filter (where request.status = 'rejected'),
    'withdrawn', count(*) filter (where request.status = 'withdrawn'),
    'conflicted', count(*) filter (where request.status = 'conflicted'),
    'superseded', count(*) filter (where request.status = 'superseded')
  ) into counts_payload
  from public.booking_reschedule_requests request;

  select coalesce(jsonb_agg(listed.payload order by listed.created_at desc), '[]'::jsonb)
  into requests_payload
  from (
    select
      public.booking_reschedule_request_payload(request.id, true) as payload,
      request.created_at
    from public.booking_reschedule_requests request
    where requested_status is null
       or requested_status = 'all'
       or request.status = requested_status
    order by request.created_at desc, request.id desc
    limit safe_limit
  ) listed;

  -- Both queue sections are read by this one STABLE RPC invocation, so the
  -- owner never combines pending and history lists from different snapshots.
  -- Each section has its own bound; a busy history cannot hide pending work.
  select coalesce(
    jsonb_agg(listed.payload order by listed.created_at desc),
    '[]'::jsonb
  )
  into pending_requests_payload
  from (
    select
      public.booking_reschedule_request_payload(request.id, true) as payload,
      request.created_at,
      request.id
    from public.booking_reschedule_requests request
    where request.status = 'pending'
    order by request.created_at desc, request.id desc
    limit safe_limit
  ) listed;

  select coalesce(
    jsonb_agg(listed.payload order by listed.created_at desc),
    '[]'::jsonb
  )
  into history_requests_payload
  from (
    select
      public.booking_reschedule_request_payload(request.id, true) as payload,
      request.created_at,
      request.id
    from public.booking_reschedule_requests request
    where request.status <> 'pending'
    order by request.created_at desc, request.id desc
    limit safe_limit
  ) listed;

  return jsonb_build_object(
    'ok', true,
    'counts', counts_payload,
    'requests', requests_payload,
    'pendingRequests', pending_requests_payload,
    'historyRequests', history_requests_payload
  );
end;
$$;

revoke all on function public.list_booking_reschedule_requests(text, integer)
  from public, anon, authenticated;
grant execute on function public.list_booking_reschedule_requests(text, integer)
  to authenticated;

create or replace function public.get_booking_reschedule_request(
  p_request_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text := public.booking_reschedule_operator_role();
  request_payload jsonb;
  events_payload jsonb;
begin
  if actor_role is null then
    raise exception 'An active owner or court owner account is required.'
      using errcode = '42501';
  end if;

  request_payload := public.booking_reschedule_request_payload(
    p_request_id, true
  );
  if request_payload is null then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', event.id,
    'type', event.event_type,
    'fromStatus', event.from_status,
    'toStatus', event.to_status,
    'actorType', event.actor_type,
    'actorRole', event.actor_role,
    'reason', event.reason,
    'details', event.details,
    'createdAt', event.created_at
  ) order by event.created_at, event.id), '[]'::jsonb)
  into events_payload
  from public.booking_reschedule_events event
  where event.request_id = p_request_id;

  return jsonb_build_object(
    'ok', true,
    'request', request_payload,
    'events', events_payload
  );
end;
$$;

revoke all on function public.get_booking_reschedule_request(uuid)
  from public, anon, authenticated;
grant execute on function public.get_booking_reschedule_request(uuid)
  to authenticated;

create or replace function public.booking_reschedule_mark_conflicted(
  p_request_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event_id bigint;
  clean_reason text := left(
    coalesce(nullif(btrim(p_reason), ''), 'The requested schedule is no longer available.'),
    500
  );
begin
  update public.booking_reschedule_requests request
  set status = 'conflicted',
      reviewed_by_user_id = p_actor_user_id,
      reviewed_by_role = p_actor_role,
      decision_reason = clean_reason,
      reviewed_at = clock_timestamp(),
      conflicted_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where request.id = p_request_id
    and request.status = 'pending';

  if not found then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_PENDING');
  end if;

  perform public.booking_reschedule_cancel_stale_notifications(
    p_request_id,
    'Cancelled because this request is no longer pending.'
  );

  delete from public.booking_reschedule_active_items active_item
  where active_item.request_id = p_request_id;

  insert into public.booking_reschedule_events (
    request_id, event_type, from_status, to_status, actor_type,
    actor_user_id, actor_role, reason
  ) values (
    p_request_id, 'conflicted', 'pending', 'conflicted', 'operator',
    p_actor_user_id, p_actor_role, clean_reason
  ) returning id into event_id;

  insert into public.booking_reschedule_notification_outbox (
    request_id, event_id, notification_kind
  ) values (p_request_id, event_id, 'customer_conflicted');

  return jsonb_build_object(
    'ok', false,
    'code', 'SLOT_CONFLICT',
    'request', public.booking_reschedule_request_payload(p_request_id, true)
  );
end;
$$;

revoke all on function public.booking_reschedule_mark_conflicted(
  uuid, uuid, text, text
) from public, anon, authenticated;

create or replace function public.review_booking_reschedule_request(
  p_request_id uuid,
  p_decision text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.booking_reschedule_operator_role();
  decision text := lower(btrim(coalesce(p_decision, '')));
  clean_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  preliminary_family_key text;
  request_row public.booking_reschedule_requests%rowtype;
  current_count integer;
  matching_count integer;
  earliest_start timestamptz;
  cutoff_text text;
  cutoff_hours integer := 24;
  lock_key text;
  item record;
  updated_count integer;
  event_id bigint;
begin
  if actor_role is null then
    raise exception 'An active owner or court owner account is required.'
      using errcode = '42501';
  end if;
  if p_request_id is null or decision not in ('approve', 'reject') then
    raise exception 'Review decision is invalid.' using errcode = '22023';
  end if;
  if clean_reason is not null and char_length(clean_reason) > 500 then
    raise exception 'Review reason is too long.' using errcode = '22023';
  end if;
  if decision = 'reject' and coalesce(char_length(clean_reason), 0) < 3 then
    raise exception 'A clear rejection reason is required.' using errcode = '22023';
  end if;

  select request.booking_family_key into preliminary_family_key
  from public.booking_reschedule_requests request
  where request.id = p_request_id;

  if preliminary_family_key is null then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'paddle-rage-reschedule-family|' || preliminary_family_key, 0
    )
  );

  select request.* into request_row
  from public.booking_reschedule_requests request
  where request.id = p_request_id
  for update;

  if request_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  end if;
  if request_row.status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'code', 'REQUEST_NOT_PENDING',
      'request', public.booking_reschedule_request_payload(request_row.id, true)
    );
  end if;

  if decision = 'reject' then
    update public.booking_reschedule_requests request
    set status = 'rejected',
        reviewed_by_user_id = actor_id,
        reviewed_by_role = actor_role,
        decision_reason = clean_reason,
        reviewed_at = clock_timestamp(),
        rejected_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where request.id = request_row.id;

    perform public.booking_reschedule_cancel_stale_notifications(
      request_row.id,
      'Cancelled because this request was declined.'
    );

    delete from public.booking_reschedule_active_items active_item
    where active_item.request_id = request_row.id;

    insert into public.booking_reschedule_events (
      request_id, event_type, from_status, to_status, actor_type,
      actor_user_id, actor_role, reason
    ) values (
      request_row.id, 'rejected', 'pending', 'rejected', 'operator',
      actor_id, actor_role, clean_reason
    ) returning id into event_id;

    insert into public.booking_reschedule_notification_outbox (
      request_id, event_id, notification_kind
    ) values (request_row.id, event_id, 'customer_rejected');

    return jsonb_build_object(
      'ok', true,
      'request', public.booking_reschedule_request_payload(request_row.id, true)
    );
  end if;

  perform booking.ref
  from public.bookings booking
  where booking.ref = any(request_row.selected_booking_refs)
  order by booking.ref
  for update;

  select
    count(*)::integer,
    count(*) filter (
      where public.booking_reschedule_schedule_fingerprint(
        booking.court_id,
        booking.date,
        booking.slots,
        coalesce(booking.duration, cardinality(booking.slots)),
        booking.rate,
        booking.total,
        booking.status
      ) = request_item.old_schedule_fingerprint
        and booking.court_id = request_item.old_court_id
        and lower(btrim(coalesce(booking.email, ''))) =
            request_row.customer_email
        and coalesce(
          nullif(btrim(booking.booking_group_ref), ''), booking.ref
        ) = request_row.booking_family_key
        and coalesce(booking.duration, cardinality(booking.slots)) =
            request_item.old_duration
        and booking.rate is not distinct from request_item.old_rate
        and booking.total is not distinct from request_item.old_total
    )::integer,
    min(public.booking_start_at_ph(booking.date, booking.start_time, booking.slots))
  into current_count, matching_count, earliest_start
  from public.booking_reschedule_request_items request_item
  left join public.bookings booking on booking.ref = request_item.booking_ref
  where request_item.request_id = request_row.id;

  select setting.value into cutoff_text
  from public.settings setting
  where setting.key = 'reschedule_cutoff_hours'
  limit 1;
  if btrim(coalesce(cutoff_text, '24')) ~ '^\d{1,3}$' then
    cutoff_hours := greatest(
      1,
      least(btrim(coalesce(cutoff_text, '24'))::integer, 720)
    );
  end if;

  if current_count <> cardinality(request_row.selected_booking_refs)
     or matching_count <> current_count
     or earliest_start is null
     or earliest_start <= now() + make_interval(hours => cutoff_hours) then
    return public.booking_reschedule_mark_conflicted(
      request_row.id,
      actor_id,
      actor_role,
      'The original booking changed or is now inside the reschedule cutoff. Nothing was moved.'
    );
  end if;

  -- Lock all destination court/date/slot keys in one global order before the
  -- UPDATE triggers run. This closes concurrent approval/new-booking races and
  -- avoids partial moves for multi-court requests.
  for lock_key in
    select distinct
      request_item.old_court_id || '|' || request_item.requested_date::text ||
      '|' || slot.value as value
    from public.booking_reschedule_request_items request_item
    cross join lateral unnest(request_item.requested_slots) slot(value)
    where request_item.request_id = request_row.id
    order by value
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('paddle-rage-booking-slot|' || lock_key, 0)
    );
  end loop;

  for item in
    select request_item.*
    from public.booking_reschedule_request_items request_item
    where request_item.request_id = request_row.id
    order by request_item.old_court_id, request_item.booking_ref
  loop
    if not public.booking_reschedule_schedule_available(
      item.old_court_id,
      item.requested_date,
      item.requested_slots,
      request_row.selected_booking_refs
    ) then
      return public.booking_reschedule_mark_conflicted(
        request_row.id,
        actor_id,
        actor_role,
        'The requested schedule is no longer available. Nothing was moved.'
      );
    end if;
  end loop;

  update public.bookings booking
  set date = request_item.requested_date,
      slots = request_item.requested_slots,
      start_time = request_item.requested_start_time,
      end_time = request_item.requested_end_time,
      duration = request_item.requested_duration
  from public.booking_reschedule_request_items request_item
  where request_item.request_id = request_row.id
    and booking.ref = request_item.booking_ref;

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(request_row.selected_booking_refs) then
    raise exception 'The complete booking selection could not be moved.'
      using errcode = '40001';
  end if;

  update public.booking_reschedule_requests request
  set status = 'approved',
      reviewed_by_user_id = actor_id,
      reviewed_by_role = actor_role,
      decision_reason = coalesce(clean_reason, 'Approved by Paddle Rage.'),
      reviewed_at = clock_timestamp(),
      approved_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where request.id = request_row.id;

  perform public.booking_reschedule_cancel_stale_notifications(
    request_row.id,
    'Cancelled because this request was approved.'
  );

  delete from public.booking_reschedule_active_items active_item
  where active_item.request_id = request_row.id;

  insert into public.booking_reschedule_events (
    request_id, event_type, from_status, to_status, actor_type,
    actor_user_id, actor_role, reason, details
  ) values (
    request_row.id, 'approved', 'pending', 'approved', 'operator',
    actor_id, actor_role, coalesce(clean_reason, 'Approved by Paddle Rage.'),
    jsonb_build_object(
      'itemRefs', to_jsonb(request_row.selected_booking_refs),
      'paymentChanged', false,
      'referenceChanged', false
    )
  ) returning id into event_id;

  insert into public.booking_reschedule_notification_outbox (
    request_id, event_id, notification_kind
  ) values (request_row.id, event_id, 'customer_approved');

  return jsonb_build_object(
    'ok', true,
    'request', public.booking_reschedule_request_payload(request_row.id, true)
  );
end;
$$;

revoke all on function public.review_booking_reschedule_request(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.review_booking_reschedule_request(uuid, text, text)
  to authenticated;

comment on function public.list_booking_reschedule_requests(text, integer) is
  'Owner/court-owner-only single-snapshot queue: compatibility requests plus independently bounded pendingRequests/historyRequests with private customer and delivery summaries.';
comment on function public.get_booking_reschedule_request(uuid) is
  'Owner/court-owner-only request detail with immutable audit events.';
comment on function public.review_booking_reschedule_request(uuid, text, text) is
  'Atomically approves all selected booking rows or rejects the request. Approval preserves court, duration, rate, total, payment evidence, and references.';

create or replace function public.retry_booking_reschedule_notifications(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ready_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the reschedule notification processor may retry notifications.'
      using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'A reschedule request id is required.' using errcode = '22023';
  end if;

  update public.booking_reschedule_notification_outbox outbox
  set available_at = now(),
      updated_at = clock_timestamp()
  where outbox.request_id = p_request_id
    and outbox.status = 'failed'
    and outbox.attempts < 20;
  get diagnostics ready_count = row_count;

  return jsonb_build_object('ok', true, 'readyCount', ready_count);
end;
$$;

create or replace function public.claim_booking_reschedule_notifications(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 180,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  worker_id text := btrim(coalesce(p_worker_id, ''));
  safe_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 180), 900));
  claim_token uuid := gen_random_uuid();
  notifications_payload jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the reschedule notification processor may claim notifications.'
      using errcode = '42501';
  end if;
  if char_length(worker_id) < 3
     or char_length(worker_id) > 120
     or worker_id ~ '[[:cntrl:]]' then
    raise exception 'Notification worker id is invalid.' using errcode = '22023';
  end if;

  -- A worker can disappear on its final permitted attempt.  Once that lease
  -- expires, close it as a retained dead-letter instead of leaving a row
  -- permanently labelled "processing" with no valid owner.
  update public.booking_reschedule_notification_outbox outbox
  set status = 'failed',
      lease_token = null,
      lease_expires_at = null,
      last_error = coalesce(
        outbox.last_error,
        'Notification delivery lease expired after the maximum attempts.'
      ),
      updated_at = clock_timestamp()
  where outbox.status = 'processing'
    and outbox.attempts >= 20
    and outbox.lease_expires_at <= now()
    and (p_request_id is null or outbox.request_id = p_request_id);

  with eligible as (
    select outbox.id
    from public.booking_reschedule_notification_outbox outbox
    where outbox.attempts < 20
      and outbox.available_at <= now()
      and (p_request_id is null or outbox.request_id = p_request_id)
      and (
        outbox.status in ('pending', 'failed')
        or (
          outbox.status = 'processing'
          and outbox.lease_expires_at <= now()
        )
      )
    order by outbox.available_at, outbox.created_at, outbox.id
    for update of outbox skip locked
    limit safe_limit
  ), claimed as (
    update public.booking_reschedule_notification_outbox outbox
    set status = 'processing',
        attempts = outbox.attempts + 1,
        lease_token = claim_token,
        lease_expires_at = now() + make_interval(secs => lease_seconds),
        last_error = null,
        updated_at = clock_timestamp()
    from eligible
    where outbox.id = eligible.id
    returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', claimed.id,
    'requestId', claimed.request_id,
    'eventId', claimed.event_id,
    'kind', claimed.notification_kind,
    'outboxStatus', claimed.status,
    'requestStatus', request.status,
    'attempt', claimed.attempts,
    'bookingRef', request.anchor_booking_ref,
    'bookingGroupRef', request.booking_group_ref,
    'itemRefs', to_jsonb(request.selected_booking_refs),
    'customerName', request.customer_name,
    'customerEmail', request.customer_email,
    'note', request.note,
    'oldSnapshot', request.old_snapshot,
    'requestedSnapshot', request.requested_snapshot,
    'decisionReason', request.decision_reason,
    'createdAt', claimed.created_at,
    'deliveredRecipientKeys', coalesce((
      select jsonb_agg(recipient.recipient_key order by recipient.recipient_key)
      from public.booking_reschedule_notification_recipients recipient
      where recipient.notification_id = claimed.id
        and recipient.sent_at is not null
    ), '[]'::jsonb)
  ) order by claimed.created_at, claimed.id), '[]'::jsonb)
  into notifications_payload
  from claimed
  join public.booking_reschedule_requests request
    on request.id = claimed.request_id;

  return jsonb_build_object(
    'ok', true,
    'workerId', worker_id,
    'leaseToken', claim_token,
    'leaseExpiresAt', now() + make_interval(secs => lease_seconds),
    'notifications', notifications_payload
  );
end;
$$;

create or replace function public.record_booking_reschedule_notification_recipient(
  p_notification_id uuid,
  p_lease_token uuid,
  p_recipient_key text,
  p_succeeded boolean,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_recipient_key text := lower(btrim(coalesce(p_recipient_key, '')));
  notification_kind text;
  recipient_row public.booking_reschedule_notification_recipients%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the reschedule notification processor may record recipient delivery.'
      using errcode = '42501';
  end if;
  if p_notification_id is null
     or p_lease_token is null
     or p_succeeded is null
     or clean_recipient_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Recipient delivery evidence is invalid.'
      using errcode = '22023';
  end if;

  select outbox.notification_kind into notification_kind
  from public.booking_reschedule_notification_outbox outbox
  where outbox.id = p_notification_id
    and outbox.status = 'processing'
    and outbox.lease_token = p_lease_token
    and outbox.lease_expires_at > now()
  for update;

  if notification_kind is null then
    return jsonb_build_object('ok', false, 'code', 'LEASE_NOT_OWNED');
  end if;
  if notification_kind <> 'admin_review_needed' then
    raise exception 'Per-recipient progress applies only to Telegram review delivery.'
      using errcode = '22023';
  end if;

  insert into public.booking_reschedule_notification_recipients as recipient (
    notification_id,
    recipient_key,
    attempts,
    sent_at,
    last_error
  ) values (
    p_notification_id,
    clean_recipient_key,
    1,
    case when p_succeeded then clock_timestamp() else null end,
    case
      when p_succeeded then null
      else left(
        coalesce(nullif(btrim(p_error), ''), 'Telegram delivery failed.'),
        2000
      )
    end
  )
  on conflict (notification_id, recipient_key) do update
  set attempts = least(recipient.attempts + 1, 20),
      sent_at = coalesce(
        recipient.sent_at,
        case when p_succeeded then clock_timestamp() else null end
      ),
      last_error = case
        when recipient.sent_at is not null or p_succeeded then null
        else left(
          coalesce(nullif(btrim(p_error), ''), 'Telegram delivery failed.'),
          2000
        )
      end,
      updated_at = clock_timestamp()
  returning recipient.* into recipient_row;

  return jsonb_build_object(
    'ok', true,
    'sent', recipient_row.sent_at is not null,
    'recipientKey', recipient_row.recipient_key,
    'attempts', recipient_row.attempts,
    'sentAt', recipient_row.sent_at
  );
end;
$$;

create or replace function public.finish_booking_reschedule_notification(
  p_notification_id uuid,
  p_lease_token uuid,
  p_succeeded boolean,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  completed public.booking_reschedule_notification_outbox%rowtype;
  retry_seconds integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the reschedule notification processor may finish notifications.'
      using errcode = '42501';
  end if;
  if p_notification_id is null
     or p_lease_token is null
     or p_succeeded is null then
    raise exception 'Notification id, lease token, and outcome are required.'
      using errcode = '22023';
  end if;

  select least(3600, (15 * power(2, least(outbox.attempts, 8)))::integer)
  into retry_seconds
  from public.booking_reschedule_notification_outbox outbox
  where outbox.id = p_notification_id;

  update public.booking_reschedule_notification_outbox outbox
  set status = case when p_succeeded then 'sent' else 'failed' end,
      sent_at = case when p_succeeded then clock_timestamp() else null end,
      available_at = case
        when p_succeeded then outbox.available_at
        else now() + make_interval(secs => coalesce(retry_seconds, 60))
      end,
      last_error = case
        when p_succeeded then null
        else left(
          coalesce(nullif(btrim(p_error), ''), 'Notification delivery failed.'),
          2000
        )
      end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where outbox.id = p_notification_id
    and outbox.status = 'processing'
    and outbox.lease_token = p_lease_token
    and outbox.lease_expires_at > now()
  returning outbox.* into completed;

  if completed.id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'LEASE_NOT_OWNED'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', completed.id,
    'status', completed.status,
    'attempts', completed.attempts,
    'sentAt', completed.sent_at,
    'nextAttemptAt', case
      when completed.status = 'failed' then completed.available_at
      else null
    end
  );
end;
$$;

revoke all on function public.claim_booking_reschedule_notifications(
  text, integer, integer, uuid
) from public, anon, authenticated;
grant execute on function public.claim_booking_reschedule_notifications(
  text, integer, integer, uuid
) to service_role;

revoke all on function public.retry_booking_reschedule_notifications(uuid)
  from public, anon, authenticated;
grant execute on function public.retry_booking_reschedule_notifications(uuid)
  to service_role;

revoke all on function public.finish_booking_reschedule_notification(
  uuid, uuid, boolean, text
) from public, anon, authenticated;
grant execute on function public.finish_booking_reschedule_notification(
  uuid, uuid, boolean, text
) to service_role;

revoke all on function public.record_booking_reschedule_notification_recipient(
  uuid, uuid, text, boolean, text
) from public, anon, authenticated;
grant execute on function public.record_booking_reschedule_notification_recipient(
  uuid, uuid, text, boolean, text
) to service_role;

comment on function public.claim_booking_reschedule_notifications(
  text, integer, integer, uuid
) is 'Service-role-only SKIP LOCKED notification claim. Optional request filter lets a proof-validating Edge request dispatch only its own outbox rows.';
comment on function public.retry_booking_reschedule_notifications(uuid) is
  'Service-role-only explicit retry: makes failed, non-exhausted request notifications immediately claimable without changing status or attempt history.';
comment on function public.finish_booking_reschedule_notification(
  uuid, uuid, boolean, text
) is 'Completes only a currently owned delivery lease; failures are retained with bounded exponential retry.';
comment on function public.record_booking_reschedule_notification_recipient(
  uuid, uuid, text, boolean, text
) is 'Records per-chat Telegram progress under the active outbox lease using only an Edge-computed HMAC fingerprint; prior success is never overwritten.';

revoke all on function public.guard_booking_reschedule_request_history()
  from public, anon, authenticated;
revoke all on function public.deny_booking_reschedule_audit_mutation()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
