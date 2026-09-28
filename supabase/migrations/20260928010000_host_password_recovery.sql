-- Private, persistent throttle; callers cannot inspect account recovery activity.
create table if not exists public.host_password_recovery_limits (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  window_start timestamptz not null default now(),
  last_requested_at timestamptz not null default now(),
  attempts integer not null default 1
);
alter table public.host_password_recovery_limits enable row level security;
revoke all on public.host_password_recovery_limits from public, anon, authenticated;

create or replace function public.claim_host_password_recovery(p_account_id uuid)
returns boolean language plpgsql security definer
set search_path = public, pg_temp as $$
declare claimed uuid;
begin
  if not exists (select 1 from public.accounts where id = p_account_id
    and role = 'host' and coalesce(status, 'active') = 'active') then
    return false;
  end if;
  insert into public.host_password_recovery_limits as limits (account_id)
  values (p_account_id)
  on conflict (account_id) do update set
    window_start = case when limits.window_start <= now() - interval '24 hours' then now() else limits.window_start end,
    attempts = case when limits.window_start <= now() - interval '24 hours' then 1 else limits.attempts + 1 end,
    last_requested_at = now()
  where limits.last_requested_at <= now() - interval '5 minutes'
    and (limits.window_start <= now() - interval '24 hours' or limits.attempts < 5)
  returning account_id into claimed;
  return claimed is not null;
end;
$$;
revoke all on function public.claim_host_password_recovery(uuid) from public, anon, authenticated;
grant execute on function public.claim_host_password_recovery(uuid) to service_role;
