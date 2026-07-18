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
const paymentSessionEdge = read('supabase/functions/create-payment-session/index.ts');
const manageAccountEdge = read('supabase/functions/manage-account/index.ts');
const hostApplicationEdge = read('supabase/functions/host-application/index.ts');

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

test('Telegram endpoint authorizes active accounts and ignores browser message content', () => {
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
  assert.match(telegramEdge, /case "booking_confirmed":[\s\S]*?everyStatus\("confirmed", "completed"\)/);
  assert.match(telegramEdge, /case "payment_verified":[\s\S]*?everyPayment\("paid", "downpayment_paid", "deposit_retained"\)/);
  assert.match(telegramEdge, /case "booking_cancelled":[\s\S]*?everyStatus\("cancelled"\)/);
  assert.match(telegramEdge, /if \(!eventMatchesCanonicalState\(event, rows, privileged\)\)/);
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
  assert.match(receiptEdge, /nameCheck === "unreadable" && expectedName[\s\S]*?RECEIVER_NAME_UNREADABLE/);
  assert.match(receiptEdge, /OCR is evidence extraction, not payment authentication/);
  assert.match(receiptEdge, /const result: "manual_review" \| "rejected" = hasHard/);
  assert.doesNotMatch(receiptEdge, /statusUpdate\.payment_status\s*=\s*(?:fullyPaid|"paid"|"downpayment_paid")/);
  assert.doesNotMatch(receiptEdge, /statusUpdate\.status\s*=\s*"confirmed"/);
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

test('dynamic booking consent keeps Vision purpose and limited retention visible', () => {
  const page = read('index.html');
  assert.match(page, /function syncGcashSharedPanel[\s\S]*?Google Cloud Vision only for payment verification and fraud prevention/);
  assert.match(page, /function updatePaymentAmountUI[\s\S]*?Google Cloud Vision processing it for payment verification/);
  assert.ok((page.match(/only as long as needed for disputes, fraud prevention, accounting, and legal requirements/g) || []).length >= 4);
});
