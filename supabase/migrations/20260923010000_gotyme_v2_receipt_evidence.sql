begin;
-- Allow the new dedicated parser while retaining in-flight v1 evidence.
do $$ declare item record; definition text; patched integer:=0; begin
  for item in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'
      and p.proname in ('finalize_digital_receipt_auto_approval','finalize_digital_receipt_review','assert_clean_registration_receipt')
  loop
    definition:=pg_get_functiondef(item.oid);
    if position('when ''gotyme'' then ''gotyme_to_gcash_v1''' in definition)>0 then
      execute replace(definition,'when ''gotyme'' then ''gotyme_to_gcash_v1''',
        'when ''gotyme'' then case when ' ||
        case when item.proname='assert_clean_registration_receipt' then 'audit_row.extracted' else 'p_receipt_extracted' end ||
        '->>''parserVersion''=''gotyme_to_gcash_v2'' then ''gotyme_to_gcash_v2'' else ''gotyme_to_gcash_v1'' end');
      patched:=patched+1;
    end if;
  end loop;
  if patched<>3 then raise exception 'Expected three GoTyme receipt gates, found %',patched; end if;
end $$;
commit;
