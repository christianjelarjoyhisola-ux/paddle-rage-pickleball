const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function setup(windows=[]) {
 const listeners={},notifications=[],opened=[];
 const self={location:{origin:'https://paddleragecdo.ph'},addEventListener:(name,fn)=>listeners[name]=fn,registration:{showNotification:async(...args)=>notifications.push(args)},clients:{matchAll:async()=>windows,openWindow:async(url)=>opened.push(url)}};
 vm.runInNewContext(fs.readFileSync('notifications-sw.js','utf8'),{self,URL});return {listeners,notifications,opened};
}
test('push hides arbitrary payload details and uses a fixed review destination',async()=>{
 const s=setup();let task;
 s.listeners.push({data:{json:()=>({title:'Customer name',body:'Sensitive receipt',url:'https://attacker.test'})},waitUntil:p=>task=p});await task;
 assert.equal(s.notifications[0][0],'Paddle Rage');assert.equal(s.notifications[0][1].body,'A payment needs review. Sign in to view the details.');
 assert.equal(s.notifications[0][1].data.url,'/admin#payreview');assert.equal(s.listeners.fetch,undefined,'no stale financial data cache');
});
test('notification click reuses an admin window and ignores foreign windows',async()=>{
 let navigated,focused=false,task;
 const s=setup([{url:'https://attacker.test/admin',navigate:()=>assert.fail('foreign client')},{url:'https://paddleragecdo.ph/admin.html',navigate:async u=>navigated=u,focus:async()=>focused=true}]);
 s.listeners.notificationclick({notification:{close(){}},waitUntil:p=>task=p});await task;
 assert.equal(navigated,'https://paddleragecdo.ph/admin#payreview');assert.ok(focused);assert.equal(s.opened.length,0);
});
test('notification click opens the secure admin route when no window is open',async()=>{
 const s=setup();let task;s.listeners.notificationclick({notification:{close(){}},waitUntil:p=>task=p});await task;
 assert.equal(s.opened[0],'https://paddleragecdo.ph/admin#payreview');
});
