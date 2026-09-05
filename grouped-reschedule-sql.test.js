const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname,
  'supabase/migrations/20260905180000_admin_grouped_reschedule.sql'), 'utf8');

test('batch rescheduling authorizes active dashboard roles and binds an exact persisted booking family', () => {
  assert.match(sql, /has_account_role\(array\['owner','court_owner','staff'\]\)/);
  assert.match(sql, /where b\.ref = btrim\(p_ref\)/);
  assert.match(sql, /b\.booking_group_ref = anchor\.booking_group_ref/);
  assert.match(sql, /selected_refs <@ family_refs/);
  assert.match(sql, /locked_anchor\.booking_group_ref is distinct from anchor\.booking_group_ref/);
  assert.match(sql, /booking\.booking_group_ref is distinct from anchor\.booking_group_ref/);
  assert.doesNotMatch(sql, /(?:email|gcash_ref|payment_method)\s*=/i, 'payment/customer similarity must not authorize batch membership');
  assert.match(sql, /revoke all on function public\.reschedule_bookings_transaction\(text,jsonb\) from public,anon/);
  assert.match(sql, /grant execute on function public\.reschedule_bookings_transaction\(text,jsonb\) to authenticated/);
});

test('every selected child has a bounded, typed schedule with its complete original snapshot', () => {
  assert.match(sql, /jsonb_array_length\(p_changes\) not between 1 and 8/);
  assert.match(sql, /cardinality\(family_refs\), 0\) not between 1 and 8/);
  assert.match(sql, /count\(distinct ref\)[\s\S]{0,100}cardinality\(selected_refs\)/);
  assert.match(sql, /jsonb_typeof\(requested_change->'startHour'\) is distinct from 'number'/);
  assert.match(sql, /jsonb_typeof\(requested_change->'expectedSlots'\) is distinct from 'array'/);
  assert.match(sql, /'expectedDate'\)::date is distinct from booking\.date/);
  assert.match(sql, /'expectedCourtId' is distinct from booking\.court_id/);
  assert.match(sql, /expected_slots is distinct from original_slots/);
  assert.match(sql, /duration_hours := cardinality\(original_slots\)/);
  assert.match(sql, /date '2026-09-19'/);
  assert.match(sql, /statement_timestamp\(\)\)::date \+ 366/);
  assert.match(sql, /requested_start \+ duration_hours > 24/);
});

test('batch locking matches guest requests and occupancy before any schedule write', () => {
  const familyLock = sql.indexOf("pg_advisory_xact_lock(hashtextextended('paddle-rage-reschedule-family|");
  const rowLocks = sql.indexOf('order by b.ref for update');
  const pendingRecheck = sql.indexOf('booking := public.admin_reschedule_booking_context(');
  const targetLocks = sql.indexOf("pg_advisory_xact_lock(hashtextextended('paddle-rage-booking-slot|");
  const availability = sql.indexOf('if not public.booking_reschedule_schedule_available(');
  const write = sql.indexOf('update public.bookings booking_row');
  assert.ok(familyLock > 0 && rowLocks > familyLock && pendingRecheck > rowLocks);
  assert.ok(targetLocks > pendingRecheck && availability > targetLocks && write > availability);
  assert.match(sql, /select distinct[\s\S]*order by key[\s\S]*paddle-rage-booking-slot/);
});

test('destinations cannot overlap each other or consume a sibling reservation', () => {
  assert.match(sql, /group by change\.value->>'courtId', change\.value->>'date', slot\.value\s+having count\(\*\) > 1/);
  assert.match(sql, /candidate_slots, array\[requested_change->>'bookingRef'\]/);
  assert.doesNotMatch(sql, /candidate_slots,\s*(?:selected_refs|family_refs)/);
  assert.doesNotMatch(sql, /(?:disable|drop|create)\s+trigger|session_replication_role|set_config/i,
    'batch rescheduling must preserve existing occupancy and financial triggers');
});

test('one atomic update preserves prices/payments and fails if any selected item was skipped', () => {
  assert.equal([...sql.matchAll(/update public\.bookings\b/g)].length, 1);
  const update = sql.slice(sql.indexOf('update public.bookings booking_row'), sql.indexOf('get diagnostics updated_count'));
  const assignments = [...update.matchAll(/(?:set|,)\s*([a-z_]+)\s*=/g)].map(match => match[1]);
  assert.deepEqual(assignments, ['date', 'slots', 'start_time', 'end_time', 'duration']);
  assert.match(sql, /get diagnostics updated_count = row_count/);
  assert.match(sql, /if updated_count <> cardinality\(selected_refs\) then\s+raise exception/);
  assert.match(sql, /return jsonb_build_object\('bookingRef', anchor\.ref, 'items', normalized_changes\)/);
  assert.doesNotMatch(sql, /exception\s+when/i, 'failures must roll back the complete batch instead of returning partial success');
});
