const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const page = fs.readFileSync('index.html', 'utf8');
const brandTheme = fs.readFileSync('brand-theme.css', 'utf8');

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
      pricePromise: {
        ariaLabel: '',
        setAttribute(name, value) { if (name === 'aria-label') this.ariaLabel = value; },
      },
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
          label: elements.pricePromise.ariaLabel,
        };
      },
    };
  `)();
}

function selectionHarness() {
  const selectionSource = sourceBetween('function selectionListedPrice(sel)', 'function slotGroups(slots)');
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

function rentalBreakdownHarness() {
  const source = sourceBetween('function bookingItemRateBreakdown', 'function hostBookingItemsSummaryHtml');
  return new Function(`
    function normalizedSlots(slots) {
      return [...(slots || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    }
    function compactPeso(amount) {
      const value = Math.max(0, Number(amount || 0));
      return '₱' + value.toLocaleString('en-PH', {
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
      });
    }
    const fmt = value => '₱' + Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2 });
    const esc = value => String(value ?? '');
    const activeBookingItems = () => [];
    const uniqueBookingSelections = items => items;
    const bookingItemsDuration = items => items.reduce((sum, item) => sum + Number(item.duration || 0), 0);
    ${source}
    return {
      item: bookingItemRateBreakdown,
      model: bookingRentalBreakdownModel,
      html: bookingRentalBreakdownHtml,
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
  assert.match(banner, /role="note" aria-label="No booking fees\."/);
  assert.match(banner, /class="price-promise-lockup"/);
  assert.match(banner, /class="price-promise-no">NO<\/span><strong class="price-promise-title">BOOKING FEES<\/strong>/);
  assert.equal(banner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), 'NO BOOKING FEES');
  assert.doesNotMatch(banner, /Paddle Rage Price Promise|Zero Booking Fees|The price shown is what you pay|<svg|price-promise-mark|price-promise-sub/);
  assert.doesNotMatch(banner, /aria-live/);
  assert.doesNotMatch(banner, /Final Prices|Live Total/i);
  assert.doesNotMatch(banner, /₱\s*10|\/hr\s*[×x]/i);

  assert.match(page, /\.price-promise-lockup\s*\{[^}]*animation:pricePromiseTitleIn\s+\.52s[^}]*\}/s);
  assert.match(page, /\.price-promise::after\s*\{[^}]*animation:pricePromiseSweep\s+7s[^}]*infinite/s);
  assert.match(page, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.price-promise::after\s*\{[^}]*animation:none;[^}]*\}\s*\.price-promise-lockup\s*\{[^}]*animation:none;[^}]*\}\s*\}/s);

  const splashOffer = sourceBetween('<div class="pr-splash-offer"', '<button class="pr-splash-enter"');
  assert.match(splashOffer, /role="note" aria-label="No booking fees\."/);
  assert.equal(splashOffer.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), 'NO BOOKING FEES');
  assert.doesNotMatch(splashOffer, /aria-live|₱\s*10|\/hr\s*[×x]/i);
  assert.match(brandTheme, /\.pr-splash-offer\s*\{[^}]*animation:\s*pr-offer-in\s+0\.55s/s);
  assert.match(brandTheme, /\.pr-splash-offer::after\s*\{[^}]*animation:\s*pr-offer-sweep\s+1\.05s/s);
  assert.match(brandTheme, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.pr-splash-offer::after\s*\{[^}]*display:\s*none/s);
});

test('per-hour configuration creates exact all-in slot prices', () => {
  const quote = pricingHarness().quote('per_hour', 10, 350);
  assert.equal(quote.exact, true);
  assert.equal(quote.rate, 350);
  assert.match(quote.html, /₱350/);
  assert.doesNotMatch(quote.html, /Final|Live total|csl-final/i);
  assert.match(quote.aria, /₱350 per hour, zero booking fee/);
});

test('flat configuration never repeats the flat share on every slot', () => {
  const quote = pricingHarness().quote('flat', 10, 350);
  assert.equal(quote.exact, true);
  assert.equal(quote.rate, 350);
  assert.match(quote.html, /₱350/);
  assert.doesNotMatch(quote.html, /Live total|Final|csl-final/i);
  assert.doesNotMatch(quote.html, /₱360/);
  assert.match(quote.aria, /₱350 per hour, zero booking fee/);

  const message = pricingHarness().message('flat', 10);
  assert.equal(message.label, 'No booking fees.');
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
  assert.deepEqual(tiered, { court: 780, fee: 20, total: 800 });

  const group = harness.aggregate([
    { courtFee: 780, serviceFee: 20, total: 800, duration: 2 },
    { courtFee: 490, serviceFee: 10, total: 500, duration: 1 },
  ]);
  assert.deepEqual(group, { court: 1270, fee: 30, total: 1300, duration: 3 });
});

test('host reservation amount keeps the internal share private without changing the money', () => {
  const due = hostDepositHarness()(1300, 1270, 30);
  assert.equal(due, 347.5, '₱30 platform share plus 25% of ₱1,270 court revenue');
  assert.equal(1300 - due, 952.5, 'remaining balance is derived from the same authoritative total');

  const hostSummary = sourceBetween('function hostBookingItemsSummaryHtml', 'function bookingItemsSummaryHtml');
  assert.doesNotMatch(hostSummary, /\$\{fmt\(svcFee\)\}/);
  assert.doesNotMatch(hostSummary, /bookingFeeDisplay/);
  assert.match(hostSummary, /Reservation payment today/);
});

test('₱400 inclusive-price contract stays exact through regular and host checkout', () => {
  const allocation = selectionHarness().selection({ slots: [18], rate: 400 }, 10);
  assert.deepEqual(allocation, { court: 390, fee: 10, total: 400 });

  const hostDue = hostDepositHarness()(allocation.total, allocation.court, allocation.fee);
  assert.equal(hostDue, 107.5);
  assert.equal(allocation.total - hostDue, 292.5);
});

test('premium rental breakdown groups three identical courts into one auditable formula', () => {
  const harness = rentalBreakdownHarness();
  const items = [1, 2, 3].map(number => ({
    courtId: String(number),
    courtName: `Court ${number}`,
    date: '2026-09-01',
    slots: [8, 9, 10],
    duration: 3,
    rate: 400,
    slotRates: [400, 400, 400],
    total: 1200,
  }));
  const model = harness.model(items);
  assert.equal(model.length, 1);
  assert.equal(model[0].entries.length, 3);
  assert.equal(model[0].subtotal, 3600);

  const html = harness.html(items);
  assert.match(html, /3 courts · 3 hrs each/);
  assert.match(html, /₱400\/hr × 3 hrs/);
  assert.doesNotMatch(html, /× 3 courts/);
  assert.match(html, /₱1,200 per court · 9 court-hours/);
  assert.match(html, /₱3,600\.00/);
});

test('Step 3 itemizes each schedule and price exactly once', () => {
  const harness = rentalBreakdownHarness();
  const items = [
    { courtId: '1', courtName: 'Court 1', date: '2026-09-02', slots: [8, 9], timeLabel: '8:00 AM - 10:00 AM', duration: 2, rate: 350, slotRates: [350, 350], total: 700 },
    { courtId: '2', courtName: 'Court 2', date: '2026-09-02', slots: [16, 17], timeLabel: '4:00 PM - 6:00 PM', duration: 2, rate: 400, slotRates: [400, 400], total: 800 },
    { courtId: '3', courtName: 'Court 3', date: '2026-09-02', slots: [16, 17], timeLabel: '4:00 PM - 6:00 PM', duration: 2, rate: 400, slotRates: [400, 400], total: 800 },
  ];
  const html = harness.html(items, {
    itemizeSchedule: true,
    dateFormatter: () => 'Wednesday, September 2, 2026',
  });

  assert.equal((html.match(/Wednesday, September 2, 2026/g) || []).length, 1);
  assert.equal((html.match(/Court 1/g) || []).length, 1);
  assert.equal((html.match(/Courts 2 & 3/g) || []).length, 1);
  assert.equal((html.match(/8:00 AM - 10:00 AM/g) || []).length, 1);
  assert.equal((html.match(/4:00 PM - 6:00 PM/g) || []).length, 1);
  assert.match(html, /₱350\/hr × 2 hrs/);
  assert.match(html, /₱700\.00/);
  assert.match(html, /₱400\/hr × 2 hrs/);
  assert.match(html, /₱800 each/);
  assert.doesNotMatch(html, /× 2 courts|₱1,600\.00/);
  assert.doesNotMatch(html, /matching courts|per court|court-hours|Court rental/i);
});

test('a grouped Step 3 price stays per court while the grand total stays combined', () => {
  const harness = rentalBreakdownHarness();
  const items = [1, 2, 3].map(number => ({
    courtId: String(number),
    courtName: `Court ${number}`,
    date: '2026-09-01',
    slots: [8, 9, 10],
    timeLabel: '8:00 AM - 11:00 AM',
    duration: 3,
    rate: 350,
    slotRates: [350, 350, 350],
    total: 1050,
  }));
  const html = harness.html(items, { itemizeSchedule: true, dateFormatter: value => value });
  assert.match(html, /₱350\/hr × 3 hrs/);
  assert.match(html, /₱1,050 each/);
  assert.doesNotMatch(html, /× 3 courts|₱3,150\.00/);
  assert.doesNotMatch(html, /per court|court-hours/);
});

test('grouped tiered prices never multiply the formula by the court count', () => {
  const harness = rentalBreakdownHarness();
  const items = [1, 2].map(number => ({
    courtId: String(number),
    courtName: `Court ${number}`,
    date: '2026-09-01',
    slots: [15, 16],
    timeLabel: '3:00 PM - 5:00 PM',
    duration: 2,
    rate: 350,
    slotRates: [350, 400],
    total: 750,
  }));
  const html = harness.html(items, { itemizeSchedule: true, dateFormatter: value => value });
  assert.match(html, /₱350\/hr × 1 hr \+ ₱400\/hr × 1 hr/);
  assert.match(html, /₱750 each/);
  assert.doesNotMatch(html, /× 2 courts|\) ×/);
  assert.equal(harness.model(items)[0].subtotal, 1500);
});

test('itemized rows keep multiple dates and separate hours truthful', () => {
  const harness = rentalBreakdownHarness();
  const items = [
    { courtId: '1', courtName: 'Court 1', date: '2026-09-02', slots: [8, 10], timeLabel: '8:00 AM - 9:00 AM, 10:00 AM - 11:00 AM', duration: 2, rate: 350, slotRates: [350, 350], total: 700 },
    { courtId: '2', courtName: 'Court 2', date: '2026-09-03', slots: [16], timeLabel: '4:00 PM - 5:00 PM', duration: 1, rate: 400, slotRates: [400], total: 400 },
  ];
  const html = harness.html(items, {
    itemizeSchedule: true,
    dateFormatter: value => value === '2026-09-02' ? 'Sep 2, 2026' : 'Sep 3, 2026',
  });
  assert.match(html, /2 booking dates/);
  assert.equal((html.match(/Sep 2, 2026/g) || []).length, 1);
  assert.equal((html.match(/Sep 3, 2026/g) || []).length, 1);
  assert.match(html, /8:00 AM - 9:00 AM, 10:00 AM - 11:00 AM/);
  assert.match(html, /₱350\/hr × 2 hrs/);
  assert.match(html, /₱400\/hr × 1 hr/);
});

test('rental breakdown expands mixed courts and preserves real tier components', () => {
  const harness = rentalBreakdownHarness();
  const items = [
    { courtId: '1', courtName: 'Court 1', date: '2026-09-01', slots: [8, 9, 10], duration: 3, rate: 400, slotRates: [400, 400, 400], total: 1200 },
    { courtId: '2', courtName: 'Court 2', date: '2026-09-01', slots: [8, 9], duration: 2, rate: 350, slotRates: [350, 350], total: 700 },
    { courtId: '3', courtName: 'Court 3', date: '2026-09-01', slots: [15, 16, 17], duration: 3, rate: 350, slotRates: [350, 350, 400], total: 1100 },
  ];
  const model = harness.model(items);
  assert.equal(model.length, 3);
  const html = harness.html(items);
  assert.match(html, /Court 1 · 3 hrs/);
  assert.match(html, /Court 2 · 2 hrs/);
  assert.match(html, /₱350\/hr × 2 hrs \+ ₱400\/hr × 1 hr/);
  assert.match(html, /₱1,100\.00/);
});

test('legacy resumed holds never invent an average hourly rate', () => {
  const harness = rentalBreakdownHarness();
  const legacy = harness.item({
    courtId: '1',
    courtName: 'Court 1',
    date: '2026-09-01',
    slots: [15, 16],
    duration: 2,
    rate: 350,
    total: 800,
  });
  assert.equal(legacy.components.length, 0);
  assert.equal(legacy.formula, 'Scheduled rates · 2 hrs');
  assert.doesNotMatch(legacy.formula, /₱400\/hr/);
});

test('both court renderers use the configured player price and accessible selection state', () => {
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

test('player summary and confirmation show the fee-free all-in price only', () => {
  const summaries = sourceBetween('function hostBookingItemsSummaryHtml', 'async function refreshBookingItemViews');
  const stepThree = sourceBetween('<!-- ── STEP 3: YOUR DETAILS ── -->', '<!-- ── STEP 5: PAYMENT ── -->');
  assert.match(stepThree, /class="wiz-summary wiz-summary--booking"/, 'Step 3 must use one scoped booking summary card');
  assert.match(page, /\.wiz-summary--booking \.pbs-price-card\s*\{[^}]*border\s*:\s*0;[^}]*background\s*:\s*transparent;/s, 'the nested price shell must be visually flattened');
  assert.match(summaries, /Booking fee/);
  assert.match(summaries, /pbs-free-badge">Free/);
  assert.match(summaries, /Booking total/);
  assert.match(summaries, />Total</);
  assert.doesNotMatch(summaries, /Final booking total|Final total|Live total/i);
  assert.doesNotMatch(summaries, /bookingFeeDisplay\(/);
  assert.doesNotMatch(summaries, /Fee paid in full|25% court/i);
  assert.equal((summaries.match(/bookingRentalBreakdownHtml\(items, \{ itemizeSchedule: true,/g) || []).length, 2, 'regular and host summaries must share the itemized rental breakdown');
  assert.doesNotMatch(summaries, /<div class="pbs-session">/, 'Step 3 must not render a second court/session summary');
  assert.match(page, /@media\(max-width:480px\)[\s\S]*?\.pbs-rental-math\s*\{[^}]*gap:/);

  const confirmation = sourceBetween('<section class="inv-payment-card', '</section>');
  assert.match(confirmation, /inv-fee-free/);
  assert.match(confirmation, /Booking fee/);
  assert.match(confirmation, />Free</);
  assert.match(confirmation, /id="iRentalBreakdown"/);

  const submission = sourceBetween('async function submitBooking(e)', 'function resetForm');
  assert.match(submission, /slotRates:\s*Array\.isArray\(item\.slotRates\) \? \[\.\.\.item\.slotRates\] : \[\]/);
  const ticketItems = sourceBetween('function bookingTicketSessionItems', 'function bookingTicketSessionModel');
  assert.match(ticketItems, /slotRates:\s*Array\.isArray\(item\.slotRates \?\? item\.slot_rates\)/);
  assert.match(ticketItems, /total:\s*Number\.isFinite\(totalValue\) \? totalValue : 0/);
  const showInvoice = sourceBetween('function showInvoice(b)', 'function copyInvRef()');
  assert.match(showInvoice, /bookingRentalBreakdownHtml\(bookingTicketPricingItems\(b, ticketModel\)\)/);
});

test('mobile sticky booking total leads with the all-in amount', () => {
  const updateCard = sourceBetween('function updateCardUI', '// Holds the ref');
  assert.match(updateCard, /`\$\{fmt\(total\)\} · \$\{hrs\}/);
  assert.doesNotMatch(updateCard, /FINAL ·|Live total/i);
  assert.doesNotMatch(updateCard, /mobileSumEl\.textContent\s*=\s*selectionSummaryText/);
});

test('stored bookings keep their immutable total and fee snapshot', () => {
  const source = sourceBetween('function bookingItemFromReservedBooking', 'function restoreGuestResumeDraft');
  assert.match(source, /bookingFeeAmountSnapshot\s*\?\?\s*b\.booking_fee_amount_snapshot/);
  assert.match(source, /storedFee !== null && storedFee !== undefined/);
  assert.match(source, /courtFee:\s*Math\.max\(0, total - serviceFee\)/);
  assert.doesNotMatch(source, /total:\s*courtFee \+ serviceFee/);
});

test('pricing surfaces never present the internal allocation as an add-on', () => {
  const slotPricing = sourceBetween('function allInSlotRate', 'function activeHostSession');
  const summaries = sourceBetween('function hostBookingItemsSummaryHtml', 'async function refreshBookingItemViews');
  assert.doesNotMatch(slotPricing, /Final Prices|Live Total|csl-final/i);
  assert.doesNotMatch(summaries, /Final booking total|Final total|Live total/i);
  assert.match(summaries, /Booking fee/);
  assert.match(summaries, /pbs-free-badge">Free/);
});
