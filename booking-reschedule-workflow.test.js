const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20260904100000_booking_reschedule_workflow.sql');
const adapter = read('supabase-config.js');
const guestHtml = read('manage-booking.html');
const guestJs = read('manage-booking.js');
const guestCss = read('manage-booking.css');
const admin = read('admin.html');
const notifier = read('supabase/functions/booking-reschedule-notifications/index.ts');

function sqlFunction(source, name) {
  const start = source.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\b`, 'i'));
  if (start < 0) return '';
  const end = source.indexOf('\n$$;', start);
  return end < 0 ? source.slice(start) : source.slice(start, end + 4);
}

function adapterMethod(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const end = nextSignature ? source.indexOf(nextSignature, start + signature.length) : -1;
  return source.slice(start, end < 0 ? undefined : end);
}

test('reschedule records are private, durable, and append-only', () => {
  for (const table of [
    'booking_reschedule_requests',
    'booking_reschedule_request_items',
    'booking_reschedule_active_items',
    'booking_reschedule_events',
    'booking_reschedule_notification_outbox',
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table}[\\s\\S]{0,100}from public, anon, authenticated`));
  }
  assert.match(migration, /Reschedule request evidence is immutable/);
  assert.match(migration, /Reschedule audit rows are append-only/);
  assert.match(migration, /unique[\s\S]{0,160}booking_family_key[\s\S]{0,120}status = 'pending'/i);
});

test('guest request RPCs require reference, normalized email, and original-device proof', () => {
  const context = sqlFunction(migration, 'booking_reschedule_guest_context');
  assert.match(context, /p_ref text,[\s\S]*p_email text,[\s\S]*p_access_token text/);
  assert.match(context, /p_access_token, ''\) !~ '\^\[0-9a-fA-F\]\{64\}\$'/);
  assert.match(context, /digest\(p_access_token, 'sha256'\)/);
  assert.match(context, /customer_access_token_hash = token_hash/);
  assert.match(context, /lower\(btrim\(coalesce\(booking\.email, ''\)\)\) = requested_email/);
  assert.match(context, /family_count > 8/);

  for (const name of [
    'get_public_booking_reschedule_state',
    'get_public_booking_reschedule_options',
    'submit_public_booking_reschedule_request',
    'withdraw_public_booking_reschedule_request',
  ]) {
    assert.match(sqlFunction(migration, name), /booking_reschedule_guest_context/);
  }
});

test('a request keeps the original reservation and validates exact selected destination slots', () => {
  const options = sqlFunction(migration, 'get_public_booking_reschedule_options');
  const submit = sqlFunction(migration, 'submit_public_booking_reschedule_request');
  assert.match(options, /p_item_refs text\[\]/);
  assert.match(options, /normalized_refs <@ family_refs/);
  assert.match(options, /booking_reschedule_schedule_available/);
  assert.match(submit, /requested_duration = old_duration|common_duration <> cardinality\(requested_slots\)/);
  assert.match(submit, /Requested time slots must be consecutive/);
  assert.match(submit, /acknowledged_no_refund/);
  assert.match(submit, /acknowledged_slot_not_held/);
  assert.match(submit, /insert into public\.booking_reschedule_requests/);
  assert.doesNotMatch(submit, /update\s+public\.bookings/i, 'submitting a request must not move the live booking');
});

test('updating a pending request is audited and cannot lose the previous valid request on failure', () => {
  const submit = sqlFunction(migration, 'submit_public_booking_reschedule_request');
  const validationAt = submit.indexOf('requested_start_time :=');
  const supersedeAt = submit.indexOf("set status = 'superseded'");
  const insertAt = submit.indexOf('insert into public.booking_reschedule_requests');
  assert.ok(validationAt > 0 && supersedeAt > validationAt && insertAt > supersedeAt);
  assert.match(submit, /event_type[\s\S]*'superseded'/);
  assert.match(submit, /delete from public\.booking_reschedule_active_items/);
  assert.match(submit, /exception[\s\S]*when unique_violation[\s\S]*REQUEST_ALREADY_PENDING/);
});

test('owner approval is authenticated, stale-safe, conflict-safe, and atomic', () => {
  const review = sqlFunction(migration, 'review_booking_reschedule_request');
  assert.match(review, /booking_reschedule_operator_role/);
  assert.match(review, /actor_role is null/);
  assert.match(review, /booking_reschedule_schedule_fingerprint/);
  assert.match(review, /for update/);
  assert.match(review, /pg_advisory_xact_lock/);
  assert.match(review, /booking_reschedule_schedule_available/);
  assert.match(review, /update public\.bookings booking[\s\S]*set date = request_item\.requested_date,[\s\S]*slots = request_item\.requested_slots,[\s\S]*start_time = request_item\.requested_start_time,[\s\S]*end_time = request_item\.requested_end_time,[\s\S]*duration = request_item\.requested_duration/);
  assert.doesNotMatch(review, /set[\s\S]{0,300}(?:payment_status|payment_method|customer_access_token_hash|total\s*=|rate\s*=)/i);
  assert.match(review, /updated_count <> cardinality\(request_row\.selected_booking_refs\)/);
  assert.match(review, /customer_(?:approved|rejected|conflicted)/);
});

test('notification outbox is leased, retryable, canonical, and service-only', () => {
  const payload = sqlFunction(migration, 'booking_reschedule_request_payload');
  const claim = sqlFunction(migration, 'claim_booking_reschedule_notifications');
  const finish = sqlFunction(migration, 'finish_booking_reschedule_notification');
  const retry = sqlFunction(migration, 'retry_booking_reschedule_notifications');
  assert.match(claim, /auth\.role\(\) <> 'service_role'/);
  assert.match(claim, /for update of outbox skip locked/);
  assert.match(claim, /attempts < 20/);
  assert.match(claim, /lease_expires_at <= now\(\)/);
  assert.match(claim, /'oldSnapshot', request\.old_snapshot/);
  assert.match(claim, /'requestedSnapshot', request\.requested_snapshot/);
  assert.match(finish, /outbox\.lease_token = p_lease_token/);
  assert.match(finish, /power\(2, least\(outbox\.attempts, 8\)\)/);
  assert.match(retry, /outbox\.status = 'failed'/);
  assert.match(payload, /'retryable',[\s\S]*outbox\.status in \('pending', 'failed'\)[\s\S]*outbox\.attempts < 20/);
  assert.match(payload, /'exhausted',[\s\S]*outbox\.status = 'failed'[\s\S]*outbox\.attempts >= 20/);
  assert.match(migration, /grant execute on function public\.claim_booking_reschedule_notifications\([\s\S]*?\) to service_role/);
  assert.match(migration, /grant execute on function public\.finish_booking_reschedule_notification\([\s\S]*?\) to service_role/);
  assert.match(migration, /grant execute on function public\.retry_booking_reschedule_notifications\(uuid\)\s+to service_role/);
});

test('guest UI uses a native premium flow and cannot submit from owner preview', () => {
  assert.match(guestHtml, /id="rescheduleDialog"[\s\S]*role="dialog"[\s\S]*aria-modal="true"/);
  assert.match(guestJs, /Request a schedule change/);
  assert.match(guestJs, /Current schedule/);
  assert.match(guestJs, /Requested schedule/);
  assert.match(guestJs, /getBookingRescheduleOptions/);
  assert.match(guestJs, /submitBookingRescheduleRequest/);
  assert.match(guestJs, /withdrawBookingRescheduleRequest/);
  assert.match(guestJs, /if \(!bookingContext \|\| ownerPreviewActive\) return/);
  assert.match(guestJs, /payments are final and non-refundable/);
  assert.match(guestJs, /not reserved until Paddle Rage approves/i);
  assert.match(guestCss, /@media \(max-width: 720px\)[\s\S]*reschedule-sheet/);
});

test('adapter sends only scoped proofs and exact selected items to guest RPCs', () => {
  const options = adapterMethod(adapter, 'async getBookingRescheduleOptions(', '\n  async submitBookingRescheduleRequest(');
  const submit = adapterMethod(adapter, 'async submitBookingRescheduleRequest(', '\n  async withdrawBookingRescheduleRequest(');
  assert.match(options, /p_item_refs: selectedRefs/);
  assert.match(options, /p_access_token: accessToken/);
  assert.match(submit, /p_item_refs: itemRefs/);
  assert.match(submit, /p_requested_slots: requestedSlots/);
  assert.match(submit, /p_acknowledged_no_refund: true/);
  assert.match(submit, /p_acknowledged_slot_not_held: true/);
  assert.match(submit, /dispatchBookingRescheduleNotifications\([\s\S]*requestId:[\s\S]*accessToken/);
  assert.doesNotMatch(guestJs, /_pbBookingAccessToken|accessToken/);
});

test('admin has a dedicated request queue and never approves by direct client booking update', () => {
  assert.match(admin, /id="bookingRescheduleQueueBtn"/);
  assert.match(admin, /id="bookingRescheduleRequestsModal"/);
  assert.match(admin, /Current reservation/);
  assert.match(admin, /Player requested/);
  assert.match(admin, /reviewBookingRescheduleRequest\('approved'\)/);
  assert.match(admin, /reviewBookingRescheduleRequest\('rejected'\)/);
  assert.match(admin, /Decline &amp; notify/);
  assert.match(admin, /Retry delivery/);
  const decision = admin.slice(admin.indexOf('async function reviewBookingRescheduleRequest('), admin.indexOf('\n}\n', admin.indexOf('async function reviewBookingRescheduleRequest(')) + 2);
  assert.doesNotMatch(decision, /DB\.updateBooking/);
  assert.match(decision, /DB\.reviewBookingRescheduleRequest/);
  assert.match(admin, /startBookingReschedulePolling/);
  assert.match(admin, /pollBookingRescheduleRequests\(\{processNotifications:true\}\)/);
  assert.match(admin, /_bookingRescheduleRequestPollInFlight/);
  assert.match(admin, /renderBookings\(\{ skipRequestRefresh:true \}\)/);
  assert.match(admin, /_bookingRescheduleRequestDrafts/);
  assert.match(admin, /_bookingRescheduleRequestOpenSeq/);
  assert.match(admin, /DB\.listBookingRescheduleRequests\(null, 200/);
  assert.match(admin, /result\?\.pendingRequests/);
  assert.match(admin, /result\?\.historyRequests/);
  assert.match(admin, /Previous schedule/);
  assert.match(admin, /Confirmed schedule/);
  assert.doesNotMatch(admin, /table:'booking_reschedule_requests'/);
});

test('owner queue receives independently bounded pending and history records in one RPC response', () => {
  const list = sqlFunction(migration, 'list_booking_reschedule_requests');
  assert.match(list, /pending_requests_payload/);
  assert.match(list, /history_requests_payload/);
  assert.match(list, /where request\.status = 'pending'/);
  assert.match(list, /where request\.status <> 'pending'/);
  assert.match(list, /'pendingRequests', pending_requests_payload/);
  assert.match(list, /'historyRequests', history_requests_payload/);
  assert.match(adapter, /pendingRequests:Array\.isArray\(result\.pendingRequests\)/);
  assert.match(adapter, /historyRequests:Array\.isArray\(result\.historyRequests\)/);
});

test('new notification function is configured and deployed with existing integrations', () => {
  const config = read('supabase/config.toml');
  const deploy = read('deploy-edge-functions.ps1');
  assert.match(config, /\[functions\.booking-reschedule-notifications\]\s*verify_jwt = true/);
  assert.match(deploy, /"booking-reschedule-notifications"/);
  assert.match(notifier, /get_public_booking_reschedule_state/);
  assert.match(notifier, /retry_booking_reschedule_notifications/);
  assert.match(notifier, /CUSTOMER_KINDS/);
  assert.match(notifier, /TELEGRAM_KIND = "admin_review_needed"/);
  assert.match(notifier, /isAllowedEmailOrigin\(req\)/);
});
