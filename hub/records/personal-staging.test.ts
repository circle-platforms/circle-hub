import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openTestRecords} from '../testing/records.ts';
import {barrier} from '../testing/member-freeze.ts';
import {PgPersonalPayloads} from './personal-payloads.ts';
import {sha256Hex} from './digest.ts';
import {LimitError} from './errors.ts';

test('ten extractions reserve at most two connections and queued checks reserve none',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-stage-admin');
 const users=[admin];for(let n=0;n<9;n++)users.push(await kit.principals.createUser(admin,'synthetic-stage-'+n));
 const payloads=kit.personalPayloads as PgPersonalPayloads,release=barrier(),entered=barrier();let running=0,peak=0;
 const jobs=users.map(user=>payloads.stage(user.id,sha256Hex(user.id),async()=>{peak=Math.max(peak,++running);if(running===2)entered.release();try{await release.promise;}finally{running--;}}));
 const settled=Promise.allSettled(jobs);
 try{
  await entered.promise;await new Promise(resolve=>setImmediate(resolve));
  assert.ok(peak<=2,'untrusted extractions must leave most pool slots for unrelated requests');
  assert.ok(payloads.db.pool.totalCount-payloads.db.pool.idleCount<=2);
  assert.equal((await kit.principals.get(admin.id))?.id,admin.id);
 }finally{release.release();await settled;}
 assert.equal(peak,2);

 const checksRelease=barrier(),checksEntered=barrier(),active=new Set<string>();let checked=0,max=0;
 const checks=[users[0],users[0],...users.slice(1)].map(user=>payloads.withStagingSlot(user.id,async()=>{
  assert.ok(!active.has(user.id),'at most one publication/check per member');active.add(user.id);max=Math.max(max,active.size);if(++checked===2)checksEntered.release();
  try{await checksRelease.promise;}finally{active.delete(user.id);}
 }));
 const all=Promise.allSettled(checks);
 try{await checksEntered.promise;assert.equal(max,2);assert.equal(payloads.db.pool.totalCount,payloads.db.pool.idleCount,'sandbox admission owns no pooled transaction');assert.ok(await kit.principals.get(admin.id));}finally{checksRelease.release();await all;}
 assert.equal(checked,10);assert.equal(max,2);assert.equal((await all).filter(result=>result.status==='fulfilled').length,10);
 const refused=(await all).filter(result=>result.status==='rejected');assert.equal(refused.length,1);assert.ok(refused[0].reason instanceof LimitError);
 await assert.rejects(payloads.withStagingSlot(admin.id,async()=>{throw new Error('synthetic check failure');}),/synthetic check failure/);
 assert.equal(await payloads.withStagingSlot(admin.id,async()=>42),42,'failure releases the member slot');
});
