-- Only the RCBC destination gains a dedicated verifier. Existing GCash contracts
-- retain their original parser versions, routes, account and evidence requirements.
begin;
insert into public.settings(key,value) values('rcbc_auto_verify_enabled','0') on conflict(key) do nothing;

create or replace function public.assert_rcbc_auto_receipt(p_evidence jsonb, p_booking_ref text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare layout text:=p_evidence#>>'{rcbc,layout}'; item text; expected_key text; configured_name text; configured_number text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Only the receipt service may validate RCBC evidence' using errcode='42501'; end if;
  if not exists(select 1 from public.settings where key='rcbc_auto_verify_enabled' and value='1') then
    raise exception 'RCBC automatic verification is disabled' using errcode='23514';
  end if;
  select value into configured_name from public.settings where key='rcbc_merchant_name';
  select value into configured_number from public.settings where key='rcbc_merchant_number';
  if layout is null or layout not in ('gcash_bank','bpi_bank','maribank_bank','instapay_details')
     or jsonb_typeof(p_evidence#>'{rcbc,references}') is distinct from 'array'
     or coalesce(p_evidence#>>'{bankTransfer,indicators,transferSuccess}','')<>'true'
     or coalesce(p_evidence#>>'{bankTransfer,recipientComparison,name}','')<>'exact'
     or coalesce(p_evidence#>>'{bankTransfer,recipientComparison,account}','') not in ('exact','suffix_exact')
     or coalesce(p_evidence->>'expectedReceiverNumber','') is distinct from configured_number
     or coalesce(p_evidence->>'expectedReceiverName','') is distinct from configured_name
     or coalesce(p_evidence#>>'{rcbc,destinationBank}','') !~* '^RCBC[[:space:]]*/[[:space:]]*DiskarTech$' then
    raise exception 'RCBC recipient and receipt evidence is incomplete' using errcode='22023';
  end if;
  if jsonb_array_length(p_evidence#>'{rcbc,references}')=0
     or not ((p_evidence#>'{rcbc,references}') ? (p_evidence->>'ref'))
     or not ((p_evidence#>'{rcbc,references}') ? (p_evidence#>>'{rcbc,canonicalReference}')) then
    raise exception 'RCBC reference aliases are incomplete' using errcode='22023';
  end if;
  for item in select jsonb_array_elements_text(p_evidence#>'{rcbc,references}') loop
    if item !~ '^[0-9]{6,20}$' then raise exception 'Invalid RCBC reference evidence' using errcode='22023'; end if;
    expected_key:=case when length(item)>=10 then 'rcbc:'||item else 'rcbc_'||layout||':'||(p_evidence->>'date')||':'||item end;
    if expected_key is null or not exists(select 1 from jsonb_array_elements(p_evidence->'dedupeKeys') k where k->>'key'=expected_key) then
      raise exception 'RCBC reference replay key is missing' using errcode='22023';
    end if;
    -- Respect receipts already claimed by the legacy owner-review-only release.
    if exists(select 1 from public.used_gcash_refs u where u.gcash_ref='rcbc:'||item
      and u.booking_ref is distinct from p_booking_ref
      and not exists(select 1 from public.bookings a join public.bookings b on a.booking_group_ref=b.booking_group_ref
        where a.ref=p_booking_ref and b.ref=u.booking_ref and a.booking_group_ref is not null)) then
      raise exception 'RCBC receipt was already used by another booking' using errcode='23505';
    end if;
  end loop;
end $$;
-- Shared workflow guard keeps its GCash branch intact and recognizes only the
-- dedicated RCBC route. Host balances also enforce the rollout/recipient gate.
do $$ declare definition text; begin
  select pg_get_functiondef('public.receipt_auto_approval_evidence_is_clean(text,text[],numeric,jsonb)'::regprocedure) into definition;
  definition:=replace(definition, ')) = ''gcash''', ')) = (case when p_extracted->>''provider''=''rcbc'' and p_extracted->>''route''=''rcbc'' and p_extracted->>''parserVersion''=''rcbc_incoming_v1'' then ''rcbc'' else ''gcash'' end)');
  if position('rcbc_incoming_v1' in definition)=0 then raise exception 'RCBC clean evidence guard patch failed'; end if;
  execute definition;
  select pg_get_functiondef('public.assert_host_booking_balance_receipt_audit(uuid,bigint)'::regprocedure) into definition;
  definition:=replace(definition, '  return v_audit;', '  if v_payment.payment_provider=''rcbc'' and v_audit.result=''auto_approved'' then perform public.assert_rcbc_auto_receipt(v_audit.extracted,v_audit.booking_ref); end if;'||chr(10)||'  return v_audit;');
  if position('assert_rcbc_auto_receipt' in definition)=0 then raise exception 'RCBC balance audit guard patch failed'; end if;
  execute definition;
end $$;
revoke all on function public.assert_rcbc_auto_receipt(jsonb,text) from public,anon,authenticated;
grant execute on function public.assert_rcbc_auto_receipt(jsonb,text) to service_role;

do $$
declare item record; definition text; evidence text; changed integer:=0;
begin
  for item in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.proname in
      ('finalize_digital_receipt_auto_approval','finalize_digital_receipt_review','assert_clean_registration_receipt')
  loop
    definition:=pg_get_functiondef(item.oid);
    evidence:=case when item.proname='assert_clean_registration_receipt' then 'audit_row.extracted' else 'p_receipt_extracted' end;
    definition:=replace(definition, '''maribank'', ''unionbank'')', '''maribank'', ''unionbank'', ''rcbc'')');
    definition:=replace(definition, 'when ''unionbank'' then ''unionbank_to_gcash_v1''', 'when ''unionbank'' then ''unionbank_to_gcash_v1'' when ''rcbc'' then ''rcbc_incoming_v1''');
    definition:=replace(definition, 'when ''unionbank'' then ''unionbank_to_gcash''', 'when ''unionbank'' then ''unionbank_to_gcash'' when ''rcbc'' then ''rcbc''');
    definition:=replace(definition, ')) <> ''gcash''', ')) <> (case when provider_value=''rcbc'' then ''rcbc'' else ''gcash'' end)');
    if item.proname<>'finalize_digital_receipt_review' then
      definition:=replace(definition, '  paid_amount :=', '  if provider_value=''rcbc'' then perform public.assert_rcbc_auto_receipt(p_receipt_extracted,p_booking_ref); end if;'||chr(10)||'  paid_amount :=');
      if item.proname='assert_clean_registration_receipt' then
        definition:=replace(definition, '  normalized_reference :=', '  if provider_value=''rcbc'' then perform public.assert_rcbc_auto_receipt(audit_row.extracted,audit_row.booking_ref); end if;'||chr(10)||'  normalized_reference :=');
      end if;
    end if;
    if position('rcbc_incoming_v1' in definition)=0 or position('then ''rcbc'' else ''gcash'' end' in definition)=0 then
      raise exception 'RCBC contract update failed for %',item.proname;
    end if;
    execute definition; changed:=changed+1;
  end loop;
  if changed<>3 then raise exception 'Expected three receipt gates, found %',changed; end if;
end $$;
-- Short incoming RCBC references are date/layout scoped; full references retain
-- the existing primary key contract. No other provider changes its replay keys.
do $$ declare definition text; begin
  select pg_get_functiondef('public.claim_verified_receipt_evidence_keys(jsonb,text,text,text,text,text)'::regprocedure) into definition;
  definition:=replace(definition,'  for evidence_key in',
    '  if provider_value=''rcbc'' and length(regexp_replace(coalesce(p_fallback_reference,''''),''[^0-9]'','''',''g''))<10 then
      primary_key:=''rcbc_''||(p_extracted#>>''{rcbc,layout}'')||'':''||(p_extracted->>''date'')||'':''||regexp_replace(p_fallback_reference,''[^0-9]'','''',''g'');
    end if;
  for evidence_key in');
  if position('rcbc_' in definition)=0 then raise exception 'RCBC replay contract patch failed'; end if;
  execute definition;
end $$;
commit;
