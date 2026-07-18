-- Authenticate the public-gateway balance processor without committing a
-- reusable secret. The secret is generated and retained inside Supabase Vault;
-- pg_cron reads it at execution time and the Edge Function asks this narrowly
-- granted RPC to verify the presented value.

begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (
    select 1
      from vault.secrets
     where name = 'paddle_rage_balance_cron_secret'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'paddle_rage_balance_cron_secret',
      'Authenticates the Paddle Rage host-balance pg_cron request.'
    );
  end if;
end;
$$;

create or replace function public.verify_balance_cron_secret(p_token text)
returns boolean
language sql
stable
security definer
set search_path = public, vault, pg_temp
as $$
  select length(coalesce(p_token, '')) between 32 and 256
    and exists (
      select 1
        from vault.decrypted_secrets
       where name = 'paddle_rage_balance_cron_secret'
         and decrypted_secret = p_token
    )
$$;

revoke all on function public.verify_balance_cron_secret(text)
  from public, anon, authenticated;
grant execute on function public.verify_balance_cron_secret(text)
  to service_role;

do $$
declare
  existing_job bigint;
begin
  select jobid
    into existing_job
    from cron.job
   where jobname = 'process-host-balance-deadlines'
   limit 1;

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;

  perform cron.schedule(
    'process-host-balance-deadlines',
    '*/15 * * * *',
    $job$
      select net.http_post(
        url := 'https://qhvrowoqeyeypmefwkha.supabase.co/functions/v1/process-host-balance-deadlines',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (
            select decrypted_secret
              from vault.decrypted_secrets
             where name = 'paddle_rage_balance_cron_secret'
             limit 1
          )
        ),
        body := '{"source":"database-cron"}'::jsonb
      );
    $job$
  );
end;
$$;

commit;
