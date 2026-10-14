import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {sha256} from '../../packages/contracts/src/index.ts';
import {setup} from './harness.ts';
test('R3 identity: refresh rotates access tokens with an absolute session bound and logout revokes the family',async t=>{
  const h=await setup(t),old=await h.login(),reply=await h.raw('/v1/auth/refresh',{token:old,body:{}});assert.equal(reply.status,200);const token=reply.body.data.token;assert.notEqual(token,old);const row=(await h.db.query('SELECT * FROM auth_tokens WHERE digest=$1',[sha256(token)])).rows[0];assert.ok(row.absolute_expires_at);assert.ok(row.expires_at<=row.absolute_expires_at);const logout=await h.raw('/v1/auth/logout',{token,body:{}});assert.equal(logout.status,200);assert.equal((await h.raw('/v1/status',{token:old})).status,401);assert.equal((await h.raw('/v1/status',{token})).status,401);
});
test('R3 identity: removed development identities are disabled on restart without reverting governed roles',async t=>{
  const h=await setup(t),token=await h.login('bob');await h.setRole('prn_alice','member');const file=h.env.CIRCLE_HUB_DEV_IDENTITIES!,input=JSON.parse(await readFile(file,'utf8'));input.identities=input.identities.filter((identity:any)=>identity.username!=='bob');await writeFile(file,JSON.stringify(input));await h.stop();await h.startServer();assert.equal((await h.raw('/v1/status',{token})).status,401);assert.equal((await h.raw('/v1/auth/dev-login',{body:{username:'bob',password:'synthetic-only-password'}})).status,401);assert.equal((await h.db.query("SELECT role FROM principal_scope_roles WHERE principal_id='prn_alice' AND scope_id='scp_lab'")).rows[0].role,'member');
});
test('R3 identity: failed password attempts lock the identity without blocking an unrelated session',async t=>{
  const h=await setup(t),token=await h.login('bob');const replies=[];for(let index=0;index<6;index++)replies.push(await h.raw('/v1/auth/dev-login',{body:{username:'alice',password:'invalid-synthetic-password'}}));assert.equal(replies.at(-1)!.status,429);assert.equal((await h.raw('/v1/status',{token})).status,200);assert.equal((await h.raw('/v1/auth/dev-login',{body:{username:'alice',password:'synthetic-only-password'}})).status,429);
});
