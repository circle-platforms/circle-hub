// Public member metadata only, synthetic credentials and temporary PostgreSQL.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres} from '../testing/postgres.ts';
import {openTestRecords} from '../testing/records.ts';
import {Database} from './db.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('batched token and client metadata preserve order, revoked rows and console-session exclusion without secret fields',async t=>{
 let clock=Date.parse('2026-11-03T08:00:00.000Z');const kit=await openTestRecords({postgres,now:()=>new Date(clock++)});t.after(()=>kit.close());
 const {user:admin}=await kit.principals.bootstrapAdmin('管理员',{password:'synthetic-only-console-password',mustChange:false});
 const a=await kit.principals.createUser(admin,'甲'),b=await kit.principals.createUser(admin,'乙');
 const client=await kit.principals.registerClient('合成客户端',['http://127.0.0.1/callback']);
 const one=await kit.principals.issueToken(admin,a.id,'合成设备一',client.id),two=await kit.principals.issueToken(admin,a.id,'合成设备二');await kit.principals.issueToken(admin,b.id,'合成设备三',client.id);
 await kit.principals.revokeToken(admin,one.id);const revision=(await kit.principals.passwordState(admin.id)).revision;const session=await kit.principals.openConsoleSession(admin.id,revision);assert.ok(session);
 const rows=await kit.principals.tokensMany!([admin.id,a.id,b.id,a.id,'invalid']);assert.deepEqual(rows.get(a.id)?.map(row=>row.id),[two.id,one.id]);assert.ok(rows.get(a.id)?.[1].revoked_at);assert.ok(!rows.get(admin.id)?.some(row=>row.id===session.id));
 for(const values of rows.values())for(const row of values)assert.deepEqual(Object.keys(row).sort(),['id','user','label','client','created_at','created_by','last_used_at','revoked_at'].sort());
 assert.deepEqual([...await kit.principals.clientsMany!([client.id,client.id,'invalid'])],[ [client.id,{id:client.id,name:'合成客户端',redirect_uris:['http://127.0.0.1/callback'],created_at:client.created_at}] ]);
 await kit.principals.setDisabled(admin,a.id,true);assert.deepEqual((await kit.principals.tokensMany!([a.id])).get(a.id),await kit.principals.tokens(a.id),'metadata does not invent a new disabled-account token policy');
 await kit.principals.revokeToken(admin,two.id);assert.ok((await kit.principals.tokensMany!([a.id])).get(a.id)?.every(row=>row.revoked_at!==null),'the next read sees revocation');
});
test('batched assignments preserve latest triples, expiry and independent subjects, and query count is constant as members grow',async t=>{
 let clock=Date.parse('2026-11-03T08:00:00.000Z');const kit=await openTestRecords({postgres,now:()=>new Date(clock)});t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('管理员');
 const ids:string[]=[];for(let n=0;n<5;n++)ids.push((await kit.principals.createUser(admin,'合成成员 '+n)).id);
 await kit.authorizations.assign(admin,ids[0],'synthetic-one');await kit.authorizations.assign(admin,ids[0],'synthetic-two',{expiresAt:new Date(clock+1000).toISOString()});await kit.authorizations.assign(admin,ids[1],'synthetic-one');await kit.authorizations.unassign(admin,ids[1],'synthetic-one');await kit.authorizations.assign(admin,ids[2],'synthetic-two');
 const first=await kit.authorizations.assign(admin,ids[0],'synthetic-history');let previous=first.digest;
 for(let n=0;n<505;n++){const record=await kit.store.put({kind:'authorization',schema:first.schema,provenance:'declared',body:{...first.body,revoked:n!==504&&n%2===0,supersedes:previous},index:[{key:'authz.subject',value:'assign|'+ids[0]},{key:'authz.object',value:'assign|synthetic-history'},{key:'authz.key',value:'assign|'+ids[0]+'|synthetic-history'}]});previous=record.digest;}
 const check=async()=>{const batch=await kit.authorizations.packsForMany!(ids);assert.deepEqual(batch,new Map(await Promise.all(ids.map(async id=>[id,await kit.authorizations.packsFor(id)] as const))));assert.deepEqual(await kit.authorizations.usersOfMany!(['synthetic-one','synthetic-two']),new Map(await Promise.all(['synthetic-one','synthetic-two'].map(async id=>[id,await kit.authorizations.usersOf(id)] as const))));};await check();clock+=1000;await check();assert.deepEqual((await kit.authorizations.packsForMany!(ids)).get(ids[0]),['synthetic-history','synthetic-one']);
 const original=Database.prototype.query;let calls=0;Database.prototype.query=(async function(this:Database,...args:Parameters<typeof original>){calls++;return original.apply(this,args);}) as typeof original;t.after(()=>{Database.prototype.query=original;});
 calls=0;await kit.authorizations.packsForMany!(ids);await kit.principals.tokensMany!(ids);const small=calls;assert.equal(small,2);
 for(let n=5;n<20;n++)ids.push((await kit.principals.createUser(admin,'合成成员 '+n)).id);
 calls=0;await kit.authorizations.packsForMany!(ids);await kit.principals.tokensMany!(ids);assert.equal(calls,small);
});
