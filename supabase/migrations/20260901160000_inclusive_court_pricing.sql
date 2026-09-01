-- Treat every configured court/tier rate as the complete player-facing price.
-- The private booking-fee allocation is taken from inside that amount. Existing
-- booking rows are deliberately untouched so historical receipts keep the total
-- that was presented when they were submitted.

begin;

-- The public and authenticated-host insert canonicalizers already calculate:
--   stored total = calculate_booking_court_total(...) + service fee
-- Keep those hardened paths in place and change the court component to the net
-- court share. This produces the configured/displayed gross price exactly once.
do $migration$
declare
  function_definition text;
  old_return_pattern constant text :=
    $regex$return[[:space:]]+round\([[:space:]]*court_total[[:space:]]*,[[:space:]]*2[[:space:]]*\)[[:space:]]*;$regex$;
  new_return_pattern constant text :=
    $regex$return[[:space:]]+round\([[:space:]]*court_total[[:space:]]*-[[:space:]]*public\.calculate_booking_service_fee\(booking_slots\)[[:space:]]*,[[:space:]]*2[[:space:]]*\)[[:space:]]*;$regex$;
  new_return constant text :=
    'return round(court_total - public.calculate_booking_service_fee(booking_slots), 2);';
begin
  select pg_get_functiondef(
           'public.calculate_booking_court_total(text,text[])'::regprocedure
         )
    into function_definition;

  if function_definition is null then
    raise exception
      'Inclusive pricing migration could not read calculate_booking_court_total.';
  end if;

  if function_definition ~* old_return_pattern then
    execute regexp_replace(function_definition, old_return_pattern, new_return, 'i');
  elsif function_definition !~* new_return_pattern then
    raise exception
      'Inclusive pricing migration found an unexpected calculate_booking_court_total definition.';
  end if;
end
$migration$;

comment on function public.calculate_booking_court_total(text, text[]) is
  'Returns the net court share so hardened booking insert triggers store the configured player-facing price after adding the embedded private fee allocation.';

-- Snapshot only the portion that can actually exist inside the authoritative
-- player total. The snapshot remains immutable after insert.
create or replace function public.snapshot_booking_fee_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  fee_text text;
  fee_type_text text;
  fee_rate numeric := 0;
  fee_type text := 'per_hour';
  fee_units numeric := 0;
  calculated_fee numeric := 0;
  authoritative_total numeric := 0;
begin
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
$$;

revoke all on function public.snapshot_booking_fee_on_insert()
  from public, anon, authenticated;

-- PostgreSQL fires same-event triggers alphabetically. Run this snapshot after
-- both a00_prepare_public_booking_insert and the authenticated host canonicalizer
-- so the cap always sees the server-authoritative total, then run the earned-at
-- marker after the snapshot exists.
drop trigger if exists trg_snapshot_booking_fee_on_insert on public.bookings;
drop trigger if exists trg_10_snapshot_booking_fee_on_insert on public.bookings;
drop trigger if exists z10_snapshot_booking_fee_on_insert on public.bookings;
create trigger z10_snapshot_booking_fee_on_insert
before insert on public.bookings
for each row execute function public.snapshot_booking_fee_on_insert();

drop trigger if exists trg_mark_booking_fee_earned on public.bookings;
drop trigger if exists trg_20_mark_booking_fee_earned on public.bookings;
drop trigger if exists z20_mark_booking_fee_earned on public.bookings;
create trigger z20_mark_booking_fee_earned
before insert or update on public.bookings
for each row execute function public.mark_booking_fee_earned();

-- Atomic confirmation must use the immutable insert snapshot. Fall back to
-- the current setting only for genuinely legacy rows without one.
do $migration$
declare
  function_definition text;
  old_expression constant text :=
    'public.calculate_booking_service_fee(b.slots)';
  new_expression constant text :=
    'coalesce(b.booking_fee_amount_snapshot, public.calculate_booking_service_fee(b.slots))';
begin
  select pg_get_functiondef(
           'public.confirm_booking_transaction(text)'::regprocedure
         )
    into function_definition;

  if function_definition is null
     or position(old_expression in function_definition) = 0 then
    raise exception
      'Inclusive pricing migration could not locate the atomic-confirmation fee expression.';
  end if;

  execute replace(function_definition, old_expression, new_expression);
end
$migration$;

commit;
