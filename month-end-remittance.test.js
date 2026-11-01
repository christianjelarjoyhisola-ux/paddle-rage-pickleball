const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = path => fs.readFileSync(path, 'utf8');
const sql = read('supabase/migrations/20261101120000_month_end_remittance_statements.sql');
const admin = read('admin.html');

const slice = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + 1);
  assert.ok(from >= 0 && to > from, `missing source range ${start} → ${end}`);
  return source.slice(from, to);
};

const closeMonth = slice(sql, 'create or replace function public.booking_fee_close_month', 'revoke all on function public.booking_fee_close_month');

test('the cutoff is the last instant of the previous Manila month, not the run time', () => {
  assert.match(closeMonth, /month_start := date_trunc\('month', timezone\('Asia\/Manila', coalesce\(p_at, now\(\)\)\)\);/);
  assert.match(closeMonth, /cutoff_time := \(month_start at time zone 'Asia\/Manila'\) - interval '1 microsecond';/);
  assert.match(closeMonth, /period_end := \(month_start - interval '1 day'\)::date;/);
  assert.doesNotMatch(closeMonth, /cutoff_time := clock_timestamp\(\)/);
  assert.match(closeMonth, /u\.fee_earned_at <= cutoff_time/);
  assert.match(closeMonth, /a\.effective_at <= cutoff_time/);
});

test('closing is idempotent per month and serialized with fee earning', () => {
  const lock = closeMonth.indexOf('pg_advisory_xact_lock');
  const existing = closeMonth.indexOf('r.cycle_due_on = period_end');
  assert.ok(lock > 0 && existing > lock, 'existing-statement check must run under the ledger lock');
  assert.match(closeMonth, /hashtextextended\('paddle-rage-pickleball-booking-fee-remittance', 0\)/);
  assert.match(closeMonth, /r\.status <> 'cancelled'[\s\S]*?return existing_id;/);
  assert.match(closeMonth, /<= 0 then\s+return null;/);
});

test('only the scheduler can close a month; manual preparation is retired', () => {
  assert.match(sql, /revoke all on function public\.booking_fee_close_month\(timestamptz, timestamptz\)\s+from public, anon, authenticated;/);
  assert.doesNotMatch(sql, /grant execute on function public\.booking_fee_close_month/);
  const prepare = slice(sql, 'create or replace function public.prepare_booking_fee_remittance', 'comment on function public.prepare_booking_fee_remittance');
  assert.match(prepare, /raise exception\s+'Remittance statements are created automatically at the end of each month\.'/);
  assert.match(sql, /'close-booking-fee-month',\s+'5 16 \* \* \*',\s+\$job\$select public\.booking_fee_close_month\(\);\$job\$/);
});

test('October 2026 closes once at the owner-chosen time, Nov 1 1:54 PM PHT', () => {
  assert.match(sql, /select public\.booking_fee_close_month\(\s+'2026-11-01 14:00:00\+08',\s+'2026-11-01 13:54:59\.999999\+08'\s+\);\s+notify pgrst/);
  // An override may only move the cutoff later than month end, never into the future.
  assert.match(closeMonth, /if p_cutoff < cutoff_time or p_cutoff > clock_timestamp\(\) then/);
  assert.match(closeMonth, /cutoff_time := p_cutoff;/);
});

test('statements carry no due date and are never overdue', () => {
  assert.match(sql, /'is_overdue', false,/);
  assert.doesNotMatch(sql, /> r\.cycle_due_on/);
  const nextDue = slice(sql, 'create or replace function public.booking_fee_next_due_on', 'comment on function public.booking_fee_next_due_on');
  assert.match(nextDue, /\+ interval '1 month' - interval '1 day'/);
});

test('the admin page explains month-end statements and hides manual prepare', () => {
  assert.doesNotMatch(admin, /14th/);
  assert.doesNotMatch(admin, /Overdue since/);
  assert.doesNotMatch(admin, /<option value="overdue">/);
  assert.match(admin, /Statements close automatically at the end of each month/);
  assert.match(admin, /prepareBtn\.hidden = true;/);
  assert.doesNotMatch(admin, /Prepare Remittance <span/);
  assert.doesNotMatch(admin, /openRemittanceCancellation\('\$\{jsArg\(/);
});
