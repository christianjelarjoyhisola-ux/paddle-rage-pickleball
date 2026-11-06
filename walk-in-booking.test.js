const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const admin = fs.readFileSync('admin.html', 'utf8');

// The admin page has older duplicate declarations; the last one is what runs.
const lastFunction = name => {
  const start = admin.lastIndexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = admin.indexOf('\n}\n', start);
  return admin.slice(start, end + 2);
};

// 5:20 PM on Nov 2, 2026 in Manila.
const NOW = Date.parse('2026-11-02T17:20:00+08:00');

function loadSlotState(bookingsByCourt) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const context = vm.createContext({
    Date: FixedDate,
    Intl,
    fmt: n => `₱${n}`,
    fmtHour: h => `${h}:00`,
    nbMaintenanceRuleForHour: () => null,
    nbMaintenanceLabel: () => 'Maintenance',
    _nbIsOpenPlayHour: () => false,
    _nbGetRateForHour: () => 400,
    _nbBookedSlotMap: new Map(Object.entries(bookingsByCourt).map(([id, rows]) => [id, new Map(rows)])),
    toasts: [],
  });
  context.toast = (message, kind) => context.toasts.push({ message, kind });
  vm.runInContext([
    lastFunction('isPlaceholderHold'),
    lastFunction('nbManilaNow'),
    lastFunction('nbHoldExpiryLabel'),
    lastFunction('nbSlotState'),
    lastFunction('nbExplainTakenSlot'),
  ].join('\n'), context);
  return context;
}

const court = { id: 'c1', name: 'Court 1' };

test('the hour in progress stays bookable for a walk-in', () => {
  const ctx = loadSlotState({ c1: [] });
  const now = ctx.nbSlotState(court, '2026-11-02', 17);
  assert.equal(now.unavailable, false);
  assert.equal(now.label, 'Now · walk-in');
  assert.equal(ctx.nbSlotState(court, '2026-11-02', 16).label, 'Past');
  assert.equal(ctx.nbSlotState(court, '2026-11-02', 18).label, 'Available');
  // Tomorrow's 5 PM is an ordinary future slot.
  assert.equal(ctx.nbSlotState(court, '2026-11-03', 17).label, 'Available');
});

test('an online checkout hold says so instead of looking like a phantom booking', () => {
  const hold = { ref: 'PR-HOLD', fullName: 'Reserving...', email: 'reserve@hold.internal', status: 'verifying', createdAt: '2026-11-02T09:15:00Z' };
  const ctx = loadSlotState({ c1: [[18, hold]] });
  const state = ctx.nbSlotState(court, '2026-11-02', 18);
  assert.equal(state.unavailable, true);
  assert.equal(state.label, 'Reserving online');
  assert.match(state.cls, /reserving/);
  assert.match(state.detail, /^Until 5:30\s?PM$/i);
  ctx.nbExplainTakenSlot(court, 18, state);
  assert.match(ctx.toasts[0].message, /checking out online.*frees up at 5:30\s?PM/i);
});

test('a taken slot names who booked it and whether payment is still pending', () => {
  const confirmed = { ref: 'PR-1', fullName: 'Juan Dela Cruz', email: 'j@x.ph', status: 'confirmed' };
  const pending = { ref: 'PR-2', fullName: 'Maria Santos', email: 'm@x.ph', status: 'verifying' };
  const ctx = loadSlotState({ c1: [[18, confirmed], [19, pending]] });
  const taken = ctx.nbSlotState(court, '2026-11-02', 18);
  assert.equal(taken.label, 'Taken');
  assert.equal(taken.detail, 'Juan');
  assert.equal(ctx.nbSlotState(court, '2026-11-02', 19).label, 'Payment pending');
  ctx.nbExplainTakenSlot(court, 18, taken);
  assert.match(ctx.toasts[0].message, /booked by Juan Dela Cruz \(PR-1\), confirmed/);
});

test('the grid loads only the selected date and keeps taken cells clickable', () => {
  const render = lastFunction('nbRenderSlots');
  assert.match(render, /DB\.getBookings\(\{ date, activeOnly: true \}\)/);
  assert.doesNotMatch(render, /DB\.getBookings\(\)/);
  assert.match(render, /const disabled = state\.unavailable && !state\.booking \? 'disabled' : '';/);
  assert.match(lastFunction('nbToggleSlot'), /nbExplainTakenSlot\(court, Number\(hour\), state\);/);
});

test('the form puts court and time first and uses Manila dates', () => {
  const modal = admin.slice(admin.indexOf('id="newBookingModal"'), admin.indexOf('<!-- RESCHEDULE MODAL -->'));
  assert.ok(modal.indexOf('1 · Pick Court &amp; Time') < modal.indexOf('2 · Customer Details'));
  assert.ok(modal.indexOf('2 · Customer Details') < modal.indexOf('3 · Payment'));
  assert.match(modal, /onclick="nbPickDate\(0\)">Today</);
  assert.match(modal, /onclick="nbPickDate\(1\)">Tomorrow</);
  assert.match(modal, /onclick="nbRefreshSlots\(this\)"/);
  assert.match(lastFunction('openNewBookingModal'), /const todayStr = nbManilaNow\(\)\.date;/);
  assert.match(lastFunction('saveNewBooking'), /\/already booked\/i\.test[\s\S]*?await nbRenderSlots\(\);/);
});
