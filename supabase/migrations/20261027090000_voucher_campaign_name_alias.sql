begin;

-- Owners naturally share the campaign title shown on the voucher card. Accept
-- that title only when it identifies exactly one generated code. This keeps a
-- real code authoritative and refuses ambiguous campaign names.
do $$
declare
  definition text;
  needle text;
  replacement text;
begin
  select pg_get_functiondef('public.voucher_checkout(text,text,text,text,uuid,jsonb)'::regprocedure)
    into definition;
  needle := 'refs text[]; k text; em text; ph text; nm text; gross numeric; saving numeric; part numeric; allocated numeric:=0; due numeric;';
  replacement := needle || E'\n  alias_campaign_count integer:=0; alias_campaign_id uuid;';
  if position(needle in definition) = 0 then
    raise exception 'Unexpected voucher checkout declaration';
  end if;
  definition := replace(definition, needle, replacement);

  needle := E'select * into cd from public.voucher_codes where code=upper(trim(p_code));\n        select * into c from public.voucher_campaigns where id=cd.campaign_id;';
  replacement := $alias$
select * into cd from public.voucher_codes where code=upper(trim(p_code));
        if cd.code is null then
          select count(*), (array_agg(campaign.id order by campaign.id))[1] into alias_campaign_count, alias_campaign_id
          from public.voucher_campaigns campaign
          where upper(trim(campaign.name))=upper(trim(p_code))
            and (select count(*) from public.voucher_codes candidate where candidate.campaign_id=campaign.id)=1;
          if alias_campaign_count=1 then
            select * into cd from public.voucher_codes where campaign_id=alias_campaign_id;
          end if;
        end if;
        select * into c from public.voucher_campaigns where id=cd.campaign_id;$alias$;
  if position(needle in definition) = 0 then
    raise exception 'Unexpected voucher checkout code lookup';
  end if;
  execute replace(definition, needle, replacement);
end $$;

commit;
