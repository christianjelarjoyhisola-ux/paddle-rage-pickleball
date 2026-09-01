const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const clientSource = fs.readFileSync(path.join(root, 'supabase-config.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const migrationSource = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901200000_platform_fee_ledger_safeguards.sql'),
  'utf8',
);
const FinanceCore = require('./finance-core.js');

function extractLocalSnapshot() {
  const start = clientSource.indexOf('const localBookingFeeSnapshot =');
  const end = clientSource.indexOf('const defaultAccounts', start);
  assert.ok(start >= 0 && end > start, 'local booking-fee snapshot helper must exist');
  return new Function(`${clientSource.slice(start, end)}; return localBookingFeeSnapshot;`)();
}

test('the approved policy is fixed at PHP 10 per booked court-hour', () => {
  assert.match(clientSource, /service_fee_rate:\s*'10'/);
  assert.match(clientSource, /maintenance_fee:\s*'10'/);
  assert.match(clientSource, /fee_type:\s*'per_hour'/);
  assert.match(migrationSource, /\('maintenance_fee',\s*'10',\s*now\(\)\)/i);
  assert.match(migrationSource, /\('fee_type',\s*'per_hour',\s*now\(\)\)/i);
  assert.match(migrationSource, /create or replace function public\.guard_fixed_booking_fee_policy\(\)/i);
  assert.match(migrationSource, /booking_fee_policy_history_rate_check\s+check\s*\(fee_rate = 10\)/i);
});

test('three courts booked for three hours create nine court-hours and PHP 90', () => {
  const snapshot = extractLocalSnapshot();
  const rows = ['Court 1', 'Court 2', 'Court 3'].map((courtName, index) => snapshot({
    ref: `TEST-${index + 1}`,
    courtName,
    slots: [8, 9, 10],
    total: 1050,
    paymentMethod: 'gcash',
  }, {
    maintenance_fee: '10',
    fee_type: 'per_hour',
  }));

  assert.equal(rows.reduce((sum, row) => sum + row.bookingFeeUnitsSnapshot, 0), 9);
  assert.equal(rows.reduce((sum, row) => sum + row.bookingFeeAmountSnapshot, 0), 90);
  assert.ok(rows.every(row => row.bookingFeeRateSnapshot === 10));
  assert.ok(rows.every(row => row.bookingFeeTypeSnapshot === 'per_hour'));
});

test('pending proof earns nothing and an accepted booking earns its allocation once', () => {
  const pending = {
    ref: 'PENDING-1',
    total: 1050,
    slots: [8, 9, 10],
    status: 'pending',
    paymentStatus: 'for_verification',
    bookingFeeAmountSnapshot: 30,
  };
  const accepted = {
    ...pending,
    status: 'confirmed',
    paymentStatus: 'downpayment_paid',
    bookingFeeEarnedAt: '2026-09-01T00:00:00.000Z',
  };

  assert.equal(FinanceCore.bookingFeeEarned(pending, { maintenance_fee: 10, fee_type: 'per_hour' }), 0);
  assert.equal(FinanceCore.bookingFeeEarned(accepted, { maintenance_fee: 10, fee_type: 'per_hour' }), 30);
  assert.match(
    clientSource,
    /next\.bookingFeeEarnedAt = booking\.bookingFeeEarnedAt\s*\|\| booking\.booking_fee_earned_at\s*\|\| confirmedAt/,
    'later payment stages must retain the first earned timestamp',
  );
  assert.match(migrationSource, /on conflict \(booking_ref\) where released_at is null do nothing/i);
});

test('the premium dashboard uses authoritative, non-overlapping ledger buckets', () => {
  assert.match(adminSource, /id="maintFeePanel"[^>]*data-perm="remittances"/);
  assert.match(adminSource, /DB\.getBookingFeeRemittanceDashboard\(\)/);
  assert.match(adminSource, /const reviewAmountRaw = reviewRows\.reduce\(\(sum, record\) => sum \+ rmAmountUnderReview\(record\), 0\)/);
  assert.match(adminSource, /const preparedAmount = Math\.max\(0, openAmount - reviewAmount\)/);
  assert.match(adminSource, /accepted_total/);
  assert.match(adminSource, /Rates locked per booking/);
  assert.doesNotMatch(adminSource, /id="maintRateInput"|id="saveMaintRate"|id="maintMonth"/);
});

test('the SQL ledger preserves audit history and excludes released rows from payable totals', () => {
  assert.match(migrationSource, /create table if not exists public\.booking_fee_adjustments/i);
  assert.match(migrationSource, /create table if not exists public\.booking_fee_adjustment_applications/i);
  assert.match(migrationSource, /prevent_booking_fee_adjustment_change/i);
  assert.match(migrationSource, /(?:where|and)\s+i\.released_at is null/i);
  assert.match(migrationSource, /(?:where|and)\s+a\.released_at is null/i);
  assert.match(migrationSource, /gross_booking_fee_amount/i);
  assert.match(migrationSource, /adjustment_amount/i);
  assert.match(migrationSource, /credit_carryforward/i);
  assert.match(migrationSource, /sum\(r\.amount_settled\)[\s\S]*?where r\.status <> 'cancelled'/i);
  assert.match(migrationSource, /booking_fee_adjustment_applications[\s\S]*?void_delete_booking_group/i);
  assert.match(migrationSource, /already used for a different platform-fee adjustment/i);
});
