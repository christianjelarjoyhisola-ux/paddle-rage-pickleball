const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = __dirname;
const migration = fs.readFileSync(path.join(
  root,
  'supabase',
  'migrations',
  '20260902230000_admin_availability_graphic_rpc.sql',
), 'utf8');
const client = fs.readFileSync(path.join(root, 'supabase-config.js'), 'utf8');
const canonicalOccupancy = fs.readFileSync(path.join(
  root,
  'supabase',
  'migrations',
  '20260902150000_automatic_booking_hold_cleanup.sql',
), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function validSnapshot() {
  return {
    version: 1,
    date: '2026-09-19',
    timezone: 'Asia/Manila',
    asOf: '2026-09-02T23:12:45.123+08:00',
    openHour: 6,
    closeHour: 8,
    courts: [{
      id: 'c1',
      name: 'Court 1',
      availableCount: 1,
      totalSlots: 2,
      slots: [
        { hour: 6, startHour: 6, endHour: 7, startLabel: '6:00 AM', endLabel: '7:00 AM', state: 'free', reason: null, label: 'Available' },
        { hour: 7, startHour: 7, endHour: 8, startLabel: '7:00 AM', endLabel: '8:00 AM', state: 'unavailable', reason: 'booked', label: 'Booked' },
      ],
    }],
  };
}

function localBuilderHarness(db, now = '2026-09-19T04:30:00.000Z') {
  const NativeDate = Date;
  class FixedDate extends NativeDate {
    constructor(value) { super(value === undefined ? now : value); }
    static now() { return new NativeDate(now).getTime(); }
  }
  const context = {
    Date: FixedDate,
    Intl,
    PB_PUBLIC_COURT_OPENING_DATE: '2026-09-19',
    PB_RESERVATION_HOLD_MINUTES: 15,
    _safeJsonParse(value) { try { return JSON.parse(value); } catch (_) { return null; } },
    readDb() { return db; },
    window: { Auth: { getSession: () => ({ role: 'owner', status: 'active' }) } },
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction(client, '_pbNormalizeAvailabilityGraphicSnapshot'),
    extractFunction(client, 'buildLocalAvailabilityGraphic'),
    'this.build = buildLocalAvailabilityGraphic;',
  ].join('\n'), context);
  return context.build;
}

function localDb(overrides = {}) {
  return {
    settings: {
      open_hour: '6',
      close_hour: '14',
      maintenance_config: JSON.stringify({ rules: [] }),
      open_play_config: JSON.stringify({ enabled: true, start: 6, end: 14, days: [0, 6], courtIds: [] }),
    },
    courts: [
      { id: 'c1', name: 'Court 1', blocked: false },
      { id: 'c2', name: 'Court 2', blocked: true },
      { id: 'c3', name: 'Court 3', blocked: false },
    ],
    bookings: [],
    blockedDates: [],
    ...overrides,
  };
}

test('availability graphic RPC is owner-only, privacy-safe, bounded, and authoritative', () => {
  assert.match(migration, /create or replace function public\.get_admin_availability_graphic\(\s*p_date date,\s*p_court_ids text\[\] default null\s*\)/i);
  assert.match(migration, /language plpgsql\s+stable\s+security definer\s+set search_path = public, pg_temp/i);
  assert.match(migration, /auth\.uid\(\) is null[\s\S]*?not exists\s*\([\s\S]*?from public\.accounts account[\s\S]*?account\.id = auth\.uid\(\)[\s\S]*?account\.status = 'active'[\s\S]*?account\.role in \('owner', 'court_owner'\)/i);
  assert.doesNotMatch(migration, /has_account_role\(/i, 'RPC authorization must verify active account status directly');
  assert.match(migration, /revoke all on function public\.get_admin_availability_graphic\(date, text\[\]\)\s+from public, anon/i);
  assert.match(migration, /grant execute on function public\.get_admin_availability_graphic\(date, text\[\]\)\s+to authenticated, service_role/i);
  assert.match(migration, /p_date < ph_today[\s\S]*?p_date > ph_today \+ 366/i);
  assert.match(migration, /coalesce\(cardinality\(p_court_ids\), 0\) > 50/i);
  assert.match(migration, /One or more selected courts are unavailable/i);
  assert.match(migration, /No active courts are available for this snapshot/i);

  assert.match(migration, /coalesce\(c\.blocked, false\) = false/i);
  assert.match(migration, /public\.blocked_dates/i);
  assert.match(migration, /public\.booking_occupies_slot\(\s*b\.status,\s*b\.email,\s*b\.full_name,\s*b\.created_at\s*\)/i);
  assert.match(migration, /maintenance_config/i);
  assert.match(migration, /slot_state := 'unavailable'[\s\S]*?slot_reason := 'maintenance'/i);
  assert.doesNotMatch(migration, /open_play_config/i, 'Open Play is hard-disabled on both booking surfaces in v1');
  assert.match(migration, /timezone\('Asia\/Manila', statement_timestamp\(\)\)/i);
  assert.match(migration, /'asOf',[\s\S]*?'\+08:00'/i);

  for (const key of ['fullName', 'email', 'contactNumber', 'bookingRef', 'gcashRef', 'paymentStatus']) {
    assert.doesNotMatch(migration, new RegExp(`'${key}'`, 'i'), `${key} must not be returned`);
  }
});

test('availability configuration fails closed and seeds explicit first-run defaults', () => {
  assert.match(migration, /\('open_hour', '6', now\(\)\)/i);
  assert.match(migration, /\('close_hour', '22', now\(\)\)/i);
  assert.match(migration, /\('maintenance_config', '\{"rules":\[\]\}', now\(\)\)/i);
  assert.match(migration, /on conflict \(key\) do nothing/i);
  assert.match(migration, /Court operating hours are not configured correctly/i);
  assert.match(migration, /Maintenance schedule is not configured correctly/i);
  assert.match(migration, /jsonb_typeof\(maintenance_rule->'dates'\) is distinct from 'array'/i);
  assert.match(migration, /jsonb_typeof\(maintenance_rule#>'\{recurring,days\}'\) is distinct from 'array'[\s\S]*?configured\.value !~ '\^\[0-6\]\$'/i);
  assert.doesNotMatch(migration, /open_hour integer := 6|close_hour integer := 22/i);
});

test('local occupancy parity follows the latest canonical AND-only placeholder expiry', () => {
  assert.match(canonicalOccupancy, /booking_created_at <= now\(\) - interval '15 minutes'[\s\S]*?booking_status[\s\S]*?= 'verifying'[\s\S]*?booking_email[\s\S]*?= 'reserve@hold\.internal'[\s\S]*?booking_full_name[\s\S]*?in \('reserving\.\.\.', 'reserving…'\)/i);
  assert.match(client, /status[^\n]*=== 'verifying' && placeholder[\s\S]*?Date\.now\(\) - createdMs >= PB_RESERVATION_HOLD_MINUTES/i);

  const old = '2026-09-19T03:00:00.000Z';
  const fresh = '2026-09-19T04:25:00.000Z';
  const booking = (slot, status, fields = {}) => ({
    courtId: 'c1', date: '2026-09-20', slots: [slot], status, createdAt: old,
    fullName: 'Customer', email: 'customer@example.com', ...fields,
  });
  const db = localDb({
    bookings: [
      booking(6, 'confirmed'),
      booking(7, 'cancelled'),
      booking(8, 'forfeited'),
      booking(9, 'verifying', { createdAt: fresh, fullName: 'Reserving...', email: 'reserve@hold.internal' }),
      booking(10, 'verifying', { fullName: 'Reserving...', email: 'reserve@hold.internal' }),
      booking(11, 'verifying'),
      booking(12, 'pending', { fullName: 'Reserving...', email: 'reserve@hold.internal' }),
    ],
  });
  const snapshot = localBuilderHarness(db)('2026-09-20', ['c1']);
  const state = hour => snapshot.courts[0].slots.find(slot => slot.hour === hour);
  assert.equal(state(6).reason, 'booked');
  assert.equal(state(7).state, 'free');
  assert.equal(state(8).state, 'free');
  assert.equal(state(9).reason, 'booked', 'fresh placeholder still occupies');
  assert.equal(state(10).state, 'free', 'only an expired canonical placeholder is released');
  assert.equal(state(11).reason, 'booked', 'genuine verifying receipt remains occupied');
  assert.equal(state(12).reason, 'booked', 'placeholder identity without verifying status remains occupied');
});

test('local snapshot honors blocked inventory, Manila current hour, and hard-disabled Open Play', () => {
  const db = localDb();
  const build = localBuilderHarness(db);
  const today = build('2026-09-19', ['c1']);
  const state = hour => today.courts[0].slots.find(slot => slot.hour === hour);
  assert.equal(state(11).reason, 'past');
  assert.equal(state(12).reason, 'current');
  assert.equal(state(13).state, 'free');
  assert.equal(today.courts.length, 1);
  assert.throws(() => build('2026-09-19', ['c2']), /selected courts are unavailable/i);

  db.blockedDates = ['2026-09-20'];
  const blocked = build('2026-09-20', ['c1']);
  assert.ok(blocked.courts[0].slots.every(slot => slot.reason === 'blocked_date'));

  db.blockedDates = [];
  const future = build('2026-09-20', ['c1']);
  assert.ok(future.courts[0].slots.every(slot => slot.state === 'free'), 'saved Open Play config is ignored while both booking UI gates are disabled');
});

test('local maintenance parity covers boundaries, court targeting, and recurrence modes', () => {
  const db = localDb();
  db.settings.maintenance_config = JSON.stringify({ rules: [
    { enabled: true, mode: 'specific', start: 7, end: 9, dates: ['2026-09-20'], courtIds: ['c1'], label: 'reserved' },
    { enabled: true, mode: 'specific', start: 9, end: 10, dates: ['2026-09-20'], courtIds: ['c3'], label: 'private' },
    { enabled: true, mode: 'weekly', start: 10, end: 11, recurring: { days: [0] }, courtIds: ['c1'] },
    { enabled: true, mode: 'monthly', start: 11, end: 12, recurring: { day: 20 }, courtIds: ['c1'], label: 'group' },
    { enabled: true, mode: 'specific', start: 22, end: 7, dates: ['2026-09-20'], courtIds: ['c1'], label: 'closed' },
  ] });
  const snapshot = localBuilderHarness(db)('2026-09-20', ['c1']);
  const state = hour => snapshot.courts[0].slots.find(slot => slot.hour === hour);
  assert.equal(state(6).label, 'Closed', 'overnight range stays attached to the selected date like the booking UI');
  assert.equal(state(7).label, 'Reserved');
  assert.equal(state(8).label, 'Reserved');
  assert.equal(state(9).state, 'free', 'end boundary and a rule for another court do not block');
  assert.equal(state(10).label, 'Maintenance');
  assert.equal(state(11).label, 'Group Session');
  assert.equal(state(12).state, 'free');
});

test('local snapshot fails closed on malformed settings instead of advertising open slots', () => {
  const missingHours = localDb();
  delete missingHours.settings.open_hour;
  assert.throws(() => localBuilderHarness(missingHours)('2026-09-20', ['c1']), /operating hours/i);

  const malformedHours = localDb();
  malformedHours.settings.close_hour = 'tomorrow';
  assert.throws(() => localBuilderHarness(malformedHours)('2026-09-20', ['c1']), /operating hours/i);

  const malformedMaintenance = localDb();
  malformedMaintenance.settings.maintenance_config = '{bad json';
  assert.throws(() => localBuilderHarness(malformedMaintenance)('2026-09-20', ['c1']), /maintenance schedule/i);

  const malformedRule = localDb();
  malformedRule.settings.maintenance_config = JSON.stringify({ rules: [
    { enabled: true, mode: 'weekly', start: 6, end: 8, recurring: {} },
  ] });
  assert.throws(() => localBuilderHarness(malformedRule)('2026-09-20', ['c1']), /maintenance schedule/i);

  const invalidWeeklyDay = localDb();
  invalidWeeklyDay.settings.maintenance_config = JSON.stringify({ rules: [
    { enabled: true, mode: 'weekly', start: 6, end: 8, recurring: { days: [7] } },
  ] });
  assert.throws(() => localBuilderHarness(invalidWeeklyDay)('2026-09-20', ['c1']), /maintenance schedule/i);
});

test('browser adapter is uncached, throws RPC errors, validates snapshots, and keeps the compatibility alias', () => {
  assert.match(client, /async getAvailabilityGraphic\(date, courtIds = \[\]\)[\s\S]*?_sb\.rpc\('get_admin_availability_graphic'/i);
  assert.match(client, /if \(error\) \{[\s\S]*?throw error;/i);
  assert.doesNotMatch(
    extractFunction(client, '_pbNormalizeAvailabilityGraphicSnapshot'),
    /_pbCached|return \[\]|return \{\}/,
  );
  assert.match(client, /async getAvailabilityGraphicSnapshot\(date, courtIds = \[\]\) \{\s*return this\.getAvailabilityGraphic\(date, courtIds\);/i);
  assert.equal((client.match(/async getAvailabilityGraphic\(date, courtIds = \[\]\)/g) || []).length, 2, 'remote and local adapters must both expose the method');
  assert.match(client, /function buildLocalAvailabilityGraphic\(/);
});

test('snapshot validator rejects empty, inconsistent, or wrong-court data', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${extractFunction(client, '_pbNormalizeAvailabilityGraphicSnapshot')}; this.normalize = _pbNormalizeAvailabilityGraphicSnapshot;`, context);
  const normalize = context.normalize;
  const valid = normalize(validSnapshot(), '2026-09-19', ['c1']);
  assert.equal(valid.generatedAt, valid.asOf);
  assert.equal(valid.courts[0].availableCount, 1);

  assert.throws(() => normalize(null, '2026-09-19'), /invalid snapshot/i);
  assert.throws(() => normalize({ ...validSnapshot(), courts: [] }, '2026-09-19'), /incomplete snapshot/i);
  assert.throws(() => normalize(validSnapshot(), '2026-09-19', ['c2']), /selected courts/i);

  const badHour = validSnapshot();
  badHour.courts[0].slots[0].startHour = 5;
  assert.throws(() => normalize(badHour, '2026-09-19', ['c1']), /invalid slot state/i);

  const badLabel = validSnapshot();
  badLabel.courts[0].slots[0].startLabel = '';
  assert.throws(() => normalize(badLabel, '2026-09-19', ['c1']), /invalid slot state/i);

  const badCount = validSnapshot();
  badCount.courts[0].availableCount = 2;
  assert.throws(() => normalize(badCount, '2026-09-19', ['c1']), /inconsistent slot totals/i);
});
