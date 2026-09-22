begin;

-- The list query uses alias c and the administration function also has a
-- campaign record named c. Resolve query columns explicitly without changing
-- the existing campaign authorization branches.
do $$ declare definition text; begin
  select pg_get_functiondef('public.voucher_admin(uuid,text,jsonb)'::regprocedure) into definition;
  definition := replace(definition, E'\ndeclare ar text;', E'\n#variable_conflict use_column\ndeclare ar text;');
  if position('#variable_conflict use_column' in definition)=0 then
    raise exception 'Unexpected voucher administration function';
  end if;
  execute definition;
end $$;

commit;
