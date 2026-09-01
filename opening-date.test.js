const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = __dirname;
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(root, 'supabase-config.js'), 'utf8');
const edge = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'submit-public-booking', 'index.ts'),
  'utf8',
);
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901183000_public_court_opening_gate.sql'),
  'utf8',
);
const baseline = fs.readFileSync(path.join(root, 'SETUP_NEW_SUPABASE.sql'), 'utf8');

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker after ${start}: ${end}`);
  return source.slice(from, to);
}

function dateHarness(initialToday) {
  const source = sourceBetween(
    page,
    "const PUBLIC_COURT_OPENING_DATE = '2026-09-19';",
    'function selectedCourtBrowseDate()',
  );
  return new Function(`
    let currentToday = ${JSON.stringify(initialToday)};
    const todayStr = () => currentToday;
    ${source}
    return {
      setToday(value) { currentToday = value; },
      minimum: minimumPublicBookingDate,
      allowed: isPublicBookingDateAllowed,
      normalize: normalizedCourtBrowseDate,
      message: publicBookingDateMessage,
    };
  `)();
}

test('opening boundary follows Manila business date and never moves before September 19', () => {
  const harness = dateHarness('2026-09-18');
  assert.equal(harness.minimum(), '2026-09-19');
  assert.equal(harness.normalize('2026-09-18'), '2026-09-19');
  assert.equal(harness.normalize('2026-09-19'), '2026-09-19');
  assert.equal(harness.allowed('2026-09-18'), false);
  assert.equal(harness.allowed('2026-09-19'), true);
  assert.match(harness.message(), /September 19, 2026/);

  harness.setToday('2026-09-19');
  assert.equal(harness.minimum(), '2026-09-19');
  harness.setToday('2026-09-20');
  assert.equal(harness.minimum(), '2026-09-20');
  assert.equal(harness.allowed('2026-09-19'), false);
  assert.equal(harness.allowed('2026-09-20'), true);
});

test('public date controls clamp navigation and disable every date before launch', () => {
  const controls = sourceBetween(page, '<div class="shared-date-entry">', '<div class="price-promise"');
  assert.match(controls, /id="courtSharedPrev"/);
  assert.match(controls, /id="courtSharedQuickDate"/);
  assert.match(controls, /Advance booking · opening Sep 19/);

  const dateLogic = sourceBetween(page, 'function selectedCourtBrowseDate()', 'function emptyCardSelection()');
  assert.match(dateLogic, /input\.min = minimumPublicBookingDate\(\)/);
  assert.match(dateLogic, /previousDay\.disabled = safeDate <= minimumPublicBookingDate\(\)/);
  assert.match(dateLogic, /Opening Day/);
  assert.match(dateLogic, /ds < minimumDate \? 'disabled'/);
  assert.match(dateLogic, /requestedMonth < minimumMonth/);
  assert.match(dateLogic, /onSharedCourtDate\(minimumPublicBookingDate\(\)\)/);
});

test('Find Time, slot painters, selection, checkout, and resume fail closed before launch', () => {
  const findTime = sourceBetween(page, 'function populateFindTimeControls()', 'async function toggleCardSlot');
  assert.match(findTime, /dateEl\.min = minimumDate/);
  assert.match(findTime, /if \(!isPublicBookingDateAllowed\(date\)\) return \[\]/);
  assert.match(findTime, /async function selectFindTimeResult[\s\S]*?!isPublicBookingDateAllowed\(date\)/);

  const cardPainter = sourceBetween(page, 'async function onCardDate', 'async function ensureCourt');
  assert.ok(
    cardPainter.indexOf('!isPublicBookingDateAllowed(date)') < cardPainter.indexOf('DB.getCourts()'),
    'pre-opening card dates must stop before availability queries',
  );
  const selection = sourceBetween(page, 'async function toggleCardSlot', 'function updateCardUI');
  assert.match(selection, /!isPublicBookingDateAllowed\(date\)/);
  const proceed = sourceBetween(page, 'async function proceedToBookLegacy', 'function closeBookModal');
  assert.match(proceed, /!isPublicBookingDateAllowed\(cardSel\.date\)/);
  assert.match(proceed, /!isPublicBookingDateAllowed\(selectedDate\)/);

  const modernSubmit = sourceBetween(page, 'async function submitBooking(e)', 'function resetForm');
  assert.match(modernSubmit, /items\.some\(item => !isPublicBookingDateAllowed\(item\.date\)\)/);
  const resume = sourceBetween(page, 'async function maybeResumeGuestBooking()', 'function cancelReservedBookings');
  assert.match(resume, /rows\.some\(booking => !isPublicBookingDateAllowed\(booking\.date\)\)/);
  assert.match(resume, /status: 'cancelled'/);
});

test('remote and local clients reject an invalid batch atomically before mutation', () => {
  const addMethods = [...client.matchAll(/async addBookings\(bookings\) \{([\s\S]*?)(?=\n\s*async addBooking\()/g)].map(match => match[1]);
  assert.equal(addMethods.length, 2, 'remote and local addBookings implementations must exist');
  for (const method of addMethods) {
    assert.match(method, /batch\.forEach\(booking => _pbAssertPublicBookingDate\(booking\.date\)\)/);
    const assertion = method.indexOf('batch.forEach(booking => _pbAssertPublicBookingDate(booking.date))');
    const firstMutation = Math.min(
      ...['await _sb.from', 'const db = readDb()', 'db.bookings.push'].map(marker => {
        const index = method.indexOf(marker);
        return index < 0 ? Number.POSITIVE_INFINITY : index;
      }),
    );
    assert.ok(assertion >= 0 && assertion < firstMutation, 'date validation must happen before any write');
  }
  assert.match(client, /timeZone: 'Asia\/Manila'/);
  assert.match(client, /PB_PUBLIC_COURT_OPENING_DATE = '2026-09-19'/);
});

test('Edge and database enforce the same authoritative opening date', () => {
  assert.match(edge, /PUBLIC_COURT_OPENING_DATE = "2026-09-19"/);
  assert.match(edge, /timeZone: "Asia\/Manila"/);
  const precheck = edge.indexOf('bookings.some((booking) =>');
  const rpc = edge.indexOf('db.rpc("submit_public_booking_holds"');
  assert.ok(precheck >= 0 && rpc > precheck, 'Edge must reject the whole batch before the RPC');

  for (const sql of [migration, baseline]) {
    assert.match(sql, /greatest\(\s*date '2026-09-19',\s*timezone\('Asia\/Manila', now\(\)\)::date\s*\)/i);
    assert.match(sql, /before insert or update of date on public\.bookings/i);
    assert.match(sql, /before insert or update of date on public\.open_play_registrations/i);
    assert.match(sql, /before insert or update of date on public\.open_play_host_sessions/i);
    assert.match(sql, /enforce_host_session_registration_opening_date/i);
  }
});

test('Open Play and share-link entry points use the same launch boundary', () => {
  const openPlay = sourceBetween(page, 'async function openPlaySignup', 'function closeOpModal');
  assert.match(openPlay, /!isPublicBookingDateAllowed\(date\)/);
  const openPlaySubmit = sourceBetween(page, 'async function submitOpenPlay()', '</script>');
  assert.match(openPlaySubmit, /!isPublicBookingDateAllowed\(_opSignupData\.date\)/);
  const hostJoin = sourceBetween(page, 'async function submitHostSessionJoin()', 'function renderPublicHostSession');
  assert.match(hostJoin, /!isPublicBookingDateAllowed\(session\.date\)/);
});
