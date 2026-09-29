import {parseRcbcReceipt,verifyRcbcReceipt} from './rcbc.ts';
const raw="16:38 1\nBank Transfer\n764\nBank Transfer Complete\nSent via GCash\nSuccessful transactions are credited instantly. You will receive\nan update about this transaction in your GCash Inbox.\nBank\nAccount No.\nAccount Name\nTransfer Method\nReceipt sent to\nRCBC/DiskarTech\n..7890\nTEST COURT\nOWNER\nInstaPay\ntest-payer\nTransfer Amount\n+Fee\nTotal\nDate\n9@example.com\n700.00\n10.00\nP 710.00\nInstaPay Invoice No.\nRef No.\nSep 29, 2026 04:38 PM\n6996999\n4045565399999\nMay chance kang kumita as a\nPART\nOWNER\nRegister. Top up, and Buy Stocks!\ni";
const context={typedReference:'4045565399999',expectedAmount:700,pricingAvailable:true,amountTolerance:.01,expectedRecipientName:'TEST COURT OWNER',expectedRecipientNumber:'1234567890',bookingStartedAt:'2026-09-29T08:36:02.567Z',bookingStartedDate:'2026-09-29',paymentWindowMinutes:15,earlyToleranceMinutes:2};
const run=(text=raw,patch={})=>{const c={...context,...patch};const p=parseRcbcReceipt(text,{typedReference:c.typedReference});return {p,v:verifyRcbcReceipt(p,c)}};
const eq=(a:unknown,b:unknown)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(JSON.stringify({a,b}))};
Deno.test('GCash RCBC split columns recover labels and split email without using fee as payment',()=>{const {p,v}=run();eq(v.flags,[]);eq(p.amount.amount,700);eq(p.railReference.value,'6996999');eq(p.timestamp.instant,'2026-09-29T08:38:00.000Z');eq(p.recipient.nameRaw,'TEST COURT OWNER');});
Deno.test('GCash RCBC new columns still reject incorrect fields',()=>{
for(const [text,patch,flag] of [
 [raw,{expectedAmount:710},'AMOUNT_MISMATCH'],
 [raw.replace('10.00','20.00'),{},'AMOUNT_CONFLICT'],
 [raw.replace('..7890','..1234'),{},'RECEIVER_ACCOUNT_MISMATCH'],
 [raw.replace('TEST COURT','OTHER COURT'),{},'RECEIVER_NAME_MISMATCH'],
 [raw.replace('RCBC/DiskarTech','Other Bank'),{},'RCBC_DESTINATION_MISMATCH'],
 [raw,{typedReference:'6996999'},'REF_MISMATCH'],
 [raw,{bookingStartedAt:'2026-09-29T08:00:00Z'},'TIME_EXPIRED'],
] as const)eq(run(text,patch).v.flags.includes(flag),true);
});
Deno.test('GCash RCBC duplicated labels and incomplete columns stay in review',()=>{
for(const text of [raw.replace('Date\n','Date\nDate\n'),raw.replace('6996999',''),raw.replace('9@example.com\n',''),raw.replace('Ref No.\n','')])eq(run(text).v.flags.length>0,true);
});
Deno.test('GCash RCBC ignores advertisement money and phone status clock',()=>{const {p,v}=run(raw+'\nPHP 9999.00\n12:00 PM');eq(v.flags,[]);eq(p.amount.amount,700);eq(p.timestamp.time24,'16:38');});
