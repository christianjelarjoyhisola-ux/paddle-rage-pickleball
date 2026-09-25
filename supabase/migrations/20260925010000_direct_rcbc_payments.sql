-- Direct RCBC deposits use their own receiving account and remain owner reviewed.
begin;
do $$
declare target record; definition text; changed integer := 0;
begin
  for target in select p.oid, p.proname from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.proname = any(array[
      'transfer_cancelled_booking_payment', 'reject_booking_payment_transaction',
      'prevent_automatic_booking_rejection', 'prepare_public_booking_insert',
      'prepare_public_open_play_registration', 'prepare_public_host_session_registration',
      'public_payment_method_ready', 'update_public_booking_hold',
      'confirm_booking_transaction', 'create_host_booking_balance_payment',
      'guard_digital_payment_decision_role', 'normalize_payment_reference_key',
      'payment_review_ledger_keys', 'claim_owner_confirmed_receipt_evidence'
    ])
  loop
    definition := pg_get_functiondef(target.oid);
    if target.proname = 'public_payment_method_ready' then
      definition := replace(definition, 'method_value = ''pnb''', 'method_value in (''pnb'', ''rcbc'')');
      definition := replace(definition, '''pnb_merchant_name''', 'method_value || ''_merchant_name''');
      definition := replace(definition, '''pnb_merchant_number'', ''pnb_qr_image''',
        'method_value || ''_merchant_number'', method_value || ''_qr_image''');
    else
      definition := replace(definition, '''unionbank'', ''pnb''', '''unionbank'', ''pnb'', ''rcbc''');
    end if;
    if target.proname = 'prepare_public_booking_insert' then
      definition := replace(definition, 'when new.payment_method = ''cash'' then ''cash''',
        'when new.payment_method = ''cash'' then ''cash'' when new.payment_method = ''rcbc'' then ''rcbc''');
    elsif target.proname = 'update_public_booking_hold' then
      definition := replace(definition, 'case when lower(p_updates->>''payment_method'') = ''cash'' then ''cash'' else ''gcash'' end',
        'case when lower(p_updates->>''payment_method'') = ''cash'' then ''cash'' when lower(p_updates->>''payment_method'') = ''rcbc'' then ''rcbc'' else ''gcash'' end');
    end if;
    if position('''rcbc''' in definition)=0 then
      raise exception 'RCBC routing update failed for %', target.proname;
    end if;
    execute definition;
    changed := changed+1;
  end loop;
  if changed<>14 then raise exception 'Expected 14 RCBC routing contracts, found %',changed; end if;
end;
$$;
-- Deliberately do not extend automatic approval/evidence allowlists without a
-- validated RCBC receipt parser. Owner confirmation retains reference deduplication.
alter table public.open_play_host_session_registrations
  drop constraint open_play_host_session_registrations_payment_method_check;
alter table public.open_play_host_session_registrations
  add constraint open_play_host_session_registrations_payment_method_check
  check (payment_method in ('gcash','bdopay','maya','bpi','gotyme','maribank','unionbank','pnb','rcbc','cash'));
alter table public.host_booking_balance_payments
  drop constraint host_booking_balance_payments_provider_check;
alter table public.host_booking_balance_payments
  add constraint host_booking_balance_payments_provider_check
  check (payment_provider in ('gcash','bdopay','maya','bpi','gotyme','maribank','unionbank','pnb','rcbc'));
alter table public.booking_payment_transfers drop constraint booking_payment_transfers_method_check;
alter table public.booking_payment_transfers add constraint booking_payment_transfers_method_check
  check (payment_method in ('gcash','bdopay','maya','bpi','gotyme','maribank','unionbank','pnb','rcbc'));
insert into public.settings(key,value) values ('payment_method_rcbc','0') on conflict(key) do nothing;
commit;
