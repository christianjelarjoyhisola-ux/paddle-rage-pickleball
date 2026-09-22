begin;

insert into public.settings(key,value) values ('vouchers_enabled','0') on conflict (key) do nothing;

-- Explicit commercial authority: existing court-owner accounts have no court
-- ownership column. The system owner assigns voucher funding authority here.
create table public.voucher_court_managers (
  user_id uuid not null references public.accounts(id),
  court_id text not null references public.courts(id),
  primary key(user_id,court_id)
);
create table public.voucher_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(name) between 1 and 100),
  created_by uuid not null references public.accounts(id),
  kind text not null check(kind in ('fixed','percent')),
  value numeric(12,2) not null check(value>0),
  max_discount numeric(12,2) check(max_discount>0),
  min_spend numeric(12,2) not null default 0 check(min_spend>=0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  max_uses integer not null check(max_uses between 1 and 100000),
  customer_limit integer check(customer_limit>0),
  court_ids text[] not null check(cardinality(court_ids)>0),
  booking_types text[] not null default array['guest','host'],
  play_from date,
  play_to date,
  weekdays integer[] not null default array[0,1,2,3,4,5,6],
  hour_from integer not null default 0 check(hour_from between 0 and 23),
  hour_to integer not null default 24 check(hour_to between 1 and 24),
  state text not null default 'active' check(state in ('active','paused','archived')),
  created_at timestamptz not null default now(),
  check(ends_at>starts_at), check(kind<>'percent' or value<=100),
  check(hour_to>hour_from), check(play_to is null or play_from is null or play_to>=play_from),
  check(cardinality(booking_types)>0 and booking_types <@ array['guest','host']),
  check(cardinality(weekdays)>0 and weekdays <@ array[0,1,2,3,4,5,6])
);
create table public.voucher_codes (
  code text primary key check(code ~ '^[A-Z0-9-]{6,40}$'),
  campaign_id uuid not null references public.voucher_campaigns(id),
  max_uses integer not null check(max_uses>0),
  created_at timestamptz not null default now()
);
create table public.voucher_redemptions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.voucher_campaigns(id),
  code text not null references public.voucher_codes(code),
  booking_key text not null,
  booking_refs text[] not null,
  full_name text not null,
  email text not null,
  phone text not null,
  host_user_id uuid,
  original_total numeric(12,2) not null,
  discount numeric(12,2) not null,
  rules jsonb not null,
  state text not null default 'reserved' check(state in ('reserved','consumed','released')),
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  released_at timestamptz
);
create unique index voucher_active_booking on public.voucher_redemptions(booking_key) where state<>'released';
create index voucher_campaign_usage on public.voucher_redemptions(campaign_id,state);
create table public.voucher_audit (
  id bigint generated always as identity primary key,
  campaign_id uuid references public.voucher_campaigns(id),
  redemption_id uuid references public.voucher_redemptions(id),
  actor_id uuid,
  event text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table public.voucher_attempt_limits (
  key text primary key,
  bucket timestamptz not null,
  attempts integer not null
);

alter table public.bookings add column voucher_original_total numeric(12,2),
  add column voucher_discount numeric(12,2) not null default 0,
  add column voucher_redemption_id uuid references public.voucher_redemptions(id),
  add column voucher_code text;
alter table public.bookings add constraint booking_voucher_amounts check(
  voucher_discount>=0 and (voucher_original_total is null or
  (voucher_original_total>=0 and voucher_discount<=voucher_original_total)));
alter table public.bookings drop constraint bookings_payment_status_check;
alter table public.bookings add constraint bookings_payment_status_check check(payment_status in
  ('unpaid','pending','for_verification','downpayment_paid','paid','failed','rejected','deposit_retained','complimentary'));

-- No direct client writes or public campaign enumeration.
do $$ declare t text; begin
  foreach t in array array['voucher_court_managers','voucher_campaigns','voucher_codes','voucher_redemptions','voucher_audit','voucher_attempt_limits'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;

create function public.voucher_normalize_phone(p_phone text) returns text
language sql immutable set search_path=public,pg_temp as $$
  select regexp_replace(regexp_replace(coalesce(p_phone,''),'[^0-9]','','g'),'^63','0')
$$;

create function public.voucher_play_allowed(p_rules jsonb,p_court text,p_date date,p_slots text[],p_host boolean)
returns boolean language sql immutable set search_path=public,pg_temp as $$
  select (p_rules->'court_ids') ? p_court
    and (p_rules->'booking_types') ? case when p_host then 'host' else 'guest' end
    and (p_rules->>'play_from' is null or p_date >= (p_rules->>'play_from')::date)
    and (p_rules->>'play_to' is null or p_date <= (p_rules->>'play_to')::date)
    and (p_rules->'weekdays') @> to_jsonb(extract(dow from p_date)::integer)
    and not exists(select 1 from unnest(p_slots) s where s::numeric < (p_rules->>'hour_from')::integer or s::numeric >= (p_rules->>'hour_to')::integer)
$$;

create function public.guard_voucher_booking() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.voucher_redemptions%rowtype;
  internal_write boolean := auth.role()='service_role' and current_setting('paddle_rage.voucher_write',true)='on';
begin
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
end $$;
create trigger a02_guard_voucher_booking before insert or update on public.bookings for each row execute function public.guard_voucher_booking();

create function public.voucher_booking_transition() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.voucher_redemption_id is not null then
    if new.status in ('confirmed','completed') then
      update public.voucher_redemptions set state='consumed',consumed_at=clock_timestamp() where id=new.voucher_redemption_id and state='reserved';
      if found then insert into public.voucher_audit(redemption_id,event) values(new.voucher_redemption_id,'consumed'); end if;
    elsif new.status in ('cancelled','forfeited') or new.payment_status in ('rejected','failed') then
      -- Never release a consumed voucher, including after cancellations.
      if not exists(select 1 from public.bookings b where b.voucher_redemption_id=new.voucher_redemption_id and b.status not in ('cancelled','forfeited') and b.payment_status not in ('rejected','failed')) then
        update public.voucher_redemptions set state='released',released_at=clock_timestamp() where id=new.voucher_redemption_id and state='reserved';
        if found then insert into public.voucher_audit(redemption_id,event) values(new.voucher_redemption_id,'released'); end if;
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger z99_voucher_booking_transition after update on public.bookings for each row execute function public.voucher_booking_transition();

create function public.voucher_booking_deleted() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if old.voucher_redemption_id is not null and not exists (
    select 1 from public.bookings where voucher_redemption_id=old.voucher_redemption_id
      and status not in ('cancelled','forfeited')
  ) then
    update public.voucher_redemptions set state='released',released_at=now()
      where id=old.voucher_redemption_id and state='reserved';
    if found then insert into public.voucher_audit(redemption_id,event) values(old.voucher_redemption_id,'hold_deleted'); end if;
  end if;
  return old;
end $$;
create trigger z99_voucher_booking_deleted after delete on public.bookings for each row execute function public.voucher_booking_deleted();

-- Extend fee earning only for voucher bookings. Existing cash/historical rules
-- are unchanged. The existing unclaimed/settled ledger uses this timestamp.
do $$ declare d text; begin
  select pg_get_functiondef('public.mark_booking_fee_earned()'::regprocedure) into d;
  if position('and new.payment_status in (''paid'', ''downpayment_paid'')' in d)=0 then raise exception 'Unexpected fee earning function'; end if;
  d:=replace(d,'and new.payment_status in (''paid'', ''downpayment_paid'')',
    'and (new.payment_status in (''paid'', ''downpayment_paid'') or new.voucher_redemption_id is not null)');
  execute d;
end $$;

do $$ declare d text; begin
  select pg_get_functiondef('public.confirm_booking_transaction(text)'::regprocedure) into d;
  d:=replace(d,'or b.total <= 0','or (b.total <= 0 and not (b.total=0 and b.voucher_redemption_id is not null))');
  d:=replace(d,'or (b.downpayment is not null and b.downpayment <= 0)','or (b.downpayment is not null and b.downpayment <= 0 and not (b.total=0 and b.voucher_redemption_id is not null))');
  d:=replace(d,'and b.downpayment < b.total - 0.01','and (b.downpayment < b.total - 0.01 or (b.total=0 and b.voucher_redemption_id is not null))');
  execute d;
end $$;

-- A separate limiter transaction survives invalid-code RPC rollbacks.
create function public.voucher_attempt(p_key text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  if auth.role()<>'service_role' then raise exception 'Service only'; end if;
  insert into public.voucher_attempt_limits(key,bucket,attempts) values(p_key,now(),1)
  on conflict(key) do update set attempts=case when voucher_attempt_limits.bucket<now()-interval '10 minutes' then 1 else voucher_attempt_limits.attempts+1 end,
    bucket=case when voucher_attempt_limits.bucket<now()-interval '10 minutes' then now() else voucher_attempt_limits.bucket end
  returning attempts into n;
  return n<=30;
end $$;

create function public.voucher_checkout(p_action text,p_ref text,p_code text default null,p_token_hash text default null,p_actor uuid default null,p_contact jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.bookings%rowtype; item public.bookings%rowtype;
  c public.voucher_campaigns%rowtype; cd public.voucher_codes%rowtype; r public.voucher_redemptions%rowtype;
  refs text[]; k text; em text; ph text; nm text; gross numeric; saving numeric; part numeric; allocated numeric:=0; due numeric;
  rid uuid; result jsonb; enabled boolean; count_used integer; i integer:=0; rules jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'Service only'; end if;
  if p_action not in ('preview','apply','remove','status','confirm') then raise exception 'Invalid voucher action'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('paddle-rage-pickleball-booking-fee-remittance',0));
  perform pg_advisory_xact_lock(hashtextextended('paddle-rage-vouchers',0));
  select * into b from public.bookings where ref=p_ref;
  if not found then raise exception 'Booking not found'; end if;
  k:=coalesce(b.booking_group_ref,b.ref);
  perform pg_advisory_xact_lock(hashtextextended('paddle-rage-public-booking-group:'||k,0));
  perform 1 from public.bookings where coalesce(booking_group_ref,ref)=k order by ref for update;
  select * into b from public.bookings where ref=p_ref;
  select array_agg(ref order by ref) into refs from public.bookings where coalesce(booking_group_ref,ref)=k;
  if exists(select 1 from public.bookings x where x.ref=any(refs) and not coalesce((
    (x.host_booking and p_actor is not null and x.host_user_id=p_actor and exists(select 1 from public.accounts a where a.id=p_actor and a.role='host' and a.status='active')) or
    (not coalesce(x.host_booking,false) and x.customer_access_token_hash is not null and x.customer_access_token_hash=p_token_hash)
  ),false)) then raise exception 'Booking access denied'; end if;
  select * into r from public.voucher_redemptions where booking_key=k and state<>'released';
  if p_action in ('apply','preview') and (r.id is null or r.code<>upper(trim(p_code))) then
    select value='1' into enabled from public.settings where key='vouchers_enabled';
    if not coalesce(enabled,false) then raise exception 'Vouchers are not available yet'; end if;
  end if;
  if p_action='status' or (p_action='confirm' and r.state='consumed' and b.payment_status='complimentary' and b.status in ('confirmed','completed')) then
    null;
  else
    if exists(select 1 from public.bookings x where x.ref=any(refs) and (
      x.status not in ('verifying','pending') or x.created_at<now()-interval '15 minutes' or
      x.receipt_image_url is not null or x.receipt_image_hash is not null or x.receipt_status in ('manual_review','auto_approved') or
      nullif(trim(x.gcash_ref),'') is not null or x.payment_session_id is not null or x.paid_at is not null or
      x.payment_status in ('paid','downpayment_paid','complimentary','deposit_retained')
    )) then raise exception 'Voucher changes are locked after payment submission or hold expiry'; end if;
    if p_action='remove' then
      perform set_config('paddle_rage.voucher_write','on',true);
      update public.bookings set total=coalesce(voucher_original_total,total),voucher_discount=0,voucher_code=null,voucher_redemption_id=null,
        downpayment=case when host_booking then null else coalesce(voucher_original_total,total) end where ref=any(refs);
      update public.voucher_redemptions set state='released',released_at=now() where id=r.id and state='reserved';
      insert into public.voucher_audit(redemption_id,actor_id,event) values(r.id,p_actor,'removed');
    elsif p_action='confirm' then
      if r.id is null or r.state<>'reserved' or exists(select 1 from public.bookings where ref=any(refs) and (total<>0 or voucher_redemption_id<>r.id)) then raise exception 'Only a fully discounted voucher booking can be confirmed here'; end if;
      perform set_config('paddle_rage.voucher_write','on',true);
      update public.bookings set full_name=r.full_name,email=r.email,contact_number=r.phone,status='confirmed',payment_status='complimentary',payment_method='voucher',payment_flow='voucher',received_account=null,downpayment=0,paid_at=null where ref=any(refs);
    else
      em:=lower(trim(coalesce(p_contact->>'email',''))); ph:=public.voucher_normalize_phone(p_contact->>'phone'); nm:=trim(coalesce(p_contact->>'name',''));
      if em !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or em='reserve@hold.internal' or ph !~ '^09[0-9]{9}$' or length(nm)<3 or length(nm)>150 then raise exception 'Enter your name, valid email and phone before applying a voucher'; end if;
      if r.id is not null then
        if r.code<>upper(trim(p_code)) or r.email<>em or r.phone<>ph then raise exception 'Remove the existing voucher before changing code or contact details'; end if;
      else
        select * into cd from public.voucher_codes where code=upper(trim(p_code));
        select * into c from public.voucher_campaigns where id=cd.campaign_id;
        if c.id is null or c.state<>'active' or now()<c.starts_at or now()>=c.ends_at then raise exception 'Voucher is invalid or unavailable'; end if;
        -- The existing evidence-aware hold cleanup releases reservations through
        -- the delete trigger. Do not race receipt submission with a second,
        -- unlocked expiry mechanism here.
        select count(*) into count_used from public.voucher_redemptions where campaign_id=c.id and state<>'released';
        if count_used>=c.max_uses or (select count(*) from public.voucher_redemptions where code=cd.code and state<>'released')>=cd.max_uses then raise exception 'Voucher redemption limit reached'; end if;
        if c.customer_limit is not null and (select count(*) from public.voucher_redemptions where campaign_id=c.id and state<>'released' and (email=em or phone=ph or (p_actor is not null and host_user_id=p_actor)))>=c.customer_limit then raise exception 'Voucher customer limit reached'; end if;
        rules:=to_jsonb(c);
        if exists(select 1 from public.bookings x where x.ref=any(refs) and not public.voucher_play_allowed(rules,x.court_id,x.date,x.slots,coalesce(x.host_booking,false))) then raise exception 'Voucher does not apply to all selected courts and times'; end if;
        select round(sum(coalesce(voucher_original_total,total)),2) into gross from public.bookings where ref=any(refs);
        if gross<=0 or gross<c.min_spend then raise exception 'Voucher minimum spend not reached'; end if;
        saving:=least(gross,round(case when c.kind='fixed' then c.value else gross*c.value/100 end,2));
        if c.max_discount is not null then saving:=least(saving,c.max_discount); end if;
        if p_action='preview' then return jsonb_build_object('originalTotal',gross,'discount',saving,'total',gross-saving,'code',cd.code,'preview',true); end if;
        insert into public.voucher_redemptions(campaign_id,code,booking_key,booking_refs,full_name,email,phone,host_user_id,original_total,discount,rules)
        values(c.id,cd.code,k,refs,nm,em,ph,b.host_user_id,gross,saving,rules) returning id into rid;
        perform set_config('paddle_rage.voucher_write','on',true);
        -- Largest-remainder allocation, with booking ref as deterministic tie-break.
        for item in select * from public.bookings where ref=any(refs) order by ref loop
          part:=floor(saving*100*coalesce(item.voucher_original_total,item.total)/gross)/100;
          update public.bookings set voucher_original_total=coalesce(voucher_original_total,total),voucher_discount=part,voucher_redemption_id=rid,voucher_code=cd.code,
            total=coalesce(voucher_original_total,total)-part,
            downpayment=case when host_booking then null else coalesce(voucher_original_total,total)-part end where ref=item.ref;
          allocated:=allocated+part;
        end loop;
        for item in select * from public.bookings where ref=any(refs) order by (saving*100*voucher_original_total/gross-floor(saving*100*voucher_original_total/gross)) desc,ref loop
          exit when allocated>=saving;
          update public.bookings set voucher_discount=voucher_discount+0.01,total=total-0.01,downpayment=case when host_booking then null else total-0.01 end where ref=item.ref;
          allocated:=allocated+0.01;
        end loop;
        insert into public.voucher_audit(campaign_id,redemption_id,actor_id,event) values(c.id,rid,p_actor,'reserved');
      end if;
    end if;
  end if;
  select jsonb_build_object('ref',p_ref,'code',max(voucher_code),'originalTotal',sum(coalesce(voucher_original_total,total)),'discount',sum(voucher_discount),'total',sum(total),
    'complimentary',bool_and(payment_status='complimentary'),'items',jsonb_agg(jsonb_build_object('ref',ref,'originalTotal',coalesce(voucher_original_total,total),'discount',voucher_discount,'total',total,'serviceFee',least(total,booking_fee_amount_snapshot),
      'due',case when host_booking and date>((now() at time zone 'Asia/Manila')::date+5) then round(greatest(total-booking_fee_amount_snapshot,0)*0.25+least(total,booking_fee_amount_snapshot),2) else total end) order by ref))
    into result from public.bookings where ref=any(refs);
  return result;
end $$;

create function public.voucher_admin(p_actor uuid,p_action text,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare ar text; c public.voucher_campaigns%rowtype; cid uuid; courts text[]; codes jsonb:='[]'; code text; n integer; j integer; result jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'Service only'; end if;
  select role into ar from public.accounts where id=p_actor and status='active';
  if ar is null or ar not in ('owner','court_owner') then raise exception 'Owner access required'; end if;
  if p_action='assign' then
    if ar<>'owner' then raise exception 'Only the system owner can assign funding authority'; end if;
    if not exists(select 1 from public.accounts where id=(p_data->>'userId')::uuid and role='court_owner' and status='active') then raise exception 'Choose an active court owner'; end if;
    delete from public.voucher_court_managers where user_id=(p_data->>'userId')::uuid;
    insert into public.voucher_court_managers select (p_data->>'userId')::uuid,jsonb_array_elements_text(p_data->'courtIds');
    insert into public.voucher_audit(actor_id,event,details) values(p_actor,'funding_authority',p_data);
    return jsonb_build_object('ok',true);
  elsif p_action='create' then
    if coalesce((p_data->>'acceptOwnerFees')::boolean,false)<>true then raise exception 'Acknowledge owner-funded booking fees'; end if;
    courts:=array(select jsonb_array_elements_text(p_data->'courtIds'));
    if cardinality(courts)=0 or exists(select 1 from unnest(courts) x where not exists(select 1 from public.courts where id=x)) then raise exception 'Select valid courts'; end if;
    if ar='court_owner' and exists(select 1 from unnest(courts) x where not exists(select 1 from public.voucher_court_managers where user_id=p_actor and court_id=x)) then raise exception 'You can fund vouchers only for assigned courts'; end if;
    insert into public.voucher_campaigns(name,created_by,kind,value,max_discount,min_spend,starts_at,ends_at,max_uses,customer_limit,court_ids,booking_types,play_from,play_to,weekdays,hour_from,hour_to)
    values(trim(p_data->>'name'),p_actor,p_data->>'kind',(p_data->>'value')::numeric,nullif(p_data->>'maxDiscount','')::numeric,coalesce(nullif(p_data->>'minSpend','')::numeric,0),
      (p_data->>'startsAt')::timestamptz,(p_data->>'endsAt')::timestamptz,(p_data->>'maxUses')::integer,nullif(p_data->>'customerLimit','')::integer,courts,
      array(select jsonb_array_elements_text(p_data->'bookingTypes')),nullif(p_data->>'playFrom','')::date,nullif(p_data->>'playTo','')::date,
      array(select jsonb_array_elements_text(p_data->'weekdays'))::integer[],coalesce((p_data->>'hourFrom')::integer,0),coalesce((p_data->>'hourTo')::integer,24)) returning id into cid;
    n:=coalesce((p_data->>'batchSize')::integer,1);
    if n<1 or n>500 then raise exception 'Generate between 1 and 500 codes'; end if;
    for j in 1..n loop
      code:=case when n=1 and nullif(trim(p_data->>'code'),'') is not null then upper(trim(p_data->>'code')) else 'PR-'||upper(encode(extensions.gen_random_bytes(8),'hex')) end;
      insert into public.voucher_codes(code,campaign_id,max_uses) values(code,cid,case when n>1 or coalesce((p_data->>'singleUse')::boolean,false) then 1 else (p_data->>'maxUses')::integer end);
      codes:=codes||jsonb_build_array(code);
    end loop;
    insert into public.voucher_audit(campaign_id,actor_id,event,details) values(cid,p_actor,'created',jsonb_build_object('ownerFundsBookingFee',true));
    return jsonb_build_object('id',cid,'codes',codes);
  elsif p_action='state' then
    select * into c from public.voucher_campaigns where id=(p_data->>'id')::uuid;
    if c.id is null or (ar<>'owner' and (c.created_by<>p_actor or exists(select 1 from unnest(c.court_ids) x where not exists(select 1 from public.voucher_court_managers where user_id=p_actor and court_id=x)))) then raise exception 'Campaign access denied'; end if;
    update public.voucher_campaigns set state=p_data->>'state' where id=c.id;
    insert into public.voucher_audit(campaign_id,actor_id,event,details) values(c.id,p_actor,'state_changed',p_data);
    return jsonb_build_object('ok',true);
  elsif p_action<>'list' then raise exception 'Invalid management action'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]') into result from (
    select c.*,
      (select coalesce(jsonb_agg(code order by code),'[]') from public.voucher_codes where campaign_id=c.id) codes,
      (select count(*) from public.voucher_redemptions where campaign_id=c.id and state='consumed') used,
      (select count(*) from public.voucher_redemptions where campaign_id=c.id and state='reserved') reserved,
      (select coalesce(sum(discount),0) from public.voucher_redemptions where campaign_id=c.id and state='consumed') discounts,
      (select coalesce(jsonb_agg(jsonb_build_object('booking',booking_key,'state',state,'discount',discount,'createdAt',created_at) order by created_at desc),'[]') from public.voucher_redemptions where campaign_id=c.id) redemptions
    from public.voucher_campaigns c where ar='owner' or (c.created_by=p_actor and not exists(select 1 from unnest(c.court_ids) x where not exists(select 1 from public.voucher_court_managers where user_id=p_actor and court_id=x)))
  ) q;
  return jsonb_build_object('campaigns',result,'courts',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name)),'[]') from public.courts where ar='owner' or id in(select court_id from public.voucher_court_managers where user_id=p_actor)),
    'owners',case when ar='owner' then (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',full_name)),'[]') from public.accounts where role='court_owner' and status='active') else '[]'::jsonb end,
    'assignments',case when ar='owner' then (select coalesce(jsonb_agg(to_jsonb(m)),'[]') from public.voucher_court_managers m) else '[]'::jsonb end);
end $$;

revoke all on function public.voucher_checkout(text,text,text,text,uuid,jsonb),public.voucher_admin(uuid,text,jsonb),public.voucher_attempt(text) from public,anon,authenticated;
grant execute on function public.voucher_checkout(text,text,text,text,uuid,jsonb),public.voucher_admin(uuid,text,jsonb),public.voucher_attempt(text) to service_role;
revoke all on function public.guard_voucher_booking(),public.voucher_booking_transition(),public.voucher_booking_deleted() from public,anon,authenticated;

commit;
