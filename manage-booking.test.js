const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const readMigrations = () => fs.readdirSync(path.join(root, 'supabase', 'migrations'))
  .filter(file => file.endsWith('.sql'))
  .sort()
  .map(file => read(path.join('supabase', 'migrations', file)))
  .join('\n');

function sqlFunctionBody(sql, functionName) {
  const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\b`, 'i'));
  if (start < 0) return '';
  const end = sql.indexOf('\n$$;', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 4);
}

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
  assert.match(script, /DB\.getBookingForManagement\(reference, email(?:,\s*[^)]*)?\)/);
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
  assert.match(adapter, /async getBookingForManagement\(ref, email(?:, options = \{\})?\)/);
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

test('owner preview RPC is independently authenticated, owner-only, bounded, and privacy-safe', () => {
  const migrations = readMigrations();
  const ownerRpc = sqlFunctionBody(migrations, 'get_owner_booking_for_management');
  assert.ok(ownerRpc, 'owner preview RPC migration is required');

  assert.match(ownerRpc, /get_owner_booking_for_management\(\s*p_ref text,\s*p_email text\s*\)/s);
  assert.match(ownerRpc, /security definer/i);
  assert.match(ownerRpc, /set search_path\s*=\s*public,\s*pg_temp/i);
  assert.match(ownerRpc, /auth\.uid\(\) is null[\s\S]*?from public\.accounts[\s\S]*?\.id = auth\.uid\(\)[\s\S]*?\.status = 'active'[\s\S]*?\.role = 'owner'/i);
  assert.doesNotMatch(ownerRpc, /\.role\s+in\s*\([^)]*(?:court_owner|staff|host)/i);
  assert.match(ownerRpc, /lower\(trim\(coalesce\(b\.email, ''\)\)\) = requested_email/i);
  assert.match(ownerRpc, /limit 8;/i);

  const returnShape = ownerRpc.match(/returns table \(([\s\S]*?)\)\s*language/i)?.[1] || '';
  for (const privateColumn of [
    'full_name', 'email', 'contact_number', 'gcash_ref', 'receipt_image_url',
    'receipt_extracted', 'customer_access_token_hash', 'host_user_id',
  ]) {
    assert.doesNotMatch(returnShape, new RegExp(`\\b${privateColumn}\\b`, 'i'));
  }

  const grants = migrations.slice(migrations.indexOf(ownerRpc) + ownerRpc.length);
  assert.match(grants, /revoke all on function public\.get_owner_booking_for_management\(text, text\)[\s\S]{0,120}from public, anon, authenticated/i);
  assert.match(grants, /grant execute on function public\.get_owner_booking_for_management\(text, text\)[\s\S]{0,80}to authenticated/i);
  assert.doesNotMatch(grants, /grant execute on function public\.get_owner_booking_for_management\(text, text\)[\s\S]{0,80}to anon/i);
});

test('live adapter uses the verified account-role helper for owner preview and preserves guest proof lookup', () => {
  const adapter = read('supabase-config.js');
  const contextStart = adapter.indexOf('async getBookingManagementViewerContext()');
  const contextEnd = adapter.indexOf('\n  async getBookingForManagement(', contextStart);
  const contextMethod = contextStart < 0 ? '' : adapter.slice(contextStart, contextEnd < 0 ? undefined : contextEnd);
  const start = adapter.indexOf('async getBookingForManagement(ref, email');
  const end = adapter.indexOf('\n  async updateBooking(', start);
  const method = start < 0 ? '' : adapter.slice(start, end < 0 ? undefined : end);
  assert.ok(contextMethod, 'live viewer-context adapter is required');
  assert.ok(method, 'remote management adapter is required');

  assert.match(contextMethod, /_pbCurrentAccountRole\(\)/);
  assert.match(contextMethod, /isSystemOwner:\s*role\s*===\s*['"]owner['"]/);
  assert.doesNotMatch(contextMethod, /Auth\.getSession\s*\(/, 'cached browser metadata must not identify a live owner');
  assert.match(method, /_pbCurrentAccountRole\(\)/);
  assert.match(method, /options\?\.ownerPreview\s*===\s*true/);
  assert.match(method, /accountRole\s*!==\s*['"]owner['"]/);
  assert.match(method, /get_owner_booking_for_management/);
  assert.match(method, /managementAccess:\s*['"]owner_preview['"]/);
  assert.doesNotMatch(method, /Auth\.getSession\s*\(/, 'cached browser metadata must not authorize owner preview');

  assert.match(method, /_pbBookingAccessToken\(/);
  assert.match(method, /BOOKING_ACCESS_TOKEN_MISSING/);
  assert.match(method, /get_public_booking_for_management/);
  assert.match(method, /p_access_token:\s*accessToken/);
  assert.ok(
    method.indexOf('get_owner_booking_for_management') < method.indexOf('BOOKING_ACCESS_TOKEN_MISSING'),
    'an authenticated owner must not be rejected merely because the original-device token is absent',
  );
});

test('admin booking details offers an owner-only fragment preview without URL email data', () => {
  const admin = read('admin.html');
  const start = admin.indexOf('function openOwnerBookingPreview');
  const end = admin.indexOf('\n}', start);
  const previewFunction = start < 0 ? '' : admin.slice(start, end < 0 ? undefined : end + 2);
  assert.ok(previewFunction, 'booking details must expose an explicit owner preview action');
  assert.match(previewFunction, /manage-booking\.html#ref=/i);
  assert.match(previewFunction, /ownerPreview=1/i);
  assert.match(previewFunction, /encodeURIComponent\(/);
  assert.doesNotMatch(previewFunction, /email|b\.email/i);
  assert.match(admin, /role\s*===\s*['"]owner['"][\s\S]{0,1000}openOwnerBookingPreview/i);
  assert.doesNotMatch(admin, /manage-booking\.html\?ref=/i);
  assert.doesNotMatch(admin, /manage-booking\.html[^\n]{0,240}(?:email|b\.email)/i);
});

test('management page visibly identifies owner preview and can return to the unchanged guest path', () => {
  const html = read('manage-booking.html');
  const script = read('manage-booking.js');
  const source = `${html}\n${script}`;

  for (const id of [
    'ownerPreviewBanner', 'ownerPreviewModeButton', 'guestAccessModeButton', 'ownerResultNote',
  ]) {
    assert.match(source, new RegExp(`(?:id=["']${id}["']|getElementById\\(["']${id}["']\\))`));
  }
  assert.match(script, /getBookingManagementViewerContext\(\)/);
  assert.match(script, /ownerPreview\s*:/);
  assert.match(script, /managementAccess\s*===\s*["']owner_preview["']/);
  assert.match(script, /ownerPreview=1/);
  assert.match(script, /login\.html\?next=/i);
  assert.match(script, /encodeURIComponent\(/);
  assert.doesNotMatch(script, /login\.html\?next=[^\n]{0,240}(?:ref|email)/i);
  assert.match(script, /guestAccessModeButton[\s\S]{0,1200}addEventListener\(["']click["']/);

  assert.match(script, /DB\.getBookingForManagement\(reference, email/);
  assert.match(script, /BOOKING_ACCESS_TOKEN_MISSING/);
  assert.match(script, /OWNER_PREVIEW_UNAUTHORIZED/);
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
