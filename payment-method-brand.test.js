const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = path => fs.readFileSync(path, 'utf8');

test('official payment marks are vendored locally with stable dimensions', () => {
  for (const method of ['gcash', 'gotyme', 'maribank']) {
    const path = `assets/payment-methods/${method}.png`;
    assert.ok(fs.existsSync(path), `${method} icon must exist`);
    assert.ok(fs.statSync(path).size > 1_000, `${method} icon must not be an empty placeholder`);
  }

  const helper = read('payment-method-brand.js');
  assert.match(helper, /gcash: 'assets\/payment-methods\/gcash\.png'/);
  assert.match(helper, /gotyme: 'assets\/payment-methods\/gotyme\.png'/);
  assert.match(helper, /maribank: 'assets\/payment-methods\/maribank\.png'/);
  assert.match(helper, /width="32" height="32"/);
  assert.match(helper, /alt="" aria-hidden="true"/);
});

test('player and owner payment surfaces use the shared local brand system', () => {
  const page = read('index.html');
  const admin = read('admin.html');
  const deploy = read('deploy-cloudflare-pages.ps1');

  for (const source of [page, admin]) {
    assert.match(source, /payment-method-brand\.css\?v=20260901-payment-icons-v1/);
    assert.match(source, /payment-method-brand\.js\?v=20260901-payment-icons-v1/);
    assert.doesNotMatch(source, /<img[^>]+src="https?:\/\/[^">]+"[^>]+payment-method/i);
  }

  assert.match(page, /id="payOptGcash"[\s\S]{0,500}?assets\/payment-methods\/gcash\.png/);
  assert.match(page, /id="payOptGotyme"[\s\S]{0,500}?assets\/payment-methods\/gotyme\.png/);
  assert.match(page, /id="payOptMaribank"[\s\S]{0,500}?assets\/payment-methods\/maribank\.png/);
  assert.match(page, /function paymentMethodBrandLabelHtml/);
  assert.match(page, /paymentMethodBrandMarkHtml\('gotyme', 'po-ico pm-brand-mark--compact'\)/);
  assert.match(page, /paymentMethodBrandMarkHtml\('maribank', 'po-ico pm-brand-mark--compact'\)/);
  assert.match(page, /renderPaymentMethodBrandLabel\(title, method, profile\.title\)/);

  assert.match(admin, /id="payMethodGcashOn"[\s\S]{0,500}?assets\/payment-methods\/gcash\.png/);
  assert.match(admin, /id="payMethodGotymeOn"[\s\S]{0,500}?assets\/payment-methods\/gotyme\.png/);
  assert.match(admin, /id="payMethodMaribankOn"[\s\S]{0,500}?assets\/payment-methods\/maribank\.png/);
  assert.match(admin, /renderPaymentMethodBrandLabel\(\$\('vmMethod'\), b\.paymentMethod\)/);
  assert.match(admin, /paymentMethodBrandLabelHtml\(b\.paymentMethod\)/);

  assert.match(deploy, /"payment-method-brand\.css"/);
  assert.match(deploy, /"payment-method-brand\.js"/);
  assert.match(deploy, /"assets\/payment-methods\/gcash\.png"/);
  assert.match(deploy, /"assets\/payment-methods\/gotyme\.png"/);
  assert.match(deploy, /"assets\/payment-methods\/maribank\.png"/);
  assert.match(deploy, /\$destination = Join-Path \$stagingDir \$file/);
});
