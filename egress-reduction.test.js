const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const admin = fs.readFileSync('admin.html', 'utf8');
const start = admin.indexOf('async function getBookingGroupByRef(ref)');
const end = admin.indexOf('async function updateBookingGroupByRef', start);
const source = admin.slice(start, end);

test('opening a grouped booking hydrates only its receipts and retains duplicate scope', async () => {
  const rows = [{ref:'A',key:'group'}, {ref:'B',key:'group'}, {ref:'C',key:'other'}];
  const calls = [];
  const context = {
    DB: {
      getBookingByRef: async ref => { calls.push(ref); return {...rows.find(b=>b.ref===ref),receiptExtracted:{evidence:ref}}; },
      getBookings: async () => rows,
    },
    bookingGroupKey:b=>b.key,
    groupBookings:all=>{
      assert.equal(all.length,3,'duplicate detection still sees other reservations');
      assert.equal(all[2].receiptExtracted,undefined);
      return [{groupKey:'group',items:all.slice(0,2)}];
    },
  };
  vm.createContext(context); vm.runInContext(source,context);
  const result = await context.getBookingGroupByRef('B');
  assert.deepEqual(calls,['B','A']);
  assert.equal(result.items[0].receiptExtracted.evidence,'A');
  assert.equal(result.items[1].receiptExtracted.evidence,'B');
});

test('a missing grouped record fails instead of showing incomplete payment evidence', async () => {
  const context = {DB:{getBookingByRef:async ref=>ref==='A'?{ref,key:'group'}:null,getBookings:async()=>[{ref:'A',key:'group'},{ref:'B',key:'group'}]},bookingGroupKey:b=>b.key};
  vm.createContext(context);vm.runInContext(source,context);
  await assert.rejects(context.getBookingGroupByRef('A'),/Booking changed/);
});

test('live board polling backs off while idle, slows when paused, and stops when final', () => {
  const live = fs.readFileSync('player-live.js', 'utf8');
  const consts = live.slice(live.indexOf('const POLL_MS'), live.indexOf('const state = {'));
  const fnStart = live.indexOf('function schedulePoll()');
  const fn = live.slice(fnStart, live.indexOf('\n  }\n', fnStart) + 4);
  const delays = [];
  const context = { state: { failures: 0, unchangedPolls: 0, terminal: false, snapshot: { session: { status: 'active' } } },
    document: { hidden: false }, clearTimeout() {}, setTimeout: (_fn, ms) => { delays.push(ms); return 1; }, fetchSnapshot() {} };
  vm.createContext(context);
  vm.runInContext(`${consts}\n${fn}\nthis.schedulePoll = schedulePoll;`, context);
  context.schedulePoll();
  context.state.unchangedPolls = 10; context.schedulePoll();
  context.state.snapshot.session.status = 'paused'; context.schedulePoll();
  context.state.snapshot.session.status = 'completed'; context.schedulePoll();
  assert.deepEqual(delays, [3000, 15000, 30000]);
});
