const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const graphic = require('./availability-graphic.js');

function fakeCanvas() {
  const calls = [];
  const gradient = { addColorStop() {} };
  const context = {
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    closePath() {},
    arc() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
    clearRect() {},
    fillRect() {},
    fillText(value, x, y) { calls.push({ type: 'fillText', value: String(value), x, y }); },
    drawImage() {},
    createLinearGradient() { return gradient; },
    createRadialGradient() { return gradient; },
    measureText(value) { return { width: String(value).length * 11 }; },
  };
  return {
    width: 0,
    height: 0,
    calls,
    getContext(kind) { return kind === '2d' ? context : null; },
  };
}

test('normalizes the production availability graphic contract without carrying PII', () => {
  const snapshot = graphic.normalizeSnapshot({
    version: 1,
    date: '2026-09-20',
    timezone: 'Asia/Manila',
    asOf: '2026-09-02T12:15:00.000Z',
    customerName: 'Must Not Appear',
    courts: [{
      id: 'court-a',
      name: 'Center Court',
      availableCount: 1,
      totalSlots: 12,
      slots: [{
        hour: 6,
        startLabel: '6:00 AM',
        endLabel: '7:00 AM',
        state: 'free',
        label: '6:00 AM - 7:00 AM',
        customer_name: 'Also Must Not Appear',
      }],
    }],
  });

  assert.equal(snapshot.generatedAt, '2026-09-02T12:15:00.000Z');
  assert.equal(snapshot.courts[0].slots[0].status, 'available');
  assert.equal(snapshot.courts[0].slots[0].start, 6);
  assert.equal(snapshot.courts[0].slots[0].end, 7);
  assert.equal(JSON.stringify(snapshot).includes('Must Not Appear'), false);
});

test('tolerates snake_case court maps and available-slot arrays', () => {
  const snapshot = graphic.normalizeSnapshot({
    schedule_date: '2026-09-21',
    generated_at: '2026-09-02T13:00:00.000Z',
    court_availability: {
      alpha: {
        court_name: 'Court Alpha',
        available_slots: ['8:00 AM - 9:00 AM', '9:00 AM - 10:00 AM'],
      },
    },
  });
  assert.equal(snapshot.courts[0].id, 'alpha');
  assert.equal(snapshot.courts[0].name, 'Court Alpha');
  assert.deepEqual(graphic.mergeAvailableRanges(snapshot.courts[0].slots), [
    { start: 8, end: 10, label: '8–10 AM' },
  ]);
});

test('merges consecutive slots, preserves gaps, and formats noon and midnight', () => {
  const ranges = graphic.mergeAvailableRanges([
    { start: 10, end: 11, status: 'available' },
    { start: 11, end: 13, status: 'available' },
    { start: 13, end: 14, status: 'booked' },
    { start: 15, end: 16, status: 'available' },
    { start: 23, end: 24, status: 'available' },
  ]);
  assert.deepEqual(ranges, [
    { start: 10, end: 13, label: '10 AM–1 PM' },
    { start: 15, end: 16, label: '3–4 PM' },
    { start: 23, end: 24, label: '11 PM–MIDNIGHT' },
  ]);
});

test('end-of-day ranges label midnight without an ambiguous 12 AM collapse', () => {
  assert.deepEqual(graphic.mergeAvailableRanges([
    { start: 18, end: 24, status: 'available' },
  ]), [{ start: 18, end: 24, label: '6 PM–MIDNIGHT' }]);
});

test('caption contains only court availability, booking CTA, and freshness disclaimer', () => {
  const caption = graphic.buildCaption({
    date: '2026-09-20',
    asOf: '2026-09-02T11:42:00.000Z',
    customerName: 'Hidden Customer',
    courts: [{
      id: '1',
      name: 'Court One',
      slots: [{ hour: 18, end: 20, status: 'available' }],
    }],
  });
  assert.match(caption, /Court One: 6–8 PM/);
  assert.match(caption, /Slots may change/);
  assert.match(caption, /paddleragecdo\.ph/);
  assert.doesNotMatch(caption, /Hidden Customer/);
});

test('feed and story renderers set exact Facebook canvas dimensions', async () => {
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    asOf: '2026-09-02T12:00:00.000Z',
    courts: [{ id: '1', name: 'Court One', slots: [{ hour: 7, end: 9, state: 'free' }] }],
  });
  const feed = fakeCanvas();
  const story = fakeCanvas();
  await graphic.drawPoster(feed, snapshot, 'feed', { logo: false, qr: false });
  await graphic.drawPoster(story, snapshot, 'story', { logo: false, qr: false });
  assert.deepEqual([feed.width, feed.height], [1080, 1350]);
  assert.deepEqual([story.width, story.height], [1080, 1920]);
});

test('nine courts become complete, ordered carousel pages in both formats', () => {
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    asOf: '2026-09-02T12:00:00.000Z',
    courts: Array.from({ length: 9 }, (_, index) => ({
      id: `court-${index + 1}`,
      name: `Court ${index + 1}`,
      slots: [{ hour: 6 + index, end: 7 + index, state: 'free' }],
    })),
  });
  ['feed', 'story'].forEach(format => {
    const pages = graphic.paginateSnapshot(snapshot, format);
    assert.equal(pages.length, 3);
    assert.deepEqual(
      pages.flatMap(page => page.courts.map(court => court.id)),
      snapshot.courts.map(court => court.id),
    );
    assert.ok(pages.every(page => page.courts.length <= graphic.posterLayouts[format].capacity));
  });
});

test('court controls, captions, and carousel pages use stable natural court order', () => {
  const courts = Array.from({ length: 10 }, (_, index) => ({
    id: String(10 - index),
    name: `Court ${10 - index}`,
    slots: [{ hour: 7, end: 8, state: 'free' }],
  }));
  const snapshot = graphic.normalizeSnapshot({ date: '2026-09-20', courts });
  const expected = Array.from({ length: 10 }, (_, index) => `Court ${index + 1}`);
  assert.deepEqual(snapshot.courts.map(court => court.name), expected);
  assert.deepEqual(
    graphic.paginateSnapshot(snapshot, 'feed').flatMap(page => page.courts.map(court => court.name)),
    expected,
  );
  const caption = graphic.buildCaption(snapshot);
  expected.slice(0, -1).forEach((name, index) => {
    assert.ok(caption.indexOf(`${name}:`) < caption.indexOf(`${expected[index + 1]}:`));
  });
});

test('court continuation cards retain every disjoint available range without ellipsis', () => {
  const slots = Array.from({ length: 9 }, (_, index) => ({
    hour: index * 2,
    end: index * 2 + 1,
    state: 'free',
  }));
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    courts: [{ id: 'show-court', name: 'Show Court', slots }],
  });
  const expected = graphic.mergeAvailableRanges(snapshot.courts[0].slots).map(range => range.label);
  const pages = graphic.paginateSnapshot(snapshot, 'feed');
  const actual = pages.flatMap(page => page.courts).flatMap(court => graphic.mergeAvailableRanges(court.slots).map(range => range.label));
  assert.deepEqual(actual, expected);
  assert.equal(pages.length, 2);
  assert.ok(pages.flatMap(page => page.courts).every(court => graphic.mergeAvailableRanges(court.slots).length <= 2));
});

test('carousel filenames are numbered and every rendered page carries its marker', async () => {
  const snapshot = graphic.normalizeSnapshot({
    date: '2026-09-20',
    courts: Array.from({ length: 9 }, (_, index) => ({
      id: String(index + 1),
      name: `Court ${index + 1}`,
      slots: [{ hour: 7, end: 8, state: 'free' }],
    })),
  });
  const pages = graphic.paginateSnapshot(snapshot, 'feed');
  for (let index = 0; index < pages.length; index += 1) {
    const canvas = fakeCanvas();
    await graphic.drawPoster(canvas, pages[index], 'feed', {
      logo: false,
      qr: false,
      pageNumber: index + 1,
      totalPages: pages.length,
      summarySnapshot: snapshot,
    });
    assert.deepEqual([canvas.width, canvas.height], [1080, 1350]);
    assert.ok(canvas.calls.some(call => call.value === `PAGE ${index + 1} / ${pages.length}`));
    assert.equal(
      graphic.outputFileName(snapshot.date, 'feed', index, pages.length),
      `paddle-rage-availability-2026-09-20-feed-0${index + 1}-of-03.png`,
    );
  }
});

test('poster layouts keep branded content inside feed and story safe areas', () => {
  const feed = graphic.posterLayouts.feed;
  const story = graphic.posterLayouts.story;
  assert.ok(feed.footerContentBottom <= feed.safeBottom);
  assert.ok(story.brandY >= story.safeTop);
  assert.ok(story.footerContentBottom <= story.safeBottom);
  assert.ok(story.cardsEnd < story.footerY);
});

test('opening date and Web Share fallback are explicit', () => {
  assert.equal(graphic.constants.OPENING_DATE, '2026-09-19');
  assert.match(graphic.shareErrorMessage({ name: 'NotAllowedError' }), /Download PNG/);
  assert.match(graphic.shareErrorMessage({ name: 'NotAllowedError' }), /upload.*Facebook/i);
  assert.equal(graphic.shareErrorMessage({ name: 'AbortError' }), '');
});

test('every output path is guarded by a forced serialized live refresh', () => {
  const source = fs.readFileSync(require.resolve('./availability-graphic.js'), 'utf8');
  assert.match(source, /refresh\(\{ replace: false, force: true,/);
  assert.match(source, /if \(state\.outputPromise\) return state\.outputPromise/);
  assert.match(source, /const snapshot = await ensureFreshForExport\(label\);\s*setBusy\(true,/);
  assert.match(source, /const pages = paginateSnapshot\(snapshot, state\.format\)/);
  assert.match(source, /const \{ items \} = await prepareOutputSet\('download'\)/);
  assert.match(source, /await ensureFreshForExport\('caption copy'\)/);
  assert.match(source, /const \{ items, snapshot \} = await prepareOutputSet\('share'\)/);
  assert.match(source, /navigator\.share\(\{ title: 'Paddle Rage court availability', text: caption, files \}\)/);
  assert.doesNotMatch(source, /if \(state\.busy\) return currentSnapshot\(\)/);
});

test('styles include the integration launch hook and responsive three-action layouts', () => {
  const css = fs.readFileSync('availability-graphic.css', 'utf8');
  assert.match(css, /\.availability-post-launch\s*\{/);
  assert.match(css, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.prag-canvas-shell canvas[\s\S]*max-height:\s*100%/);
  assert.match(css, /body\.prag-modal-open\s*\{\s*overflow:\s*hidden/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.prag-workspace\s*\{[\s\S]*?display:\s*block;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.prag-controls\s*\{[\s\S]*?min-height:\s*max-content;[\s\S]*?overflow:\s*visible;/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.prag-preview-panel\s*\{\s*height:\s*470px;\s*min-height:\s*470px;/);
});
