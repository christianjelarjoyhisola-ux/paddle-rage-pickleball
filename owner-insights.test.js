const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Insights = require('./owner-insights.js');

const ROOT = __dirname;
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function addDays(value, amount) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function court(id = 'court-1', name = 'Court 1') {
  return { id, name, rate: 350, blocked: false, createdAt: '2026-01-01T00:00:00Z' };
}

function booking(overrides = {}) {
  return {
    ref: overrides.ref || `PB-${Math.random().toString(36).slice(2)}`,
    groupRef: overrides.groupRef || null,
    courtId: 'court-1',
    date: '2026-08-31',
    slots: [8],
    duration: 1,
    status: 'confirmed',
    paymentStatus: 'paid',
    createdAt: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    now: '2026-09-01T00:30:00+08:00',
    courts: [court()],
    bookings: [],
    blockedDates: [],
    settings: { open_hour: '8', close_hour: '10' },
    ...overrides,
  };
}

test('fresh production data stays explicitly at day zero and invents no forecast', () => {
  const snapshot = Insights.buildSnapshot(baseInput());
  assert.equal(snapshot.period.from, null);
  assert.equal(snapshot.period.learning_days, 0);
  assert.equal(snapshot.kpis.expected_total_fill_pct, null);
  assert.equal(snapshot.kpis.likely_open_hours, null);
  assert.equal(snapshot.recommendation, null);
  assert.equal(snapshot.kpis.booked_next_28_hours, 0);
  assert.ok(snapshot.kpis.sellable_next_28_hours > 0, 'actual upcoming capacity may still be reported');
});

test('Manila midnight includes yesterday but never trains on today', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    bookings: [
      booking({ ref: 'YESTERDAY', date: '2026-08-31' }),
      booking({ ref: 'TODAY', date: '2026-09-01' }),
    ],
  }));
  assert.equal(snapshot.period.to, '2026-08-31');
  assert.equal(snapshot.period.from, '2026-08-31');
  assert.equal(snapshot.period.learning_days, 1);
  assert.equal(snapshot.data_quality.successful_booking_rows, 1);
  assert.equal(snapshot.kpis.booked_next_28_hours, 0, 'today is neither historical evidence nor a future day');
});

test('only paid successful reservations teach demand', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    now: '2026-09-05T12:00:00+08:00',
    bookings: [
      booking({ ref: 'GOOD', date: '2026-09-01' }),
      booking({ ref: 'UNPAID', date: '2026-09-02', paymentStatus: 'unpaid' }),
      booking({ ref: 'CANCELLED', date: '2026-09-03', status: 'cancelled' }),
      booking({ ref: 'PENDING', date: '2026-09-04', status: 'pending' }),
      booking({ ref: 'DOWNPAYMENT', date: '2026-09-04', slots: [9], paymentStatus: 'downpayment_paid' }),
    ],
  }));
  assert.equal(snapshot.data_quality.successful_booking_rows, 2);
  assert.equal(snapshot.data_quality.successful_reservations, 2);
  const learnedHours = snapshot.heatmap.reduce((sum, cell) => sum + cell.booked_hours, 0);
  assert.equal(learnedHours, 2);
});

test('Open Play, Maintenance, and blocked dates are removed from private-court demand capacity', () => {
  const snapshot = Insights.buildSnapshot(baseInput({
    bookings: [booking({ ref: 'PROGRAMMED', date: '2026-08-31', slots: [8, 9], duration: 2 })],
    settings: {
      open_hour: '8',
      close_hour: '10',
      open_play_config: JSON.stringify({ enabled: true, start: 8, end: 9, specificDates: ['2026-08-31'] }),
      maintenance_config: JSON.stringify({ rules: [{ enabled: true, mode: 'specific', start: 9, end: 10, dates: ['2026-08-31'] }] }),
    },
  }));
  assert.equal(snapshot.signals.reduce((sum, signal) => sum + signal.available_hours, 0), 0);
  assert.equal(snapshot.signals.reduce((sum, signal) => sum + signal.booked_hours, 0), 0);

  const blocked = Insights.buildSnapshot(baseInput({
    bookings: [booking({ ref: 'BLOCKED', date: '2026-08-31' })],
    blockedDates: ['2026-08-31'],
  }));
  assert.equal(blocked.signals.reduce((sum, signal) => sum + signal.booked_hours, 0), 0);
});

test('expected total fill combines existing future bookings with evidence-backed open-hour demand', () => {
  const history = [];
  for (let date = '2026-07-01'; date <= '2026-08-31'; date = addDays(date, 1)) {
    history.push(booking({ ref: `H-${date}`, date, slots: [8] }));
  }
  history.push(booking({ ref: 'FUTURE', date: '2026-09-02', slots: [8], status: 'pending', paymentStatus: 'unpaid' }));
  const snapshot = Insights.buildSnapshot(baseInput({
    settings: { open_hour: '8', close_hour: '9' },
    bookings: history,
  }));
  assert.ok(snapshot.period.learning_days >= 60);
  assert.equal(snapshot.kpis.booked_next_28_hours, 1);
  assert.equal(snapshot.kpis.expected_total_fill_pct, 100);
  assert.equal(snapshot.kpis.likely_open_hours, 0);
  assert.equal(snapshot.recommendation, null, 'a fully utilized schedule must not invent a quiet-hour action');
});

test('a zero-booking court learns from venue history without being stuck forever', () => {
  const courts = [court('court-1', 'Court 1'), court('court-2', 'Court 2')];
  const history = [];
  for (let date = '2026-07-01'; date <= '2026-08-31'; date = addDays(date, 1)) {
    history.push(booking({ ref: `V-${date}`, date, courtId: 'court-1' }));
  }
  const snapshot = Insights.buildSnapshot(baseInput({
    courts,
    bookings: history,
    courtId: 'court-2',
    settings: { open_hour: '8', close_hour: '9' },
  }));
  assert.ok(snapshot.period.learning_days >= 60);
  assert.ok(snapshot.signals.every(signal => signal.booked_hours === 0));
  assert.equal(snapshot.recommendation?.court_id, 'court-2');
  assert.equal(snapshot.recommendation?.action_type, 'feature_regular_price_hour');
});

test('mobile demand map is compact, transposed, evidence-aware, and accessible', () => {
  const admin = read('admin.html');
  const styles = read('owner-insights.css');

  assert.match(admin, /id="prInsightMobileMap"/);
  assert.match(admin, /function renderPaddleInsightMobileMap\(\)/);
  assert.match(admin, /function renderPaddleInsightMobileUnavailable\(\)/);
  assert.match(admin, /Demand by weekday rows and time columns/);
  assert.match(admin, /role="rowheader"/);
  assert.match(admin, /role="columnheader"/);
  assert.match(admin, /aria-rowcount="8"/);
  assert.match(admin, /aria-colcount="\$\{starts\.length\+1\}"/);
  assert.match(admin, /Jump to time of day/);
  assert.match(admin, /\{id:'morning',label:'Morning'/);
  assert.match(admin, /\{id:'afternoon',label:'Afternoon'/);
  assert.match(admin, /\{id:'evening',label:'Evening'/);
  assert.match(admin, /Swipe times/);
  assert.doesNotMatch(admin, /id="prInsightDay"|prInsightMobileList|renderPaddleInsightMobileDay/);

  assert.match(admin, /const evidenceCells=cells\.filter/);
  assert.match(admin, /if\(!evidenceCells\.length\)/);
  assert.match(admin, /Learning your booking pattern/);
  assert.match(admin, /role="progressbar"/);
  assert.match(admin, /confidenceFor\(cell\)\.code==='learning'\?'—':`\$\{prInsightNumber\(cell\.utilization_pct\)\}%`/);
  assert.match(admin, /id="prInsightMobileDetail" role="region" aria-label="Selected hour details"/);
  assert.doesNotMatch(admin, /aria-describedby="prInsightMobileDetail"/);
  assert.match(admin, /onfocus="selectPaddleInsightMobileCell\(this\)"/);
  assert.match(admin, /function handlePaddleInsightMobileGridKey\(event\)/);
  assert.match(admin, /_prInsightSnapshot=\{\};\s*renderPaddleInsightMobileUnavailable\(\);/);
  assert.match(admin, /requestAnimationFrame\(\(\)=>syncPaddleInsightMobilePeriod\(\)\)/);
  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].forEach(key => assert.match(admin, new RegExp(key)));

  assert.match(styles, /\.pr-insights-mobile-scroll \{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/s);
  assert.match(styles, /\.pr-insights-mobile-scroll \{[^}]*touch-action: pan-x pan-y;/s);
  assert.match(styles, /\.pr-insights-mobile-day \{[^}]*position: sticky;[^}]*left: 0;/s);
  assert.match(styles, /\.pr-insights-mobile-grid-row \{[^}]*grid-template-columns: 56px repeat\(var\(--mobile-hour-count\), 56px\)/s);
  assert.match(styles, /\.pr-insights-mobile-cell \{[^}]*min-height: 44px;/s);
  assert.match(styles, /\.pr-insights-mobile-toolbar \{[^}]*display: grid;/s);
  assert.match(styles, /\.pr-insights-mobile-scroll-shell\.is-at-end::after \{ opacity: 0;/);
  assert.match(styles, /\.pr-insights-map-card \{ grid-row: 1; \}/);
  assert.match(styles, /\.pr-insights-action > \.pr-insights-empty \{ min-height: 0;/);
});

test('Paddle admin integration is branded, role-scoped, mobile-safe, and read-only', () => {
  const admin = read('admin.html');
  const config = read('supabase-config.js');
  const runtime = read('owner-insights.js');
  const styles = read('owner-insights.css');
  const headers = read('_headers');
  const worker = read('_worker.js');
  const deploy = read('deploy-cloudflare-pages.ps1');

  assert.match(admin, /data-s="insights" data-perm="insights"/);
  assert.match(admin, /Paddle Rage Intelligence/);
  assert.match(admin, /Find quiet hours\. Fill more courts\./);
  assert.match(admin, /insights:'Insights'/);
  assert.match(admin, /insights:'insights'/);
  assert.match(admin, /renderPaddleInsights\(\{force:true\}\)/);
  assert.match(config, /owner:\s+\[[^\]]*'insights'/);
  assert.match(config, /court_owner:\s+\[[^\]]*'insights'/);
  assert.doesNotMatch(config.match(/staff:\s+\[[^\]]*\]/)?.[0] || '', /insights/);
  assert.match(config, /async getInsightBookings\(\)/);
  assert.match(config, /select\('ref,booking_group_ref,court_id,date,slots,start_time,end_time,duration,status,payment_status,created_at'\)/);
  assert.match(config, /\.range\(from, from \+ pageSize - 1\)/);
  assert.doesNotMatch(config.match(/select\('ref,booking_group_ref,court_id,date,slots,start_time,end_time,duration,status,payment_status,created_at'\)/)?.[0] || '', /full_name|email|contact|receipt/i);
  assert.match(admin, /DB\.getInsightBookings/);
  assert.match(styles, /@media \(max-width: 680px\)/);
  assert.match(styles, /\.pr-insights-mobile-map \{ display: none/);
  assert.match(admin, /role="gridcell"/);
  assert.match(admin, /No price or booking is changed/);
  assert.doesNotMatch(`${runtime}\n${styles}`, /Korte|Bayabas|kortedoscdo\.club/i);
  assert.doesNotMatch(runtime, /discount|voucher|updateBooking|saveBooking/i);
  assert.match(headers, /\/owner-insights\.js[\s\S]*no-store/);
  assert.match(worker, /'\/owner-insights\.js'/);
  assert.match(deploy, /"owner-insights\.js"/);
  assert.match(deploy, /"owner-insights\.css"/);
});
