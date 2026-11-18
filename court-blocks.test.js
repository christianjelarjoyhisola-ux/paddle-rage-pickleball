const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const admin = fs.readFileSync('admin.html', 'utf8');
const config = fs.readFileSync('supabase-config.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20261119120000_court_block_details.sql', 'utf8');

function adminBlockContext(extra = {}) {
  const start = admin.indexOf('const CB_TYPES = [');
  const end = admin.indexOf('async function renderMaintenance()', start);
  assert.ok(start > 0 && end > start, 'court block helpers are present');
  const context = { esc: v => String(v), jsArg: v => String(v), MT_LABELS: [], _mtCourts: [], ...extra };
  vm.createContext(context);
  vm.runInContext(`${admin.slice(start, end)}\nthis.cbNextDate = cbNextDate; this.cbIsPast = cbIsPast; this.cbPaymentState = cbPaymentState; this.cbCourtsLabel = cbCourtsLabel; this.setDetails = d => { _cbDetails = d; };`, context);
  return context;
}

test('private block details are owner/court_owner only and never readable by anon', () => {
  assert.match(migration, /create table if not exists public\.court_block_details/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.court_block_details from public, anon/);
  const policies = migration.match(/create policy court_block_details_\w+[\s\S]*?;/g) || [];
  assert.equal(policies.length, 4);
  for (const policy of policies) {
    assert.match(policy, /to authenticated/);
    assert.match(policy, /has_account_role\(array\['owner','court_owner'\]\)/);
  }
  assert.match(migration, /payment_status in \('not_paid', 'paid', 'not_needed'\)/);
});

test('names, payment and notes are never written into the public maintenance_config', () => {
  const save = admin.slice(admin.indexOf('async function cbSave()'), admin.indexOf('async function cbDeleteFromEditor()'));
  const ruleLiteral = save.slice(save.indexOf('const rule = {'), save.indexOf('const detail = {'));
  assert.doesNotMatch(ruleLiteral, /forName|notes|paymentStatus/);
  assert.match(save, /saveCourtBlockDetail\(rule\.id, detail\)/);
});

test('block detail rows are validated before saving', () => {
  const start = config.indexOf("const PB_COURT_BLOCK_PAYMENT");
  const end = config.indexOf('function rowToCourt(r)', start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${config.slice(start, end)}\nthis.toRow = _pbCourtBlockDetailToRow; this.fromRow = _pbCourtBlockDetailFromRow;`, context);
  assert.deepEqual({ ...context.toRow('r1', { forName: '  Santos ', paymentStatus: 'paid', notes: ' gcash ' }) },
    { rule_id: 'r1', for_name: 'Santos', payment_status: 'paid', notes: 'gcash' });
  assert.throws(() => context.toRow('', {}), /missing its id/);
  assert.throws(() => context.toRow('r1', { paymentStatus: 'maybe' }), /valid payment/);
  assert.throws(() => context.toRow('r1', { forName: 'x'.repeat(161) }), /too long/);
  assert.equal(context.fromRow({ payment_status: 'weird' }).paymentStatus, 'not_paid');
});

test('next block date handles one-time, weekly and monthly blocks', () => {
  const ctx = adminBlockContext();
  const today = '2026-11-19'; // Thursday
  assert.equal(ctx.cbNextDate({ mode: 'specific', dates: ['2026-11-01', '2026-12-04', '2026-11-21'] }, today), '2026-11-21');
  assert.equal(ctx.cbNextDate({ mode: 'specific', dates: ['2026-11-01'] }, today), null);
  assert.equal(ctx.cbIsPast({ mode: 'specific', dates: ['2026-11-18'] }, today), true);
  assert.equal(ctx.cbNextDate({ mode: 'weekly', recurring: { days: [3] } }, today), '2026-11-25');
  assert.equal(ctx.cbNextDate({ mode: 'weekly', recurring: { days: [4] } }, today), '2026-11-19');
  assert.equal(ctx.cbNextDate({ mode: 'monthly', recurring: { day: 5 } }, today), '2026-12-05');
});

test('maintenance and closed blocks never show as unpaid', () => {
  const ctx = adminBlockContext();
  ctx.setDetails({ a: { paymentStatus: 'paid' } });
  assert.equal(ctx.cbPaymentState({ id: 'a', label: 'private' }), 'paid');
  assert.equal(ctx.cbPaymentState({ id: 'b', label: 'private' }), 'not_paid');
  assert.equal(ctx.cbPaymentState({ id: 'b', label: 'maintenance' }), 'not_needed');
  assert.equal(ctx.cbPaymentState({ id: 'b', label: 'closed' }), 'not_needed');
});

test('court labels treat no selection or every court as all courts', () => {
  const ctx = adminBlockContext({ _mtCourts: [{ id: 'c1', name: 'Court 1' }, { id: 'c2', name: 'Court 2' }] });
  assert.equal(ctx.cbCourtsLabel({ courtIds: [] }), 'All courts');
  assert.equal(ctx.cbCourtsLabel({ courtIds: ['c1', 'c2'] }), 'All courts');
  assert.equal(ctx.cbCourtsLabel({ courtIds: ['c2'] }), 'Court 2');
});
