const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const read = p => fs.readFileSync(p, 'utf8');

test('UnionBank booking, open play, host and admin routing is wired end-to-end', () => {
  const page = read('index.html');
  const admin = read('admin.html');
  for (const p of ['index.html', 'supabase-config.js', 'supabase/functions/submit-public-registration/index.ts',
    'supabase/functions/host-booking-balance-payment/index.ts']) assert.match(read(p), /['"]unionbank['"]/);
  assert.match(page, /id="payOptUnionbank"/);
  assert.match(page, /paymentMethods\.unionbank.*public|paymentMethods\.unionbank = settings\.payment_method_unionbank/);
  assert.match(page, /opPickPay\('unionbank'\)/);
  assert.match(page, /unionbank:.*receiver: paymentReceiverSettings\.gcash/);
  assert.match(admin, /id="payMethodUnionbankOn"/);
  assert.match(admin, /saveSetting\('payment_method_unionbank'/);
  assert.match(admin, /Account number not shown on receipt/);
  assert.match(read('deploy-cloudflare-pages.ps1'), /assets\/payment-methods\/unionbank\.svg/);
});
test('UnionBank dedicated contracts are connected to settlement', () => {
  const registry = read('supabase/functions/_shared/receipt-providers/index.ts');
  assert.match(registry, /from "\.\/unionbank\.ts"/);
  assert.match(registry, /case "unionbank":[\s\S]*parseUnionbankToGcashReceipt/);
  assert.match(registry, /case "unionbank":[\s\S]*verifyUnionbankToGcashReceipt/);
  const edge = read('supabase/functions/verify-gcash-receipt/index.ts');
  assert.match(edge, /provider === "unionbank"[\s\S]*name: settings\.gcash_qr_receipt_recipient_name/);
  assert.match(edge, /providerVerification\?\.provider === "unionbank"[\s\S]*recipientComparison\.name === "exact"/);
  const migration = read('supabase/migrations/20260921010000_unionbank_dedicated_receipt_verifier.sql');
  for (const name of ['finalize_digital_receipt_auto_approval', 'finalize_digital_receipt_review',
    'assert_clean_registration_receipt', 'booking_payment_transfers_method_check', 'unionbank_to_gcash_v1']) assert.ok(migration.includes(name));
});
test('UnionBank UI scripts parse and new IDs remain unique', () => {
  for (const file of ['index.html', 'admin.html']) {
    const html = read(file);
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc=|application\/ld\+json/.test(match[1])) continue;
      new vm.Script(match[2], { filename: file });
    }
    for (const id of ['payOptUnionbank', 'payMethodUnionbankOn', 'gcashQrReceiptNameInput']) {
      assert.ok([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length <= 1, `${file}: duplicate ${id}`);
    }
  }
});
