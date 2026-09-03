const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '..', '..', 'migrations', '20260904100000_booking_reschedule_workflow.sql'),
  'utf8',
);

test('function RPC calls match the service-only database contract', () => {
  assert.match(migration, /claim_booking_reschedule_notifications\(\s*p_worker_id text,\s*p_limit integer default 10,\s*p_lease_seconds integer default 180,\s*p_request_id uuid default null/s);
  assert.match(migration, /finish_booking_reschedule_notification\(\s*p_notification_id uuid,\s*p_lease_token uuid,\s*p_succeeded boolean,\s*p_error text default null/s);
  assert.match(migration, /'requestStatus', request\.status/);
  assert.match(migration, /'deliveredRecipientKeys',[\s\S]*?booking_reschedule_notification_recipients/);
  assert.match(migration, /'oldSnapshot', request\.old_snapshot/);
  assert.match(migration, /'requestedSnapshot', request\.requested_snapshot/);
  assert.match(migration, /grant execute on function public\.claim_booking_reschedule_notifications\([\s\S]*?\) to service_role/);
  assert.match(migration, /retry_booking_reschedule_notifications\(\s*p_request_id uuid\s*\)[\s\S]*?outbox\.status = 'failed'[\s\S]*?outbox\.attempts < 20/);
  assert.match(migration, /grant execute on function public\.retry_booking_reschedule_notifications\(uuid\)\s+to service_role/);
  assert.match(migration, /record_booking_reschedule_notification_recipient\(\s*p_notification_id uuid,\s*p_lease_token uuid,\s*p_recipient_key text,\s*p_succeeded boolean,\s*p_error text default null/s);
  assert.match(migration, /grant execute on function public\.record_booking_reschedule_notification_recipient\([\s\S]*?\)\s+to service_role/);
  assert.match(migration, /primary key \(notification_id, recipient_key\)/);
  assert.match(migration, /recipient\.sent_at is not null[\s\S]*?'\[\]'::jsonb/);
  assert.match(migration, /sent_at = coalesce\(\s*recipient\.sent_at,/s);
  assert.match(migration, /revoke all on table public\.booking_reschedule_notification_recipients\s+from public, anon, authenticated, service_role/);
  assert.match(migration, /grant execute on function public\.get_public_booking_reschedule_state\(text, text, text\)\s+to anon, authenticated, service_role/);
});

test('reschedule notifier authorizes only active owners or a verified guest request', () => {
  assert.match(source, /ADMIN_ROLES = new Set\(\["owner", "court_owner"\]\)/);
  assert.match(source, /account\?\.status === "active" && ADMIN_ROLES\.has\(role\)/);
  assert.match(source, /get_public_booking_reschedule_state/);
  assert.match(source, /text\(request\.id, 80\)\.toLowerCase\(\) !== requestedId/);
  assert.match(source, /\^\[0-9a-fA-F\]\{64\}\$/);
});

test('reschedule notifier claims canonical outbox rows with a bounded lease', () => {
  assert.match(source, /const MAX_CLAIM_BATCH = 4/);
  assert.match(source, /claim_booking_reschedule_notifications/);
  assert.match(source, /p_request_id: requestedId/);
  assert.match(source, /p_lease_seconds: LEASE_SECONDS/);
  assert.match(source, /finish_booking_reschedule_notification/);
  assert.match(source, /p_lease_token: leaseToken/);
  assert.match(source, /p_succeeded: succeeded/);
  assert.match(source, /Math\.min\([\s\S]*?MAX_CLAIM_BATCH/);
});

test('owner retry makes failed request deliveries eligible before claiming', () => {
  assert.match(source, /if \(action === "retry"\)/);
  assert.match(source, /"retry_booking_reschedule_notifications"/);
  assert.match(source, /\{ p_request_id: requestedId \}/);
  assert.match(source, /requestId is required to retry delivery/);
});

test('caller cannot supply customer or schedule facts used for delivery', () => {
  const bodyType = source.match(/type DispatchBody = \{([\s\S]*?)\n\};/)?.[1] || '';
  assert.match(bodyType, /requestId\?: unknown/);
  assert.match(bodyType, /bookingRef\?: unknown/);
  assert.match(bodyType, /email\?: unknown/);
  assert.match(bodyType, /accessToken\?: unknown/);
  assert.doesNotMatch(bodyType, /customerName|oldSnapshot|requestedSnapshot|decisionReason/);
  assert.match(source, /rawNotifications\.map\(claimedNotification\)/);
});

test('customer email covers every reschedule lifecycle notification', () => {
  for (const kind of [
    'customer_request_received',
    'customer_approved',
    'customer_rejected',
    'customer_conflicted',
    'customer_withdrawn',
  ]) {
    assert.match(source, new RegExp(`"${kind}"`));
  }
  assert.match(source, /sendMailerooEmail/);
  assert.match(source, /Payments are non-refundable/);
});

test('Telegram is restricted to pending admin review and contains no customer PII', () => {
  assert.match(source, /TELEGRAM_KIND = "admin_review_needed"/);
  assert.match(source, /sendTelegramRecipient/);
  assert.match(source, /notification\.requestStatus !== "pending"/);
  const telegramRenderer = source.match(
    /function telegramMessage\([\s\S]*?\n\}/,
  )?.[0] || '';
  assert.match(telegramRenderer, /RESCHEDULE REQUEST/);
  assert.match(telegramRenderer, /Pending owner review/);
  assert.doesNotMatch(telegramRenderer, /customerName|customerEmail|decisionReason|note/);
});

test('stale request-received email is completed without being sent', () => {
  assert.match(
    source,
    /\["customer_request_received", TELEGRAM_KIND\]\.includes\(notification\.kind\)\s*&&\s*notification\.requestStatus !== "pending"/,
  );
});

test('Telegram retries only recipients without persisted success', () => {
  assert.match(source, /deliveredRecipientKeys: string\[\]/);
  assert.match(source, /new Set\(notification\.deliveredRecipientKeys\)/);
  assert.match(source, /deliveredKeys\.has\(recipientKey\)/);
  assert.match(source, /"record_booking_reschedule_notification_recipient"/);
  assert.match(source, /p_recipient_key: recipientKey/);
  assert.match(source, /p_succeeded: succeeded/);
  assert.match(source, /name: "HMAC", hash: "SHA-256"/);
  assert.doesNotMatch(source, /p_recipient_(?:key|id): chatId/);
});

test('Telegram provider calls have a hard timeout', () => {
  assert.match(source, /const TELEGRAM_TIMEOUT_MS = 12_000/);
  assert.match(source, /signal: AbortSignal\.timeout\(TELEGRAM_TIMEOUT_MS\)/);
  assert.match(source, /!response\.ok \|\| payload\.ok !== true/);
});

test('responses use an origin allowlist and disable caching', () => {
  assert.match(source, /isAllowedEmailOrigin\(req\)/);
  assert.match(source, /emailCorsHeaders\(req\)/);
  assert.match(source, /"Cache-Control": "no-store, max-age=0"/);
  assert.match(source, /"X-Content-Type-Options": "nosniff"/);
});
