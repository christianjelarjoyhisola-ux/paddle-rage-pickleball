const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const admin = fs.readFileSync('admin.html', 'utf8');
const hostBalanceAdmin = fs.readFileSync('host-balance-admin.js', 'utf8');
const balanceEdge = fs.readFileSync('supabase/functions/host-booking-balance-payment/index.ts', 'utf8');
const deadlineEdge = fs.readFileSync('supabase/functions/process-host-balance-deadlines/index.ts', 'utf8');
const visibilityMigration = fs.readFileSync(
  'supabase/migrations/20260831100000_host_balance_admin_visibility.sql',
  'utf8',
);

test('late-binds Payment Review so the host balance wrapper runs on navigation', () => {
  assert.match(admin, /payreview:\(\)=>renderPaymentReview\(\)/);
  assert.doesNotMatch(admin, /payreview:renderPaymentReview(?:[,}])/);
  assert.match(
    hostBalanceAdmin,
    /global\.renderPaymentReview\s*=\s*async function wrappedPaymentReview\(\)[\s\S]*?await render\(false\)/,
  );
});

test('loads pending host balances into Bookings and exposes one-tap review', () => {
  assert.match(admin, /HostBalanceAdmin\?\.load\?\.\(false\)/);
  assert.match(admin, /function hostBalancePendingBadge\(b\)/);
  assert.match(admin, /Balance receipt pending/);
  assert.match(admin, /function hostBalanceReviewButton\(b\)/);
  assert.match(admin, /reviewHostBalanceForBooking\('\$\{jsArg\(actionRef\)\}',this\)/);
  assert.match(admin, /const balanceReviewLocked = hasBalance && balanceReviewState !== 'clear'/);
  assert.match(admin, /const canRecordManualPayment = hasBalance && !balanceReviewLocked/);
  assert.match(hostBalanceAdmin, /function pendingForBooking\(booking\)/);
  assert.match(hostBalanceAdmin, /function statusForBooking\(booking\)/);
  assert.match(hostBalanceAdmin, /async function reviewForBooking\(booking, trigger\)/);
  assert.match(hostBalanceAdmin, /pendingForBooking,[\s\S]*?reviewForBooking,/);
});

test('paginates the complete pending queue and fails closed when it is unavailable', () => {
  assert.match(hostBalanceAdmin, /apiCall\('list_pending', \{ limit: 100, offset \}\)/);
  assert.match(hostBalanceAdmin, /state\.loadState = 'error'/);
  assert.match(hostBalanceAdmin, /state\.loadState === 'ready' \? 'clear' : 'unknown'/);
  assert.match(balanceEdge, /const offset = Number\.isSafeInteger\(requestedOffset\)/);
  assert.match(balanceEdge, /\.range\(offset, offset \+ limit - 1\)/);
  assert.match(balanceEdge, /nextOffset: payments\.length === limit/);
  assert.match(admin, /Balance review unavailable/);
  assert.match(admin, /balanceReviewLocked\?'disabled title="Resolve the pending balance review first"'/);
  assert.match(admin, /canDelete && !forfeited && !balanceReviewLocked/);
});

test('refreshes balance indicators in realtime without changing canonical booking payment state', () => {
  assert.match(admin, /table:'host_booking_balance_payments'\},rerenderHostBalances/);
  assert.match(admin, /HostBalanceAdmin\?\.invalidate\?\.\(\)/);
  assert.match(hostBalanceAdmin, /function invalidate\(\)\s*{\s*state\.generation \+= 1;\s*state\.loadedAt = 0;/);
  assert.match(visibilityMigration, /alter publication supabase_realtime[\s\S]*?add table public\.host_booking_balance_payments/);
  assert.doesNotMatch(admin, /Balance receipt pending[\s\S]{0,200}updatePaymentStatus/);
});

test('blocks conflicting booking mutations and reminders during pending review', () => {
  assert.match(admin, /historicalBalance > 0 && balanceReviewState === 'clear'/);
  assert.match(admin, /A balance receipt is already awaiting owner review/);
  assert.match(deadlineEdge, /loadPendingBalancePayments\(db\)/);
  assert.match(deadlineEdge, /groupHasPendingBalance\(rows, pendingPayments\)/);
  assert.match(deadlineEdge, /Balance receipt pending owner review/);
  assert.match(visibilityMigration, /create or replace function public\.protect_pending_host_balance_booking\(\)/);
  assert.match(visibilityMigration, /before update or delete on public\.bookings/);
  assert.match(visibilityMigration, /payment\.status = 'pending_review'/);
  assert.match(visibilityMigration, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(visibilityMigration, /old\.duration is distinct from new\.duration/);
  assert.match(visibilityMigration, /old\.slots is distinct from new\.slots/);
  assert.match(
    visibilityMigration,
    /create or replace function public\.claim_booking_balance_notification[\s\S]*?for update;[\s\S]*?'balance_pending_review'/,
  );
  assert.match(visibilityMigration, /payment\.status = 'approved'/);
  assert.match(visibilityMigration, /'balance_already_paid'/);
  assert.match(visibilityMigration, /'booking_not_payable'/);
  assert.match(visibilityMigration, /booking\.status = 'confirmed'/);
  assert.match(visibilityMigration, /booking\.payment_status = 'downpayment_paid'/);
  assert.match(deadlineEdge, /claim\.reason === "balance_pending_review"/);
});

test('invalidates a stale Admin shell when another account replaces its session', () => {
  assert.match(admin, /function startAdminSessionGuard\(\)/);
  assert.match(admin, /event\.key!=='pb_session'/);
  assert.match(admin, /_supabase\.auth\.onAuthStateChange/);
  assert.match(admin, /nextUserId!==bootUserId/);
  assert.match(admin, /invalidateStaleAdminSession\(\)/);
  assert.match(admin, /startAdminSessionGuard\(\);/);
});
