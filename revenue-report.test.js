const test = require('node:test');
const assert = require('node:assert/strict');
const RevenueReport = require('./finance-core');

const settings = { maintenance_fee: '5', fee_type: 'per_hour' };
const range = { from: '2026-07-01', to: '2026-07-31' };

function booking(overrides = {}) {
  return {
    ref: 'PR-001',
    courtName: 'Court 1',
    date: '2026-07-24',
    duration: 1,
    total: 205,
    downpayment: 105,
    status: 'confirmed',
    paymentStatus: 'paid',
    paymentMethod: 'gcash',
    receivedAccount: 'gcash',
    paidAt: '2026-07-20T03:00:00Z',
    createdAt: '2026-07-19T03:00:00Z',
    bookingFeeAmountSnapshot: 5,
    bookingFeeEarnedAt: '2026-07-20T03:00:00Z',
    ...overrides,
  };
}

test('separates fully paid court rental from the system-owner booking fee', () => {
  const report = RevenueReport.build({ transactions: [booking()], settings, range, basis: 'payment' });
  assert.equal(report.summary.customerCharges, 205);
  assert.equal(report.summary.collected, 205);
  assert.equal(report.summary.outstanding, 0);
  assert.equal(report.summary.courtRental, 200);
  assert.equal(report.summary.courtCollected, 200);
  assert.equal(report.summary.platformFeesEarned, 5);
});

test('counts the full booking fee in a downpayment and leaves only court balance outstanding', () => {
  const report = RevenueReport.build({
    transactions: [booking({ paymentStatus: 'downpayment_paid' })],
    settings, range, basis: 'payment',
  });
  assert.equal(report.summary.collected, 105);
  assert.equal(report.summary.courtCollected, 100);
  assert.equal(report.summary.platformFeesEarned, 5);
  assert.equal(report.summary.outstanding, 100);
  assert.equal(report.summary.downpayments, 105);
});

test('treats a forfeited deposit as collected with no collectible balance', () => {
  const report = RevenueReport.build({
    transactions: [booking({ status: 'forfeited', paymentStatus: 'deposit_retained' })],
    settings, range, basis: 'payment',
  });
  assert.equal(report.summary.customerCharges, 105);
  assert.equal(report.summary.collected, 105);
  assert.equal(report.summary.outstanding, 0);
  assert.equal(report.summary.forfeitedDeposits, 105);
  assert.equal(report.summary.courtRental, 100);
  assert.equal(report.summary.platformFeesEarned, 5);
  assert.equal(report.summary.bookingCount, 0);
});

test('includes direct venue Open Play without treating pending registrations as collected', () => {
  const openPlay = [
    { id: 1, court_name: 'Court 1', date: '2026-07-21', amount: 100, payment_status: 'paid', payment_method: 'cash', created_at: '2026-07-20T02:00:00Z' },
    { id: 2, court_name: 'Court 2', date: '2026-07-21', amount: 100, payment_status: 'pending', payment_method: 'gcash', created_at: '2026-07-20T02:00:00Z' },
  ];
  const report = RevenueReport.build({ openPlay, settings, range, basis: 'service' });
  assert.equal(report.summary.customerCharges, 200);
  assert.equal(report.summary.openPlayCharges, 200);
  assert.equal(report.summary.openPlayCollected, 100);
  assert.equal(report.summary.outstanding, 100);
  assert.equal(report.summary.openPlayCount, 2);
  assert.equal(report.summary.courtRental, 0);
  assert.equal(report.breakdowns.stream.reduce((sum, row) => sum + row.charges, 0), 200);
});

test('payment-date reports exclude transactions with no verified or recorded payment', () => {
  const unpaid = booking({ ref: 'PR-UNPAID', paymentStatus: 'unpaid', paidAt: null, bookingFeeEarnedAt: null });
  const report = RevenueReport.build({ transactions: [unpaid], settings, range, basis: 'payment' });
  assert.equal(report.summary.customerCharges, 0);
  assert.equal(report.rows.length, 0);
});

test('uses immutable fee snapshots for multi-court transactions', () => {
  const first = booking({ ref: 'PR-G-1', courtName: 'Court 1', total: 205, bookingFeeAmountSnapshot: 5 });
  const second = booking({ ref: 'PR-G-2', courtName: 'Court 2', total: 310, duration: 2, bookingFeeAmountSnapshot: 10 });
  const transaction = {
    ...first,
    total: 515,
    duration: 3,
    items: [first, second],
  };
  const report = RevenueReport.build({ transactions: [transaction], settings, range, basis: 'payment' });
  assert.equal(report.summary.platformFeesEarned, 15);
  assert.equal(report.summary.courtRental, 500);
  assert.equal(report.summary.bookedHours, 3);
  assert.deepEqual(report.breakdowns.court.map(row => [row.label, row.charges]), [['Court 2', 300], ['Court 1', 200]]);
});
