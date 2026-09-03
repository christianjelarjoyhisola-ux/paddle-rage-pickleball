const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const page = fs.readFileSync('index.html', 'utf8');

function openingTagById(id) {
  return page.match(new RegExp(`<[^>]+id=["']${id}["'][^>]*>`))?.[0] || '';
}

function openingTagByClass(className) {
  return page.match(new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`))?.[0] || '';
}

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...page.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gs'))];
  return matches.map(match => match[1]).join('\n');
}

function sourceBetween(start, end) {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker after ${start}: ${end}`);
  return page.slice(from, to);
}

function ticketSessionModel(booking) {
  const helpers = sourceBetween('function bookingTicketHourLabel', 'function renderBookingTicketSessions');
  return new Function('booking', `${helpers}\nreturn bookingTicketSessionModel(booking);`)(booking);
}

test('premium booking ticket uses semantic dialog and compact information groups', () => {
  const modalTag = openingTagById('invModal');
  const titleTag = openingTagById('iTitle');
  const subtitleTag = openingTagById('iHeroSub');
  const statusTag = openingTagById('iStatus');

  assert.match(modalTag, /role=["']dialog["']/);
  assert.match(modalTag, /aria-modal=["']true["']/);
  assert.match(modalTag, /aria-labelledby=["']iTitle["']/);
  assert.match(modalTag, /aria-describedby=["']iHeroSub["']/);
  assert.match(titleTag, /id=["']iTitle["']/);
  assert.match(subtitleTag, /id=["']iHeroSub["']/);
  assert.match(statusTag, /role=["']status["']/);
  assert.match(statusTag, /aria-live=["']polite["']/);
  assert.match(statusTag, /aria-atomic=["']true["']/);

  assert.match(openingTagByClass('inv-card'), /data-invoice-state=["']pending["']/);
  assert.match(page, /class=["'][^"']*inv-scroll-region[^"']*["']/);
  assert.match(page, /class=["'][^"']*inv-ref-line[^"']*["']/);
  assert.match(page, /class=["'][^"']*inv-ticket-summary[^"']*["']/);
  assert.match(page, /class=["'][^"']*inv-session-card[^"']*["']/);
  assert.match(page, /class=["'][^"']*inv-payment-card[^"']*["']/);
  assert.match(page, /class=["'][^"']*inv-customer-grid[^"']*["']/);
  assert.match(page, /class=["'][^"']*inv-status-strip[^"']*["']/);

  const modalMarkup = sourceBetween('<!-- INVOICE MODAL -->', '<!-- OPEN PLAY SIGN-UP MODAL -->');
  const closeButton = modalMarkup.match(/<button[^>]+aria-label=["']Close booking confirmation["'][^>]*>/)?.[0] || '';
  assert.match(closeButton, /type=["']button["']/);
  for (const className of ['inv-copy-btn', 'btn-print', 'btn-done']) {
    assert.match(openingTagByClass(className), /type=["']button["']/);
  }
});

test('ticket keeps actions visible and uses a readable single-column mobile flow', () => {
  const cardRule = cssRule('.inv-card');
  const scrollRule = cssRule('.inv-scroll-region');
  const summaryRule = cssRule('.inv-ticket-summary');
  const actionsRule = cssRule('.inv-actions');

  assert.match(cardRule, /overflow\s*:\s*hidden/);
  assert.match(scrollRule, /overflow-y\s*:\s*auto/);
  assert.match(scrollRule, /overscroll-behavior\s*:\s*contain/);
  assert.match(summaryRule, /display\s*:\s*block/);
  assert.match(actionsRule, /position\s*:\s*sticky/);
  assert.match(actionsRule, /bottom\s*:\s*0/);
  assert.match(actionsRule, /z-index\s*:\s*[1-9]/);

  assert.match(
    page,
    /@media\s*\([^)]*max-width\s*:\s*700px[^)]*\)\s*,\s*\([^)]*max-height\s*:\s*720px[^)]*\)\s*\{[\s\S]*?\.inv-hero/,
    'mobile confirmation rules must include the 532px screenshot and short screens',
  );
  assert.match(
    page,
    /@media\s*\([^)]*max-width\s*:\s*700px[^)]*\)[\s\S]*?\.inv-customer-grid\s*\{[^}]*grid-template-columns\s*:\s*1fr/,
    'player details should become readable label/value rows at mobile widths',
  );

  const ticketMarkup = sourceBetween('<div class="inv-ticket-summary">', '<footer class="inv-actions">');
  const flow = ['inv-status-strip', 'inv-session-card', 'inv-payment-card', 'inv-customer-grid'];
  for (let index = 1; index < flow.length; index += 1) {
    assert.ok(
      ticketMarkup.indexOf(flow[index - 1]) < ticketMarkup.indexOf(flow[index]),
      `${flow[index - 1]} must appear before ${flow[index]} in the mobile ticket flow`,
    );
  }
});

test('full-payment tickets show the amount once instead of repeating it as a second total', () => {
  const showInvoice = sourceBetween('function showInvoice(b)', 'function copyInvRef()');

  assert.match(openingTagById('iDownWrap'), /class=["'][^"']*inv-amt-down-wrap/);
  assert.match(showInvoice, /classList\.toggle\(["']is-full-payment["']\s*,\s*isFullPay\)/);
  assert.match(
    page,
    /\.inv-amount-wrap\.is-full-payment\s+\.inv-amt-down-wrap\s*\{[^}]*display\s*:\s*none/,
  );
  assert.match(showInvoice, /const isFullPay\s*=\s*b\.downpayment\s*>=\s*b\.total/);
  assert.doesNotMatch(
    showInvoice,
    /isFullPay\s*\?\s*["'`]Fully paid\./,
    'a full requested payment is not automatically proof that cash or a receipt is settled',
  );
});

test('pending, confirmed, and rejected are explicit ticket states with one consolidated follow-up', () => {
  const showInvoice = sourceBetween('function showInvoice(b)', 'function copyInvRef()');

  assert.match(showInvoice, /dataset\.invoiceState\s*=\s*invoiceState/);
  assert.match(showInvoice, /isRejected\s*\?\s*["']rejected["']\s*:\s*isConfirmed\s*\?\s*["']confirmed["']\s*:\s*["']pending["']/);
  for (const state of ['pending', 'confirmed', 'rejected']) {
    assert.match(
      page,
      new RegExp(`\\.inv-card\\[data-invoice-state=["']${state}["']\\]`),
      `missing premium ${state} ticket styling`,
    );
  }

  assert.doesNotMatch(showInvoice, /What's Next/i);
  assert.doesNotMatch(showInvoice, /inv-next-step/);
  assert.match(showInvoice, /iStatusSummary/);
  assert.match(showInvoice, /isConfirmed[\s\S]*?Booking Confirmed!/);
  assert.match(showInvoice, /isRejected[\s\S]*?Receipt Rejected/);

  assert.match(
    showInvoice,
    /(?:if\s*\(\s*!isConfirmed\s*&&\s*b\._receiptResult\s*\)|if\s*\(\s*b\._receiptResult\s*&&\s*!isConfirmed\s*\)|if\s*\(\s*isConfirmed\s*\)[\s\S]*?else\s+if\s*\(\s*b\._receiptResult\s*\))/, 
    'receipt substates must not downgrade an already confirmed booking to awaiting confirmation',
  );
});

test('status changes remain accessible and empty email copy is hidden', () => {
  const showInvoice = sourceBetween('function showInvoice(b)', 'function copyInvRef()');

  assert.match(showInvoice, /statusEl\.setAttribute\(["']aria-live["']\s*,\s*(?:isRejected|invoiceState\s*===\s*["']rejected["'])\s*\?\s*["']assertive["']\s*:\s*["']polite["']\)/);
  assert.match(
    showInvoice,
    /(?:\.hidden\s*=\s*!b\.email|\.style\.display\s*=\s*b\.email\s*\?\s*["']["']\s*:\s*["']none["'])/,
  );
  assert.match(page, /\.i-row\s+\.vl\s*\{[^}]*overflow-wrap\s*:\s*anywhere/);
  assert.match(page, /\.inv-status-strip[^}]*\{|\.inv-status-strip\s*\{/);
});

test('multi-court tickets collapse identical schedules into one organized block', () => {
  const model = ticketSessionModel({
    courtName: '3 courts: Court 1, Court 2, Court 3',
    timeLabel: 'flattened aggregate must not render',
    date: '2026-09-01',
    duration: 6,
    groupItems: [
      { courtName: 'Court 1', date: '2026-09-01', slots: [8, 9], timeLabel: '8:00 AM - 10:00 AM', duration: 2 },
      { courtName: 'Court 2', date: '2026-09-01', slots: ['8', '9'], timeLabel: '8:00 AM - 10:00 AM', duration: 2 },
      { courtName: 'Court 3', date: '2026-09-01', slots: [9, 8, 8], timeLabel: '8:00 AM - 10:00 AM', duration: 2 },
    ],
  });

  assert.equal(model.isMulti, true);
  assert.equal(model.groups.length, 1);
  assert.deepEqual(model.groups[0].courts, ['Court 1', 'Court 2', 'Court 3']);
  assert.equal(model.groups[0].timeLabel, '8:00 AM – 10:00 AM');
  assert.equal(model.groups[0].durationLabel, '2 hrs each');
  assert.equal(model.summary, '3 courts · 6 court-hours');
  assert.doesNotMatch(JSON.stringify(model), /flattened aggregate must not render/);
});

test('different and nonconsecutive court schedules remain separate', () => {
  const model = ticketSessionModel({
    duration: 5,
    groupItems: [
      { courtName: 'Court 1', date: '2026-09-01', slots: [8, 9], timeLabel: '8:00 AM - 10:00 AM', duration: 2 },
      { courtName: 'Court 2', date: '2026-09-01', slots: [8, 9], timeLabel: '8:00 AM - 10:00 AM', duration: 2 },
      { courtName: 'Court 3', date: '2026-09-01', slots: [10], timeLabel: '10:00 AM - 11:00 AM', duration: 1 },
    ],
  });
  assert.equal(model.groups.length, 2);
  assert.deepEqual(model.groups.map(group => group.courts), [['Court 1', 'Court 2'], ['Court 3']]);
  assert.equal(model.summary, '3 courts · 5 court-hours');

  const disjoint = ticketSessionModel({
    groupItems: [
      { courtName: 'Court 1', date: '2026-09-01', slots: [8, 10], timeLabel: '8:00 AM - 9:00 AM, 10:00 AM - 11:00 AM', duration: 2 },
      { courtName: 'Court 2', date: '2026-09-01', slots: [8, 9], timeLabel: '8:00 AM - 10:00 AM', duration: 2 },
    ],
  });
  assert.equal(disjoint.groups.length, 2, 'different slot signatures must never be falsely merged');
});

test('single and legacy aggregate bookings keep safe organized fallbacks', () => {
  const single = ticketSessionModel({
    courtName: 'Court 1',
    date: '2026-09-01',
    timeLabel: '11:00 PM - 12:00 AM',
    duration: 1,
  });
  assert.equal(single.isMulti, false);
  assert.equal(single.groups.length, 1);
  assert.equal(single.summary, '1 hr');

  const legacy = ticketSessionModel({
    courtName: '3 courts: Court 1, Court 2, Court 3',
    date: '2026-09-01',
    timeLabel: 'Court 1: 8:00 AM - 10:00 AM; Court 2: 8:00 AM - 10:00 AM; Court 3: 10:00 AM - 11:00 AM',
    duration: 5,
  });
  assert.equal(legacy.items.length, 3);
  assert.equal(legacy.groups.length, 2);
  assert.deepEqual(legacy.groups[0].courts, ['Court 1', 'Court 2']);
  assert.equal(legacy.summary, '3 courts · 5 court-hours');
  assert.ok(legacy.groups.every(group => !group.timeLabel.includes(';')));

  const opaque = ticketSessionModel({
    courtName: '2 courts: East Championship Court, West Championship Court',
    date: '2026-09-01',
    timeLabel: 'Multiple time blocks',
    duration: 4,
  });
  assert.equal(opaque.groups.length, 1);
  assert.equal(opaque.groups[0].timeLabel, 'Multiple time blocks');
});

test('multi-session markup prevents squeezed duration and aggregate strings', () => {
  const showInvoice = sourceBetween('function showInvoice(b)', 'function copyInvRef()');
  for (const id of ['iSessionMeta', 'iSessionMulti', 'iSessionDate', 'iSessionList']) {
    assert.ok(openingTagById(id), `missing ${id}`);
  }
  assert.match(showInvoice, /renderBookingTicketSessions\(b\)/);
  assert.doesNotMatch(showInvoice, /set\(['"]iCourt['"]\s*,\s*b\.courtName/);
  assert.doesNotMatch(showInvoice, /set\(['"]iTime['"]\s*,\s*b\.timeLabel/);
  assert.match(page, /\.inv-session-slot-line\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,1fr\)\s+auto/);
  assert.match(page, /\.inv-session-slot-duration\s*\{[^}]*white-space\s*:\s*nowrap/);
  assert.match(page, /\.inv-session-courts\s*\{[^}]*flex-wrap\s*:\s*wrap/);
  assert.match(page, /group\.courts\.map\([^)]*=>\s*`<span[^`]*\$\{esc\(courtName\)\}/);
});
