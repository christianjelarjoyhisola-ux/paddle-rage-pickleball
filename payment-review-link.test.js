const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const links=require('./payment-review-link.js');
test('payment kinds round-trip through links with no customer or payment information',()=>{
 for(const kind of ['booking','host_balance','open_play','host_session']){
  const p={kind,subject_id:'record-123'};const url=new URL(links.path(p),'https://paddleragecdo.ph');
  assert.deepEqual(links.fromSearch(url.search),p);assert.equal(url.hash,'#payreview');
 }
 for(const p of [{kind:'approve',subject_id:'1'},{kind:'booking',subject_id:'../1'},null])assert.equal(links.path(p),'/admin#payreview');
});
test('opens only the matching modal after current manual-review status is checked',async()=>{
 for(const kind of ['booking','host_balance','open_play','host_session']){
  const calls=[];await links.open({kind,subject_id:'group-1'},{resolve:async p=>{calls.push('resolve:'+p.subject_id);return {pending:true,kind,id:'record-1'};},openers:{[kind]:async id=>calls.push('open:'+id)},notify:()=>assert.fail('Unexpected notice')});
  assert.deepEqual(calls,['resolve:group-1','open:record-1']);
 }
});
test('an already resolved payment never opens confirmation or approves anything',async()=>{
 let notice='';await links.open({kind:'booking',subject_id:'record-1'},{resolve:async()=>({pending:false}),openers:{booking:()=>assert.fail('Resolved payment opened')},notify:s=>notice=s});
 assert.match(notice,/no longer awaiting manual review/);
});
test('server errors and mismatched payment types do not open another record',async()=>{
 await assert.rejects(links.open({kind:'booking',subject_id:'record-1'},{resolve:async()=>({pending:true,kind:'host_balance',id:'record-2'}),openers:{host_balance:()=>assert.fail('Wrong modal')},notify:()=>{}}),/could not be opened/);
});
test('sign-in return URL retains payment identity without preserving unrelated query parameters',()=>{
 const html=fs.readFileSync('admin.html','utf8');
 const fn=html.slice(html.indexOf('function adminSignInReturnTo()'),html.indexOf("let _linkedPaymentReviewKey="));
 const ctx={window:{PaymentReviewLink:links},location:{search:'?review_kind=booking&review_id=PB-123&unsafe=ignored'},sectionFromLocation:()=> 'payreview'};
 vm.createContext(ctx);vm.runInContext(fn,ctx);
 assert.equal(ctx.adminSignInReturnTo(),'admin.html?review_kind=booking&review_id=PB-123#payreview');
 ctx.location.search='?review_kind=bad&review_id=PB-123';assert.equal(ctx.adminSignInReturnTo(),'admin.html#payreview');
});
