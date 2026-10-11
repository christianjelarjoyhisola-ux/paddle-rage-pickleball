import { validSubscription, escapeHtml, pushPayload } from './core.ts';
import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
const sub=(endpoint:string)=>({endpoint,keys:{p256dh:'B'.repeat(87),auth:'a'.repeat(22)}});
Deno.test('push endpoint validation blocks SSRF and preserves known provider subscriptions',()=>{
  for(const url of ['https://fcm.googleapis.com/fcm/send/example','https://web.push.apple.com/Qexample','https://updates.push.services.mozilla.com/wpush/v2/test']) assert(validSubscription(sub(url)));
  for(const url of ['http://fcm.googleapis.com/a','https://localhost/a','https://127.0.0.1/a','https://fcm.googleapis.com.attacker.test/a','https://attacker.test/?web.push.apple.com','https://user@fcm.googleapis.com/a','https://fcm.googleapis.com:9999/a']) assertEquals(validSubscription(sub(url)),null);
  assertEquals(validSubscription({...sub('https://web.push.apple.com/a'),keys:{auth:'bad',p256dh:'bad'}}),null);
});
Deno.test('lock screen copy contains no customer data or arbitrary navigation URL',()=>{
  assertEquals(pushPayload(),{title:'Paddle Rage',body:'A payment needs review. Sign in to view the details.',tag:'paddle-rage-payment-review'});
  assertEquals(pushPayload(true).tag,'paddle-rage-test');
});
Deno.test('email receipt metadata is escaped',()=>assertEquals(escapeHtml('<img src="x">&'), '&lt;img src=&quot;x&quot;&gt;&amp;'));
