const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const admin = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const start = admin.indexOf('function fmtHour(');
const end = admin.indexOf('async function exportCSV()', start);
assert.ok(start >= 0 && end > start, 'manual reschedule functions are present');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const elements = new Map();
  const calls = { moves: [], emails: [], updates: [], toasts: [] };
  const booking = {
    ref: 'PB-TEST123', courtId: 'c1', courtName: 'Court 1', fullName: 'Test Guest',
    email: 'guest@example.test', date: '2026-09-21', slots: [8, 9, 10], duration: 3,
    startTime: '8:00 AM', endTime: '11:00 AM', ...overrides.booking,
  };
  const document = { activeElement: null, createElement: () => element() };
  function element() {
    return {
      value: '', textContent: '', disabled: false, hidden: false, dataset: {}, attributes: {}, children: [],
      min: '', max: '', isConnected: true,
      classList: { add() {}, remove() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ''; },
      focus() { document.activeElement = this; },
    };
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const snapshot = (date, starts = [12, 13, 17], patch = {}) => ({
    bookingRef: booking.ref, courtId: booking.courtId, date,
    duration: booking.slots.length, starts, oldDate: booking.date, oldSlots: [...booking.slots], ...patch,
  });
  const context = vm.createContext({
    $, document, console, Date,
    phDateKeyFromTimestamp: () => '2026-09-20',
    _pbMinimumPublicBookingDate: () => '2026-09-20',
    fmtD: date => date,
    getBookingGroupByRef: async () => ({ isGroup: false }),
    closeModal() {},
    renderBookings: async () => {},
    renderDash() {},
    toast: (...args) => calls.toasts.push(args),
    notifyBookingUpdateSafe: async (...args) => calls.updates.push(args),
    DB: {
      getBookingByRef: async () => booking,
      getAdminRescheduleOptions: overrides.options || (async (ref, date) => snapshot(date)),
      rescheduleBookingTransaction: async (...args) => {
        calls.moves.push(args);
        return overrides.move ? overrides.move(...args) : { bookingRef: booking.ref };
      },
      sendRescheduleEmail: async payload => { calls.emails.push(payload); return { ok: true }; },
    },
  });
  function $(id) { return get(id); }
  vm.runInContext(`${admin.slice(start, end)}\nthis.rsTest = { get state() { return _rsState; } };`, context);
  return { context, calls, booking, get, snapshot };
}

test('three-hour booking offers only server-approved complete ranges and keeps its duration read-only', async () => {
  const h = harness();
  await h.context.openRescheduleModal(h.booking.ref);
  assert.equal(h.get('rsDuration').value, '3 hours');
  assert.deepEqual(h.get('rsStartTime').children.map(option => option.textContent), [
    '12:00 PM – 3:00 PM', '1:00 PM – 4:00 PM', '5:00 PM – 8:00 PM',
  ]);
  assert.equal(h.get('rsEndTimeDisplay').textContent, '3:00 PM');
  assert.equal(h.get('rsSaveBtn').disabled, false);
  assert.match(admin, /<input[^>]*id="rsDuration"[^>]*readonly/);
  assert.doesNotMatch(admin, /<select[^>]*id="rsDuration"/);
});

test('original duration is derived from reserved slots without the old four-hour clamp', async () => {
  const h = harness({ booking: { slots: [6, 7, 8, 9, 10], duration: 5 } });
  await h.context.openRescheduleModal(h.booking.ref);
  assert.equal(h.get('rsDuration').value, '5 hours');
  assert.equal(h.get('rsStartTime').children[0].textContent, '12:00 PM – 5:00 PM');
  assert.throws(() => h.context.rsOriginalSlots([6, 8, 9]), /continuous/);
  assert.throws(() => h.context.rsOriginalSlots([6, 6, 7]), /continuous/);
});

test('opening date and Manila calendar day bound the date picker', async () => {
  const h = harness();
  h.context.phDateKeyFromTimestamp = () => '2026-09-05';
  h.context._pbMinimumPublicBookingDate = () => '2026-09-19';
  await h.context.openRescheduleModal(h.booking.ref);
  assert.equal(h.get('rsNewDate').min, '2026-09-19');
  assert.equal(h.get('rsNewDate').value, '2026-09-19');
  assert.equal(h.context.rsDateIsValid('2026-09-18'), false);
  assert.equal(h.context.rsDateIsValid('2026-09-31'), false);
  assert.equal(h.context.rsDateIsValid('2026-09-19'), true);
});

test('newer date wins when earlier availability responds late', async () => {
  const h = harness();
  await h.context.openRescheduleModal(h.booking.ref);
  const older = deferred();
  const newer = deferred();
  h.context.DB.getAdminRescheduleOptions = (ref, date) => date === '2026-09-22' ? older.promise : newer.promise;
  h.get('rsNewDate').value = '2026-09-22';
  const oldLoad = h.context.loadRsAvailability();
  assert.equal(h.get('rsStartTime').disabled, true);
  assert.equal(h.get('rsSaveBtn').disabled, true);
  assert.equal(h.get('rsAvailabilityStatus').dataset.state, 'loading');
  h.get('rsNewDate').value = '2026-09-23';
  const newLoad = h.context.loadRsAvailability();
  newer.resolve(h.snapshot('2026-09-23', [18]));
  await newLoad;
  older.resolve(h.snapshot('2026-09-22', [7]));
  await oldLoad;
  assert.equal(h.get('rsStartTime').value, '18');
  assert.equal(h.context.rsTest.state.optionsDate, '2026-09-23');
  assert.equal(h.get('rsEndTimeDisplay').textContent, '9:00 PM');
});

test('closing and reopening the dialog invalidates pending availability', async () => {
  const h = harness();
  await h.context.openRescheduleModal(h.booking.ref);
  const delayed = deferred();
  h.context.DB.getAdminRescheduleOptions = () => delayed.promise;
  const oldLoad = h.context.loadRsAvailability();
  h.context.closeRescheduleModal();
  h.context.DB.getAdminRescheduleOptions = async (ref, date) => h.snapshot(date, [19]);
  await h.context.openRescheduleModal(h.booking.ref);
  delayed.resolve(h.snapshot('2026-09-21', [7]));
  await oldLoad;
  assert.equal(h.get('rsStartTime').value, '19');
});

test('empty and failed availability keep submission disabled and errors can be retried', async () => {
  const h = harness();
  h.context.DB.getAdminRescheduleOptions = async (ref, date) => h.snapshot(date, []);
  await h.context.openRescheduleModal(h.booking.ref);
  assert.equal(h.get('rsAvailabilityStatus').dataset.state, 'empty');
  assert.match(h.get('rsAvailabilityStatus').textContent, /No continuous 3-hour/);
  assert.equal(h.get('rsStartTime').disabled, true);
  assert.equal(h.get('rsSaveBtn').disabled, true);
  h.context.DB.getAdminRescheduleOptions = async () => { throw new Error('Service unavailable'); };
  await h.context.loadRsAvailability();
  assert.equal(h.get('rsAvailabilityStatus').dataset.state, 'error');
  assert.equal(h.get('rsRetryBtn').hidden, false);
  await h.context.saveReschedule();
  assert.equal(h.calls.moves.length, 0);
  h.context.DB.getAdminRescheduleOptions = async (ref, date) => h.snapshot(date, [15]);
  await h.context.loadRsAvailability();
  assert.equal(h.get('rsSaveBtn').disabled, false);
  assert.equal(h.get('rsRetryBtn').hidden, true);
});

test('mismatched booking snapshots and impossible ranges fail closed', async () => {
  const h = harness();
  await h.context.openRescheduleModal(h.booking.ref);
  for (const patch of [{ oldDate: '2026-09-22' }, { oldSlots: [9, 10, 11] }, { courtId: 'c2' }, { duration: 2 }, { starts: [22] }]) {
    h.context.DB.getAdminRescheduleOptions = async (ref, date) => h.snapshot(date, [12], patch);
    await h.context.loadRsAvailability();
    assert.equal(h.get('rsSaveBtn').disabled, true);
    assert.equal(h.get('rsAvailabilityStatus').dataset.state, 'error');
  }
});

test('tampered duration cannot change the atomic request and duplicate saves cannot notify twice', async () => {
  const pending = deferred();
  const h = harness({ move: () => pending.promise });
  await h.context.openRescheduleModal(h.booking.ref);
  h.get('rsDuration').value = '1';
  const save = h.context.saveReschedule();
  await h.context.saveReschedule();
  h.context.closeRescheduleModal();
  assert.ok(h.context.rsTest.state, 'cannot close during an in-flight mutation');
  assert.equal(h.calls.moves.length, 1);
  const [ref, schedule] = h.calls.moves[0];
  assert.equal(ref, h.booking.ref);
  assert.deepEqual(JSON.parse(JSON.stringify(schedule)), {
    date: '2026-09-21', startHour: 12, expectedDate: '2026-09-21', expectedCourtId: 'c1', expectedSlots: [8, 9, 10],
  });
  assert.equal(h.get('rsCancelBtn').disabled, true);
  assert.equal(h.calls.emails.length, 0);
  pending.resolve({ bookingRef: h.booking.ref });
  await save;
  assert.equal(h.context.rsTest.state, null);
  assert.equal(h.calls.emails.length, 1);
  assert.equal(h.calls.emails[0].newDuration, 3);
  assert.equal(h.calls.emails[0].newEndTime, '3:00 PM');
  assert.equal(h.calls.updates.length, 1);
});

test('server conflict refreshes availability and sends no notification', async () => {
  const h = harness({ move: async () => { throw new Error('That block was just booked. Choose another time.'); } });
  await h.context.openRescheduleModal(h.booking.ref);
  h.context.DB.getAdminRescheduleOptions = async (ref, date) => h.snapshot(date, [17]);
  await h.context.saveReschedule();
  assert.equal(h.calls.moves.length, 1);
  assert.equal(h.calls.emails.length, 0);
  assert.equal(h.calls.updates.length, 0);
  assert.equal(h.get('rsSaveError').hidden, false);
  assert.match(h.get('rsSaveError').textContent, /just booked/);
  assert.equal(h.get('rsStartTime').value, '17');
  assert.equal(h.get('rsSaveBtn').disabled, false);
});

test('an unlisted start or date change before refresh cannot be submitted', async () => {
  const h = harness();
  await h.context.openRescheduleModal(h.booking.ref);
  h.get('rsStartTime').value = '14';
  await h.context.saveReschedule();
  assert.equal(h.calls.moves.length, 0);
  h.get('rsStartTime').value = '12';
  h.get('rsNewDate').value = '2026-09-22';
  await h.context.saveReschedule();
  assert.equal(h.calls.moves.length, 0);
});
