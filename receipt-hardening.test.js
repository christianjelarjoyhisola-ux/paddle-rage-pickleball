const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = path => fs.readFileSync(path, 'utf8');

test('application no longer loads or requires Cloudflare Turnstile', () => {
  const productionFiles = [
    '.env.example',
    '_headers',
    'deploy-cloudflare-pages.ps1',
    'deploy-edge-functions.ps1',
    'host.html',
    'index.html',
    'supabase-config.js',
    'supabase/functions/host-application/index.ts',
    'supabase/functions/integration-status/index.ts',
    'supabase/functions/submit-public-booking/index.ts',
    'supabase/functions/submit-public-registration/index.ts',
    'supabase/functions/verify-gcash-receipt/index.ts',
  ];

  for (const path of productionFiles) {
    assert.doesNotMatch(read(path), /turnstile|challenges\.cloudflare\.com/i, path);
  }
  assert.equal(fs.existsSync('runtime-config.js'), false);
  assert.equal(fs.existsSync('supabase/functions/_shared/turnstile.ts'), false);
});

test('public receipt OCR flows share the canonical client verifier', () => {
  const page = read('index.html');

  assert.ok(
    (page.match(/DB\.verifyGcashReceipt\(/g) || []).length >= 3,
    'booking, Open Play, and host-session OCR must share the same client',
  );
});

test('receipt verification preserves authorization, resource, and settlement boundaries', () => {
  const edge = read('supabase/functions/verify-gcash-receipt/index.ts');
  const parser = read('supabase/functions/_shared/gcash-receipt.ts');
  const finalizer = read(
    'supabase/migrations/20260728120000_gcash_receipt_auto_verification.sql'
  );
  const storage = edge.indexOf('db.storage.from("receipts").upload');
  const vision = edge.indexOf('const ocr = await runOCR');
  const dimensionGate = edge.indexOf('if (!receiptImageSafeToDecode(bytes, contentType))');
  const imageDecode = edge.indexOf('Image.decode(bytes)');
  const persistedBranch = edge.indexOf('if (persistedRow) {');
  const persistedAuthorization = edge.indexOf(
    'canViewBookingReceipt(caller.account, caller.userId, booking)',
    persistedBranch,
  );
  const persistedDenial = edge.indexOf(
    'Receipt verification is not authorized for this booking',
    persistedAuthorization,
  );

  assert.ok(storage > 0 && vision > storage, 'receipt storage must complete before Google Vision runs');
  assert.ok(dimensionGate > 0 && imageDecode > dimensionGate, 'pixel dimensions must be capped before Image.decode');
  assert.ok(
    persistedBranch > 0 && persistedAuthorization > persistedBranch &&
      persistedDenial > persistedAuthorization && storage > persistedDenial,
    'persisted receipt writes must be authorized before Storage or OCR',
  );

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

test('browser configuration does not expose server keys and CSP blocks frames', () => {
  const headers = read('_headers');

  if (fs.existsSync('runtime-config.js')) {
    const runtime = read('runtime-config.js');
    assert.doesNotMatch(runtime, /\b(?:serviceRole|secret|private)(?:Key|_KEY)\b/i);
  }
  assert.match(headers, /frame-src 'none'/);
});
