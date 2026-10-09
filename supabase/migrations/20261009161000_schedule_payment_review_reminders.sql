begin;
-- Runs independently of any open browser or Codex session. Existing Vault
-- authentication is checked inside the function; no public sending endpoint.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'paddle_rage_balance_cron_secret') then
    raise exception 'Balance cron authentication must be configured first';
  end if;
  perform cron.schedule(
    'payment-review-reminders', '*/5 * * * *',
    $job$
      select net.http_post(
        url := 'https://qhvrowoqeyeypmefwkha.supabase.co/functions/v1/payment-review-reminders',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
            where name = 'paddle_rage_balance_cron_secret' limit 1)
        ),
        body := '{"source":"database-cron"}'::jsonb,
        timeout_milliseconds := 120000
      );
    $job$
  );
end $$;
commit;
