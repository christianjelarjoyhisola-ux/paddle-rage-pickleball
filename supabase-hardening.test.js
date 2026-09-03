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
const atomicBookingConfirmation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260830090000_atomic_booking_confirmation.sql'
  ),
  'utf8'
);
const inclusivePricingMigration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260901160000_inclusive_court_pricing.sql'
  ),
  'utf8'
);
const baselineSetup = fs.readFileSync(path.join(root, 'SETUP_NEW_SUPABASE.sql'), 'utf8');
const gcashReviewFinalizer = gcashAutoMigration.slice(
  gcashAutoMigration.indexOf('create or replace function public.finalize_gcash_receipt_review')
);

function methodSources(source, methodName) {
  const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...source.matchAll(new RegExp(`^([ \\t]*)async\\s+${escaped}\\s*\\([^\\n]*\\)\\s*\\{`, 'gm'))];
  return matches.map(match => {
    const start = match.index;
    const restStart = start + match[0].length;
    const rest = source.slice(restStart);
    const indent = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const next = new RegExp(`^${indent}(?:async\\s+)?[A-Za-z_$][\\w$]*\\s*\\(`, 'm').exec(rest);
    return source.slice(start, next ? restStart + next.index : source.length);
  });
}

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

test('dashboard booking confirmation is an authenticated atomic group transaction', () => {
  const rpcFunction = atomicBookingConfirmation.match(
    /create or replace function public\.confirm_booking_transaction[\s\S]*?\n\$\$;/i
  )?.[0] || '';

  assert.match(
    rpcFunction,
    /language plpgsql\s+security definer\s+set search_path = public, pg_temp/i,
  );
  assert.match(
    rpcFunction,
    /has_account_role\(array\['owner', 'court_owner', 'staff'\]\)/i,
  );
  assert.match(rpcFunction, /paddle-rage-pickleball-booking-fee-remittance/i);
  assert.match(rpcFunction, /paddle-rage-public-booking-group:/i);
  assert.match(rpcFunction, /paddle-rage-booking-confirmation:/i);
  assert.ok(
    (rpcFunction.match(/pg_advisory_xact_lock(?:_shared)?\s*\(/gi) || []).length >= 3,
    'confirmation must serialize remittance, group membership, and repeat clicks',
  );
  assert.match(rpcFunction, /where b\.ref = requested_ref\s+for update/i);
  assert.match(
    rpcFunction,
    /where b\.booking_group_ref = observed_group_ref\s+order by b\.ref\s+for update/i,
  );

  for (const values of ['status_values', 'payment_status_values', 'host_values', 'method_values']) {
    assert.match(
      rpcFunction,
      new RegExp(`cardinality\\(${values}\\) <> 1`, 'i'),
      `${values} must be uniform across every sibling`,
    );
  }
  assert.match(rpcFunction, /current_booking_status in \('cancelled', 'completed', 'forfeited'\)/i);
  assert.match(rpcFunction, /current_payment_status in \('failed', 'rejected', 'deposit_retained'\)/i);
  assert.match(rpcFunction, /receipt_status[\s\S]*?= 'rejected'/i);
  assert.match(rpcFunction, /receipt_flags[\s\S]*?upper\(trim\(flag\)\) ~ '\^DUPLICATE_'/i);
  assert.match(rpcFunction, /distinct_receipt_images > 1 or distinct_receipt_hashes > 1/i);
  assert.match(
    rpcFunction,
    /is_digital_payment\s+and current_payment_status = 'for_verification'\s+and receipt_image_rows = 0/i,
  );
  assert.match(rpcFunction, /normalize_payment_reference_key[\s\S]*?cardinality\(reference_values\) <> 1/i);
  assert.match(rpcFunction, /not \(other_booking\.ref = any\(actual_refs\)\)[\s\S]*?payment_reference_key/i);
  assert.match(rpcFunction, /perform public\.claim_payment_reference\(/i);
  assert.match(
    rpcFunction,
    /full_amount_rows <> cardinality\(actual_refs\)[\s\S]*?abs\(expected_due - expected_total\) > 0\.01/i,
  );
  assert.match(rpcFunction, /calculate_booking_service_fee\(b\.slots\)[\s\S]*?\* 0\.25/i);

  assert.match(
    rpcFunction,
    /current_booking_status = 'confirmed'[\s\S]*?current_payment_status = target_payment_status[\s\S]*?select false/i,
    'repeat confirmations must return an idempotent non-transition result',
  );
  assert.equal(
    (rpcFunction.match(/\n\s*update public\.bookings\b/gi) || []).length,
    1,
    'all sibling rows must transition through one SQL update statement',
  );
  assert.match(
    rpcFunction,
    /update public\.bookings b\s+set status = 'confirmed',\s*payment_status = target_payment_status,\s*paid_at = case[\s\S]*?target_payment_status in \('paid', 'downpayment_paid'\)[\s\S]*?coalesce\(b\.paid_at, confirmation_time\)[\s\S]*?else b\.paid_at[\s\S]*?where b\.ref = any\(actual_refs\)/i,
  );
  assert.match(
    rpcFunction,
    /updated_count <> cardinality\(actual_refs\)[\s\S]*?complete group could be confirmed/i,
  );

  assert.match(
    atomicBookingConfirmation,
    /revoke all on function public\.confirm_booking_transaction\(text\)\s+from public, anon, authenticated/i,
  );
  assert.match(
    atomicBookingConfirmation,
    /grant execute on function public\.confirm_booking_transaction\(text\)\s+to authenticated/i,
  );
  assert.doesNotMatch(
    atomicBookingConfirmation,
    /grant execute on function public\.confirm_booking_transaction\(text\)\s+to (?:public|anon)/i,
  );
});

test('database stores the configured court price while privately snapshotting its allocation', () => {
  assert.match(
    inclusivePricingMigration,
    /court_total - public\.calculate_booking_service_fee\(booking_slots\)/i,
  );
  assert.match(
    inclusivePricingMigration,
    /booking_fee_amount_snapshot := least\(calculated_fee, authoritative_total\)/i,
  );
  assert.match(
    inclusivePricingMigration,
    /create trigger z10_snapshot_booking_fee_on_insert\s+before insert on public\.bookings/i,
  );
  assert.match(
    inclusivePricingMigration,
    /create trigger z20_mark_booking_fee_earned\s+before insert or update on public\.bookings/i,
  );
  assert.match(
    inclusivePricingMigration,
    /coalesce\(b\.booking_fee_amount_snapshot, public\.calculate_booking_service_fee\(b\.slots\)\)/i,
  );
  assert.match(
    inclusivePricingMigration,
    /coalesce\(wf\.billed_refs, '\[\]'::jsonb\) @> jsonb_build_array\(new\.ref\)[\s\S]*?new\.weekly_fee_id := null;\s*new\.billed_at := null;/i,
    'client-supplied legacy billing stamps must not suppress the fee ledger',
  );
  assert.doesNotMatch(
    inclusivePricingMigration,
    /\bupdate\s+public\.bookings\b/i,
    'historical booking totals must never be rewritten',
  );
  assert.match(
    inclusivePricingMigration,
    /if function_definition ~\* old_return_pattern then[\s\S]*?regexp_replace\(function_definition, old_return_pattern, new_return, 'i'\)[\s\S]*?elsif function_definition !~\* new_return_pattern then/i,
    'the migration must work both after the legacy schema and after the inclusive baseline setup',
  );
  assert.match(
    baselineSetup,
    /return\s+round\(\s*court_total\s*-\s*public\.calculate_booking_service_fee\(booking_slots\)\s*,\s*2\s*\);/i,
    'fresh Supabase setup must already use inclusive court pricing',
  );
});

test('admin accounting uses immutable fee snapshots and net court revenue', () => {
  assert.match(adminSite, /function storedPlatformFeeForBooking\(b\)/);
  assert.match(adminSite, /b\?\.bookingFeeAmountSnapshot \?\? b\?\.booking_fee_amount_snapshot/);
  assert.match(
    adminSite,
    /DB\.getBookingFeeRemittanceDashboard\(\)/,
    'the dashboard must use the authoritative server ledger instead of recalculating fees from mutable bookings',
  );
  assert.match(adminSite, /const PLATFORM_ALLOCATION_RATE = 10/);
  assert.match(adminSite, /Net Court Revenue/);
  assert.match(
    adminSite,
    /const rev=activeTxns\.reduce\(\(s,b\)=>s\+netCourtRevenueForBooking\(b,feeCfg\),0\)\+retainedRevenue;/,
  );
  assert.match(adminSite, /revByMonth\[mk\] \+= netCourtRevenueForBooking\(b, feeCfg\)/);
  assert.doesNotMatch(adminSite, /const totalFee = isFlat \? totalBookings \* _maintRate : totalHours \* _maintRate/);
  assert.doesNotMatch(adminSite, /id="maintRateInput"|id="saveMaintRate"/);
});

test('remote and local booking clients expose the same canonical confirmation result', () => {
  const adapters = methodSources(client, 'confirmBookingTransaction');
  assert.equal(adapters.length, 2, 'remote and local DB adapters must both implement confirmation');
  const remote = adapters.find(source => source.includes("_sb.rpc('confirm_booking_transaction'")) || '';
  const local = adapters.find(source => source.includes('writeDb(db)')) || '';
  assert.ok(remote, 'missing remote confirm_booking_transaction adapter');
  assert.ok(local, 'missing local confirmBookingTransaction adapter');

  assert.match(remote, /p_booking_ref:\s*bookingRef/);
  assert.match(remote, /typeof result\.transitioned !== 'boolean'/);
  assert.match(remote, /result\.booking_ref/);
  assert.match(remote, /result\.booking_refs/);
  assert.match(remote, /result\.booking_payment_status/);
  assert.match(remote, /result\.booking_status/);
  const clearAt = remote.indexOf("_pbClearFastCache(['bookings'])");
  const refreshAt = remote.indexOf('this.getBookingByRef(', clearAt);
  assert.ok(clearAt >= 0 && refreshAt > clearAt, 'booking cache must clear before the post-commit refresh');
  assert.match(remote, /catch \(readError\)[\s\S]*?console\.warn\('confirmBookingTransaction refresh:'/);

  assert.doesNotMatch(local, /_sb\.rpc\(/);
  assert.match(local, /groupRef|bookingGroupRef/);
  assert.match(local, /writeDb\(db\)/);
  assert.match(local, /paidAt/);
  assert.match(
    local,
    /item\.bookingFeeAmountSnapshot \?\? item\.booking_fee_amount_snapshot/,
    'local confirmation must prefer the immutable fee snapshot',
  );
  assert.match(
    local,
    /const requestedServiceFee = storedServiceFee !== null && storedServiceFee !== undefined[\s\S]*?\? parsedStoredServiceFee\s*:\s*configuredServiceFee/,
    'explicit zero snapshots must not fall back to current settings',
  );
  for (const [name, pattern] of [
    ['transitioned', /\btransitioned(?:\s*:|\s*[,}])/],
    ['booking', /\bbooking(?:\s*:|\s*[,}])/],
    ['paymentStatus', /\bpaymentStatus(?:\s*:|\s*[,}])/],
    ['status', /\bstatus(?:\s*:|\s*[,}])/],
    ['refs', /\brefs\s*[,}:]/],
  ]) {
    assert.match(remote, pattern, `remote result must expose camelCase ${name}`);
    assert.match(local, pattern, `local result must expose camelCase ${name}`);
  }
});

test('remote and local clients expose the same narrow cancelled-payment transfer contract', () => {
  const adapters = methodSources(client, 'transferCancelledBookingPayment');
  assert.equal(adapters.length, 2, 'remote and local DB adapters must both implement payment transfer');
  const remote = adapters.find(source => source.includes("_sb.rpc('transfer_cancelled_booking_payment'")) || '';
  const local = adapters.find(source => source.includes('bookingPaymentTransfers')) || '';
  assert.ok(remote, 'missing remote transfer_cancelled_booking_payment adapter');
  assert.ok(local, 'missing local transferCancelledBookingPayment adapter');

  for (const adapter of adapters) {
    assert.match(adapter, /sourceBookingRef[\s\S]*?targetBookingRef/);
    assert.match(adapter, /sourceBookingRef === targetBookingRef/);
    assert.match(adapter, /transferReason\.length < 10 \|\| transferReason\.length > 1000/);
    assert.match(adapter, /noRefundConfirmed !== true/);
    assert.match(adapter, /requestKey/);
    for (const field of [
      'transitioned',
      'transferId',
      'sourceBookingRef',
      'targetBookingRef',
      'targetBookingStatus',
      'targetPaymentStatus',
      'sourceBookingRefs',
      'targetBookingRefs',
    ]) {
      assert.match(adapter, new RegExp(`\\b${field}\\b`), `${field} missing from transfer adapter`);
    }
  }

  assert.match(remote, /p_source_booking_ref:\s*sourceBookingRef/);
  assert.match(remote, /p_target_booking_ref:\s*targetBookingRef/);
  assert.match(remote, /p_reason:\s*transferReason/);
  assert.match(remote, /p_no_refund_confirmed:\s*true/);
  assert.match(remote, /p_idempotency_key:\s*requestKey/);
  assert.match(remote, /typeof result\.transitioned !== 'boolean' \|\| !result\.transfer_id/);
  assert.match(remote, /_pbClearFastCache\(\['bookings'\]\)/);

  assert.match(local, /\['owner', 'court_owner'\]\.includes\(String\(session\.role/);
  assert.match(local, /session\.status && session\.status !== 'active'/);
  assert.match(local, /bookingPaymentTransfers\.find\(item => String\(item\.idempotencyKey\) === requestKey\)/);
  assert.match(local, /replay\.sourceBookingRef !== sourceBookingRef[\s\S]*?replay\.targetBookingRef !== targetBookingRef[\s\S]*?replay\.reason !== transferReason[\s\S]*?replay\.noRefundConfirmed !== true/);
  assert.match(local, /targetPaymentStatus !== 'for_verification'/, 'local target state must match the server-only For Verification gate');
  assert.match(local, /sourceStatus !== 'cancelled'/);
  assert.match(local, /!\['unpaid', 'paid', 'downpayment_paid'\]\.includes\(sourcePaymentStatus\)/, 'a review-only source must never be transferable');
  assert.match(local, /if \(!sourceHasSettlementEvidence\)/, 'all accepted source shapes need durable paid and fee-earned timestamps');
  assert.match(local, /sourceMethod !== targetMethod[\s\S]*?!PB_DIGITAL_PAYMENT_METHODS\.includes\(sourceMethod\)/);
  assert.match(local, /sourcePaymentRef !== targetPaymentRef/);
  assert.match(local, /sourceEmail !== targetEmail[\s\S]*?sourcePhone !== targetPhone/);
  assert.match(local, /sourceName !== targetName/, 'local mode must enforce the server same-player name check');
  assert.match(local, /sourceHost !== targetHost/);
  assert.match(local, /sourceHostId !== targetHostId/);
  assert.match(local, /sourceItems\.length !== targetItems\.length/, 'local mode must reject partial or differently sized groups');
  for (const shapeField of [
    'duration',
    'slots',
    'bookingFeeAmountSnapshot',
    'bookingFeeRateSnapshot',
    'bookingFeeTypeSnapshot',
    'bookingFeeUnitsSnapshot',
    'bookingFeeLedgerEligibleSnapshot',
  ]) {
    assert.match(local, new RegExp(`\\b${shapeField}\\b`), `local transfer does not compare ${shapeField}`);
  }
  assert.match(local, /receiptImageHash[\s\S]*?receiptPhash/);
  assert.match(local, /sourceReceiptHash[\s\S]*?targetReceiptHash|sourceHash[\s\S]*?targetHash/);
  assert.match(local, /hostBookingBalancePayments/, 'local mode must reject any Payment 2 history');
  assert.match(local, /weeklyFeeId|weekly_fee_id|billedAt|billed_at/, 'local mode must reject billed/remitted source money');
  assert.match(local, /openPlayRegistrations/, 'local mode must detect Open Play reference ownership');
  assert.match(local, /openPlayHostSessionRegistrations/, 'local mode must detect host-session reference ownership');
  assert.match(local, /localReferenceLedger[\s\S]*?canonicalClaims\.length !== 1[\s\S]*?ledgerScope !== sourceClaimScope[\s\S]*?ledgerOwnerId !== sourceClaimOwnerId/, 'an available local ledger must prove unique source ownership');
  assert.match(local, /canonicalLedgerClaim\.claim_scope = targetClaimScope|canonicalLedgerClaim\.claimScope = targetClaimScope/, 'local canonical ledger ownership must move to the target');
  assert.match(local, /paymentTransferId:\s*transferId[\s\S]*?paymentReassignedToRef:\s*targetBookingRef/);
  assert.match(local, /paymentReassignedFromRef:\s*sourceBookingRef/);
  assert.match(local, /db\.bookingPaymentTransfers\.push\(audit\)[\s\S]*?writeDb\(db\)/);
});

test('local cancelled-payment transfer is idempotent and moves the one fee allocation to the confirmed replacement', async () => {
  const localTransferSource = methodSources(client, 'transferCancelledBookingPayment')
    .find(source => source.includes('bookingPaymentTransfers')) || '';
  const localDashboardSource = methodSources(client, 'getBookingFeeRemittanceDashboard')
    .find(source => source.includes('const earned = readDb().bookings.filter')) || '';
  assert.ok(localTransferSource && localDashboardSource, 'missing local transfer/remittance methods');

  let localDb;
  const readDb = () => localDb;
  const writeDb = next => { localDb = next; };
  const session = { id: 'owner-1', userId: 'owner-1', role: 'owner', status: 'active' };
  const nowIso = () => '2026-09-03T04:00:00.000Z';
  const transfer = new Function(
    'PB_DIGITAL_PAYMENT_METHODS',
    'readDb',
    'writeDb',
    'nowIso',
    'window',
    `return ({${localTransferSource}}).transferCancelledBookingPayment;`,
  )(
    ['gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'],
    readDb,
    writeDb,
    nowIso,
    { Auth: { getSession: () => session } },
  );
  const dashboard = new Function(
    'readDb',
    'Auth',
    `return ({${localDashboardSource}}).getBookingFeeRemittanceDashboard;`,
  )(readDb, { getSession: () => session });

  const acceptedAt = '2026-09-02T23:08:34.000Z';
  const booking = ({ ref, groupRef, courtId, courtName, source }) => ({
    ref,
    groupRef,
    courtId,
    courtName,
    fullName: 'Same Player',
    email: 'player@example.com',
    contactNumber: '0917 555 0101',
    hostBooking: false,
    hostUserId: null,
    status: source ? 'cancelled' : 'pending',
    paymentStatus: source ? 'unpaid' : 'for_verification',
    paymentMethod: 'maya',
    gcashRef: '9F34 952D 6576',
    total: 800,
    downpayment: 800,
    slots: ['7:00 PM'],
    duration: 1,
    paidAt: source ? acceptedAt : null,
    bookingFeeEarnedAt: source ? acceptedAt : null,
    bookingFeeAmountSnapshot: 10,
    bookingFeeRateSnapshot: 10,
    bookingFeeTypeSnapshot: 'per_hour',
    bookingFeeUnitsSnapshot: 1,
    bookingFeeLedgerEligibleSnapshot: true,
    receiptStatus: 'manual_review',
    receiptImageUrl: 'receipts/same.png',
    receiptImageHash: 'same-hash',
    receiptPhash: 'same-phash',
  });
  localDb = {
    bookings: [
      booking({ ref: 'OLD-1', groupRef: 'OLD-G', courtId: 'old-1', courtName: 'Old Court 1', source: true }),
      booking({ ref: 'OLD-2', groupRef: 'OLD-G', courtId: 'old-2', courtName: 'Old Court 2', source: true }),
      booking({ ref: 'NEW-1', groupRef: 'NEW-G', courtId: 'new-1', courtName: 'New Court 1', source: false }),
      booking({ ref: 'NEW-2', groupRef: 'NEW-G', courtId: 'new-2', courtName: 'New Court 2', source: false }),
    ],
    settings: {},
    bookingPaymentTransfers: [],
    bookingFeeRemittanceItems: [],
    weeklyFees: [],
    hostBookingBalancePayments: [],
    openPlayRegistrations: [],
    openPlayHostSessionRegistrations: [],
    usedGcashRefs: [{
      gcashRef: 'maya:9F34952D6576',
      bookingRef: 'OLD-1',
      provider: 'maya',
      claimScope: 'booking_group',
      claimOwnerId: 'OLD-G',
    }],
  };

  const sourceRowsForSetup = () => localDb.bookings.filter(row => row.groupRef === 'OLD-G');
  sourceRowsForSetup().forEach(row => { row.paymentStatus = 'for_verification'; });
  await assert.rejects(
    transfer('OLD-1', 'NEW-1', 'Review-only source must not be movable.', true, '31fb1ea1-9877-4fd3-ad92-03569cf99d94'),
    /durably accepted payment/,
  );
  sourceRowsForSetup().forEach(row => { row.paymentStatus = 'unpaid'; });

  sourceRowsForSetup()[0].bookingFeeEarnedAt = null;
  await assert.rejects(
    transfer('OLD-1', 'NEW-1', 'Missing durable timestamp must fail.', true, '1e557fed-9427-48f0-bf65-4eca11fdd9cc'),
    /durable prior-acceptance timestamps/,
  );
  sourceRowsForSetup()[0].bookingFeeEarnedAt = acceptedAt;

  localDb.usedGcashRefs[0].claimOwnerId = 'ANOTHER-GROUP';
  await assert.rejects(
    transfer('OLD-1', 'NEW-1', 'Wrong canonical owner must fail.', true, '508e0cfb-a7df-4e03-b490-e32f9ec849e0'),
    /canonical payment reference belongs to another booking/,
  );
  localDb.usedGcashRefs[0].claimOwnerId = 'OLD-G';

  const request = ['OLD-1', 'NEW-1', 'Player cancelled a mistaken reservation and rebooked.', true, '8bb20150-e11e-4fe7-a4e8-0d9752d00c31'];
  const [first, replay] = await Promise.all([transfer(...request), transfer(...request)]);
  assert.equal(first.transitioned, true);
  assert.equal(replay.transitioned, false);
  assert.equal(replay.transferId, first.transferId);
  assert.equal(localDb.bookingPaymentTransfers.length, 1, 'an idempotent replay must not append another audit');

  const sourceRows = localDb.bookings.filter(row => row.groupRef === 'OLD-G');
  const targetRows = localDb.bookings.filter(row => row.groupRef === 'NEW-G');
  assert.ok(sourceRows.every(row => row.status === 'cancelled' && row.paymentStatus === 'unpaid'));
  assert.ok(sourceRows.every(row => row.paidAt === acceptedAt && row.bookingFeeEarnedAt === acceptedAt));
  assert.ok(sourceRows.every(row => row.paymentTransferId === first.transferId && row.paymentReassignedToRef === 'NEW-1'));
  assert.ok(targetRows.every(row => row.status === 'confirmed' && row.paymentStatus === 'paid'));
  assert.ok(targetRows.every(row => row.bookingFeeEarnedAt === nowIso()), 'the confirmed target must own the earned allocation');
  assert.ok(targetRows.every(row => row.paymentTransferId === first.transferId && row.paymentReassignedFromRef === 'OLD-1'));
  assert.deepEqual(localDb.usedGcashRefs, [{
    gcashRef: 'maya:9F34952D6576',
    bookingRef: 'NEW-1',
    provider: 'maya',
    claimScope: 'booking_group',
    claimOwnerId: 'NEW-G',
  }], 'the canonical local ledger claim must move atomically to the replacement group');

  const ledger = await dashboard();
  assert.equal(ledger.accumulated.booking_rows_count, 2, 'source and target fees must never both be billable');
  assert.equal(ledger.accumulated.amount, 20);
  assert.deepEqual(
    ledger.accumulated.court_breakdown.map(row => row.court_name),
    ['New Court 1', 'New Court 2'],
    'the fee allocation must be attributed to the replacement courts',
  );
});

test('local booking creation stamps the same bounded private allocation', () => {
  assert.match(client, /const localBookingFeeSnapshot = \(booking, settings = \{\}\) =>/);
  assert.match(
    client,
    /explicitAmount !== null && explicitAmount !== undefined && Number\.isFinite\(parsedExplicitAmount\)/,
    'an explicit zero snapshot must be preserved',
  );
  assert.match(client, /Math\.min\(total, Math\.max\(0, calculatedAmount\)\)/);
  assert.match(client, /\.\.\.localBookingFeeSnapshot\(row, db\.settings \|\| \{\}\)/);
  assert.match(
    client,
    /const downpayment = Math\.round\(\(\(courtFee \* 0\.25\) \+ serviceFee\) \* 100\) \/ 100;/,
    'host demo reservations must retain centavo precision (₱107.50, not ₱108)',
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
