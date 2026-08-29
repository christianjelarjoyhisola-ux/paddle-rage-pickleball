const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const read = file => readFileSync(file, 'utf8');
const index = read('index.html');
const admin = read('admin.html');
const theme = read('brand-theme.css');
const manager = read('play-manager.js');
const player = read('player-live.js');
const supabase = read('supabase-config.js');

test('public booking keeps a zoomable, explicit, first-session intro', () => {
  assert.match(index, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.doesNotMatch(index, /maximum-scale|user-scalable\s*=\s*no/i);
  assert.match(index, /id="splashWelcomeMusic"[^>]*preload="none"[^>]*loop/);
  assert.doesNotMatch(index.match(/<audio id="splashWelcomeMusic"[^>]*>/)?.[0] || '', /autoplay/i);
  assert.doesNotMatch(index, /attemptSplashAutoplay|unlockSplashMusicFromGesture/);
  assert.match(index, /sessionStorage\.getItem\('paddle_rage_intro_seen_v1'\)/);
  assert.match(index, /sessionStorage\.setItem\('paddle_rage_intro_seen_v1', '1'\)/);
  assert.match(index, /class="pr-splash-enter"[^>]*onclick="dismissSplashAndBook\(\)"/);
  assert.match(index, /class="pr-splash-skip"[^>]*onclick="dismissSplash\(\)"/);
  assert.match(index, /class="pr-splash-logo" src="paddleragelogo\.jpg"/);
  assert.doesNotMatch(index, /paddle-rage-grunge-edge\.png|paddle-rage-word-(?:paddle|rage)\.png/);
});

test('public booking exposes keyboard and autofill affordances', () => {
  assert.match(index, /class="skip-link" href="#courts" onclick="dismissSplash\(\)"/);
  assert.match(index, /id="bName"[^>]*autocomplete="name"/);
  assert.match(index, /id="bPhone"[^>]*autocomplete="tel"[^>]*inputmode="tel"/);
  assert.match(index, /id="bEmail"[^>]*autocomplete="email"/);
  assert.match(theme, /:where\(a, button, input, select, textarea, \[tabindex\]\):focus-visible/);
  assert.match(theme, /@media \(pointer: coarse\)[\s\S]*?min-height: 44px/);
  assert.match(index, /mailto:bookings@paddleragecdo\.ph/);
  assert.doesNotMatch(index, /href="#"/);
});

test('mobile court selector is a roving, keyboard-operable tab interface', () => {
  assert.match(index, /id="courtTabs" role="tablist" aria-label="Choose a court"/);
  assert.match(index, /role="tab" aria-selected="\$\{active\}" aria-controls="courtPanel_\$\{courtIndex\}"/);
  assert.match(index, /function courtTabKeydown\(event\)[\s\S]*?ArrowRight[\s\S]*?ArrowLeft[\s\S]*?Home[\s\S]*?End/);
  assert.match(index, /function syncMobileCourtAccessibility\(\)[\s\S]*?role', 'tabpanel'[\s\S]*?panel\.hidden = !active/);
  assert.match(index, /\.court-tab\s*\{[\s\S]*?min-height:44px/);
  assert.match(index, /<button type="button" class="cc-slot-btn\$\{isSelectedSlot_/);
  assert.match(index, /aria-pressed="\$\{isSelectedSlot_ \? 'true' : 'false'\}"/);
});

test('synced production surfaces remain Paddle-only and tenant-isolated', () => {
  const productionSurface = [index, admin, theme, manager, player, supabase].join('\n');
  for (const forbidden of [
    /Korte DOS/i,
    /korte-dos/i,
    /kortedoscdo/i,
    /zcuufcpkgidmaanxjufo/i,
    /DWQM4TK496R3UA1BS/i,
  ]) {
    assert.doesNotMatch(productionSurface, forbidden);
  }
  assert.match(productionSurface, /Paddle Rage Pickleball/i);
  assert.match(index, /https:\/\/paddleragecdo\.ph\//);
  assert.match(supabase, /qhvrowoqeyeypmefwkha/);
  assert.match(index, /paymentAcceptanceMode = 'full_payment_only'/);
  assert.match(index, /const HOST_DOWNPAYMENT_RATE = 0\.25/);
});
