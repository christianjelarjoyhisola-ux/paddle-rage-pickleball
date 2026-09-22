begin;

-- The existing checkout creates tokenless guest holds when an active dashboard
-- operator is signed in. Honor that established authorization path as well as
-- guest tokens and host ownership; never grant access from a missing token alone.
do $$ declare definition text; needle text; replacement text; begin
  select pg_get_functiondef('public.voucher_checkout(text,text,text,text,uuid,jsonb)'::regprocedure) into definition;
  needle := '(not coalesce(x.host_booking,false) and x.customer_access_token_hash is not null and x.customer_access_token_hash=p_token_hash)';
  replacement := needle || $branch$ or
    (not coalesce(x.host_booking,false) and x.host_user_id is null
      and x.customer_access_token_hash is null
      and x.created_via='customer' and x.created_by_user_id is null
      and p_actor is not null and exists (
        select 1 from public.accounts operator_account
        where operator_account.id=p_actor and operator_account.status='active'
          and operator_account.role in ('owner','court_owner','staff')
      ))$branch$;
  if position(needle in definition)=0 then raise exception 'Unexpected voucher access function'; end if;
  execute replace(definition,needle,replacement);
end $$;

commit;
