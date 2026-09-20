-- UnionBank is a source bank for the existing GCash QR, with its own evidence contract.
begin;
do $$
declare
  target record;
  definition text;
  changed integer := 0;
begin
  for target in select p.oid, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname = any(array[
      'transfer_cancelled_booking_payment', 'finalize_digital_receipt_review',
      'assert_clean_registration_receipt', 'reject_booking_payment_transaction',
      'prepare_public_booking_insert', 'prepare_public_open_play_registration',
      'prepare_public_host_session_registration', 'public_payment_method_ready',
      'update_public_booking_hold', 'confirm_booking_transaction',
      'create_host_booking_balance_payment', 'guard_digital_payment_decision_role',
      'finalize_digital_receipt_auto_approval', 'normalize_payment_reference_key',
      'payment_review_ledger_keys', 'prevent_automatic_booking_rejection',
      'claim_owner_confirmed_receipt_evidence'
    ])
  loop
    definition := pg_get_functiondef(target.oid);
    definition := replace(definition, '''gotyme'', ''maribank''', '''gotyme'', ''maribank'', ''unionbank''');
    definition := replace(definition, 'when ''maribank'' then ''maribank_to_gcash''',
      'when ''maribank'' then ''maribank_to_gcash'' when ''unionbank'' then ''unionbank_to_gcash''');
    definition := replace(definition, 'when ''maribank'' then ''maribank_to_gcash_v1''',
      'when ''maribank'' then ''maribank_to_gcash_v1'' when ''unionbank'' then ''unionbank_to_gcash_v1''');
    if target.proname = 'normalize_payment_reference_key' then
      definition := replace(definition, 'elsif provider_value = ''bpi''',
        'elsif provider_value = ''unionbank'' and normalized_value !~ ''^UB[0-9]{6,20}$'' then
          raise exception ''Enter the UnionBank UB reference, not the InstaPay trace.'' using errcode = ''22023'';
        elsif provider_value = ''bpi''');
    end if;
    if position('''unionbank''' in definition) = 0 then
      raise exception 'UnionBank allowlist update failed for %', target.proname;
    end if;
    if target.proname in ('finalize_digital_receipt_auto_approval', 'finalize_digital_receipt_review', 'assert_clean_registration_receipt')
       and position('unionbank_to_gcash_v1' in definition) = 0 then
      raise exception 'UnionBank evidence contract update failed for %', target.proname;
    end if;
    execute definition;
    changed := changed + 1;
  end loop;
  if changed <> 17 then raise exception 'Expected 17 UnionBank routing contracts, found %', changed; end if;
end;
$$;

alter table public.open_play_host_session_registrations
  drop constraint if exists open_play_host_session_registrations_payment_method_check;
alter table public.open_play_host_session_registrations
  add constraint open_play_host_session_registrations_payment_method_check
  check (payment_method in ('gcash','bdopay','maya','bpi','gotyme','maribank','unionbank','pnb','cash'));
alter table public.host_booking_balance_payments
  drop constraint if exists host_booking_balance_payments_provider_check;
alter table public.host_booking_balance_payments
  add constraint host_booking_balance_payments_provider_check
  check (payment_provider in ('gcash','bdopay','maya','bpi','gotyme','maribank','unionbank','pnb'));

insert into public.settings (key, value) values ('payment_method_unionbank','1')
on conflict (key) do nothing;
alter table public.booking_payment_transfers drop constraint if exists booking_payment_transfers_method_check;
alter table public.booking_payment_transfers add constraint booking_payment_transfers_method_check
  check (payment_method in ('gcash','bdopay','maya','bpi','gotyme','maribank','unionbank','pnb'));
commit;
