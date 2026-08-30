const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const admin = fs.readFileSync('admin.html', 'utf8');
const config = fs.readFileSync('supabase-config.js', 'utf8');
const migration = fs.readFileSync(
  'supabase/migrations/20260830160000_host_booking_parity.sql',
  'utf8',
);

test('host full-payment selection uses one atomic database operation', () => {
  assert.match(admin, /DB\.markHostBookingGroupFullyPaid\(ref\)/);
  assert.match(config, /rpc\('mark_host_booking_group_fully_paid'/);
  assert.match(
    migration,
    /create or replace function public\.mark_host_booking_group_fully_paid\([\s\S]*?set payment_status = 'paid',[\s\S]*?downpayment = booking\.total/,
  );
  assert.match(migration, /order by booking\.ref[\s\S]*?for update/);
  assert.match(migration, /payment\.status = 'pending_review'/);
  assert.match(migration, /if unpaid_count = 0 then/);
});

test('authorized manual settlement expires only an unsubmitted online attempt', () => {
  assert.match(admin, /Record Fully Paid/);
  assert.match(admin, /received the complete remaining balance/i);
  assert.match(admin, /offline or verified manual payment/i);
  assert.match(admin, /settled atomically/i);
  assert.match(
    migration,
    /payment\.status = 'pending_review'[\s\S]*?awaiting Payment Review/,
  );
  assert.match(
    migration,
    /set status = 'expired'[\s\S]*?payment\.status = 'created'/,
  );
  assert.match(migration, /recorded manual full payment/i);
});

test('manual payment RPCs use disambiguated group arrays everywhere', () => {
  assert.match(migration, /v_booking_refs text\[\]/);
  assert.match(migration, /payment\.booking_refs && v_booking_refs/g);
  assert.doesNotMatch(migration, /payment\.booking_refs && booking_refs/);
  assert.match(migration, /restored the booking as manually fully paid/i);
});

test('forfeiture is group-safe and never splits a mixed-payment reservation', () => {
  const forfeitStart = migration.indexOf(
    'create or replace function public.forfeit_overdue_host_booking',
  );
  assert.ok(forfeitStart >= 0, 'forfeit_overdue_host_booking must exist');
  const forfeitSql = migration.slice(forfeitStart);
  assert.match(
    forfeitSql,
    /into v_booking_key[\s\S]*?booking\.ref = p_booking_key[\s\S]*?booking\.booking_group_ref = p_booking_key/,
  );
  assert.match(
    forfeitSql,
    /coalesce\(nullif\(btrim\(booking\.booking_group_ref\), ''\), booking\.ref\) =\s*v_booking_key/,
  );
  assert.match(forfeitSql, /where not coalesce\(inconsistent\.host_booking, false\)/);
  assert.match(forfeitSql, /inconsistent\.payment_status <> 'downpayment_paid'/);
  assert.match(forfeitSql, /status = 'forfeited'/);
  assert.match(forfeitSql, /payment_status = 'deposit_retained'/);
});

test('owners can correct an accidental forfeiture without displacing another booking', () => {
  assert.match(admin, /Restore Fully Paid/);
  assert.match(config, /rpc\('restore_forfeited_host_booking_as_fully_paid'/);
  assert.match(
    migration,
    /create or replace function public\.restore_forfeited_host_booking_as_fully_paid/,
  );
  assert.match(migration, /actor_role not in \('owner', 'court_owner'\)/);
  assert.match(migration, /occupied\.slots && target\.slots/);
  assert.match(migration, /lock table public\.bookings in share row exclusive mode/);
  assert.match(migration, /Prior forfeiture state:/);
  assert.match(migration, /'FORFEITURE_CORRECTION'/);
});

test('online balance approval owns every replay key as a distinct payment', () => {
  const approvalStart = migration.indexOf(
    'create or replace function public.apply_host_booking_balance_payment_decision',
  );
  const submitStart = migration.indexOf(
    'create or replace function public.submit_host_booking_balance_payment',
    approvalStart,
  );
  assert.ok(approvalStart >= 0 && submitStart > approvalStart);
  const approvalSql = migration.slice(approvalStart, submitStart);

  assert.match(
    approvalSql,
    /insert into public\.used_gcash_refs\s*\([\s\S]*?claim_scope[\s\S]*?claim_owner_id[\s\S]*?\)/,
  );
  assert.match(approvalSql, /'booking'/);
  assert.match(
    approvalSql,
    /values\s*\(\s*v_ledger\.ledger_key,\s*v_payment\.verification_ref,\s*v_ledger\.provider_key,\s*'booking',\s*v_payment\.verification_ref\s*\)/,
  );
  assert.match(
    approvalSql,
    /v_ledger_owner is distinct from v_payment\.verification_ref/,
  );
  assert.match(
    approvalSql,
    /claim_scope[\s\S]*?claim_owner_id[\s\S]*?on conflict \(gcash_ref\) do nothing/,
  );
});

test('manual settlement and restoration leave immutable review decisions', () => {
  assert.match(
    migration,
    /insert into public\.payment_review_decisions[\s\S]*?'MANUAL_FULL_PAYMENT'/,
  );
  assert.match(
    migration,
    /insert into public\.payment_review_decisions[\s\S]*?'FORFEITURE_CORRECTION'/,
  );
});
