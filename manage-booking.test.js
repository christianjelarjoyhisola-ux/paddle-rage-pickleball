const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('guest management page gives returning players a clear, accessible lookup', () => {
  const html = read('manage-booking.html');
  assert.match(html, /<h1>Manage your booking<\/h1>/);
  assert.match(html, /Paddle Rage booking reference/);
  assert.match(html, /Starts with PB-/);
  assert.match(html, /Don.t enter your bank or e-wallet payment reference/);
  assert.match(html, /id="bookingEmail"[\s\S]*type="email"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /manage-booking\.css/);
  assert.match(html, /manage-booking\.js/);
});

test('guest management UI is read-only, bounded, and never stores or links the email', () => {
  const script = read('manage-booking.js');
  assert.match(script, /const MAX_RESULT_ROWS = 8/);
  assert.match(script, /DB\.getBookingForManagement\(reference, email\)/);
  assert.match(script, /BOOKING_ACCESS_TOKEN_MISSING/);
  assert.match(script, /original browser or device/i);
  assert.match(script, /This page does not change your booking automatically/);
  assert.match(script, /Paid booking payments are final and non-refundable/);
  assert.doesNotMatch(script, /localStorage\.(?:setItem|getItem)[\s\S]{0,120}email/i);
  assert.doesNotMatch(script, /searchParams\.set\([^,]+,\s*email/i);
  assert.doesNotMatch(script, /DB\.(?:updateBooking|deleteBooking|releaseBookingHold)\s*\(/);
});

test('public navigation and confirmation expose Manage booking without putting email in a URL', () => {
  const index = read('index.html');
  assert.match(index, /class="nav-manage-link guest-manage-link" href="manage-booking\.html"/);
  assert.match(index, /Already booked\? <strong>Manage booking<\/strong>/);
  assert.match(index, /<li><a href="manage-booking\.html">Manage booking<\/a><\/li>/);
  assert.match(index, /manage-booking\.html#ref=\$\{encodeURIComponent\(bookingRef\)\}/);
  assert.doesNotMatch(index, /manage-booking\.html\?[^"'\s]*email=/i);
  assert.match(index, /not your GCash, Maya, BDO Pay, BPI, bank, or e-wallet payment reference/);
});

test('booking access proof survives reschedules but legacy tokens retain their old lifetime', () => {
  const adapter = read('supabase-config.js');
  assert.match(adapter, /PB_BOOKING_ACCESS_TOKEN_LEGACY_MAX_AGE_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(adapter, /PB_BOOKING_ACCESS_TOKEN_HARD_MAX_AGE_MS = 400 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(adapter, /function _pbBookingAccessExpiry\(\)/);
  assert.match(adapter, /return Date\.now\(\) \+ PB_BOOKING_ACCESS_TOKEN_HARD_MAX_AGE_MS/);
  assert.match(adapter, /_pbSaveBookingAccessTokens\(cleaned\)/);
  assert.match(adapter, /const accessExpiresAt = _pbBookingAccessExpiry\(batch\)/);
  assert.match(adapter, /async getBookingForManagement\(ref, email\)/);
  assert.match(adapter, /get_public_booking_for_management/);
  assert.match(adapter, /\.trim\(\)\.toUpperCase\(\)/);
});

test('management RPC requires all three proofs and returns only bounded non-PII data', () => {
  const sql = read('supabase/migrations/20260903120000_public_booking_management_lookup.sql');
  assert.match(sql, /get_public_booking_for_management\(\s*p_ref text,\s*p_email text,\s*p_access_token text/s);
  assert.match(sql, /p_access_token, ''\) !~ '\^\[0-9a-fA-F\]\{64\}\$'/);
  assert.match(sql, /customer_access_token_hash = token_hash/);
  assert.match(sql, /lower\(trim\(coalesce\(b\.email, ''\)\)\) = requested_email/);
  assert.match(sql, /time zone 'Asia\/Manila'/);
  assert.match(sql, /::date - 7/);
  assert.match(sql, /limit 8;/i);
  assert.match(sql, /idx_bookings_customer_access_token_hash/i);
  assert.match(sql, /earliest_booking_created_at < \(now\(\) - interval '400 days'\)/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /revoke all on function[\s\S]+from public, anon, authenticated/i);

  const returnShape = sql.match(/returns table \(([\s\S]*?)\)\s*language/i)?.[1] || '';
  for (const privateColumn of [
    'full_name', 'email', 'contact_number', 'gcash_ref', 'receipt_image_url',
    'receipt_extracted', 'customer_access_token_hash', 'host_user_id',
  ]) {
    assert.doesNotMatch(returnShape, new RegExp(`\\b${privateColumn}\\b`, 'i'));
  }
});

test('confirmation email links to management with a fragment, not query-string PII', () => {
  const email = read('supabase/functions/_shared/paddle-rage-email.ts');
  assert.match(email, /manage-booking\.html#ref=\$\{/);
  assert.doesNotMatch(email, /manage-booking\.html\?ref=/);
  assert.match(email, /not your GCash, Maya, BDO Pay, BPI, bank, or e-wallet payment reference/);
  assert.match(email, /View booking status/);
});

test('new page and assets are included in deployment and no-store routing', () => {
  const deploy = read('deploy-cloudflare-pages.ps1');
  const headers = read('_headers');
  const worker = read('_worker.js');
  for (const file of ['manage-booking.html', 'manage-booking.css', 'manage-booking.js']) {
    assert.match(deploy, new RegExp(`"${file.replace('.', '\\.')}"`));
  }
  assert.match(headers, /\/manage-booking\.html[\s\S]*Cache-Control: no-cache/);
  assert.match(headers, /\/manage-booking\.js[\s\S]*Cache-Control: no-store/);
  assert.match(worker, /'\/manage-booking'/);
  assert.match(worker, /'\/manage-booking\.js'/);
});
