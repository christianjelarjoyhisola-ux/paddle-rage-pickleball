-- Recoverable, single-sender claims for customer confirmation emails.

begin;

alter table public.bookings
  add column if not exists confirmation_email_claim_token uuid,
  add column if not exists confirmation_email_claim_expires_at timestamptz;

create or replace function public.guard_confirmation_email_claim_fields()
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
begin
  if request_role <> 'service_role' and (
    (tg_op = 'INSERT' and (
      new.confirmation_email_claim_token is not null or
      new.confirmation_email_claim_expires_at is not null
    )) or
    (tg_op = 'UPDATE' and (
      new.confirmation_email_claim_token is distinct from old.confirmation_email_claim_token or
      new.confirmation_email_claim_expires_at is distinct from old.confirmation_email_claim_expires_at
    ))
  ) then
    raise exception 'Confirmation delivery claim fields are server-owned.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists a05_guard_confirmation_email_claim_fields
  on public.bookings;
create trigger a05_guard_confirmation_email_claim_fields
before insert or update on public.bookings
for each row execute function public.guard_confirmation_email_claim_fields();

create index if not exists idx_bookings_confirmation_email_active_claim
  on public.bookings (confirmation_email_claim_expires_at)
  where confirmation_email_claim_token is not null;

create or replace function public.claim_booking_confirmation_email(
  p_booking_ref text,
  p_force boolean default false
)
returns table (
  claimed boolean,
  claim_token uuid,
  reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  target public.bookings%rowtype;
  logical_group text;
  logical_lock_key text;
  primary_ref text;
  token_value uuid := gen_random_uuid();
  has_sent boolean;
  has_live_claim boolean;
begin
  if request_role <> 'service_role' then
    raise exception 'Confirmation delivery claims are service-only.' using errcode = '42501';
  end if;

  select b.*
    into target
    from public.bookings b
   where b.ref = trim(coalesce(p_booking_ref, ''));
  if not found then
    return query select false, null::uuid, 'not_found'::text;
    return;
  end if;

  logical_group := nullif(trim(coalesce(target.booking_group_ref, '')), '');
  logical_lock_key := coalesce(logical_group, target.ref);
  perform pg_advisory_xact_lock(hashtextextended(
    'paddle-rage-confirmation-email:' || logical_lock_key,
    0
  ));

  -- Re-read after taking the logical-group lock so a concurrent state change
  -- cannot be evaluated from the pre-lock snapshot.
  select b.*
    into target
    from public.bookings b
   where b.ref = trim(coalesce(p_booking_ref, ''))
   for update;
  if not found then
    return query select false, null::uuid, 'not_found'::text;
    return;
  end if;
  logical_group := nullif(trim(coalesce(target.booking_group_ref, '')), '');
  if coalesce(logical_group, target.ref) <> logical_lock_key then
    logical_lock_key := coalesce(logical_group, target.ref);
    perform pg_advisory_xact_lock(hashtextextended(
      'paddle-rage-confirmation-email:' || logical_lock_key,
      0
    ));
  end if;

  if logical_group is not null then
    perform 1
      from public.bookings b
     where b.booking_group_ref = logical_group
     order by b.ref
     for update;
    select min(b.ref) into primary_ref
      from public.bookings b
     where b.booking_group_ref = logical_group;
    select
      bool_or(b.confirmation_email_id is not null or (
        b.confirmation_email_sent_at is not null and
        b.confirmation_email_last_event = 'sent'
      )),
      bool_or(
        b.confirmation_email_claim_token is not null and
        b.confirmation_email_claim_expires_at > clock_timestamp()
      )
      into has_sent, has_live_claim
      from public.bookings b
     where b.booking_group_ref = logical_group;
  else
    primary_ref := target.ref;
    has_sent := target.confirmation_email_id is not null or (
      target.confirmation_email_sent_at is not null and
      target.confirmation_email_last_event = 'sent'
    );
    has_live_claim := target.confirmation_email_claim_token is not null and
      target.confirmation_email_claim_expires_at > clock_timestamp();
  end if;

  if coalesce(has_live_claim, false) then
    return query select false, null::uuid, 'processing'::text;
    return;
  end if;
  if coalesce(has_sent, false) and not coalesce(p_force, false) then
    return query select false, null::uuid, 'already_sent'::text;
    return;
  end if;

  update public.bookings b
     set confirmation_email_claim_token = token_value,
         confirmation_email_claim_expires_at = clock_timestamp() + interval '5 minutes',
         confirmation_email_last_event = 'sending'
   where b.ref = primary_ref;

  return query select true, token_value, 'claimed'::text;
end;
$$;

create or replace function public.finish_booking_confirmation_email(
  p_booking_ref text,
  p_claim_token uuid,
  p_success boolean,
  p_provider_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  target public.bookings%rowtype;
  logical_group text;
  logical_lock_key text;
  primary_ref text;
begin
  if request_role <> 'service_role' then
    raise exception 'Confirmation delivery claims are service-only.' using errcode = '42501';
  end if;

  select b.*
    into target
    from public.bookings b
   where b.ref = trim(coalesce(p_booking_ref, ''));
  if not found then return false; end if;

  logical_group := nullif(trim(coalesce(target.booking_group_ref, '')), '');
  logical_lock_key := coalesce(logical_group, target.ref);
  perform pg_advisory_xact_lock(hashtextextended(
    'paddle-rage-confirmation-email:' || logical_lock_key,
    0
  ));

  select b.*
    into target
    from public.bookings b
   where b.ref = trim(coalesce(p_booking_ref, ''))
   for update;
  if not found then return false; end if;
  logical_group := nullif(trim(coalesce(target.booking_group_ref, '')), '');
  if coalesce(logical_group, target.ref) <> logical_lock_key then
    logical_lock_key := coalesce(logical_group, target.ref);
    perform pg_advisory_xact_lock(hashtextextended(
      'paddle-rage-confirmation-email:' || logical_lock_key,
      0
    ));
  end if;

  if logical_group is not null then
    select min(b.ref) into primary_ref
      from public.bookings b
     where b.booking_group_ref = logical_group;
  else
    primary_ref := target.ref;
  end if;

  if not exists (
    select 1
      from public.bookings b
     where b.ref = primary_ref
       and b.confirmation_email_claim_token = p_claim_token
  ) then
    return false;
  end if;

  if p_success then
    update public.bookings b
       set confirmation_email_id = nullif(trim(coalesce(p_provider_id, '')), ''),
           confirmation_email_sent_at = clock_timestamp(),
           confirmation_email_last_event = 'sent',
           confirmation_email_claim_token = null,
           confirmation_email_claim_expires_at = null
     where (logical_group is not null and b.booking_group_ref = logical_group)
        or (logical_group is null and b.ref = primary_ref);
  else
    update public.bookings b
       set confirmation_email_last_event = 'failed',
           confirmation_email_claim_token = null,
           confirmation_email_claim_expires_at = null
     where b.ref = primary_ref
       and b.confirmation_email_claim_token = p_claim_token;
  end if;
  return true;
end;
$$;

revoke all on function public.claim_booking_confirmation_email(text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_booking_confirmation_email(text, boolean)
  to service_role;
revoke all on function public.finish_booking_confirmation_email(text, uuid, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_booking_confirmation_email(text, uuid, boolean, text)
  to service_role;
revoke all on function public.guard_confirmation_email_claim_fields()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
