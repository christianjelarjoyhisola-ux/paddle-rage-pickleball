const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const read = path => fs.readFileSync(path, 'utf8');
const sql = read('supabase/migrations/20261101090000_owner_payment_reference_correction.sql');
const admin = read('admin.html');
const customer = read('index.html');
const config = read('supabase-config.js');
const freeFormat = read('supabase/migrations/20261101100000_owner_free_format_payment_reference.sql');

const slice = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + 1);
  assert.ok(from >= 0 && to > from, `missing source range ${start} → ${end}`);
  return source.slice(from, to);
};

test('only an active system owner or court owner can correct, and staff cannot', () => {
  assert.match(sql, /v_actor_id is null or v_actor_role not in \('owner', 'court_owner'\)/);
  assert.match(sql, /revoke all on function public\.correct_booking_payment_reference\(text, text, text, boolean, uuid\)\s+from public, anon;/);
  assert.match(sql, /grant execute on function public\.correct_booking_payment_reference\(text, text, text, boolean, uuid\)\s+to authenticated;/);
});

test('correction never weakens duplicate protection', () => {
  // A receipt that itself shows the reused reference is a real duplicate.
  assert.match(sql, /v_receipt_key is not null and v_receipt_key = v_previous_key[\s\S]*?real duplicate/);
  // The corrected value must be free on bookings, Open Play and the paid ledger.
  assert.match(sql, /not \(other_booking\.ref = any\(v_refs\)\)[\s\S]*?= v_corrected_key/);
  assert.match(sql, /from public\.open_play_registrations r/);
  assert.match(sql, /from public\.open_play_host_session_registrations r/);
  assert.match(sql, /from public\.used_gcash_refs ledger[\s\S]*?ledger\.gcash_ref = v_corrected_key/);
  // Provider formats are validated by the same normalizer confirmation uses.
  assert.match(sql, /v_corrected_key := public\.normalize_payment_reference_key\(v_method, p_corrected_reference\)/);
  // The correction never confirms or settles the payment itself.
  assert.doesNotMatch(sql, /set[\s\S]{0,200}payment_status\s*=\s*'(paid|downpayment_paid)'/);
  assert.doesNotMatch(sql, /set[\s\S]{0,200}status\s*=\s*'confirmed'/);
});

test('the receipt scan must agree unless the reviewer ticks the audited image check', () => {
  assert.match(sql, /v_matched := v_receipt_key is not null and v_receipt_key = v_corrected_key/);
  assert.match(sql, /if not v_override then[\s\S]*?raise exception/);
  // Follow-up migration lets both owner roles acknowledge a mismatch, audited.
  assert.match(freeFormat, /drop constraint if exists booking_payment_reference_corrections_override_check/);
  assert.match(freeFormat, /Only the system owner can correct a reference[\s\S]*?\$old\$,\s*''/);
});

test('owners may save any 4-40 character reference; players and the verifier stay strict', () => {
  assert.match(freeFormat, /normalize_payment_reference_key_strict/);
  assert.match(freeFormat, /exception when sqlstate '22023' then[\s\S]*?auth\.uid\(\) is null[\s\S]*?not in \('owner', 'court_owner'\)[\s\S]*?raise;/);
  assert.match(freeFormat, /cleaned !~ '\^\[A-Z0-9\]\{4,40\}\$'/);
  assert.match(freeFormat, /revoke all on function public\.normalize_payment_reference_key\(text, text\)\s+from public, anon, authenticated;/);
  assert.doesNotMatch(freeFormat, /grant execute on function public\.normalize_payment_reference_key/);
});

test('only pending, receipt-backed, unmoved payments are eligible and verification races are blocked', () => {
  assert.match(sql, /not in \('pending', 'verifying'\)[\s\S]*?<> 'for_verification'/);
  assert.match(sql, /receipt_status, ''\)\)\) = 'rejected'/);
  assert.match(sql, /payment_transfer_id is not null/);
  assert.match(sql, /receipt_image_url, ''\)\), ''\) is not null/);
  assert.match(sql, /receipt_verification_leases l[\s\S]*?lease_expires_at > now\(\)/);
  assert.match(sql, /pg_advisory_xact_lock\(\s*hashtextextended\('paddle-rage-public-booking-group:' \|\| v_booking_key, 0\)/);
  assert.match(sql, /for update;/);
});

test('every correction is audited append-only and is idempotent', () => {
  assert.match(sql, /create table if not exists public\.booking_payment_reference_corrections/);
  assert.match(sql, /idempotency_key uuid not null unique/);
  assert.match(sql, /previous_reference text not null/);
  assert.match(sql, /before update or delete on public\.booking_payment_reference_corrections/);
  assert.match(sql, /before truncate on public\.booking_payment_reference_corrections/);
  assert.match(sql, /using \(public\.has_account_role\(array\['owner', 'court_owner'\]\)\)/);
  assert.match(sql, /revoke insert, update, delete, truncate\s+on public\.booking_payment_reference_corrections from authenticated/);
  assert.match(sql, /where c\.idempotency_key = p_idempotency_key[\s\S]*?select false, v_existing\.id/);
});

test('client calls the secured RPC and refreshes cached bookings', () => {
  const remote = slice(config, '  async correctBookingPaymentReference(', '  async getPaymentReferenceCorrections(');
  assert.match(remote, /_sb\.rpc\('correct_booking_payment_reference'/);
  assert.match(remote, /p_scan_override: scanOverride === true/);
  assert.match(remote, /_pbClearFastCache\(\['bookings'\]\)/);
  assert.match(config, /\.from\('booking_payment_reference_corrections'\)[\s\S]*?\.overlaps\('booking_refs', bookingRefs\)/);
});

function adminHelpers(session = { role: 'court_owner' }) {
  const source = slice(admin, 'let _paymentRefCorrectContext = null;', 'async function openDuplicatePaymentTransferFromVerify(){');
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', hidden: false, disabled: false, checked: false, dataset: {}, style: {}, setAttribute() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    sess: session,
    $: el,
    DB: {},
    bookingGroupRowsForPaymentGuard: g => g?.allItems || g?.items || (g ? [g] : []),
    canManuallyResolvePayment: () => ['owner', 'court_owner'].includes(session.role),
    bookingPaymentIsResolved: b => ['paid', 'downpayment_paid', 'rejected'].includes(String(b?.paymentStatus || '').toLowerCase()),
    isDigitalPayment: m => m && m !== 'cash',
    hostBalancePendingPayment: () => null,
  });
  vm.runInContext(source + '\nthis.__set = c => { _paymentRefCorrectContext = c; };', context);
  return { context, el };
}

test('admin offers Correct reference only for mistyped, pending, receipt-backed payments', () => {
  const { context } = adminHelpers();
  const pending = { paymentMethod: 'gcash', status: 'pending', paymentStatus: 'for_verification', receiptImageUrl: 'x.jpg', gcashRef: '1111111111111' };
  assert.equal(context.paymentReferenceCorrectable(pending), true);
  assert.equal(context.paymentReferenceCorrectable({ ...pending, paymentStatus: 'paid', status: 'confirmed' }), false);
  assert.equal(context.paymentReferenceCorrectable({ ...pending, receiptImageUrl: '' }), false);
  assert.equal(context.paymentReferenceCorrectable({ ...pending, paymentTransferId: 'abc' }), false);

  assert.equal(context.paymentReferenceNeedsCorrection({ ...pending, duplicatePaymentRef: true }), true);
  assert.equal(context.paymentReferenceNeedsCorrection({ ...pending, receiptFlags: ['POSSIBLE_DUPLICATE_REF'] }), true);
  assert.equal(context.paymentReferenceNeedsCorrection({ ...pending, receiptExtracted: { ref: '2222 222 222222' } }), true);
  assert.equal(context.paymentReferenceNeedsCorrection({ ...pending, receiptExtracted: { ref: '1111 111 111111' } }), false);
  assert.equal(context.paymentRefCorrectKey('maya', 'b6dc-f633 f08c'), 'B6DCF633F08C');
});

test('admin dialog saves a scan match directly and a mismatch only after the image check', () => {
  const { context, el } = adminHelpers({ role: 'court_owner' });
  context.__set({ method: 'gcash', typed: '1111111111111', scanRef: '2222 222 222222' });
  el('paymentRefCorrectReason').value = 'Player swapped two digits';

  el('paymentRefCorrectInput').value = '2222222222229';
  context.syncPaymentRefCorrect();
  assert.equal(el('paymentRefCorrectSubmit').disabled, true, 'scan mismatch needs the image check');
  assert.equal(el('paymentRefCorrectOverrideWrap').hidden, false, 'court owner can tick the image check');
  el('paymentRefCorrectOverride').checked = true;
  context.syncPaymentRefCorrect();
  assert.equal(el('paymentRefCorrectSubmit').disabled, false, 'court owner may save after ticking');
  el('paymentRefCorrectOverride').checked = false;

  el('paymentRefCorrectInput').value = '2222-222-222222';
  context.syncPaymentRefCorrect();
  assert.equal(el('paymentRefCorrectCheck').dataset.tone, 'ok');
  assert.equal(el('paymentRefCorrectSubmit').disabled, false);

  el('paymentRefCorrectReason').value = 'short';
  context.syncPaymentRefCorrect();
  assert.equal(el('paymentRefCorrectSubmit').disabled, true, 'reason required');
});

test('admin dialog refuses a receipt that shows the reused reference, even for the system owner', () => {
  const { context, el } = adminHelpers({ role: 'owner' });
  context.__set({ method: 'gcash', typed: '1111111111111', scanRef: '1111111111111' });
  el('paymentRefCorrectReason').value = 'Trying to bypass a duplicate';
  el('paymentRefCorrectInput').value = '3333333333333';
  el('paymentRefCorrectOverride').checked = true;
  context.syncPaymentRefCorrect();
  assert.equal(el('paymentRefCorrectCheck').dataset.tone, 'bad');
  assert.equal(el('paymentRefCorrectOverrideWrap').hidden, true);
  assert.equal(el('paymentRefCorrectSubmit').disabled, true);
});

test('a BDO Pay receipt with a non-BN reference can be saved after the image check', () => {
  const { context, el } = adminHelpers({ role: 'court_owner' });
  context.__set({ method: 'bdopay', typed: 'BN2026103100000001', scanRef: '' });
  el('paymentRefCorrectReason').value = 'Receipt is from another app; reference checked by eye';
  el('paymentRefCorrectInput').value = 'REF-5566-7788';
  context.syncPaymentRefCorrect();
  assert.equal(el('paymentRefCorrectSubmit').disabled, true);
  el('paymentRefCorrectOverride').checked = true;
  context.syncPaymentRefCorrect();
  assert.equal(el('paymentRefCorrectSubmit').disabled, false);
});

test('system owner can override an unreadable scan only by ticking the audited override', () => {
  const { context, el } = adminHelpers({ role: 'owner' });
  context.__set({ method: 'gcash', typed: '1111111111111', scanRef: '' });
  el('paymentRefCorrectReason').value = 'Scan unreadable; checked the image by eye';
  el('paymentRefCorrectInput').value = '4444444444444';
  context.syncPaymentRefCorrect();
  assert.equal(el('paymentRefCorrectOverrideWrap').hidden, false);
  assert.equal(el('paymentRefCorrectSubmit').disabled, true);
  el('paymentRefCorrectOverride').checked = true;
  context.syncPaymentRefCorrect();
  assert.equal(el('paymentRefCorrectSubmit').disabled, false);
});

test('verify modal wires the correction button, history line and flag labels', () => {
  assert.match(admin, /id="vmCorrectRefBtn"[^>]*onclick="openPaymentRefCorrectFromVerify\(\)"/);
  assert.match(admin, /id="vmRefCorrection"/);
  assert.match(admin, /paymentReferenceCorrectable\(b\) && paymentReferenceNeedsCorrection\(b\)/);
  assert.match(admin, /REF_CORRECTED:'Reference corrected by owner'/);
  assert.match(admin, /id="paymentRefCorrectModal"[^>]*inert hidden/);
});

test('player sees a calm notice when the typed reference differs from the receipt', () => {
  const source = slice(customer, 'function receiptReferenceMismatchNotice(', 'function receiptReasonFromFlags(');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const notice = context.receiptReferenceMismatchNotice('1111111111111', { extracted: { ref: '2222 222 222222' } }, 'gcash');
  assert.match(notice, /receipt shows reference 2222 222 222222/);
  assert.match(notice, /do not pay again/);
  assert.equal(context.receiptReferenceMismatchNotice('2222222222222', { extracted: { ref: '2222 222 222222' } }, 'gcash'), '');
  assert.equal(context.receiptReferenceMismatchNotice('1111111111111', { extracted: {} }, 'gcash'), '');
  assert.match(customer, /const referenceNotice = receiptReferenceMismatchNotice\(b\.gcashRef, b\._receiptResult, b\.paymentMethod\)/);
});
