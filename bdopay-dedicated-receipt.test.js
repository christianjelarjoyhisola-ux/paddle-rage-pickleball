const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = __dirname;
const edge = fs.readFileSync(
  path.join(root, 'supabase/functions/verify-gcash-receipt/index.ts'),
  'utf8',
);
const registry = fs.readFileSync(
  path.join(root, 'supabase/functions/_shared/receipt-providers/index.ts'),
  'utf8',
);
const provider = fs.readFileSync(
  path.join(root, 'supabase/functions/_shared/receipt-providers/bdopay.ts'),
  'utf8',
);
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase/migrations/20260902160000_bdopay_dedicated_receipt_verifier.sql',
  ),
  'utf8',
);
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const booking = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('BDO Pay has its own parser/verifier and dedicated route', () => {
  assert.match(registry, /from "\.\/bdopay\.ts"/);
  assert.match(registry, /case "bdopay"[\s\S]*?parseBdoPayToGcashReceipt/);
  assert.match(registry, /case "bdopay"[\s\S]*?verifyBdoPayToGcashReceipt/);
  assert.match(provider, /parserVersion: "bdopay_to_gcash_v1"/);
  assert.match(edge, /provider === "bdopay"[\s\S]*?`\$\{provider\}_to_gcash`/);
  assert.match(
    edge,
    /name:\s*settings\.bdopay_receipt_recipient_name\s*\|\|/,
  );
});

test('BDO Pay evidence fails closed and claims both replay identifiers', () => {
  for (const required of [
    'REF_DATE_MISMATCH',
    'AMOUNT_CONFIRMATION_UNREADABLE',
    'INVOICE_UNREADABLE',
    'GXI_DESTINATION_UNREADABLE',
    'RECEIVER_NAME_MISMATCH',
    'RECEIVER_ACCOUNT_MISMATCH',
    'TRANSFER_STATUS_UNREADABLE',
    'INSTAPAY_QRPH_UNREADABLE',
  ]) {
    assert.match(provider, new RegExp(`"${required}"`));
  }
  assert.match(provider, /key: `bdopay:\$\{parsed\.reference\.value\}`/);
  assert.match(provider, /key: `bdopay_invoice:\$\{parsed\.invoice\.value\}`/);
  assert.match(provider, /parsed\.reference\.typedMatch === "mismatch"/);
});

test('database settlement contracts explicitly allow dedicated BDO Pay', () => {
  for (const functionName of [
    'finalize_digital_receipt_auto_approval',
    'finalize_digital_receipt_review',
    'assert_clean_registration_receipt',
  ]) {
    assert.match(migration, new RegExp(`'${functionName}'`));
  }
  assert.match(
    migration,
    /provider_value not in \(''gcash'', ''bdopay'', ''bpi'', ''gotyme'', ''maribank''\)/,
  );
  assert.match(migration, /when ''bdopay'' then ''bdopay_to_gcash''/);
  assert.match(migration, /when ''bdopay'' then ''bdopay_to_gcash_v1''/);
  assert.match(
    migration,
    /values \('bdopay_receipt_recipient_name', 'PaddleRage'\)/,
  );
});

test('staff and customer UI describe the dedicated BDO Pay verifier', () => {
  assert.match(admin, /bdopay_to_gcash_v1:\s*'Dedicated BDO Pay/);
  assert.match(admin, /id="bdopayReceiptNameInput"/);
  assert.match(admin, /id="bdopayReceiptTokenInput"/);
  assert.match(admin, /\['BDO Pay Reference'/);
  assert.match(booking, /BDO Pay → GCash\. Clean receipts can confirm automatically/);
});
