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
const cleanupMigration = fs.readFileSync(path.join(
  __dirname,
  'supabase',
  'migrations',
  '20260902150000_automatic_booking_hold_cleanup.sql'
), 'utf8');
const dataLayer = fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');
const publicPage = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const adminPage = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

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

test('one canonical predicate expires placeholders without releasing genuine verification rows', () => {
  const predicate = cleanupMigration.match(
    /create or replace function public\.booking_occupies_slot[\s\S]*?\n\$\$;/i
  )?.[0] || '';

  assert.match(predicate, /in \('cancelled', 'forfeited'\)[\s\S]*?then false/i);
  assert.match(predicate, /booking_created_at <= now\(\) - interval '15 minutes'/i);
  assert.match(predicate, /booking_email[\s\S]*?reserve@hold\.internal/i);
  assert.match(predicate, /booking_status[\s\S]*?= 'verifying'[\s\S]*?booking_email[\s\S]*?booking_full_name/i);
  assert.match(predicate, /booking_full_name[\s\S]*?in \('reserving\.\.\.', 'reserving…'\)/i);
  assert.doesNotMatch(predicate, /booking_email[\s\S]*?reserve@hold\.internal'[\s\S]*?\bor\b[\s\S]*?booking_full_name/i);

  const uses = `${migration}\n${cleanupMigration}`.match(/public\.booking_occupies_slot\(/gi) || [];
  assert.ok(uses.length >= 5, 'final definition, availability, incoming, and existing conflict rows must share the predicate');
  assert.match(
    cleanupMigration,
    /grant execute on function public\.booking_occupies_slot\(text, text, text, timestamptz\)\s+to anon, authenticated, service_role/i
  );
  assert.match(migration, /get_public_booking_availability[\s\S]*?public\.booking_occupies_slot\(b\.status, b\.email, b\.full_name, b\.created_at\)/i);
  assert.match(migration, /prevent_double_booking[\s\S]*?public\.booking_occupies_slot\([\s\S]*?booking\.status,[\s\S]*?booking\.email/i);
  const finalConflictGuard = cleanupMigration.match(
    /create or replace function public\.prevent_double_booking\(\)[\s\S]*?\n\$\$;/i
  )?.[0] || '';
  assert.match(
    finalConflictGuard,
    /new\.slots is not distinct from old\.slots[\s\S]*?new\.email is not distinct from old\.email[\s\S]*?new\.full_name is not distinct from old\.full_name[\s\S]*?new\.created_at is not distinct from old\.created_at/i
  );
  assert.match(finalConflictGuard, /paddle-rage-booking-slot\|/i);
  assert.match(finalConflictGuard, /booking\.slots && new\.slots[\s\S]*?booking_occupies_slot/i);
  assert.match(publicPage, /function isHeldVerifying\(b\)[\s\S]*?if \(!isPlaceholderBookingHold\(b\)\) return true;/i);
  assert.match(adminPage, /function bookingHoldsAdminSlot\(b\)[\s\S]*?if \(!isPlaceholderHold\(b\)\) return true;/i);
  const browserCleanup = publicPage.match(/async function expireStaleVerifyingBookings\(\)[\s\S]*?\n}/i)?.[0] || '';
  assert.match(browserCleanup, /isPlaceholderBookingHold\(b\)/i);
  assert.doesNotMatch(browserCleanup, /status:\s*'pending'[\s\S]*?paymentStatus:\s*'for_verification'/i);
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

test('hold release atomically authorizes bearer, host, or dashboard-owned placeholder groups', () => {
  const release = cleanupMigration.match(
    /create or replace function public\.release_public_booking_hold[\s\S]*?\n\$\$;/i
  )?.[0] || '';
  assert.match(release, /request_role not in \('anon', 'authenticated'\)/i);
  assert.match(release, /token_mode[\s\S]*?customer_access_token_hash is not null[\s\S]*?customer_access_token_hash = token_hash/i);
  assert.match(release, /account_role = 'host'[\s\S]*?host_user_id = auth\.uid\(\)[\s\S]*?created_by_user_id = auth\.uid\(\)/i);
  assert.match(release, /account_role in \('owner', 'court_owner', 'staff'\)[\s\S]*?customer_access_token_hash is null/i);
  assert.match(release, /paddle-rage-public-booking-group:/i);
  assert.match(release, /paddle-rage-booking-hold-ref:/i);
  assert.match(release, /paddle-rage-receipt-verification-lease:/i);
  assert.match(release, /pg_try_advisory_xact_lock/i);
  assert.match(release, /for update skip locked/i);
  assert.match(release, /array_length\(locked_refs, 1\)[\s\S]*?<> group_count/i);
  assert.match(release, /bool_and\([\s\S]*?customer_access_token_hash = token_hash[\s\S]*?is_evidence_free_booking_hold\(booking\)/i);
  assert.ok(
    (release.match(/bool_and\(\s*coalesce\(/gi) || []).length >= 3,
    'every authorization mode must make NULL row predicates fail closed'
  );
  assert.match(release, /booking_hold_group_has_no_durable_evidence\(group_refs, group_key\)/i);
  assert.match(release, /delete from public\.bookings booking where booking\.ref = any\(group_refs\)/i);
  assert.match(release, /delete from public\.deleted_booking_archive[\s\S]*?archive\.source = 'trigger'[\s\S]*?archive\.deleted_at = cleanup_tx_started/i);
  assert.match(cleanupMigration, /grant execute on function public\.release_public_booking_hold\(text, text\)\s+to anon, authenticated/i);
  assert.match(dataLayer, /async releaseBookingHold\(ref\)[\s\S]*?const accessToken[\s\S]*?rpc\('release_public_booking_hold'/i);
  assert.match(dataLayer, /p_access_token:\s*accessToken \|\| null/i);
  const releaseDataLayer = dataLayer.match(/async releaseBookingHold\(ref\)[\s\S]*?\n  },/i)?.[0] || '';
  assert.doesNotMatch(releaseDataLayer, /isMissingRpcFunctionError|updateBooking\(/i);
  assert.match(dataLayer, /_pbForgetBookingAccessTokenFamily\(accessToken\)/i);
  assert.match(dataLayer, /const rows = batch\.map\(bookingToRow\)[\s\S]*?\.insert\(rows\)/i);
  assert.match(publicPage, /function releaseBookingHoldRef\(ref\)[\s\S]*?DB\.releaseBookingHold[\s\S]*?DB\.updateBooking/);
  assert.match(publicPage, /startSlotCountdown\(reservationSecondsLeft\(reserveStartedAt\)\)/);
  assert.match(publicPage, /saved reservation expired after 15 minutes[\s\S]*?slots were released/i);
});

test('Book Now shows a three-second non-confirmation countdown before revealing details', () => {
  const introStart = publicPage.indexOf('<div class="booking-intro" id="bookingIntro"');
  const introEnd = publicPage.indexOf('<div class="booking-countdown-announcer"', introStart);
  assert.ok(introStart >= 0 && introEnd > introStart, 'booking intro markup must exist');
  const introMarkup = publicPage.slice(introStart, introEnd);
  assert.match(introMarkup, /Complete your booking/i);
  assert.match(introMarkup, /booking is not confirmed/i);
  assert.doesNotMatch(introMarkup, /\bheld\b|\breserved\b|Continue/i);

  assert.match(publicPage, /const RESERVATION_INTRO_MS = 3000;/);
  assert.match(publicPage, /const RESERVATION_INTRO_EXIT_MS = 540;/);
  const introLogic = publicPage.match(/function hideBookingIntro[\s\S]*?function cancelReservedBookings/)?.[0] || '';
  assert.match(introLogic, /RESERVATION_INTRO_MS - RESERVATION_INTRO_EXIT_MS[\s\S]*?setTimeout\(\(\) => finishBookingIntro\(token\), introPauseMs\)/);
  assert.match(introLogic, /reducedMotion \? 0 : RESERVATION_INTRO_EXIT_MS/);
  assert.match(introLogic, /booking-intro-exiting[\s\S]*?getBoundingClientRect[\s\S]*?timer\.animate/i);
  assert.match(introLogic, /setBookingIntroContentInert\(true\)/);
  assert.match(introLogic, /prefers-reduced-motion:\s*reduce/i);

  const launchStart = publicPage.indexOf('async function proceedToBook(courtId = null)');
  const launchEnd = publicPage.indexOf('function closeBookModal', launchStart);
  const launch = launchStart >= 0 && launchEnd > launchStart
    ? publicPage.slice(launchStart, launchEnd)
    : '';
  assert.match(launch, /if \(_bookingLaunchInFlight\) return;/);
  assert.match(launch, /setBookingLaunchInFlight\(true\)/);
  assert.match(launch, /await DB\.addBookings\(reserveRows\)[\s\S]*?startSlotCountdown[\s\S]*?showBookingIntro\(\)/);
  assert.match(launch, /finally[\s\S]*?setBookingLaunchInFlight\(false\)/);

  const countdownStart = publicPage.indexOf('function startSlotCountdown');
  const countdownEnd = publicPage.indexOf('function stopSlotCountdown', countdownStart);
  const countdown = countdownStart >= 0 && countdownEnd > countdownStart
    ? publicPage.slice(countdownStart, countdownEnd)
    : '';
  assert.match(countdown, /deadlineMs[\s\S]*?Date\.now\(\)/);
  assert.match(countdown, /bookingIntroTimer/);
  assert.doesNotMatch(countdown, /secsLeft--/);
});

test('expired placeholder cleanup is recurring and fails closed around evidence', () => {
  const rowGuard = cleanupMigration.match(
    /create or replace function public\.is_evidence_free_booking_hold[\s\S]*?\n\$\$;/i
  )?.[0] || '';
  const durableGuard = cleanupMigration.match(
    /create or replace function public\.booking_hold_group_has_no_durable_evidence[\s\S]*?\n\$\$;/i
  )?.[0] || '';
  const purge = cleanupMigration.match(
    /create or replace function public\.purge_expired_booking_holds\(\)[\s\S]*?\n\$\$;/i
  )?.[0] || '';
  assert.match(rowGuard, /reserve@hold\.internal[\s\S]*?reserving\.\.\.[\s\S]*?reserving…[\s\S]*?00000000000/i);
  for (const field of [
    'payment_session_id', 'payment_checkout_url', 'paid_at', 'downpayment',
    'receipt_image_url', 'receipt_image_hash', 'receipt_phash', 'receipt_status',
    'receipt_flags', 'receipt_extracted', 'receipt_confidence', 'receipt_verified_at',
    'booking_fee_earned_at', 'billed_at', 'confirmation_email_sent_at'
  ]) assert.match(rowGuard, new RegExp(field, 'i'));
  assert.match(
    rowGuard,
    /created_via[\s\S]*?= 'customer'[\s\S]*?not coalesce\([\s\S]*?host_booking[\s\S]*?downpayment = \(p_booking\)\.total[\s\S]*?customer_access_token_hash is null[\s\S]*?\^\[0-9a-f\]\{64\}\$/i,
    'customer placeholders must match the server-normalized authoritative total and a canonical optional bearer hash'
  );
  assert.match(rowGuard, /select coalesce\([\s\S]*?,\s*false\s*\)\s*\$\$/i);
  assert.match(
    rowGuard,
    /created_via[\s\S]*?= 'host'[\s\S]*?coalesce\([\s\S]*?host_booking[\s\S]*?host_user_id[\s\S]*?created_by_user_id[\s\S]*?customer_access_token_hash is null[\s\S]*?downpayment is null/i,
    'host placeholders must still have no finalized payment amount'
  );
  assert.match(rowGuard, /receipt_status[\s\S]*?= 'none'[\s\S]*?status = 'cancelled'[\s\S]*?payment_status = 'rejected'[\s\S]*?receipt_status[\s\S]*?= 'rejected'/i);
  for (const table of [
    'receipt_verifications', 'used_gcash_refs', 'payment_sessions',
    'receipt_verification_leases', 'payment_review_decisions',
    'host_booking_balance_payments', 'booking_fee_remittance_items'
  ]) assert.match(durableGuard, new RegExp(`public\\.${table}`, 'i'));
  assert.match(purge, /cutoff timestamptz := clock_timestamp\(\) - interval '30 minutes'/i);
  assert.match(purge, /limit 500/i);
  assert.match(purge, /is_evidence_free_booking_hold\(booking\)/i);
  assert.match(purge, /booking_hold_group_has_no_durable_evidence/i);
  assert.match(purge, /array_length\(locked_refs, 1\)[\s\S]*?<> group_count/i);
  assert.match(purge, /for update skip locked/i);
  assert.match(purge, /pg_try_advisory_xact_lock[\s\S]*?paddle-rage-public-booking-group:/i);
  assert.match(purge, /paddle-rage-receipt-verification-lease:/i);
  assert.match(purge, /delete from public\.deleted_booking_archive[\s\S]*?archive\.source = 'trigger'[\s\S]*?archive\.deleted_at = cleanup_tx_started/i);
  assert.match(cleanupMigration, /create trigger a00_lock_receipt_verification_lease_key[\s\S]*?before insert or update on public\.receipt_verification_leases/i);
  assert.match(durableGuard, /receipt_verification_leases[\s\S]*?lease_expires_at > now\(\)/i);
  const expiredLeaseDeletes = cleanupMigration.match(/delete from public\.receipt_verification_leases lease[\s\S]*?lease\.lease_expires_at <= clock_timestamp\(\)/gi) || [];
  assert.equal(expiredLeaseDeletes.length, 2, 'release and purge must remove expired coordination-only leases under the mutex');
  const canonicalGroupLockUses = cleanupMigration.match(/paddle-rage-public-booking-group:/g) || [];
  assert.equal(canonicalGroupLockUses.length, 2, 'release and purge must share the canonical public group mutex');
  assert.match(cleanupMigration, /'cleanup-expired-booking-holds'[\s\S]*?'\*\/5 \* \* \* \*'/i);
  assert.match(cleanupMigration, /select public\.purge_expired_booking_holds\(\);/i);
  assert.doesNotMatch(adminPage, /cleanupAbandonedHolds|purge old abandoned slot-holds/i);
});
