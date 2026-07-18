-- Serialize expensive receipt OCR/finalization for each logical booking while
-- still allowing recovery after an Edge runtime crash.

begin;

create table if not exists public.receipt_verification_leases (
  booking_key text primary key,
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint receipt_verification_leases_key_check
    check (length(booking_key) between 1 and 150)
);

alter table public.receipt_verification_leases enable row level security;
drop policy if exists receipt_verification_leases_no_access
  on public.receipt_verification_leases;
create policy receipt_verification_leases_no_access
  on public.receipt_verification_leases
  for all
  to anon, authenticated
  using (false)
  with check (false);

create or replace function public.claim_receipt_verification_lease(
  p_booking_key text,
  p_lease_seconds integer default 600
)
returns table (
  claimed boolean,
  claim_token uuid,
  lease_expires_at timestamptz
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
  normalized_key text := nullif(trim(coalesce(p_booking_key, '')), '');
  new_token uuid := gen_random_uuid();
  new_expiry timestamptz := clock_timestamp() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 600), 900)));
  claimed_row public.receipt_verification_leases%rowtype;
  current_expiry timestamptz;
begin
  if request_role <> 'service_role' then
    raise exception 'Receipt verification leases are service-only.' using errcode = '42501';
  end if;
  if normalized_key is null or length(normalized_key) > 150 then
    raise exception 'Receipt verification key is invalid.' using errcode = '22023';
  end if;

  insert into public.receipt_verification_leases as leases (
    booking_key,
    claim_token,
    lease_expires_at,
    updated_at
  ) values (
    normalized_key,
    new_token,
    new_expiry,
    clock_timestamp()
  )
  on conflict (booking_key) do update
    set claim_token = excluded.claim_token,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
    where leases.lease_expires_at <= clock_timestamp()
  returning * into claimed_row;

  if found then
    return query select true, claimed_row.claim_token, claimed_row.lease_expires_at;
    return;
  end if;

  select leases.lease_expires_at
    into current_expiry
    from public.receipt_verification_leases leases
   where leases.booking_key = normalized_key;
  return query select false, null::uuid, current_expiry;
end;
$$;

create or replace function public.release_receipt_verification_lease(
  p_booking_key text,
  p_claim_token uuid
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
begin
  if request_role <> 'service_role' then
    raise exception 'Receipt verification leases are service-only.' using errcode = '42501';
  end if;
  delete from public.receipt_verification_leases leases
   where leases.booking_key = trim(coalesce(p_booking_key, ''))
     and leases.claim_token = p_claim_token;
  return found;
end;
$$;

revoke all on table public.receipt_verification_leases
  from public, anon, authenticated;
revoke all on function public.claim_receipt_verification_lease(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_receipt_verification_lease(text, integer)
  to service_role;
revoke all on function public.release_receipt_verification_lease(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.release_receipt_verification_lease(text, uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
