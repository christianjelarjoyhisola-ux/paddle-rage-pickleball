-- Secure, minimal guest booking-status lookup.
--
-- A booking reference and email address are not treated as authentication.
-- The caller must also possess the 256-bit bearer token created in the browser
-- that submitted the booking. Only non-PII scheduling and payment-state fields
-- are returned; receipt evidence and customer contact details stay private.

create index if not exists idx_bookings_customer_access_token_hash
  on public.bookings (customer_access_token_hash)
  where customer_access_token_hash is not null;

create or replace function public.get_public_booking_for_management(
  p_ref text,
  p_email text,
  p_access_token text
)
returns table (
  ref text,
  booking_group_ref text,
  court_id text,
  court_name text,
  date date,
  slots text[],
  start_time text,
  end_time text,
  duration numeric,
  rate numeric,
  total numeric,
  downpayment numeric,
  payment_method text,
  payment_status text,
  status text,
  balance_due_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  requested_ref text := upper(trim(coalesce(p_ref, '')));
  requested_email text := lower(trim(coalesce(p_email, '')));
  token_hash text;
  anchor_ref text;
  anchor_group_ref text;
  latest_booking_date date;
  earliest_booking_created_at timestamptz;
begin
  if requested_ref !~ '^PB-[A-Z0-9_-]{3,76}$'
     or length(requested_email) < 3
     or length(requested_email) > 254
     or requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or coalesce(p_access_token, '') !~ '^[0-9a-fA-F]{64}$' then
    return;
  end if;

  token_hash := encode(extensions.digest(p_access_token, 'sha256'), 'hex');

  select b.ref, nullif(trim(b.booking_group_ref), '')
    into anchor_ref, anchor_group_ref
    from public.bookings b
   where b.customer_access_token_hash = token_hash
     and lower(trim(coalesce(b.email, ''))) = requested_email
     and (
       upper(b.ref) = requested_ref
       or upper(coalesce(b.booking_group_ref, '')) = requested_ref
       or upper(coalesce(b.booking_group_ref, '')) = requested_ref || '-G'
       or regexp_replace(upper(coalesce(b.booking_group_ref, '')), '-G$', '') = requested_ref
     )
   order by case when upper(b.ref) = requested_ref then 0 else 1 end,
            b.created_at asc
   limit 1;

  if anchor_ref is null then
    return;
  end if;

  -- The device proof is useful through the visit and a short support window,
  -- but it is not a permanent public history endpoint.
  select max(b.date), min(b.created_at)
    into latest_booking_date, earliest_booking_created_at
    from public.bookings b
    where b.customer_access_token_hash = token_hash
      and lower(trim(coalesce(b.email, ''))) = requested_email
      and (
        (anchor_group_ref is null and b.ref = anchor_ref)
        or (anchor_group_ref is not null and b.booking_group_ref = anchor_group_ref)
      );

  if latest_booking_date is null
     or latest_booking_date < ((now() at time zone 'Asia/Manila')::date - 7)
     or earliest_booking_created_at is null
     or earliest_booking_created_at < (now() - interval '400 days') then
    return;
  end if;

  return query
  select
    b.ref,
    b.booking_group_ref,
    b.court_id,
    b.court_name,
    b.date,
    b.slots,
    b.start_time,
    b.end_time,
    b.duration,
    b.rate,
    b.total,
    b.downpayment,
    b.payment_method,
    b.payment_status,
    b.status,
    b.balance_due_at,
    b.created_at
  from public.bookings b
  where b.customer_access_token_hash = token_hash
    and lower(trim(coalesce(b.email, ''))) = requested_email
    and (
      (anchor_group_ref is null and b.ref = anchor_ref)
      or (anchor_group_ref is not null and b.booking_group_ref = anchor_group_ref)
    )
  order by b.date asc, b.start_time asc, b.court_name asc, b.ref asc
  limit 8;
end;
$$;

revoke all on function public.get_public_booking_for_management(text, text, text)
  from public, anon, authenticated;
grant execute on function public.get_public_booking_for_management(text, text, text)
  to anon, authenticated;

comment on function public.get_public_booking_for_management(text, text, text) is
  'Returns a minimal non-PII booking family only when ref, normalized email, and the original browser bearer token all match.';
