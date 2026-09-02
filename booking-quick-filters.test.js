const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminSource = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

function bookingQuickFilterHelpers() {
  const placeholderStart = adminSource.indexOf('function isPlaceholderHold');
  const placeholderEnd = adminSource.indexOf('function isCancelledBooking', placeholderStart);
  const start = adminSource.indexOf("const BOOKING_TYPE_VIEWS =");
  const end = adminSource.indexOf('function setBookingQuickCount', start);
  assert.ok(placeholderStart >= 0 && placeholderEnd > placeholderStart, 'placeholder helpers must exist');
  assert.ok(start >= 0 && end > start, 'booking quick-filter helpers must exist');
  return new Function(`${adminSource.slice(placeholderStart, placeholderEnd)}; ${adminSource.slice(start, end)}; return {
    isPlaceholderHold,
    isFreshPlaceholderHold,
    bookingQuickGroupItems,
    bookingGroupIsHost,
    bookingQuickStatusKey,
    bookingMatchesQuickStatus,
    bookingMatchesQuickType,
    bookingGroupMatchesFormFilters,
  };`)();
}

const helpers = bookingQuickFilterHelpers();

function grouped(...items) {
  return {
    ...items[0],
    allItems: items,
    items,
    hostBooking: items.some(item => item.hostBooking || item.host_booking),
  };
}

test('reservation status chips classify every supported lifecycle without auto-rejecting receipt evidence', () => {
  const cases = [
    ['pending', grouped({ status: 'pending', paymentStatus: 'unpaid' }), 'pending'],
    ['processing', grouped({ status: 'verifying', paymentStatus: 'for_verification' }), 'pending'],
    ['confirmed', grouped({ status: 'confirmed', paymentStatus: 'downpayment_paid' }), 'confirmed'],
    ['completed', grouped({ status: 'completed', paymentStatus: 'paid' }), 'completed'],
    ['cancelled', grouped({ status: 'cancelled', paymentStatus: 'unpaid' }), 'closed'],
    ['forfeited', grouped({ status: 'forfeited', paymentStatus: 'deposit_retained' }), 'closed'],
    ['rejected initial payment', grouped({ status: 'pending', paymentStatus: 'rejected' }), 'closed'],
    ['failed initial payment', grouped({ status: 'pending', paymentStatus: 'failed' }), 'closed'],
    [
      'rejected receipt evidence alone',
      grouped({ status: 'confirmed', paymentStatus: 'for_verification', receiptStatus: 'rejected' }),
      'confirmed',
    ],
  ];

  for (const [label, booking, expected] of cases) {
    assert.equal(helpers.bookingQuickStatusKey(booking), expected, label);
  }
});

test('terminal booking state wins for an inconsistent multi-court group', () => {
  const booking = grouped(
    { ref: 'GROUP-1-A', status: 'confirmed', paymentStatus: 'paid' },
    { ref: 'GROUP-1-B', status: 'cancelled', paymentStatus: 'paid' },
    { ref: 'GROUP-1-C', status: 'confirmed', paymentStatus: 'paid' },
  );

  assert.equal(helpers.bookingQuickStatusKey(booking), 'closed');
  assert.equal(helpers.bookingMatchesQuickStatus(booking, 'closed'), true);
  assert.equal(helpers.bookingMatchesQuickStatus(booking, 'confirmed'), false);
});

test('host booking detection supports current and legacy records', () => {
  const direct = grouped({ status: 'confirmed', hostBooking: true });
  const legacy = grouped({ status: 'confirmed', created_via: 'HOST' });
  const childLegacy = { items: [{ status: 'confirmed', host_booking: true }] };
  const court = grouped({ status: 'confirmed', createdVia: 'customer' });

  assert.equal(helpers.bookingMatchesQuickType(direct, 'host'), true);
  assert.equal(helpers.bookingMatchesQuickType(legacy, 'host'), true);
  assert.equal(helpers.bookingMatchesQuickType(childLegacy, 'host'), true);
  assert.equal(helpers.bookingMatchesQuickType(court, 'court'), true);
  assert.equal(helpers.bookingMatchesQuickType(court, 'host'), false);
});

test('search, date, and payment filters match the complete grouped reservation', () => {
  const booking = grouped(
    {
      ref: 'GROUP-A', groupRef: 'PB-GROUP', fullName: 'Chris', email: 'chris@example.com',
      courtName: 'Court 1', date: '2026-09-19', paymentStatus: 'paid',
    },
    {
      ref: 'GROUP-B', groupRef: 'PB-GROUP', fullName: 'Chris', email: 'chris@example.com',
      courtName: 'Court 2', date: '2026-09-20', paymentStatus: 'for_verification',
    },
  );

  assert.equal(helpers.bookingGroupMatchesFormFilters(booking, { q: 'court 2' }), true);
  assert.equal(helpers.bookingGroupMatchesFormFilters(booking, { q: 'group-b' }), true);
  assert.equal(helpers.bookingGroupMatchesFormFilters(booking, { fd: '2026-09-20' }), true);
  assert.equal(helpers.bookingGroupMatchesFormFilters(booking, { fp: 'for_verification' }), true);
  assert.equal(helpers.bookingGroupMatchesFormFilters(booking, { q: 'missing' }), false);
});

test('Bookings exposes premium independent type and status controls accessibly', () => {
  assert.match(adminSource, /id="bookingQuickNav"[^>]*aria-label="Booking list quick filters"/);
  assert.match(adminSource, /role="group" aria-label="Filter by booking type"/);
  assert.match(adminSource, /role="group" aria-label="Filter by reservation status"/);
  assert.match(adminSource, /data-booking-status="pending"[^>]*aria-pressed="false"/);
  assert.match(adminSource, /data-booking-status="confirmed"[^>]*aria-pressed="false"/);
  assert.match(adminSource, /data-booking-status="completed"[^>]*aria-pressed="false"/);
  assert.match(adminSource, /data-booking-status="closed"[^>]*aria-pressed="false"/);
  assert.match(adminSource, /Host Bookings/);
  assert.match(adminSource, /id="bookingFilterMeta" role="status" aria-live="polite"/);
  assert.doesNotMatch(adminSource, /id="fStatus"/, 'the old duplicate Status dropdown must stay removed');
});

test('filtering happens after grouping and before pagination', () => {
  const start = adminSource.indexOf('async function renderBookings()');
  const end = adminSource.indexOf('function clearFilters()', start);
  const source = adminSource.slice(start, end);

  const groupedAt = source.indexOf('const allGroups = groupBookings(bks, bks)');
  const formFilterAt = source.indexOf('allGroups.filter(group => bookingGroupMatchesFormFilters');
  const statusFilterAt = source.indexOf('.filter(group => bookingMatchesQuickStatus(group))');
  const paginationAt = source.indexOf('updateBookingPagination(filteredCount)');
  assert.ok(groupedAt >= 0 && groupedAt < formFilterAt, 'raw rows must be grouped first');
  assert.ok(formFilterAt < statusFilterAt && statusFilterAt < paginationAt, 'facets must filter complete groups before pagination');
  assert.doesNotMatch(source, /bks\s*=\s*bks\.filter\(b\s*=>\s*b\.status/, 'status filtering must never split a group');
});

test('only fresh verifying placeholders stay hidden from the operational booking list', () => {
  const now = Date.parse('2026-09-02T02:10:00Z');
  const fresh = { email: 'reserve@hold.internal', status: 'verifying', createdAt: '2026-09-02T02:00:00Z' };
  const expired = { ...fresh, createdAt: '2026-09-02T01:40:00Z' };
  const orphanedPending = { ...fresh, status: 'pending' };
  const real = { email: 'player@example.com', status: 'pending', createdAt: fresh.createdAt };

  assert.equal(helpers.isFreshPlaceholderHold(fresh, now), true);
  assert.equal(helpers.isFreshPlaceholderHold(expired, now), false);
  assert.equal(helpers.isFreshPlaceholderHold(orphanedPending, now), false);
  assert.equal(helpers.isFreshPlaceholderHold(real, now), false);

  const renderStart = adminSource.indexOf('async function renderBookings()');
  const renderEnd = adminSource.indexOf('function clearFilters()', renderStart);
  const renderSource = adminSource.slice(renderStart, renderEnd);
  assert.match(renderSource, /bks\s*=\s*bks\.filter\(b\s*=>\s*!isFreshPlaceholderHold\(b\)\)/);
  assert.doesNotMatch(renderSource, /b\.email\s*!==?\s*['"]reserve@hold\.internal['"]/);
  assert.match(adminSource, /Incomplete hold · no customer details/);
  assert.match(adminSource, />Release Hold</);
});

test('mobile status filters are touch-sized and horizontally swipeable', () => {
  assert.match(adminSource, /\.booking-status-actions\s*\{[\s\S]{0,260}?overflow-x:\s*auto/i);
  assert.match(adminSource, /\.booking-status-actions \.booking-filter-chip\s*\{[\s\S]{0,160}?min-height:\s*44px/i);
  assert.match(adminSource, /\.booking-quick-type-actions\s*\{[^}]*grid-template-columns:\s*repeat\(3,minmax\(0,1fr\)\)/i);
  assert.match(adminSource, /\.booking-filter-chip:focus-visible\s*\{/);
});

test('tablet and laptop widths keep every status action visible without clipping', () => {
  assert.match(
    adminSource,
    /@media\s*\(min-width:\s*761px\)\s*and\s*\(max-width:\s*1480px\)\s*\{[\s\S]{0,700}?\.booking-status-actions\s*\{\s*flex-wrap:\s*wrap;/i,
  );
  assert.match(
    adminSource,
    /@media\s*\(min-width:\s*761px\)\s*and\s*\(max-width:\s*1480px\)\s*\{[\s\S]{0,900}?\.booking-status-actions \.booking-filter-chip\s*\{\s*flex:\s*1 1 150px;/i,
  );
});

test('list-only quick filters hide in Calendar and return with a fresh List render', () => {
  const start = adminSource.indexOf('function switchBookingView(mode)');
  const end = adminSource.indexOf('function calNav(', start);
  const source = adminSource.slice(start, end);

  assert.match(source, /bookingQuickNav[^\n]*\.hidden\s*=\s*isCal/);
  assert.match(source, /if\(isCal\) renderCalendar\(\);\s*else renderBookings\(\);/);
  assert.match(adminSource, /\.booking-quick-nav\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test('opening a calendar day applies its date before the single List render', () => {
  const start = adminSource.indexOf('function calViewDayBookings(dateStr)');
  const end = adminSource.indexOf('function calStatusBreakdownHtml', start);
  const source = adminSource.slice(start, end);

  assert.ok(source.indexOf("$('fDate').value=dateStr") < source.indexOf("switchBookingView('list')"));
  assert.equal((source.match(/renderBookings\(\)/g) || []).length, 0, 'List switching owns the only booking render');
});
