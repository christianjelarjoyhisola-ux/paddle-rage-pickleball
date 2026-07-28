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
const gcashAutoMigration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260728120000_gcash_receipt_auto_verification.sql'
  ),
  'utf8'
);
const gcashReviewFinalizer = gcashAutoMigration.slice(
  gcashAutoMigration.indexOf('create or replace function public.finalize_gcash_receipt_review')
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

test('GCash auto-approval is a service-role-only atomic finalization', () => {
  assert.match(
    gcashAutoMigration,
    /create or replace function public\.finalize_gcash_receipt_auto_approval/i
  );
  assert.match(
    gcashAutoMigration,
    /language plpgsql\s+security definer\s+set search_path = public, pg_temp/i
  );
  assert.match(
    gcashAutoMigration,
    /pg_advisory_xact_lock[\s\S]*?paddle-rage-public-booking-group:' \|\| observed_group_ref/i
  );
  assert.match(gcashAutoMigration, /where b\.ref = p_booking_ref\s+for update/i);
  assert.match(
    gcashAutoMigration,
    /where b\.booking_group_ref = observed_group_ref\s+order by b\.ref\s+for update/i
  );
  assert.match(
    gcashAutoMigration,
    /actual_refs is distinct from expected_refs[\s\S]*?Booking group changed during receipt verification/i
  );

  // The transaction re-checks canonical stored rows instead of trusting the
  // Edge Function's earlier snapshot.
  assert.match(
    gcashAutoMigration,
    /lower\(trim\(coalesce\(b\.payment_method, ''\)\)\) <> 'gcash'/i
  );
  assert.match(
    gcashAutoMigration,
    /regexp_replace\(coalesce\(b\.gcash_ref, ''\), '\[\^0-9\]', '', 'g'\)[\s\S]*?<> normalized_reference/i
  );
  assert.match(
    gcashAutoMigration,
    /b\.status not in \('verifying', 'pending'\)[\s\S]*?b\.payment_status not in \('unpaid', 'pending', 'for_verification'\)/i
  );
  assert.match(
    gcashAutoMigration,
    /p_receipt_extracted->>'provider', ''\) <> 'gcash'[\s\S]*?p_receipt_extracted->>'parserVersion', ''\) <> 'gcash_v1'/i
  );

  // The finalizer independently revalidates every high-confidence parser gate
  // instead of trusting the Edge Function's auto_approved classification.
  assert.match(
    gcashAutoMigration,
    /cardinality\(coalesce\(p_receipt_flags, array\[\]::text\[\]\)\) <> 0/i
  );
  assert.match(
    gcashAutoMigration,
    /p_receipt_confidence is null[\s\S]*?p_receipt_confidence < 0\.90[\s\S]*?p_receipt_confidence > 1/i
  );
  assert.match(
    gcashAutoMigration,
    /\{gcash,reference,source\}[\s\S]*?<> 'ref_label'[\s\S]*?\{gcash,reference,confidence\}[\s\S]*?<> 'high'[\s\S]*?\{gcash,reference,typedMatch\}[\s\S]*?<> 'match'/i
  );
  assert.match(
    gcashAutoMigration,
    /\{gcash,amount,reliable\}[\s\S]*?<> 'true'[\s\S]*?\{gcash,amount,ambiguous\}[\s\S]*?<> 'false'[\s\S]*?\{gcash,amount,conflictingPrimaryAmounts\}[\s\S]*?<> 'false'/i
  );
  assert.match(
    gcashAutoMigration,
    /\{gcash,timestamp,completeness\}[\s\S]*?<> 'date_time'[\s\S]*?receiptAgeMinutes[\s\S]*?< -2[\s\S]*?receiptAgeMinutes[\s\S]*?> 15/i
  );
  assert.match(
    gcashAutoMigration,
    /\{gcash,recipientComparison,phone\}[\s\S]*?<> 'exact'[\s\S]*?\{gcash,recipientComparison,name\}[\s\S]*?= 'mismatch'/i
  );
  assert.match(
    gcashAutoMigration,
    /\{gcash,indicators,classification\}[\s\S]*?<> 'gcash'[\s\S]*?\{gcash,indicators,sentViaGcash\}[\s\S]*?<> 'true'[\s\S]*?\{gcash,indicators,totalAmountSent\}[\s\S]*?<> 'true'[\s\S]*?\{gcash,indicators,referenceLabel\}[\s\S]*?<> 'true'[\s\S]*?\{gcash,indicators,amountLabel\}[\s\S]*?<> 'true'[\s\S]*?ocrProvider[\s\S]*?<> 'google_vision'/i
  );
  assert.match(
    gcashAutoMigration,
    /ocrConfidenceSource', ''\)[\s\S]*?<> 'native'/i
  );
  assert.match(
    gcashAutoMigration,
    /p_receipt_extracted->>'autoPaymentStatus'[\s\S]*?<> p_payment_status/i
  );
  assert.match(
    gcashAutoMigration,
    /p_receipt_extracted->>'amount'[\s\S]*?!~ '\^\[0-9\]\+\(\[\.\]\[0-9\]\+\)\?\$'[\s\S]*?paid_amount := \(p_receipt_extracted->>'amount'\)::numeric/i
  );
  assert.match(
    gcashAutoMigration,
    /p_payment_status = 'paid'[\s\S]*?abs\(paid_amount - expected_total\) > 0\.01/i
  );
  assert.match(
    gcashAutoMigration,
    /p_payment_status[\s\S]*?'downpayment_paid'[\s\S]*?non_host_rows <> 0[\s\S]*?abs\(paid_amount - expected_due\) > 0\.01/i
  );

  // Booking confirmation, the existing settled-reference claim trigger, and
  // the immutable audit insert all commit or roll back together.
  assert.match(
    gcashAutoMigration,
    /update public\.bookings b\s+set status = 'confirmed',\s*payment_status = p_payment_status/i
  );
  assert.match(
    gcashAutoMigration,
    /receipt_status = 'auto_approved'[\s\S]*?where b\.ref = any\(actual_refs\)/i
  );
  assert.match(
    gcashAutoMigration,
    /updated_count <> cardinality\(actual_refs\)[\s\S]*?Automatic settlement did not update the complete booking group/i
  );
  assert.match(
    gcashAutoMigration,
    /insert into public\.receipt_verifications[\s\S]*?'auto_approved'/i
  );
  assert.match(
    gcashAutoMigration,
    /lease_row\.claim_token is distinct from p_lease_token[\s\S]*?receipt_image_hash is distinct from p_receipt_image_hash/i
  );
  assert.match(
    gcashAutoMigration,
    /create or replace function public\.finalize_gcash_receipt_review[\s\S]*?duplicate_owned_elsewhere[\s\S]*?GCash review did not update the complete booking group/i
  );
  assert.match(
    gcashReviewFinalizer,
    /p_result = 'rejected'[\s\S]*?cardinality\(coalesce\(p_receipt_flags, array\[\]::text\[\]\)\) <> 1[\s\S]*?ocrConfidence[\s\S]*?< 0\.90/i
  );
  assert.match(
    gcashReviewFinalizer,
    /\{gcash,indicators,classification\}[\s\S]*?<> 'gcash'[\s\S]*?ocrProvider[\s\S]*?<> 'google_vision'[\s\S]*?ocrConfidenceSource[\s\S]*?<> 'native'/i
  );
  assert.match(
    gcashReviewFinalizer,
    /paid_amount := \(p_receipt_extracted->>'amount'\)::numeric[\s\S]*?abs\(paid_amount - expected_due\) > 0\.01/i
  );
  assert.match(migration, /trigger z90_claim_booking_reference_when_settled/i);
  assert.match(
    gcashAutoMigration,
    /revoke all on function public\.finalize_gcash_receipt_auto_approval\([\s\S]*?\)\s+from public, anon, authenticated/i
  );
  assert.match(
    gcashAutoMigration,
    /grant execute on function public\.finalize_gcash_receipt_auto_approval\([\s\S]*?\)\s+to service_role/i
  );
  assert.doesNotMatch(
    gcashAutoMigration,
    /grant execute on function public\.finalize_gcash_receipt_auto_approval\([\s\S]*?\)\s+to (?:public|anon|authenticated)/i
  );
  assert.match(
    gcashAutoMigration,
    /revoke all on function public\.finalize_gcash_receipt_review\([\s\S]*?\)\s+from public, anon, authenticated[\s\S]*?grant execute on function public\.finalize_gcash_receipt_review\([\s\S]*?\)\s+to service_role/i
  );
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
