-- Only incoming GoTyme -> RCBC gains support for its masked name and ITO reference.
begin;
do $$ declare definition text; begin
  select pg_get_functiondef('public.assert_rcbc_auto_receipt(jsonb,text)'::regprocedure) into definition;
  definition:=replace(definition,'''maribank_bank'',''instapay_details'')','''maribank_bank'',''instapay_details'',''gotyme_bank'')');
  definition:=replace(definition,
    'coalesce(p_evidence#>>''{bankTransfer,recipientComparison,name}'','''')<>''exact''',
    '(coalesce(p_evidence#>>''{bankTransfer,recipientComparison,name}'','''')<>''exact'' and not (layout=''gotyme_bank'' and p_evidence#>>''{bankTransfer,recipientComparison,name}''=''masked_compatible''))');
  definition:=replace(definition,
    'coalesce(p_evidence#>>''{rcbc,destinationBank}'','''') !~* ''^RCBC[[:space:]]*/[[:space:]]*DiskarTech$''',
    'coalesce(p_evidence#>>''{rcbc,destinationBank}'','''') !~* (case when layout=''gotyme_bank'' then ''^Rizal Commercial Banking Corp[.]?[[:space:]]*[(]RCBC[)]$'' else ''^RCBC[[:space:]]*/[[:space:]]*DiskarTech$'' end)');
  definition:=replace(definition,'item !~ ''^[0-9]{6,20}$''','item !~ (case when layout=''gotyme_bank'' then ''^ITO[0-9]{15}$'' else ''^[0-9]{6,20}$'' end)');
  definition:=replace(definition,'  for item in select',
    '  if layout=''gotyme_bank'' and (coalesce(p_evidence#>>''{rcbc,sourceParserVersion}'','''')<>''gotyme_to_rcbc_v1'' or coalesce(p_evidence#>>''{rcbc,traceReference}'','''') !~ ''^[0-9]{6}$'') then
      raise exception ''GoTyme RCBC source evidence is incomplete'' using errcode=''22023'';
    end if;
  for item in select');
  if position('gotyme_to_rcbc_v1' in definition)=0 or position('masked_compatible' in definition)=0 or position('^ITO' in definition)=0 then
    raise exception 'GoTyme RCBC contract patch failed';
  end if;
  execute definition;
end $$;
commit;
