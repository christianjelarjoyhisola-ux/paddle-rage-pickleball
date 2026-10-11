import {renderPaidScheduleMoveEmail} from './paddle-rage-email.ts';
Deno.test('paid schedule email separates full old/new schedules and preserves hours and amount',()=>{
 const old={courtName:'Court 1',date:'2026-10-16',startTime:'10:00 AM',endTime:'12:00 PM',duration:2,total:700};
 const result=renderPaidScheduleMoveEmail({bookingRef:'PB-TEST',fullName:'<script>bad</script>',note:'<b>Changed court</b>',before:[old],after:[{...old,courtName:'Court 2',endTime:'11:00 AM',duration:1,total:350},{...old,courtName:'Court 3',startTime:'11:00 AM',duration:1,total:350}]});
 for(const value of ['PREVIOUS SCHEDULE','NEW SCHEDULE','Court 1','Court 2','Court 3','2 paid court-hours preserved','700.00'])if(!result.plain.includes(value))throw new Error('Missing '+value);
 if(result.html.includes('<script>bad</script>')||result.html.includes('<b>Changed court</b>'))throw new Error('Email content must be escaped');
});
