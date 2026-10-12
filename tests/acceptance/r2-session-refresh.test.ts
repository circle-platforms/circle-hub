import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {sha256,CLIENT_ROUTES} from '../../packages/contracts/src/index.ts';
import {setup} from './harness.ts';

test('Development sessions: default login lasts a work day and explicit short expirations remain enforced',async t=>{
  const h=await setup(t),login=await h.raw('/v1/auth/dev-login',{body:{username:'alice',password:'synthetic-only-password'}});assert.equal(login.status,200);const remaining=Date.parse(login.body.data.expiresAt)-Date.now();assert.ok(remaining>7*60*60*1000&&remaining<=8*60*60*1000,`Default expires after ${remaining}ms`);
  const short=await h.login('alice',20);await delay(40);assert.equal((await h.raw('/v1/status',{token:short})).status,401);
});

test('Development sessions: bearer refresh needs no password preserves concurrent calls and rechecks live authority',async t=>{
  const h=await setup(t),token=await h.login('alice',2500),old=(await h.db.query('SELECT expires_at FROM auth_tokens WHERE digest=$1',[sha256(token)])).rows[0].expires_at;
  const replies=await Promise.all([h.raw('/v1/auth/refresh',{token,body:{}}),h.raw('/v1/status',{token}),h.raw('/v1/auth/refresh',{token,body:{}})]);for(const reply of replies)assert.equal(reply.status,200,JSON.stringify(reply.body));const renewed=replies[0].body.data;assert.equal(renewed.token,token);assert.equal(renewed.principalId,'prn_alice');assert.ok(Date.parse(renewed.expiresAt)>old.getTime());assert.deepEqual(renewed.scopes,['scp_lab','scp_second']);
  assert.equal((CLIENT_ROUTES as any).authRefresh.path,'/v1/auth/refresh');assert.equal((await h.db.query('SELECT count(*) AS n FROM auth_tokens WHERE digest=$1',[sha256(token)])).rows[0].n,'1');
  await h.db.query("UPDATE policies SET scopes='[\"scp_second\"]'::jsonb WHERE principal_id='prn_alice'");assert.deepEqual((await h.raw('/v1/auth/refresh',{token,body:{}})).body.data.scopes,['scp_second']);
  await h.db.query("UPDATE policies SET disabled=true WHERE principal_id='prn_alice'");assert.equal((await h.raw('/v1/auth/refresh',{token,body:{}})).status,401);
  const expired=await h.login('bob',20);await delay(40);assert.equal((await h.raw('/v1/auth/refresh',{token:expired,body:{}})).status,401);
  assert.equal((await h.raw('/v1/auth/refresh',{body:{}})).status,401);assert.equal((await h.raw('/v1/auth/refresh',{token:await h.login('bob'),body:{expiresInMs:86400000}})).body.error.code,'INVALID_PAYLOAD');
});

test('Development sessions: a live session can renew through task reads and reconnect without another credential exchange',async t=>{
  const h=await setup(t,{CIRCLE_SERVER_DEV_TOKEN_TTL_MS:'1500'}),login=await h.raw('/v1/auth/dev-login',{body:{username:'alice',password:'synthetic-only-password'}}),token=login.body.data.token,task=await h.raw('/v1/tasks/submit',{token,body:{scopeId:'scp_lab',title:'Long-lived read follow',input:{},idempotencyKey:'long-read-session'}});
  for(let count=0;count<4;count++){await delay(500);const renewed=await h.raw('/v1/auth/refresh',{token,body:{}});assert.equal(renewed.status,200);assert.equal(renewed.body.data.token,token);assert.equal((await h.raw(`/v1/tasks/${task.body.data.taskId}/events?after=0`,{token})).status,200);}
  assert.ok(Date.now()>Date.parse(login.body.data.expiresAt));await h.stop();await h.startServer();assert.equal((await h.raw(`/v1/tasks/${task.body.data.taskId}/status`,{token})).status,200);assert.equal((await h.raw('/v1/auth/refresh',{token,body:{}})).status,200);
});
