begin;
select cron.schedule('review-notification-channels','* * * * *',
  $job$select net.http_post(
    url := 'https://qhvrowoqeyeypmefwkha.supabase.co/functions/v1/review-notifications',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='paddle_rage_balance_cron_secret' limit 1)),
    body := '{"source":"database-cron"}'::jsonb, timeout_milliseconds := 120000
  );$job$);
commit;
