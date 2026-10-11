const test=require('node:test');
const assert=require('node:assert/strict');
const editor=require('./paid-schedule-editor.js');
const item={bookingRef:'one',courtId:'c1',courtName:'Court 1',date:'2026-11-01',slots:['10','11'],duration:2};
test('two paid hours can move to another court or split across courts and dates',()=>{
  assert.equal(editor.validate([item],{one:[{courtId:'c3',date:item.date,hour:10},{courtId:'c3',date:item.date,hour:11}]}),'');
  const slots=[{courtId:'c2',date:item.date,hour:10},{courtId:'c3',date:'2026-11-02',hour:17}];
  assert.equal(editor.validate([item],{one:slots}),'');
  assert.equal(editor.blocks(slots).length,2);
  assert.deepEqual(editor.changes([item],{one:slots})[0].expectedSlots,['10','11']);
});
test('hours cannot be added or removed and unchanged schedules cannot save',()=>{
  assert.match(editor.validate([item],{one:[]}),/exactly 2/);
  assert.match(editor.validate([item],{one:editor.initialSlots(item)}),/different court/);
  assert.match(editor.validate([item],{one:[...editor.initialSlots(item),{courtId:'c3',date:item.date,hour:12}]}),/exactly 2/);
});
test('duplicate slots across portions are rejected but simultaneous different courts are allowed',()=>{
  const a={...item,duration:1,slots:['10']}, b={...a,bookingRef:'two',courtId:'c2'};
  const s={courtId:'c3',date:item.date,hour:12};
  assert.match(editor.validate([a,b],{one:[s],two:[s]}),/more than once/);
  assert.equal(editor.validate([a,b],{one:[s],two:[{...s,courtId:'c2'}]}),'');
});
test('continuous runs merge and separated times remain separate',()=>{
  const slots=[11,10,14].map(hour=>({courtId:'c1',date:item.date,hour}));
  assert.deepEqual(editor.blocks(slots).map(b=>[b.start,b.end]),[[10,12],[14,15]]);
});
