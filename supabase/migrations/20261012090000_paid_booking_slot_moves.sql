-- Paid schedule portions preserve the original payment and fee audit trail.
begin;
alter table public.bookings add column if not exists schedule_payment_root_ref text;
create table public.booking_schedule_moves (
 id uuid primary key default gen_random_uuid(), actor_id uuid not null,
 transaction_id bigint not null, anchor_ref text not null, write_refs text[] not null,
 before_schedule jsonb not null, after_schedule jsonb, note text,
 writing boolean not null default true, created_at timestamptz not null default now(),
 email_claimed_at timestamptz, email_sent_at timestamptz
);
create table public.booking_schedule_payment_roots (
 ref text primary key, original_group_ref text,
 created_at timestamptz not null default now()
);
alter table public.booking_schedule_moves enable row level security;
alter table public.booking_schedule_payment_roots enable row level security;
revoke all on public.booking_schedule_moves, public.booking_schedule_payment_roots from public,anon,authenticated;
grant select on public.booking_schedule_moves, public.booking_schedule_payment_roots to service_role;
grant update(email_claimed_at,email_sent_at) on public.booking_schedule_moves to service_role;

create function public.booking_schedule_write_authorized(p_ref text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.booking_schedule_moves m
 where m.id::text=current_setting('paddle_rage.schedule_move',true)
 and m.transaction_id=txid_current() and m.actor_id=auth.uid() and m.writing
 and p_ref=any(m.write_refs))
$$;
revoke all on function public.booking_schedule_write_authorized(text) from public,anon,authenticated;

create function public.guard_booking_schedule_root() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if ((tg_op='INSERT' and new.schedule_payment_root_ref is not null)
 or (tg_op='UPDATE' and new.schedule_payment_root_ref is distinct from old.schedule_payment_root_ref))
 and not public.booking_schedule_write_authorized(new.ref) then
 raise exception 'Schedule payment links are server managed.' using errcode='42501';
 end if;
 return new;
end $$;
create trigger a03_guard_booking_schedule_root before insert or update on public.bookings
for each row execute function public.guard_booking_schedule_root();
revoke all on function public.guard_booking_schedule_root() from public,anon,authenticated;

CREATE OR REPLACE FUNCTION public.guard_earned_booking_fee_units()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
 if public.booking_schedule_write_authorized(new.ref) then return new; end if;
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
$function$;


CREATE OR REPLACE FUNCTION public.guard_voucher_booking()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r public.voucher_redemptions%rowtype;
  internal_write boolean := auth.role()='service_role' and current_setting('paddle_rage.voucher_write',true)='on';
begin
 if public.booking_schedule_write_authorized(new.ref) then return new; end if;
  if tg_op='INSERT' then
    if new.voucher_redemption_id is not null or new.voucher_original_total is not null or new.voucher_discount<>0 or new.voucher_code is not null or new.payment_status='complimentary' then
      raise exception 'Vouchers must be applied through the voucher service.';
    end if;
    if new.booking_group_ref is not null and exists(select 1 from public.bookings where booking_group_ref=new.booking_group_ref and voucher_redemption_id is not null) then
      raise exception 'Cannot add items after a group voucher has been reserved.';
    end if;
    return new;
  end if;
  if old.voucher_original_total is not null and new.voucher_original_total is distinct from old.voucher_original_total then
    raise exception 'Original booking price is immutable.';
  end if;
  if not coalesce(internal_write,false) and (
    new.voucher_original_total is distinct from old.voucher_original_total or
    new.voucher_discount is distinct from old.voucher_discount or
    new.voucher_redemption_id is distinct from old.voucher_redemption_id or
    new.voucher_code is distinct from old.voucher_code or
    (new.payment_status='complimentary' and old.payment_status<>'complimentary')
  ) then raise exception 'Voucher fields are server managed.'; end if;
  if new.voucher_redemption_id is not null then
    select * into r from public.voucher_redemptions where id=new.voucher_redemption_id;
    if new.total <> new.voucher_original_total-new.voucher_discount then raise exception 'Voucher price snapshot mismatch.'; end if;
    if new.payment_transfer_id is not null or new.payment_reassigned_from_ref is not null or new.payment_reassigned_to_ref is not null then
      raise exception 'Payment transfers involving vouchers are not supported.';
    end if;
    if new.booking_group_ref is distinct from old.booking_group_ref or new.ref is distinct from old.ref then raise exception 'Voucher booking scope is immutable.'; end if;
    if not public.voucher_play_allowed(r.rules,new.court_id,new.date,new.slots,coalesce(new.host_booking,false)) then raise exception 'The new schedule is outside the voucher restrictions.'; end if;
    if new.status not in ('cancelled','forfeited') then
      if r.state='released' then raise exception 'This voucher reservation has expired. Start a new booking.'; end if;
      if not (new.status='verifying' and lower(trim(coalesce(new.email,'')))='reserve@hold.internal') and (lower(trim(coalesce(new.email,'')))<>r.email or public.voucher_normalize_phone(new.contact_number)<>r.phone or new.host_user_id is distinct from r.host_user_id) then
        raise exception 'Remove the voucher before changing the booking contact.';
      end if;
    end if;
    if new.payment_status='complimentary' and (new.total<>0 or new.downpayment<>0 or new.paid_at is not null) then raise exception 'Complimentary bookings cannot contain collected payments.'; end if;
    if old.payment_status='complimentary' and new.payment_status<>'complimentary' then raise exception 'Complimentary payment state is immutable.'; end if;
  end if;
  return new;
end $function$;


CREATE OR REPLACE FUNCTION public.snapshot_booking_fee_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  fee_text text;
  fee_type_text text;
  fee_rate numeric := 0;
  fee_type text := 'per_hour';
  fee_units numeric := 0;
  calculated_fee numeric := 0;
  authoritative_total numeric := 0;
begin
 if public.booking_schedule_write_authorized(new.ref) then
 new.booking_fee_amount_snapshot:=0; new.booking_fee_rate_snapshot:=0;
 new.booking_fee_type_snapshot:='per_hour'; new.booking_fee_units_snapshot:=0;
 new.booking_fee_snapshot_source:='paid_schedule_portion';
 new.booking_fee_ledger_eligible_snapshot:=false;
 new.booking_fee_earned_at:=null; new.weekly_fee_id:=null; new.billed_at:=null;
 return new; end if;
  select s.value
    into fee_text
    from public.settings s
   where s.key in ('maintenance_fee', 'service_fee_rate', 'booking_fee')
     and s.value is not null
   order by case s.key
     when 'maintenance_fee' then 1
     when 'service_fee_rate' then 2
     else 3
   end
   limit 1;

  if trim(coalesce(fee_text, '')) ~ '^[0-9]+([.][0-9]+)?$' then
    fee_rate := round(trim(fee_text)::numeric, 2);
  end if;

  select s.value
    into fee_type_text
    from public.settings s
   where s.key = 'fee_type'
   limit 1;

  if lower(trim(coalesce(fee_type_text, ''))) in
     ('flat', 'booking', 'per_booking', 'per_transaction') then
    fee_type := 'flat';
    fee_units := 1;
  else
    fee_units := coalesce(cardinality(new.slots), 0);
  end if;

  calculated_fee := round(greatest(fee_rate, 0) * greatest(fee_units, 0), 2);
  authoritative_total := round(greatest(coalesce(new.total, 0), 0), 2);

  -- Ignore all client-supplied snapshot values.
  new.booking_fee_rate_snapshot := greatest(fee_rate, 0);
  new.booking_fee_type_snapshot := fee_type;
  new.booking_fee_units_snapshot := greatest(fee_units, 0);
  new.booking_fee_amount_snapshot := least(calculated_fee, authoritative_total);
  new.booking_fee_snapshot_source := 'server_insert';
  new.booking_fee_ledger_eligible_snapshot := (
    auth.role() = 'anon'
    or public.current_account_role() = 'host'
    or (
      lower(coalesce(new.created_via, '')) in ('customer', 'host', 'admin')
      and lower(coalesce(new.payment_method, '')) <> 'manual'
      and new.ref not ilike 'MANUAL-%'
    )
  );

  -- Restores and direct inserts may carry old client-controlled billing stamps.
  -- Preserve them only when this exact reference belongs to a paid legacy
  -- statement; otherwise clear them so they cannot suppress the new ledger.
  if not exists (
    select 1
      from public.weekly_fees wf
     where wf.status = 'paid'
       and (
         coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(new.ref)
         or (
           public.current_account_role() = 'owner'
           and wf.id = new.weekly_fee_id
         )
       )
  ) then
    new.weekly_fee_id := null;
    new.billed_at := null;
  end if;

  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION public.claim_booking_reference_when_settled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
 if public.booking_schedule_write_authorized(new.ref) then return new; end if;
 if new.schedule_payment_root_ref is not null then
 select case when original_group_ref is null then 'booking' else 'booking_group' end,
 coalesce(original_group_ref,ref) into owner_scope,owner_id
 from public.booking_schedule_payment_roots where ref=new.schedule_payment_root_ref;
 if owner_id is null then raise exception 'Payment source not found.'; end if;
 end if;
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
$function$;


create function public.paid_schedule_family(p_ref text) returns text[]
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a public.bookings%rowtype; refs text[]; b public.bookings%rowtype;
begin
 if not public.has_account_role(array['owner','court_owner','staff']) then
 raise exception 'An active dashboard account is required.' using errcode='42501'; end if;
 select * into a from public.bookings where ref=btrim(p_ref);
 if a.ref is null then raise exception 'Booking not found.'; end if;
 select array_agg(ref order by ref) into refs from public.bookings
 where ref=a.ref or (a.booking_group_ref is not null and booking_group_ref=a.booking_group_ref);
 if cardinality(refs) not between 1 and 8 then raise exception 'This reservation supports up to eight schedule portions.'; end if;
 for b in select * from public.bookings where ref=any(refs) loop
 perform public.admin_reschedule_booking_context(b.ref);
 if b.payment_status is distinct from 'paid' or b.status is distinct from 'confirmed' then
 raise exception 'Court and slot changes require a fully paid, confirmed reservation.'; end if;
 if b.payment_transfer_id is not null or b.payment_reassigned_to_ref is not null then
 raise exception 'This booking has a payment transfer. Review its transfer before changing court-hours.'; end if;
 end loop;
 return refs;
end $$;
revoke all on function public.paid_schedule_family(text) from public,anon,authenticated;

create function public.paid_schedule_snapshot(p_refs text[]) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('bookingRef',ref,'courtId',court_id,
 'courtName',court_name,'date',date,'slots',slots,'startTime',start_time,'endTime',end_time,
 'duration',duration,'total',total,'downpayment',downpayment,
 'voucherOriginalTotal',voucher_original_total,'voucherDiscount',voucher_discount)
 order by ref),'[]'::jsonb) from public.bookings where ref=any(p_refs)
$$;
revoke all on function public.paid_schedule_snapshot(text[]) from public,anon,authenticated;

create function public.get_paid_schedule_options(p_ref text,p_date date) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare refs text[]; courts_json jsonb; a public.bookings%rowtype;
begin
 refs:=public.paid_schedule_family(p_ref);
 if p_date is null or p_date<timezone('Asia/Manila',now())::date or p_date>timezone('Asia/Manila',now())::date+366 then
 raise exception 'Choose a date within the next year.'; end if;
 select * into a from public.bookings where ref=p_ref;
 select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'hours',(
 select coalesce(jsonb_agg(h order by h),'[]'::jsonb) from generate_series(0,23) h
 where public.booking_reschedule_schedule_available(c.id,p_date,array[h::text],refs))) order by c.id)
 into courts_json from public.courts c where not coalesce(c.blocked,false);
 return jsonb_build_object('items',public.paid_schedule_snapshot(refs),'courts',coalesce(courts_json,'[]'::jsonb),
 'fullName',a.full_name,'bookingRef',coalesce(a.booking_group_ref,a.ref),'date',p_date);
end $$;
revoke all on function public.get_paid_schedule_options(text,date) from public,anon;
grant execute on function public.get_paid_schedule_options(text,date) to authenticated;

create function public.move_paid_booking_slots(p_ref text,p_changes jsonb,p_note text default '') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
 refs text[]; locked_refs text[]; a public.bookings%rowtype; b public.bookings%rowtype;
 portion public.bookings%rowtype; change jsonb; slot jsonb; block record;
 before_json jsonb; after_json jsonb; plans jsonb:='[]'::jsonb; plan jsonb;
 selected_refs text[]; expected text[]; target_slots text[]; lock_key text;
 source_hours integer; used_hours integer; segment_hours integer; n integer;
 new_ref text; group_key text; root_ref text; move_id uuid; write_refs text[];
 amount numeric; deposit numeric; original_amount numeric; discount numeric; retained_fee numeric;
 previous_total numeric; previous_deposit numeric; previous_original numeric; previous_discount numeric;
 voucher_rules jsonb;
begin
 refs:=public.paid_schedule_family(p_ref);
 select * into a from public.bookings where ref=p_ref;
 perform pg_advisory_xact_lock(hashtextextended('paddle-rage-reschedule-family|'||coalesce(a.booking_group_ref,a.ref),0));
 perform ref from public.bookings where ref=any(refs) order by ref for update;
 locked_refs:=public.paid_schedule_family(p_ref);
 if refs is distinct from locked_refs then raise exception 'Booking changed. Reopen the schedule editor.' using errcode='40001'; end if;
 before_json:=public.paid_schedule_snapshot(refs);
 if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes)<>cardinality(refs) then
 raise exception 'Include every schedule in this reservation.'; end if;
 select array_agg(value->>'bookingRef' order by value->>'bookingRef') into selected_refs from jsonb_array_elements(p_changes);
 if selected_refs is distinct from refs then raise exception 'The selected booking family changed.'; end if;
 for change in select value from jsonb_array_elements(p_changes) loop
 select * into b from public.bookings where ref=change->>'bookingRef';
 if jsonb_typeof(change->'expectedTotal') is distinct from 'number'
 or (change->>'expectedTotal')::numeric is distinct from b.total then
 raise exception 'The payment amount changed. Reopen the editor.' using errcode='40001'; end if;
 if change->>'expectedDate' is distinct from b.date::text or change->>'expectedCourtId' is distinct from b.court_id
 or jsonb_typeof(change->'expectedSlots') is distinct from 'array' then
 raise exception 'The original schedule changed. Reopen the editor.' using errcode='40001'; end if;
 select array_agg(value order by value::integer) into expected from jsonb_array_elements_text(change->'expectedSlots');
 if expected is distinct from (select array_agg(s order by s::integer) from unnest(b.slots) s) then
 raise exception 'The original time slots changed.' using errcode='40001'; end if;
 source_hours:=cardinality(b.slots);
 if jsonb_typeof(change->'slots') is distinct from 'array' or jsonb_array_length(change->'slots')<>source_hours then
 raise exception 'Keep exactly the original paid court-hours for every booking portion.'; end if;
 for slot in select value from jsonb_array_elements(change->'slots') loop
 if jsonb_typeof(slot) is distinct from 'object' or nullif(slot->>'courtId','') is null
 or coalesce(slot->>'date','') !~ '^\d{4}-\d{2}-\d{2}$'
 or jsonb_typeof(slot->'hour') is distinct from 'number'
 or coalesce(slot->>'hour','') !~ '^(?:[0-9]|1[0-9]|2[0-3])$' then
 raise exception 'Select valid court and hourly slots.'; end if;
 end loop;
 used_hours:=0; n:=0; previous_total:=0; previous_deposit:=0; previous_original:=0; previous_discount:=0;
 -- Consecutive hours on one court/date become one ordinary booking row.
 for block in
 with slots as (select value->>'courtId' court_id,(value->>'date')::date slot_date,(value->>'hour')::integer h
 from jsonb_array_elements(change->'slots')),
 islands as (select *,h-row_number() over(partition by court_id,slot_date order by h) island from slots)
 select court_id,slot_date,array_agg(h::text order by h) hours,min(h) first_hour,max(h)+1 last_hour
 from islands group by court_id,slot_date,island order by slot_date,court_id,min(h)
 loop
 n:=n+1; segment_hours:=cardinality(block.hours); used_hours:=used_hours+segment_hours;
 new_ref:=case when n=1 then b.ref else 'PB-RS-'||replace(gen_random_uuid()::text,'-','') end;
 -- Keep the source's existing fee obligation funded on its original row.
 -- Allocate the remaining rental value by hours without adding a new fee.
 retained_fee:=least(coalesce(b.total,0),coalesce(b.booking_fee_amount_snapshot,0));
 amount:=retained_fee+round((coalesce(b.total,0)-retained_fee)*used_hours/source_hours,2)-previous_total;
 previous_total:=previous_total+amount;
 deposit:=case when b.downpayment is null then null else round(b.downpayment*used_hours/source_hours,2)-previous_deposit end;
 previous_deposit:=previous_deposit+coalesce(deposit,0);
 original_amount:=case when b.voucher_original_total is null then null else round(b.voucher_original_total*used_hours/source_hours,2)-previous_original end;
 previous_original:=previous_original+coalesce(original_amount,0);
 discount:=round(coalesce(b.voucher_discount,0)*used_hours/source_hours,2)-previous_discount; previous_discount:=previous_discount+discount;
 if original_amount is not null then amount:=original_amount-discount; end if;
 if b.voucher_redemption_id is not null then
 select rules into voucher_rules from public.voucher_redemptions where id=b.voucher_redemption_id;
 if public.voucher_play_allowed(voucher_rules,block.court_id,block.slot_date,block.hours,coalesce(b.host_booking,false)) is not true then
 raise exception 'A selected slot is outside this booking voucher restrictions.'; end if;
 end if;
 plans:=plans||jsonb_build_array(jsonb_build_object('sourceRef',b.ref,'ref',new_ref,
 'courtId',block.court_id,'date',block.slot_date,'slots',block.hours,'startHour',block.first_hour,'endHour',block.last_hour,
 'duration',segment_hours,'total',amount,'downpayment',deposit,'voucherOriginalTotal',original_amount,'voucherDiscount',discount));
 end loop;
 end loop;
 if jsonb_array_length(plans)>8 then raise exception 'Choose at most eight continuous court/time portions in this reservation.'; end if;
 if exists(select 1 from jsonb_array_elements(p_changes) c cross join lateral jsonb_array_elements(c->'slots') s
 group by s->>'courtId',s->>'date',s->>'hour' having count(*)>1) then
 raise exception 'The same court/time slot is selected more than once.' using errcode='23P01'; end if;
 -- Lock all destinations in the same order used by ordinary booking creation.
 for lock_key in select distinct (p->>'courtId')||'|'||(p->>'date')||'|'||s as k
 from jsonb_array_elements(plans) p cross join lateral jsonb_array_elements_text(p->'slots') s order by k loop
 perform pg_advisory_xact_lock(hashtextextended('paddle-rage-booking-slot|'||lock_key,0)); end loop;
 for plan in select value from jsonb_array_elements(plans) loop
 select array_agg(value) into target_slots from jsonb_array_elements_text(plan->'slots');
 if not public.booking_reschedule_schedule_available(plan->>'courtId',(plan->>'date')::date,target_slots,refs) then
 raise exception 'A selected court/time is no longer available. Nothing was changed.' using errcode='23P01'; end if;
 end loop;
 select array_agg(value->>'ref') into write_refs from jsonb_array_elements(plans);
 insert into public.booking_schedule_moves(actor_id,transaction_id,anchor_ref,write_refs,before_schedule,note)
 values(auth.uid(),txid_current(),p_ref,write_refs,before_json,left(p_note,1200)) returning id into move_id;
 perform set_config('paddle_rage.schedule_move',move_id::text,true);
 group_key:=coalesce(a.booking_group_ref,case when jsonb_array_length(plans)>1 then a.ref else null end);
 -- Clear only the locked source occupancy inside this transaction. Other
 -- sessions never see a released slot unless the complete move commits.
 update public.bookings set slots='{}' where ref=any(refs);
 for change in select value from jsonb_array_elements(p_changes) loop
 select * into b from public.bookings where ref=change->>'bookingRef';
 root_ref:=coalesce(b.schedule_payment_root_ref,b.ref);
 insert into public.booking_schedule_payment_roots(ref,original_group_ref)
 values(root_ref,b.booking_group_ref) on conflict(ref) do nothing;
 for plan in select value from jsonb_array_elements(plans) where value->>'sourceRef'=b.ref loop
 portion:=jsonb_populate_record(null::public.bookings,to_jsonb(b)||jsonb_build_object(
 'ref',plan->>'ref','booking_group_ref',group_key,'schedule_payment_root_ref',root_ref,
 'court_id',plan->>'courtId','court_name',(select name from public.courts where id=plan->>'courtId'),
 'date',plan->>'date','slots',plan->'slots','start_time',public.booking_reschedule_hour_label((plan->>'startHour')::integer),
 'end_time',public.booking_reschedule_hour_label((plan->>'endHour')::integer),'duration',plan->'duration',
 'total',plan->'total','downpayment',plan->'downpayment','voucher_original_total',plan->'voucherOriginalTotal','voucher_discount',plan->'voucherDiscount'));
 if portion.ref=b.ref then
 update public.bookings set booking_group_ref=portion.booking_group_ref,schedule_payment_root_ref=portion.schedule_payment_root_ref,
 court_id=portion.court_id,court_name=portion.court_name,date=portion.date,slots=portion.slots,
 start_time=portion.start_time,end_time=portion.end_time,duration=portion.duration,total=portion.total,
 downpayment=portion.downpayment,voucher_original_total=portion.voucher_original_total,voucher_discount=portion.voucher_discount
 where ref=b.ref;
 else
 portion.confirmation_email_claim_token:=null; portion.confirmation_email_claim_expires_at:=null;
 portion.confirmation_email_id:=null; portion.confirmation_email_sent_at:=null; portion.confirmation_email_last_event:=null;
 insert into public.bookings select portion.*;
 end if;
 end loop;
 end loop;
 update public.voucher_redemptions r set booking_refs=(
   select array_agg(ref order by ref) from public.bookings where voucher_redemption_id=r.id
 ) where r.id in (select voucher_redemption_id from public.bookings where ref=any(write_refs));
 after_json:=public.paid_schedule_snapshot(write_refs);
 if (select sum((x->>'duration')::numeric) from jsonb_array_elements(before_json) x) is distinct from
 (select sum((x->>'duration')::numeric) from jsonb_array_elements(after_json) x)
 or (select sum((x->>'total')::numeric) from jsonb_array_elements(before_json) x) is distinct from
 (select sum((x->>'total')::numeric) from jsonb_array_elements(after_json) x)
 or (select sum(coalesce((x->>'downpayment')::numeric,0)) from jsonb_array_elements(before_json) x) is distinct from
 (select sum(coalesce((x->>'downpayment')::numeric,0)) from jsonb_array_elements(after_json) x) then
 raise exception 'Paid hours or payment amounts changed. Nothing was saved.'; end if;
 update public.booking_schedule_moves set after_schedule=after_json,writing=false where id=move_id;
 perform set_config('paddle_rage.schedule_move','',true);
 return jsonb_build_object('ok',true,'moveId',move_id,'items',after_json,'before',before_json);
end $$;
revoke all on function public.move_paid_booking_slots(text,jsonb,text) from public,anon;
grant execute on function public.move_paid_booking_slots(text,jsonb,text) to authenticated;
commit;
