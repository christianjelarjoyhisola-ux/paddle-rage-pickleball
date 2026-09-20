const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const sql=fs.readFileSync('supabase/migrations/20260921020000_host_booking_grace.sql','utf8');
const admin=fs.readFileSync('admin.html','utf8');
test('admin inline scripts compile with grace actions',()=>{
  for(const match of admin.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if(!/src=|application\/ld\+json/i.test(match[1])) new vm.Script(match[2]);
  }
});
test('grace never creates payment credit and requires authenticated owner role',()=>{
  assert.match(sql,/coalesce\(actor_role, ''\) not in \('owner', 'court_owner'\)/);
  assert.doesNotMatch(sql,/set[^;]*downpayment\s*=/);
  assert.match(sql,/payment_status = 'downpayment_paid'/);
  assert.match(sql,/payment.status = 'pending_review'/);
  assert.match(sql,/least\(paid_time \+ interval '24 hours', earliest_start\)/);
});
test('internal audit is read-only to owners and captures original forfeiture',()=>{
  assert.match(sql,/revoke all on public.host_booking_grace_audit from public, anon, authenticated/);
  assert.match(sql,/grant select on public.host_booking_grace_audit to authenticated/);
  assert.match(sql,/'forfeitedAt', b.forfeited_at/);
  assert.match(sql,/prior_forfeiture_notices/);
  assert.match(sql,/a.booking_refs && v_booking_refs/);
});
