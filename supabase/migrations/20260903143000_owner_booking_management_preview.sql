-- Active System Owner preview for the public Manage Booking presentation.
--
-- This is deliberately separate from the guest RPC. It does not weaken the
-- original-device bearer-token requirement for players, and it exposes only
-- the same bounded, non-PII fields as the guest-safe booking view.

create or replace function public.get_owner_booking_for_management(
  p_ref text,
  p_email text
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
set search_path = public, pg_temp
as $$
declare
  requested_ref text := upper(trim(coalesce(p_ref, '')));
  requested_email text := lower(trim(coalesce(p_email, '')));
  anchor_ref text;
  anchor_group_ref text;
begin
  if auth.uid() is null
     or not exists (
       select 1
         from public.accounts account
        where account.id = auth.uid()
          and account.status = 'active'
          and account.role = 'owner'
     ) then
    raise exception 'An active System Owner account is required.'
      using errcode = '42501';
  end if;

  if length(requested_ref) > 72
     or requested_ref !~ '^PB-[A-Z0-9]+(-[A-Z0-9]+)*$'
     or length(requested_email) > 254
     or requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Invalid booking lookup.'
      using errcode = '22023';
  end if;

  select b.ref, nullif(trim(b.booking_group_ref), '')
    into anchor_ref, anchor_group_ref
    from public.bookings b
   where lower(trim(coalesce(b.email, ''))) = requested_email
     and (
       upper(b.ref) = requested_ref
       or upper(coalesce(b.booking_group_ref, '')) = requested_ref
       or upper(coalesce(b.booking_group_ref, '')) = requested_ref || '-G'
       or regexp_replace(
         upper(coalesce(b.booking_group_ref, '')),
         '-G$',
         ''
       ) = requested_ref
     )
   order by
     case when upper(b.ref) = requested_ref then 0 else 1 end,
     b.created_at asc
   limit 1;

  if anchor_ref is null then
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
  where lower(trim(coalesce(b.email, ''))) = requested_email
    and (
      (anchor_group_ref is null and b.ref = anchor_ref)
      or (
        anchor_group_ref is not null
        and b.booking_group_ref = anchor_group_ref
      )
    )
  order by b.date asc, b.start_time asc, b.court_name asc, b.ref asc
  limit 8;
end;
$$;

revoke all on function public.get_owner_booking_for_management(text, text)
  from public, anon, authenticated;
grant execute on function public.get_owner_booking_for_management(text, text)
  to authenticated;

comment on function public.get_owner_booking_for_management(text, text) is
  'Active System Owner-only preview of the same bounded, non-PII booking fields shown by Manage Booking; reference and normalized booking email must match.';
