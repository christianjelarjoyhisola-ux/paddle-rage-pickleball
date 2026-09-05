-- Manual rescheduling preserves the paid court-hours and checks the same
-- availability rules used by guest requests, both when choosing and saving.
begin;

create or replace function public.admin_reschedule_booking_context(p_ref text)
returns public.bookings
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  booking public.bookings%rowtype;
  hours integer[];
begin
  if not public.has_account_role(array['owner','court_owner','staff']) then
    raise exception 'An active dashboard account is required.' using errcode='42501';
  end if;
  select b.* into booking from public.bookings b where b.ref=btrim(p_ref);
  if booking.ref is null then
    raise exception 'Booking not found.' using errcode='P0002';
  end if;
  if booking.status not in ('confirmed','pending','verifying') then
    raise exception 'Only an active booking can be rescheduled.' using errcode='23514';
  end if;
  if exists (select 1 from public.booking_reschedule_active_items a where a.booking_ref=booking.ref) then
    raise exception 'Review the pending reschedule request before moving this booking.' using errcode='23514';
  end if;
  if coalesce(cardinality(booking.slots),0)<1 or cardinality(booking.slots)>24
     or exists(select 1 from unnest(booking.slots) s where s is null or s !~ '^(?:[0-9]|1[0-9]|2[0-3])$') then
    raise exception 'The original booking has invalid time slots.' using errcode='23514';
  end if;
  select array_agg(s::integer order by s::integer) into hours from unnest(booking.slots) s;
  if (select count(distinct h) from unnest(hours) h)<>cardinality(hours)
     or hours[cardinality(hours)]-hours[1]+1<>cardinality(hours)
     or coalesce(booking.duration,cardinality(hours))<>cardinality(hours) then
    raise exception 'The original booking must have a continuous, valid duration.' using errcode='23514';
  end if;
  return booking;
end;
$$;
revoke all on function public.admin_reschedule_booking_context(text) from public,anon,authenticated;

create or replace function public.get_admin_reschedule_options(p_ref text,p_date date)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  booking public.bookings%rowtype;
  duration_hours integer;
  start_hour integer;
  candidate_slots text[];
  original_slots integer[];
  starts integer[] := '{}';
begin
  booking := public.admin_reschedule_booking_context(p_ref);
  if p_date is null or p_date<greatest(date '2026-09-19',timezone('Asia/Manila',now())::date)
     or p_date>timezone('Asia/Manila',now())::date+366 then
    raise exception 'Choose a valid date within the next year.' using errcode='22023';
  end if;
  duration_hours := cardinality(booking.slots);
  select array_agg(s::integer order by s::integer) into original_slots from unnest(booking.slots) s;
  for start_hour in 0..24-duration_hours loop
    select array_agg(h::text order by h) into candidate_slots
      from generate_series(start_hour,start_hour+duration_hours-1) h;
    -- Moving to the unchanged schedule is not a reschedule option.
    if p_date=booking.date and start_hour=original_slots[1] then continue; end if;
    if public.booking_reschedule_schedule_available(booking.court_id,p_date,candidate_slots,array[booking.ref]) then
      starts := array_append(starts,start_hour);
    end if;
  end loop;
  return jsonb_build_object('bookingRef',booking.ref,'courtId',booking.court_id,
    'date',p_date,'duration',duration_hours,'starts',starts,
    'oldDate',booking.date,'oldSlots',original_slots);
end;
$$;
revoke all on function public.get_admin_reschedule_options(text,date) from public,anon;
grant execute on function public.get_admin_reschedule_options(text,date) to authenticated;

create or replace function public.reschedule_booking_transaction(
  p_ref text,p_date date,p_start_hour integer,p_expected_date date,p_expected_slots integer[],p_expected_court_id text
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  booking public.bookings%rowtype;
  current_booking public.bookings%rowtype;
  family_key text;
  duration_hours integer;
  original_slots integer[];
  expected_slots integer[];
  candidate_slots text[];
  lock_key text;
begin
  booking := public.admin_reschedule_booking_context(p_ref);
  family_key := coalesce(nullif(btrim(booking.booking_group_ref),''),booking.ref);
  perform pg_advisory_xact_lock(hashtextextended('paddle-rage-reschedule-family|'||family_key,0));
  select b.* into current_booking from public.bookings b where b.ref=booking.ref for update;
  booking := public.admin_reschedule_booking_context(p_ref);
  if family_key<>coalesce(nullif(btrim(booking.booking_group_ref),''),booking.ref) then
    raise exception 'The booking changed. Reopen rescheduling.' using errcode='40001';
  end if;
  select array_agg(s::integer order by s::integer) into original_slots from unnest(booking.slots) s;
  select array_agg(h order by h) into expected_slots from unnest(p_expected_slots) h;
  if p_expected_date is distinct from booking.date or expected_slots is distinct from original_slots
     or p_expected_court_id is distinct from booking.court_id then
    raise exception 'The original schedule changed. Reopen rescheduling.' using errcode='40001';
  end if;
  duration_hours := cardinality(original_slots);
  if p_date is null or p_start_hour is null or p_start_hour<0 or p_start_hour+duration_hours>24 then
    raise exception 'Choose a complete available time slot.' using errcode='22023';
  end if;
  if p_date=booking.date and p_start_hour=original_slots[1] then
    raise exception 'Choose a different schedule.' using errcode='22023';
  end if;
  select array_agg(h::text order by h) into candidate_slots
    from generate_series(p_start_hour,p_start_hour+duration_hours-1) h;
  -- Match the booking occupancy trigger's keys and ordering to serialize
  -- selection with new reservations and owner approvals.
  for lock_key in select booking.court_id||'|'||p_date::text||'|'||s as key
    from unnest(candidate_slots) s order by key
  loop
    perform pg_advisory_xact_lock(hashtextextended('paddle-rage-booking-slot|'||lock_key,0));
  end loop;
  if not public.booking_reschedule_schedule_available(booking.court_id,p_date,candidate_slots,array[booking.ref]) then
    raise exception 'That time is no longer available. Choose another slot.' using errcode='23P01';
  end if;
  update public.bookings set date=p_date,slots=candidate_slots,
    start_time=public.booking_reschedule_hour_label(p_start_hour),
    end_time=public.booking_reschedule_hour_label(p_start_hour+duration_hours),
    duration=duration_hours where ref=booking.ref;
  return jsonb_build_object('bookingRef',booking.ref,'date',p_date,'slots',candidate_slots,
    'startTime',public.booking_reschedule_hour_label(p_start_hour),
    'endTime',public.booking_reschedule_hour_label(p_start_hour+duration_hours),
    'duration',duration_hours,'oldDate',booking.date,'oldSlots',original_slots);
end;
$$;
revoke all on function public.reschedule_booking_transaction(text,date,integer,date,integer[],text) from public,anon;
grant execute on function public.reschedule_booking_transaction(text,date,integer,date,integer[],text) to authenticated;

commit;
