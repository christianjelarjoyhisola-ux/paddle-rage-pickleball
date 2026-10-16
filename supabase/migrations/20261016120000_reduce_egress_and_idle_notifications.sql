begin;

-- Keep table RLS in force. Lists need receipt badges, not the complete OCR
-- evidence for every historical payment. Detail reads still use bookings.
do $$
declare columns text;
begin
  select string_agg(format('b.%I', attname), ', ' order by attnum)
    into columns from pg_attribute
    where attrelid='public.bookings'::regclass and attnum>0 and not attisdropped
      and attname not in ('receipt_extracted','customer_access_token_hash');
  execute 'create or replace view public.booking_list_rows with (security_invoker=true) as select '
    || columns || ', case when b.receipt_extracted is null then null else jsonb_build_object('
    || '''parserVersion'',b.receipt_extracted->''parserVersion'','
    || '''ref'',b.receipt_extracted->''ref'','
    || '''receiptAgeMinutes'',b.receipt_extracted->''receiptAgeMinutes'','
    || '''allowedPaymentEarlyToleranceMinutes'',b.receipt_extracted->''allowedPaymentEarlyToleranceMinutes'','
    || '''allowedPaymentWindowMinutes'',b.receipt_extracted->''allowedPaymentWindowMinutes'') end as receipt_extracted '
    || 'from public.bookings b';
end $$;
revoke all on public.booking_list_rows from public,anon,authenticated;
grant select on public.booking_list_rows to authenticated,service_role;

-- Preserve the one-minute check and hourly delivery leases. Only start an Edge
-- Function (and its auth/API/log traffic) when the existing due query has work.
select cron.schedule('review-notification-channels','* * * * *',
  $job$select net.http_post(
    url := 'https://qhvrowoqeyeypmefwkha.supabase.co/functions/v1/review-notifications',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='paddle_rage_balance_cron_secret' limit 1)),
    body := '{"source":"database-cron"}'::jsonb, timeout_milliseconds := 120000
  ) where exists (select 1 from public.due_review_notifications());$job$);

-- Recipient-specific delivery leases remain inside the Telegram handler. This
-- coarse gate only skips work when no manual review is at least an hour old.
select cron.schedule('payment-review-reminders','*/5 * * * *',
  $job$select net.http_post(
    url := 'https://qhvrowoqeyeypmefwkha.supabase.co/functions/v1/payment-review-reminders',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='paddle_rage_balance_cron_secret' limit 1)),
    body := '{"source":"database-cron"}'::jsonb, timeout_milliseconds := 120000
  ) where exists (select 1 from public.payment_review_reminder_candidates
    where pending_since <= now()-interval '1 hour');$job$);

commit;
