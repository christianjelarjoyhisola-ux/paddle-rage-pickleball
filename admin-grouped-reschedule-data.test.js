const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('supabase-config.js','utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function harness({bookings,role='owner',pending=[]}={}) {
  let saved = {bookings:bookings || [
    {ref:'A',groupRef:'GROUP',courtId:'c1',date:'2026-10-10',slots:[8,9,10],duration:3,status:'confirmed',total:900,rate:300,paymentStatus:'paid'},
    {ref:'B',groupRef:'GROUP',courtId:'c2',date:'2026-10-10',slots:[8,9,10],duration:3,status:'confirmed',total:900,rate:300,paymentStatus:'paid'},
    {ref:'C',groupRef:'GROUP',courtId:'c1',date:'2026-10-11',slots:[14,15],duration:2,status:'confirmed',total:600,rate:300,paymentStatus:'paid'},
  ],bookingRescheduleRequests:pending};
  let writes=0;
  const context = vm.createContext({window:{Auth:{getSession:()=>({role,status:'active'})}},
    readDb:()=>clone(saved),writeDb:value=>{saved=clone(value);writes++;},
    _pbAssertPublicBookingDate:date=>{if(!/^2026-10-\d{2}$/.test(date))throw Error('Invalid date');},
    _fmtBookingHour:hour=>`${hour%12||12}:00 ${hour%24<12?'AM':'PM'}`,
    buildLocalAvailabilityGraphic:(date,ids,options)=>({openHour:6,closeHour:22,courts:ids.map(id=>({id,
      slots:Array.from({length:16},(_,index)=>({hour:index+6,state:saved.bookings.some(row=>
        row.courtId===id && row.date===date && !options.excludeBookingRefs.includes(row.ref)
        && row.status==='confirmed' && row.slots.includes(index+6))?'unavailable':'free'}))}))}),
  });
  const optionsStart=source.indexOf('  function buildLocalAdminRescheduleOptions(');
  const optionsEnd=source.indexOf('  const localRescheduleNotificationSummary',optionsStart);
  const batchStart=source.indexOf('  const localRescheduleFamilyKey');
  const batchEnd=source.indexOf('  const localRescheduleCourtId',batchStart);
  vm.runInContext(source.slice(optionsStart,optionsEnd)+source.slice(batchStart,batchEnd)
    +'\nthis.move=applyLocalAdminGroupedReschedule;',context);
  return {get:()=>clone(saved),writes:()=>writes,move:(changes,anchor='A')=>clone(context.move(anchor,changes)),
    change:(ref,date='2026-10-12',startHour=14)=>{
      const b=saved.bookings.find(row=>row.ref===ref);
      return {bookingRef:ref,date,startHour,expectedDate:b.date,expectedCourtId:b.courtId,expectedSlots:[...b.slots]};
    }};
}

test('grouped move atomically preserves each court, duration and payment across courts and dates',()=>{
  const h=harness();const before=h.get();
  const result=h.move([h.change('A'),h.change('B'),h.change('C','2026-10-13',18)]);
  assert.equal(h.writes(),1);assert.equal(result.items.length,3);
  h.get().bookings.forEach((row,index)=>{
    for(const key of ['courtId','duration','total','rate','paymentStatus','groupRef','status']) assert.equal(row[key],before.bookings[index][key]);
  });
  assert.deepEqual(h.get().bookings.map(row=>row.slots),[[14,15,16],[14,15,16],[18,19]]);
});

test('same-court multiple times and different durations can move together or individually',()=>{
  const h=harness();const untouched=h.get().bookings[1];
  h.move([h.change('A','2026-10-12',8),h.change('C','2026-10-12',16)]);
  assert.deepEqual(h.get().bookings[1],untouched);
  assert.deepEqual(h.get().bookings[2].slots,[16,17]);
  const second=h.get().bookings[2];
  h.move([h.change('A','2026-10-14',14)]);
  assert.deepEqual(h.get().bookings[2],second);
});

test('a late conflict or stale snapshot prevents every grouped write',()=>{
  for(const fault of ['overlap','occupied','date','court','slots','duplicate','foreign','unchanged']) {
    const h=harness();const original=h.get();
    const first=h.change('A'),last=h.change('C');
    if(fault==='occupied'){last.date='2026-10-10';last.startHour=8;}
    if(fault==='date')last.expectedDate='2026-10-01';
    if(fault==='court')last.expectedCourtId='c9';
    if(fault==='slots')last.expectedSlots=[14,null];
    if(fault==='duplicate')last.bookingRef='A';
    if(fault==='foreign')last.bookingRef='UNRELATED';
    if(fault==='unchanged'){last.date='2026-10-11';last.startHour=14;}
    if(!['overlap','occupied'].includes(fault) && last.date==='2026-10-12')last.startHour=18;
    assert.throws(()=>h.move([first,last]),undefined,fault);
    assert.equal(h.writes(),0,fault);assert.deepEqual(h.get(),original,fault);
  }
});

test('batch rejects unrelated families, roles, pending items, empty lists and oversized selections',()=>{
  const base=harness().get().bookings;
  for(const [patch,pattern] of [
    [{role:'host'},/active dashboard/],
    [{pending:[{status:'pending',itemRefs:['C']}]},/pending reschedule/],
    [{bookings:base.map(row=>row.ref==='C'?{...row,groupRef:'OTHER'}:row)},/same booking group/],
  ]) {
    const h=harness(patch);assert.throws(()=>h.move([h.change('A'),h.change('C','2026-10-13')]),pattern);assert.equal(h.writes(),0);
  }
  const h=harness();assert.throws(()=>h.move([]),/1 and 8/);
  assert.throws(()=>h.move(Array.from({length:9},()=>h.change('A'))),/1 and 8/);
  const staff=harness({role:'staff'});staff.move([staff.change('A')]);assert.equal(staff.writes(),1);
});

test('production batch adapter uses one RPC and invalidates bookings only after success',async()=>{
  const calls=[];let failure=null;
  const context=vm.createContext({_pbAssertPublicBookingDate:()=>{},_pbClearFastCache:keys=>calls.push(['cache',...keys]),
    _extractFnError:error=>error.message,_pbRpcResultError:()=>Error('bad result'),
    _sb:{rpc:async(name,args)=>{calls.push([name,clone(args)]);return failure?{error:failure}:{data:{items:[{bookingRef:'A'}]}};}}});
  const start=source.indexOf('  async rescheduleBookingsTransaction(');
  const end=source.indexOf('  async getBookingRescheduleOptions(',start);
  vm.runInContext('this.adapter=({'+source.slice(start,end)+'});',context);
  const changes=[harness().change('A')];
  await context.adapter.rescheduleBookingsTransaction(' A ',changes);
  assert.deepEqual(calls,[['reschedule_bookings_transaction',{p_ref:'A',p_changes:changes}],['cache','bookings']]);
  calls.length=0;failure={message:'Slot conflict'};
  await assert.rejects(context.adapter.rescheduleBookingsTransaction('A',changes),/Slot conflict/);
  assert.equal(calls.length,1);
});
