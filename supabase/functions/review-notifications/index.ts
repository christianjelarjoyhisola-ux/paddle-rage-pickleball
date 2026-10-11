import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { sendMailerooEmail, isEmailAddress } from '../_shared/maileroo.ts';
import { validSubscription, escapeHtml, pushPayload, digest } from './core.ts';
import { paymentReviewUrl, validReviewTarget } from '../_shared/payment-review-link.ts';

const roles = new Set(['owner','court_owner','staff']);
const origins = new Set(['https://paddleragecdo.ph','https://www.paddleragecdo.ph','http://localhost:3000']);
const env = (key: string) => Deno.env.get(key)?.trim() || '';
function checked(result: any) { if (result.error) throw new Error('Database operation failed'); return result.data; }
async function deliver(db: any, target: any, payment: any = null) {
  try {
    const reviewUrl = paymentReviewUrl(payment);
    if (target.channel === 'email') {
      const detail = payment ? `Booker: ${payment.booker_name || 'Name unavailable'}\nReference: ${payment.reference}\nAmount: PHP ${Number(payment.amount).toFixed(2)}` : 'Your payment-review email alerts are ready.';
      const plain = `${payment ? 'Payment review needed' : 'Paddle Rage test notification'}\n\n${detail}\n\n${reviewUrl}\nReminders repeat hourly while a payment awaits review. Manage alerts in Admin > Notifications.`;
      await sendMailerooEmail({to:target.destination.email,subject:payment ? 'Paddle Rage — payment review needed' : 'Paddle Rage — test notification',plain,
        html:`<h2>Paddle Rage</h2><p>${escapeHtml(plain).replace(/\n/g,'<br>')}</p><p><a href="${escapeHtml(reviewUrl)}">Review payment</a></p>`});
    } else {
      const sub = validSubscription(target.destination);
      if (!sub) throw new Error('Invalid subscription');
      const request = webpush.generateRequestDetails(sub, JSON.stringify(pushPayload(!payment, payment)), {
        TTL:60, urgency:'normal', vapidDetails:{subject:'https://paddleragecdo.ph',publicKey:env('WEB_PUSH_PUBLIC_KEY'),privateKey:env('WEB_PUSH_PRIVATE_KEY')},
      });
      const r = await fetch(request.endpoint,{method:'POST',headers:request.headers,body:request.body,redirect:'error',signal:AbortSignal.timeout(12000)});
      if (r.status===404 || r.status===410) checked(await db.from('review_notification_targets').update({enabled:false}).eq('id',target.id));
      if (!r.ok) throw new Error('Push delivery failed');
    }
    checked(await db.from('review_notification_targets').update({last_sent_at:new Date().toISOString(),last_error:null}).eq('id',target.id));
    return true;
  } catch {
    checked(await db.from('review_notification_targets').update({last_error:'Delivery failed. Check the address or re-enable this device.'}).eq('id',target.id));
    return false;
  }
}
async function dispatch(db: any) {
  const due = checked(await db.rpc('due_review_notifications')) || [];
  let sent=0,failed=0,skipped=0;
  // Bound concurrent delivery and preserve the database lease for overlapping cron runs.
  for(let i=0;i<due.length;i+=5) await Promise.all(due.slice(i,i+5).map(async (row: any) => {
    const args={p_target:row.target_id,p_kind:row.kind,p_subject:row.subject_id,p_since:row.pending_since};
    const token=checked(await db.rpc('claim_review_notification',args));
    if(!token){skipped++;return;}
    const target=checked(await db.from('review_notification_targets').select('*').eq('id',row.target_id).eq('enabled',true).maybeSingle());
    const current=checked(await db.from('payment_review_reminder_candidates').select('*').eq('kind',row.kind).eq('subject_id',row.subject_id).eq('pending_since',row.pending_since).maybeSingle());
    const account=target && checked(await db.from('accounts').select('role,status').eq('id',target.user_id).maybeSingle());
    let ok=false;
    if(target && current && account?.status==='active' && roles.has(account.role)) {ok=await deliver(db,target,current);if(ok)sent++;else failed++;} else skipped++;
    checked(await db.rpc('finish_review_notification',{...args,p_token:token,p_sent:ok}));
  }));
  return {ok:failed===0,sent,failed,skipped};
}
export async function handle(req: Request) {
  const origin=req.headers.get('origin') || '';
  const headers: Record<string,string> = {'Vary':'Origin','Cache-Control':'no-store','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'};
  if(origins.has(origin)) headers['Access-Control-Allow-Origin']=origin;
  const json=(body: unknown,status=200)=>Response.json(body,{status,headers});
  if(origin && !origins.has(origin)) return json({error:'Origin not allowed'},403);
  if(req.method==='OPTIONS')return new Response(null,{headers});
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'));
  try {
    const secret=req.headers.get('x-cron-secret');
    if(secret){
      if(secret.length<32 || secret.length>256 || checked(await db.rpc('verify_balance_cron_secret',{p_token:secret}))!==true)return json({error:'Unauthorized'},401);
      return json(await dispatch(db));
    }
    const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
    const {data:auth,error}=await db.auth.getUser(token);
    const user=auth?.user;
    if(error||!user)return json({error:'Sign in again to manage notifications.'},401);
    const account=checked(await db.from('accounts').select('role,status').eq('id',user.id).maybeSingle());
    if(account?.status!=='active'||!roles.has(account.role))return json({error:'Payment review access required.'},403);
    const raw=await req.text();if(raw.length>10000)return json({error:'Request too large'},413);
    let body;try{body=JSON.parse(raw);}catch{return json({error:'Invalid request'},400);}
    if(!body || typeof body!=='object')return json({error:'Invalid request'},400);
    if(body.action==='resolve_review'){
      const target=validReviewTarget(body.review);
      if(!target)return json({error:'Invalid payment link.'},400);
      // A notification is a navigation hint, never authority to approve a payment.
      const pending=checked(await db.from('payment_review_reminder_candidates').select('kind,subject_id')
        .eq('kind',target.kind).eq('subject_id',target.subject_id).maybeSingle());
      if(!pending)return json({ok:true,pending:false});
      if(target.kind==='host_balance' && account.role==='staff')return json({error:'Only an owner can review host balance payments.'},403);
      let id=target.subject_id;
      if(target.kind==='booking'){
        let rows=checked(await db.from('bookings').select('ref').eq('booking_group_ref',id).order('created_at').limit(1));
        if(!rows.length)rows=checked(await db.from('bookings').select('ref').eq('ref',id).limit(1));
        if(!rows.length)return json({ok:true,pending:false});
        id=rows[0].ref;
      }
      return json({ok:true,pending:true,kind:target.kind,id});
    }
    if(body.action==='status'){
      const rows=checked(await db.from('review_notification_targets').select('id,channel,target_key,destination,enabled,last_sent_at,last_error').eq('user_id',user.id));
      return json({ok:true,email:rows.find((r:any)=>r.channel==='email') || null,devices:rows.filter((r:any)=>r.channel==='push').map((r:any)=>({id:r.id,target_key:r.target_key,enabled:r.enabled,last_sent_at:r.last_sent_at,last_error:r.last_error})),publicKey:env('WEB_PUSH_PUBLIC_KEY'),emailReady:!!env('MAILEROO_API_KEY'),pushReady:!!env('WEB_PUSH_PUBLIC_KEY')&&!!env('WEB_PUSH_PRIVATE_KEY')});
    }
    if(body.action==='verify_email_start'){
      const email=String(body.email||'').trim().toLowerCase();if(!isEmailAddress(email))return json({error:'Enter a valid email address.'},400);
      const bytes=crypto.getRandomValues(new Uint32Array(1));const code=String(100000+bytes[0]%900000);
      const hash=await digest(`${user.id}:${code}:${env('SUPABASE_SERVICE_ROLE_KEY')}`);
      if(!checked(await db.rpc('begin_review_email_verification',{p_user:user.id,p_email:email,p_hash:hash})))return json({error:'Wait one minute before requesting another code.'},429);
      await sendMailerooEmail({to:email,subject:'Paddle Rage — verify notification email',plain:`Your notification email verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,html:`<h2>Paddle Rage</h2><p>Your notification email verification code:</p><p style="font-size:28px;letter-spacing:6px"><strong>${code}</strong></p><p>Expires in 10 minutes. If you did not request this, ignore this email.</p>`});
      return json({ok:true});
    }
    if(body.action==='verify_email_finish'){
      if(!/^\d{6}$/.test(String(body.code||'')))return json({error:'Enter the six-digit code.'},400);
      const ok=checked(await db.rpc('confirm_review_email',{p_user:user.id,p_hash:await digest(`${user.id}:${body.code}:${env('SUPABASE_SERVICE_ROLE_KEY')}`)}));
      return json(ok?{ok:true}:{error:'Code incorrect or expired. Request a new code after five attempts.'},ok?200:400);
    }
    if(body.action==='subscribe'){
      if(!env('WEB_PUSH_PRIVATE_KEY'))return json({error:'Phone notifications are not configured yet.'},503);
      const sub=validSubscription(body.subscription);if(!sub)return json({error:'Unsupported push subscription.'},400);
      const key=await digest(sub.endpoint);
      checked(await db.from('review_notification_targets').upsert({user_id:user.id,channel:'push',target_key:key,destination:sub,enabled:true,last_error:null},{onConflict:'user_id,channel,target_key'}));
      return json({ok:true});
    }
    if(body.action==='toggle' || body.action==='test'){
      const target=checked(await db.from('review_notification_targets').select('*').eq('id',body.id).eq('user_id',user.id).maybeSingle());
      if(!target)return json({error:'Notification setting not found.'},404);
      if(body.action==='toggle'){
        if(typeof body.enabled!=='boolean')return json({error:'Invalid setting'},400);
        checked(await db.from('review_notification_targets').update({enabled:body.enabled}).eq('id',target.id).eq('user_id',user.id));return json({ok:true});
      }
      if(!checked(await db.rpc('claim_review_notification_test',{p_target:target.id,p_user:user.id})))return json({error:'Enable alerts first, then wait one minute between tests.'},429);
      const ok=await deliver(db,target);return json(ok?{ok:true}:{error:'Provider did not accept the notification. Try again later.'},ok?200:502);
    }
    return json({error:'Unknown action'},400);
  } catch {return json({error:'Notification request failed. Please try again.'},500);}
}
if(import.meta.main)Deno.serve(handle);
