const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const page = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n');
function fn(name, globals = {}) {
  const start = page.indexOf('function ' + name + '(');
  assert.ok(start >= 0);
  const end = page.indexOf('\n}', start) + 2;
  return vm.runInNewContext(page.slice(start, end) + '\n' + name, globals);
}
test('RCBC uses its own receiving identity while bank-to-GCash routes are preserved', () => {
  const key = fn('paymentReceiverKey');
  assert.equal(key('rcbc'), 'rcbc');
  assert.equal(key('pnb'), 'pnb');
  for (const method of ['bpi', 'gotyme', 'maya', 'bdopay', 'unionbank', 'maribank']) assert.equal(key(method), 'gcash');
  assert.equal(fn('paymentMethodName')('rcbc'), 'RCBC');
});
test('RCBC copy action copies its account, never the shared GCash number', async () => {
  let copied;
  const copy = fn('copyPaymentNumber', {
    $: id => ({ textContent: id === 'rcMerchantNumber' ? '75912 71901' : '09455107667' }),
    navigator: { clipboard: { writeText: async value => { copied = value; } } },
    toast() {},
  });
  await copy('rcbc');
  assert.equal(copied, '7591271901');
});
test('direct RCBC has a complete checkout panel and independent settings', () => {
  for (const id of ['payOptRcbc','rcbcBox','rcbcQrImg','rcMerchantNumber','rcMerchantName','rcDownAmt']) {
    assert.equal([...page.matchAll(new RegExp('id="' + id + '"', 'g'))].length, 1, id);
  }
  const receiver = page.match(/rcbc: \{\s+number: settings.rcbc_merchant_number[\s\S]*?\n    \}/)[0];
  assert.doesNotMatch(receiver, /gcash/);
  assert.match(page, /paymentMethods.rcbc = settings.payment_method_rcbc === '1' && receiverReady\('rcbc'\)/);
  assert.match(fs.readFileSync('voucher-checkout.js','utf8'), /'gcashBox','pnbBox','rcbcBox'/);
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync('payment-method-brand.js','utf8'), context);
  assert.ok(context.window.PaymentMethodBrand.iconSrc('rcbc').endsWith('rcbc.svg'));
});
test('RCBC receipts are explicitly owner reviewed without a GCash parser fallback', () => {
  const edge = fs.readFileSync('supabase/functions/verify-gcash-receipt/index.ts', 'utf8');
  assert.match(edge, /provider === "rcbc"[\s\S]*?number: settings.rcbc_merchant_number \|\| ""/);
  assert.match(edge, /!isDedicatedReceiptProvider\(provider\)[\s\S]*?flags.push\("PROVIDER_REVIEW_REQUIRED"\)/);
  const dispatch = fs.readFileSync('supabase/functions/_shared/receipt-providers/index.ts', 'utf8');
  assert.doesNotMatch(dispatch, /case "rcbc"/);
  for (const file of ['submit-public-registration', 'host-booking-balance-payment']) {
    assert.match(fs.readFileSync('supabase/functions/' + file + '/index.ts','utf8'), /"rcbc"/);
  }
});
test('finance reports attribute direct RCBC money to RCBC', () => {
  const report = require('./finance-core').build({
    transactions: [{ref:'RCBC-TEST',date:'2026-09-25',total:1200,duration:1,status:'confirmed',paymentStatus:'paid',paymentMethod:'rcbc',paidAt:'2026-09-25T03:00:00Z',createdAt:'2026-09-25T03:00:00Z'}],
    settings:{},range:{from:'2026-09-25',to:'2026-09-25'},basis:'payment',
  });
  assert.equal(report.breakdowns.received.length,1);
  assert.equal(report.breakdowns.received[0].label,'rcbc');
  assert.equal(report.breakdowns.received[0].collected,1200);
});
