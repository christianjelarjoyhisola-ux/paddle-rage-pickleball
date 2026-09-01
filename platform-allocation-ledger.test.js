const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const clientSource = fs.readFileSync(path.join(root, 'supabase-config.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const migrationSource = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901200000_platform_fee_ledger_safeguards.sql'),
  'utf8',
);
const courtBreakdownMigrationSource = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901210000_platform_allocation_court_breakdown.sql'),
  'utf8',
);
const courtBreakdownDashboardSql = courtBreakdownMigrationSource.match(
  /create or replace function public\.get_booking_fee_remittance_dashboard\(\)[\s\S]*?\n\$\$;/i,
)?.[0] || '';
const FinanceCore = require('./finance-core.js');

function extractLocalSnapshot() {
  const start = clientSource.indexOf('const localBookingFeeSnapshot =');
  const end = clientSource.indexOf('const defaultAccounts', start);
  assert.ok(start >= 0 && end > start, 'local booking-fee snapshot helper must exist');
  return new Function(`${clientSource.slice(start, end)}; return localBookingFeeSnapshot;`)();
}

function runLocalRemittanceDashboard(bookings, role = 'court_owner') {
  const start = clientSource.lastIndexOf('async getBookingFeeRemittanceDashboard()');
  const end = clientSource.indexOf('async getBookingFeeRemittanceHistory()', start);
  assert.ok(start >= 0 && end > start, 'local remittance dashboard adapter must exist');
  const methodSource = clientSource.slice(start, end).trim().replace(/,\s*$/, '');
  const getDashboard = new Function(
    'readDb',
    'Auth',
    `return ({ ${methodSource} }).getBookingFeeRemittanceDashboard;`,
  )(
    () => ({ bookings }),
    { getSession: () => ({ role }) },
  );
  return getDashboard();
}

test('the approved policy is fixed at PHP 10 per booked court-hour', () => {
  assert.match(clientSource, /service_fee_rate:\s*'10'/);
  assert.match(clientSource, /maintenance_fee:\s*'10'/);
  assert.match(clientSource, /fee_type:\s*'per_hour'/);
  assert.match(migrationSource, /\('maintenance_fee',\s*'10',\s*now\(\)\)/i);
  assert.match(migrationSource, /\('fee_type',\s*'per_hour',\s*now\(\)\)/i);
  assert.match(migrationSource, /create or replace function public\.guard_fixed_booking_fee_policy\(\)/i);
  assert.match(migrationSource, /booking_fee_policy_history_rate_check\s+check\s*\(fee_rate = 10\)/i);
});

test('three courts booked for three hours create nine court-hours and PHP 90', () => {
  const snapshot = extractLocalSnapshot();
  const rows = ['Court 1', 'Court 2', 'Court 3'].map((courtName, index) => snapshot({
    ref: `TEST-${index + 1}`,
    courtName,
    slots: [8, 9, 10],
    total: 1050,
    paymentMethod: 'gcash',
  }, {
    maintenance_fee: '10',
    fee_type: 'per_hour',
  }));

  assert.equal(rows.reduce((sum, row) => sum + row.bookingFeeUnitsSnapshot, 0), 9);
  assert.equal(rows.reduce((sum, row) => sum + row.bookingFeeAmountSnapshot, 0), 90);
  assert.ok(rows.every(row => row.bookingFeeRateSnapshot === 10));
  assert.ok(rows.every(row => row.bookingFeeTypeSnapshot === 'per_hour'));
});

test('pending proof earns nothing and an accepted booking earns its allocation once', () => {
  const pending = {
    ref: 'PENDING-1',
    total: 1050,
    slots: [8, 9, 10],
    status: 'pending',
    paymentStatus: 'for_verification',
    bookingFeeAmountSnapshot: 30,
  };
  const accepted = {
    ...pending,
    status: 'confirmed',
    paymentStatus: 'downpayment_paid',
    bookingFeeEarnedAt: '2026-09-01T00:00:00.000Z',
  };

  assert.equal(FinanceCore.bookingFeeEarned(pending, { maintenance_fee: 10, fee_type: 'per_hour' }), 0);
  assert.equal(FinanceCore.bookingFeeEarned(accepted, { maintenance_fee: 10, fee_type: 'per_hour' }), 30);
  assert.match(
    clientSource,
    /next\.bookingFeeEarnedAt = booking\.bookingFeeEarnedAt\s*\|\| booking\.booking_fee_earned_at\s*\|\| confirmedAt/,
    'later payment stages must retain the first earned timestamp',
  );
  assert.match(migrationSource, /on conflict \(booking_ref\) where released_at is null do nothing/i);
});

test('the premium dashboard uses authoritative, non-overlapping ledger buckets', () => {
  assert.match(adminSource, /id="maintFeePanel"[^>]*data-perm="remittances"/);
  assert.match(adminSource, /DB\.getBookingFeeRemittanceDashboard\(\)/);
  assert.match(adminSource, /const reviewAmountRaw = reviewRows\.reduce\(\(sum, record\) => sum \+ rmAmountUnderReview\(record\), 0\)/);
  assert.match(adminSource, /const preparedAmount = Math\.max\(0, openAmount - reviewAmount\)/);
  assert.match(adminSource, /accepted_total/);
  assert.match(adminSource, /Rates locked per booking/);
  assert.doesNotMatch(adminSource, /id="maintRateInput"|id="saveMaintRate"|id="maintMonth"/);
});

test('the SQL ledger preserves audit history and excludes released rows from payable totals', () => {
  assert.match(migrationSource, /create table if not exists public\.booking_fee_adjustments/i);
  assert.match(migrationSource, /create table if not exists public\.booking_fee_adjustment_applications/i);
  assert.match(migrationSource, /prevent_booking_fee_adjustment_change/i);
  assert.match(migrationSource, /(?:where|and)\s+i\.released_at is null/i);
  assert.match(migrationSource, /(?:where|and)\s+a\.released_at is null/i);
  assert.match(migrationSource, /gross_booking_fee_amount/i);
  assert.match(migrationSource, /adjustment_amount/i);
  assert.match(migrationSource, /credit_carryforward/i);
  assert.match(migrationSource, /sum\(r\.amount_settled\)[\s\S]*?where r\.status <> 'cancelled'/i);
  assert.match(migrationSource, /booking_fee_adjustment_applications[\s\S]*?void_delete_booking_group/i);
  assert.match(migrationSource, /already used for a different platform-fee adjustment/i);
});

test('the accumulating dashboard derives additive court totals from its authoritative unclaimed snapshot', () => {
  assert.ok(courtBreakdownDashboardSql, 'the additive dashboard function definition must exist');
  assert.match(
    courtBreakdownDashboardSql,
    /create or replace function public\.get_booking_fee_remittance_dashboard\(\)[\s\S]*?language plpgsql[\s\S]*?stable[\s\S]*?security definer[\s\S]*?set search_path = public, pg_temp/i,
  );
  assert.match(
    courtBreakdownDashboardSql,
    /with unclaimed as materialized\s*\([\s\S]*?from public\.booking_fee_unclaimed_rows\(\) u[\s\S]*?\),\s*rate_rows as/i,
    'one materialized set must feed both the existing aggregate and the court rows',
  );
  assert.equal(
    (courtBreakdownDashboardSql.match(/booking_fee_unclaimed_rows\(\)/gi) || []).length,
    1,
    'the function must not independently re-query live booking rows for its court breakdown',
  );
  assert.match(
    courtBreakdownDashboardSql,
    /when nullif\(btrim\(u\.booking_group_ref\), ''\) is not null\s+then 'group:' \|\| btrim\(u\.booking_group_ref\)\s+else 'booking:' \|\| u\.booking_ref/i,
    'multi-court booking rows must retain one shared reservation identity',
  );
  assert.match(
    courtBreakdownDashboardSql,
    /when nullif\(btrim\(coalesce\(u\.court_id, ''\)\), ''\) is not null[\s\S]*?'court-id:' \|\| btrim\(u\.court_id\)[\s\S]*?'court-name:' \|\| lower\([\s\S]*?regexp_replace\(btrim\(u\.court_name\), '\\s\+', ' ', 'g'\)[\s\S]*?else 'court-unknown'/i,
    'stable court IDs must win, with deterministic name and unknown fallbacks',
  );
  assert.match(
    courtBreakdownDashboardSql,
    /court_booking_totals as\s*\([\s\S]*?count\(distinct u\.reservation_key\)::integer as reservation_count[\s\S]*?sum\(u\.fee_units\) filter \(where u\.fee_type = 'per_hour'\)[\s\S]*?sum\(u\.fee_amount\)[\s\S]*?group by u\.court_key, u\.court_key_source/i,
  );
  assert.match(
    courtBreakdownDashboardSql,
    /court_rate_rows as\s*\([\s\S]*?group by u\.court_key, u\.fee_type, u\.fee_rate/i,
    'locked fee types and rates must remain nested inside each court',
  );
  for (const responseKey of [
    'court_key',
    'court_key_source',
    'court_id',
    'court_name',
    'booking_rows_count',
    'reservation_count',
    'billable_hours',
    'court_hours',
    'flat_fee_booking_count',
    'gross_booking_fee_amount',
    'adjustment_count',
    'adjustment_amount',
    'net_contribution',
    'fee_breakdown',
    'rate_type_breakdown',
  ]) {
    assert.match(
      courtBreakdownDashboardSql,
      new RegExp(`'${responseKey}'`),
      `court breakdown must expose ${responseKey}`,
    );
  }
  assert.match(
    courtBreakdownDashboardSql,
    /'accumulated', jsonb_build_object\([\s\S]*?'court_breakdown', accumulated_court_breakdown[\s\S]*?'court_breakdown_meta', accumulated_court_breakdown_meta/i,
  );
  assert.match(courtBreakdownDashboardSql, /'reservation_count_additive', false/i);
  assert.match(courtBreakdownDashboardSql, /'reservation_count_scope', 'distinct_within_each_court'/i);
  assert.ok(
    (courtBreakdownDashboardSql.match(/from unclaimed u/gi) || []).length >= 3,
    'global, per-court, and nested-rate metrics must reuse the materialized booking rows',
  );
  assert.doesNotMatch(courtBreakdownDashboardSql, /from public\.(?:bookings|settings)\b/i);
});

test('court adjustment attribution is exact-only and every response total is reconcilable', () => {
  assert.match(
    courtBreakdownDashboardSql,
    /with current_adjustments as materialized\s*\([\s\S]*?booking_fee_unclaimed_adjustments\(\)[\s\S]*?\),\s*source_matches as/i,
  );
  assert.equal(
    (courtBreakdownDashboardSql.match(/booking_fee_unclaimed_adjustments\(\)/gi) || []).length,
    1,
    'top-level and per-court adjustment totals must share one materialized set',
  );
  assert.match(
    courtBreakdownDashboardSql,
    /left join public\.booking_fee_remittance_items i[\s\S]*?i\.remittance_id = a\.source_remittance_id[\s\S]*?i\.booking_ref = a\.booking_ref/i,
  );
  assert.match(
    courtBreakdownDashboardSql,
    /count\(i\.id\)::integer as source_match_count[\s\S]*?where s\.source_match_count = 1/i,
    'LEFT JOIN misses and ambiguous source rows must never be treated as exact matches',
  );
  assert.match(courtBreakdownDashboardSql, /where s\.source_match_count <> 1/i);
  assert.match(
    courtBreakdownDashboardSql,
    /from booking_courts b\s+full join adjustment_court_totals a/i,
    'an exactly-attributed adjustment-only court must not disappear',
  );
  assert.match(
    courtBreakdownDashboardSql,
    /'adjustment_attribution', jsonb_build_object\([\s\S]*?'basis', 'exact_immutable_source_remittance_item'[\s\S]*?'coverage'[\s\S]*?'unattributed_count'[\s\S]*?'unattributed_amount'/i,
  );
  assert.match(
    courtBreakdownDashboardSql,
    /from jsonb_to_recordset\(accumulated_court_breakdown\)[\s\S]*?'reconciliation', jsonb_build_object\([\s\S]*?'booking_rows_match'[\s\S]*?'billable_hours_match'[\s\S]*?'gross_booking_fee_amount_match'[\s\S]*?'adjustment_amount_match'[\s\S]*?'net_amount_match'/i,
  );
  assert.match(
    courtBreakdownDashboardSql,
    /'adjustment_amount_match',[\s\S]*?unattributed_adjustment_count = 0[\s\S]*?court_adjustment_amount_total = adjustment_amount/i,
  );
  assert.match(
    courtBreakdownDashboardSql,
    /'net_amount_match',[\s\S]*?unattributed_adjustment_count = 0[\s\S]*?court_net_contribution_total = net_accumulated/i,
  );
  assert.match(courtBreakdownDashboardSql, /'flat_fee_booking_count_match'/i);
  assert.match(
    courtBreakdownDashboardSql,
    /net_accumulated := round\(gross_booking_amount \+ adjustment_amount, 2\)/i,
  );
  assert.match(
    courtBreakdownDashboardSql,
    /from public\.booking_fee_remittances r\s+where r\.status not in \('settled', 'cancelled'\)/i,
  );
  assert.match(
    courtBreakdownDashboardSql,
    /sum\(r\.amount_settled\)[\s\S]*?where r\.status <> 'cancelled'/i,
  );
  assert.match(
    courtBreakdownDashboardSql,
    /'can_prepare', local_date >= next_due and net_accumulated > 0/i,
  );
  assert.match(
    courtBreakdownDashboardSql,
    /'total_outstanding_balance', round\(open_remaining \+ greatest\(net_accumulated, 0\), 2\)/i,
  );
  assert.match(courtBreakdownDashboardSql, /'amount', greatest\(net_accumulated, 0\)/i);
  assert.match(courtBreakdownDashboardSql, /'credit_carryforward', greatest\(-net_accumulated, 0\)/i);
});

test('the additive dashboard migration preserves existing fields and RPC access control', () => {
  for (const responseKey of [
    'server_now',
    'timezone',
    'role',
    'next_due_on',
    'can_prepare',
    'can_owner_override',
    'bookings_count',
    'booking_rows_count',
    'reservation_count',
    'billable_hours',
    'court_hours',
    'flat_fee_booking_count',
    'fee_breakdown',
    'rate_type_breakdown',
    'gross_booking_fee_amount',
    'adjustment_count',
    'adjustment_amount',
    'net_amount',
    'credit_carryforward',
    'amount',
    'coverage_start_at',
    'open_remaining_balance',
    'total_outstanding_balance',
    'accepted_total',
    'settled_total',
    'open_remittances',
    'last_settled',
  ]) {
    assert.match(
      courtBreakdownDashboardSql,
      new RegExp(`'${responseKey}'`),
      `existing dashboard field ${responseKey} must remain present`,
    );
  }
  assert.match(
    courtBreakdownDashboardSql,
    /account_role not in \('owner', 'court_owner'\)[\s\S]*?errcode = '42501'/i,
  );
  assert.match(
    courtBreakdownMigrationSource,
    /revoke all on function public\.get_booking_fee_remittance_dashboard\(\)[\s\S]*?from public, anon, authenticated/i,
  );
  assert.match(
    courtBreakdownMigrationSource,
    /grant execute on function public\.get_booking_fee_remittance_dashboard\(\)[\s\S]*?to authenticated/i,
  );
  assert.doesNotMatch(
    courtBreakdownMigrationSource,
    /grant execute on function public\.get_booking_fee_remittance_dashboard\(\)[\s\S]*?to (?:anon|public)/i,
  );
  assert.doesNotMatch(
    courtBreakdownMigrationSource,
    /create or replace function public\.booking_fee_remittance_summary_json|\bcreate table\b|\balter table\b|\binsert into\b|\bupdate public\.|\bdelete from\b/i,
    'the additive migration must not mutate ledger tables or redefine frozen-record summaries',
  );
  assert.match(courtBreakdownMigrationSource, /\bbegin;[\s\S]*?notify pgrst, 'reload schema';[\s\S]*?commit;\s*$/i);
});

test('the local adapter mirrors court grouping, aliases, and non-additive reservation totals', async () => {
  const earnedAt = '2026-09-01T01:00:00.000Z';
  const dashboard = await runLocalRemittanceDashboard([
    {
      ref: 'GROUP-AND-BOOKING-REF',
      groupRef: 'GROUP-AND-BOOKING-REF',
      courtId: 'court-1',
      courtName: 'Court 1',
      bookingFeeEarnedAt: earnedAt,
      bookingFeeLedgerEligibleSnapshot: true,
      bookingFeeTypeSnapshot: 'per_hour',
      bookingFeeRateSnapshot: 10,
      bookingFeeUnitsSnapshot: 3,
      bookingFeeAmountSnapshot: 30,
    },
    {
      ref: 'GROUP-ROW-2',
      groupRef: 'GROUP-AND-BOOKING-REF',
      courtName: '  Court   2  ',
      bookingFeeEarnedAt: earnedAt,
      bookingFeeLedgerEligibleSnapshot: true,
      bookingFeeTypeSnapshot: 'per_hour',
      bookingFeeRateSnapshot: 10,
      bookingFeeUnitsSnapshot: 3,
      bookingFeeAmountSnapshot: 30,
    },
    {
      ref: 'GROUP-AND-BOOKING-REF',
      courtId: 'court-1',
      courtName: 'Court 1',
      bookingFeeEarnedAt: earnedAt,
      bookingFeeLedgerEligibleSnapshot: true,
      bookingFeeTypeSnapshot: 'flat',
      bookingFeeRateSnapshot: 10,
      bookingFeeUnitsSnapshot: 1,
      bookingFeeAmountSnapshot: 10,
    },
  ], 'owner');

  const live = dashboard.accumulated;
  assert.equal(dashboard.live, live, 'local aliases must point at one authoritative snapshot');
  assert.equal(dashboard.role, 'owner');
  assert.equal(dashboard.can_owner_override, true);
  assert.equal(live.booking_rows_count, 3);
  assert.equal(live.bookings_count, 3);
  assert.equal(live.reservation_count, 2, 'group: and booking: identities must not collide');
  assert.equal(live.billable_hours, 6);
  assert.equal(live.court_hours, 6);
  assert.equal(live.flat_fee_booking_count, 1);
  assert.equal(live.gross_booking_fee_amount, 70);
  assert.equal(live.net_amount, 70);
  assert.equal(live.amount, 70);
  assert.equal(live.court_breakdown.length, 2);

  const courtOne = live.court_breakdown.find(row => row.court_key === 'court-id:court-1');
  const courtTwo = live.court_breakdown.find(row => row.court_key === 'court-name:court 2');
  assert.ok(courtOne);
  assert.ok(courtTwo);
  assert.equal(courtOne.court_key_source, 'court_id');
  assert.equal(courtTwo.court_key_source, 'court_name_fallback');
  assert.equal(courtOne.booking_rows_count, 2);
  assert.equal(courtOne.reservation_count, 2);
  assert.equal(courtOne.gross_booking_fee_amount, 40);
  assert.equal(courtOne.fee_breakdown.length, 2, 'locked flat and hourly rows stay separate');
  assert.deepEqual(courtOne.rate_type_breakdown, courtOne.fee_breakdown);
  assert.equal(courtTwo.booking_rows_count, 1);
  assert.equal(courtTwo.reservation_count, 1);
  assert.equal(courtTwo.billable_hours, 3);
  assert.equal(
    live.court_breakdown.reduce((sum, row) => sum + row.reservation_count, 0),
    3,
    'per-court reservation counts are intentionally non-additive',
  );

  const metadata = live.court_breakdown_meta;
  assert.equal(metadata.reservation_count_additive, false);
  assert.equal(metadata.reservation_count_scope, 'distinct_within_each_court');
  assert.equal(metadata.adjustment_attribution.coverage, 'not_applicable');
  assert.deepEqual(metadata.court_totals, {
    booking_rows_count: 3,
    billable_hours: 6,
    flat_fee_booking_count: 1,
    gross_booking_fee_amount: 70,
    attributed_adjustment_amount: 0,
    net_contribution: 70,
    court_hours: 6,
  });
  assert.ok(
    Object.values(metadata.reconciliation).every(Boolean),
    'local reconciliation flags must be computed from returned court rows',
  );
});

test('the court breakdown remains an accessible, closed-by-default authoritative disclosure', () => {
  assert.match(
    adminSource,
    /<button[^>]*id="mfCourtBreakdownToggle"[^>]*type="button"[^>]*aria-expanded="false"[^>]*aria-controls="mfCourtBreakdown"[^>]*hidden>/i,
  );
  assert.match(adminSource, /<section[^>]*id="mfCourtBreakdown"[^>]*hidden>/i);
  assert.match(adminSource, /let _platformCourtBreakdownOpen = false;/);
  assert.match(
    adminSource,
    /function paCourtBreakdownRows\(record\)\s*{\s*return paServerRows\(rmPick\(record, 'court_breakdown', 'courtBreakdown'\)\);\s*}/,
    'the disclosure must consume only the secure dashboard rows',
  );
  assert.match(
    adminSource,
    /function setPlatformCourtBreakdown\(open\)[\s\S]*?open && !toggle\.hidden && count > 0[\s\S]*?setAttribute\('aria-expanded', expanded \? 'true' : 'false'\)[\s\S]*?Hide court breakdown[\s\S]*?Show \$\{count}-court breakdown[\s\S]*?disclosure\.hidden = !expanded;/,
  );
  assert.match(adminSource, /\.pa-breakdown-toggle\s*{[\s\S]*?min-height:\s*44px;/);
  assert.match(adminSource, /\.pa-breakdown-summary\s*{[^}]*font:\s*750 \.68rem\/1\.3/);
  assert.match(adminSource, /\.pa-breakdown-formula\s*{[^}]*font:\s*750 \.68rem\/1\.45/);
  assert.match(adminSource, /\.pa-breakdown-total-meta\s*{[^}]*font-size:\s*\.65rem;/);
  assert.match(adminSource, /\.pa-breakdown-definition\s*{[^}]*font-size:\s*\.65rem;/);
  assert.match(
    adminSource,
    /@media \(max-width: 700px\)[\s\S]*?\.pa-breakdown-head\s*{[^}]*flex-direction:\s*column;[\s\S]*?\.pa-breakdown-table thead\s*{[^}]*position:\s*absolute;[\s\S]*?\.pa-breakdown-table tbody tr,[\s\S]*?\.pa-breakdown-table tfoot tr\s*{[^}]*display:\s*grid;/,
    'the narrow layout must stack its heading and retain readable row structure',
  );
  assert.match(adminSource, /serverName \|\| \(courtId \? `Court \$\{courtId}` : 'Court not recorded'\)/);

  const refreshStart = adminSource.indexOf('async function renderMaintFee(');
  const refreshEnd = adminSource.indexOf('let _chartBookings', refreshStart);
  const refreshSource = adminSource.slice(refreshStart, refreshEnd);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.ok(
    refreshSource.indexOf('setPlatformCourtBreakdown(false);')
      < refreshSource.indexOf('await DB.getBookingFeeRemittanceDashboard()'),
    'refresh must collapse the supplementary disclosure before awaiting new data',
  );
  assert.match(
    refreshSource,
    /catch \(error\)[\s\S]*?renderPlatformCourtBreakdown\(\{\}, 0\);/,
    'a failed refresh must clear stale rows and hide the toggle',
  );
  assert.match(
    refreshSource,
    /const liveNetAmount = rmNetAllocationAmount\(live, liveBreakdown\);\s*renderPlatformCourtBreakdown\(live, liveNetAmount, liveAmount\);/,
    'the breakdown must reconcile against signed net rather than clamped payable amount',
  );

  const renderStart = adminSource.indexOf('function renderPlatformCourtBreakdown(');
  const renderEnd = adminSource.indexOf('async function renderMaintFee(', renderStart);
  const renderSource = adminSource.slice(renderStart, renderEnd);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.match(renderSource, /const ledgerNetTotal = rmNumber\(authoritativeNetTotal\);/);
  for (const reconciliationFlag of [
    'booking_rows_match',
    'billable_hours_match',
    'flat_fee_booking_count_match',
    'gross_booking_fee_amount_match',
    'adjustment_amount_match',
    'net_amount_match',
  ]) {
    assert.match(
      renderSource,
      new RegExp(`['"]${reconciliationFlag}['"]`),
      `the disclosure must honor server reconciliation flag ${reconciliationFlag}`,
    );
  }
  assert.match(renderSource, /const attributedHours = rows\.reduce\(\(sum, row\) => sum \+ row\.hours, 0\);/);
  assert.match(
    renderSource,
    /const hoursReconciled = authoritativeHours === null \|\| Math\.abs\(attributedHours - authoritativeHours\) < \.01;/,
  );
  assert.match(renderSource, /&& hoursReconciled[\s\S]*?&& serverMetricsMatch[\s\S]*?&& attributionComplete;/);
  assert.match(renderSource, /attributionCoverage !== 'partial'/);
  assert.match(renderSource, /total\.textContent = paDisplayMoney\(ledgerNetTotal\);/);
  assert.match(
    renderSource,
    /\$\{fmt\(payableTotal\)\} payable · \$\{fmt\(creditCarry\)\} credit carried forward/,
    'negative net must display zero payable with its carried-forward credit',
  );
  assert.doesNotMatch(
    renderSource,
    /row\.reservations/,
    'per-court reservation counts must not be presented as additive row metadata',
  );
  assert.doesNotMatch(renderSource, /DB\.getBookings|readDb\(\)|window\.DB\.getBookings/);
});
