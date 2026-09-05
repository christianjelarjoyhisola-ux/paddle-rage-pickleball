const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

const rendererPath = path.join(__dirname, 'supabase/functions/_shared/paddle-rage-email.ts');
const endpointPath = path.join(__dirname, 'supabase/functions/send-reschedule-email/index.ts');

function javascript(file) {
  return stripTypeScriptTypes(fs.readFileSync(file, 'utf8'))
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export\s+/gm, '');
}

const rendererContext = vm.createContext({
  Deno: { env: { get: () => undefined } },
  URL,
});
vm.runInContext(javascript(rendererPath), rendererContext, { filename: rendererPath });

function booking(ref, overrides = {}) {
  return {
    ref,
    booking_group_ref: 'PB-FAMILY-G',
    full_name: 'Test Player',
    email: 'player@example.test',
    court_name: 'Court 1',
    date: '2026-09-22',
    start_time: '8:00 AM',
    end_time: '10:00 AM',
    duration: 2,
    status: 'confirmed',
    ...overrides,
  };
}

function item(row, overrides = {}) {
  return {
    bookingRef: row.ref,
    oldDate: '2026-09-20',
    oldStartTime: '6:00 PM',
    oldEndTime: '8:00 PM',
    newDate: row.date,
    newStartTime: row.start_time,
    newEndTime: row.end_time,
    newDuration: row.duration,
    ...overrides,
  };
}

function endpoint(rows, { authorized = true } = {}) {
  const sent = [];
  const reads = [];
  let handler;
  const db = {
    from(table) {
      assert.equal(table, 'bookings');
      let found = rows;
      return {
        select() { return this; },
        eq(column, value) {
          reads.push({ column, value });
          found = rows.filter(row => row[column] === value);
          return this;
        },
        async maybeSingle() { return { data: found[0] || null, error: null }; },
        async limit(count) { return { data: found.slice(0, count), error: null }; },
      };
    },
  };
  const context = vm.createContext({
    Deno: {
      env: { get: key => key === 'SUPABASE_URL' ? 'https://database.example.test' : 'test-only-value' },
      serve: value => { handler = value; },
    },
    createClient: () => db,
    isAllowedEmailOrigin: () => true,
    emailCorsHeaders: () => ({}),
    jsonResponse: (_req, body, status = 200) => new Response(JSON.stringify(body), { status }),
    requireAdminEmailRequest: async () => { if (!authorized) throw new Error('Admin access required'); },
    isEmailAddress: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    sendMailerooEmail: async payload => { sent.push(payload); return { id: 'fake-delivery' }; },
    renderRescheduleEmail: rendererContext.renderRescheduleEmail,
    renderGroupedRescheduleEmail: rendererContext.renderGroupedRescheduleEmail,
    Response,
    Error,
    URL,
  });
  vm.runInContext(javascript(endpointPath), context, { filename: endpointPath });
  return {
    sent,
    reads,
    async request(payload) {
      const response = await handler(new Request('https://functions.example.test/send-reschedule-email', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      }));
      return { status: response.status, body: await response.json() };
    },
  };
}

test('a moved subset sends one canonical email for differing durations and repeated courts', async () => {
  const anchor = booking('PB-FAMILY-01');
  const first = booking('PB-FAMILY-02');
  const second = booking('PB-FAMILY-03', { start_time: '1:00 PM', end_time: '2:00 PM', duration: 1 });
  const api = endpoint([anchor, first, second]);
  const response = await api.request({
    bookingRef: anchor.ref,
    email: 'wrong@example.test', fullName: 'Wrong Guest', courtName: 'Wrong Court',
    items: [item(first), item(second, { oldStartTime: '2:00 PM', oldEndTime: '3:00 PM' })],
    note: 'Weather adjustment',
  });
  assert.equal(response.status, 200);
  assert.equal(api.sent.length, 1);
  const mail = api.sent[0];
  assert.equal(mail.to, 'player@example.test');
  assert.equal(mail.toName, 'Test Player');
  assert.equal(mail.tags.booking_reference, 'PB-FAMILY');
  assert.match(mail.plain, /PB-FAMILY-02[\s\S]*8:00 AM - 10:00 AM[\s\S]*Duration: 2 hours/);
  assert.match(mail.plain, /PB-FAMILY-03[\s\S]*1:00 PM - 2:00 PM[\s\S]*Duration: 1 hour/);
  assert.doesNotMatch(mail.plain, /PB-FAMILY-01|Wrong Guest|Wrong Court|wrong@example/);
  assert.match(mail.plain, /Any other reservations in your booking keep their current schedules/);
  assert.match(mail.plain, /Weather adjustment/);
  assert.match(mail.html, /manage-booking\.html#ref=PB-FAMILY/);
});

test('empty, excessive, malformed, and duplicate selections never send', async () => {
  const row = booking('PB-FAMILY-01');
  for (const items of [[], Array.from({ length: 9 }, () => item(row)), [item(row), item(row)], null, [null]]) {
    const api = endpoint([row]);
    assert.equal((await api.request({ bookingRef: row.ref, items })).status, 400);
    assert.equal(api.sent.length, 0);
    assert.equal(api.reads.length, 0);
  }
});

test('same email, payment reference, or prefix cannot authorize another booking family', async () => {
  const anchor = booking('PB-FAMILY-01');
  const unrelated = booking('PB-FAMILY-02', { booking_group_ref: 'PB-OTHER-G' });
  const api = endpoint([anchor, unrelated]);
  const response = await api.request({ bookingRef: anchor.ref, items: [item(anchor), item(unrelated)] });
  assert.equal(response.status, 404);
  assert.equal(api.sent.length, 0);

  const standalone = booking('PB-LEGACY-01', { booking_group_ref: null });
  const sibling = booking('PB-LEGACY-02', { booking_group_ref: null });
  const legacy = endpoint([standalone, sibling]);
  assert.equal((await legacy.request({ bookingRef: standalone.ref, items: [item(standalone), item(sibling)] })).status, 404);
  assert.equal(legacy.sent.length, 0);
  assert.equal((await legacy.request({ bookingRef: standalone.ref, items: [item(standalone)] })).status, 200);
});

test('mixed-recipient and oversized families are rejected even for a selected subset', async () => {
  const anchor = booking('PB-FAMILY-01');
  for (const family of [
    [anchor, booking('PB-FAMILY-02', { email: 'other@example.test' })],
    Array.from({ length: 9 }, (_, index) => booking(`PB-FAMILY-0${index + 1}`)),
  ]) {
    const api = endpoint(family);
    assert.equal((await api.request({ bookingRef: anchor.ref, items: [item(anchor)] })).status, 409);
    assert.equal(api.sent.length, 0);
  }
});

test('every saved date, start, end, duration and active status is verified before any mail', async () => {
  const anchor = booking('PB-FAMILY-01');
  const second = booking('PB-FAMILY-02');
  for (const changed of [
    { date: '2026-09-23' }, { start_time: '9:00 AM' }, { end_time: '11:00 AM' },
    { duration: 1 }, { status: 'cancelled' }, { status: 'forfeited' },
  ]) {
    const api = endpoint([anchor, { ...second, ...changed }]);
    const response = await api.request({ bookingRef: anchor.ref, items: [item(anchor), item(second)] });
    assert.ok([404, 409].includes(response.status));
    assert.equal(api.sent.length, 0);
  }
});

test('invalid dates and noninteger durations are refused', async () => {
  const anchor = booking('PB-FAMILY-01');
  for (const invalid of [{ newDate: '2026-02-30' }, { oldDate: '2026-09-31' }, { newDuration: 1.5 }, { bookingRef: '' }]) {
    const api = endpoint([anchor]);
    assert.equal((await api.request({ bookingRef: anchor.ref, items: [item(anchor, invalid)] })).status, 400);
    assert.equal(api.sent.length, 0);
  }
});

test('grouped notices require admin authorization before reading bookings', async () => {
  const row = booking('PB-FAMILY-01');
  const api = endpoint([row], { authorized: false });
  assert.equal((await api.request({ bookingRef: row.ref, items: [item(row)] })).status, 403);
  assert.equal(api.reads.length, 0);
  assert.equal(api.sent.length, 0);
});

test('the existing single-booking payload keeps its renderer and recipient checks', async () => {
  const row = booking('PB-SINGLE', { booking_group_ref: null });
  const api = endpoint([row]);
  const payload = { ...item(row), email: row.email, fullName: 'Client Name', courtName: 'Client Court' };
  assert.equal((await api.request(payload)).status, 200);
  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0].plain, /Court: Court 1/);
  assert.match(api.sent[0].plain, /Hi Test Player/);
  assert.match(api.sent[0].plain, /Your booking has been moved\. Your slot remains secure/);
  assert.equal((await api.request({ ...payload, email: 'wrong@example.test' })).status, 404);
  assert.equal(api.sent.length, 1);
});

test('grouped renderer escapes court names, guest names and notes while preserving every item', () => {
  const row = booking('PB-FAMILY-01');
  const payload = {
    bookingRef: 'PB-FAMILY', email: row.email, fullName: '<img src=x onerror=alert(1)>',
    note: '<script>alert(1)</script>',
    items: Array.from({ length: 8 }, (_, index) => ({ ...item(row), bookingRef: `PB-ITEM-${index + 1}`, courtName: `Court ${index + 1} <script>` })),
  };
  const rendered = rendererContext.renderGroupedRescheduleEmail(payload);
  assert.doesNotMatch(rendered.html, /<script>|<img src=x/);
  assert.match(rendered.html, /&lt;script&gt;/);
  for (let index = 1; index <= 8; index += 1) {
    assert.match(rendered.html, new RegExp(`PB-ITEM-${index}`));
    assert.match(rendered.plain, new RegExp(`PB-ITEM-${index}`));
  }
  assert.match(rendered.html, />Manage booking<\/a>/);
  assert.doesNotMatch(rendered.html, /accessToken|access_token|token_hash/);
});
