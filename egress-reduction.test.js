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
