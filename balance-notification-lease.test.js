const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = __dirname;
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260719100000_balance_notification_delivery_leases.sql'),
  'utf8'
);
const processor = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'process-host-balance-deadlines', 'index.ts'),
  'utf8'
);

test('one atomic upsert serializes balance-notification claimants', () => {
  const claimFunction = migration.match(
    /create or replace function public\.claim_booking_balance_notification[\s\S]*?\n\$\$;/i
  )?.[0] || '';
  assert.match(claimFunction, /insert into public\.booking_balance_notifications as notice/i);
  assert.match(claimFunction, /on conflict \(booking_key, event_type\) do update/i);
  assert.match(claimFunction, /notice\.status = 'failed'/i);
  assert.match(
    claimFunction,
    /notice\.status = 'pending'[\s\S]*?delivery_lease_expires_at[\s\S]*?<= now\(\)/i
  );
  assert.match(claimFunction, /coalesce\(p_force, false\) and notice\.status = 'sent'/i);
  assert.match(claimFunction, /returning notice\.\* into claimed/i);
  assert.doesNotMatch(claimFunction, /select[\s\S]*?for update/i);
});

test('active leases are bounded and legacy pending attempts receive a safe lease', () => {
  assert.match(migration, /greatest\(60, least\(coalesce\(p_lease_seconds, 300\), 900\)\)/i);
  assert.match(
    migration,
    /coalesce\(last_attempt_at, created_at, now\(\)\) \+ interval '10 minutes'/i
  );
  assert.match(migration, /where status = 'pending'/i);
  assert.match(migration, /reason'[\s\S]*?'lease_active'/i);
  assert.match(
    migration,
    /status = 'pending'[\s\S]*?delivery_lease_token is not null[\s\S]*?delivery_lease_expires_at > last_attempt_at/i
  );
});

test('only the lease owner can mark a delivery sent or failed', () => {
  const finishFunction = migration.match(
    /create or replace function public\.finish_booking_balance_notification[\s\S]*?\n\$\$;/i
  )?.[0] || '';
  assert.match(finishFunction, /p_outcome not in \('sent', 'failed'\)/i);
  assert.match(finishFunction, /where id = p_notification_id/i);
  assert.match(finishFunction, /and status = 'pending'/i);
  assert.match(finishFunction, /and delivery_lease_token = p_claim_token/i);
  assert.match(finishFunction, /delivery_lease_token = null/i);
  assert.match(finishFunction, /delivery_lease_expires_at = null/i);
  assert.match(migration, /revoke all on function public\.claim_booking_balance_notification[\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /revoke all on function public\.finish_booking_balance_notification[\s\S]*?from public, anon, authenticated/i);
});

test('the Edge Function claims before Maileroo and has no read-then-upsert race', () => {
  const claimAt = processor.indexOf('await claimBalanceNotification(');
  const sendAt = processor.indexOf('await sendMailerooEmail(');
  assert.ok(claimAt >= 0 && sendAt > claimAt, 'Maileroo must run only after the DB claim');
  assert.doesNotMatch(processor, /booking_balance_notifications[\s\S]{0,600}?\.upsert\(/i);
  assert.ok(
    (processor.match(/await finishBalanceNotification\(/g) || []).length >= 2,
    'both provider success and failure must release the owned lease'
  );
  assert.match(processor, /if \(!claim\.acquired\)[\s\S]*?Already processing/i);
});
