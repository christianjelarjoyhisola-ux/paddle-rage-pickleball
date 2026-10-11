const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function setup(windows=[]) {
 const listeners={},notifications=[],opened=[];
 const self={location:{origin:'https://paddleragecdo.ph'},addEventListener:(name,fn)=>listeners[name]=fn,registration:{showNotification:async(...args)=>notifications.push(args)},clients:{matchAll:async()=>windows,openWindow:async(url)=>opened.push(url)}};
 vm.runInNewContext(fs.readFileSync('notifications-sw.js','utf8'),{self,URL,importScripts:()=>{self.PaymentReviewLink=require('./payment-review-link.js');}});return {listeners,notifications,opened};
}
test('push hides arbitrary payload details and uses a fixed review destination',async()=>{
 const s=setup();let task;
 s.listeners.push({data:{json:()=>({title:'Customer name',body:'Sensitive receipt',url:'https://attacker.test'})},waitUntil:p=>task=p});await task;
 assert.equal(s.notifications[0][0],'Paddle Rage');assert.equal(s.notifications[0][1].body,'A payment needs review. Sign in to view the details.');
 assert.equal(s.notifications[0][1].data.url,'/admin#payreview');assert.equal(s.listeners.fetch,undefined,'no stale financial data cache');
});
test('notification click reuses an admin window and ignores foreign windows',async()=>{
 let navigated,focused=false,task;
 const s=setup([{url:'https://attacker.test/admin',navigate:()=>assert.fail('foreign client')},{url:'https://paddleragecdo.ph/admin.html',navigate:async u=>{navigated=u;},focus:async()=>focused=true}]);
 s.listeners.notificationclick({notification:{close(){}},waitUntil:p=>task=p});await task;
 assert.equal(navigated,'https://paddleragecdo.ph/admin#payreview');assert.ok(focused);assert.equal(s.opened.length,0);
});
test('notification click opens the secure admin route when no window is open',async()=>{
 const s=setup();let task;s.listeners.notificationclick({notification:{close(){}},waitUntil:p=>task=p});await task;
 assert.equal(s.opened[0],'https://paddleragecdo.ph/admin#payreview');
});
test('notification click brings the installed homepage into Payment Review',async()=>{
 let navigated,focused=false,task;
 const s=setup([{url:'https://paddleragecdo.ph/',navigate:async u=>{navigated=u;},focus:async()=>focused=true}]);
 s.listeners.notificationclick({notification:{close(){}},waitUntil:p=>task=p});await task;
 assert.equal(navigated,'https://paddleragecdo.ph/admin#payreview');assert.ok(focused);assert.equal(s.opened.length,0);
});
test('a stale app window falls back to opening Payment Review',async()=>{
 const s=setup([{url:'https://paddleragecdo.ph/admin',navigate:async()=>{throw Error('Window closed');}}]);
 let task;s.listeners.notificationclick({notification:{close(){}},waitUntil:p=>task=p});await task;
 assert.equal(s.opened[0],'https://paddleragecdo.ph/admin#payreview');
});
test('each payment notification retains its target through push and click',async()=>{
 const s=setup();let task;
 const review={kind:'booking',subject_id:'PB-GROUP-123'};
 s.listeners.push({data:{json:()=>({review})},waitUntil:p=>task=p});await task;
 const opts=s.notifications[0][1];
 assert.equal(opts.tag,'paddle-rage-review:booking:PB-GROUP-123');
 s.listeners.notificationclick({notification:{data:opts.data,close(){}},waitUntil:p=>task=p});await task;
 assert.equal(s.opened[0],'https://paddleragecdo.ph/admin?review_kind=booking&review_id=PB-GROUP-123#payreview');
});
test('untrusted URLs and malformed review targets cannot redirect a notification',async()=>{
 const s=setup();let task;
 s.listeners.notificationclick({notification:{data:{url:'https://attacker.test',review:{kind:'booking',subject_id:'../../attacker'}},close(){}},waitUntil:p=>task=p});await task;
 assert.equal(s.opened[0],'https://paddleragecdo.ph/admin#payreview');
});
