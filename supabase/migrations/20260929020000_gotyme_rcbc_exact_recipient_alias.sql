-- Exact alias approved by the merchant for GoTyme -> RCBC only.
begin;
do $$ declare account_number text; begin
  select value into account_number from public.settings where key='rcbc_merchant_number';
  if account_number is null or account_number !~ '^[0-9]{6}1901$' then
    raise exception 'Expected RCBC account ending 1901 before adding GoTyme name alias';
  end if;
  insert into public.settings(key,value) values('rcbc_gotyme_recipient_name_aliases',
    jsonb_build_object('account',account_number,'names',jsonb_build_array('Jan Magallano'))::text)
    on conflict(key) do nothing;
end $$;
CREATE OR REPLACE FUNCTION public.assert_rcbc_auto_receipt(p_evidence jsonb, p_booking_ref text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare layout text:=p_evidence#>>'{rcbc,layout}'; item text; expected_key text; configured_name text; configured_number text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Only the receipt service may validate RCBC evidence' using errcode='42501'; end if;
  if not exists(select 1 from public.settings where key='rcbc_auto_verify_enabled' and value='1') then
    raise exception 'RCBC automatic verification is disabled' using errcode='23514';
  end if;
  select value into configured_name from public.settings where key='rcbc_merchant_name';
  select value into configured_number from public.settings where key='rcbc_merchant_number';
  if layout is null or layout not in ('gcash_bank','bpi_bank','maribank_bank','instapay_details','gotyme_bank','bdo_bank')
     or jsonb_typeof(p_evidence#>'{rcbc,references}') is distinct from 'array'
     or coalesce(p_evidence#>>'{bankTransfer,indicators,transferSuccess}','')<>'true'
     or (coalesce(p_evidence#>>'{bankTransfer,recipientComparison,name}','')<>'exact' and not (layout='gotyme_bank' and p_evidence#>>'{bankTransfer,recipientComparison,name}'='masked_compatible'))
     or coalesce(p_evidence#>>'{bankTransfer,recipientComparison,account}','') not in ('exact','suffix_exact')
     or coalesce(p_evidence->>'expectedReceiverNumber','') is distinct from configured_number
     or coalesce(p_evidence->>'expectedReceiverName','') is distinct from configured_name
     or (layout<>'bdo_bank' and coalesce(p_evidence#>>'{rcbc,destinationBank}','') !~* (case when layout='gotyme_bank' then '^Rizal Commercial Banking Corp[.]?[[:space:]]*[(]RCBC[)]$' else '^RCBC[[:space:]]*/[[:space:]]*DiskarTech$' end)) then
    raise exception 'RCBC recipient and receipt evidence is incomplete' using errcode='22023';
  end if;
  if jsonb_array_length(p_evidence#>'{rcbc,references}')=0
     or not ((p_evidence#>'{rcbc,references}') ? (p_evidence->>'ref'))
     or not ((p_evidence#>'{rcbc,references}') ? (p_evidence#>>'{rcbc,canonicalReference}')) then
    raise exception 'RCBC reference aliases are incomplete' using errcode='22023';
  end if;
  if layout='gotyme_bank' and (coalesce(p_evidence#>>'{rcbc,sourceParserVersion}','')<>'gotyme_to_rcbc_v1' or coalesce(p_evidence#>>'{rcbc,traceReference}','') !~ '^[0-9]{6}$') then
      raise exception 'GoTyme RCBC source evidence is incomplete' using errcode='22023';
    end if;
  -- Exact shortened names are accepted only from the account-bound GoTyme
  -- allowlist. Masked canonical names retain the existing verifier policy.
  if layout='gotyme_bank' and p_evidence#>>'{bankTransfer,recipientComparison,name}'='exact'
     and upper(regexp_replace(trim(coalesce(p_evidence#>>'{bankTransfer,recipient,nameRaw}','')),'[.[:space:]]','','g'))
       <>upper(regexp_replace(trim(coalesce(configured_name,'')),'[.[:space:]]','','g'))
     and not exists (
       select 1 from public.settings s,
         lateral jsonb_array_elements_text(s.value::jsonb->'names') alias_name
       where s.key='rcbc_gotyme_recipient_name_aliases'
         and s.value::jsonb->>'account'=configured_number
         and upper(regexp_replace(trim(alias_name),'[.[:space:]]','','g'))
           =upper(regexp_replace(trim(coalesce(p_evidence#>>'{bankTransfer,recipient,nameRaw}','')),'[.[:space:]]','','g'))
     ) then
    raise exception 'GoTyme RCBC recipient name is not approved for this account' using errcode='22023';
  end if;
  if layout='bdo_bank' then
    if coalesce(p_evidence#>>'{rcbc,sourceParserVersion}','')<>'bdo_to_rcbc_v1'
       or coalesce(configured_number,'') !~ '^[0-9]{6}1901$'
       or coalesce(p_evidence#>>'{bankTransfer,recipient,accountRaw}','')<>'...1901'
       or upper(regexp_replace(coalesce(p_evidence#>>'{bankTransfer,recipient,nameRaw}',''),'[^a-zA-Z0-9]','','g'))<>upper(regexp_replace(configured_name,'[^a-zA-Z0-9]','','g'))
       or coalesce(p_evidence->>'date','')<>to_char(clock_timestamp() at time zone 'Asia/Manila','YYYY-MM-DD')
       or coalesce(p_evidence->>'receiptAgeMinutes','') !~ '^[0-9]+([.][0-9]+)?$'
       or (p_evidence->>'receiptAgeMinutes')::numeric > 15
       or coalesce(p_evidence#>>'{rcbc,invoiceReference}','') !~ '^[0-9]{6,12}$'
       or not exists(select 1 from jsonb_array_elements(p_evidence->'dedupeKeys') k where k->>'key'='bdopay_invoice:'||(p_evidence#>>'{rcbc,invoiceReference}'))
       or not exists(select 1 from jsonb_array_elements(p_evidence->'dedupeKeys') k where k->>'key'='bdopay:'||(p_evidence#>>'{rcbc,canonicalReference}')) then
      raise exception 'BDO RCBC approval requirements are incomplete' using errcode='22023';
    end if;
  end if;
  for item in select jsonb_array_elements_text(p_evidence#>'{rcbc,references}') loop
    if item !~ (case when layout='bdo_bank' then '^BN[0-9]{16}$' when layout='gotyme_bank' then '^ITO[0-9]{15}$' else '^[0-9]{6,20}$' end) then raise exception 'Invalid RCBC reference evidence' using errcode='22023'; end if;
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
end $function$
;
commit;
