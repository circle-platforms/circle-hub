import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
import {INITIAL_PERSONAL_EPOCH} from './personal-payloads.ts';

test('new personal bodies stay indirect, preserve their logical digest and are physically removed on purge',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());
 const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-admin');
 const owner=await kit.principals.createUser(admin,'synthetic-owner'),other=await kit.principals.createUser(admin,'synthetic-other');
 const db=new Database(createPool(kit.database));t.after(()=>db.end());
 const body={space:owner.id,title:'synthetic-private-title',markdown:'synthetic-private-body\0é',path:'/synthetic-private-folder'};
 const record=await kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body,unique_key:'synthetic.personal',index:[{key:'synthetic.personal',value:owner.id}]});
 assert.deepEqual((await kit.store.get(record.digest))?.body,body);
 const raw=(await db.query('SELECT body FROM records WHERE digest=$1',[record.digest])).rows[0].body;
 assert.ok(!String(raw).includes('synthetic-private'));
 assert.equal((await kit.personalPayloads!.inspect(record.digest))?.cleared,false);
 const independent=await kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{...body,space:'team'}});
 const otherRecord=await kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{...body,space:other.id}});
 await kit.personalPayloads!.purge(owner,INITIAL_PERSONAL_EPOCH);
 assert.equal(await kit.store.get(record.digest),null);
 assert.equal(await kit.store.getById(record.id),null);
 assert.equal(await kit.store.getByKey('memory_version','synthetic.personal'),null);
 assert.equal(await kit.store.getText(record.digest),null);
 assert.equal((await kit.store.getTexts([record.digest])).size,0);
 assert.equal((await kit.store.getMany([record.digest])).size,0);
 assert.deepEqual(await kit.store.findMany({key:'synthetic.personal',values:[owner.id]}),[]);
 assert.equal((await kit.store.findFirstMany({key:'synthetic.personal',values:[owner.id]})).size,0);
 assert.deepEqual((await kit.store.find({key:'synthetic.personal',value:owner.id})).items,[]);
 assert.ok(!(await kit.store.list({kind:'memory_version'})).items.some(r=>r.digest===record.digest));
 assert.equal((await kit.personalPayloads!.inspect(record.digest))?.cleared,true);
 assert.deepEqual((await kit.store.get(independent.digest))?.body,{...body,space:'team'});
 assert.ok(await kit.store.get(otherRecord.digest));
 assert.equal((await db.query('SELECT count(*)::int AS n FROM personal_payloads WHERE owner=$1',[owner.id])).rows[0].n,0);
 await assert.rejects(kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{...body,markdown:'after purge'}}),/仅保存在本机/);
});

test('a runtime-style binding cannot hide an independent record with a manufactured capsule',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const {user}=await kit.principals.bootstrapAdmin('synthetic');
 const db=new Database(createPool(kit.database));t.after(()=>db.end());
 const team=await kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:'team',markdown:'independent'}});
 await assert.rejects(db.query('INSERT INTO personal_record_bindings VALUES($1,$2,$3,$4,1,$5,$6)',[team.digest,user.id,INITIAL_PERSONAL_EPOCH,'a'.repeat(64),'fake','b'.repeat(64)]));
 assert.ok(await kit.store.get(team.digest));
});

test('missing active payloads fail integrity checks; cleared capsules still verify their immutable digest chain',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const {user}=await kit.principals.bootstrapAdmin('synthetic-owner');
 const db=new Database(createPool(kit.database));t.after(()=>db.end());
 const r=await kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:user.id,markdown:'synthetic'}});
 await db.query('DELETE FROM personal_payloads WHERE owner=$1',[user.id]);
 await assert.rejects(kit.store.get(r.digest),/摘要不符|不完整/);
 await kit.personalPayloads!.purge(user,INITIAL_PERSONAL_EPOCH);
 assert.equal(await kit.store.get(r.digest),null);
 // Simulate privileged offline corruption, not an application-role capability.
 await db.query('ALTER TABLE records DISABLE TRIGGER records_append_only');
 await db.query("UPDATE records SET body='{}' WHERE digest=$1",[r.digest]);
 await db.query('ALTER TABLE records ENABLE TRIGGER records_append_only');
 await assert.rejects(kit.store.get(r.digest),/摘要链/);
});

test('equal original bytes are held separately per account and do not confer cross-account read or purge authority',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-admin');
 const owner=await kit.principals.createUser(admin,'synthetic-owner'),other=await kit.principals.createUser(admin,'synthetic-other');
 const bytes=Buffer.from('synthetic equal personal original');
 const input=(by:typeof owner)=>({personalOwner:by.id,bytes,mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:by.id},provenanceType:'declared' as const,visibility:{readers:[by.id],admins:false,packs:[],shareable:false}});
 const a=await kit.artifacts.ingest(input(owner)),b=await kit.artifacts.ingest(input(other));assert.equal(a.body.sha256,b.body.sha256);
 const db=new Database(createPool(kit.database));t.after(()=>db.end());
 assert.equal((await db.query('SELECT count(*)::int AS n FROM personal_payloads WHERE sha256=$1',[a.body.sha256])).rows[0].n,2);
 await assert.rejects(kit.personalPayloads!.purge(admin,INITIAL_PERSONAL_EPOCH));
 assert.ok((await kit.artifacts.source(owner,a.body.sha256))?.bytes);
 await kit.personalPayloads!.purge(owner,INITIAL_PERSONAL_EPOCH);
 assert.equal(await kit.artifacts.source(owner,a.body.sha256),null);
 assert.equal(await kit.artifacts.source(admin,a.body.sha256),null);
 assert.deepEqual(Buffer.from((await kit.artifacts.source(other,b.body.sha256))!.bytes!),bytes);
});

test('standalone and space-transaction personal captures use one lock order and idempotent capture identity',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const {user}=await kit.principals.bootstrapAdmin('synthetic-owner');
 const input={personalOwner:user.id,bytes:Buffer.from('synthetic concurrent original'),mediaType:'text/plain',origin:{upload:{session:'synthetic-lock-order'}},author:{user:user.id},provenanceType:'declared' as const,visibility:{readers:[user.id],admins:false,packs:[],shareable:false}};
 const captures=await Promise.all(Array.from({length:12},(_,n)=>n%2?kit.artifacts.ingest(input):kit.store.withTransaction(async tx=>{await kit.store.lock('knowledge-space:'+user.id,tx);return kit.artifacts.ingest(input,tx);})));
 assert.equal(new Set(captures.map(r=>r.digest)).size,1);
 assert.ok((await kit.artifacts.source(user,captures[0].body.sha256))?.bytes);
});
