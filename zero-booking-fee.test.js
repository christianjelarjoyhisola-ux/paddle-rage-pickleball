const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const page = fs.readFileSync('index.html', 'utf8');

function sourceBetween(start, end) {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker after ${start}: ${end}`);
  return page.slice(from, to);
}

function pricingHarness() {
  const source = sourceBetween('function calcSvcFee(hrs)', 'function activeHostSession()');
  return new Function(`
    let _serviceFeeType = 'per_hour';
    let _serviceFeeRate = 0;
    const elements = {
      pricePromiseSub: { textContent: '' },
      pricePromiseChip: { textContent: '' },
    };
    const $ = id => elements[id] || null;
    ${source}
    return {
      quote(type, fee, base) {
        _serviceFeeType = type;
        _serviceFeeRate = fee;
        return {
          exact: hasExactAllInSlotPrice(),
          rate: allInSlotRate(base),
          html: allInSlotPriceHtml(base),
          aria: allInSlotAriaLabel(base),
        };
      },
      message(type, fee) {
        _serviceFeeType = type;
        _serviceFeeRate = fee;
        syncPricePromiseMessaging();
        return {
          sub: elements.pricePromiseSub.textContent,
          chip: elements.pricePromiseChip.textContent,
        };
      },
    };
  `)();
}

function selectionHarness() {
  const selectionSource = sourceBetween('function selectionCourtFee(sel)', 'function normalizedSlots(slots)');
  const totalsSource = sourceBetween('function bookingItemsCourtFee', 'function bookingItemsCourtLabel');
  return new Function(`
    let pricingTiers = [];
    let _serviceFeeType = 'per_hour';
    let _serviceFeeRate = 0;
    function getRateForHourFromTiers(h, tiers, fallbackRate = 0) {
      for (const tier of (tiers || [])) {
        const inRange = tier.from < tier.to
          ? h >= tier.from && h < tier.to
          : h >= tier.from || h < tier.to;
        if (inRange) return tier.rate;
      }
      return fallbackRate;
    }
    function calcSvcFee(hours) {
      return _serviceFeeType === 'flat' ? _serviceFeeRate : _serviceFeeRate * hours;
    }
    ${selectionSource}
    ${totalsSource}
    return {
      selection(sel, fee = 10) {
        _serviceFeeRate = fee;
        return {
          court: selectionCourtFee(sel),
          fee: selectionServiceFee(sel),
          total: selectionTotal(sel),
        };
      },
      aggregate(items) {
        return {
          court: bookingItemsCourtFee(items),
          fee: bookingItemsServiceFee(items),
          total: bookingItemsTotal(items),
          duration: bookingItemsDuration(items),
        };
      },
    };
  `)();
}

function hostDepositHarness() {
  const source = sourceBetween('function downpaymentAmount', 'function hostBookingNoteText');
  return new Function(`
    let payFull = false;
    const isVerifiedHostBooking = () => true;
    const hostBookingDepositEligible = () => true;
    const HOST_DOWNPAYMENT_RATE = 0.25;
    ${source}
    return (total, court, fee) => downpaymentAmount(total, court, fee);
  `)();
}

test('premium price promise markets zero booking fees without exposing the private rate', () => {
  const banner = sourceBetween('<div class="price-promise"', '<div class="courts" id="courtsGrid">');
  assert.match(banner, /Paddle Rage Price Promise/);
  assert.match(banner, /Zero Booking Fees/);
  assert.match(banner, /Book at the price shown/);
  assert.match(banner, /Final Prices/);
  assert.doesNotMatch(banner, /₱\s*10|\/hr\s*[×x]/i);

  assert.match(page, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^{]*\{[^}]*\.price-promise::after[^}]*animation\s*:\s*none/s);
});

test('per-hour configuration creates exact all-in slot prices', () => {
  const quote = pricingHarness().quote('per_hour', 10, 350);
  assert.equal(quote.exact, true);
  assert.equal(quote.rate, 360);
  assert.match(quote.html, /₱360/);
  assert.match(quote.html, />Final</);
  assert.match(quote.aria, /₱360 final price, zero booking fee/);
});

test('flat configuration never repeats the flat share on every slot', () => {
  const quote = pricingHarness().quote('flat', 10, 350);
  assert.equal(quote.exact, false);
  assert.equal(quote.rate, 350);
  assert.match(quote.html, /₱350\/hr/);
  assert.match(quote.html, /Live total/);
  assert.doesNotMatch(quote.html, /₱360/);
  assert.match(quote.aria, /final total shown after selection/);

  const message = pricingHarness().message('flat', 10);
  assert.equal(message.sub, 'Your final total updates as you select.');
  assert.equal(message.chip, 'Live Total');
});

test('tiered and multi-court totals preserve the private allocation exactly once', () => {
  const harness = selectionHarness();
  const tiered = harness.selection({
    slots: [15, 16],
    rate: 350,
    tiers: [
      { from: 6, to: 16, rate: 350 },
      { from: 16, to: 24, rate: 450 },
    ],
  });
  assert.deepEqual(tiered, { court: 800, fee: 20, total: 820 });

  const group = harness.aggregate([
    { courtFee: 800, serviceFee: 20, total: 820, duration: 2 },
    { courtFee: 500, serviceFee: 10, total: 510, duration: 1 },
  ]);
  assert.deepEqual(group, { court: 1300, fee: 30, total: 1330, duration: 3 });
});

test('host reservation amount keeps the internal share private without changing the money', () => {
  const due = hostDepositHarness()(1330, 1300, 30);
  assert.equal(due, 355, '₱30 platform share plus 25% of ₱1,300 court revenue');
  assert.equal(1330 - due, 975, 'remaining balance is derived from the same authoritative total');

  const hostSummary = sourceBetween('function hostBookingItemsSummaryHtml', 'function bookingItemsSummaryHtml');
  assert.doesNotMatch(hostSummary, /\$\{fmt\(svcFee\)\}/);
  assert.doesNotMatch(hostSummary, /bookingFeeDisplay/);
  assert.match(hostSummary, /Reservation payment today/);
});

test('both court renderers use final player pricing and accessible selection state', () => {
  const onCardDate = sourceBetween('async function onCardDate', 'async function ensureCourt');
  const renderCourts = sourceBetween('async function renderCourts()', 'async function selectCourt');

  for (const source of [onCardDate, renderCourts]) {
    assert.match(source, /allInSlotPriceHtml\(baseRate\)/);
    assert.match(source, /allInSlotAriaLabel\(baseRate\)/);
    assert.match(source, /aria-pressed=/);
    assert.match(source, /plainTimeRange/);
    assert.doesNotMatch(source, /aria-label="\$\{esc\(timeRange\)\}/);
  }
  assert.doesNotMatch(renderCourts, /<div class="csl-price">₱\$\{_cRate\(h\)\}/);
  assert.match(page, /\.cc-slot-btn\s*\{[^}]*min-height\s*:\s*48px/s);
});

test('player summary and confirmation show fee-free final pricing only', () => {
  const summaries = sourceBetween('function hostBookingItemsSummaryHtml', 'async function refreshBookingItemViews');
  assert.match(summaries, /Booking fee/);
  assert.match(summaries, /pbs-free-badge">Free/);
  assert.match(summaries, /Final booking total/);
  assert.match(summaries, /Final total/);
  assert.doesNotMatch(summaries, /bookingFeeDisplay\(/);
  assert.doesNotMatch(summaries, /Fee paid in full|25% court/i);

  const confirmation = sourceBetween('<section class="inv-payment-card', '</section>');
  assert.match(confirmation, /inv-fee-free/);
  assert.match(confirmation, /Booking fee/);
  assert.match(confirmation, />Free</);
});

test('mobile sticky booking total leads with the final amount', () => {
  const updateCard = sourceBetween('function updateCardUI', '// Holds the ref');
  assert.match(updateCard, /`FINAL · \$\{fmt\(total\)\} · \$\{hrs\}/);
  assert.doesNotMatch(updateCard, /mobileSumEl\.textContent\s*=\s*selectionSummaryText/);
});
