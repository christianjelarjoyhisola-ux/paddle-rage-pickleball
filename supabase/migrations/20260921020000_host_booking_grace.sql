-- One immutable internal record per booking group. Notes are never public booking fields.
create table public.host_booking_grace_audit (
  booking_key text primary key,
  booking_refs text[] not null,
  actor_user_id uuid not null,
  actor_role text not null,
  reason text not null check (length(btrim(reason)) >= 10),
  granted_at timestamptz not null,
  deadline_at timestamptz not null,
  prior_state jsonb not null,
  prior_forfeiture_notices jsonb not null default '[]'::jsonb
);
alter table public.host_booking_grace_audit enable row level security;
revoke all on public.host_booking_grace_audit from public, anon, authenticated;
grant select on public.host_booking_grace_audit to authenticated;
create policy owner_read_grace_audit on public.host_booking_grace_audit for select to authenticated
using (exists (select 1 from public.accounts a where a.id = auth.uid() and a.status = 'active' and a.role in ('owner','court_owner')));
alter table public.bookings add column balance_grace_granted_at timestamptz;

-- Derive deadlines from authoritative audit records, never client supplied overrides.
create or replace function public.set_host_balance_deadline()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare grace public.host_booking_grace_audit%rowtype;
begin
  select * into grace from public.host_booking_grace_audit a where new.ref = any(a.booking_refs) limit 1;
  new.balance_grace_granted_at := grace.granted_at;
  if coalesce(new.host_booking, false) then
    new.balance_due_at := case when grace.booking_key is not null then
      least(grace.deadline_at, public.booking_start_at_ph(new.date, new.start_time, new.slots))
      else public.host_balance_deadline_at_ph(new.date) end;
  else new.balance_due_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_set_host_balance_deadline on public.bookings;
create trigger trg_set_host_balance_deadline before insert or update of date, start_time, slots, host_booking, balance_due_at, balance_grace_granted_at
on public.bookings for each row execute function public.set_host_balance_deadline();

create or replace function public.reopen_forfeited_host_booking(
  p_booking_ref text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_ref text := nullif(btrim(coalesce(p_booking_ref, '')), '');
  clean_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  actor_id uuid := auth.uid();
  actor_role text;
  primary_ref text;
  group_ref text;
  v_booking_refs text[];
  booking_count integer;
  forfeited_count integer;
  earliest_start timestamptz;
  prior_forfeiture text;
  paid_time timestamptz := clock_timestamp();
  new_deadline timestamptz;
begin
  if requested_ref is null then
    raise exception using errcode = '22023', message = 'A booking reference is required.';
  end if;
  if clean_reason is null or length(clean_reason) < 10 then
    raise exception using errcode = '22023', message = 'Enter a internal reason of at least 10 characters.';
  end if;

  select account.role into actor_role
  from public.accounts account
  where account.id = actor_id and account.status = 'active'
  limit 1;

  if actor_id is null or coalesce(actor_role, '') not in ('owner', 'court_owner') then
    raise exception using errcode = '42501', message = 'Only an owner can restore a forfeited booking.';
  end if;

  lock table public.bookings in share row exclusive mode;

  select booking.ref, nullif(btrim(booking.booking_group_ref), '')
    into primary_ref, group_ref
  from public.bookings booking
  where booking.ref = requested_ref or booking.booking_group_ref = requested_ref
  order by case when booking.ref = requested_ref then 0 else 1 end,
           booking.created_at, booking.ref
  limit 1;

  if primary_ref is null then
    raise exception using errcode = 'P0002', message = 'Booking or booking group was not found.';
  end if;

  perform booking.ref
  from public.bookings booking
  where (group_ref is not null and booking.booking_group_ref = group_ref)
     or (group_ref is null and booking.ref = primary_ref)
  order by booking.ref
  for update;

  select array_agg(booking.ref order by booking.ref), count(*)::integer,
         count(*) filter (
           where coalesce(booking.host_booking, false)
             and booking.status = 'forfeited'
             and booking.payment_status = 'deposit_retained'
         )::integer,
         min(public.booking_start_at_ph(booking.date, booking.start_time, booking.slots)),
         string_agg(
           format('%s forfeited_at=%s reason=%s', booking.ref, booking.forfeited_at,
                  coalesce(booking.forfeiture_reason, '')),
           '; ' order by booking.ref
         )
    into v_booking_refs, booking_count, forfeited_count, earliest_start, prior_forfeiture
  from public.bookings booking
  where (group_ref is not null and booking.booking_group_ref = group_ref)
     or (group_ref is null and booking.ref = primary_ref);

  if booking_count = 0 or forfeited_count <> booking_count then
    raise exception using errcode = 'P0001',
      message = 'Every row must still be forfeited with its deposit retained.';
  end if;
  if earliest_start is null or earliest_start <= now() then
    raise exception using errcode = 'P0001', message = 'This booking has already started or elapsed.';
  end if;

  if exists (select 1 from public.host_booking_grace_audit a where a.booking_refs && v_booking_refs) then
    raise exception 'This booking has already received its one-time extension.';
  end if;
  if exists (select 1 from public.bookings b where b.ref = any(v_booking_refs) and (b.downpayment is null or b.downpayment < 0 or b.total <= b.downpayment)) then
    raise exception 'The booking must have a recorded deposit and an unpaid balance.';
  end if;
  new_deadline := least(paid_time + interval '24 hours', earliest_start);

  perform payment.id
  from public.host_booking_balance_payments payment
  where payment.booking_key = coalesce(group_ref, primary_ref)
     or payment.booking_ref = any(v_booking_refs)
     or payment.booking_refs && v_booking_refs
  order by payment.id
  for update;

  if exists (
    select 1
    from public.host_booking_balance_payments payment
    where (
      payment.booking_key = coalesce(group_ref, primary_ref)
      or payment.booking_ref = any(v_booking_refs)
      or payment.booking_refs && v_booking_refs
    )
      and payment.status = 'pending_review'
  ) then
    raise exception using errcode = 'P0001',
      message = 'A submitted balance receipt is awaiting Payment Review and must be resolved first.';
  end if;

  if exists (
    select 1
    from public.bookings target
    join public.bookings occupied
      on occupied.court_id = target.court_id
     and occupied.date = target.date
     and occupied.ref <> all(v_booking_refs)
     and occupied.status not in ('cancelled', 'forfeited')
     and occupied.slots && target.slots
     and (occupied.status <> 'verifying' or occupied.created_at is null
          or occupied.created_at > now() - interval '15 minutes')
    where target.ref = any(v_booking_refs)
  ) then
    raise exception using errcode = 'P0001',
      message = 'This booking cannot be restored because one or more slots were booked again.';
  end if;

  update public.host_booking_balance_payments payment
     set status = 'expired',
         review_reason = 'Closed because an owner reopened the booking with a new balance deadline.',
         updated_at = paid_time
   where (
      payment.booking_key = coalesce(group_ref, primary_ref)
      or payment.booking_ref = any(v_booking_refs)
      or payment.booking_refs && v_booking_refs
   )
     and payment.status = 'created';

  insert into public.host_booking_grace_audit
    (booking_key, booking_refs, actor_user_id, actor_role, reason, granted_at, deadline_at, prior_state)
  select coalesce(group_ref, primary_ref), v_booking_refs, actor_id, actor_role, clean_reason,
    paid_time, new_deadline, jsonb_agg(jsonb_build_object('ref', b.ref,
      'deadline', b.balance_due_at, 'forfeitedAt', b.forfeited_at, 'reason', b.forfeiture_reason))
  from public.bookings b where b.ref = any(v_booking_refs);

  -- Retain old delivery history before allowing a notice for a second forfeiture.
  perform 1 from public.booking_balance_notifications n
    where n.booking_key = coalesce(group_ref, primary_ref) and n.event_type = 'forfeited' for update;
  if exists (select 1 from public.booking_balance_notifications n
      where n.booking_key = coalesce(group_ref, primary_ref) and n.event_type = 'forfeited'
      and n.delivery_lease_expires_at > clock_timestamp()) then
    raise exception 'A forfeiture notice is being delivered. Please try reopening again shortly.';
  end if;
  update public.host_booking_grace_audit a set prior_forfeiture_notices =
    coalesce((select jsonb_agg(to_jsonb(n)) from public.booking_balance_notifications n
      where n.booking_key = a.booking_key and n.event_type = 'forfeited'), '[]'::jsonb)
    where a.booking_key = coalesce(group_ref, primary_ref);
  update public.booking_balance_notifications n set status = 'failed',
    sent_at = null, provider_message_id = null, delivery_lease_token = null,
    delivery_lease_expires_at = null, error_message = 'Booking reopened; prior delivery retained in grace audit.'
    where n.booking_key = coalesce(group_ref, primary_ref) and n.event_type = 'forfeited';

  update public.bookings booking
     set status = 'confirmed', payment_status = 'downpayment_paid',
         balance_due_at = new_deadline, balance_grace_granted_at = paid_time,
         forfeited_at = null, forfeiture_reason = null
   where booking.ref = any(v_booking_refs);

  return jsonb_build_object('status', 'confirmed', 'paymentStatus', 'downpayment_paid',
    'balanceDueAt', new_deadline, 'refs', to_jsonb(v_booking_refs));

end;
$$;

revoke all on function public.reopen_forfeited_host_booking(text, text)
  from public, anon, authenticated;
grant execute on function public.reopen_forfeited_host_booking(text, text)
  to authenticated;
