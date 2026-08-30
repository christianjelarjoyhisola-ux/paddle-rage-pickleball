const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const admin = fs.readFileSync('admin.html', 'utf8');
const hostBalanceAdmin = fs.readFileSync('host-balance-admin.js', 'utf8');
const balanceEdge = fs.readFileSync('supabase/functions/host-booking-balance-payment/index.ts', 'utf8');
const deadlineEdge = fs.readFileSync('supabase/functions/process-host-balance-deadlines/index.ts', 'utf8');
const visibilityMigration = fs.readFileSync(
  'supabase/migrations/20260831100000_host_balance_admin_visibility.sql',
  'utf8',
);

test('late-binds Payment Review so the host balance wrapper runs on navigation', () => {
  assert.match(admin, /payreview:\(\)=>renderPaymentReview\(\)/);
  assert.doesNotMatch(admin, /payreview:renderPaymentReview(?:[,}])/);
  assert.match(
    hostBalanceAdmin,
    /global\.renderPaymentReview\s*=\s*async function wrappedPaymentReview\(\)[\s\S]*?await render\(false\)/,
  );
});

test('loads pending host balances and keeps Payment History available for every host booking', () => {
  assert.match(admin, /HostBalanceAdmin\?\.load\?\.\(false\)/);
  assert.match(admin, /function hostBalancePendingBadge\(b\)/);
  assert.match(admin, /PAYMENT REVIEW NEEDED/);
  assert.match(admin, /function hostPaymentHistoryButton\(b, mobile = false\)/);
  assert.match(admin, /if \(!b\?\.hostBooking\) return ''/);
  assert.match(admin, /function canViewHostPaymentHistory\(\)[\s\S]*?\['owner','court_owner'\]/);
  assert.match(admin, /if \(!canViewHostPaymentHistory\(\)\) return ''/);
  assert.match(admin, /openHostPaymentHistory\('\$\{jsArg\(actionRef\)\}',this\)/);
  assert.match(admin, /const balanceReviewLocked = hasBalance && balanceReviewState !== 'clear'/);
  assert.match(admin, /const canRecordManualPayment = hasBalance && !balanceReviewLocked/);
  assert.match(hostBalanceAdmin, /function pendingForBooking\(booking\)/);
  assert.match(hostBalanceAdmin, /function statusForBooking\(booking\)/);
  assert.match(hostBalanceAdmin, /async function reviewForBooking\(booking, trigger\)/);
  assert.match(hostBalanceAdmin, /async function openHistoryForBooking\(booking, trigger\)/);
  assert.match(hostBalanceAdmin, /apiCall\('history_for_booking', \{ bookingRef \}\)/);
  assert.match(hostBalanceAdmin, /review\.addEventListener\('click', event => openHistoryForBooking\(payment, event\.currentTarget\)\)/);
  assert.match(hostBalanceAdmin, /pendingForBooking,[\s\S]*?reviewForBooking,[\s\S]*?openHistoryForBooking,/);
});

test('resolves the real list_pending payment shape when Payment Review opens history', () => {
  const resolverStart = hostBalanceAdmin.indexOf('function actualBookingRef(booking)');
  const resolverEnd = hostBalanceAdmin.indexOf('\n  function humanizeFlag', resolverStart);
  const resolver = hostBalanceAdmin.slice(resolverStart, resolverEnd);

  assert.notEqual(resolverStart, -1, 'actualBookingRef must remain the single history ref resolver');
  assert.match(balanceEdge, /bookingRef: row\.booking_ref/);
  assert.match(
    hostBalanceAdmin,
    /review\.addEventListener\('click', event => openHistoryForBooking\(payment, event\.currentTarget\)\)/,
  );
  assert.match(resolver, /booking\?\.bookingRef/);
  assert.match(resolver, /booking\?\.booking_ref/);
});

test('paginates the complete pending queue and fails closed when it is unavailable', () => {
  assert.match(hostBalanceAdmin, /apiCall\('list_pending', \{ limit: 100, offset \}\)/);
  assert.match(hostBalanceAdmin, /state\.loadState = 'error'/);
  assert.match(hostBalanceAdmin, /state\.loadState === 'ready' \? 'clear' : 'unknown'/);
  assert.match(balanceEdge, /const offset = Number\.isSafeInteger\(requestedOffset\)/);
  assert.match(balanceEdge, /\.range\(offset, offset \+ limit - 1\)/);
  assert.match(balanceEdge, /nextOffset: payments\.length === limit/);
  assert.match(admin, /Balance review unavailable/);
  assert.match(admin, /balanceReviewLocked\?'disabled title="Balance review status is unavailable"'/);
  assert.match(admin, /canDelete && !forfeited && !balanceReviewLocked/);
});

test('refreshes balance indicators in realtime without changing canonical booking payment state', () => {
  assert.match(admin, /table:'host_booking_balance_payments'\},rerenderHostBalances/);
  assert.match(admin, /HostBalanceAdmin\?\.invalidate\?\.\(\)/);
  assert.match(hostBalanceAdmin, /function invalidate\(\)\s*{\s*state\.generation \+= 1;\s*state\.loadedAt = 0;/);
  assert.match(visibilityMigration, /alter publication supabase_realtime[\s\S]*?add table public\.host_booking_balance_payments/);
  assert.doesNotMatch(admin, /PAYMENT REVIEW NEEDED[\s\S]{0,200}updatePaymentStatus/);
});

test('separates reservation state from pending balance review on desktop and mobile', () => {
  assert.match(admin, /<th>Method<\/th><th>Payment Status<\/th><th>Reservation<\/th>/);
  assert.match(admin, /COURT RESERVED/);
  assert.match(admin, /Awaiting Payment 2 review/);
  assert.match(admin, /Payment History — balance review needed/);
  assert.match(admin, /balanceReviewState === 'pending' \? '' : `<select/);
  assert.match(admin, /deposit accepted · \$\{fmt\(pendingAmount\)\} submitted/);
  assert.match(admin, /Awaiting owner verification/);
  assert.match(admin, /<div class="mb-book-primary-actions">\$\{bookingDetailsButton\(b\)\}\$\{hostPaymentHistoryButton\(b, true\)\}<\/div>/);
  assert.match(admin, /b\.hostBooking \? hostDepositEvidenceBadge\(b\) : receiptBadge\(b\)/);
  assert.match(admin, /<span>Payment status<\/span><span>\$\{bookingPayStateSelect\(b\)\}<\/span>/);
  assert.match(admin, /<span>Deposit<\/span><span>\$\{hostDepositEvidenceBadge\(b\) \|\| 'Not recorded'\}<\/span>/);
  assert.match(admin, /bookingActionsHtml\(b, canDelete, !b\.hostBooking\)/);
  const pendingBranch = admin.match(/if \(hostBalancePendingPayment\(b\)\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.match(pendingBranch, /PAYMENT REVIEW NEEDED/);
  assert.doesNotMatch(pendingBranch, /payStatusBdg\('downpayment_paid'\)/);
  assert.match(hostBalanceAdmin, /Court reserved/);
  assert.match(hostBalanceAdmin, /Payment 1 secured the court and stays read-only/);
});

test('reveals a successfully loaded host balance receipt', () => {
  assert.match(hostBalanceAdmin, /function prepareReceiptImage\([\s\S]*?image\.addEventListener\('load'/);
  assert.match(hostBalanceAdmin, /image\.style\.display = 'block'/);
  assert.match(hostBalanceAdmin, /status\.style\.display = 'none'/);
  assert.match(hostBalanceAdmin, /link\.style\.display = 'inline-flex'/);
  assert.doesNotMatch(hostBalanceAdmin, /image\.style\.display = ''/);
  assert.match(hostBalanceAdmin, /onLoad\(\) \{\s*state\.receiptLoaded = true;\s*syncActions\(\);/);
  assert.match(admin, /host-balance-admin\.js\?v=20260831-host-balance-v6/);
});

test('shows a premium two-payment history without merging financial evidence', () => {
  assert.match(hostBalanceAdmin, /Booking Payment History/);
  assert.match(hostBalanceAdmin, /Payment 1 of 2/);
  assert.match(hostBalanceAdmin, /Reservation deposit/);
  assert.match(hostBalanceAdmin, /Payment 2 of 2/);
  assert.match(hostBalanceAdmin, /Remaining balance/);
  assert.match(hostBalanceAdmin, /appendMetric\(moneyStrip, 'Payment 1 · Accepted', depositAmount == null \? 'Amount unavailable' : money\(depositAmount\)/);
  assert.match(hostBalanceAdmin, /`Payment 2 · \$\{view\.metric\}`,[\s\S]*?view\.key === 'manual' \? 'No online receipt'/);
  assert.match(hostBalanceAdmin, /Approve \$\{money\(balanceAmount \|\| 0\)\} Balance/);
  assert.match(hostBalanceAdmin, /'Payment History'/);
  assert.match(hostBalanceAdmin, /status === 'approved'[\s\S]*?label: 'Fully paid'/);
  assert.match(hostBalanceAdmin, /status === 'rejected'[\s\S]*?label: 'Balance receipt rejected'/);
  assert.match(hostBalanceAdmin, /Payment 2 approved/);
  assert.match(hostBalanceAdmin, /Payment 2 rejected/);
  assert.match(hostBalanceAdmin, /\.hba-workspace\{display:grid;grid-template-columns:255px minmax\(0,1fr\)/);
  assert.match(hostBalanceAdmin, /@media\(max-width:760px\)[\s\S]*?\.hba-workspace\{grid-template-columns:1fr\}/);
});

test('retrieves reviewer-only historical host payments without exposing receipt internals', () => {
  assert.match(balanceEdge, /if \(action === "history_for_booking"\)/);
  assert.match(balanceEdge, /function cleanBookingRef[\s\S]*?code: "22023"/);
  assert.match(balanceEdge, /const denied = requireReviewer\(actor\)/);
  assert.match(balanceEdge, /\.from\("bookings"\)[\s\S]*?\.eq\("ref", bookingRef\)[\s\S]*?\.maybeSingle\(\)/);
  assert.match(balanceEdge, /booking\.host_booking !== true/);
  assert.match(balanceEdge, /\.eq\("booking_key", bookingKey\)[\s\S]*?\.eq\("host_user_id", booking\.host_user_id\)/);
  assert.match(balanceEdge, /\.in\("status", \["pending_review", "approved", "rejected"\]\)/);
  assert.match(balanceEdge, /\.not\("receipt_verification_id", "is", null\)/);
  assert.match(balanceEdge, /payments: rows\.map\(normalizePaymentHistoryRow\)/);
  assert.match(balanceEdge, /delete payment\.receiptImageHash/);
  assert.match(balanceEdge, /delete payment\.receiptExtracted/);
  assert.doesNotMatch(
    balanceEdge.match(/if \(action === "history_for_booking"\) \{([\s\S]*?)\n    \}/)?.[1] || '',
    /receipt_image_hash|receipt_extracted|signed_url|storage_path/,
  );
});

test('places one permanent host Payment History control beside Details on desktop and mobile', () => {
  assert.match(admin, /includePrimaryActions \? `\$\{bookingDetailsButton\(b\)\} \$\{hostPaymentHistoryButton\(b\)\}`/);
  assert.match(admin, /b\.hostBooking[\s\S]{0,100}<div class="mb-book-primary-actions">\$\{bookingDetailsButton\(b\)\}\$\{hostPaymentHistoryButton\(b, true\)\}<\/div>/);
  assert.match(admin, /function openHostPaymentHistoryFromDetails\(ref\)/);
  assert.match(admin, /closeBookingDetails\(\);[\s\S]*?openHostPaymentHistory\(ref, trigger\)/);
  assert.match(admin, /b\.hostBooking && canViewHostPaymentHistory\(\) \? `<button[^`]+openHostPaymentHistoryFromDetails/);
  assert.match(admin, /!b\.hostBooking && hasReceipt[\s\S]{0,180}>View Payment<\/button>/);
  assert.doesNotMatch(admin, /hostBalanceReviewButton|reviewHostBalanceForBooking|View Deposit/);
});

test('uses the canonical booking group snapshot when no online balance receipt exists', () => {
  assert.match(balanceEdge, /bookingRowsQuery = booking\.booking_group_ref[\s\S]*?\.eq\("booking_group_ref", bookingKey\)/);
  assert.match(balanceEdge, /bookingRefs: bookingRows\.map/);
  assert.match(balanceEdge, /totalAmount: sumMoney\("total"\)/);
  assert.match(balanceEdge, /originalDepositAmount: originalDepositKnown[\s\S]*?sumMoney\("downpayment"\)[\s\S]*?: null/);
  assert.match(hostBalanceAdmin, /status: fullyPaidWithoutOnlineBalance \? 'paid_without_online_balance' : 'deposit_only'/);
  assert.match(hostBalanceAdmin, /originalPaidAmount: originalDeposit/);
  assert.match(hostBalanceAdmin, /balanceAmount: originalDeposit == null \? null/);
  assert.match(hostBalanceAdmin, /Fully paid · no online balance receipt/);
  assert.match(hostBalanceAdmin, /Payment 1 keeps the original deposit evidence/);
  assert.doesNotMatch(hostBalanceAdmin, /paymentState === 'paid'[\s\S]{0,80}\? total/);
});

test('renders the current reservation state and never invents reviewer facts', () => {
  assert.match(hostBalanceAdmin, /function reservationStatusView\(payment\)/);
  assert.match(hostBalanceAdmin, /Booking completed/);
  assert.match(hostBalanceAdmin, /Booking cancelled/);
  assert.match(hostBalanceAdmin, /Slot released · deposit retained/);
  assert.match(hostBalanceAdmin, /reservationChip\.textContent = reservation\.label/);
  assert.match(hostBalanceAdmin, /'Review time unavailable'/);
  assert.match(hostBalanceAdmin, /'Reviewer unavailable\.'/);
  assert.doesNotMatch(hostBalanceAdmin, /reviewed_by_role', 'owner'/);
});

test('loads the accepted deposit through its existing private receipt API', () => {
  assert.match(hostBalanceAdmin, /function depositBookingRefs\(payment\)/);
  assert.match(hostBalanceAdmin, /if \(ref && !refs\.includes\(ref\)\) refs\.push\(ref\)/);
  assert.match(hostBalanceAdmin, /db\.getBookingByRef\(ref\)\.catch\(\(\) => null\)/);
  assert.match(hostBalanceAdmin, /global\.DB\.getReceiptSignedUrl\(booking\.ref\)/);
  assert.match(hostBalanceAdmin, /depositProof\.show\(url\)/);
  assert.doesNotMatch(hostBalanceAdmin, /depositProof\.show\(booking\.receiptImageUrl\)/);
  assert.match(hostBalanceAdmin, /function secureReceiptUrl\(value\)[\s\S]*?url\.protocol !== 'https:'/);
  assert.match(hostBalanceAdmin, /onLoad\(\) \{ state\.depositReceiptLoaded = true; \}/);
  assert.match(hostBalanceAdmin, /if \(!depositHistoryLoaded\)[\s\S]*?Accepted · history unavailable/);
  assert.doesNotMatch(hostBalanceAdmin, /depositReceiptLoaded[\s\S]{0,120}state\.receiptLoaded = true/);
});

test('permits decisions only while viewing the loaded Payment 2 receipt', () => {
  assert.match(hostBalanceAdmin, /const reviewingBalance = state\.activeReceipt === 'balance'/);
  assert.match(hostBalanceAdmin, /!state\.reviewable \|\| !canDecide\(\) \|\| !state\.receiptLoaded \|\| !reviewingBalance/);
  assert.match(hostBalanceAdmin, /reasonField\.hidden = !reviewingBalance \|\| !state\.reviewable/);
  assert.match(hostBalanceAdmin, /actions\.hidden = !reviewingBalance \|\| !state\.reviewable/);
  assert.match(hostBalanceAdmin, /!state\.reviewable \|\| paymentStatus\(payment\) !== 'pending_review'/);
  assert.match(hostBalanceAdmin, /state\.activeReceipt !== 'balance'\) return/);
  assert.match(hostBalanceAdmin, /state\.reviewable = view\.key === 'pending'/);
  assert.match(hostBalanceAdmin, /selectPaymentReceipt\(view\.hasBalanceReceipt \? 'balance' : 'deposit'\)/);
  assert.match(hostBalanceAdmin, /Payment 1 is read-only\. Select Payment 2/);
  assert.match(hostBalanceAdmin, /Read-only history\. Payment 2 was approved/);
  assert.match(hostBalanceAdmin, /Read-only history\. Payment 2 was rejected/);
  assert.match(hostBalanceAdmin, /Reject Payment 2/);
  assert.match(hostBalanceAdmin, /Approve Payment 2 — \$\{amount\} remaining balance/);
  assert.match(hostBalanceAdmin, /for \(const id of \['hostDepositProofImage', 'hostBalanceProofImage'\]\)[\s\S]*?removeAttribute\('src'\)/);
  assert.match(hostBalanceAdmin, /for \(const id of \['hostDepositProofLink', 'hostBalanceProofLink'\]\)[\s\S]*?removeAttribute\('href'\)/);
});

test('keeps owner review actions fail-closed until the Payment 2 image load event', () => {
  const syncStart = hostBalanceAdmin.indexOf('function syncActions()');
  const syncEnd = hostBalanceAdmin.indexOf('\n  function ensureModal', syncStart);
  const syncActions = hostBalanceAdmin.slice(syncStart, syncEnd);
  const modalStart = hostBalanceAdmin.indexOf('async function openModal(payment, trigger)');
  const modalEnd = hostBalanceAdmin.indexOf('\n  function closeModal', modalStart);
  const openModal = hostBalanceAdmin.slice(modalStart, modalEnd);
  const decideStart = hostBalanceAdmin.indexOf('async function decide(decision)');
  const decideEnd = hostBalanceAdmin.indexOf('\n  function renderCards', decideStart);
  const decide = hostBalanceAdmin.slice(decideStart, decideEnd);

  assert.notEqual(syncStart, -1, 'syncActions must own the visible action gate');
  assert.notEqual(modalStart, -1, 'openModal must reset receipt state for each review');
  assert.notEqual(decideStart, -1, 'decide must independently enforce the receipt gate');
  assert.match(syncActions, /!state\.reviewable[\s\S]*?!state\.receiptLoaded[\s\S]*?!reviewingBalance/);
  assert.match(openModal, /state\.receiptLoaded = false/);
  assert.match(openModal, /onLoad\(\) \{\s*state\.receiptLoaded = true;\s*syncActions\(\);/);
  assert.match(openModal, /onError\([^)]*\) \{\s*state\.receiptLoaded = false;\s*syncActions\(\);/);
  assert.doesNotMatch(openModal, /balanceProof\.show\([^)]*\);\s*state\.receiptLoaded = true/);
  assert.match(
    decide,
    /!state\.reviewable[\s\S]*?paymentStatus\(payment\) !== 'pending_review'[\s\S]*?!state\.receiptLoaded[\s\S]*?state\.activeReceipt !== 'balance'/,
  );
});

test('blocks conflicting booking mutations and reminders during pending review', () => {
  assert.match(admin, /historicalBalance > 0 && balanceReviewState === 'clear'/);
  assert.match(admin, /A balance receipt is already awaiting owner review/);
  assert.match(deadlineEdge, /loadPendingBalancePayments\(db\)/);
  assert.match(deadlineEdge, /groupHasPendingBalance\(rows, pendingPayments\)/);
  assert.match(deadlineEdge, /Balance receipt pending owner review/);
  assert.match(visibilityMigration, /create or replace function public\.protect_pending_host_balance_booking\(\)/);
  assert.match(visibilityMigration, /before update or delete on public\.bookings/);
  assert.match(visibilityMigration, /payment\.status = 'pending_review'/);
  assert.match(visibilityMigration, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(visibilityMigration, /old\.duration is distinct from new\.duration/);
  assert.match(visibilityMigration, /old\.slots is distinct from new\.slots/);
  assert.match(
    visibilityMigration,
    /create or replace function public\.claim_booking_balance_notification[\s\S]*?for update;[\s\S]*?'balance_pending_review'/,
  );
  assert.match(visibilityMigration, /payment\.status = 'approved'/);
  assert.match(visibilityMigration, /'balance_already_paid'/);
  assert.match(visibilityMigration, /'booking_not_payable'/);
  assert.match(visibilityMigration, /booking\.status = 'confirmed'/);
  assert.match(visibilityMigration, /booking\.payment_status = 'downpayment_paid'/);
  assert.match(deadlineEdge, /claim\.reason === "balance_pending_review"/);
});

test('invalidates a stale Admin shell when another account replaces its session', () => {
  assert.match(admin, /function startAdminSessionGuard\(\)/);
  assert.match(admin, /event\.key!=='pb_session'/);
  assert.match(admin, /_supabase\.auth\.onAuthStateChange/);
  assert.match(admin, /nextUserId!==bootUserId/);
  assert.match(admin, /invalidateStaleAdminSession\(\)/);
  assert.match(admin, /startAdminSessionGuard\(\);/);
});
