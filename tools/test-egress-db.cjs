// Read-only assertions in a rolled-back migration transaction; no notification calls.
const fs=require('fs'),assert=require('node:assert/strict'),{Client}=require('pg');
process.loadEnvFile('.env.local');
const url=new URL(fs.readFileSync('supabase/.temp/pooler-url','utf8').trim());url.password=process.env.SUPABASE_DB_PASSWORD;
const db=new Client({connectionString:url.href,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,statement_timeout:20000});
const sql=fs.readFileSync('supabase/migrations/20261016120000_reduce_egress_and_idle_notifications.sql','utf8').replace(/^begin;\s*/,'').replace(/commit;\s*$/,'');
(async()=>{await db.connect();try{
  await db.query('begin');await db.query(sql);
  const owner=(await db.query("select id from accounts where role='owner' and status='active' limit 1")).rows[0];
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner.id,role:'authenticated'})]);
  await db.query('set local role authenticated');
  const data=(await db.query(`select (select count(*) from bookings) full_count,(select count(*) from booking_list_rows) list_count,
    (select sum(octet_length(row_to_json(b)::text)) from bookings b) full_bytes,
    (select sum(octet_length(row_to_json(b)::text)) from booking_list_rows b) list_bytes,
    exists(select 1 from booking_list_rows v join bookings b using(ref) where v.receipt_extracted->'parserVersion' is distinct from b.receipt_extracted->'parserVersion') mismatched`)).rows[0];
  assert.equal(data.full_count,data.list_count);assert.equal(data.mismatched,false);
  assert.ok(Number(data.list_bytes)<Number(data.full_bytes)*0.6);
  await db.query('reset role');
  assert.equal((await db.query("select has_table_privilege('anon','public.booking_list_rows','select') allowed")).rows[0].allowed,false);
  const options=(await db.query("select reloptions from pg_class where oid='public.booking_list_rows'::regclass")).rows[0].reloptions;
  assert.ok(options.includes('security_invoker=true'));
  const jobs=(await db.query("select jobname,schedule,command from cron.job where jobname in ('review-notification-channels','payment-review-reminders')")).rows;
  assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.command.includes('where exists')));
  assert.equal(jobs.find(j=>j.jobname==='review-notification-channels').schedule,'* * * * *');
  console.log('PASS: RLS-preserving list, receipt badge parity, anonymous denial, gated cron, unchanged cadence.',JSON.stringify(data));
}finally{await db.query('rollback');await db.end();}})().catch(e=>{console.error(e.message);process.exitCode=1});
