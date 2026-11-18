-- Private details for court blocks (Admin -> Maintenance).
--
-- The block schedule itself stays in settings.maintenance_config because the
-- public booking site must read it to hide blocked slots. Who a block is for,
-- whether it has been paid and the owner's notes are private, so they live in
-- this table, readable and writable only by owner / court_owner accounts.
begin;

create table if not exists public.court_block_details (
  rule_id         text primary key,
  for_name        text not null default '',
  payment_status  text not null default 'not_paid',
  notes           text not null default '',
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid default auth.uid(),
  constraint court_block_details_rule_id_check
    check (char_length(rule_id) between 1 and 80),
  constraint court_block_details_for_name_check
    check (char_length(for_name) <= 160),
  constraint court_block_details_notes_check
    check (char_length(notes) <= 4000),
  constraint court_block_details_payment_check
    check (payment_status in ('not_paid', 'paid', 'not_needed'))
);

comment on table public.court_block_details is
  'Private owner notes for court blocks: who the block is for, payment status and remarks. Keyed by the maintenance_config rule id.';

create or replace function public.touch_court_block_details()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_touch_court_block_details on public.court_block_details;
create trigger trg_touch_court_block_details
  before insert or update on public.court_block_details
  for each row execute function public.touch_court_block_details();

alter table public.court_block_details enable row level security;

revoke all on public.court_block_details from public, anon;
grant select, insert, update, delete on public.court_block_details to authenticated;

drop policy if exists court_block_details_select_operators on public.court_block_details;
create policy court_block_details_select_operators
  on public.court_block_details for select to authenticated
  using (public.has_account_role(array['owner','court_owner']));

drop policy if exists court_block_details_insert_operators on public.court_block_details;
create policy court_block_details_insert_operators
  on public.court_block_details for insert to authenticated
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists court_block_details_update_operators on public.court_block_details;
create policy court_block_details_update_operators
  on public.court_block_details for update to authenticated
  using (public.has_account_role(array['owner','court_owner']))
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists court_block_details_delete_operators on public.court_block_details;
create policy court_block_details_delete_operators
  on public.court_block_details for delete to authenticated
  using (public.has_account_role(array['owner','court_owner']));

notify pgrst, 'reload schema';

commit;
