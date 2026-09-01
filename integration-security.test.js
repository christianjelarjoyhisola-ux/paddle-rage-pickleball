const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = file => fs.readFileSync(file, 'utf8');

function functionSource(source, name, { required = true } = {}) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...source.matchAll(new RegExp(`^(?:async\\s+)?function\\s+${escaped}\\s*\\(`, 'gm'))];
  const match = matches.at(-1);
  if (!match) {
    if (required) assert.fail(`missing function ${name}`);
    return '';
  }
  const rest = source.slice(match.index + match[0].length);
  const next = /\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.exec(rest);
  return source.slice(match.index, next ? match.index + match[0].length + next.index : source.length);
}

function functionClosure(source, rootName, follow = name =>
  /booking.*confirm|confirm.*booking|quick.*confirm|confirm.*quick|bookingPaymentIsResolved|isDigitalPayment/i.test(name)
) {
  const pending = [rootName];
  const seen = new Set();
  const blocks = [];
  while (pending.length) {
    const name = pending.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const block = functionSource(source, name, { required: name === rootName });
    if (!block) continue;
    blocks.push(block);
    for (const call of block.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const calledName = call[1];
      if (follow(calledName) && !seen.has(calledName) && functionSource(source, calledName, { required: false })) {
        pending.push(calledName);
      }
    }
  }
  return blocks.join('\n');
}

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
const hostTelegramMigration = read('supabase/migrations/20260902120000_host_application_telegram_review_alerts.sql');
const telegramShared = read('supabase/functions/_shared/telegram.ts');
const fullPaymentMigration = read('supabase/migrations/20260719130000_regular_bookings_full_payment.sql');
const gcashParser = read('supabase/functions/_shared/gcash-receipt.ts');
const receiptProviderDispatch = read(
  'supabase/functions/_shared/receipt-providers/index.ts'
);
const bankToGcashParser = read(
  'supabase/functions/_shared/receipt-providers/bank-to-gcash.ts'
);
const gotymeParser = read(
  'supabase/functions/_shared/receipt-providers/gotyme.ts'
);
const maribankParser = read(
  'supabase/functions/_shared/receipt-providers/maribank.ts'
);
const gcashAutoFinalizer = read(
  'supabase/migrations/20260728120000_gcash_receipt_auto_verification.sql'
);
const digitalReceiptMigration = read(
  'supabase/migrations/20260901090000_receipt_review_maribank.sql'
);

test('public creation paths keep configured Edge and database boundaries', () => {
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

  assert.match(bookingEdge, /db\.rpc\("submit_public_booking_holds"/);
  assert.match(registrationEdge, /"submit_public_open_play_registration"/);

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

  const hostLookup = hostApplicationEdge.indexOf('await restSelect("accounts"');
  const hostAuth = hostApplicationEdge.indexOf('await createAuthUser(email, password, fullName)');
  const hostStorage = hostApplicationEdge.indexOf('db.storage.from("host-ids").upload');
  const hostWrite = hostApplicationEdge.indexOf('await restInsert("open_play_host_applications"');
  assert.ok(
    hostLookup > 0 && hostAuth > hostLookup && hostStorage > hostAuth &&
      hostWrite > hostStorage,
  );
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
  assert.match(client, /addOpenPlayHostApplication\(app\)[\s\S]*?return this\.submitOpenPlayHostSignup\(app\)/);
  assert.doesNotMatch(hostPage, /runtime-config\.js/);
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
  assert.match(admin, /Add the shared GCash recipient name and number or QR before enabling/);
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
  const verifyStart = receiptEdge.indexOf('// ── verify a freshly-uploaded receipt');
  assert.ok(
    receiptEdge.indexOf('claim_receipt_verification_lease', verifyStart) <
      receiptEdge.indexOf('db.storage.from("receipts").upload', verifyStart),
  );
  assert.match(receiptEdge, /release_receipt_verification_lease/);
  assert.match(receiptEdge, /flags\.push\("REF_UNREADABLE"\)/);
  assert.match(receiptEdge, /flags\.push\("MERCHANT_CONFIG_MISSING"\)/);
  assert.match(receiptEdge, /flags\.push\("SETTINGS_UNAVAILABLE"\)/);
  assert.match(receiptEdge, /flags\.push\("PROVIDER_REVIEW_REQUIRED"\)/);
  assert.match(receiptEdge, /if \(!receiptDate\) flags\.push\("DATE_UNREADABLE"\)/);
  assert.match(
    receiptProviderDispatch,
    /!receiptInstant \|\| Number\.isNaN\(receiptInstant\.getTime\(\)\)[\s\S]*?addUnique\(flags, "TIME_UNREADABLE"\)/
  );
  assert.match(receiptEdge, /code: "DIGITAL_PAYMENT_METHOD_REQUIRED"/);
  const merchantResolver = receiptEdge.slice(
    receiptEdge.indexOf('function expectedMerchantForProvider'),
    receiptEdge.indexOf('function expectedOpenPlayAmounts'),
  );
  assert.doesNotMatch(merchantResolver, /Paddle Rage Pickleball/);
  assert.match(receiptEdge, /const authoritativeProvider = paymentMethodProvider\([\s\S]*?provider = authoritativeProvider/);
  assert.doesNotMatch(receiptEdge, /paymentMethodProvider\([\s\S]{0,160}\)\s*\|\|\s*provider/);

  // GCash, GoTyme->GCash, and MariBank->GCash have explicit pure parser and
  // verifier dispatch. Unknown providers fail closed.
  assert.match(gcashParser, /export function parseGcashReceipt\(/);
  assert.match(gcashParser, /export function compareGcashRecipient\(/);
  assert.match(gcashParser, /source:\s*"ref_label"/);
  assert.match(gcashParser, /typedMatch:\s*typedReferenceMatch\(/);
  assert.match(gcashParser, /source:\s*"recipient_block"/);
  assert.doesNotMatch(gcashParser, /expectedAmount/);
  assert.match(receiptProviderDispatch, /case "gcash":/);
  assert.match(receiptProviderDispatch, /case "gotyme":/);
  assert.match(receiptProviderDispatch, /case "maribank":/);
  assert.match(
    receiptProviderDispatch,
    /default:\s*throw new UnsupportedReceiptProviderError\(provider\)/
  );
  assert.match(gotymeParser, /parseGotymeToGcashReceipt/);
  assert.match(gotymeParser, /verifyGotymeToGcashReceipt/);
  assert.match(maribankParser, /parseMaribankToGcashReceipt/);
  assert.match(maribankParser, /verifyMaribankToGcashReceipt/);
  assert.match(bankToGcashParser, /typedReferenceMatch\(/);
  assert.match(
    bankToGcashParser,
    /const primary = parsePrimaryReference\(lines, options\.typedReference \|\| ""\)/
  );
  assert.doesNotMatch(
    bankToGcashParser,
    /selected\?\.(?:value|raw)\s*\|\|\s*typedReference/
  );
  assert.match(
    receiptEdge,
    /code: "UNSUPPORTED_PAYMENT_PROVIDER"/
  );
  assert.match(
    receiptEdge,
    /parseProviderReceipt\(provider, ocrText,[\s\S]*?typedReference: typedRef/
  );
  assert.match(
    receiptEdge,
    /verifyProviderReceipt\(providerParse,[\s\S]*?expectedRecipientNumber: expectedNumber,[\s\S]*?expectedRecipientName: expectedName/
  );

  // Auto-verification is deliberately narrow: exact dedicated-parser evidence,
  // native 90%+ OCR, a valid timestamp inside the same customer hold window,
  // recipient/amount/reference matches, and an atomically clear replay ledger.
  assert.match(receiptEdge, /const PAYMENT_WINDOW_MINUTES = 15/);
  assert.match(
    receiptEdge,
    /minimumOcrConfidence = isDedicatedReceiptProvider\(provider\)[\s\S]*?\? 0\.9/
  );
  assert.match(receiptEdge, /ocrConfidenceSource !== "native"/);
  assert.match(
    receiptEdge,
    /provider === "gcash" && !expectedNumber &&\s*!flags\.includes\("MERCHANT_CONFIG_MISSING"\)[\s\S]*?flags\.push\("MERCHANT_CONFIG_MISSING"\)/
  );
  assert.match(
    receiptProviderDispatch,
    /receipt\.reference\.typedMatch === "mismatch"[\s\S]*?addUnique\(flags, "REF_MISMATCH"\)/
  );
  assert.match(
    receiptEdge,
    /const groupPaymentConsistent = bookingGroup\.length > 0 &&[\s\S]*?paymentMethodProvider\(row\.payment_method\) === provider[\s\S]*?=== typedRef/
  );
  assert.match(
    receiptEdge,
    /const cleanEvidence = !!providerVerification &&[\s\S]*?sourceProviderMatch &&[\s\S]*?referenceMatch &&[\s\S]*?amountMatch &&[\s\S]*?timestampValid &&[\s\S]*?recipientMatch &&[\s\S]*?duplicateClear &&[\s\S]*?flags\.length === 0/
  );

  // Every wrong/uncertain/mismatched/duplicate receipt stays pending. Automated
  // verification has no rejected/cancelled outcome.
  assert.match(
    bankToGcashParser,
    /providerKey: parsed\.provider,[\s\S]*?duplicateFlag: "DUPLICATE_REF"/
  );
  assert.match(
    bankToGcashParser,
    /providerKey: "instapay",[\s\S]*?duplicateFlag: "DUPLICATE_INSTAPAY_REF"/
  );
  assert.match(
    receiptEdge,
    /let result: "auto_approved" \| "manual_review" =/
  );
  const decisionStart = receiptEdge.indexOf('// ── decision routing');
  const auditStart = receiptEdge.indexOf('// ── audit trail', decisionStart);
  const automaticOutcome = receiptEdge.slice(decisionStart, auditStart);
  assert.doesNotMatch(automaticOutcome, /result\s*=\s*"rejected"/);
  assert.doesNotMatch(automaticOutcome, /statusUpdate\.status\s*=\s*"cancelled"/);
  assert.doesNotMatch(automaticOutcome, /statusUpdate\.payment_status\s*=\s*"rejected"/);
  assert.match(
    automaticOutcome,
    /statusUpdate\.status = "pending";[\s\S]*?statusUpdate\.payment_status = "for_verification"/
  );
  assert.match(
    automaticOutcome,
    /already been used for another payment[\s\S]*?flags\.push\("DUPLICATE_REF"\)[\s\S]*?result = "manual_review"/
  );
  assert.match(
    receiptEdge,
    /if \(!isDedicatedReceiptProvider\(provider\)\)[\s\S]*?flags\.push\("PROVIDER_REVIEW_REQUIRED"\)/
  );

  // The successful state transition, complete booking-group update, ledger
  // claim trigger, and audit insert occur in one service-role-only transaction.
  assert.match(receiptEdge, /db\.rpc\(\s*"finalize_digital_receipt_auto_approval"/);
  assert.match(receiptEdge, /p_provider: provider/);
  assert.match(receiptEdge, /p_payment_reference: typedRef/);
  assert.match(receiptEdge, /db\.rpc\("finalize_digital_receipt_review"/);
  assert.doesNotMatch(receiptEdge, /FALLBACK cancel succeeded/);
  assert.match(
    digitalReceiptMigration,
    /create or replace function public\.finalize_digital_receipt_auto_approval\([\s\S]*?security definer\s+set search_path = public, pg_temp/i
  );
  assert.match(
    digitalReceiptMigration,
    /create or replace function public\.finalize_digital_receipt_review\([\s\S]*?security definer\s+set search_path = public, pg_temp/i
  );
  assert.match(
    digitalReceiptMigration,
    /cardinality\(coalesce\(p_receipt_flags, array\[\]::text\[\]\)\) <> 0/
  );
  assert.match(
    digitalReceiptMigration,
    /jsonb_typeof\(p_extracted->'dedupeKeys'\) <> 'array'[\s\S]*?payment_review_ledger_keys\([\s\S]*?used_gcash_refs/
  );
  const automaticFinalizer = digitalReceiptMigration.slice(
    digitalReceiptMigration.indexOf('create or replace function public.finalize_digital_receipt_auto_approval'),
    digitalReceiptMigration.indexOf('create or replace function public.finalize_digital_receipt_review')
  );
  assert.doesNotMatch(automaticFinalizer, /payment_status = 'rejected'/i);
  assert.doesNotMatch(automaticFinalizer, /status = 'cancelled'/i);
  const reviewFinalizer = digitalReceiptMigration.slice(
    digitalReceiptMigration.indexOf('create or replace function public.finalize_digital_receipt_review'),
    digitalReceiptMigration.indexOf('create or replace function public.assert_clean_registration_receipt')
  );
  assert.match(reviewFinalizer, /status = 'pending'[\s\S]*?payment_status = 'for_verification'/i);
  assert.match(reviewFinalizer, /receipt_status = 'manual_review'/i);
  assert.doesNotMatch(reviewFinalizer, /payment_status = 'rejected'/i);
  assert.doesNotMatch(reviewFinalizer, /status = 'cancelled'/i);
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
    /res\?\.status === 'auto_approved' \? 'auto_approved' : 'manual_review'/
  );
  assert.doesNotMatch(savedBookingVerifier, /rejected/);
  assert.match(
    savedBookingVerifier,
    /paymentStatus:\s*status === 'auto_approved' \? \(res\?\.paymentStatus \|\| null\) : 'for_verification'[\s\S]*?bookingStatus:\s*status === 'auto_approved' \? \(res\?\.bookingStatus \|\| null\) : 'pending'/
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
    /(?:ocrStatus|booking\._receiptResult\?\.status) === 'auto_approved'[\s\S]*?canonicalAutoReceiptState\([\s\S]*?booking\.status = verifiedState\.bookingStatus;[\s\S]*?booking\.paymentStatus = verifiedState\.paymentStatus/
  );
  assert.match(
    groupBookingFlow,
    /(?:ocrStatus|booking\._receiptResult\?\.status) === 'auto_approved'[\s\S]*?canonicalAutoReceiptState\([\s\S]*?itemBookings\.forEach\(row => \{[\s\S]*?row\.status = verifiedState\.bookingStatus;[\s\S]*?row\.paymentStatus = verifiedState\.paymentStatus/
  );

  // Pre-save host-session and Open Play scans can return a clean audit proof.
  // The browser passes its immutable ID to the protected registration Edge;
  // canonical paid state comes only from the verified registration RPC.
  assert.match(
    hostVerifier,
    /res\?\.status === 'auto_approved'[\s\S]*?receiptVerificationId/
  );
  assert.doesNotMatch(hostVerifier, /rejected/);
  assert.match(
    hostSubmission,
    /receiptVerificationId:\s*receiptResult\?\.status === 'auto_approved'[\s\S]*?receiptResult\.receiptVerificationId/
  );
  assert.match(hostSubmission, /paymentStatus = savedRegistration\.paymentStatus/);
  assert.match(
    hostSubmission,
    /canonicalReceiptStatus = savedRegistration\.receiptStatus \|\| 'none'/
  );
  assert.match(
    openPlayVerifier,
    /res\?\.status === 'auto_approved'[\s\S]*?receiptVerificationId/
  );
  assert.doesNotMatch(openPlayVerifier, /rejected/);
  assert.match(
    openPlaySubmission,
    /receiptVerificationId:\s*receiptResult\?\.status === 'auto_approved'[\s\S]*?receiptResult\.receiptVerificationId/
  );
  assert.match(openPlaySubmission, /regPayStatus = savedRegistration\.paymentStatus/);
  assert.match(
    openPlaySubmission,
    /canonicalReceiptStatus = savedRegistration\.receiptStatus \|\| 'none'/
  );
  assert.match(registrationEdge, /function positiveReceiptVerificationId\(/);
  assert.match(
    registrationEdge,
    /submit_verified_public_open_play_registration[\s\S]*?p_receipt_verification_id: receiptVerificationId/
  );
  assert.match(
    registrationEdge,
    /submit_verified_public_host_session_registration[\s\S]*?p_receipt_verification_id: receiptVerificationId/
  );
  assert.match(
    registrationEdge,
    /receiptVerificationId && response\.error[\s\S]*?retryable: true/
  );
  assert.ok(
    (digitalReceiptMigration.match(
      /pg_advisory_xact_lock\(hashtextextended\([\s\S]*?'paddle-rage-receipt-registration:' \|\| p_receipt_verification_id::text/g
    ) || []).length >= 2,
    'both verified registration RPCs serialize same-audit retries'
  );
  assert.ok(
    (digitalReceiptMigration.match(
      /from public\.receipt_verification_subject_claims claims[\s\S]*?where claims\.receipt_verification_id = p_receipt_verification_id;[\s\S]*?return query/g
    ) || []).length >= 2,
    'both verified registration RPCs return the canonical claimed row on an exact retry'
  );
  assert.match(
    digitalReceiptMigration,
    /Receipt verification retry does not match its original registration\./
  );
  assert.match(
    registrationEdge,
    /receiptVerificationId[\s\S]*?submit_verified_public_open_play_registration[\s\S]*?: await db\.rpc\("submit_public_open_play_registration"[\s\S]*?p_client_receipt_status:[\s\S]*?"manual_review"/
  );
  assert.doesNotMatch(
    registrationEdge,
    /receiptVerificationId && response\.error[\s\S]{0,900}?submit_public_(?:open_play|host_session)_registration/
  );
  assert.doesNotMatch(
    registrationEdge,
    /p_client_receipt_status:\s*text\(body\.receiptStatus/
  );
});

test('verified host applications enqueue one privacy-safe retryable Telegram review alert', () => {
  const hostPage = read('host.html');
  const admin = read('admin.html');
  const config = read('supabase-config.js');
  const deploy = read('deploy-edge-functions.ps1');
  const message = functionSource(hostApplicationEdge, 'hostReviewTelegramMessage');
  const dispatch = functionSource(hostApplicationEdge, 'dispatchHostReviewNotifications');
  const confirm = hostApplicationEdge.slice(
    hostApplicationEdge.indexOf('if (body.action === "confirm-verification")'),
    hostApplicationEdge.indexOf('if (body.action === "dispatch-review-notifications")')
  );

  assert.match(confirm, /db\.auth\.getUser\(token\)/);
  assert.match(confirm, /authUser\?\.email_confirmed_at/);
  assert.match(confirm, /mark_host_application_email_verified/);
  assert.match(confirm, /dispatchHostReviewNotifications/);
  assert.ok(confirm.indexOf('email_confirmed_at') < confirm.indexOf('mark_host_application_email_verified'));
  assert.match(hostTelegramMigration, /email_verified_at timestamptz/);
  assert.match(hostTelegramMigration, /telegram_notification_sent_at timestamptz/);
  assert.match(hostTelegramMigration, /telegram_notification_next_attempt_at timestamptz/);
  assert.match(hostTelegramMigration, /from auth\.users u[\s\S]*u\.email_confirmed_at is not null/);
  assert.match(hostTelegramMigration, /security definer/);
  assert.match(hostTelegramMigration, /revoke all on function public\.mark_host_application_email_verified[\s\S]*from public, anon, authenticated/);
  assert.match(dispatch, /\.eq\("status", "pending"\)/);
  assert.match(dispatch, /\.not\("email_verified_at", "is", null\)/);
  assert.match(dispatch, /notification_event_claims/);
  assert.match(dispatch, /telegramRecipientKey\(chatId\)/);
  assert.match(dispatch, /const leaseUntil = new Date\(Date\.now\(\) \+ 2 \* 60_000\)/);
  assert.match(dispatch, /\.eq\("telegram_notification_next_attempt_at", previousNextAttempt\)/);
  assert.match(dispatch, /\.eq\("telegram_notification_next_attempt_at", leaseUntil\)/);
  assert.match(dispatch, /delete\(\)\.eq\("event_key", eventKey\)/);
  assert.match(dispatch, /Math\.min\(360, 5 \* Math\.pow\(2/);
  assert.match(telegramShared, /Promise\.all\(chatIds\.map/);
  assert.match(telegramShared, /deliveredChatIds/);
  assert.match(telegramShared, /failedChatIds/);

  assert.match(message, /HOST APPLICATION NEEDS REVIEW/);
  assert.match(message, /maskedEmail\(app\.email\)/);
  assert.match(message, /Email verified: Yes/);
  assert.match(message, /Open Host Center/);
  assert.doesNotMatch(message, /password|gcash|valid_id|notes|contact_number/i);

  assert.match(hostPage, /await DB\.confirmOpenPlayHostVerification\(\)/);
  assert.ok(hostPage.indexOf('await DB.confirmOpenPlayHostVerification()') < hostPage.indexOf("await _sb.auth.signOut({ scope: 'local' })"));
  assert.match(config, /action: 'confirm-verification'/);
  assert.match(config, /action: 'dispatch-review-notifications'/);
  assert.match(config, /action: 'test-review-notification'/);
  assert.match(admin, /a\.status === 'pending' && a\.emailVerifiedAt/);
  assert.match(admin, /dispatchOpenPlayHostReviewNotifications\(\)\.catch/);
  assert.match(admin, /sendOpenPlayHostTelegramTest\(\)/);
  const testAlert = hostApplicationEdge.slice(
    hostApplicationEdge.indexOf('if (body.action === "test-review-notification")'),
    hostApplicationEdge.indexOf('if (body.action === "resend-verification")')
  );
  assert.match(testAlert, /requireReviewer\(req, db\)/);
  assert.match(testAlert, /PADDLE RAGE TELEGRAM TEST/);
  assert.match(testAlert, /No host application was created/);
  assert.doesNotMatch(testAlert, /body\.(?:message|chatId|botToken)/);
  assert.match(deploy, /TELEGRAM_BOT_TOKEN/);
  assert.match(deploy, /TELEGRAM_CHAT_ID/);
  assert.match(config, /confirmOpenPlayHostVerification\(\) \{ return \{ ok: true, reviewable: true, skipped: true, reason: 'Local data mode'/);
});

test('public court schedules use compact stacked court headings without filter buttons', () => {
  const page = read('index.html');
  assert.doesNotMatch(page, /id="courtTabs"|class="court-tab"|function switchCourtTab/);
  assert.doesNotMatch(page, /🕐\s*Available times|📍\s*\$\{esc\(c\.name\)\}/);
  assert.match(
    page,
    /@media\(max-width:700px\)\{[\s\S]*?\.cc \{ flex-direction:column; display:flex; \}/
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
  assert.match(admin, /regular bookings require (?:the )?full payment(?: amount)?/);
  assert.match(admin, /receiptRef: receiptItem\.ref/);
  assert.match(admin, /function bookingPaymentIsResolved[\s\S]*?'deposit_retained'[\s\S]*?'forfeited'/);
  assert.match(
    admin,
    /vmRejectBtn'\)\.style\.display = !readOnly && canReview \? '' : 'none'/
  );
  assert.match(
    admin,
    /vmConfirmBtn'\)\.style\.display = !readOnly && canReview \? '' : 'none'/
  );
  assert.ok((admin.match(/if \(bookingPaymentIsResolved\(bkForPay\)\)/g) || []).length >= 1);
  assert.match(admin, /item\.status === 'retained'[\s\S]*?>Resolved</);
  assert.match(client, /async updateOpenPlayHostSessionRegistration\(id, updates\)/);
});

test('booking quick confirm is a dedicated responsive row action using the canonical booking ref', () => {
  const admin = read('admin.html');
  const quickButton = functionSource(admin, 'bookingQuickConfirmButton');
  const quickButtonClosure = functionClosure(admin, 'bookingQuickConfirmButton');
  const mobileCard = functionSource(admin, 'mobileBookingCard');
  const renderBookings = functionSource(admin, 'renderBookings');
  const activeActions = functionSource(admin, 'bookingActionsHtml');

  assert.match(quickButton, /const\s+actionRef\s*=\s*b\.primaryRef\s*\|\|\s*b\.ref/);
  assert.match(quickButton, /type=["']button["']/);
  assert.match(quickButton, /booking-quick-confirm/);
  assert.match(quickButtonClosure, /confirmBookingTransaction\s*\(/);
  assert.match(quickButton, /onclick=[^\n]*\$\{jsArg\(actionRef\)\}/);

  const quickAt = mobileCard.indexOf('bookingQuickConfirmButton(');
  const detailsAt = mobileCard.indexOf('<details class="mb-book-pay">');
  assert.ok(quickAt >= 0, 'mobile booking card must render quick confirm');
  assert.ok(detailsAt > quickAt, 'mobile quick confirm must stay above the collapsed Details section');
  assert.match(mobileCard, /bookingQuickConfirmButton\(b[\s\S]*?mb-book-pay/);

  const desktopStatusCell = renderBookings.match(/<td\s+data-label=["'](?:Status|Reservation)["'][^>]*>[\s\S]*?<\/td>/)?.[0] || '';
  assert.match(desktopStatusCell, /booking-status-stack/);
  assert.match(desktopStatusCell, /bookingQuickConfirmButton\(b/);
  assert.doesNotMatch(
    activeActions,
    /bookingQuickConfirmButton/,
    'desktop quick confirm belongs in the Reservation cell, not the crowded Actions cell',
  );
});

test('booking confirmation adapter is not served behind the obsolete receipt-stage asset token', () => {
  const client = read('supabase-config.js');
  assert.match(
    client,
    /async\s+confirmBookingTransaction\s*\(/,
    'fixture requires the newer booking-confirmation DB adapter API',
  );

  const pages = ['admin.html', 'index.html', 'host.html', 'login.html', 'player-live.html'];
  const assetUrls = pages.map(file => {
    const page = read(file);
    const match = page.match(/<script\s+src=["'](supabase-config\.js[^"']*)["']/i);
    assert.ok(match, `${file} must load the shared Supabase adapter`);
    return match[1].replaceAll('&amp;', '&');
  });

  assert.equal(
    new Set(assetUrls).size,
    1,
    'every page must request the same Supabase adapter revision',
  );
  assert.match(
    assetUrls[0],
    /^supabase-config\.js\?v=[A-Za-z0-9._-]+(?:&[A-Za-z0-9._-]+=[A-Za-z0-9._-]+)*$/,
    'the shared Supabase adapter must use an explicit cache-busting revision',
  );
  assert.doesNotMatch(
    assetUrls[0],
    /20260830-receipt-stage-v1|rollback=deb2d66/i,
    'the booking-confirmation API must not reuse the pre-confirmation receipt-stage cache key',
  );
});

test('Pages worker prevents stale shared runtime and HTML entry responses', async () => {
  const workerSource = read('_worker.js');
  const workerUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`;
  const { default: worker } = await import(workerUrl);
  const staleAssetPolicy = 'max-age=14400';
  const env = {
    PRIMARY_HOSTNAME: 'paddleragecdo.ph',
    ASSETS: {
      fetch: async () => new Response('fixture', {
        headers: { 'Cache-Control': staleAssetPolicy },
      }),
    },
  };

  const protectedRoutes = [
    '/supabase-config.js?v=obsolete',
    '/',
    '/admin',
    '/admin.html',
    '/host',
    '/host.html',
    '/login',
    '/login.html',
    '/player-live',
    '/player-live.html',
  ];
  for (const route of protectedRoutes) {
    const response = await worker.fetch(
      new Request(`https://paddleragecdo.ph${route}`),
      env,
    );
    assert.equal(
      response.headers.get('Cache-Control'),
      'no-store, max-age=0',
      `${route} must override the stale Pages asset cache policy`,
    );
  }

  const staticAsset = await worker.fetch(
    new Request('https://paddleragecdo.ph/brand-theme.css'),
    env,
  );
  assert.equal(
    staticAsset.headers.get('Cache-Control'),
    staleAssetPolicy,
    'the cache override must remain scoped to HTML and the shared DB adapter',
  );
});

test('duplicate payment risk survives a lookup narrowed to one booking group', async () => {
  const admin = read('admin.html');
  const helpersStart = admin.indexOf('function bookingStartHour');
  const helpersEnd = admin.indexOf('async function updateBookingGroupByRef', helpersStart);
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'missing active booking-group helpers');

  const bookings = [
    {
      ref: 'PB-GROUP-A-1', groupRef: 'PB-GROUP-A-G', courtId: 'c1', courtName: 'Court 1',
      date: '2026-09-01', slots: [8], startTime: '8:00 AM', endTime: '9:00 AM', duration: 1,
      total: 350, downpayment: 350, paymentMethod: 'gcash', gcashRef: '1234567890123',
      paymentStatus: 'for_verification', status: 'pending', receiptImageUrl: 'receipts/a.jpg',
      createdAt: '2026-08-30T01:00:00.000Z',
    },
    {
      ref: 'PB-GROUP-B-1', groupRef: 'PB-GROUP-B-G', courtId: 'c2', courtName: 'Court 2',
      date: '2026-09-02', slots: [9], startTime: '9:00 AM', endTime: '10:00 AM', duration: 1,
      total: 350, downpayment: 350, paymentMethod: 'gcash', gcashRef: '1234567890123',
      paymentStatus: 'for_verification', status: 'pending', receiptImageUrl: 'receipts/b.jpg',
      createdAt: '2026-08-30T02:00:00.000Z',
    },
  ];
  const DB = {
    getBookingByRef: async ref => bookings.find(booking => booking.ref === ref) || null,
    getBookings: async () => bookings,
  };
  const model = new Function(
    'DB',
    'fmtD',
    'receivedAccountKey',
    `${admin.slice(helpersStart, helpersEnd)}\nreturn { groupBookings, getBookingGroupByRef };`,
  )(DB, value => value, () => 'gcash');

  const allGroups = model.groupBookings(bookings);
  assert.equal(allGroups.length, 2, 'fixture must remain two independent booking groups');
  assert.ok(
    allGroups.every(group => group.duplicatePaymentRef),
    'the complete booking collection must flag both groups sharing the reference',
  );

  const filteredGroups = model.groupBookings([bookings[0]], bookings);
  assert.equal(filteredGroups.length, 1, 'fixture must simulate one visible group');
  assert.equal(
    filteredGroups[0].duplicatePaymentRef,
    true,
    'filtering the visible rows must not erase duplicate risk from the full booking scope',
  );
  assert.equal(filteredGroups[0].duplicatePaymentRefCount, 2);

  const visibleGroup = await model.getBookingGroupByRef('PB-GROUP-A-1');
  assert.deepEqual(visibleGroup.refs, ['PB-GROUP-A-1'], 'lookup must return only the requested group');
  assert.equal(
    visibleGroup.duplicatePaymentRef,
    true,
    'duplicate risk must not disappear merely because only one booking group is returned to the caller',
  );
});

test('row and verify-modal confirmation reuse one atomic transaction with deliberate owner review', () => {
  const admin = read('admin.html');
  const quickButton = functionSource(admin, 'bookingQuickConfirmButton');
  const quickButtonClosure = functionClosure(admin, 'bookingQuickConfirmButton');
  const transaction = functionSource(admin, 'confirmBookingTransaction');
  const transactionClosure = functionClosure(admin, 'confirmBookingTransaction');
  const verifyAndConfirm = functionSource(admin, 'verifyAndConfirm');
  const updateStatus = functionSource(admin, 'updateStatus');

  assert.match(quickButtonClosure, /confirmBookingTransaction\s*\(/);
  assert.match(verifyAndConfirm, /await\s+confirmBookingTransaction\s*\(/);
  assert.doesNotMatch(quickButton, /\bupdateStatus\s*\(/);
  assert.doesNotMatch(transaction, /\bupdateStatus\s*\(/);
  assert.doesNotMatch(
    admin,
    /updateStatus\s*\([^)]*,\s*["']confirmed["']\s*\)/,
    'confirmation must not bypass the payment guards through a bare status update',
  );
  assert.match(transaction, /await\s+DB\.confirmBookingTransaction\s*\(\s*current\.primaryRef\s*\|\|\s*key\s*\)/);
  assert.doesNotMatch(transaction, /\b(?:updateBookingGroupByRef|updatePaymentStatus)\s*\(/);
  assert.match(updateStatus, /status\s*===\s*["']confirmed["'][\s\S]*?confirmBookingTransaction\s*\(/);
  assert.match(transaction, /bookingQuickConfirmIssue\s*\(\s*current\s*\)/);
  assert.match(
    transaction,
    /if\s*\(\s*!paymentReviewDecision\s*\)[\s\S]{0,180}bookingQuickConfirmIssue/,
    'one-tap confirmation must retain the convenience safety guard',
  );
  assert.match(
    verifyAndConfirm,
    /paymentReviewDecision:\s*true/,
    'the explicit owner modal decision must be distinct from one-tap confirmation',
  );
  assert.doesNotMatch(
    quickButtonClosure,
    /paymentReviewDecision:\s*true/,
    'row quick-confirm must never opt into deliberate review semantics',
  );

  const inFlightSets = [...admin.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Set\s*\(\s*\)/g)]
    .map(match => match[1]);
  const confirmSet = inFlightSets.find(name => transaction.includes(name) && /confirm|booking/i.test(name));
  assert.ok(confirmSet, 'confirmation transaction must use a dedicated in-flight Set');
  const escapedSet = confirmSet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(transaction, new RegExp(`${escapedSet}\\.has\\s*\\(`));
  assert.match(transaction, new RegExp(`${escapedSet}\\.add\\s*\\(`));
  assert.match(transaction, new RegExp(`finally\\s*\\{[\\s\\S]*?${escapedSet}\\.delete\\s*\\(`));
  assert.match(transactionClosure, /aria-busy/);
  assert.match(transactionClosure, /\.disabled\s*=|disabled\s*:/);
  assert.match(transactionClosure, /Confirming(?:\.{3}|…)/);
  assert.match(transaction, /String\(error\?\.code \|\| ''\) === '23505'/);
  assert.match(
    transaction,
    /already linked to another payment\. Nothing was changed/,
    'a true atomic replay collision needs a clear owner-facing no-change result',
  );
});

test('quick confirmation visibility and transaction guards reject unsafe payment states', () => {
  const admin = read('admin.html');
  const buttonClosure = functionClosure(admin, 'bookingQuickConfirmButton');
  const transactionClosure = functionClosure(admin, 'confirmBookingTransaction');

  for (const [label, pattern] of [
    ['duplicate payment references', /duplicatePaymentRef/],
    ['missing durable receipts', /receiptImageUrl/],
    ['rejected receipts or payments', /rejected/],
    ['mixed grouped state', /mixed/],
    ['digital payment requirement', /isDigitalPayment/],
  ]) {
    assert.match(buttonClosure, pattern, `button visibility must guard ${label}`);
    assert.match(transactionClosure, pattern, `transaction must re-check ${label}`);
  }

  for (const guardedSource of [buttonClosure, transactionClosure]) {
    assert.match(guardedSource, /receiptStatus[\s\S]{0,180}rejected|rejected[\s\S]{0,180}receiptStatus/);
    assert.match(guardedSource, /paymentStatus[\s\S]{0,180}mixed|mixed[\s\S]{0,180}paymentStatus/);
    assert.match(guardedSource, /status[\s\S]{0,180}mixed|mixed[\s\S]{0,180}status/);
    assert.match(
      guardedSource,
      /!\s*(?:b|booking|group)\??\.hostBooking[\s\S]{0,140}<(?:[\s\S]{0,40})?total|regular bookings require (?:the )?full payment(?: amount)?/i,
      'regular underpayment must never expose or pass one-tap confirmation',
    );
  }
});

test('receipt review copy identifies each dedicated parser without mislabeling bank transfers', () => {
  const admin = read('admin.html');
  const receiptDetails = functionSource(admin, 'receiptDetailsHtml');

  assert.match(receiptDetails, /gcash_v1:\s*'Dedicated GCash v1'/);
  assert.match(receiptDetails, /gotyme_to_gcash_v1:\s*'Dedicated GoTyme → GCash v1'/);
  assert.match(receiptDetails, /maribank_to_gcash_v1:\s*'Dedicated MariBank → GCash v1'/);
  assert.match(
    receiptDetails,
    /All provider, reference, amount, time, recipient, and replay checks passed/,
  );
  assert.doesNotMatch(receiptDetails, /All dedicated GCash checks passed/);
  assert.doesNotMatch(receiptDetails, /Anchored Maya amount/);
});

test('deliberate owner review ignores analyzer labels but atomically claims real evidence keys', () => {
  assert.match(
    digitalReceiptMigration,
    /do \$manual_review_confirm_patch\$/,
  );
  assert.match(
    digitalReceiptMigration,
    /foreach guard_message[\s\S]*?The receipt is rejected and cannot be confirmed/,
  );
  assert.match(
    digitalReceiptMigration,
    /foreach guard_message[\s\S]*?proven duplicate evidence and cannot be confirmed/,
  );
  assert.match(
    digitalReceiptMigration,
    /reverse_if_offset := strpos\([\s\S]*?reverse\('if exists \('\)/,
    'analyzer-only guards must be removed structurally across pg_get_functiondef formatting variants',
  );
  assert.match(
    digitalReceiptMigration,
    /end_if_offset := strpos\(following_text, 'end if;'\)/,
  );
  assert.match(
    digitalReceiptMigration,
    /canonical_definition := replace\(original_definition, E'\\r\\n', E'\\n'\)/,
    'the Payment 2 context patch must normalize production CRLF function bodies',
  );
  assert.match(
    digitalReceiptMigration,
    /target_marker constant text := 'downpayment = b\.total'/,
  );
  assert.match(
    digitalReceiptMigration,
    /reverse_update_offset := strpos\([\s\S]*?reverse\(lower\(preceding_text\)\)[\s\S]*?reverse\(update_anchor\)/,
    'the Payment 2 context must be inserted by semantic structure, not exact whitespace',
  );
  assert.match(
    digitalReceiptMigration,
    /update_segment !~\*[\s\S]*?Payment 2 settlement shape/,
    'the structural splice must fail closed unless the located update is the settlement statement',
  );
  assert.match(
    digitalReceiptMigration,
    /create or replace function public\.claim_owner_confirmed_receipt_evidence/,
  );
  assert.match(
    digitalReceiptMigration,
    /actor_role_value not in \('owner', 'court_owner'\)/,
  );
  assert.match(
    digitalReceiptMigration,
    /perform public\.claim_payment_reference\([\s\S]*?new\.gcash_ref[\s\S]*?claim_owner_value/,
  );
  assert.match(
    digitalReceiptMigration,
    /from public\.payment_review_ledger_keys\([\s\S]*?new\.receipt_extracted[\s\S]*?new\.gcash_ref/,
  );
  assert.match(
    digitalReceiptMigration,
    /incumbent_owner is distinct from claim_owner_value[\s\S]*?already linked to another payment[\s\S]*?errcode = '23505'/,
  );
  assert.match(
    digitalReceiptMigration,
    /create trigger y95_claim_owner_confirmed_receipt_evidence[\s\S]*?before update of payment_status on public\.bookings/,
  );
});
