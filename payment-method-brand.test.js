const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = path => fs.readFileSync(path, 'utf8');

test('official payment marks are vendored locally with stable dimensions', () => {
  const expectedDimensions = {
    gcash: [256, 256],
    'bdo-pay': [256, 256],
    maya: [256, 256],
    bpi: [256, 256],
    gotyme: [64, 64],
    maribank: [122, 122],
    pnb: [256, 256],
  };
  for (const [method, dimensions] of Object.entries(expectedDimensions)) {
    const path = `assets/payment-methods/${method}.png`;
    assert.ok(fs.existsSync(path), `${method} icon must exist`);
    assert.ok(fs.statSync(path).size > 1_000, `${method} icon must not be an empty placeholder`);
    const image = fs.readFileSync(path);
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${method} must be a valid PNG`);
    assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], dimensions, `${method} dimensions changed unexpectedly`);
  }
  assert.ok(fs.existsSync('assets/payment-methods/cash.svg'), 'cash icon must exist');
  assert.ok(fs.statSync('assets/payment-methods/cash.svg').size > 250, 'cash icon must not be an empty placeholder');
  assert.match(read('assets/payment-methods/cash.svg'), /viewBox="0 0 64 64"/);

  const helper = read('payment-method-brand.js');
  assert.match(helper, /gcash: 'assets\/payment-methods\/gcash\.png'/);
  assert.match(helper, /bdopay: 'assets\/payment-methods\/bdo-pay\.png'/);
  assert.match(helper, /maya: 'assets\/payment-methods\/maya\.png'/);
  assert.match(helper, /bpi: 'assets\/payment-methods\/bpi\.png'/);
  assert.match(helper, /gotyme: 'assets\/payment-methods\/gotyme\.png'/);
  assert.match(helper, /maribank: 'assets\/payment-methods\/maribank\.png'/);
  assert.match(helper, /pnb: 'assets\/payment-methods\/pnb\.png'/);
  assert.match(helper, /cash: 'assets\/payment-methods\/cash\.svg'/);
  assert.match(helper, /width="32" height="32"/);
  assert.match(helper, /alt="" aria-hidden="true"/);
});

test('player and owner payment surfaces use the shared local brand system', () => {
  const page = read('index.html');
  const admin = read('admin.html');
  const deploy = read('deploy-cloudflare-pages.ps1');

  for (const source of [page, admin]) {
    assert.match(source, /payment-method-brand\.css\?v=20260901-payment-icons-v2/);
    assert.match(source, /payment-method-brand\.js\?v=20260901-payment-icons-v2/);
    assert.doesNotMatch(source, /<img[^>]+src="https?:\/\/[^">]+"[^>]+payment-method/i);
  }

  const pickerAssets = {
    Gcash: 'gcash.png',
    Bdopay: 'bdo-pay.png',
    Maya: 'maya.png',
    Bpi: 'bpi.png',
    Gotyme: 'gotyme.png',
    Maribank: 'maribank.png',
    Pnb: 'pnb.png',
    Cash: 'cash.svg',
  };
  for (const [idSuffix, filename] of Object.entries(pickerAssets)) {
    assert.match(page, new RegExp(`id="payOpt${idSuffix}"[\\s\\S]{0,500}?assets/payment-methods/${filename.replace('.', '\\.')}"`));
  }
  assert.match(page, /function paymentMethodBrandLabelHtml/);
  for (const method of ['gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb', 'cash']) {
    assert.match(page, new RegExp(`paymentMethodBrandMarkHtml\\('${method}', 'po-ico pm-brand-mark--compact'\\)`));
  }
  assert.match(page, /\.pay-opts\.bpay-methods,[\s\S]{0,100}?\.pay-opts\.op-pay-opts\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);\}/);
  assert.match(page, /renderPaymentMethodBrandLabel\(title, method, profile\.title\)/);

  assert.match(admin, /class="pm-toggle-grid"/);
  for (const [idSuffix, filename] of Object.entries(pickerAssets)) {
    assert.match(admin, new RegExp(`id="payMethod${idSuffix}On"[\\s\\S]{0,500}?assets/payment-methods/${filename.replace('.', '\\.')}"`));
  }
  assert.match(admin, /renderPaymentMethodBrandLabel\(\$\('vmMethod'\), b\.paymentMethod\)/);
  assert.match(admin, /paymentMethodBrandLabelHtml\(b\.paymentMethod\)/);

  assert.match(deploy, /"payment-method-brand\.css"/);
  assert.match(deploy, /"payment-method-brand\.js"/);
  for (const filename of Object.values(pickerAssets)) {
    assert.match(deploy, new RegExp(`"assets/payment-methods/${filename.replace('.', '\\.')}"`));
  }
  assert.match(deploy, /\$destination = Join-Path \$stagingDir \$file/);
});

test('payment history uses the shared local provider marks without changing review logic', () => {
  const history = read('host-balance-admin.js');
  assert.match(history, /PaymentMethodBrand/);
  assert.match(history, /renderLabel/);
  assert.match(history, /renderPaymentMethodReference\(balanceTabMeta, providerMethod, balanceReference\)/);
  assert.match(history, /renderPaymentMethodReference\(byId\('hostDepositTab'\)[\s\S]{0,160}?depositMethod, depositReference\)/);
  assert.match(history, /appendPaymentMethodSummary\(meta, 'Method', payment\.paymentProvider/);
  assert.doesNotMatch(history, /https?:\/\/[^'"`]+payment-method/i);
});
