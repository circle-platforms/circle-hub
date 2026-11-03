// Destructive writes must retire every request-local proof, including retained adapters and nested read scopes.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {openTestRecords} from '../testing/records.ts';
import {barrier} from '../testing/member-freeze.ts';
import {withReadScope,retireReadScope,scopedRecordStore,memoReadPort,memoReadValue,type RecordStore} from './api.ts';
import {SyncModeSchema} from '../../contracts/generated/vocabulary.ts';

test('a member deleted within an outer read scope cannot reuse cached principals, private bodies or payload state',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-scope-admin'),member=await kit.principals.createUser(admin,'synthetic-scope-member');
 const record=await kit.store.put({kind:'memory_version',schema:'synthetic-deletion-scope@1',provenance:'declared',body:{space:member.id,markdown:'synthetic private scope text'},index:[{key:'synthetic.scope.member',value:member.id}]}),query={key:'synthetic.scope.member',value:member.id};
 await withReadScope(async()=>{
  const store=scopedRecordStore(kit.store),principals=memoReadPort(kit.principals,['get','list']),payloads=memoReadPort(kit.personalPayloads!,['mode','cleared']);
  assert.ok(await store.get(record.digest));assert.ok((await store.getMany([record.digest])).has(record.digest));assert.equal((await store.find(query)).items.length,1);assert.equal((await store.countIndexed!({index:[query]})).count,1);
  assert.equal((await principals.get(member.id))?.deleted_at,undefined);assert.ok((await principals.list()).some(user=>user.id===member.id&&!user.deleted_at));assert.equal(await payloads.cleared(record.digest),false);
  const api=kit.memberDeletions!,preview=await api.preview(admin,member.id),intent=await api.prepare(admin,{...preview,operation_id:randomUUID()});
  assert.ok((await principals.get(member.id))?.deleted_at,'prepare invalidates cached active identities');
  await withReadScope(async()=>{
   const nested=scopedRecordStore(kit.store);assert.ok(await nested.get(record.digest));await api.finish(admin,member.id,intent.operation_id);
   assert.equal(await nested.get(record.digest),null);assert.equal(await store.get(record.digest),null);assert.equal((await store.getMany([record.digest])).size,0);assert.deepEqual((await store.find(query)).items,[]);assert.equal((await store.countIndexed!({index:[query]})).count,0);
   assert.ok((await principals.list()).find(user=>user.id===member.id)?.deleted_at);assert.equal(await payloads.cleared(record.digest),true);assert.equal(await payloads.mode(member.id),SyncModeSchema.enum.local);
  });
 });
});

test('raw deactivation and local purge retire cached access and private records without needing a new request',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-purge-admin'),member=await kit.principals.createUser(admin,'synthetic-purge-member');
 const record=await kit.store.put({kind:'memory_version',schema:'synthetic-scope-purge@1',provenance:'declared',body:{space:member.id,markdown:'synthetic purge text'}}),epoch=(await kit.personalPayloads!.scope(member.id)).epoch;
 await withReadScope(async()=>{
  const principals=memoReadPort(kit.principals,['get']),store=scopedRecordStore(kit.store);assert.equal((await principals.get(member.id))?.disabled,false);await kit.principals.setDisabled(admin,member.id,true);assert.equal((await principals.get(member.id))?.disabled,true);await kit.principals.setDisabled(admin,member.id,false);assert.equal((await principals.get(member.id))?.disabled,false);
  await withReadScope(async()=>{const modes=memoReadPort(kit.personalPayloads!,['mode']);assert.equal(await modes.mode(member.id),SyncModeSchema.enum.hub);assert.ok(await store.get(record.digest));await kit.personalPayloads!.purge(member,epoch);assert.equal(await store.get(record.digest),null);assert.equal(await modes.mode(member.id),SyncModeSchema.enum.local);const state=await kit.personalSync!.state(member);await kit.personalSync!.resume(member,state.epoch,state.state_version);assert.equal(await modes.mode(member.id),SyncModeSchema.enum.hub);assert.equal(await store.get(record.digest),null);});
 });
});

test('pending memoized results that finish after deletion reload instead of delivering their earlier snapshots',async()=>{
 let deleted=false,entered=0;const gate=barrier(),id='a'.repeat(64),snapshot=()=>deleted?null:{digest:id,body:{private:'synthetic old private text'}},page=()=>({items:deleted?[]:[snapshot()],next:null});
 const delayed=async<T>(read:()=>T)=>{const value=read();entered++;if(!deleted)await gate.promise;return value;};
 const seen:string[]=[];
 const raw={getMany:async()=>delayed(()=>new Map(deleted?[]:[[id,snapshot()]])),get:async()=>delayed(snapshot),find:async(query:{value:string})=>{seen.push(query.value);return delayed(page);},countIndexed:async()=>delayed(()=>({count:deleted?0:1,capped:false})),list:async()=>delayed(page)} as unknown as RecordStore;
 const port={read:async(arg:{member:string})=>{seen.push(arg.member);return delayed(snapshot);}};
 await withReadScope(async()=>{
  const store=scopedRecordStore(raw),account=memoReadPort(port,['read']),arg={member:'synthetic-owner'},query={key:'synthetic.key',value:'synthetic-owner'};
  const pending=[store.get(id),store.getMany([id]),store.find(query),store.countIndexed!({index:[query]}),store.list({kind:'memory_version'}),account.read(arg),memoReadValue(raw,['synthetic'],()=>delayed(snapshot))];
  await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,7);arg.member='synthetic-other';query.value='synthetic-other';deleted=true;retireReadScope();gate.release();
  assert.deepEqual(await Promise.all(pending),[null,new Map(),{items:[],next:null},{count:0,capped:false},{items:[],next:null},null,null]);assert.ok(seen.every(value=>value==='synthetic-owner'),'a reload must retain the frozen arguments of the admitted read');
 });
});

test('retiring an older parent scope invalidates a later nested scope through the shared generation',async()=>{
 let current=0;const entered=barrier(),release=barrier(),port={read:async()=>current};
 await withReadScope(async()=>{
  retireReadScope();const nested=withReadScope(async()=>{const read=memoReadPort(port,['read']);assert.equal(await read.read(),0);entered.release();await release.promise;return read.read();});
  await entered.promise;current=1;retireReadScope();release.release();assert.equal(await nested,1);
 });
});

test('private object batches preserve the caller transaction rather than borrowing a second connection',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const {user:owner}=await kit.principals.bootstrapAdmin('synthetic-transaction-owner'),bytes=Buffer.from('synthetic uncommitted private object');
 await kit.store.withTransaction(async tx=>{const object=await kit.objects.put(bytes,'text/plain',tx,owner.id,true);assert.deepEqual(Buffer.from((await kit.objects.get(object.sha256,tx))!),bytes);});
});
