const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const admin = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const start = admin.indexOf('function fmtHour(');
const end = admin.indexOf('async function exportCSV()', start);
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides = {}) {
  const rows = overrides.rows || [
    { ref:'PB-GROUP-A', courtId:'c1', courtName:'Court 1', date:'2026-10-10', slots:[8,9,10], duration:3, startTime:'8:00 AM', endTime:'11:00 AM', status:'confirmed', groupRef:'PB-GROUP-G' },
    { ref:'PB-GROUP-B', courtId:'c2', courtName:'Court 2', date:'2026-10-10', slots:[12,13], duration:2, startTime:'12:00 PM', endTime:'2:00 PM', status:'confirmed', groupRef:'PB-GROUP-G' },
  ];
  const group = { isGroup:true, primaryRef:rows[0].ref, fullName:'Test Guest', displayRef:'PB-GROUP', items:rows, allItems:rows };
  const elements = new Map();
  const document = { activeElement:null, body:{style:{overflow:''}}, createElement:()=>element() };
  function element() {
    const classes = new Set();
    return { value:'',textContent:'',disabled:false,hidden:false,inert:false,dataset:{},attributes:{},children:[],isConnected:true,
      classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)},
      setAttribute(name,value) { this.attributes[name]=value; },
      replaceChildren(...children) { this.children=children; this.value=children[0]?.value||''; },
      querySelector() { return this; },querySelectorAll() { return []; },
      focus() { document.activeElement=this; },
    };
  }
  const get = id => { if(!elements.has(id)) elements.set(id,element()); return elements.get(id); };
  const calls = { moves:[],emails:[],updates:[],toasts:[] };
  const snapshot = (ref,date,starts=[15,18],patch={}) => {
    const row=rows.find(row=>row.ref===ref);
    return {bookingRef:ref,courtId:row.courtId,date,duration:row.slots.length,starts,oldDate:row.date,oldSlots:[...row.slots],...patch};
  };
  const canonicalResult = changes => ({items:changes.map(change=>{
    const row=rows.find(row=>row.ref===change.bookingRef);
    return {bookingRef:row.ref,date:change.date,slots:row.slots.map((_,i)=>change.startHour+i),duration:row.duration,
      oldDate:row.date,oldSlots:[...row.slots],oldStartTime:row.startTime,oldEndTime:row.endTime,
      startTime:`${change.startHour-12}:00 PM`,endTime:`${change.startHour+row.duration-12}:00 PM`};
  })});
  const context=vm.createContext({
    document,console,Date,$:get,requestAnimationFrame:callback=>callback(),
    _pbMinimumPublicBookingDate:()=> '2026-09-19',phDateKeyFromTimestamp:()=> '2026-09-20',fmtD:date=>date,
    isPlaceholderHold:()=>false,pendingRescheduleRequestForBooking:()=>null,hostBalanceReviewState:()=> 'clear',
    jsArg:value=>value,esc:value=>String(value??''),getBookingGroupByRef:async()=>group,
    closeModal(){},closeBookingDetails(){},renderBookings:async()=>{},renderDash(){},
    toast:(...args)=>calls.toasts.push(args),notifyBookingUpdateSafe:async(...args)=>calls.updates.push(args),
    DB:{getBookingByRef:async ref=>rows.find(row=>row.ref===ref),
      getAdminRescheduleOptions:overrides.options || (async(ref,date)=>snapshot(ref,date)),
      rescheduleBookingsTransaction:async(anchor,changes)=>{calls.moves.push([anchor,plain(changes)]);return overrides.move?overrides.move(anchor,changes):canonicalResult(changes);},
      sendGroupedRescheduleEmail:async payload=>{calls.emails.push(plain(payload));return {ok:true};},
    },
  });
  vm.runInContext(`${admin.slice(start,end)}\nthis.grsTest={get state(){return _grsState}}`,context);
  // DOM population is supplied here; production asynchronous selection logic runs unchanged.
  context.grsRenderItems=state=>state.items.forEach((item,index)=>{
    get('grsDate'+index).value=item.newDate;get('grsTime'+index).value='';get('grsCheck'+index).checked=item.selected;
  });
  async function open() { await context.openRescheduleModal(rows[0].ref); }
  function choose(index,start=15) { get('grsTime'+index).value=String(start);context.grsUpdateSelection(index); }
  return {context,rows,group,get,calls,snapshot,canonicalResult,open,choose};
}

test('group row and details expose rescheduling, including all stored rows and unequal durations',async()=>{
  const h=harness();await h.open();
  assert.match(h.context.bookingRescheduleActionButton(h.group),/Reschedule bookings/);
  const details=admin.slice(admin.indexOf("$('bookingDetailsActions').innerHTML"),admin.indexOf('async function resendHostBalanceNotice'));
  assert.match(details,/bookingRescheduleActionButton\(b\)/);
  assert.deepEqual(h.get('grsTime0').children.map(x=>x.textContent),['Choose an available time','3:00 PM – 6:00 PM','6:00 PM – 9:00 PM']);
  assert.deepEqual(h.get('grsTime1').children.map(x=>x.textContent),['Choose an available time','3:00 PM – 5:00 PM','6:00 PM – 8:00 PM']);
  assert.equal(h.get('grsSaveBtn').disabled,true);
  h.group.items=[h.rows[0]];await h.open();assert.equal(h.context.grsTest.state.items.length,2,'stored allItems must not be dropped by display deduplication');
});

test('subset save submits one atomic call with original court/date/slots and notifies once after success',async()=>{
  const pending=deferred();const h=harness({move:()=>pending.promise});await h.open();
  h.context.grsToggleItem(0,false);h.choose(1,18);
  const save=h.context.saveGroupReschedule();await h.context.saveGroupReschedule();h.context.closeGroupRescheduleModal();
  assert.ok(h.context.grsTest.state);assert.equal(h.calls.moves.length,1);assert.equal(h.calls.emails.length,0);
  assert.deepEqual(h.calls.moves[0],['PB-GROUP-B',[{bookingRef:'PB-GROUP-B',date:'2026-10-10',startHour:18,expectedDate:'2026-10-10',expectedSlots:[12,13],expectedCourtId:'c2'}]]);
  pending.resolve(h.canonicalResult(h.calls.moves[0][1]));await save;
  assert.equal(h.context.grsTest.state,null);assert.equal(h.calls.emails.length,1);assert.equal(h.calls.updates.length,1);
  assert.equal(h.calls.emails[0].items.length,1);assert.equal(h.calls.emails[0].items[0].newDuration,2);
});

test('mutual destination overlap is blocked even when each server range is independently available',async()=>{
  const h=harness();h.rows[1].courtId='c1';h.rows[1].courtName='Court 1';await h.open();h.choose(0,15);h.choose(1,15);
  assert.equal(h.get('grsSaveBtn').disabled,true);assert.match(h.get('grsSummary').textContent,/overlap/);
  await h.context.saveGroupReschedule();assert.equal(h.calls.moves.length,0);
  h.choose(1,18);assert.equal(h.get('grsSaveBtn').disabled,false);
});

test('stale date responses and unchecked in-flight items cannot restore a usable selection',async()=>{
  const h=harness();await h.open();const older=deferred(),newer=deferred();
  h.context.DB.getAdminRescheduleOptions=(ref,date)=>date==='2026-10-11'?older.promise:newer.promise;
  h.get('grsDate0').value='2026-10-11';const oldLoad=h.context.grsLoadAvailability(0);
  h.get('grsDate0').value='2026-10-12';const newLoad=h.context.grsLoadAvailability(0);
  newer.resolve(h.snapshot(h.rows[0].ref,'2026-10-12',[18]));await newLoad;
  older.resolve(h.snapshot(h.rows[0].ref,'2026-10-11',[12]));await oldLoad;
  assert.equal(h.context.grsTest.state.items[0].optionsDate,'2026-10-12');assert.equal(h.get('grsTime0').value,'');
  const unchecked=deferred();h.context.DB.getAdminRescheduleOptions=()=>unchecked.promise;
  const load=h.context.grsLoadAvailability(0);h.context.grsToggleItem(0,false);unchecked.resolve(h.snapshot(h.rows[0].ref,'2026-10-12',[12]));await load;
  assert.equal(h.context.grsTest.state.items[0].selected,false);assert.equal(h.context.grsTest.state.items[0].options.length,0);
});

test('bulk date changes clear old choices for selected items and preserve unchecked dates',async()=>{
  const h=harness();await h.open();h.choose(0);h.choose(1);h.context.grsToggleItem(1,false);
  h.get('grsBulkDate').value='2026-10-15';await h.context.grsApplyBulkDate();
  assert.equal(h.get('grsDate0').value,'2026-10-15');assert.equal(h.get('grsTime0').value,'');
  assert.equal(h.get('grsDate1').value,'2026-10-10');assert.equal(h.get('grsSaveBtn').disabled,true);
});

test('empty, invalid snapshot and failed availability keep save blocked and retryable',async()=>{
  const h=harness();await h.open();h.context.grsToggleItem(1,false);
  for(const response of [()=>h.snapshot(h.rows[0].ref,'2026-10-10',[]),()=>h.snapshot(h.rows[0].ref,'2026-10-10',[15],{duration:2}),()=>{throw new Error('Offline')}]){
    h.context.DB.getAdminRescheduleOptions=async()=>response();await h.context.grsLoadAvailability(0);
    assert.equal(h.get('grsSaveBtn').disabled,true);assert.equal(h.get('grsTime0').disabled,true);
  }
  assert.equal(h.get('grsRetry0').hidden,false);
  h.context.DB.getAdminRescheduleOptions=async(ref,date)=>h.snapshot(ref,date,[18]);await h.context.grsLoadAvailability(0);h.choose(0,18);
  assert.equal(h.get('grsSaveBtn').disabled,false);
});

test('failed atomic move refreshes all selected options without sending notifications',async()=>{
  const h=harness({move:async()=>{throw new Error('Another player booked one selected time. Nothing was moved.')}});await h.open();h.choose(0);h.choose(1);
  await h.context.saveGroupReschedule();assert.equal(h.calls.moves.length,1);assert.equal(h.calls.emails.length,0);assert.equal(h.calls.updates.length,0);
  assert.equal(h.get('grsSaveError').hidden,false);assert.match(h.get('grsSaveError').textContent,/Nothing was moved/);
  assert.equal(h.get('grsTime0').value,'');assert.equal(h.get('grsTime1').value,'');assert.equal(h.get('grsSaveBtn').disabled,true);
});

test('inactive items remain unselected, and tampered dates or unlisted hours cannot be saved',async()=>{
  const h=harness();h.rows[1].status='cancelled';await h.open();
  assert.equal(h.context.grsTest.state.items[1].eligible,false);assert.equal(h.context.grsTest.state.items[1].selected,false);
  h.choose(0,16);await h.context.saveGroupReschedule();assert.equal(h.calls.moves.length,0);
  h.choose(0,15);h.get('grsDate0').value='2026-10-20';await h.context.saveGroupReschedule();assert.equal(h.calls.moves.length,0);
});

test('closing and reopening restores scroll and ignores prior availability',async()=>{
  const h=harness();await h.open();const delayed=deferred();h.context.DB.getAdminRescheduleOptions=()=>delayed.promise;
  const old=h.context.grsLoadAvailability(0);h.context.closeGroupRescheduleModal();assert.equal(h.context.document.body.style.overflow,'');
  h.context.DB.getAdminRescheduleOptions=async(ref,date)=>h.snapshot(ref,date,[18]);await h.open();
  delayed.resolve(h.snapshot(h.rows[0].ref,'2026-10-10',[12]));await old;
  assert.deepEqual(plain(h.context.grsTest.state.items[0].options.map(x=>x.start)),[18]);
});

test('an email failure is reported after a successful move without retrying the transaction',async()=>{
  const h=harness();await h.open();h.choose(0);h.choose(1);
  h.context.DB.sendGroupedRescheduleEmail=async()=>{throw new Error('Mail provider unavailable')};
  await h.context.saveGroupReschedule();
  assert.equal(h.calls.moves.length,1);assert.equal(h.context.grsTest.state,null);
  assert.ok(h.calls.toasts.some(([message])=>/Schedules saved.*email could not be delivered/.test(message)));
});

test('oversized stored families are explained before opening a mutation dialog',async()=>{
  const h=harness();h.group.allItems=Array.from({length:9},(_,index)=>({...h.rows[0],ref:'PB-LARGE-'+index}));
  await h.open();assert.equal(h.context.grsTest.state,null);assert.equal(h.calls.moves.length,0);
  assert.ok(h.calls.toasts.some(([message])=>/up to 8 schedules/.test(message)));
});
