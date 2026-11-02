const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const season = require('./seasonal-theme.js');
const index = fs.readFileSync('index.html', 'utf8');
const admin = fs.readFileSync('admin.html', 'utf8');
const deploy = fs.readFileSync('deploy-cloudflare-pages.ps1', 'utf8');

const at = iso => new Date(iso);

test('automatic mode follows the Asia/Manila calendar', () => {
  assert.equal(season.themeFor(at('2026-10-14T12:00:00+08:00')), null);
  assert.equal(season.themeFor(at('2026-10-15T00:00:00+08:00')), 'halloween');
  assert.equal(season.themeFor(at('2026-10-31T23:59:00+08:00')), 'halloween');
  assert.equal(season.themeFor(at('2026-11-01T00:00:00+08:00')), 'christmas');
  assert.equal(season.themeFor(at('2026-11-02T12:00:00+08:00')), 'christmas');
  assert.equal(season.themeFor(at('2026-12-25T12:00:00+08:00')), 'christmas');
  assert.equal(season.themeFor(at('2027-01-06T23:00:00+08:00')), 'christmas');
  assert.equal(season.themeFor(at('2027-01-07T00:00:00+08:00')), null);
  assert.equal(season.themeFor(at('2027-06-01T12:00:00+08:00')), null);
});

test('the switch uses Manila time, not UTC', () => {
  // 16:30 UTC on Oct 31 is already 00:30 on Nov 1 in Manila.
  assert.equal(season.themeFor(at('2026-10-31T16:30:00Z')), 'christmas');
  assert.equal(season.themeFor(at('2026-10-31T15:30:00Z')), 'halloween');
});

test('the admin setting can force a theme or turn decorations off', () => {
  const june = at('2027-06-01T12:00:00+08:00');
  assert.equal(season.themeFor(june, 'christmas'), 'christmas');
  assert.equal(season.themeFor(june, 'halloween'), 'halloween');
  assert.equal(season.themeFor(at('2026-12-25T12:00:00+08:00'), 'off'), null);
  assert.equal(season.themeFor(june, 'something-else'), null);
  assert.equal(season.normalizeMode(' OFF '), 'off');
  assert.equal(season.normalizeMode(undefined), 'auto');
});

test('a dismissed banner stays dismissed for the whole season only', () => {
  assert.equal(season.seasonKey('christmas', at('2026-12-01T12:00:00+08:00')), 'pr-season-banner-christmas-2026');
  assert.equal(season.seasonKey('christmas', at('2027-01-03T12:00:00+08:00')), 'pr-season-banner-christmas-2026');
  assert.equal(season.seasonKey('halloween', at('2027-10-20T12:00:00+08:00')), 'pr-season-banner-halloween-2027');
});

test('decorations load on the booking site, deploy, and are controlled from admin', () => {
  assert.match(index, /<link rel="stylesheet" href="seasonal-theme\.css\?v=[^"]+" \/>/);
  assert.match(index, /<script src="seasonal-theme\.js\?v=[^"]+"><\/script>/);
  assert.match(index, /window\.SeasonalTheme\?\.apply\(settings\.seasonal_theme\);/);
  assert.doesNotMatch(admin, /seasonal-theme\.js/);
  assert.match(deploy, /"seasonal-theme\.css",\s+"seasonal-theme\.js",/);
  assert.match(admin, /await DB\.saveSetting\('seasonal_theme', mode\);/);
});

test('decorations never intercept clicks and respect reduced motion', () => {
  const css = fs.readFileSync('seasonal-theme.css', 'utf8');
  assert.match(css, /\.season-layer \{[^}]*pointer-events:none;/);
  assert.match(css, /\.season-logo-badge \{[^}]*pointer-events:none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s+\.season-layer \{ display:none; \}/);
  // Below the sticky nav (200) and all dialogs (1100+).
  assert.match(css, /\.season-layer \{[^}]*z-index:150;/);
});
