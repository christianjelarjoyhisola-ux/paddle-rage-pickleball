const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = path => fs.readFileSync(path, 'utf8');
const sql = read('supabase/migrations/20261101130000_owner_record_remittance_payment.sql');
const admin = read('admin.html');
const config = read('supabase-config.js');

const slice = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + 1);
  assert.ok(from >= 0 && to > from, `missing source range ${start} → ${end}`);
  return source.slice(from, to);
};

test('only the system owner can record a received payment', () => {
  assert.match(sql, /if public\.current_account_role\(\) is distinct from 'owner' then/);
  assert.match(sql, /revoke all on function public\.record_booking_fee_remittance_payment\(uuid, numeric, text, text, text, text, text\)\s+from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.record_booking_fee_remittance_payment\(uuid, numeric, text, text, text, text, text\)\s+to authenticated;/);
});

test('recording reuses the standard submit and review rules in one transaction', () => {
  const fn = slice(sql, 'create or replace function public.record_booking_fee_remittance_payment', 'revoke all on function');
  const submit = fn.indexOf('perform public.submit_booking_fee_remittance(');
  const review = fn.indexOf('perform public.review_booking_fee_remittance_payment(');
  assert.ok(submit > 0 && review > submit, 'submit must run before accept');
  assert.match(fn, /'accept',\s+payment\.amount_submitted,/);
  assert.match(fn, /if payment\.status = 'pending' then/);
  assert.doesNotMatch(fn, /insert into public\.booking_fee_remittance_payments/);
  assert.doesNotMatch(fn, /update public\.booking_fee_remittances/);
});

test('the client calls the record RPC only in record mode', () => {
  assert.match(config, /recordAsReceived = false,/);
  assert.match(config, /const rpcName = recordAsReceived \? 'record_booking_fee_remittance_payment' : 'submit_booking_fee_remittance';/);
});

test('the system owner gets a Record Payment action on unpaid statements', () => {
  assert.match(admin, /role === 'owner' && \['awaiting-payment','overdue','rejected'\]\.includes\(status\)[\s\S]{0,200}openRemittancePayment\('\$\{jsArg\(id\)\}',\{record:true\}\)">Record Payment</);
  assert.match(admin, /const ownerRecord = recordMode && role === 'owner';/);
  assert.match(admin, /paymentMethod: recordMode \? \$\('rmPayMethod'\)\.value : 'gcash',/);
  assert.match(admin, /recordAsReceived: recordMode,/);
  assert.match(admin, /<select class="fi" id="rmPayMethod"[^>]*><option value="gcash">GCash<\/option><option value="maya">Maya<\/option><option value="bank_transfer">Bank transfer<\/option><option value="cash">Cash<\/option><option value="other">Other<\/option><\/select>/);
});
