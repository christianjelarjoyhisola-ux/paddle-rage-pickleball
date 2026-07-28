const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = path => fs.readFileSync(path, 'utf8');

test('public OCR clients request one-use Turnstile tokens centrally', () => {
  const client = read('supabase-config.js');
  const page = read('index.html');

  assert.match(client, /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
  assert.match(client, /action:\s*action === PB_TURNSTILE_ACTION \? PB_TURNSTILE_ACTION : action/);
  assert.match(client, /execution:\s*'execute'/);
  assert.match(client, /appearance:\s*'interaction-only'/);
  assert.match(client, /turnstileChallenge\s*=\s*await _pbAcquireReceiptTurnstile\(\)/);
  assert.match(client, /form\.append\('turnstileToken',\s*requestPayload\.turnstileToken\)/);
  assert.match(client, /turnstileChallenge\?\.reset\(\)/);
  assert.ok(
    (page.match(/DB\.verifyGcashReceipt\(/g) || []).length >= 3,
    'booking, Open Play, and host-session OCR must share the guarded client',
  );
});

test('server validates Turnstile before receipt storage and Vision', () => {
  const edge = read('supabase/functions/verify-gcash-receipt/index.ts');
  const parser = read('supabase/functions/_shared/gcash-receipt.ts');
  const finalizer = read(
    'supabase/migrations/20260728120000_gcash_receipt_auto_verification.sql'
  );
  const gate = edge.indexOf('const turnstileResult = await verifyTurnstileToken');
  const storage = edge.indexOf('db.storage.from("receipts").upload');
  const vision = edge.indexOf('const ocr = await runOCR');
  const dimensionGate = edge.indexOf('if (!receiptImageSafeToDecode(bytes, contentType))');
  const imageDecode = edge.indexOf('Image.decode(bytes)');

  assert.ok(gate > 0, 'Turnstile gate must exist');
  assert.ok(storage > gate, 'Storage must happen after Turnstile siteverify');
  assert.ok(vision > storage, 'Google Vision must happen after the gate and storage');
  assert.ok(dimensionGate > 0 && imageDecode > dimensionGate, 'pixel dimensions must be capped before Image.decode');
  assert.match(edge, /secret:\s*Deno\.env\.get\("TURNSTILE_SECRET_KEY"\)/);
  assert.match(edge, /remoteIp:\s*turnstileRemoteIp\(req\)/);
  assert.match(edge, /canViewBookingReceipt\(caller\.account, caller\.userId, booking\)/);
  assert.match(edge, /canViewHostSessionReceipt\(/);
  assert.match(edge, /turnstileToken:\s*String\(form\.get\("turnstileToken"\)/);

  // A clean result may auto-settle only a canonical, already-saved GCash
  // booking. Pre-save registration OCR and every uncertain scan stay advisory.
  assert.match(edge, /parseGcashReceipt\(ocrText,\s*\{\s*typedReference:\s*typedRef\s*\}\)/);
  assert.match(parser, /export function parseGcashReceipt\(/);
  assert.match(edge, /const PAYMENT_WINDOW_MINUTES = 15/);
  assert.match(edge, /minimumOcrConfidence = provider === "gcash" \? 0\.9 : 0\.55/);
  assert.match(edge, /provider === "gcash" && ocrConfidenceSource !== "native"/);
  assert.match(
    edge,
    /const gcashCanAutoApprove = provider === "gcash" &&\s*hasPersistedBooking &&\s*autoPaymentStatus !== null &&\s*flags\.length === 0/
  );
  assert.match(
    edge,
    /gcashCanAutoApprove \? "auto_approved" : provider === "gcash"[\s\S]*?hasProvenDuplicate \? "rejected" : "manual_review"/
  );
  assert.match(
    edge,
    /result === "manual_review"[\s\S]*?statusUpdate\.status = "pending";[\s\S]*?statusUpdate\.payment_status = "for_verification"/
  );

  // Automatic settlement is delegated to one service-role-only transaction;
  // the browser and the Edge Function never claim the ledger piecemeal.
  assert.match(edge, /db\.rpc\(\s*"finalize_gcash_receipt_auto_approval"/);
  assert.match(finalizer, /language plpgsql\s+security definer\s+set search_path = public, pg_temp/i);
  assert.match(
    finalizer,
    /revoke all on function public\.finalize_gcash_receipt_auto_approval\([\s\S]*?\)\s+from public, anon, authenticated/i
  );
  assert.match(
    finalizer,
    /grant execute on function public\.finalize_gcash_receipt_auto_approval\([\s\S]*?\)\s+to service_role/i
  );
});

test('siteverify helper uses Cloudflare official endpoint and validates context', () => {
  const helper = read('supabase/functions/_shared/turnstile.ts');

  assert.match(helper, /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/);
  assert.match(helper, /idempotency_key/);
  assert.match(helper, /form\.set\("remoteip", remoteIp\)/);
  assert.match(helper, /"action-mismatch"/);
  assert.match(helper, /"hostname-mismatch"/);
  assert.match(helper, /result\.success !== true/);
});

test('runtime config exposes only the public key and CSP permits the widget frame', () => {
  const runtime = read('runtime-config.js');
  const headers = read('_headers');

  assert.match(runtime, /turnstileSiteKey:\s*"0x4AAAAAAD4nzq_UBKjDttlu"/);
  assert.doesNotMatch(runtime, /TURNSTILE_SECRET_KEY/);
  assert.match(headers, /frame-src https:\/\/challenges\.cloudflare\.com/);
});
