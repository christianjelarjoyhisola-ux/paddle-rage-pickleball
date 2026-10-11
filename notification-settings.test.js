const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{webcrypto}=require('node:crypto');
function setup({denied=false,broken=false}={}){
 const elements=new Map();const el=id=>{if(!elements.has(id))elements.set(id,{dataset:{},textContent:'',disabled:false,hidden:false,focus(){},scrollIntoView(){},querySelectorAll(){return [...elements.values()]}});return elements.get(id)};
 let subscriptions=0,saved=0,sub=null;
 const notification={permission:denied?'denied':'default',requestPermission(){assert.fail('Do not split the Safari permission and subscription gestures')}};
 const registration={pushManager:{getSubscription:async()=>{if(broken)throw Error('Unavailable');return sub;},subscribe(){subscriptions++;notification.permission='granted';sub={endpoint:'https://web.push.apple.com/test',toJSON(){return {endpoint:this.endpoint,keys:{}}}};return Promise.resolve(sub)}}};
 const window={Notification:notification,matchMedia:()=>({matches:true})};
 const navigator={userAgent:'iPhone',standalone:true,serviceWorker:{register:async()=>registration,ready:Promise.resolve(registration)}};
 const state={email:{id:'email',enabled:true,destination:{email:'verified@example.test'}},devices:[],emailReady:true,pushReady:true,publicKey:Buffer.alloc(65,1).toString('base64url')};
 const context={window,navigator,Notification:notification,document:{getElementById:el},crypto:webcrypto,TextEncoder,Uint8Array,atob,setTimeout,clearTimeout,_invokeEdgeFunction:async(_name,body)=>{if(body.action==='subscribe')saved++;return state}};
 vm.runInNewContext(fs.readFileSync('notification-settings.js','utf8'),context);
 return {el,window,render:()=>window.PaddleNotifications.render(),counts:()=>({subscriptions,saved})};
}
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
test('iPhone subscribes during the tap without requiring global PushManager',async()=>{
 const app=setup();await app.render();assert.equal(app.el('notificationPhoneToggle').disabled,false);
 app.el('notificationPhoneToggle').onclick();assert.equal(app.counts().subscriptions,1,'subscribe starts synchronously during user gesture');await settle();assert.equal(app.counts().saved,1);assert.match(app.el('notificationFeedback').textContent,/enabled on this device/);
});
test('denied permission offers actionable settings guidance',async()=>{
 const app=setup({denied:true});await app.render();assert.equal(app.el('notificationPhoneToggle').disabled,false);app.el('notificationPhoneToggle').onclick();assert.match(app.el('notificationFeedback').textContent,/Settings → Notifications/);assert.equal(app.counts().subscriptions,0);
});
test('worker setup failure does not block email settings',async()=>{
 const app=setup({broken:true});await app.render();assert.equal(app.el('notificationEmail').textContent,'verified@example.test');assert.equal(app.el('notificationEmailTest').disabled,false);app.el('notificationPhoneToggle').onclick();assert.match(app.el('notificationFeedback').textContent,/Refresh to retry/);
});
