const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = __dirname;
const edge = fs.readFileSync(
  path.join(root, 'supabase/functions/verify-gcash-receipt/index.ts'),
  'utf8',
);
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase/migrations/20260902140000_bpi_dedicated_receipt_verifier.sql',
  ),
  'utf8',
);
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

test('BPI uses its configured receipt identity and dedicated GCash route', () => {
  assert.match(
    edge,
    /name:\s*settings\.bpi_receipt_recipient_name\s*\|\|[\s\S]*?settings\.bpi_merchant_name/,
  );
  assert.match(
    edge,
    /provider === "bpi"\s*\|\|\s*provider === "gotyme"[\s\S]*?`\$\{provider\}_to_gcash`/,
  );
  assert.match(
    edge,
    /recipientComparison:\s*providerVerification\?\.provider === "bpi"/,
  );
});

test('database settlement contracts explicitly allow the dedicated BPI parser', () => {
  for (const functionName of [
    'finalize_digital_receipt_auto_approval',
    'finalize_digital_receipt_review',
    'assert_clean_registration_receipt',
  ]) {
    assert.match(migration, new RegExp(`'${functionName}'`));
  }
  assert.match(
    migration,
    /provider_value not in \(''gcash'', ''bpi'', ''gotyme'', ''maribank''\)/,
  );
  assert.match(migration, /when ''bpi'' then ''bpi_to_gcash''/);
  assert.match(migration, /when ''bpi'' then ''bpi_to_gcash_v1''/);
  assert.match(
    migration,
    /values \('bpi_receipt_recipient_name', 'PaddleRage'\)[\s\S]*?on conflict \(key\) do nothing/,
  );
});

test('staff audit modal identifies and explains dedicated BPI verification', () => {
  assert.match(admin, /bpi_to_gcash_v1:\s*'Dedicated BPI/);
  assert.match(admin, /\['BPI Confirmation'/);
  assert.match(admin, /\['BPI Transaction Ref'/);
  assert.match(admin, /\['BPI QR Recipient'/);
  assert.match(admin, /bankTransfer\.recipientComparison/);
  assert.match(admin, /bankTransfer\.indicators\?\.qrCodeRecipient/);
});
