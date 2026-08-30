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

test('keeps Paddle duplicate-payment evidence and unreadable images blocked', () => {
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
  assert.doesNotMatch(migration, /DUPLICATE_MARIBANK_TRANSACTION/);
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
