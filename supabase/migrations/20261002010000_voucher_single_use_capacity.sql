begin;
-- Normalize single-use campaign capacity at the server even for older clients.
do $migration$
declare definition text; needle text := '    insert into public.voucher_campaigns(name,created_by,kind,value,max_discount,min_spend,starts_at,ends_at,max_uses,customer_limit,court_ids,booking_types,play_from,play_to,weekdays,hour_from,hour_to)';
begin
 select pg_get_functiondef('public.voucher_admin(uuid,text,jsonb)'::regprocedure) into definition;
 if position(needle in definition)=0 then raise exception 'Unexpected voucher administration definition'; end if;
 definition:=replace(definition,needle,$patch$
    n:=coalesce((p_data->>'batchSize')::integer,1);
    if n<1 or n>500 then raise exception 'Generate between 1 and 500 codes'; end if;
    if n>1 or coalesce((p_data->>'singleUse')::boolean,false) then
      p_data:=jsonb_set(p_data,'{maxUses}',to_jsonb(n));
    end if;
$patch$||needle);
 execute definition;
end $migration$;
-- A campaign cannot offer more redemptions than all its single-use codes.
-- Reusable campaigns are not changed because their intended limit is unknown.
with capacity as (
 select campaign_id,count(*)::integer total from public.voucher_codes
 group by campaign_id having bool_and(max_uses=1)
), repaired as (
 update public.voucher_campaigns c set max_uses=p.total from capacity p
 where c.id=p.campaign_id and c.max_uses>p.total
 returning c.id,c.max_uses
)
insert into public.voucher_audit(campaign_id,event,details)
 select id,'single_use_capacity_corrected',jsonb_build_object('maxUses',max_uses) from repaired;
commit;
