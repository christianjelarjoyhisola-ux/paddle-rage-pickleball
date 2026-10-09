// Runs the migration and synthetic fixtures in one rolled-back transaction.
// No Telegram calls, cron jobs, booking mutations, or committed data changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Client } = require('pg');
process.loadEnvFile('.env.local');
const url = new URL(fs.readFileSync('supabase/.temp/pooler-url', 'utf8').trim());
url.password = process.env.SUPABASE_DB_PASSWORD;
const db = new Client({ connectionString: url.href, ssl: { rejectUnauthorized: false } });
const migration = fs.readFileSync('supabase/migrations/20261009160000_payment_review_reminders.sql', 'utf8')
  .replace(/public\.(payment_review_reminder\w*|due_payment_review_reminders|claim_payment_review_reminder|finish_payment_review_reminder)/g, 'review_reminder_test.$1');
(async () => {
  await db.connect();
  try {
    await db.query('begin');
    await db.query('create schema review_reminder_test');
    await db.query(migration.replace(/^begin;|commit;\s*$/g, ''));
    let view = migration.slice(migration.indexOf('create or replace view'), migration.indexOf('revoke all on review_reminder_test.payment_review_reminder_candidates'));
    for (const table of ['bookings', 'receipt_verifications', 'host_booking_balance_payments', 'open_play_registrations', 'open_play_host_session_registrations']) {
      await db.query(`create table review_reminder_test.${table} as select * from public.${table} with no data`);
      view = view.replaceAll(`public.${table}`, `review_reminder_test.${table}`);
    }
    await db.query(view);
    await db.query(`insert into review_reminder_test.bookings
      (ref,booking_group_ref,payment_method,payment_status,status,receipt_image_url,created_at,total)
      values ('test-a','test-group','gcash','for_verification','pending','receipt',now()-interval '2 hours',400),
      ('test-b','test-group','gcash','for_verification','pending','receipt',now()-interval '2 hours',400),
      ('test-paid',null,'gcash','paid','confirmed','receipt',now()-interval '2 hours',400),
      ('test-deposit',null,'gcash','downpayment_paid','confirmed','receipt',now()-interval '2 hours',400),
      ('test-rejected',null,'gcash','rejected','cancelled','receipt',now()-interval '2 hours',400),
      ('test-hold',null,'gcash','unpaid','pending',null,now()-interval '2 hours',400),
      ('test-new',null,'gcash','for_verification','pending','receipt',now()-interval '59 minutes',400)`);
    await db.query(`insert into review_reminder_test.host_booking_balance_payments (id,booking_key,status,expected_amount,submitted_at)
      values ('00000000-0000-4000-8000-000000000001','balance-test','pending_review',877.5,now()-interval '1 hour')`);
    for (const [table, id] of [['open_play_registrations', '1'], ['open_play_host_session_registrations', "'00000000-0000-4000-8000-000000000002'"]]) {
      await db.query(`insert into review_reminder_test.${table} (id,payment_method,payment_status,gcash_ref,amount,created_at)
        values (${id},'gcash','pending','test-reference',100,now()-interval '2 hours')`);
    }
    const recipient = 'a'.repeat(64);
    const due = () => db.query('select * from review_reminder_test.due_payment_review_reminders($1)', [recipient]);
    const rows = (await due()).rows;
    assert.equal(rows.length, 4, 'one eligible payment per type, grouped bookings counted once');
    assert.equal(Number(rows.find(r => r.kind === 'booking').amount), 800);
    const claim = () => db.query('select review_reminder_test.claim_payment_review_reminder($1,$2,$3) as token', ['booking', 'test-group', recipient]);
    const token = (await claim()).rows[0].token;
    assert.ok(token);
    assert.equal((await claim()).rows[0].token, null, 'overlapping workers cannot acquire the same claim');
    assert.equal((await due()).rows.length, 3);
    const finish = await db.query('select review_reminder_test.finish_payment_review_reminder($1,$2,$3,$4,true) as ok', ['booking', 'test-group', recipient, token]);
    assert.equal(finish.rows[0].ok, true);
    assert.equal((await claim()).rows[0].token, null, 'successful delivery waits another hour');
    await db.query("update review_reminder_test.payment_review_reminder_deliveries set next_attempt_at=now()-interval '1 second'");
    assert.ok((await claim()).rows[0].token, 'still-pending payments repeat after cooldown');
    await db.query("update review_reminder_test.bookings set payment_status='paid' where booking_group_ref='test-group'");
    await db.query("update review_reminder_test.payment_review_reminder_deliveries set next_attempt_at=now()-interval '1 second'");
    assert.equal((await claim()).rows[0].token, null, 'approval stops reminders');
    await db.query("update review_reminder_test.host_booking_balance_payments set status='rejected'");
    assert.equal((await due()).rows.length, 2, 'rejection stops balance reminders');
    const permissions = await db.query(`select
      has_function_privilege('anon','review_reminder_test.claim_payment_review_reminder(text,text,text)','execute') as anon,
      has_function_privilege('authenticated','review_reminder_test.claim_payment_review_reminder(text,text,text)','execute') as authenticated`);
    assert.deepEqual(permissions.rows[0], { anon: false, authenticated: false });
    console.log('Passed: four payment types, grouping, one-hour threshold, duplicate claims, hourly repeats, approval/rejection stop, restricted access.');
  } finally { await db.query('rollback'); await db.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });


