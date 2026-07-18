const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = __dirname;
const migrationPath = path.join(
  root,
  'supabase',
  'migrations',
  '20260719083000_public_data_access_hardening.sql'
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const client = fs.readFileSync(path.join(root, 'supabase-config.js'), 'utf8');
const publicSite = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const adminSite = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const receiptVerifier = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'verify-gcash-receipt', 'index.ts'),
  'utf8'
);

test('anonymous booking reads expose availability fields but not PII', () => {
  assert.match(migration, /drop policy if exists bookings_select_public on public\.bookings/i);
  assert.doesNotMatch(migration, /grant select \([\s\S]*?\) on public\.bookings to anon/i);
  assert.match(migration, /function public\.get_public_booking_availability/i);
  assert.match(client, /_sb\.rpc\('get_public_booking_availability'/i);
  assert.match(migration, /function public\.get_public_booking_by_ref/i);
  assert.match(client, /_sb\.rpc\('get_public_booking_by_ref'/i);
  assert.match(migration, /customer_access_token_hash = encode\(extensions\.digest\(p_access_token, 'sha256'\), 'hex'\)/i);
  assert.doesNotMatch(
    migration.match(/function public\.get_public_booking_availability[\s\S]*?\$\$;/i)?.[0] || '',
    /full_name|contact_number|email|gcash_ref|receipt_|booking_group_ref/i
  );
});

test('anonymous booking updates require a hashed bearer token', () => {
  assert.match(migration, /drop policy if exists bookings_update_public_hold/i);
  assert.match(migration, /create or replace function public\.update_public_booking_hold/i);
  assert.match(migration, /encode\(extensions\.digest\(p_access_token, 'sha256'\), 'hex'\)/i);
  assert.match(migration, /customer_access_token_hash <> token_hash/i);
  assert.match(migration, /existing\.customer_access_token_hash is distinct from new\.customer_access_token_hash/i);
  assert.match(migration, /not in \('verifying', 'pending', 'cancelled'\)/i);
  assert.match(migration, /not in\s*\('unpaid', 'pending', 'for_verification', 'rejected'\)/i);
  assert.match(migration, /revoke all on table public\.bookings from public, anon/i);

  assert.match(client, /crypto\.getRandomValues\(bytes\)/i);
  assert.match(client, /crypto\.subtle\.digest\('SHA-256'/i);
  assert.match(client, /const tokenKey = batch\[0\]\.groupRef \|\| batch\[0\]\.ref/i);
  assert.match(client, /_invokeEdgeFunction\('submit-public-booking'/i);
  assert.match(migration, /function public\.submit_public_booking_holds/i);
  assert.match(migration, /grant execute on function public\.submit_public_booking_holds\(jsonb, text\)\s+to service_role/i);
  assert.doesNotMatch(migration, /grant insert on table public\.bookings to anon/i);
  assert.match(client, /_sb\.rpc\('update_public_booking_hold'/i);
});

test('operator and receipt access is tied to active account roles', () => {
  assert.match(
    migration,
    /create policy bookings_select_dashboard_roles[\s\S]*?has_account_role\(array\['owner', 'court_owner', 'staff'\]\)/i
  );
  assert.match(
    migration,
    /create policy receipt_verifications_select_admin[\s\S]*?has_account_role\(array\['owner', 'court_owner', 'staff'\]\)/i
  );
  assert.doesNotMatch(
    migration,
    /create policy receipt_verifications_select_admin[\s\S]{0,160}?using\s*\(true\)/i
  );

  assert.match(client, /form\.append\('bookingAccessToken', requestPayload\.bookingAccessToken\)/i);
  assert.match(receiptVerifier, /bookingAccessTokenMatches\([\s\S]*?storedAccessTokenHash/i);
  assert.match(receiptVerifier, /customer_access_token_hash[\s\S]*?bookingMutationScope/i);
  assert.match(receiptVerifier, /canViewBookingReceipt\(caller\.account, caller\.userId, booking\)/i);
  assert.match(receiptVerifier, /canViewHostSessionReceipt\(caller\.account, caller\.userId, session\)/i);
  assert.match(receiptVerifier, /canViewDashboardReceipt\(caller\.account\)/i);
  assert.ok(
    receiptVerifier.indexOf('const customerTokenAuthorized = await bookingAccessTokenMatches(') <
      receiptVerifier.indexOf('db.storage.from("receipts").upload('),
    'persisted-booking authorization must run before receipt storage'
  );
});

test('public open-play inserts cannot self-approve payments', () => {
  assert.match(migration, /create or replace function public\.prepare_public_open_play_registration/i);
  assert.match(migration, /new\.payment_status := 'pending'/i);
  assert.match(migration, /new\.receipt_status := 'manual_review'/i);
  assert.match(migration, /new\.receipt_extracted := null/i);
  assert.match(migration, /function public\.submit_public_open_play_registration/i);
  assert.match(migration, /open_play_config_text[\s\S]*?where s\.key = 'open_play_config'/i);
  assert.match(migration, /new\.payment_type := canonical_payment_type/i);
  assert.match(migration, /new\.amount := case[\s\S]*?canonical_total/i);
  assert.match(migration, /pg_advisory_xact_lock\([\s\S]*?paddle-rage-open-play-registration/i);
  assert.match(migration, /active_registrations >= configured_max_players/i);
  assert.ok(
    (migration.match(/from storage\.objects receipt_object/g) || []).length >= 2,
    'regular and host-session registrations must reference a receipt object uploaded by the verifier'
  );
  assert.ok(
    (migration.match(/paddle-rage-public-receipt-path/g) || []).length >= 2,
    'receipt paths must be serialized and single-use across public registration flows'
  );
  assert.match(migration, /This receipt upload has already been used/i);
  assert.match(migration, /drop policy if exists open_play_insert_public/i);
  assert.match(migration, /function public\.get_public_open_play_counts/i);
  assert.match(client, /_sb\.rpc\('get_public_open_play_counts'/i);
  assert.match(client, /_invokeEdgeFunction\('submit-public-registration'/i);
  assert.match(publicSite, /regPayStatus = savedRegistration\.paymentStatus/i);
  assert.match(publicSite, /const canonicalAmount = Number\(savedRegistration\.amount \|\| 0\)/i);

  const publicInsertClient = client.match(/async addOpenPlayRegistration\(reg\)[\s\S]*?\n  },/i)?.[0] || '';
  assert.doesNotMatch(publicInsertClient, /\.from\('open_play_registrations'\)\.insert/i);
  assert.equal((client.match(/async addOpenPlayRegistration\(reg\)/g) || []).length, 2);
  assert.match(client, /paymentStatus: row\.payment_status[\s\S]*?amount: Number\(row\.amount \|\| 0\)/i);

  const grant = migration.match(/grant select \(([\s\S]*?)\) on public\.open_play_registrations to anon;/i)?.[1] || '';
  assert.match(grant, /court_id/i);
  assert.doesNotMatch(grant, /full_name|gcash_ref|receipt_/i);
});

test('host-session joins use authoritative session price, capacity, and payment state', () => {
  assert.match(migration, /function public\.prepare_public_host_session_registration/i);
  assert.match(migration, /new\.amount := target_session\.fee_per_player/i);
  assert.match(migration, /active_registrations >= target_session\.max_players/i);
  assert.match(migration, /new\.payment_status := 'pending'[\s\S]*?new\.receipt_status := 'manual_review'/i);
  assert.match(migration, /drop policy if exists open_play_host_session_registrations_insert_public/i);
  assert.match(migration, /revoke all on table public\.open_play_host_session_registrations from public, anon/i);
  assert.match(migration, /function public\.submit_public_host_session_registration/i);
  assert.match(client, /_invokeEdgeFunction\('submit-public-registration'/i);
  assert.match(publicSite, /paymentStatus = savedRegistration\.paymentStatus/i);
  assert.match(publicSite, /canonicalReceiptStatus = savedRegistration\.receiptStatus/i);
  assert.doesNotMatch(
    client.match(/async addOpenPlayHostSessionRegistration\(reg\)[\s\S]*?\n  },/i)?.[0] || '',
    /\.from\('open_play_host_session_registrations'\)\.insert/i
  );
});

test('published host sessions expose only the public share-link projection', () => {
  assert.match(migration, /drop policy if exists open_play_host_sessions_select_public/i);
  assert.match(migration, /create policy open_play_host_sessions_select_dashboard_roles[\s\S]*?array\['owner', 'court_owner'\]/i);
  assert.match(migration, /create policy open_play_host_sessions_select_host_own[\s\S]*?host_user_id = auth\.uid\(\)/i);
  assert.match(migration, /revoke all on table public\.open_play_host_sessions from public, anon/i);
  assert.match(migration, /function public\.get_public_open_play_host_sessions/i);
  assert.match(client, /_sb\.rpc\('get_public_open_play_host_sessions'/i);
  assert.match(publicSite, /getOpenPlayHostSessions\(\{ publicOnly: true, id \}\)/i);

  const publicSessionsFunction = migration.match(
    /create or replace function public\.get_public_open_play_host_sessions[\s\S]*?\n\$\$;/i
  )?.[0] || '';
  assert.match(publicSessionsFunction, /s\.status = 'published'/i);
  assert.doesNotMatch(publicSessionsFunction, /host_user_id|host_email/i);
});

test('digital payment references are claimed once across every payment flow', () => {
  assert.match(migration, /add column if not exists claim_scope text/i);
  assert.match(migration, /add column if not exists claim_owner_id text/i);
  assert.match(migration, /claim_scope in \('booking', 'booking_group', 'open_play', 'host_session'\)/i);
  assert.match(migration, /function public\.normalize_payment_reference_key/i);
  assert.match(
    migration,
    /provider_value = 'gcash'[\s\S]*?regexp_replace\(coalesce\(p_typed_reference, ''\), '\[\^0-9\]', '', 'g'\)/i
  );
  assert.match(migration, /else provider_value \|\| ':' \|\| normalized_value/i);
  assert.match(migration, /function public\.claim_payment_reference/i);
  assert.match(migration, /on conflict \(gcash_ref\) do nothing/i);
  assert.match(migration, /incumbent_scope is distinct from scope_value/i);
  assert.match(migration, /incumbent_owner is distinct from owner_value/i);
  assert.match(migration, /This payment reference has already been used for another payment/i);

  assert.match(migration, /trigger z90_claim_booking_reference_when_settled/i);
  assert.match(migration, /new\.payment_status not in \('paid', 'downpayment_paid', 'deposit_retained'\)/i);
  assert.match(migration, /owner_scope text := case[\s\S]*?'booking_group'[\s\S]*?'booking'/i);
  assert.match(migration, /trigger z90_claim_open_play_reference_when_paid/i);
  assert.match(migration, /trigger z90_claim_host_session_reference_when_paid/i);
  assert.match(migration, /new\.payment_status <> 'paid' or method_value = 'cash'/i);
  assert.match(migration, /'open_play',[\s\S]*?'op:' \|\| new\.id::text/i);
  assert.match(migration, /'host_session',[\s\S]*?'hs:' \|\| new\.id::text/i);
  assert.match(migration, /revoke all on table public\.used_gcash_refs from public, anon, authenticated/i);

  assert.match(receiptVerifier, /ledgerClaimScope = bookingGroupRef \? "booking_group" : "booking"/i);
  assert.match(receiptVerifier, /select\("booking_ref,claim_scope,claim_owner_id"\)/i);
  assert.doesNotMatch(receiptVerifier, /claim_scope: ledgerClaimScope/i);
  assert.doesNotMatch(receiptVerifier, /claim_owner_id: ledgerClaimOwnerId/i);
  assert.doesNotMatch(receiptVerifier, /from\("used_gcash_refs"\)[\s\S]{0,160}\.insert\(/i);
  assert.match(adminSite, /reference has already been used[\s\S]*?Failed to confirm payment/i);
});
