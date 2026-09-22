// Runs exclusively in a rollback transaction; no bookings, campaigns or fees persist.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { Client } = require('pg');
process.loadEnvFile('.env.local');
const url = new URL(fs.readFileSync('supabase/.temp/pooler-url', 'utf8').trim());
url.password = process.env.SUPABASE_DB_PASSWORD;
const db = new Client({ connectionString: url.href, ssl: { rejectUnauthorized: false } });
async function fail(sql, args, pattern) {
  await db.query('savepoint expected_failure');
  let caught;
  try { await db.query(sql, args); } catch (e) { caught = e; }
  await db.query('rollback to savepoint expected_failure');
  assert.ok(caught, 'Expected rejection');
  assert.match(caught.message, pattern);
}
(async () => {
  await db.connect();
  try {
    await db.query('begin');
    await db.query("set local lock_timeout='5s'");
    if (!process.argv.includes('--deployed')) {
      const sql = fs.readFileSync('supabase/migrations/20260922020000_premium_vouchers.sql', 'utf8').replace(/^begin;\s*/, '').replace(/commit;\s*$/, '');
      await db.query(sql);
      await db.query(fs.readFileSync('supabase/migrations/20260922021000_voucher_campaign_list.sql', 'utf8').replace(/^begin;\s*/, '').replace(/commit;\s*$/, ''));
      await db.query(fs.readFileSync('supabase/migrations/20260922022000_voucher_dashboard_booking_access.sql', 'utf8').replace(/^begin;\s*/, '').replace(/commit;\s*$/, ''));
    }
    await db.query("select set_config('request.jwt.claim.role','service_role',true)");
    await db.query("update public.settings set value='1' where key='vouchers_enabled'");
    const owner = (await db.query("select id from public.accounts where role='owner' and status='active' limit 1")).rows[0].id;
    const ownerList = (await db.query("select public.voucher_admin($1,'list','{}') v", [owner])).rows[0].v;
    assert.ok(Array.isArray(ownerList.campaigns));
    const court = 'VOUCHER-ROLLBACK-TEST';
    await db.query("insert into public.courts(id,name,rate,blocked,rate_schedule) values($1,'Voucher rollback court',1200,false,'[{\"from\":0,\"to\":24,\"rate\":1200}]')", [court]);
    const date = (await db.query("select (current_date+100)::text d")).rows[0].d;
    const token = 'a'.repeat(64);
    const contact = { name: 'Voucher Test', email: 'voucher@example.invalid', phone: '09123456789' };
    const hold = async (ref, slots, group = null) => db.query('select * from public.submit_public_booking_holds($1,$2)', [JSON.stringify([{ ref, booking_group_ref: group, full_name: 'Reserving…', email: 'reserve@hold.internal', court_id: court, date, slots, payment_method: 'cash' }]), token]);
    const campaign = async (code, kind, value, extra = {}) => {
      const data = { name: 'Rollback test', kind, value, startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', maxUses: 10, courtIds: [court], bookingTypes: ['guest','host'], weekdays: [0,1,2,3,4,5,6], code, acceptOwnerFees: true, ...extra };
      return (await db.query("select public.voucher_admin($1,'create',$2) v", [owner, data])).rows[0].v;
    };
    const checkout = async (action, ref, code, identity = contact) => (await db.query('select public.voucher_checkout($1,$2,$3,$4,null,$5) v', [action, ref, code, token, identity])).rows[0].v;
    await hold('VOUCHER-OPERATOR-HOLD', ['5']);
    await db.query("update public.bookings set customer_access_token_hash=null where ref='VOUCHER-OPERATOR-HOLD'");
    if(process.argv.includes('--verify-access-fix')) {
      await fail("select public.voucher_checkout('status','VOUCHER-OPERATOR-HOLD',null,null,$1,'{}')", [owner], /access denied/);
      console.log('REPRODUCED: signed-in owner normal court checkout rejected by voucher status check.');
      await db.query(fs.readFileSync('supabase/migrations/20260922022000_voucher_dashboard_booking_access.sql', 'utf8').replace(/^begin;\s*/, '').replace(/commit;\s*$/, ''));
    }
    const operatorQuote=(await db.query("select public.voucher_checkout('status','VOUCHER-OPERATOR-HOLD',null,null,$1,'{}') v",[owner])).rows[0].v;
    assert.equal(operatorQuote.total,1200);
    assert.equal(operatorQuote.code,null);
    await fail("select public.voucher_checkout('status','VOUCHER-OPERATOR-HOLD',null,null,null,'{}')",[],/access denied/);
    await fail("select public.voucher_checkout('status','VOUCHER-OPERATOR-HOLD',null,null,'00000000-0000-0000-0000-000000000001','{}')",[],/access denied/);
    await campaign('TEST-FREE', 'percent', 100, { maxUses: 1 });
    await hold('VOUCHER-TEST-A', ['6']);
    let q = await checkout('apply', 'VOUCHER-TEST-A', 'TEST-FREE');
    assert.equal(q.total, 0); assert.equal(q.discount, 1200);
    assert.deepEqual(await checkout('apply', 'VOUCHER-TEST-A', 'TEST-FREE'), q, 'Retry is idempotent');
    await fail("select public.voucher_checkout('apply','VOUCHER-TEST-A','TEST-FREE',$1,null,$2)", ['b'.repeat(64),contact], /access denied/);
    await fail("select public.voucher_checkout('status','VOUCHER-TEST-A',null,null,$1,'{}')", [owner], /access denied/);
    q = await checkout('confirm', 'VOUCHER-TEST-A');
    assert.equal(q.complimentary, true);
    const row = (await db.query("select * from public.bookings where ref='VOUCHER-TEST-A'")).rows[0];
    assert.equal(row.status, 'confirmed'); assert.equal(row.payment_status, 'complimentary'); assert.equal(row.paid_at, null);
    assert.ok(row.booking_fee_earned_at);
    const fee = Number(row.booking_fee_amount_snapshot);
    assert.equal(Number((await db.query("select fee_amount from public.booking_fee_unclaimed_rows() where booking_ref='VOUCHER-TEST-A'")).rows[0].fee_amount),fee);
    await checkout('confirm', 'VOUCHER-TEST-A');
    assert.equal((await db.query("select count(*)::int n from public.voucher_redemptions where booking_key='VOUCHER-TEST-A' and state='consumed'")).rows[0].n, 1);
    await db.query("update public.bookings set status='cancelled' where ref='VOUCHER-TEST-A'");
    assert.equal((await db.query("select state from public.voucher_redemptions where booking_key='VOUCHER-TEST-A'")).rows[0].state, 'consumed');
    await hold('VOUCHER-TEST-B', ['7']);
    await fail("select public.voucher_checkout('apply','VOUCHER-TEST-B','TEST-FREE',$1,null,$2)", [token,contact], /limit reached/);
    await campaign('TEST-TEN', 'percent', 10);
    q=await checkout('preview','VOUCHER-TEST-B','TEST-TEN'); assert.equal(q.total,1080);
    q=await checkout('apply','VOUCHER-TEST-B','TEST-TEN'); assert.equal(q.total,1080);
    await fail("update public.bookings set total=1 where ref='VOUCHER-TEST-B'", [], /snapshot mismatch/);
    q=await checkout('remove','VOUCHER-TEST-B'); assert.equal(q.total,1200);
    await campaign('TEST-FIXED','fixed',100.01);
    await hold('VOUCHER-TEST-C',['8'],'VOUCHER-TEST-G'); await hold('VOUCHER-TEST-D',['9'],'VOUCHER-TEST-G');
    q=await checkout('apply','VOUCHER-TEST-C','TEST-FIXED');
    assert.equal(q.discount,100.01); assert.equal(q.total,2299.99); assert.equal(q.items[0].discount,50.01); assert.equal(q.items[1].discount,50);
    await db.query("update public.bookings set receipt_image_url='https://example.invalid/private-receipt' where ref='VOUCHER-TEST-C'");
    await fail("select public.voucher_checkout('remove','VOUCHER-TEST-C',null,$1,null,'{}')", [token], /locked/);
    await db.query("select set_config('paddle_rage.voucher_write','off',true)");
    await fail("update public.bookings set voucher_discount=0 where ref='VOUCHER-TEST-D'", [], /server managed/);
    await fail("select public.voucher_admin(null,'list','{}')", [], /Owner access/);
    // Host creation follows the actual authenticated canonicalizer.
    const host = (await db.query("select id from public.accounts where role='host' and status='active' limit 1")).rows[0]?.id;
    assert.ok(host, 'An active host is required for integration coverage');
    await db.query("select set_config('paddle_rage.public_booking_submission','off',true),set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)",[host]);
    await db.query("insert into public.bookings(ref,court_id,date,slots,full_name,email,contact_number,status,payment_status,payment_method,created_at,downpayment) values('VOUCHER-TEST-HOST',$1,$2,array['10'],'Reserving…','reserve@hold.internal','00000000000','verifying','unpaid','cash',now(),null)",[court,date]);
    await db.query("select set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claim.sub','',true)");
    q=(await db.query("select public.voucher_checkout('apply','VOUCHER-TEST-HOST','TEST-TEN',null,$1,$2) v",[host,contact])).rows[0].v;
    assert.equal(q.total,1080);
    assert.equal(q.items[0].due,Math.round((Math.max(0,1080-fee)*.25+Math.min(1080,fee))*100)/100);
    await fail("select public.voucher_checkout('status','VOUCHER-TEST-HOST',null,null,$1,'{}')",[owner],/access denied/);
    const paused=await campaign('TEST-PAUSE','percent',100);
    await hold('VOUCHER-TEST-PAUSE',['11']);
    await checkout('apply','VOUCHER-TEST-PAUSE','TEST-PAUSE');
    await db.query("select public.voucher_admin($1,'state',$2)",[owner,{id:paused.id,state:'paused'}]);
    await checkout('confirm','VOUCHER-TEST-PAUSE');
    await hold('VOUCHER-TEST-NEW',['12']);
    await fail("select public.voucher_checkout('apply','VOUCHER-TEST-NEW','TEST-PAUSE',$1,null,$2)",[token,contact],/unavailable/);
    await campaign('TEST-RESTRICT','percent',20,{hourFrom:12,hourTo:14,customerLimit:1,maxDiscount:100});
    q=await checkout('apply','VOUCHER-TEST-NEW','TEST-RESTRICT');assert.equal(q.discount,100);
    await fail("update public.bookings set slots=array['15'] where ref='VOUCHER-TEST-NEW'",[],/outside the voucher/);
    await hold('VOUCHER-TEST-LIMIT',['13']);
    await fail("select public.voucher_checkout('apply','VOUCHER-TEST-LIMIT','TEST-RESTRICT',$1,null,$2)",[token,contact],/customer limit/);
    await fail("select public.voucher_checkout('apply','VOUCHER-TEST-LIMIT','TEST-RESTRICT',$1,null,$2)",[token,{...contact,email:'other@example.invalid'}],/customer limit/);
    await db.query("delete from public.bookings where ref='VOUCHER-TEST-NEW'");
    assert.equal((await db.query("select state from public.voucher_redemptions where booking_key='VOUCHER-TEST-NEW'")).rows[0].state,'released');
    q=await checkout('apply','VOUCHER-TEST-LIMIT','TEST-RESTRICT');assert.equal(q.discount,100);
    const courtOwner=(await db.query("select id from public.accounts where role='court_owner' and status='active' limit 1")).rows[0]?.id;
    if(courtOwner){
      const denied={name:'Denied',kind:'percent',value:100,startsAt:'2020-01-01T00:00:00Z',endsAt:'2099-01-01T00:00:00Z',maxUses:1,courtIds:[court],bookingTypes:['guest'],weekdays:[0,1,2,3,4,5,6],acceptOwnerFees:true};
      await fail("select public.voucher_admin($1,'create',$2)",[courtOwner,denied],/assigned courts/);
      await db.query("select public.voucher_admin($1,'assign',$2)",[owner,{userId:courtOwner,courtIds:[court]}]);
      const assigned=(await db.query("select public.voucher_admin($1,'create',$2) v",[courtOwner,denied])).rows[0].v;
      const scopedList=(await db.query("select public.voucher_admin($1,'list','{}') v",[courtOwner])).rows[0].v;
      assert.ok(scopedList.campaigns.some(c=>c.id===assigned.id));
      assert.ok(scopedList.courts.every(c=>c.id===court));
      assert.equal(assigned.codes.length,1);
    }
    await db.query("select public.voucher_checkout('remove','VOUCHER-TEST-HOST',null,null,$1,'{}')",[host]);
    await campaign('TEST-HOSTFREE','percent',100);
    await db.query("select public.voucher_checkout('apply','VOUCHER-TEST-HOST','TEST-HOSTFREE',null,$1,$2)",[host,contact]);
    q=(await db.query("select public.voucher_checkout('confirm','VOUCHER-TEST-HOST',null,null,$1,'{}') v",[host])).rows[0].v;
    assert.equal(q.complimentary,true);
    const concurrent = new Client({connectionString:url.href,ssl:{rejectUnauthorized:false}});
    await concurrent.connect();
    try {
      const lock=await concurrent.query("select pg_try_advisory_xact_lock(hashtextextended('paddle-rage-vouchers',0)) acquired");
      assert.equal(lock.rows[0].acquired,false,'Concurrent voucher requests serialize before checking quotas');
    } finally { await concurrent.end(); }
    await db.query("select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)",[owner]);
    await db.query("select public.prepare_booking_fee_remittance('voucher-rollback-remittance',true,'2099-01-14','Rollback-only voucher test')");
    const line=(await db.query("select fee_amount from public.booking_fee_remittance_items where booking_ref='VOUCHER-TEST-A' and released_at is null")).rows;
    assert.equal(line.length,1);assert.equal(Number(line[0].fee_amount),fee);
    await db.query("select public.prepare_booking_fee_remittance('voucher-rollback-remittance',true,'2099-01-14','Rollback-only voucher test')");
    assert.equal((await db.query("select count(*)::int n from public.booking_fee_remittance_items where booking_ref='VOUCHER-TEST-A' and released_at is null")).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int n from public.booking_fee_unclaimed_rows() where booking_ref='VOUCHER-TEST-A'")).rows[0].n,0);
    console.log('PASS: migration, free confirmation/remittance, retry/access guards, limits, cancellations, preview/remove, group rounding, evidence locks, tamper protection, host deposit/ownership, paused reservations, date/hour restrictions, customer caps, cleanup release, court-owner funding permissions. Rolled back.');
  } finally { await db.query('rollback'); await db.end(); }
})().catch(e => { console.error(e.message, e.where || ''); process.exitCode=1; });
