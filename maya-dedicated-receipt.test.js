const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const edge = read('supabase/functions/verify-gcash-receipt/index.ts');

test('Maya dedicated evidence reaches the OCR, audit, and settlement routes', () => {
  const registry = read('supabase/functions/_shared/receipt-providers/index.ts');
  assert.match(registry, /from "\.\/maya\.ts"/);
  assert.match(registry, /case "maya"[\s\S]*?parseMayaToGcashReceipt/);
  assert.match(registry, /case "maya"[\s\S]*?verifyMayaToGcashReceipt/);
  assert.match(edge, /providerParse\?\.provider === "maya"\s*\? providerParse\.receipt\.railReference\.value/);
  assert.match(edge, /provider === "maya" && extractedInstapayRefNo && !providerVerification/);
  assert.match(edge, /provider === "bdopay" \|\| provider === "maya" \|\| provider === "bpi"[\s\S]*?`\$\{provider\}_to_gcash`/);
  assert.match(edge, /recipientComparison: providerVerification\?\.provider === "bpi" \|\|\s*providerVerification\?\.provider === "maya"/);
  assert.match(edge, /isDedicatedReceiptProvider\(provider\)\s*\? 0\.9/);
});

test('Maya final approval requires full recipient match and every evidence gate', () => {
  const start = edge.indexOf('    const sourceProviderMatch =');
  const end = edge.indexOf('    const bookingCanAutoApprove =', start);
  assert.ok(start > 0 && end > start);
  const gate = edge.slice(start, end) + '\ncleanEvidence;';
  const evaluate = (change = {}) => {
    const receipt = {
      indicators: { providerBrand: true, competingProviderBrand: null },
      reference: { typedMatch: 'match' }, timestamp: { completeness: 'date_time' },
    };
    return vm.runInNewContext(gate, {
      providerParse: { provider: 'maya', receipt },
      providerVerification: { provider: 'maya', recipientComparison: { phone: 'exact', name: 'masked_compatible' } },
      extractedAmount: 800, expectedAmount: 800,
      amountExtraction: { reliable: true, ambiguous: false },
      flags: [], duplicateClear: true,
      closeMoney: (a, b) => Math.abs(a - b) <= 0.01,
      ...change,
    });
  };
  assert.equal(evaluate(), true);
  for (const phone of ['last4_only', 'mismatch', 'missing', 'not_configured']) {
    assert.equal(evaluate({ providerVerification: { provider: 'maya', recipientComparison: { phone, name: 'masked_compatible' } } }), false, phone);
  }
  for (const name of ['mismatch', 'missing', 'inconclusive', 'not_configured']) {
    assert.equal(evaluate({ providerVerification: { provider: 'maya', recipientComparison: { phone: 'exact', name } } }), false, name);
  }
  for (const flag of ['LOW_OCR_CONFIDENCE', 'TRANSFER_STATUS_UNREADABLE', 'AMOUNT_UNREADABLE', 'TIME_EXPIRED', 'DUPLICATE_INSTAPAY_REF']) {
    assert.equal(evaluate({ flags: [flag] }), false, flag);
  }
  assert.equal(evaluate({ extractedAmount: 810 }), false, 'fee cannot be included');
  assert.equal(evaluate({ duplicateClear: false }), false, 'replay blocked');
  assert.equal(evaluate({ amountExtraction: { reliable: true, ambiguous: true } }), false);
});

test('Maya database migration extends all three evidence contracts and aborts on drift', () => {
  const migration = read('supabase/migrations/20260905130000_maya_dedicated_receipt_verifier.sql');
  for (const name of ['finalize_digital_receipt_auto_approval', 'finalize_digital_receipt_review', 'assert_clean_registration_receipt']) {
    assert.ok(migration.includes(`'${name}'`));
  }
  assert.match(migration, /when ''maya'' then ''maya_to_gcash''/);
  assert.match(migration, /when ''maya'' then ''maya_to_gcash_v1''/);
  assert.match(migration, /updated_count <> 3/);
  assert.match(migration, /raise exception 'Could not extend % provider allowlist for Maya'/);
  assert.doesNotMatch(migration, /insert into public\.settings/);
});
