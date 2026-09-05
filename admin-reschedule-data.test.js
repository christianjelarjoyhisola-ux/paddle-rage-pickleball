const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('supabase-config.js','utf8');
const sql = fs.readFileSync('supabase/migrations/20260905160000_admin_reschedule_available_slots.sql','utf8');

function harness({role='owner',booking={},pending=false,free=[8,9,10,12,13,14,15,16,17,18,19,20,21]}={}) {
  const db = {bookings:[{ref:'QA',courtId:'c1',date:'2026-09-20',slots:[14,15,16],duration:3,status:'confirmed',...booking}],
    bookingRescheduleRequests:pending?[{status:'pending',itemRefs:['QA']}]:[]};
  let requested;
  const context = vm.createContext({window:{Auth:{getSession:()=>({role,status:'active'})}},readDb:()=>db,
    _pbAssertPublicBookingDate:()=>{},
    buildLocalAvailabilityGraphic:(date,ids,options)=>{requested={date,ids,options};return {openHour:8,closeHour:22,courts:[{id:'c1',slots:Array.from({length:14},(_,i)=>({hour:i+8,state:free.includes(i+8)?'free':'unavailable'}))}]};}});
  const start=source.indexOf('  function buildLocalAdminRescheduleOptions(');
  const end=source.indexOf('  const localRescheduleNotificationSummary',start);
  vm.runInContext(source.slice(start,end)+'\nthis.options=buildLocalAdminRescheduleOptions;',context);
  return {options:date=>context.options('QA',date||'2026-09-21'),request:()=>requested};
}

test('manual reschedule shows complete original-duration blocks within free hours',()=>{
  const h=harness();const result=h.options();
  assert.equal(result.duration,3);
  assert.deepEqual(Array.from(result.oldSlots),[14,15,16]);
  assert.deepEqual(Array.from(result.starts),[8,12,13,14,15,16,17,18,19]);
  assert.deepEqual(Array.from(h.request().options.excludeBookingRefs),['QA']);
  assert.equal(h.options('2026-09-20').starts.includes(14),false);
});

test('manual availability rejects malformed durations, inactive bookings, pending requests and guest roles',()=>{
  for(const booking of [{duration:2},{slots:[14,16,17]},{slots:[14,14,15]},{slots:[null,1,2]},{slots:['',1,2]},{status:'cancelled'}]) {
    assert.throws(()=>harness({booking}).options());
  }
  assert.throws(()=>harness({pending:true}).options(),/pending reschedule/);
  assert.throws(()=>harness({role:'host'}).options(),/active dashboard/);
  assert.equal(harness({role:'staff'}).options().duration,3);
  assert.equal(harness({free:[]}).options().starts.length,0);
});

test('server manual rescheduling binds original snapshot, locks slots, and preserves pricing',()=>{
  const mutation=sql.slice(sql.indexOf('create or replace function public.reschedule_booking_transaction('));
  assert.match(sql,/has_account_role\(array\['owner','court_owner','staff'\]\)/);
  assert.match(sql,/booking_reschedule_active_items/);
  assert.match(mutation,/for update/);
  assert.match(mutation,/paddle-rage-reschedule-family/);
  assert.match(mutation,/paddle-rage-booking-slot/);
  assert.match(mutation,/p_expected_date is distinct from booking.date or expected_slots is distinct from original_slots/);
  assert.match(mutation,/p_expected_court_id is distinct from booking.court_id/);
  assert.match(mutation,/duration_hours := cardinality\(original_slots\)/);
  assert.ok(mutation.indexOf('booking_reschedule_schedule_available')<mutation.indexOf('update public.bookings set'));
  assert.doesNotMatch(mutation,/set\s+(?:total|rate|payment_status)\s*=/);
  assert.match(mutation,/revoke all[\s\S]*from public,anon/);
});
