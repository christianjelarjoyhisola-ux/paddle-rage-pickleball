const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = file => fs.readFileSync(file, 'utf8');
const migration = read('supabase/migrations/20260719083000_public_data_access_hardening.sql');
const bookingEdge = read('supabase/functions/submit-public-booking/index.ts');
const registrationEdge = read('supabase/functions/submit-public-registration/index.ts');
const telegramEdge = read('supabase/functions/send-telegram-notification/index.ts');
const receiptEdge = read('supabase/functions/verify-gcash-receipt/index.ts');
const confirmationEdge = read('supabase/functions/send-confirmation-email/index.ts');
const bookingStatusEmailEdge = read('supabase/functions/send-booking-status-email/index.ts');
const paymentSessionEdge = read('supabase/functions/create-payment-session/index.ts');
const manageAccountEdge = read('supabase/functions/manage-account/index.ts');
const hostApplicationEdge = read('supabase/functions/host-application/index.ts');
const fullPaymentMigration = read('supabase/migrations/20260719130000_regular_bookings_full_payment.sql');
const gcashParser = read('supabase/functions/_shared/gcash-receipt.ts');
const gcashAutoFinalizer = read(
  'supabase/migrations/20260728120000_gcash_receipt_auto_verification.sql'
);

test('all public creation paths are deployed behind hostname-bound Turnstile', () => {
  const config = read('supabase/config.toml');
  const deploy = read('deploy-edge-functions.ps1');
  assert.match(config, /\[functions\.submit-public-booking\]\s*verify_jwt = true/);
  assert.match(config, /\[functions\.submit-public-registration\]\s*verify_jwt = true/);
  assert.match(config, /\[functions\.host-application\]\s*verify_jwt = true/);
  assert.match(config, /\[auth\][\s\S]*?enable_signup = false/);
  assert.match(config, /https:\/\/paddleragecdo\.ph\/host\.html\?email_verified=1/);
  assert.match(deploy, /"submit-public-booking"/);
  assert.match(deploy, /"submit-public-registration"/);
  assert.match(deploy, /"host-application"/);

  const bookingGate = bookingEdge.indexOf('await verifyTurnstileToken');
  const bookingWrite = bookingEdge.indexOf('db.rpc("submit_public_booking_holds"');
  assert.ok(bookingGate > 0 && bookingWrite > bookingGate);
  assert.match(bookingEdge, /expectedAction: PUBLIC_REGISTRATION_TURNSTILE_ACTION/);

  const registrationGate = registrationEdge.indexOf('await requireRegistrationTurnstile');
  const registrationWrite = registrationEdge.indexOf('"submit_public_open_play_registration"');
  assert.ok(registrationGate > 0 && registrationWrite > registrationGate);
  assert.doesNotMatch(registrationEdge, /if \(paymentMethod === "cash"\)[\s\S]{0,120}requireRegistrationTurnstile/);

  const openPlayTrigger = migration.slice(
    migration.indexOf('create or replace function public.prepare_public_open_play_registration'),
    migration.indexOf('drop trigger if exists a00_prepare_public_open_play_registration'),
  );
  const hostSessionTrigger = migration.slice(
    migration.indexOf('create or replace function public.prepare_public_host_session_registration'),
    migration.indexOf('drop trigger if exists a00_prepare_public_host_session_registration'),
  );
  assert.match(openPlayTrigger, /public\.public_payment_method_ready\(new\.payment_method\)/);
  assert.match(hostSessionTrigger, /public\.public_payment_method_ready\(new\.payment_method\)/);

  const hostGate = hostApplicationEdge.indexOf('await verifyTurnstileToken');
  const hostLookup = hostApplicationEdge.indexOf('await restSelect("accounts"');
  const hostAuth = hostApplicationEdge.indexOf('await createAuthUser(email, password, fullName)');
  const hostStorage = hostApplicationEdge.indexOf('db.storage.from("host-ids").upload');
  const hostWrite = hostApplicationEdge.indexOf('await restInsert("open_play_host_applications"');
  assert.ok(
    hostGate > 0 && hostLookup > hostGate && hostAuth > hostGate &&
      hostStorage > hostGate && hostWrite > hostGate,
  );
  assert.match(hostApplicationEdge, /expectedAction: HOST_APPLICATION_TURNSTILE_ACTION/);
  assert.match(hostApplicationEdge, /const MAX_REQUEST_BYTES = 8 \* 1024 \* 1024/);
  assert.match(hostApplicationEdge, /total > MAX_REQUEST_BYTES[\s\S]*?reader\.cancel\(\)/);
  assert.match(hostApplicationEdge, /\.generateLink\(\{[\s\S]*?type: "signup"/);
  assert.doesNotMatch(hostApplicationEdge, /email_confirm:\s*true/);
  assert.match(hostApplicationEdge, /must verify email ownership before host access can be approved/);
  assert.match(migration, /drop policy if exists open_play_host_applications_insert_public/);
  assert.match(
    migration,
    /revoke insert on table public\.open_play_host_applications\s+from public, anon, authenticated/,
  );
  const client = read('supabase-config.js');
  const hostPage = read('host.html');
  const mainPage = read('index.html');
  assert.match(client, /PB_HOST_APPLICATION_TURNSTILE_ACTION = 'host_application'/);
  assert.match(client, /addOpenPlayHostApplication\(app\)[\s\S]*?return this\.submitOpenPlayHostSignup\(app\)/);
  assert.match(client, /submitOpenPlayHostSignup\(app\)[\s\S]*?_pbAcquireHostApplicationTurnstile\(\)/);
  assert.match(hostPage, /runtime-config\.js/);
  assert.match(hostPage, /result\?\.emailVerificationSent/);
  assert.match(mainPage, /DB\.addOpenPlayHostApplication\(\{[\s\S]*?password,[\s\S]*?gcashNumber,/);
  assert.doesNotMatch(
    hostApplicationEdge,
    /\.from\("accounts"\)[\s\S]{0,180}\.eq\("id", userId\)[\s\S]{0,80}\.catch\(/,
  );
  assert.match(hostApplicationEdge, /fail-safe suspension:/);
  assert.doesNotMatch(hostApplicationEdge, /requestsHostLogin/);
  assert.match(hostApplicationEdge, /if \(password\.length < 8\)/);
  assert.match(hostApplicationEdge, /if \(!validPhone\(gcashNumber\)\)/);
  assert.match(hostApplicationEdge, /const existingAuthUsers = await authUsersByExactEmail\(db, email\)/);
  assert.match(hostApplicationEdge, /\.createUser\(\{[\s\S]*?email_confirm: false/);
  const createUserAt = hostApplicationEdge.indexOf('.createUser({');
  const generateSignupLinkAt = hostApplicationEdge.indexOf('.generateLink({');
  assert.ok(createUserAt > 0 && generateSignupLinkAt > createUserAt);
  assert.match(hostApplicationEdge, /verification_email_sent_at/);
  assert.match(hostApplicationEdge, /body\.action === "resend-verification"/);
  assert.match(hostApplicationEdge, /type: "magiclink"/);
  assert.match(hostApplicationEdge, /resendCount >= 10/);
  assert.match(migration, /verification_email_resend_count between 0 and 10/);
  assert.match(migration, /uq_open_play_host_applications_active_email/);
  assert.match(client, /async function _pbHasActiveAccount\(\)[\s\S]*?_pbCurrentAccountRole\(\)/);
  assert.doesNotMatch(client, /_pbHasAuthenticatedSession/);
  assert.match(client, /resendOpenPlayHostVerification\(email\)/);
  assert.match(hostPage, /Email verified successfully\. Your application is awaiting court owner review/);
  assert.match(hostPage, /_sb\.auth\.signOut\(\{ scope: 'local' \}\)/);
  assert.match(hostPage, /Resend Verification Email/);
});

test('anonymous court holds are atomic service-only writes', () => {
  const bookingSanitizer = bookingEdge.slice(
    bookingEdge.indexOf('function publicBookingRow'),
    bookingEdge.indexOf('Deno.serve'),
  );
  const prepareInsert = migration.slice(
    migration.indexOf('create or replace function public.prepare_public_booking_insert'),
    migration.indexOf('drop trigger if exists a00_prepare_public_booking_insert'),
  );
  const submitHolds = migration.slice(
    migration.indexOf('create or replace function public.submit_public_booking_holds'),
    migration.indexOf('-- Availability is also exposed as an RPC'),
  );

  assert.match(migration, /function public\.submit_public_booking_holds/);
  assert.match(migration, /jsonb_array_length\(p_bookings\) > 8/);
  assert.match(migration, /paddle_rage\.public_booking_submission/);
  assert.match(migration, /pg_advisory_xact_lock\([\s\S]*?paddle-rage-booking:/);
  assert.match(migration, /grant execute on function public\.submit_public_booking_holds\(jsonb, text\)\s+to service_role/i);
  assert.doesNotMatch(migration, /grant insert on table public\.bookings to anon/i);
  assert.doesNotMatch(bookingSanitizer, /payment_status\s*:/);
  assert.doesNotMatch(bookingSanitizer, /\bstatus\s*:/);
  assert.match(prepareInsert, /new\.status := 'verifying'/);
  assert.match(prepareInsert, /new\.payment_status := 'unpaid'/);
  assert.match(submitHolds, /\n\s*'unpaid',\s*\n[\s\S]*?\n\s*'verifying',/);
  assert.doesNotMatch(submitHolds, /booking_payload->>'(?:payment_status|status)'/);
  assert.match(migration, /function public\.public_payment_method_ready/);
  assert.match(migration, /not coalesce\(method_enabled, false\)/);
  assert.match(migration, /has_recipient_name[\s\S]*?has_destination/);
  assert.match(migration, /grant execute on function public\.public_payment_method_ready\(text\)\s+to service_role/);
  assert.match(migration, /public\.public_payment_method_ready\(effective_payment_method\)/);
  const page = read('index.html');
  const admin = read('admin.html');
  assert.match(page, /paymentMethods\.cash = settings\.payment_method_cash === '1'/);
  assert.match(page, /paymentMethods\.gcash = settings\.payment_method_gcash === '1' && receiverReady\('gcash'\)/);
  assert.doesNotMatch(page, /paymentMethods\.[a-z]+ = settings\.payment_method_[a-z]+ !== '0'/);
  assert.match(admin, /const cashOn = settings\.payment_method_cash === '1'/);
  assert.doesNotMatch(admin, /const [a-z]+On = settings\.payment_method_[a-z]+ !== '0'/);
  assert.match(admin, /Add the shared recipient name and a GCash number or QR before enabling/);
});

test('Telegram endpoint authorizes active accounts and sends review-only alerts', () => {
  const auth = telegramEdge.indexOf('db.auth.getUser(token)');
  const account = telegramEdge.indexOf('.from("accounts")');
  const booking = telegramEdge.indexOf('.from("bookings")');
  const send = telegramEdge.indexOf('const delivery = await sendTelegram');
  assert.ok(auth > 0 && account > auth && booking > account && send > booking);
  assert.match(telegramEdge, /account\?\.status !== "active"/);
  assert.match(telegramEdge, /\["owner", "court_owner", "staff"\]\.includes\(role\)/);
  assert.doesNotMatch(telegramEdge, /body\.(fullName|message|contactNumber|courtName)/);
  assert.match(telegramEdge, /notification_event_claims/);
  assert.match(telegramEdge, /function eventMatchesCanonicalState/);
  assert.match(telegramEdge, /new Set\(\["payment_review_needed"\]\)/);
  assert.match(telegramEdge, /receipt !== "manual_review"/);
  assert.match(
    telegramEdge,
    /status === "pending" &&\s*payment === "for_verification"/
  );
  assert.match(telegramEdge, /method !== "cash"/);
  assert.match(telegramEdge, /if \(!eventMatchesCanonicalState\(event, rows\)\)/);
  assert.match(
    receiptEdge,
    /if \(result === "manual_review" && hasPersistedBooking\) \{[\s\S]*?await sendTelegram/
  );
  assert.match(receiptEdge, /function shortTelegramFlags[\s\S]*?flags\.slice\(0, 2\)/);
  assert.match(telegramEdge, /Open the Paddle Rage dashboard/);
  assert.match(telegramEdge, /date,slots,start_time,end_time/);
  assert.match(telegramEdge, /Submitted: \$\{esc\(fmtDateTime\(primary\.created_at\)\)\}/);
  assert.match(telegramEdge, /COURT SCHEDULE[\s\S]*?courtLines[\s\S]*?TOTAL PAYMENT/);
  assert.match(
    receiptEdge,
    /const alertCourts = uniqueBookingRows\(bookingGroup\)[\s\S]*?const totalHours[\s\S]*?const courtLines[\s\S]*?const totalPayment/
  );
  assert.doesNotMatch(
    read('supabase/functions/submit-public-booking/index.ts'),
    /:\s*await notifyNewBooking\(db, savedRows\)/
  );
  assert.match(
    read('supabase/functions/submit-public-registration/index.ts'),
    /function registrationNeedsReview[\s\S]*?receipt === "manual_review"[\s\S]*?\["pending", "for_verification"\]\.includes\(payment\)/
  );
});

test('booking status emails require an admin and use saved cancellation data', () => {
  assert.match(bookingStatusEmailEdge, /requireAdminEmailRequest\(req, db\)/);
  assert.match(bookingStatusEmailEdge, /row\.status !== "cancelled"/);
  assert.match(bookingStatusEmailEdge, /row\.payment_status !== "rejected"/);
  assert.match(bookingStatusEmailEdge, /renderBookingCancellationEmail/);
  assert.doesNotMatch(bookingStatusEmailEdge, /body\?\.email/);
});

test('checkout creation requires booking ownership and uses canonical booking data', () => {
  const providerCall = paymentSessionEdge.indexOf('await createPayMongoCheckoutSession');
  const tokenCheck = paymentSessionEdge.indexOf('const customerAuthorized');
  const callerCheck = paymentSessionEdge.indexOf('await loadActiveCaller(req, db)');
  assert.ok(tokenCheck > 0 && callerCheck > tokenCheck && providerCall > callerCheck);
  assert.match(paymentSessionEdge, /bookingGroup\.every\(\(row\) =>[\s\S]*?customer_access_token_hash/);
  assert.match(paymentSessionEdge, /\["owner", "court_owner", "staff"\]\.includes\(caller\.role\)/);
  assert.match(paymentSessionEdge, /caller\.role === "host"[\s\S]*?row\.host_user_id === caller\.userId/);
  assert.doesNotMatch(paymentSessionEdge, /body\.customer\?\./);
  assert.doesNotMatch(paymentSessionEdge, /\.\.\.\(body\.metadata/);
  assert.doesNotMatch(paymentSessionEdge, /raw_request:\s*body/);
  assert.match(paymentSessionEdge, /\.in\("ref", bookingRefs\)/);
  const client = read('supabase-config.js');
  assert.match(client, /createPaymentSession\(payload\)[\s\S]*?_pbBookingAccessToken\(bookingRef, false\)/);
});

test('account administration requires an active owner account', () => {
  assert.match(manageAccountEdge, /\.select\("id, role, status"\)/);
  assert.match(manageAccountEdge, /account\?\.role !== "owner" \|\| account\?\.status !== "active"/);
  assert.ok(
    manageAccountEdge.indexOf('account?.status !== "active"') <
      manageAccountEdge.indexOf('Deno.serve'),
  );
});

test('receipt and confirmation delivery use recoverable single-worker leases', () => {
  const receiptLease = read('supabase/migrations/20260719110000_receipt_verification_leases.sql');
  const confirmationLease = read('supabase/migrations/20260719120000_confirmation_email_delivery_leases.sql');
  assert.match(receiptLease, /claim_receipt_verification_lease/);
  assert.match(receiptLease, /lease_expires_at <= clock_timestamp\(\)/);
  assert.ok(
    receiptEdge.indexOf('claim_receipt_verification_lease') <
      receiptEdge.indexOf('db.storage.from("receipts").upload'),
  );
  assert.match(receiptEdge, /release_receipt_verification_lease/);
  assert.match(receiptEdge, /flags\.push\("REF_UNREADABLE"\)/);
  assert.match(receiptEdge, /flags\.push\("MERCHANT_CONFIG_MISSING"\)/);
  assert.match(receiptEdge, /flags\.push\("SETTINGS_UNAVAILABLE"\)/);
  assert.match(receiptEdge, /flags\.push\("PROVIDER_REVIEW_REQUIRED"\)/);
  assert.match(receiptEdge, /if \(!receiptDate\) flags\.push\("DATE_UNREADABLE"\)/);
  assert.match(receiptEdge, /if \(!receiptDateTime \|\| !bookingStartedAt\)/);
  assert.match(receiptEdge, /code: "DIGITAL_PAYMENT_METHOD_REQUIRED"/);
  const merchantResolver = receiptEdge.slice(
    receiptEdge.indexOf('function expectedMerchantForProvider'),
    receiptEdge.indexOf('function expectedOpenPlayAmounts'),
  );
  assert.doesNotMatch(merchantResolver, /Paddle Rage Pickleball/);
  assert.match(receiptEdge, /const authoritativeProvider = paymentMethodProvider\([\s\S]*?provider = authoritativeProvider/);
  assert.doesNotMatch(receiptEdge, /paymentMethodProvider\([\s\S]{0,160}\)\s*\|\|\s*provider/);

  // GCash has a dedicated, pure parser. The typed reference and configured
  // recipient are comparisons only; they cannot become invented OCR evidence.
  assert.match(gcashParser, /export function parseGcashReceipt\(/);
  assert.match(gcashParser, /export function compareGcashRecipient\(/);
  assert.match(gcashParser, /source:\s*"ref_label"/);
  assert.match(gcashParser, /typedMatch:\s*typedReferenceMatch\(/);
  assert.match(gcashParser, /source:\s*"recipient_block"/);
  assert.doesNotMatch(gcashParser, /expectedAmount/);
  assert.match(
    receiptEdge,
    /const gcashParse:[\s\S]*?parseGcashReceipt\(ocrText,\s*\{\s*typedReference:\s*typedRef\s*\}\)/
  );
  assert.match(
    receiptEdge,
    /compareGcashRecipient\(gcashParse\.receiver,\s*\{\s*phone:\s*expectedNumber,\s*name:\s*expectedName/
  );

  // Auto-verification is deliberately narrow: a persisted GCash booking,
  // complete canonical payment state, exact parser evidence, 90%+ OCR, and no
  // flags. The same 15-minute limit used by the customer hold is enforced.
  assert.match(receiptEdge, /const PAYMENT_WINDOW_MINUTES = 15/);
  assert.match(receiptEdge, /receiptAgeMinutes as number\) > PAYMENT_WINDOW_MINUTES/);
  assert.match(receiptEdge, /minimumOcrConfidence = provider === "gcash" \? 0\.9 : 0\.55/);
  assert.match(receiptEdge, /gcashParse\.reference\.source !== "ref_label"/);
  assert.match(receiptEdge, /gcashParse\.reference\.confidence !== "high"/);
  assert.match(
    receiptEdge,
    /provider === "gcash" && !expectedNumber &&\s*!flags\.includes\("MERCHANT_CONFIG_MISSING"\)[\s\S]*?flags\.push\("MERCHANT_CONFIG_MISSING"\)/
  );
  assert.match(
    receiptEdge,
    /if \(gcashRecipient\?\.phone === "mismatch"\) \{[\s\S]*?flags\.push\("WRONG_GCASH_NUMBER"\);[\s\S]*?\} else if \(gcashRecipient\?\.phone !== "exact"\) \{[\s\S]*?flags\.push\("NUMBER_UNREADABLE"\)/
  );
  assert.match(
    receiptEdge,
    /const groupPaymentConsistent = bookingGroup\.length > 0 &&\s*bookingGroup\.every\(\(row\) =>[\s\S]*?paymentMethodProvider\(row\.payment_method\) === "gcash"[\s\S]*?normalizeReferenceForProvider\([\s\S]*?=== typedRef[\s\S]*?\["verifying", "pending"\][\s\S]*?\["pending", "for_verification", "unpaid"\]/
  );
  assert.match(
    receiptEdge,
    /const gcashCanAutoApprove = provider === "gcash" &&\s*hasPersistedBooking &&\s*autoPaymentStatus !== null &&\s*flags\.length === 0/
  );

  // Missing/uncertain/mismatched GCash evidence stays pending for an owner.
  // Only a reference already claimed by another payment is terminal.
  assert.match(
    receiptEdge,
    /const hasProvenDuplicate = flags\.some\(\(flag\) =>[\s\S]*?"DUPLICATE_REF"[\s\S]*?"DUPLICATE_INVOICE"[\s\S]*?"DUPLICATE_INSTAPAY_REF"[\s\S]*?"DUPLICATE_BPI_TRANSACTION_REF"/
  );
  assert.match(
    receiptEdge,
    /gcashCanAutoApprove \? "auto_approved" : provider === "gcash"[\s\S]*?\(hasProvenDuplicate \? "rejected" : "manual_review"\)/
  );
  assert.match(
    receiptEdge,
    /const gcashReferenceProven = provider === "gcash" &&[\s\S]*?flags\.length === 0[\s\S]*?ocrProvider === "google_vision"[\s\S]*?ocrConfidenceSource === "native"[\s\S]*?ocrConfidence >= minimumOcrConfidence[\s\S]*?reference\.source === "ref_label"[\s\S]*?reference\.confidence === "high"[\s\S]*?reference\.typedMatch === "match"[\s\S]*?indicators\.classification === "gcash"/
  );
  assert.match(
    receiptEdge,
    /provider === "gcash" && !gcashReferenceProven[\s\S]*?"POSSIBLE_DUPLICATE_REF"[\s\S]*?: "DUPLICATE_REF"/
  );
  assert.match(
    receiptEdge,
    /result === "manual_review"[\s\S]*?statusUpdate\.status = "pending";[\s\S]*?statusUpdate\.payment_status = "for_verification"/
  );
  assert.match(
    receiptEdge,
    /if \(duplicateReference\) \{[\s\S]*?result = "rejected";[\s\S]*?\} else \{[\s\S]*?flags\.push\("AUTO_APPROVAL_FAILED"\);[\s\S]*?result = "manual_review"/
  );

  // The successful state transition, complete booking-group update, ledger
  // claim trigger, and audit insert occur in one service-role-only transaction.
  assert.match(receiptEdge, /db\.rpc\(\s*"finalize_gcash_receipt_auto_approval"/);
  assert.match(receiptEdge, /db\.rpc\("finalize_gcash_receipt_review"/);
  assert.doesNotMatch(receiptEdge, /FALLBACK cancel succeeded/);
  assert.match(gcashAutoFinalizer, /language plpgsql\s+security definer\s+set search_path = public, pg_temp/i);
  assert.match(gcashAutoFinalizer, /where b\.ref = p_booking_ref\s+for update/i);
  assert.match(gcashAutoFinalizer, /actual_refs is distinct from expected_refs/i);
  assert.match(gcashAutoFinalizer, /b\.payment_status not in \('unpaid', 'pending', 'for_verification'\)/i);
  assert.match(gcashAutoFinalizer, /set status = 'confirmed',\s*payment_status = p_payment_status/i);
  assert.match(gcashAutoFinalizer, /receipt_status = 'auto_approved'/i);
  assert.match(gcashAutoFinalizer, /insert into public\.receipt_verifications/i);
  assert.match(
    gcashAutoFinalizer,
    /revoke all on function public\.finalize_gcash_receipt_auto_approval\([\s\S]*?\)\s+from public, anon, authenticated/i
  );
  assert.match(
    gcashAutoFinalizer,
    /grant execute on function public\.finalize_gcash_receipt_auto_approval\([\s\S]*?\)\s+to service_role/i
  );
  const methodCheck = receiptEdge.indexOf('code: "PAYMENT_METHOD_DISABLED"');
  const receiptCheckpoint = receiptEdge.indexOf('receipt checkpoint: attached');
  const receiptStorage = receiptEdge.indexOf('db.storage.from("receipts").upload');
  assert.ok(methodCheck > 0 && receiptStorage > methodCheck && receiptCheckpoint > receiptStorage);
  assert.doesNotMatch(
    receiptEdge,
    /if \(!extractedRef && !flags\.includes\("REF_FORMAT_INVALID"\)\) \{\s*flags\.push\("REF_FORMAT_INVALID"\)/,
  );

  assert.match(confirmationLease, /claim_booking_confirmation_email/);
  assert.match(confirmationLease, /interval '5 minutes'/);
  assert.match(confirmationLease, /finish_booking_confirmation_email/);
  assert.match(confirmationLease, /guard_confirmation_email_claim_fields/);
  assert.match(confirmationLease, /request_role <> 'service_role'/);
  assert.match(confirmationLease, /confirmation_email_claim_token is distinct from old\.confirmation_email_claim_token/);
  assert.match(confirmationEdge, /db\.rpc\(\s*"claim_booking_confirmation_email"/);
  assert.match(confirmationEdge, /db\.rpc\(\s*"finish_booking_confirmation_email"/);
  assert.doesNotMatch(confirmationEdge, /confirmation_email_sent_at:\s*claimTime/);
});

test('receipt clients preserve only a persisted canonical auto-verification result', () => {
  const page = read('index.html');
  const savedBookingVerifier = page.slice(
    page.indexOf('async function verifyUploadedReceipt'),
    page.indexOf('function sendCustomerConfirmationEmail')
  );
  const canonicalAutoState = page.slice(
    page.indexOf('async function canonicalAutoReceiptState'),
    page.indexOf('function onReceiptPicked')
  );
  const singleBookingFlow = page.slice(
    page.indexOf('async function submitBookingLegacy'),
    page.indexOf('async function submitBooking(e)')
  );
  const groupBookingFlow = page.slice(
    page.indexOf('async function submitBooking(e)'),
    page.indexOf('async function canonicalAutoReceiptState')
  );
  const hostVerifier = page.slice(
    page.indexOf('async function verifyHostSessionReceipt'),
    page.indexOf('async function submitHostSessionJoin')
  );
  const hostSubmission = page.slice(
    page.indexOf('async function submitHostSessionJoin'),
    page.indexOf('function renderPublicHostSession')
  );
  const openPlayVerifier = page.slice(
    page.indexOf('async function verifyOpReceipt'),
    page.indexOf('async function submitOpenPlay')
  );
  const openPlaySubmission = page.slice(
    page.indexOf('async function submitOpenPlay'),
    page.indexOf('</script>', page.indexOf('async function submitOpenPlay'))
  );

  // The verifier returns the state committed by the atomic finalizer.
  assert.match(
    receiptEdge,
    /paymentStatus:\s*hasPersistedBooking \? finalPaymentStatus \|\| null : null/
  );
  assert.match(
    receiptEdge,
    /bookingStatus:\s*hasPersistedBooking \? finalBookingStatus \|\| null : null/
  );
  assert.match(
    savedBookingVerifier,
    /\['auto_approved', 'manual_review', 'rejected'\]\.includes\(res\?\.status\)[\s\S]*?\? res\.status/
  );
  assert.doesNotMatch(
    savedBookingVerifier,
    /res\?\.status === 'rejected' \? 'rejected' : 'manual_review'/
  );
  assert.match(
    savedBookingVerifier,
    /paymentStatus:\s*res\?\.paymentStatus \|\| null,[\s\S]*?bookingStatus:\s*res\?\.bookingStatus \|\| null/
  );

  // The browser accepts auto-approval only with a canonical confirmed and paid
  // response (or a protected read-back), never by inventing a local paid state.
  assert.match(
    canonicalAutoState,
    /bookingStatus === 'confirmed' && \['paid', 'downpayment_paid'\]\.includes\(paymentStatus\)/
  );
  assert.match(
    canonicalAutoState,
    /const saved = await DB\.getBookingByRef\(bookingRef\)[\s\S]*?return canonical\(saved\)/
  );
  assert.match(
    singleBookingFlow,
    /ocrStatus === 'auto_approved'[\s\S]*?canonicalAutoReceiptState\([\s\S]*?booking\.status = verifiedState\.bookingStatus;[\s\S]*?booking\.paymentStatus = verifiedState\.paymentStatus/
  );
  assert.match(
    groupBookingFlow,
    /ocrStatus === 'auto_approved'[\s\S]*?canonicalAutoReceiptState\([\s\S]*?itemBookings\.forEach\(row => \{[\s\S]*?row\.status = verifiedState\.bookingStatus;[\s\S]*?row\.paymentStatus = verifiedState\.paymentStatus/
  );

  // Pre-save host-session and Open Play scans have no row that the finalizer
  // can lock. They preserve only proven duplicate rejection; all other results
  // are submitted as pending and the UI renders the protected insert response.
  assert.match(
    hostVerifier,
    /const status = res\?\.status === 'rejected' \? 'rejected' : 'manual_review'/
  );
  assert.doesNotMatch(hostVerifier, /\['auto_approved'/);
  assert.match(
    hostSubmission,
    /paymentStatus = receiptResult\.status === 'rejected' \? 'rejected' : 'pending'/
  );
  assert.match(hostSubmission, /paymentStatus = savedRegistration\.paymentStatus/);
  assert.match(
    hostSubmission,
    /canonicalReceiptStatus = savedRegistration\.receiptStatus \|\| 'none'/
  );
  assert.match(
    openPlayVerifier,
    /const status = res\?\.status === 'rejected' \? 'rejected' : 'manual_review'/
  );
  assert.doesNotMatch(openPlayVerifier, /\['auto_approved'/);
  assert.match(openPlaySubmission, /regPayStatus = 'pending'/);
  assert.match(openPlaySubmission, /regPayStatus = savedRegistration\.paymentStatus/);
  assert.match(
    openPlaySubmission,
    /canonicalReceiptStatus = savedRegistration\.receiptStatus \|\| 'none'/
  );
});

test('public court schedules use accessible mobile court tabs and compact headings', () => {
  const page = read('index.html');
  assert.match(page, /id="courtTabs" role="tablist" aria-label="Choose a court"/);
  assert.match(page, /class="court-tab"[^>]*role="tab"[^>]*aria-selected=/);
  assert.match(page, /function courtTabKeydown\(event\)[\s\S]*?ArrowRight[\s\S]*?ArrowLeft/);
  assert.match(page, /function syncMobileCourtAccessibility\(\)[\s\S]*?role', 'tabpanel'/);
  assert.doesNotMatch(page, /🕐\s*Available times|📍\s*\$\{esc\(c\.name\)\}/);
  assert.match(
    page,
    /@media\(max-width:700px\) \{[\s\S]*?\.court-tabs \{ display:flex; \}[\s\S]*?\.cc\.active-mobile \{ display:flex; \}/
  );
  assert.match(
    page,
    /const courtTimesHeading = `[\s\S]*?court-heading-icon[\s\S]*?compactCourtName[\s\S]*?Available Times/
  );
  assert.match(page, /class="cc-mobile-name">\$\{courtTimesHeading\}/);
  assert.match(page, /class="cc-times-title">\$\{courtTimesHeading\}/);
  assert.match(page, /\.court-heading-icon::before[\s\S]*?\.court-heading-icon::after/);

  const inlineScripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]);
  assert.ok(inlineScripts.length >= 1);
  inlineScripts.forEach(source => {
    assert.doesNotThrow(() => new Function(source));
  });
});

test('court slot states stay distinct and the public light theme is genuinely light', () => {
  const page = read('index.html');
  const brand = read('brand-theme.css');

  assert.match(page, /--slot-available:\s*#7fa9cc/);
  assert.match(page, /--slot-selected:\s*#c2410c/);
  assert.match(page, /--slot-booked:\s*#f87171/);
  assert.match(page, /--slot-processing:\s*#22c55e/);
  assert.match(page, /--slot-done:\s*#94a3b8/);
  assert.match(
    page,
    /\.cc-slot-btn:not\(\.taken\):not\(\.past-slot\):not\(\.open-play\):not\(\.maintenance\):not\(\.processing\)/
  );
  for (const state of ['available', 'selected', 'booked', 'processing', 'done']) {
    assert.match(page, new RegExp(`\\.cc-dot\\.${state} \\{ background:var\\(--slot-${state}\\)`));
  }

  assert.match(
    brand,
    /body\.light,[\s\S]*?color-scheme:\s*light;[\s\S]*?--bg:\s*#f4f7f2;[\s\S]*?--card:\s*#ffffff;/
  );
  assert.match(brand, /--slot-available:\s*#143d63/);
  assert.match(brand, /--slot-booked:\s*#b91c1c/);
  assert.match(brand, /--slot-processing:\s*#15803d/);
  assert.match(brand, /--slot-done:\s*#475569/);
  assert.match(brand, /body\.light \.nav,[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.94\) !important/);
  assert.match(brand, /body\.light \.open-play-block,[\s\S]*?var\(--surface2\)/);
  assert.match(brand, /body\.light \.date-day\.selected,[\s\S]*?color:\s*#fff/);
  assert.match(brand, /body\.light \.cc-photo-avail\.av,[\s\S]*?color:\s*#050706/);

  assert.match(
    page,
    /const savedPublicTheme = localStorage\.getItem\('pb_template_theme'\)[\s\S]*?document\.documentElement\.style\.colorScheme = savedPublicTheme/
  );
  assert.match(
    page,
    /function initDark\(\)[\s\S]*?const isDark = document\.body\.dataset\.theme !== 'light';[\s\S]*?document\.body\.dataset\.theme = dark \? 'dark' : 'light';[\s\S]*?document\.documentElement\.style\.colorScheme = dark \? 'dark' : 'light'/
  );
  assert.match(page, /try \{\s*localStorage\.setItem\('pb_template_theme'/);
});

test('payment step removes duplicate notices while keeping Vision consent visible', () => {
  const page = read('index.html');
  const sharedPanel = page.slice(
    page.indexOf('function syncGcashSharedPanel'),
    page.indexOf('function copyPaymentNumber')
  );
  assert.match(page, /Upload your proof of payment below\./);
  assert.doesNotMatch(page, /Payment window:|id="bPayWindow"|id="bPayWindowStart"|id="bPayWindowEnd"/);
  assert.doesNotMatch(sharedPanel, /<strong>Privacy:<\/strong>|privacy requests/i);
  assert.match(page, /function updatePaymentAmountUI[\s\S]*?Google Cloud Vision processing it for payment verification/);
  assert.ok((page.match(/only as long as needed for disputes, fraud prevention, accounting, and legal requirements/g) || []).length >= 4);
});

test('only host court reservations can carry an outstanding balance', () => {
  const page = read('index.html');
  const paymentRules = read('supabase/functions/_shared/booking-payment.ts');
  assert.match(page, /function downpaymentAmount[\s\S]*?if \(!isVerifiedHostBooking\(\)\) return Number\(total \|\| 0\)/);
  assert.match(page, /const payType = '100%'/);
  assert.doesNotMatch(page, /Full Booking Fee \+ 50% Court Fee Due/);
  assert.match(bookingEdge, /downpayment: total/);
  assert.match(registrationEdge, /p_payment_type: "100%"/);
  assert.match(paymentRules, /Regular bookings require full payment/);
  assert.match(paymentRules, /Only host court reservations can carry a balance/);
  assert.match(confirmationEdge, /Regular bookings require verified full payment/);
  assert.match(fullPaymentMigration, /payment_acceptance_mode', 'full_payment_only'/);
  assert.match(fullPaymentMigration, /coalesce\(new\.host_booking, false\) = false/);
  assert.match(fullPaymentMigration, /new\.downpayment := new\.total/);
  assert.match(fullPaymentMigration, /new\.payment_status[\s\S]*?'downpayment_paid'[\s\S]*?raise exception/);
});

test('payment review covers every receipt-backed registration type', () => {
  const admin = read('admin.html');
  const client = read('supabase-config.js');
  assert.match(admin, /renderPaymentReview[\s\S]*?DB\.getOpenPlayHostSessionRegistrations\(\)/);
  assert.match(admin, /openHostSessionVerifyModal/);
  assert.match(admin, /DB\.getHostSessionReceiptSignedUrl\(r\.id\)/);
  assert.match(admin, /DB\.updateOpenPlayHostSessionRegistration\(id, \{ paymentStatus: 'paid' \}\)/);
  assert.match(admin, /regular bookings require the full payment amount/);
  assert.match(admin, /receiptRef: receiptItem\.ref/);
  assert.match(admin, /function bookingPaymentIsResolved[\s\S]*?'deposit_retained'[\s\S]*?'forfeited'/);
  assert.match(admin, /vmRejectBtn'\)\.style\.display = readOnly \? 'none'/);
  assert.match(admin, /vmConfirmBtn'\)\.style\.display = readOnly \? 'none'/);
  assert.ok((admin.match(/if \(bookingPaymentIsResolved\(bkForPay\)\)/g) || []).length >= 2);
  assert.match(admin, /item\.status === 'retained'[\s\S]*?>Resolved</);
  assert.match(client, /async updateOpenPlayHostSessionRegistration\(id, updates\)/);
});
