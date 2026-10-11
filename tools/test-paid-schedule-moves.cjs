// Executes schema changes and synthetic fixtures in ONE rolled-back transaction.
// Never sends email or changes an existing customer reservation.
const fs=require('fs'),assert=require('node:assert/strict'),{Client}=require('pg');
process.loadEnvFile('.env.local');
const u=new URL(fs.readFileSync('supabase/.temp/pooler-url','utf8').trim());u.password=process.env.SUPABASE_DB_PASSWORD;
const db=new Client({connectionString:u.href,ssl:{rejectUnauthorized:false}});
const migration=fs.readFileSync('supabase/migrations/20261012090000_paid_booking_slot_moves.sql','utf8').replace(/^begin;\s*$/m,'').replace(/commit;\s*$/,'');
(async()=>{
 await db.connect();try{
 await db.query('begin');await db.query("set local lock_timeout='5s'; set local statement_timeout='30s'");
 if(!(await db.query("select to_regprocedure('public.move_paid_booking_slots(text,jsonb,text)') installed")).rows[0].installed) await db.query(migration);
 const owner=(await db.query("select id from public.accounts where role='owner' and status='active' limit 1")).rows[0].id;
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated'})]);
 await db.query("insert into public.courts(id,name,rate) values ('test-move-c1','Test move 1',350),('test-move-c2','Test move 2',350),('test-move-c3','Test move 3',350)");
 const date=(await db.query("select (timezone('Asia/Manila',now())::date+90)::text as day")).rows[0].day;
 await db.query(`insert into public.bookings(ref,full_name,email,court_id,court_name,date,slots,start_time,end_time,duration,rate,total,downpayment,payment_method,payment_status,status,receipt_image_url,customer_access_token_hash)
 values ('TEST-PAID-MOVE','Schedule test','schedule-test@example.invalid','test-move-c1','Test move 1',$1,array['10','11'],'10:00 AM','12:00 PM',2,350,700,700,'cash','paid','confirmed','test-receipt',repeat('a',64))`,[date]);
 const options=()=>db.query('select public.get_paid_schedule_options($1,$2) data',['TEST-PAID-MOVE',date]).then(r=>r.rows[0].data);
 let data=await options();assert.equal(data.items.length,1);
 const original=data.items[0];
 const change=slots=>[{bookingRef:original.bookingRef,expectedCourtId:original.courtId,expectedDate:original.date,expectedSlots:original.slots,expectedTotal:Number(original.total),slots}];
 const call=c=>db.query('select public.move_paid_booking_slots($1,$2,$3) data',['TEST-PAID-MOVE',JSON.stringify(c),'Synthetic rollback test']).then(r=>r.rows[0].data);
 const rejected=async(c,pattern)=>{await db.query('savepoint failure');try{await call(c);assert.fail('Expected rejection');}catch(e){assert.match(e.message,pattern);}finally{await db.query('rollback to savepoint failure');}};
 const slot=(courtId,hour)=>({courtId,date,hour});
 await rejected(change([slot('test-move-c3',10)]),/paid court-hours/);
 await rejected(change([slot('test-move-c3',10),slot('test-move-c3',10)]),/more than once/);
 await rejected([{...change([slot('test-move-c3',10),slot('test-move-c3',11)])[0],expectedDate:'2026-01-01'}],/original schedule changed/);
 await db.query(`insert into public.bookings(ref,full_name,court_id,date,slots,duration,total,downpayment,payment_method,payment_status,status)
 values ('TEST-MOVE-CONFLICT','Schedule blocker','test-move-c3',$1,array['12'],1,350,350,'cash','paid','confirmed')`,[date]);
 await rejected(change([slot('test-move-c2',10),slot('test-move-c3',12)]),/no longer available/);
 assert.deepEqual((await options()).items,data.items,'failed moves leave original unchanged');
 const beforeFee=(await db.query("select booking_fee_amount_snapshot fee,booking_fee_earned_at earned from public.bookings where ref='TEST-PAID-MOVE'")).rows[0];
 const result=await call(change([slot('test-move-c2',10),slot('test-move-c3',11)]));
 assert.equal(result.items.length,2);assert.equal(result.items.reduce((n,i)=>n+Number(i.duration),0),2);
 assert.equal(result.items.reduce((n,i)=>n+Number(i.total),0),700);assert.equal(result.items.reduce((n,i)=>n+Number(i.downpayment),0),700);
 const rows=(await db.query("select * from public.bookings where booking_group_ref='TEST-PAID-MOVE' order by ref")).rows;
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.payment_status==='paid'&&r.status==='confirmed'&&r.receipt_image_url==='test-receipt'&&r.customer_access_token_hash==='a'.repeat(64)));
 assert.equal(rows.reduce((n,r)=>n+Number(r.booking_fee_amount_snapshot),0),Number(beforeFee.fee));
 assert.equal(rows.filter(r=>r.booking_fee_ledger_eligible_snapshot).length,1);
 assert.ok(rows.every(r=>r.schedule_payment_root_ref==='TEST-PAID-MOVE'));
 assert.equal((await db.query('select writing from public.booking_schedule_moves where id=$1',[result.moveId])).rows[0].writing,false);
 data=await options();assert.equal(data.items.length,2,'split booking remains one retrievable reservation');
 const next=data.items.map(i=>({bookingRef:i.bookingRef,expectedDate:i.date,expectedCourtId:i.courtId,expectedSlots:i.slots,expectedTotal:Number(i.total),slots:[slot(i.courtId,Number(i.slots[0])+4)]}));
 assert.equal((await call(next)).items.length,2,'split portions can be moved again');
 // A single court transfer preserves the original booking reference.
 await db.query(`insert into public.bookings(ref,full_name,email,court_id,court_name,date,slots,start_time,end_time,duration,rate,total,downpayment,payment_method,payment_status,status,gcash_ref)
 values ('TEST-GCASH-MOVE','Schedule test','schedule-test@example.invalid','test-move-c1','Test move 1',$1,array['8','9'],'8:00 AM','10:00 AM',2,350,700.01,700.01,'gcash','paid','confirmed','9912345678901')`,[date]);
 const moveG=async slots=>{
 const d=(await db.query('select public.get_paid_schedule_options($1,$2) data',['TEST-GCASH-MOVE',date])).rows[0].data;
 const cs=d.items.map(i=>({bookingRef:i.bookingRef,expectedDate:i.date,expectedCourtId:i.courtId,expectedSlots:i.slots,expectedTotal:Number(i.total),slots:slots[i.bookingRef]}));
 return (await db.query('select public.move_paid_booking_slots($1,$2) data',['TEST-GCASH-MOVE',JSON.stringify(cs)])).rows[0].data;
 };
 const transfer=await moveG({'TEST-GCASH-MOVE':[slot('test-move-c3',8),slot('test-move-c3',9)]});
 assert.equal(transfer.items.length,1);assert.equal(transfer.items[0].bookingRef,'TEST-GCASH-MOVE');
 const split=await moveG({'TEST-GCASH-MOVE':[slot('test-move-c1',8),slot('test-move-c2',9)]});
 assert.equal(split.items.reduce((n,i)=>n+Number(i.total),0),700.01,'fractional cent allocation preserves total');
 assert.equal((await db.query("select count(*)::int n from public.bookings where booking_group_ref='TEST-GCASH-MOVE' and gcash_ref='9912345678901'")).rows[0].n,2);
 // Discounted bookings retain voucher restrictions and exact amount totals.
 const campaign=(await db.query(`insert into public.voucher_campaigns(name,created_by,kind,value,starts_at,ends_at,max_uses,court_ids)
 values ('Rollback move voucher',$1,'fixed',300,now(),now()+interval '1 year',10,array['test-move-c1','test-move-c2']) returning *`,[owner])).rows[0];
 await db.query("insert into public.voucher_codes(code,campaign_id,max_uses) values ('TEST-MOVE-VOUCHER',$1,10)",[campaign.id]);
 await db.query(`insert into public.bookings(ref,full_name,email,court_id,court_name,date,slots,start_time,end_time,duration,total,downpayment,payment_method,payment_status,status)
 values ('TEST-VOUCHER-MOVE','Schedule test','schedule-test@example.invalid','test-move-c1','Test move 1',$1,array['16','17'],'4:00 PM','6:00 PM',2,1000.01,1000.01,'cash','paid','confirmed')`,[date]);
 const redemption=(await db.query(`insert into public.voucher_redemptions(campaign_id,code,booking_key,booking_refs,full_name,email,phone,original_total,discount,rules,state)
 values ($1,'TEST-MOVE-VOUCHER','TEST-VOUCHER-MOVE',array['TEST-VOUCHER-MOVE'],'Schedule test','schedule-test@example.invalid','',1000.01,300,$2,'consumed') returning id`,[campaign.id,JSON.stringify(campaign)])).rows[0].id;
 await db.query("select set_config('request.jwt.claims',$1,true),set_config('paddle_rage.voucher_write','on',true)",[JSON.stringify({sub:owner,role:'service_role'})]);
 await db.query("update public.bookings set voucher_original_total=1000.01,voucher_discount=300,total=700.01,downpayment=700.01,voucher_redemption_id=$1,voucher_code='TEST-MOVE-VOUCHER' where ref='TEST-VOUCHER-MOVE'",[redemption]);
 await db.query("select set_config('request.jwt.claims',$1,true),set_config('paddle_rage.voucher_write','off',true)",[JSON.stringify({sub:owner,role:'authenticated'})]);
 const vc=[{bookingRef:'TEST-VOUCHER-MOVE',expectedCourtId:'test-move-c1',expectedDate:date,expectedSlots:['16','17'],expectedTotal:700.01,slots:[slot('test-move-c1',16),slot('test-move-c3',17)]}];
 await db.query('savepoint voucher_restriction');
 try{await db.query('select public.move_paid_booking_slots($1,$2)',['TEST-VOUCHER-MOVE',JSON.stringify(vc)]);assert.fail('Expected voucher court rejection');}catch(e){assert.match(e.message,/voucher restrictions/);}finally{await db.query('rollback to savepoint voucher_restriction');}
 vc[0].slots[1].courtId='test-move-c2';
 const vr=(await db.query('select public.move_paid_booking_slots($1,$2) data',['TEST-VOUCHER-MOVE',JSON.stringify(vc)])).rows[0].data;
 assert.equal(vr.items.reduce((n,i)=>n+Number(i.total),0),700.01);
 assert.equal(vr.items.reduce((n,i)=>n+Number(i.voucherOriginalTotal),0),1000.01);
 assert.equal(vr.items.reduce((n,i)=>n+Number(i.voucherDiscount),0),300);
 assert.equal((await db.query('select cardinality(booking_refs) n from public.voucher_redemptions where id=$1',[redemption])).rows[0].n,2);
 await db.query('savepoint unauthorized');
 try{await db.query("update public.bookings set schedule_payment_root_ref='fake' where ref='TEST-PAID-MOVE'");assert.fail('Expected guarded link');}catch(e){assert.match(e.message,/server managed/);}finally{await db.query('rollback to savepoint unauthorized');}
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'anon'})]);
 await rejected(next,/active dashboard/);
 console.log('PASS: court splits, paid hours/money, receipts, fee ledger, stale snapshot, overlap/conflict rollback, repeat moves, and role/link guards.');
 }finally{await db.query('rollback');await db.end();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
