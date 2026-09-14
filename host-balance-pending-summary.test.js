const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('host-balance-admin.js', 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness({ role = 'owner', local = false, pending = () => ({ payments: [] }) } = {}) {
  let currentRole = role;
  const events = [];
  const calls = [];
  const evidenceQuery = {
    select() { return this; },
    order() { return this; },
    range() { return Promise.resolve({ data: [], error: null }); },
  };
  const window = {
    Auth: { getSession: () => ({ role: currentRole }) },
    PB_USE_LOCAL_DATA: local,
    _supabase: { functions: { invoke() {} }, from: () => evidenceQuery },
    HostBalancePayment: {
      normalizeAttempt: row => row,
      invoke: async (_client, payload) => {
        calls.push(payload);
        return pending(payload);
      },
    },
    syncPaymentReviewPendingCount: () => {
      events.push(JSON.parse(JSON.stringify(window.HostBalanceAdmin.pendingSummary())));
    },
  };
  const document = {
    getElementById: id => ['hostBalanceAdminStyles', 'hostBalanceReviewModal'].includes(id) ? {} : null,
    createElement: () => ({}),
  };
  vm.runInNewContext(source, { window, document, console }, { filename: 'host-balance-admin.js' });
  return {
    api: window.HostBalanceAdmin,
    events,
    calls,
    setRole(value) { currentRole = value; },
    summary: () => JSON.parse(JSON.stringify(window.HostBalanceAdmin.pendingSummary())),
  };
}

test('counts pending payment IDs once across booking groups and paginated responses', async () => {
  const h = harness({ pending: ({ offset }) => offset === 0 ? {
    payments: [
      { paymentId: ' p1 ', status: 'pending_review', bookingRefs: ['A', 'B', 'C'] },
      { payment_id: 'p2', status: 'pending_review', bookingGroupRef: 'GROUP-A' },
      { id: 'p3', status: 'PENDING_REVIEW', bookingGroupRef: 'GROUP-A' },
      { paymentId: 'approved', status: 'approved' },
      { paymentId: 'rejected', status: 'rejected' },
      { paymentId: '   ', status: 'pending_review' },
      { status: 'pending_review', bookingRef: 'NOT-A-PAYMENT-ID' },
    ],
    nextOffset: 7,
  } : {
    payments: [{ paymentId: 'p1', status: 'pending_review', bookingRefs: ['D'] }],
  } });
  assert.equal(Object.isFrozen(h.api), true);
  assert.deepEqual(h.summary(), { status: 'idle', count: null });
  await h.api.load(false);
  assert.deepEqual(h.summary(), { status: 'ready', count: 3 });
  assert.deepEqual(
    Array.from(h.api.pendingPayments(), payment => String(payment.paymentId || payment.payment_id || payment.id || '').trim()),
    ['p1', 'p2', 'p3'],
  );
  assert.deepEqual(h.calls.map(call => call.offset), [0, 7]);
  assert.deepEqual(h.events, [{ status: 'loading', count: null }, { status: 'ready', count: 3 }]);
  await h.api.load(false);
  assert.equal(h.calls.length, 2, 'cached loading must not add counts or requests');
  assert.deepEqual(h.summary(), { status: 'ready', count: 3 });
  h.api.invalidate();
  assert.deepEqual(h.summary(), { status: 'idle', count: null });
  assert.deepEqual(h.events.at(-1), { status: 'idle', count: null });
});

test('publishes unknown after load failure and a real zero after recovery', async () => {
  let failed = true;
  const h = harness({ pending: () => {
    if (failed) throw new Error('Queue unavailable');
    return { payments: [] };
  } });
  await assert.rejects(h.api.load(false), /Queue unavailable/);
  assert.deepEqual(h.summary(), { status: 'error', count: null });
  assert.deepEqual(h.events, [{ status: 'loading', count: null }, { status: 'error', count: null }]);
  failed = false;
  await h.api.load(true);
  assert.deepEqual(h.summary(), { status: 'ready', count: 0 });
  assert.deepEqual(h.events.slice(-2), [{ status: 'loading', count: null }, { status: 'ready', count: 0 }]);
});

test('inaccessible and local queues publish the appropriate summary without network access', async () => {
  const denied = harness({ role: 'staff' });
  assert.deepEqual(denied.summary(), { status: 'forbidden', count: null });
  assert.deepEqual(Array.from(denied.api.pendingPayments()), []);
  await denied.api.render(true);
  assert.deepEqual(denied.events, [{ status: 'forbidden', count: null }]);
  assert.equal(denied.calls.length, 0);

  const local = harness({ role: 'court_owner', local: true });
  await local.api.load(false);
  assert.deepEqual(local.summary(), { status: 'ready', count: 0 });
  assert.deepEqual(local.events, [{ status: 'ready', count: 0 }]);
  assert.equal(local.calls.length, 0);
  local.setRole('host');
  assert.deepEqual(local.summary(), { status: 'forbidden', count: null });
  await local.api.load(false);
  assert.deepEqual(local.events.at(-1), { status: 'forbidden', count: null });
});

for (const outcome of ['success', 'failure']) {
  test(`ignores an invalidated in-flight ${outcome} and fetches the current queue`, async () => {
    const stale = deferred();
    let requests = 0;
    const h = harness({ pending: () => ++requests === 1 ? stale.promise : { payments: [] } });
    const loading = h.api.load(false);
    h.api.invalidate();
    assert.deepEqual(h.summary(), { status: 'loading', count: null });
    const refreshed = h.api.load(true);
    assert.equal(refreshed, loading, 'reuse the in-flight loader while its generation is invalidated');
    if (outcome === 'success') stale.resolve({ payments: [{ paymentId: 'already-reviewed', status: 'pending_review' }] });
    else stale.reject(new Error('Old failed request'));
    await refreshed;
    assert.equal(requests, 2);
    assert.deepEqual(h.summary(), { status: 'ready', count: 0 });
    assert.deepEqual(h.events, [
      { status: 'loading', count: null },
      { status: 'loading', count: null },
      { status: 'ready', count: 0 },
    ]);
  });
}

test('does not restore reviewer data when authorization is lost during a load', async () => {
  const response = deferred();
  const h = harness({ pending: () => response.promise });
  const loading = h.api.load(false);
  h.setRole('host');
  assert.deepEqual(h.summary(), { status: 'forbidden', count: null });
  response.resolve({ payments: [{ paymentId: 'private-payment', status: 'pending_review', bookingRef: 'PRIVATE' }] });
  await loading;
  assert.deepEqual(h.summary(), { status: 'forbidden', count: null });
  assert.equal(h.api.pendingForBooking('PRIVATE'), null);
  assert.deepEqual(h.events.at(-1), { status: 'forbidden', count: null });
});
