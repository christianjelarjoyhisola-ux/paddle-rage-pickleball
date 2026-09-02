-- Promote BPI-to-GCash receipts to the dedicated evidence pipeline.
--
-- The Edge Function still sends every uncertain or mismatched receipt to
-- manual review. These database changes only allow an unflagged BPI v1 parse
-- to use the existing atomic settlement functions.

begin;

insert into public.settings (key, value)
values ('bpi_receipt_recipient_name', 'PaddleRage')
on conflict (key) do nothing;

do $$
declare
  target record;
  definition text;
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
      'provider_value not in (''gcash'', ''gotyme'', ''maribank'')',
      'provider_value not in (''gcash'', ''bpi'', ''gotyme'', ''maribank'')'
    );
    definition := regexp_replace(
      definition,
      'when ''gcash'' then ''gcash''[[:space:]]+when ''gotyme'' then ''gotyme_to_gcash''',
      'when ''gcash'' then ''gcash''
    when ''bpi'' then ''bpi_to_gcash''
    when ''gotyme'' then ''gotyme_to_gcash''',
      'g'
    );
    definition := regexp_replace(
      definition,
      'when ''gcash'' then ''gcash_v1''[[:space:]]+when ''gotyme'' then ''gotyme_to_gcash_v1''',
      'when ''gcash'' then ''gcash_v1''
    when ''bpi'' then ''bpi_to_gcash_v1''
    when ''gotyme'' then ''gotyme_to_gcash_v1''',
      'g'
    );

    if position(
      'provider_value not in (''gcash'', ''bpi'', ''gotyme'', ''maribank'')'
      in definition
    ) = 0 then
      raise exception 'Could not extend % provider allowlist for BPI',
        target.proname;
    end if;
    if position('expected_parser_version text' in definition) > 0
       and position('when ''bpi'' then ''bpi_to_gcash_v1''' in definition) = 0
    then
      raise exception 'Could not extend % parser contract for BPI',
        target.proname;
    end if;
    if position('expected_route text' in definition) > 0
       and position('when ''bpi'' then ''bpi_to_gcash''' in definition) = 0
    then
      raise exception 'Could not extend % route contract for BPI',
        target.proname;
    end if;

    execute definition;
  end loop;
end;
$$;

comment on function public.finalize_digital_receipt_auto_approval(
  text, text[], text, uuid, text, text, text, text, text, text, text[],
  jsonb, numeric, timestamptz, text
) is
  'Atomically settles a clean dedicated GCash, BPI, GoTyme, or MariBank receipt and claims all provider/rail evidence keys.';

comment on function public.finalize_digital_receipt_review(
  text, text[], text, uuid, text, text, text, text, text, text[], jsonb,
  numeric, timestamptz, text
) is
  'Atomically queues flagged dedicated GCash, BPI, GoTyme, or MariBank evidence for owner review.';

commit;
