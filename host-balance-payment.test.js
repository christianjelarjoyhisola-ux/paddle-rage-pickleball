const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const balancePayment = require('./host-balance-payment.js');

const eligibleBooking = {
  ref: 'PB-HOST-001',
  hostBooking: true,
  status: 'confirmed',
  paymentStatus: 'downpayment_paid',
  total: 1000,
  downpayment: 250,
  balanceDueAt: '2026-09-10T23:59:59.999+08:00',
};

test('offers balance payment only for a confirmed paid-down host booking before its deadline', () => {
  const result = balancePayment.eligibility(
    eligibleBooking,
    new Date('2026-09-09T09:59:00+08:00'),
  );
  assert.equal(result.eligible, true);
  assert.equal(result.balance, 750);
  assert.equal(result.bookingKey, 'PB-HOST-001');
  assert.equal(result.bookingRef, 'PB-HOST-001');
});

test('does not offer balance payment while the deposit is unresolved', () => {
  for (const pending of [
    { status: 'pending', paymentStatus: 'for_verification' },
    { status: 'verifying', paymentStatus: 'unpaid' },
  ]) {
    const result = balancePayment.eligibility(
      { ...eligibleBooking, ...pending },
      new Date('2026-09-09T09:59:00+08:00'),
    );
    assert.equal(result.eligible, false);
  }
});

test('does not offer balance payment at the deadline, after forfeiture, or after settlement', () => {
  const overdue = balancePayment.eligibility(
    eligibleBooking,
    new Date('2026-09-10T23:59:59.999+08:00'),
  );
  assert.equal(overdue.eligible, false);
  assert.equal(overdue.reason, 'deadline_passed');

  const forfeited = balancePayment.eligibility({
    ...eligibleBooking,
    status: 'forfeited',
    paymentStatus: 'deposit_retained',
  }, new Date('2026-09-09T09:59:00+08:00'));
  assert.equal(forfeited.eligible, false);

  const settled = balancePayment.eligibility({
    ...eligibleBooking,
    paymentStatus: 'paid',
    downpayment: 1000,
  }, new Date('2026-09-09T09:59:00+08:00'));
  assert.equal(settled.eligible, false);
});

test('fallback deadline is 11:59 PM Philippine time on the fifth calendar day', () => {
  const booking = {
    ref: 'PB-HOST-EOD',
    date: '2026-09-15',
    startTime: '3:00 PM',
    hostBooking: true,
    status: 'confirmed',
    paymentStatus: 'downpayment_paid',
    total: 1000,
    downpayment: 250,
  };
  assert.equal(
    balancePayment.balanceDeadline(booking).toISOString(),
    '2026-09-10T15:59:59.999Z',
  );
  assert.equal(
    balancePayment.eligibility(booking, new Date('2026-09-10T15:01:00Z')).eligible,
    true,
  );
});

test('resolves grouped booking keys while retaining a real child ref for server lookup', () => {
  const grouped = {
    ...eligibleBooking,
    ref: 'PB-HOST-GROUP-001',
    displayRef: 'PB-HOST-GROUP-001',
    groupRef: 'PB-HOST-GROUP-001',
    total: 2000,
    downpayment: 500,
    items: [
      { ...eligibleBooking, ref: 'PB-HOST-001-A', groupRef: 'PB-HOST-GROUP-001' },
      { ...eligibleBooking, ref: 'PB-HOST-001-B', groupRef: 'PB-HOST-GROUP-001' },
    ],
  };

  assert.equal(balancePayment.bookingKey(grouped), 'PB-HOST-GROUP-001');
  assert.equal(balancePayment.primaryBookingRef(grouped), 'PB-HOST-001-A');
  assert.equal(balancePayment.bookingMatchesKey(grouped, 'PB-HOST-001-B'), true);
  assert.deepEqual(balancePayment.buildQuotePayload(grouped), {
    action: 'quote',
    bookingRef: 'PB-HOST-GROUP-001',
  });
  assert.deepEqual(balancePayment.buildCreatePayload({
    bookingKey: 'PB-HOST-GROUP-001',
  }, 'paddle-idempotency-001', {
    paymentMethod: 'gcash',
    paymentReference: '1234567890123',
  }), {
    action: 'create',
    bookingKey: 'PB-HOST-GROUP-001',
    bookingRef: 'PB-HOST-GROUP-001',
    idempotencyKey: 'paddle-idempotency-001',
    paymentProvider: 'gcash',
    provider: 'gcash',
    paymentReference: '1234567890123',
  });

  const groupEligibility = balancePayment.eligibility(
    grouped,
    new Date('2026-09-09T09:59:00+08:00'),
  );
  assert.equal(groupEligibility.eligible, true);
  assert.equal(groupEligibility.balance, 1500);

  assert.equal(balancePayment.eligibility({
    ...grouped,
    items: [grouped.items[0], { ...grouped.items[1], paymentStatus: 'paid' }],
  }, new Date('2026-09-09T09:59:00+08:00')).eligible, false);
});

test('builds exact-balance verification data without copying deposit evidence', () => {
  const quote = balancePayment.normalizeQuote({
    paymentId: '0b08bdf9-8ab9-4ad6-b75e-171c877ca428',
    verificationRef: 'HBAL-0123456789ABCDEF0123456789ABCDEF',
    balance: 750,
    bookingKey: 'PB-HOST-001',
    bookingRef: 'PB-HOST-001',
    verificationBookingData: {
      verification_context: 'host_booking_balance',
      balance_payment_id: '0b08bdf9-8ab9-4ad6-b75e-171c877ca428',
      booking_ref: 'PB-HOST-001',
      booking_group_ref: null,
      full_name: 'Host Name',
      total: 750,
      downpayment: 750,
      created_at: '2026-09-01T10:00:00Z',
      payment_method: 'gcash',
      gcash_ref: '1234567890123',
    },
  }, eligibleBooking);
  const payload = balancePayment.buildVerificationBookingData(quote);

  assert.equal(payload.total, 750);
  assert.equal(payload.downpayment, 750);
  assert.equal(payload.gcash_ref, '1234567890123');
  assert.equal(payload.verification_context, 'host_booking_balance');
  assert.equal(
    payload.balance_payment_id,
    '0b08bdf9-8ab9-4ad6-b75e-171c877ca428',
  );
  assert.equal(Object.hasOwn(payload, 'receiptImageUrl'), false);
  assert.equal(Object.hasOwn(payload, 'receipt_image_url'), false);
  assert.equal(JSON.stringify(payload).includes('OLD-DEPOSIT-REF'), false);
  assert.equal(balancePayment.buildVerificationBookingData({
    ...quote,
    verificationBookingData: null,
  }), null);
});

test('rejects verification data whose server-locked payment id or amount changed', () => {
  const bad = {
    paymentId: '0b08bdf9-8ab9-4ad6-b75e-171c877ca428',
    amount: 750,
    verificationBookingData: {
      verification_context: 'host_booking_balance',
      balance_payment_id: '8de85d77-365d-40ed-85de-af34ec862032',
      total: 700,
      downpayment: 700,
    },
  };
  assert.throws(
    () => balancePayment.buildVerificationBookingData(bad),
    /do not match this payment/i,
  );
});

test('builds submit payload and normalizes approved, pending, and rejected states', () => {
  const quote = {
    paymentId: '0b08bdf9-8ab9-4ad6-b75e-171c877ca428',
    bookingKey: 'PB-HOST-GROUP-001',
  };
  assert.deepEqual(balancePayment.buildSubmitPayload(quote, {
    receiptVerificationId: 42,
  }), {
    action: 'submit',
    paymentId: '0b08bdf9-8ab9-4ad6-b75e-171c877ca428',
    receiptVerificationId: 42,
  });
  assert.equal(balancePayment.statusState({ paymentStatus: 'paid' }), 'approved');
  assert.equal(balancePayment.statusState({ status: 'manual_review' }), 'pending');
  assert.equal(balancePayment.statusState({ receipt_status: 'rejected' }), 'rejected');
});

test('normalizes camel and snake quote fields together with a current grouped attempt', () => {
  const normalized = balancePayment.normalizeQuote({
    quote: {
      booking_key: 'PB-HOST-GROUP-001',
      booking_group_ref: 'PB-HOST-GROUP-001',
      balance_amount: 1500,
      balance_due_at: '2026-09-10T15:59:59.999Z',
      booking_date: '2026-09-15',
      court_label: 'Court 1, Court 2',
      schedule_label: '8:00 AM - 10:00 AM',
      customer_name: 'Host Name',
    },
    current_attempt: {
      id: '0b08bdf9-8ab9-4ad6-b75e-171c877ca428',
      verification_ref: 'HBAL-0123456789ABCDEF0123456789ABCDEF',
      expected_amount: 1500,
      payment_provider: 'gcash',
      payment_reference: '1234567890123',
      status: 'submitted',
    },
  }, eligibleBooking);

  assert.equal(normalized.bookingKey, 'PB-HOST-GROUP-001');
  assert.equal(normalized.groupRef, 'PB-HOST-GROUP-001');
  assert.equal(normalized.balance, 1500);
  assert.equal(normalized.paymentProvider, 'gcash');
  assert.equal(normalized.paymentReference, '1234567890123');
  assert.equal(balancePayment.statusState({ current_attempt: { status: 'submitted' } }), 'pending');
});

test('invokes the dedicated authenticated balance endpoint', async () => {
  const calls = [];
  const response = await balancePayment.invoke({
    functions: {
      async invoke(name, options) {
        calls.push({ name, options });
        return { data: { ok: true, quote: { balanceAmount: 750 } }, error: null };
      },
    },
  }, { action: 'quote', bookingRef: 'PB-HOST-001' });

  assert.equal(balancePayment.FUNCTION_NAME, 'host-booking-balance-payment');
  assert.deepEqual(calls, [{
    name: 'host-booking-balance-payment',
    options: {
      body: { action: 'quote', bookingRef: 'PB-HOST-001' },
    },
  }]);
  assert.equal(response.quote.balanceAmount, 750);
});

test('surfaces the Edge Function response instead of a generic non-2xx error', async () => {
  await assert.rejects(
    balancePayment.invoke({
      functions: {
        async invoke() {
          return {
            data: null,
            error: {
              message: 'Edge Function returned a non-2xx status code',
              context: {
                async json() {
                  return { error: 'The receipt was submitted after the balance deadline.' };
                },
              },
            },
          };
        },
      },
    }, { action: 'submit' }),
    /submitted after the balance deadline/,
  );
});

test('uses Paddle payment providers and contains no Korte or Resend coupling', () => {
  const edge = fs.readFileSync(
    'supabase/functions/host-booking-balance-payment/index.ts',
    'utf8',
  );
  const providerBlock = edge.match(/const ALLOWED_PROVIDERS\s*=\s*new Set\(\[[\s\S]*?\]\)/)?.[0] || '';
  for (const provider of ['gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb']) {
    assert.match(providerBlock, new RegExp(`["']${provider}["']`));
  }
  assert.doesNotMatch(providerBlock, /maribank/i);
  assert.doesNotMatch(edge, /Korte\s*DOS|kortedoscdo|RESEND_API_KEY/i);
});

test('serves every coupled host balance asset versioned and no-store', () => {
  const indexHtml = fs.readFileSync('index.html', 'utf8');
  const adminHtml = fs.readFileSync('admin.html', 'utf8');
  const headers = fs.readFileSync('_headers', 'utf8');
  const worker = fs.readFileSync('_worker.js', 'utf8');

  const indexPayment = indexHtml.match(/host-balance-payment\.js\?v=[^"']+/)?.[0] || '';
  const adminPayment = adminHtml.match(/host-balance-payment\.js\?v=[^"']+/)?.[0] || '';
  assert.ok(indexPayment, 'index.html must load a versioned host balance runtime');
  assert.equal(adminPayment, indexPayment, 'public and admin pages must load the same balance runtime');
  assert.match(adminHtml, /host-balance-admin\.js\?v=[^"']+/);
  assert.match(indexHtml, /booking-balance\.js\?v=[^"']+/);
  assert.match(adminHtml, /booking-balance\.js\?v=[^"']+/);

  assert.match(
    headers,
    /\/host-balance-payment\.js[\s\S]*?Cache-Control:\s*no-store, max-age=0/i,
  );
  assert.match(
    headers,
    /\/host-balance-admin\.js[\s\S]*?Cache-Control:\s*no-store, max-age=0/i,
  );
  assert.match(worker, /["']\/host-balance-payment\.js["']/);
  assert.match(worker, /["']\/host-balance-admin\.js["']/);
  assert.match(worker, /Cache-Control["'],\s*["']no-store, max-age=0/);
});
