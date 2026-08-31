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
  const providerRegistry = read('supabase/functions/_shared/receipt-providers/index.ts');
  const gotymeParser = read('supabase/functions/_shared/receipt-providers/gotyme.ts');
  const maribankParser = read('supabase/functions/_shared/receipt-providers/maribank.ts');
  const finalizer = read(
    'supabase/migrations/20260901090000_receipt_review_maribank.sql'
  );
  const verifyStart = edge.indexOf('// ── verify a freshly-uploaded receipt');
  const storage = edge.indexOf('db.storage.from("receipts").upload', verifyStart);
  const vision = edge.indexOf('const ocr = await runOCR');
  const dimensionGate = edge.indexOf('if (!receiptImageSafeToDecode(bytes, contentType))');
  const imageDecode = edge.indexOf('Image.decode(bytes)');
  const persistedBranch = edge.indexOf('if (persistedRow) {', verifyStart);
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

  // Dedicated provider parsers keep source-bank evidence separate while all
  // uncertain results stay advisory and automated checks never reject.
  assert.match(edge, /parseProviderReceipt\(provider,\s*ocrText,\s*\{\s*typedReference:\s*typedRef/);
  assert.match(parser, /export function parseGcashReceipt\(/);
  assert.match(providerRegistry, /case "gcash"[\s\S]*?parseGcashReceipt/);
  assert.match(providerRegistry, /case "gotyme"[\s\S]*?parseGotymeToGcashReceipt/);
  assert.match(providerRegistry, /case "maribank"[\s\S]*?parseMaribankToGcashReceipt/);
  assert.match(gotymeParser, /export function parseGotymeToGcashReceipt/);
  assert.match(gotymeParser, /export function verifyGotymeToGcashReceipt/);
  assert.match(maribankParser, /export function parseMaribankToGcashReceipt/);
  assert.match(maribankParser, /export function verifyMaribankToGcashReceipt/);
  assert.match(edge, /const PAYMENT_WINDOW_MINUTES = 15/);
  assert.match(edge, /minimumOcrConfidence = isDedicatedReceiptProvider\(provider\)[\s\S]*?\? 0\.9[\s\S]*?: 0\.55/);
  assert.match(edge, /isDedicatedReceiptProvider\(provider\)[\s\S]*?ocrConfidenceSource !== "native"/);
  assert.match(edge, /const cleanEvidence = !!providerVerification &&[\s\S]*?duplicateClear &&\s*flags\.length === 0/);
  assert.match(edge, /let result: "auto_approved" \| "manual_review" =/);
  assert.match(edge, /bookingCanAutoApprove \|\| hostBalanceCanAutoApprove[\s\S]*?\? "auto_approved"[\s\S]*?: "manual_review"/);
  assert.doesNotMatch(edge, /let result: "auto_approved" \| "manual_review" \| "rejected"/);
  assert.match(
    edge,
    /result === "manual_review"[\s\S]*?statusUpdate\.status = "pending";[\s\S]*?statusUpdate\.payment_status = "for_verification"/
  );

  // Automatic settlement is delegated to one service-role-only transaction;
  // the browser and the Edge Function never claim the ledger piecemeal.
  assert.match(edge, /db\.rpc\(\s*"finalize_digital_receipt_auto_approval"/);
  assert.match(finalizer, /language plpgsql\s+security definer\s+set search_path = public, pg_temp/i);
  assert.match(
    finalizer,
    /revoke all on function public\.finalize_digital_receipt_auto_approval\([\s\S]*?\)\s+from public, anon, authenticated/i
  );
  assert.match(
    finalizer,
    /grant execute on function public\.finalize_digital_receipt_auto_approval\([\s\S]*?\)\s+to service_role/i
  );
});

test('GoTyme and MariBank use dedicated source methods with the shared GCash destination', () => {
  const page = read('index.html');
  const admin = read('admin.html');
  const client = read('supabase-config.js');

  assert.match(page, /id="payOptGotyme"[\s\S]*?GoTyme → GCash/);
  assert.match(page, /id="payOptMaribank"[\s\S]*?MariBank → GCash/);
  assert.match(page, /\['bdopay', 'maya', 'bpi', 'gotyme', 'maribank'\][\s\S]*?\? 'gcash'/);
  assert.match(page, /payment_method_maribank === '1' && receiverReady\('maribank'\)/);
  assert.doesNotMatch(page, /id="gotymeBox"|id="gotymeQrPlaceholder"/);

  assert.match(admin, /id="payMethodGotymeOn"[^>]*\/> GoTyme → GCash/);
  assert.match(admin, /id="payMethodMaribankOn"[^>]*\/> MariBank → GCash/);
  assert.match(admin, /saveSetting\('payment_method_maribank'/);
  assert.doesNotMatch(admin, /id="gotymeNumInput"|id="gotymeNameInput"|saveSetting\('gotyme_merchant_/);

  assert.match(client, /PB_DIGITAL_PAYMENT_METHODS = \['gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'\]/);
  assert.match(client, /payment_method_gotyme: '1'/);
  assert.match(client, /payment_method_maribank: '1'/);
});

test('automated uncertainty queues owner review while owners retain both deliberate decisions', () => {
  const page = read('index.html');
  const admin = read('admin.html');
  const client = read('supabase-config.js');
  const hostSessionVerifier = page.slice(
    page.indexOf('async function verifyHostSessionReceipt'),
    page.indexOf('async function submitHostSessionJoin'),
  );
  const openPlayVerifier = page.slice(
    page.indexOf('async function verifyOpReceipt'),
    page.indexOf('async function submitOpenPlay'),
  );
  const paymentPolicy = page.slice(
    page.indexOf('function updatePaymentAmountUI'),
    page.indexOf('function setPayAmount'),
  );

  assert.match(client, /function _pbNormalizeReceiptOutcome[\s\S]*?status: 'manual_review'/);
  assert.match(client, /if \(String\(source\.status \|\| ''\)\.toLowerCase\(\) === 'auto_approved'\) return source/);
  assert.doesNotMatch(hostSessionVerifier, /status === 'rejected'|status: 'rejected'/);
  assert.doesNotMatch(openPlayVerifier, /status === 'rejected'|status: 'rejected'/);
  assert.match(admin, /id="vmRejectBtn"[\s\S]*?❌ Not Received/);
  assert.match(admin, /id="vmConfirmBtn"[\s\S]*?✅ Received — Confirm/);
  assert.match(admin, /function canManuallyResolvePayment\(\)[\s\S]*?\['owner', 'court_owner'\]/);
  assert.match(admin, /DB\.rejectBookingPaymentTransaction\(bkForPay\.primaryRef \|\| ref, reviewReason\.trim\(\)\)/);
  assert.doesNotMatch(
    admin.slice(admin.indexOf('async function rejectPayment'), admin.indexOf('async function delBooking')),
    /updateBookingGroupByRef/,
  );
  assert.match(client, /async rejectBookingPaymentTransaction\(ref, reason\)[\s\S]*?\.rpc\('reject_booking_payment_transaction'/);
  assert.ok((client.match(/receiptVerificationId: Number\(reg\.receiptVerificationId\) \|\| null/g) || []).length >= 2);
  assert.doesNotMatch(admin, /Request clearer proof|Request Clearer Proof/i);
  assert.match(
    paymentPolicy,
    /clean proof can confirm automatically; anything wrong or unclear stays pending for the court owner to choose Confirm Received or Not Received/,
  );
  assert.doesNotMatch(page, /invalid payment may release this reservation/i);
  assert.doesNotMatch(page, /receipt[^\n]*(?:automatically|automatic)[^\n]*(?:reject|cancel|release)/i);
});

test('browser configuration does not expose server keys and CSP blocks frames', () => {
  const headers = read('_headers');

  if (fs.existsSync('runtime-config.js')) {
    const runtime = read('runtime-config.js');
    assert.doesNotMatch(runtime, /\b(?:serviceRole|secret|private)(?:Key|_KEY)\b/i);
  }
  assert.match(headers, /frame-src 'none'/);
});
