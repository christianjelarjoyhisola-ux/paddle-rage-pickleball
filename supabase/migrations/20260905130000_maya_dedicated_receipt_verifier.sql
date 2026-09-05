-- Enable only the dedicated Maya-to-GCash evidence contract.
-- Recipient identity remains deployment configuration, never receipt-derived.
begin;

do $$
declare
  target record;
  definition text;
  updated_count integer := 0;
begin
  for target in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'finalize_digital_receipt_auto_approval',
         'finalize_digital_receipt_review',
         'assert_clean_registration_receipt'
       )
  loop
    definition := pg_get_functiondef(target.oid);
    definition := replace(
      definition,
      'provider_value not in (''gcash'', ''bdopay'', ''bpi'', ''gotyme'', ''maribank'')',
      'provider_value not in (''gcash'', ''bdopay'', ''maya'', ''bpi'', ''gotyme'', ''maribank'')'
    );
    definition := regexp_replace(
      definition,
      'when ''bdopay'' then ''bdopay_to_gcash''[[:space:]]+when ''bpi'' then ''bpi_to_gcash''',
      'when ''bdopay'' then ''bdopay_to_gcash''
    when ''maya'' then ''maya_to_gcash''
    when ''bpi'' then ''bpi_to_gcash''',
      'g'
    );
    definition := regexp_replace(
      definition,
      'when ''bdopay'' then ''bdopay_to_gcash_v1''[[:space:]]+when ''bpi'' then ''bpi_to_gcash_v1''',
      'when ''bdopay'' then ''bdopay_to_gcash_v1''
    when ''maya'' then ''maya_to_gcash_v1''
    when ''bpi'' then ''bpi_to_gcash_v1''',
      'g'
    );

    if position(
      'provider_value not in (''gcash'', ''bdopay'', ''maya'', ''bpi'', ''gotyme'', ''maribank'')'
      in definition
    ) = 0 then
      raise exception 'Could not extend % provider allowlist for Maya', target.proname;
    end if;
    if position('expected_parser_version text' in definition) > 0
       and position('when ''maya'' then ''maya_to_gcash_v1''' in definition) = 0
    then
      raise exception 'Could not extend % parser contract for Maya', target.proname;
    end if;
    if position('expected_route text' in definition) > 0
       and position('when ''maya'' then ''maya_to_gcash''' in definition) = 0
    then
      raise exception 'Could not extend % route contract for Maya', target.proname;
    end if;

    execute definition;
    updated_count := updated_count + 1;
  end loop;
  if updated_count <> 3 then
    raise exception 'Expected 3 receipt contracts for Maya, found %', updated_count;
  end if;
end;
$$;

comment on function public.finalize_digital_receipt_auto_approval(
  text, text[], text, uuid, text, text, text, text, text, text, text[],
  jsonb, numeric, timestamptz, text
) is
  'Atomically settles clean dedicated GCash, BDO Pay, Maya, BPI, GoTyme, or MariBank receipt evidence and claims its replay keys.';

comment on function public.finalize_digital_receipt_review(
  text, text[], text, uuid, text, text, text, text, text, text[], jsonb,
  numeric, timestamptz, text
) is
  'Atomically queues flagged dedicated GCash, BDO Pay, Maya, BPI, GoTyme, or MariBank evidence for owner review.';

commit;
