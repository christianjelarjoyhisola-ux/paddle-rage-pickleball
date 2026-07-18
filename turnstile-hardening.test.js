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
  assert.match(edge, /const result: "manual_review" \| "rejected" = hasHard/);
  assert.doesNotMatch(edge, /result\s*=\s*"auto_approved"/);
  assert.doesNotMatch(edge, /statusUpdate\.payment_status\s*=\s*fullyPaid/);
  assert.doesNotMatch(edge, /statusUpdate\.status\s*=\s*"confirmed"/);
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
