const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const config = fs.readFileSync(path.join(root, 'supabase-config.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, '_worker.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260830160000_host_booking_parity.sql'),
  'utf8',
);

test('host My Bookings uses its identity-scoped RPC instead of general booking reads', () => {
  assert.match(config, /async getMyHostBookings\(\)[\s\S]*?\.rpc\('get_my_host_bookings'\)/);
  assert.match(index, /const all = await loadMyHostBookingsForPage\(\);/);
  assert.doesNotMatch(index, /DB\.getBookings\(\{\s*hostUserId:/);
});

test('host My Bookings survives a mixed cached page and data-layer release', () => {
  assert.match(index, /supabase-config\.js\?v=[A-Za-z0-9._-]+/);
  assert.match(index, /typeof DB\?\.getMyHostBookings === 'function'/);
  assert.match(index, /const client = window\._supabase/);
  assert.match(index, /client\.rpc\('get_my_host_bookings'\)/);
  assert.match(index, /site update is available[\s\S]*?refresh this page/i);
  assert.match(worker, /url\.pathname === '\/supabase-config\.js'/);
  assert.match(worker, /Cache-Control["'],\s*["']no-store, max-age=0/);
});

test('host booking RPC derives ownership from auth uid and rejects public execution', () => {
  assert.match(
    migration,
    /create or replace function public\.get_my_host_bookings\(\)/,
  );
  assert.match(migration, /caller_id uuid := auth\.uid\(\)/);
  assert.match(migration, /(?:b|booking)\.host_user_id = caller_id/);
  assert.match(migration, /(?:a|account)\.role = 'host'/);
  assert.match(migration, /coalesce\((?:a|account)\.status, 'active'\) = 'active'/);
  assert.match(
    migration,
    /revoke all on function public\.get_my_host_bookings\(\)\s+from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_my_host_bookings\(\)\s+to authenticated/,
  );
});

test('host row visibility requires authenticated ownership metadata', () => {
  const policyStart = migration.indexOf('create policy bookings_select_host_own');
  assert.ok(policyStart >= 0, 'host-owned bookings need an explicit SELECT policy');
  const policySql = migration.slice(policyStart, policyStart + 1400);
  assert.match(policySql, /to authenticated/);
  assert.match(policySql, /public\.current_account_role\(\) = 'host'/);
  assert.match(policySql, /coalesce\((?:bookings\.)?host_booking, false\) = true/);
  assert.match(policySql, /(?:bookings\.)?host_user_id = auth\.uid\(\)/);
  assert.match(policySql, /(?:bookings\.)?created_by_user_id = auth\.uid\(\)/);
  assert.match(policySql, /(?:bookings\.)?created_by_role[^\n]*'host'/);
});

test('public homepage remains outside the general private booking surface', () => {
  assert.match(
    config,
    /const PB_PRIVATE_DATA_SURFACE = \/\^\\\/\(\?:admin\|signature-view\)/,
  );
  assert.doesNotMatch(config, /PB_PRIVATE_DATA_SURFACE[\s\S]{0,80}\bhost\b/);
});

test('local data mode exposes the same host-owned booking method', () => {
  const methodMatches = config.match(/async getMyHostBookings\(\)/g) || [];
  assert.ok(methodMatches.length >= 2, 'remote and local adapters must both implement getMyHostBookings');
  assert.match(
    config,
    /async getMyHostBookings\(\)[\s\S]*?session\.role !== 'host'[\s\S]*?booking\.hostBooking[\s\S]*?booking\.hostUserId/,
  );
});
