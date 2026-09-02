const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.join(
  __dirname,
  'supabase',
  'migrations',
  '20260902130000_expire_orphan_booking_holds.sql'
), 'utf8');

test('placeholder cancellations bypass automatic payment-review suppression', () => {
  const rejectionGuard = migration.match(
    /create or replace function public\.prevent_automatic_booking_rejection\(\)[\s\S]*?\n\$\$;/i
  )?.[0] || '';

  assert.match(rejectionGuard, /placeholder_hold boolean[\s\S]*?reserve@hold\.internal/i);
  assert.match(rejectionGuard, /lower\(trim\(coalesce\(new\.full_name, ''\)\)\) like 'reserving%'/i);
  assert.match(rejectionGuard, /if placeholder_hold then\s+return new;/i);
  assert.ok(
    rejectionGuard.indexOf('if placeholder_hold then') <
      rejectionGuard.indexOf('new.status := \'pending\''),
    'placeholder exemption must run before automatic rejection is changed to pending'
  );
});

test('one canonical predicate controls public and conflict occupancy', () => {
  const predicate = migration.match(
    /create or replace function public\.booking_occupies_slot[\s\S]*?\n\$\$;/i
  )?.[0] || '';

  assert.match(predicate, /in \('cancelled', 'forfeited'\)[\s\S]*?then false/i);
  assert.match(predicate, /booking_created_at <= now\(\) - interval '15 minutes'/i);
  assert.match(predicate, /booking_status[\s\S]*?= 'verifying'/i);
  assert.match(predicate, /booking_email[\s\S]*?reserve@hold\.internal/i);
  assert.match(predicate, /booking_full_name[\s\S]*?like 'reserving%'/i);

  const uses = migration.match(/public\.booking_occupies_slot\(/gi) || [];
  assert.ok(uses.length >= 4, 'definition, availability, incoming, and existing conflict rows must share the predicate');
  assert.match(
    migration,
    /grant execute on function public\.booking_occupies_slot\(text, text, text, timestamptz\)\s+to anon, authenticated, service_role/i
  );
  assert.match(migration, /get_public_booking_availability[\s\S]*?public\.booking_occupies_slot\(b\.status, b\.email, b\.full_name, b\.created_at\)/i);
  assert.match(migration, /prevent_double_booking[\s\S]*?public\.booking_occupies_slot\([\s\S]*?booking\.status,[\s\S]*?booking\.email/i);
});

test('cleanup is limited to expired placeholders with no payment evidence', () => {
  const cleanup = migration.slice(migration.lastIndexOf('update public.bookings booking'));

  assert.match(cleanup, /status in \('verifying', 'pending'\)/i);
  assert.match(cleanup, /created_at <= now\(\) - interval '15 minutes'/i);
  assert.match(cleanup, /reserve@hold\.internal[\s\S]*?reserving%/i);
  assert.match(cleanup, /receipt_image_url is null/i);
  assert.match(cleanup, /receipt_image_hash is null/i);
  assert.match(cleanup, /nullif\(btrim\(coalesce\(booking\.gcash_ref, ''\)\), ''\) is null/i);
  assert.match(cleanup, /set status = 'cancelled',[\s\S]*?payment_status = 'rejected',[\s\S]*?receipt_status = 'rejected'/i);
});

test('payment-decision role guard remains enabled for genuine bookings', () => {
  assert.match(
    migration,
    /create trigger y90_guard_booking_payment_decision_role[\s\S]*?when \([\s\S]*?reserve@hold\.internal[\s\S]*?new\.status in \('cancelled', 'forfeited'\)[\s\S]*?new\.receipt_image_url is null[\s\S]*?execute function public\.guard_digital_payment_decision_role\(\)/i
  );
});
