const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const migration = fs.readFileSync(
  'supabase/migrations/20260830160000_host_booking_parity.sql',
  'utf8',
);
const verifier = fs.readFileSync(
  'supabase/functions/verify-gcash-receipt/index.ts',
  'utf8',
);
const paymentExpansion = fs.readFileSync(
  'supabase/migrations/20260901090000_receipt_review_maribank.sql',
  'utf8',
);

test('routes reviewable host balance verification failures to owner review', () => {
  assert.match(
    migration,
    /create or replace function public\.route_host_balance_receipt_for_owner_review/,
  );
  assert.match(
    migration,
    /verificationContext'\s*,\s*''\)\s*=\s*\n?\s*'host_booking_balance'/,
  );
  assert.match(migration, /new\.result\s*=\s*'rejected'/);
  assert.match(migration, /new\.result\s*:=\s*'manual_review'/);
  assert.match(migration, /'automaticResult',\s*'rejected'/);
  assert.match(migration, /'reviewRouting',\s*'pending_owner_review'/);
  assert.match(
    migration,
    /before insert on public\.receipt_verifications[\s\S]*?route_host_balance_receipt_for_owner_review/,
  );
});

test('retains duplicate and unreadable evidence while routing every automatic rejection to review', () => {
  for (const flag of [
    'DUPLICATE_REF',
    'DUPLICATE_INVOICE',
    'DUPLICATE_INSTAPAY_REF',
    'DUPLICATE_BPI_TRANSACTION_REF',
    'IMAGE_UNREADABLE',
  ]) {
    assert.match(migration, new RegExp(`'${flag}'`));
  }
  assert.match(
    migration,
    /not coalesce\(new\.flags, array\[\]::text\[\]\) && v_blocking_flags/,
  );
  assert.match(paymentExpansion, /'AUTO_REJECTION_SUPPRESSED'/);
  assert.match(
    paymentExpansion,
    /if lower\(trim\(coalesce\(new\.result, ''\)\)\) = 'rejected'[\s\S]*?new\.result := 'manual_review'/,
  );
  assert.doesNotMatch(migration, /DUPLICATE_MARIBANK_TRANSACTION/);
});

test('allows host-balance auto approval only for clean, valid verifier evidence', () => {
  assert.match(
    paymentExpansion,
    /create or replace function public\.receipt_auto_approval_evidence_is_clean/,
  );
  assert.match(
    paymentExpansion,
    /cardinality\(coalesce\(p_flags, array\[\]::text\[\]\)\) = 0/,
  );
  assert.match(paymentExpansion, /p_confidence >= 0\.90/);
  assert.match(
    paymentExpansion,
    /p_extracted#>>'\{verification,decision\}'[\s\S]*?= 'valid'/,
  );
  for (const verifierField of [
    'sourceProviderMatch',
    'referenceMatch',
    'amountMatch',
    'timestampValid',
    'recipientMatch',
    'duplicateClear',
  ]) {
    assert.match(
      paymentExpansion,
      new RegExp(`verification,${verifierField}\\}'[\\s\\S]*?= 'true'`),
    );
  }
  assert.match(
    paymentExpansion,
    /elsif lower\(trim\(coalesce\(new\.result, ''\)\)\) = 'auto_approved'[\s\S]*?receipt_auto_approval_evidence_is_clean[\s\S]*?new\.result := 'manual_review'/,
  );
  assert.ok(
    (paymentExpansion.match(/receipt_auto_approval_evidence_is_clean\(/g) || []).length >= 3,
    'clean-evidence predicate must protect inserts and host-balance audit consumption',
  );
});

test('normalizes historical rejected host-balance audits so owners can still resolve pending review', () => {
  const forwardOverride = paymentExpansion.slice(
    paymentExpansion.indexOf(
      'create or replace function public.assert_host_booking_balance_receipt_audit',
    ),
    paymentExpansion.indexOf(
      '-- This trigger runs before the existing z90 reference-claim trigger.',
    ),
  );
  assert.match(
    forwardOverride,
    /if v_audit\.result = 'rejected'[\s\S]*?automatic_rejection_review_flags\(v_audit\.flags\)[\s\S]*?v_audit\.result := 'manual_review'/,
  );
  assert.match(
    forwardOverride,
    /elsif v_audit\.result = 'auto_approved'[\s\S]*?automatic_approval_review_flags\(v_audit\.flags\)[\s\S]*?v_audit\.result := 'manual_review'/,
  );
});

test('requires an exact OCR amount before a host balance can auto-approve', () => {
  assert.match(
    verifier,
    /hostBalancePayment && extractedAmount != null &&\s*!closeMoney\(extractedAmount, expectedAmount\)/,
  );
  assert.match(verifier, /flags\.push\("AMOUNT_MISMATCH"\)/);
  assert.match(
    verifier,
    /verificationContext[\s\S]*?"host_booking_balance"/,
  );
});

test('host balance audits bind payment id, provider, amount, and fresh evidence', () => {
  assert.match(
    migration,
    /create or replace function public\.assert_host_booking_balance_receipt_audit/,
  );
  assert.match(migration, /r\.booking_ref = v_payment\.verification_ref/);
  assert.match(
    migration,
    /v_audit\.created_at < v_payment\.created_at - interval '5 seconds'/,
  );
  assert.match(
    migration,
    /v_audit\.extracted->>'verificationContext'[\s\S]*?'host_booking_balance'/,
  );
  assert.match(
    migration,
    /v_audit\.extracted->>'balancePaymentId'[\s\S]*?v_payment\.id::text/,
  );
  assert.match(
    migration,
    /v_audit\.extracted->>'expectedAmount'[\s\S]*?v_payment\.expected_amount/,
  );
  assert.match(
    migration,
    /v_audit\.extracted->>'submittedReference'[\s\S]*?v_payment\.payment_reference/,
  );
});

test('Paddle payment replay keys are canonical and service-only', () => {
  assert.match(
    migration,
    /create or replace function public\.payment_review_ledger_keys/,
  );
  assert.match(migration, /p_extracted->'dedupeKeys'/);
  assert.match(migration, /clean_provider in \('bdopay', 'maya', 'bpi', 'gotyme', 'pnb'\)/);
  assert.doesNotMatch(migration, /clean_provider = 'maribank'/);
  assert.match(
    migration,
    /revoke all on function public\.payment_review_ledger_keys\([\s\S]*?from public, anon, authenticated/,
  );
  assert.match(
    paymentExpansion,
    /'public\.payment_review_ledger_keys\(jsonb,text,text\)'/,
  );
  assert.match(
    paymentExpansion,
    /'''gotyme'', ''maribank'', ''pnb'''/,
  );
});

test('forward payment policy enables shared-GCash providers and keeps owner Not Received atomic', () => {
  assert.match(
    paymentExpansion,
    /values\s+\('payment_method_gotyme', '1'\),\s+\('payment_method_maribank', '1'\)/,
  );
  assert.match(paymentExpansion, /new\.result := 'manual_review'/);
  assert.match(
    paymentExpansion,
    /create or replace function public\.reject_booking_payment_transaction/,
  );
  assert.match(
    paymentExpansion,
    /has_account_role\(array\['owner', 'court_owner'\]\)/,
  );
  assert.match(
    paymentExpansion,
    /set status = 'cancelled',[\s\S]*?payment_status = 'rejected'/,
  );
  assert.match(
    paymentExpansion,
    /create or replace function public\.guard_digital_payment_decision_role/,
  );
  assert.match(
    paymentExpansion,
    /actor_role_value in \('owner', 'court_owner'\)[\s\S]*?request_role_value = 'service_role'[\s\S]*?'auto_approved'/,
  );
  assert.ok(
    (paymentExpansion.match(/for each row execute function public\.guard_digital_payment_decision_role\(\)/g) || []).length >= 3,
  );
});

test('review decisions are private, immutable financial audit records', () => {
  assert.match(migration, /create table if not exists public\.payment_review_decisions/);
  assert.match(migration, /alter table public\.payment_review_decisions enable row level security/);
  assert.match(
    migration,
    /revoke all on table public\.payment_review_decisions from (?:public, )?anon, authenticated/,
  );
  assert.match(migration, /grant select on table public\.payment_review_decisions to authenticated/);
  assert.doesNotMatch(
    migration,
    /grant\s+(?:insert|update|delete|all)\s+on table public\.payment_review_decisions to authenticated/i,
  );
});
