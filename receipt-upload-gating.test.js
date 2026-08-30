const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = path => fs.readFileSync(path, 'utf8');

const page = read('index.html');
const client = read('supabase-config.js');
const edge = read('supabase/functions/verify-gcash-receipt/index.ts');
const admin = read('admin.html');

test('court receipt starts uploading immediately and must finish before Continue', () => {
  const picker = page.slice(
    page.indexOf('function onReceiptPicked'),
    page.indexOf('function clearReceipt'),
  );
  const automaticUpload = page.slice(
    page.indexOf('function beginAutomaticReceiptUpload'),
    page.indexOf('async function canonicalAutoReceiptState'),
  );

  assert.match(picker, /beginAutomaticReceiptUpload\(f\)/);
  assert.doesNotMatch(automaticUpload, /bookingPolicyAgree/);
  assert.match(page, /Tap to attach — uploads automatically/);
  assert.match(page, /button\.disabled = locked/);
  assert.match(page, /\['uploading', 'failed'\]\.includes\(kind\)/);
  assert.match(page, /if \(ready && consentAgreed\) button\.disabled = false/);
  assert.match(page, /Agree Below to Continue/);
  assert.match(page, /Continue — Verify Payment/);
  assert.match(page, /Upload complete — ready to verify/);
  assert.match(page, /Upload complete\. Agree below to continue/);
  assert.match(page, /!\$\('bookingPolicyAgree'\)\?\.checked[\s\S]*?Please agree to the booking and payment policy/);
  assert.match(
    automaticUpload,
    /const stale(?:BeforeUpload)? = sequence !== _receiptUploadSequence \|\|[\s\S]*?file !== _receiptFile \|\|[\s\S]*?bookingRef !== _reservedRef \|\|[\s\S]*?paymentMethod !==/,
  );
});

test('court receipt shows an accessible animated upload state', () => {
  const statusTag = page.match(/<div[^>]*id="bReceiptStatus"[^>]*>/)?.[0] || '';
  const statusHelper = page.slice(
    page.indexOf('function setBookingReceiptUploadMessage'),
    page.indexOf('function receiptUploadStateMatchesCurrentContext'),
  );
  const continueState = page.slice(
    page.indexOf('function setBookingReceiptContinueState'),
    page.indexOf('function beginAutomaticReceiptUpload'),
  );
  const clearing = page.slice(
    page.indexOf('function clearReceipt(options = {})'),
    page.indexOf('async function verifyUploadedReceipt'),
  );
  const verifier = page.slice(
    page.indexOf('async function verifyUploadedReceipt'),
    page.indexOf('function sendCustomerConfirmationEmail'),
  );
  const reducedMotionStart = page.indexOf(
    '@media(prefers-reduced-motion:reduce)',
    page.indexOf('@keyframes receiptStatePop'),
  );
  const reducedMotion = page.slice(reducedMotionStart, page.indexOf('.booking-policy-check', reducedMotionStart));

  assert.match(statusTag, /class="bpay-upload-status"/);
  assert.match(statusTag, /role="status"/);
  assert.match(statusTag, /aria-live="polite"/);
  assert.match(statusTag, /aria-atomic="true"/);
  assert.match(page, /\.bpay-upload-status\[data-state="uploading"\]::before[\s\S]*?animation:receiptUploadSpin[^;]*infinite/);
  assert.match(page, /\.bpay-upload-status\[data-state="uploading"\]::after[\s\S]*?animation:receiptUploadSweep[^;]*infinite/);
  assert.match(page, /#wizNextBtn\.is-receipt-uploading::before[\s\S]*?animation:receiptUploadSpin[^;]*infinite/);
  assert.match(page, /@keyframes receiptUploadSpin/);
  assert.match(page, /@keyframes receiptUploadSweep/);
  assert.match(reducedMotion, /\.bpay-upload-status\[data-state="uploading"\]::before/);
  assert.match(reducedMotion, /#wizNextBtn\.is-receipt-uploading::before/);
  assert.match(reducedMotion, /animation:none !important/);
  assert.match(statusHelper, /status\.dataset\.state = kind/);
  assert.match(statusHelper, /region\.dataset\.uploadState = kind/);
  assert.match(statusHelper, /region\.setAttribute\('aria-busy', String\(kind === 'uploading'\)\)/);
  assert.match(statusHelper, /kind === 'failed' \? 'assertive' : 'polite'/);
  assert.match(continueState, /button\.classList\.toggle\('is-receipt-uploading', uploadActive\)/);
  assert.match(continueState, /button\.setAttribute\('aria-busy', String\(uploadActive\)\)/);
  assert.match(clearing, /setBookingReceiptUploadMessage\('idle', ''\)/);
  assert.match(verifier, /setBookingReceiptUploadMessage\('verifying', 'Checking payment details…'\)/);
});

test('leaving receipt upload restores the shared Next button on earlier wizard steps', () => {
  const continueState = page.slice(
    page.indexOf('function setBookingReceiptContinueState'),
    page.indexOf('function beginAutomaticReceiptUpload'),
  );
  const navigation = page.slice(
    page.indexOf('function wizGoTo'),
    page.indexOf('async function wizNext'),
  );

  const runRegression = new Function(`
    const nextButton = {
      disabled: false,
      textContent: '',
      attrs: new Map(),
      classes: new Set(),
      classList: {
        toggle(name, force) {
          if (force) nextButton.classes.add(name);
          else nextButton.classes.delete(name);
        },
        remove(name) { nextButton.classes.delete(name); },
      },
      setAttribute(name, value) { this.attrs.set(name, String(value)); },
    };
    const simpleNode = () => ({
      textContent: '',
      value: '',
      checked: false,
      classList: { toggle() {}, remove() {} },
    });
    const nodes = {
      wizNextBtn: nextButton,
      wizBackBtn: simpleNode(),
      bPay: { value: 'gcash' },
      bookingPolicyAgree: { checked: false },
    };
    for (let i = 1; i <= 5; i += 1) {
      nodes['wizPanel' + i] = simpleNode();
      nodes['wizStep' + i] = simpleNode();
    }
    const $ = id => nodes[id] || null;
    const document = { querySelector: () => ({ scrollTop: 0 }) };
    let wizStep = 1;
    const wizStartStep = 1;
    let _receiptUploadState = { status: 'uploading' };
    let _bookingSubmissionInFlight = false;
    let _receiptFile = { name: 'receipt.jpg' };
    let _reservedRef = 'PR-REGRESSION';
    let _receiptFinalRetryNeeded = false;
    const renderSlots = () => {};
    const updateWiz3Summary = () => {};
    const updatePrice = () => {};
    const preparePaymentStep = () => {};
    const saveGuestBookingResume = () => {};
    const isDigitalPayMethod = method => method === 'gcash';
    const receiptUploadStateMatchesCurrentContext = () => true;
    const bookingReceiptUploadReady = () => false;

    ${continueState}
    ${navigation}

    wizGoTo(5);
    const duringUpload = {
      disabled: nextButton.disabled,
      busy: nextButton.attrs.get('aria-busy'),
      uploading: nextButton.classes.has('is-receipt-uploading'),
    };
    wizGoTo(3);
    // A receipt promise may settle after the player has already gone Back.
    // Late upload updates must never re-lock a non-Payment wizard step.
    setBookingReceiptContinueState('uploading');
    return {
      duringUpload,
      afterBack: {
        disabled: nextButton.disabled,
        busy: nextButton.attrs.get('aria-busy'),
        uploading: nextButton.classes.has('is-receipt-uploading'),
        label: nextButton.textContent,
      },
    };
  `);

  const state = runRegression();
  assert.deepEqual(state.duringUpload, {
    disabled: true,
    busy: 'true',
    uploading: true,
  });
  assert.deepEqual(state.afterBack, {
    disabled: false,
    busy: 'false',
    uploading: false,
    label: 'Next →',
  });
});

test('final verification reuses the exact staged receipt checkpoint', () => {
  const verifier = page.slice(
    page.indexOf('async function verifyUploadedReceipt'),
    page.indexOf('function sendCustomerConfirmationEmail'),
  );

  assert.match(verifier, /stagedReceiptPath: staged\.stagedReceiptPath/);
  assert.match(verifier, /stagedResult\?\.stagedReceiptPath[\s\S]*?bookingReceiptUploadReady\(receiptFile, bookingRef, method\)/);
  assert.match(client, /async stageBookingReceipt\(payload\)/);
  assert.match(client, /action: String\(payload\?\.action \|\| 'verify'\)/);
  assert.match(client, /_pbBookingAccessToken\(bookingRef, false\)/);
  assert.match(client, /form\.append\('bookingAccessToken', requestPayload\.bookingAccessToken\)/);
});

test('receipt checkpoint adapters recover and discard with the booking bearer boundary', () => {
  const productionStart = client.indexOf('// Upload a court-booking receipt');
  const productionEnd = client.indexOf('// Verify an uploaded GCash', productionStart);
  const production = client.slice(productionStart, productionEnd);
  const requestHelper = client.slice(
    client.indexOf('async function _pbReceiptCheckpointRequest'),
    client.indexOf('function _extractFnError'),
  );

  assert.match(production, /async recoverBookingReceipt\(bookingRef\)/);
  assert.match(production, /_pbReceiptCheckpointRequest\('recover-stage'/);
  assert.match(production, /stagedReceiptPath[\s\S]*?receiptImageUrl/);
  assert.match(production, /async discardBookingReceipt\(payload = \{\}\)/);
  assert.match(production, /_pbReceiptCheckpointRequest\('discard-stage'/);
  assert.match(production, /bookingRef,[\s\S]*?stagedReceiptPath/);
  assert.match(requestHelper, /_pbBookingAccessToken\(bookingRef, false\)/);
  assert.match(requestHelper, /bookingAccessToken: storedBookingToken/);
  assert.match(requestHelper, /'Authorization': authHeader/);
});

test('multipart staging falls back only for immediate transport incompatibility', () => {
  const fallbackGuard = client.slice(
    client.indexOf('function _pbCanFallbackReceiptTransport'),
    client.indexOf('async function _pbReceiptCheckpointRequest'),
  );
  const stageStart = client.indexOf('async stageBookingReceipt(payload)');
  const stageEnd = client.indexOf('async recoverBookingReceipt', stageStart);
  const stage = client.slice(stageStart, stageEnd);

  assert.match(fallbackGuard, /elapsedMs <= 1000/);
  assert.match(fallbackGuard, /name === 'AbortError'/);
  assert.match(fallbackGuard, /code === 'PB_REQUEST_TIMEOUT'/);
  assert.match(fallbackGuard, /timed out\|timeout\|aborted/);
  assert.match(
    stage,
    /catch \(transportError\)[\s\S]*?_pbCanFallbackReceiptTransport\(transportError, transportStartedAt\)[\s\S]*?_pbVerifyReceiptBase64Fallback[\s\S]*?throw transportError/,
  );
});

test('local receipt staging is durable across the booking group and discard preserves verified evidence', () => {
  const local = client.slice(client.indexOf('(function installLocalDataMode()'));
  const localStageStart = local.indexOf('async stageBookingReceipt(payload)');
  const localRecoverStart = local.indexOf('async recoverBookingReceipt', localStageStart);
  const localDiscardStart = local.indexOf('async discardBookingReceipt', localRecoverStart);
  const localVerifyStart = local.indexOf('async verifyGcashReceipt', localDiscardStart);
  const localStage = local.slice(localStageStart, localRecoverStart);
  const localRecover = local.slice(localRecoverStart, localDiscardStart);
  const localDiscard = local.slice(localDiscardStart, localVerifyStart);
  const localStageResult = localStage.slice(localStage.lastIndexOf('return {'));
  const localRecoverResult = localRecover.slice(localRecover.lastIndexOf('return {'));

  assert.match(localStage, /sameBooking \|\| sameGroup/);
  assert.match(localStage, /receiptImageUrl,[\s\S]*?receiptStatus: 'manual_review'/);
  assert.match(localStage, /receiptFlags: \[\]/);
  assert.match(localStage, /receiptVerifiedAt: null/);
  assert.ok(localStage.indexOf('writeDb(db)') < localStage.indexOf('return {'));
  assert.match(localStageResult, /found: true/);
  assert.match(localStageResult, /receiptStatus: 'manual_review'/);
  assert.match(localStageResult, /receiptFlags: \[\]/);
  assert.match(localStageResult, /receiptVerifiedAt: null/);
  assert.match(localStageResult, /verified: false/);
  assert.match(localRecover, /receiptStagedPath/);
  assert.match(localRecover, /!booking\.receiptVerifiedAt/);
  assert.doesNotMatch(localRecover, /receiptStatus[^\n]*=== 'none'/);
  assert.match(localRecoverResult, /receiptVerifiedAt: null/);
  assert.match(localRecoverResult, /verified: false/);
  assert.match(localDiscard, /!booking\.receiptVerifiedAt/);
  assert.match(localDiscard, /_pbLocalStagedReceipts\.delete\(stagedReceiptPath\)/);
  assert.match(localDiscard, /receiptImageUrl: null/);
});

test('local booking mode supports the same atomic multi-court hold entry point', () => {
  const local = client.slice(client.indexOf('(function installLocalDataMode()'));
  const addManyStart = local.indexOf('async addBookings(bookings)');
  const addOneStart = local.indexOf('async addBooking(booking)', addManyStart);
  const addMany = local.slice(addManyStart, addOneStart);

  assert.ok(addManyStart > 0 && addOneStart > addManyStart);
  assert.match(addMany, /batch\.length < 1 \|\| batch\.length > 8/);
  assert.match(addMany, /\[\.\.\.db\.bookings, \.\.\.rows\]/);
  assert.match(addMany, /hasSlotConflict\(existing, booking\)/);
  assert.ok(
    addMany.indexOf('db.bookings.push(...rows)') < addMany.indexOf('writeDb(db)'),
    'the complete conflict-free batch must be persisted together',
  );
  assert.match(local.slice(addOneStart, local.indexOf('async getBookingByRef', addOneStart)), /this\.addBookings\(\[booking\]\)/);
});

test('court Payment Review excludes bookings without durable receipt evidence', () => {
  const paymentReview = admin.slice(
    admin.indexOf('async function renderPaymentReview'),
    admin.indexOf('function switchBookingView'),
  );
  assert.match(
    paymentReview,
    /groupBookings\(bookings\.filter[\s\S]*?\)\)\s*\.filter\(b => !!b\.receiptImageUrl\)\s*\.map/,
  );
});

test('court CTA serializes discard, replacement upload, and uncertain-result recovery', () => {
  const invalidation = page.slice(
    page.indexOf('function invalidateBookingReceiptUpload'),
    page.indexOf('function setBookingReceiptContinueState'),
  );
  const automaticUpload = page.slice(
    page.indexOf('function beginAutomaticReceiptUpload'),
    page.indexOf('async function canonicalAutoReceiptState'),
  );
  const submit = page.slice(
    page.indexOf('async function submitBooking(e)'),
    page.indexOf('/* =============================================\n   RECEIPT UPLOAD + AUTO-VERIFICATION'),
  );
  const recovery = page.slice(
    page.indexOf('async function recoverStoredBookingReceipt'),
    page.indexOf('function onReceiptPicked'),
  );
  const clearing = page.slice(
    page.indexOf('function clearReceipt(options = {})'),
    page.indexOf('async function verifyUploadedReceipt'),
  );

  assert.match(invalidation, /previous\?\.promise \|\| previous\?\.result/);
  assert.match(invalidation, /discardBookingReceiptCheckpoint\(previous/);
  assert.match(invalidation, /_receiptUploadSequence \+= 1/);
  assert.ok(
    automaticUpload.indexOf('const discardBarrier = _receiptDiscardPromise') <
      automaticUpload.indexOf('return DB.stageBookingReceipt'),
    'replacement upload must wait for the prior exact-path discard',
  );
  assert.match(page, /function pickPay\(m\)[\s\S]*?previousMethod !== m[\s\S]*?invalidateBookingReceiptUpload\(\{ discard: true \}\)/);
  const policyListener = page.slice(
    page.indexOf("const policy = $('bookingPolicyAgree');"),
    page.indexOf('function wizGoTo', page.indexOf("const policy = $('bookingPolicyAgree');")),
  );
  assert.match(policyListener, /setBookingReceiptContinueState\(_receiptUploadState\?\.status \|\| 'idle'\)/);
  assert.doesNotMatch(policyListener, /invalidateBookingReceiptUpload/);
  assert.match(clearing, /_bookingSubmissionInFlight && !options\.force/);
  assert.match(clearing, /invalidateBookingReceiptUpload\(\{ discard: options\.discard !== false \}\)/);
  assert.match(submit, /Object\.freeze\(\{[\s\S]*?bookingRef: _reservedRef[\s\S]*?paymentMethod: payMethod[\s\S]*?stagedReceiptPath/);
  assert.match(submit, /_bookingSubmissionInFlight = true[\s\S]*?setBookingSubmissionControlsLocked\(true\)/);
  assert.match(submit, /recoverStoredBookingReceipt\(receiptSnapshot\.bookingRef/);
  assert.match(submit, /keepBookingReceiptForRetry\([\s\S]*?Retry — Verify Payment/);
  assert.match(submit, /finally \{[\s\S]*?_bookingSubmissionInFlight = false[\s\S]*?setBookingSubmissionControlsLocked\(false\)/);
  assert.match(recovery, /DB\.recoverBookingReceipt\(bookingRef\)/);
  assert.match(recovery, /wizGoTo\(5\)[\s\S]*?startSlotCountdown/);
});

test('staging stays inside Paddle receipt authorization and image boundaries', () => {
  const checkpointStart = edge.indexOf(
    'if (["stage", "recover-stage", "discard-stage"].includes(action))',
  );
  const checkpointEnd = edge.indexOf('// ── admin-only:', checkpointStart);
  const checkpoint = edge.slice(checkpointStart, checkpointEnd);
  const tokenAuthorization = checkpoint.indexOf('bookingAccessTokenMatches(');
  const roleAuthorization = checkpoint.indexOf('canViewBookingReceipt(');
  const contentDetection = checkpoint.indexOf('detectReceiptImageContentType(bytes)');
  const dimensionGate = checkpoint.indexOf('receiptImageSafeToDecode(bytes, contentType)');
  const storageWrite = checkpoint.indexOf('db.storage.from("receipts").upload(');
  const stagedMetadata = checkpoint.indexOf('const stagedMetadata', storageWrite);
  const durableAttach = checkpoint.indexOf('bookingUpdateQuery(', stagedMetadata);
  const stagedMetadataBlock = checkpoint.slice(stagedMetadata, durableAttach);

  assert.ok(
    checkpointStart > 0 && checkpointEnd > checkpointStart,
    'receipt checkpoint actions must share one authorization boundary',
  );
  assert.ok(tokenAuthorization > 0 && roleAuthorization > tokenAuthorization);
  assert.ok(
    storageWrite > roleAuthorization,
    'token/role authorization must happen before private Storage is written',
  );
  assert.ok(contentDetection > roleAuthorization && storageWrite > contentDetection);
  assert.ok(dimensionGate > contentDetection && storageWrite > dimensionGate);
  assert.ok(
    stagedMetadata > storageWrite && durableAttach > stagedMetadata,
    'private Storage must be written before its durable booking metadata is attached',
  );
  assert.match(checkpoint, /receiptGroupIsActive\(groupRows\)/);
  assert.match(checkpoint, /receipt_status: "manual_review"/);
  assert.match(checkpoint, /receipt_flags: \[\]/);
  assert.match(checkpoint, /receipt_verified_at: null/);
  assert.match(stagedMetadataBlock, /payment_method: provider/);
  assert.match(stagedMetadataBlock, /payment_flow: provider/);
  assert.doesNotMatch(stagedMetadataBlock, /\n\s*status:/);
  assert.doesNotMatch(stagedMetadataBlock, /\n\s*payment_status:/);
  assert.doesNotMatch(checkpoint, /receiptGroupUsesProvider/);
  assert.match(checkpoint, /\.is\("receipt_verified_at", null\)/);
  assert.doesNotMatch(checkpoint, /runOCR\(|googleVisionOcr\(/);
});

test('recover and discard preserve canonical, unverified checkpoint identity', () => {
  const checkpointStart = edge.indexOf(
    'if (["stage", "recover-stage", "discard-stage"].includes(action))',
  );
  const checkpointEnd = edge.indexOf('// ── admin-only:', checkpointStart);
  const checkpoint = edge.slice(checkpointStart, checkpointEnd);
  const recoverStart = checkpoint.indexOf('if (action === "recover-stage")');
  const discardStart = checkpoint.indexOf('if (action === "discard-stage")');
  const discardEnd = checkpoint.indexOf('let bytes: Uint8Array', discardStart);
  const recover = checkpoint.slice(recoverStart, discardStart);
  const discard = checkpoint.slice(discardStart, discardEnd);

  assert.ok(recoverStart > 0 && discardStart > recoverStart && discardEnd > discardStart);
  assert.match(recover, /stagedReceiptPath: attached\.path/);
  assert.match(recover, /receiptImageHash: attached\.hash/);
  assert.doesNotMatch(recover, /receipt_status[^\n]*===?[^\n]*"none"/);
  assert.match(checkpoint, /String\(body\.stagedReceiptPath \|\| ""\)/);
  assert.match(discard, /stagedReceiptPath[\s\S]*?attached\.path|attached\.path[\s\S]*?stagedReceiptPath/);
  assert.match(discard, /\.is\("receipt_verified_at", null\)/);
  assert.match(discard, /\.remove\(\[attached\.path\]\)/);
});

test('staged verification authorizes before download and checks content-derived path', () => {
  const verifyStart = edge.indexOf('// ── verify a freshly-uploaded receipt');
  const verify = edge.slice(verifyStart);
  const authorization = verify.indexOf(
    'canViewBookingReceipt(caller.account, caller.userId, booking)',
  );
  const download = verify.indexOf('.download(stagedReceiptPath)');

  assert.ok(authorization > 0 && download > authorization);
  assert.match(verify, /\^\[0-9a-f\]\{64\}\\\.\(\?:jpg\|png\|webp\)\$/);
  assert.match(verify, /stagedReceiptPath && stagedReceiptPath !== objectPath/);
  assert.match(verify, /const upErr = stagedReceiptPath\s*\? null/);
});

test('all pages load the receipt-stage client cache key', () => {
  for (const path of ['index.html', 'admin.html', 'host.html', 'login.html', 'player-live.html']) {
    assert.match(read(path), /supabase-config\.js\?v=20260830-receipt-stage-v1/);
  }
});

test('the default test command includes receipt checkpoint lifecycle coverage', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.match(String(packageJson.scripts?.test || ''), /receipt-upload-gating\.test\.js/);
});
