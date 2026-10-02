import { verifyHostReapplicationPassword } from './host-reapplication.ts';
for (const [name, user, error, expected] of [
 ['verified existing owner',{id:'host',email:'host@example.invalid',email_confirmed_at:'2026-10-01'},null,true],
 ['wrong password',null,{message:'Invalid credentials'},false],
 ['different identity',{id:'other',email:'host@example.invalid',email_confirmed_at:'2026-10-01'},null,false],
 ['unverified email',{id:'host',email:'host@example.invalid'},null,false],
 ['different email',{id:'host',email:'other@example.invalid',email_confirmed_at:'2026-10-01'},null,false],
] as const) Deno.test('Reapplication password: '+name,async()=>{
 let closed=false;
 const auth={signInWithPassword:async()=>({data:{user,session:user?{}:null},error}),signOut:async(options:unknown)=>{if(JSON.stringify(options)!=='{"scope":"local"}')throw Error('Must not log out other sessions');closed=true;}};
 const result=await verifyHostReapplicationPassword(auth,'host@example.invalid','test-password','host');
 if(result!==expected || closed!==Boolean(user))throw Error('Unexpected identity or cleanup result');
});
