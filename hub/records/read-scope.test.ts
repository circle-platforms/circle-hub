import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {startPostgres} from '../testing/postgres.ts';
import {openTestRecords} from '../testing/records.ts';
import {withReadScope,scopedRecordStore,memoReadPort,memoReadValue,IntegrityError,type RecordStore} from './api.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('batched indexed pages preserve each independent order, limit and continuation including missing keys',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const store=kit.store;
 for(let n=0;n<8;n++)await store.put({kind:'action',schema:'synthetic-page@1',provenance:'declared',body:{n},index:[{key:'synthetic.group',value:n%2?'a':'b'}]});
 const first=await store.find({key:'synthetic.group',value:'a',limit:2});
 const queries=[{key:'synthetic.group',value:'a',limit:2,cursor:first.next},{key:'synthetic.group',value:'b',limit:1,newestFirst:true},{key:'synthetic.group',value:'missing',limit:3},{key:'synthetic.group',value:'\0',limit:0}];
 assert.deepEqual(await store.findBatch!(queries),await Promise.all(queries.map(q=>store.find(q))));
 await assert.rejects(store.findBatch!([{key:'synthetic.group',value:'a',cursor:'bad'}]),/继续令牌/);
});
test('ordered candidates use body order rather than append order, preserve tie keys and leave unrelated escaped NUL intact',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const store=kit.store;
 const ids=['b','a','c','d'].map(c=>'run_'+'0'.repeat(25)+c),dates=['2026-11-03T01:00:00.000Z','2026-11-03T03:00:00.000Z','2026-11-03T01:00:00.000Z','2026-11-03T02:00:00.000Z'];
 for(let i=0;i<4;i++)await store.put({kind:'run',schema:'synthetic-order@1',provenance:'declared',body:{started_at:dates[i],run:ids[i],parameter:'\0'},index:[{key:'runs.pack',value:i===3?'other':'main'}]});
 const first=await store.runCandidates!<{started_at:string;run:string}>({limit:2});assert.deepEqual(first.map(r=>r.body.run),[ids[1],ids[3]]);
 const next=await store.runCandidates!<{run:string}>({after:[dates[3],ids[3]],limit:2});assert.deepEqual(next.map(r=>r.body.run),[ids[2],ids[0]]);
 assert.deepEqual((await store.runCandidates!<{run:string;parameter:string}>({pack:'main',limit:3})).map(r=>r.body.run),[ids[1],ids[2],ids[0]]);
 assert.equal((await store.runCandidates!<{parameter:string}>({limit:1}))[0].body.parameter,'\0','projection masking never edits returned bytes');

});
test('scoped reads coalesce verified gets, isolate caller mutation and bypass transactions and escaped scopes',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const store=kit.store;
 const row=await store.put({kind:'action',schema:'synthetic-scope@1',provenance:'declared',body:{n:1}}),many=store.getMany.bind(store);let batches=0;
 store.getMany=async(...args)=>{batches++;return many(...args);};let escaped:RecordStore;
 await withReadScope(async()=>{const scoped=scopedRecordStore(store);escaped=scoped;const [a,b]=await Promise.all([scoped.get<{n:number}>(row.digest),scoped.get<{n:number}>(row.digest)]);assert.equal(batches,1);a!.body.n=99;assert.equal(b!.body.n,1);assert.equal((await scoped.get<{n:number}>(row.digest))!.body.n,1);assert.equal(batches,1);
  await store.withTransaction(async tx=>{assert.equal((await scoped.get<{n:number}>(row.digest,tx))!.body.n,1);});
 });
 await escaped!.get(row.digest);assert.equal(batches,1,'escaped adapters read directly rather than reuse their expired cache');
 await withReadScope(async()=>{await scopedRecordStore(store).get(row.digest);});assert.equal(batches,2);
});
test('a rejected batch isolates healthy siblings and keeps the failing record unavailable',async()=>{
 const healthy={digest:'a'.repeat(64),body:{value:'synthetic'}},bad='b'.repeat(64);
 const store={getMany:async()=>{throw new IntegrityError('合成批量读取故障');},get:async(id:string)=>{if(id===bad)throw new IntegrityError('合成单项完整性故障');return healthy;}} as unknown as RecordStore;
 await withReadScope(async()=>{const scoped=scopedRecordStore(store),rows=await Promise.allSettled([scoped.get(healthy.digest),scoped.get(bad)]);assert.equal(rows[0].status,'fulfilled');assert.equal(rows[1].status,'rejected');});
});
test('writes invalidate an existing request view rather than lend an old absence to a later read',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());
 await withReadScope(async()=>{const store=scopedRecordStore(kit.store),query={key:'synthetic.changed',value:'one'};assert.equal((await store.find(query)).items.length,0);
  await store.put({kind:'action',schema:'synthetic-invalidation@1',provenance:'declared',body:{value:1},index:[{key:query.key,value:query.value}]});assert.equal((await store.find(query)).items.length,1);
 });
});
test('authorization memoization is isolated by reader and request, including an adapter used after its scope ends',async()=>{
 let enabled=true,calls=0;const port={canRead:async(reader:string)=>{calls++;return enabled&&reader==='owner';}};let escaped:typeof port;
 await Promise.all(['owner','other'].map(reader=>withReadScope(async()=>{const scoped=memoReadPort(port,['canRead']);escaped=scoped;assert.equal(await scoped.canRead(reader),reader==='owner');assert.equal(await scoped.canRead(reader),reader==='owner');})));assert.equal(calls,2);
 enabled=false;assert.equal(await escaped!.canRead('owner'),false);assert.equal(calls,3);
 await withReadScope(async()=>assert.equal(await memoReadPort(port,['canRead']).canRead('owner'),false));assert.equal(calls,4);
});

test('failed reads can retry inside the same scope instead of caching a transient failure',async()=>{
 let calls=0;const port={read:async()=>{if(++calls===1)throw new Error('synthetic transient read');return true;}};
 await withReadScope(async()=>{const scoped=memoReadPort(port,['read']);await assert.rejects(scoped.read());assert.equal(await scoped.read(),true);});assert.equal(calls,2);
 let attempts=0;const store={getMany:async()=>{throw new Error('synthetic batch failure');},get:async()=>{if(++attempts===1)throw new Error('synthetic fallback failure');return null;}} as unknown as RecordStore;
 await withReadScope(async()=>{const scoped=scopedRecordStore(store);await assert.rejects(scoped.get('a'.repeat(64)));assert.equal(await scoped.get('a'.repeat(64)),null);});assert.equal(attempts,2);
});
test('batched citation counters equal independent capped, dated, duplicate and empty counts',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());
 for(let n=0;n<5;n++)await kit.store.put({kind:n===4?'claim':'submission',schema:'synthetic-count@1',provenance:'declared',created_at:`2026-11-0${n+1}T00:00:00.000Z`,body:{n},index:[{key:'synthetic.count',value:'all'},{key:'synthetic.parity',value:n%2?'odd':'even'}]});
 const queries=[{index:[{key:'synthetic.count',value:'all'},{key:'synthetic.parity',value:'odd'}],kind:'submission' as const},{index:[{key:'synthetic.count',value:'all'}],since:'2026-11-03T00:00:00.000Z',cap:2},{index:[]},{index:[{key:'synthetic.count',value:'missing'}]},{index:[{key:'synthetic.count',value:'\0'}],since:'invalid'}];
 assert.deepEqual(await kit.store.countIndexedBatch!(queries),await Promise.all(queries.map(q=>kit.store.countIndexed!(q))));
 let batches=0;const count=kit.store.countIndexedBatch!.bind(kit.store);kit.store.countIndexedBatch=async(...args)=>{batches++;return count(...args);};
 await withReadScope(async()=>{const scoped=scopedRecordStore(kit.store);assert.deepEqual(await Promise.all(queries.map(q=>scoped.countIndexed!(q))),await count(queries));});assert.equal(batches,1);
 await assert.rejects(kit.store.countIndexedBatch!([{index:[],cap:0}]),TypeError);
});

test('candidate entry times read only the canonical header, tolerate unrelated escaped NUL and leave full verification to hydration',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());
 const at='2026-11-03T02:00:00.000Z',record=await kit.store.put({kind:'knowledge_space_entry',schema:'synthetic-header@1',provenance:'declared',body:{at,content:'synthetic\0text'}});
 const other=await kit.store.put({kind:'claim',schema:'synthetic-header@1',provenance:'declared',body:{at}});
 assert.deepEqual(await kit.store.entryTimes!([record.digest,record.digest,other.digest,'f'.repeat(64)]),new Map([[record.digest,at]]));
 assert.equal((await kit.store.get<{content:string}>(record.digest))?.body.content,'synthetic\0text');
 const candidates=[other.digest,record.digest,record.digest,'f'.repeat(64)];
 assert.deepEqual(await kit.store.entryCandidates!({digests:candidates,offset:0,limit:1}),{items:[{index:1,at}],total:2});
 assert.deepEqual(await kit.store.entryCandidates!({digests:candidates,offset:1,limit:1}),{items:[{index:2,at}],total:2});
 assert.deepEqual(await kit.store.entryCandidates!({digests:candidates,offset:2,limit:1}),{items:[],total:2});
 const invalid=await kit.store.put({kind:'knowledge_space_entry',schema:'synthetic-header@1',provenance:'declared',body:{at:'invalid'}});await assert.rejects(kit.store.entryTimes!([invalid.digest]),IntegrityError);
});

test('entry candidate counts filter each expected space header before limit and preserve NUL bodies',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());
 const at='2026-11-03T02:00:00.000Z';
 const own=await kit.store.put({kind:'knowledge_space_entry',schema:'synthetic-header@1',provenance:'declared',body:{at,space:'own',content:'synthetic\0text'}});
 const foreign=await kit.store.put({kind:'knowledge_space_entry',schema:'synthetic-header@1',provenance:'declared',body:{at,space:'foreign'}});
 const digests=[foreign.digest,own.digest,own.digest],spaces=['own','own','foreign'];
 assert.deepEqual(await kit.store.entryCandidates!({digests,spaces,offset:0,limit:1}),{items:[{index:1,at}],total:1});
 assert.deepEqual(await kit.store.entryCandidates!({digests,spaces,offset:1,limit:100}),{items:[],total:1});
 await assert.rejects(kit.store.entryCandidates!({digests,spaces:[],offset:0,limit:1}),TypeError);
});

test('queued reads on both sides of a write all settle and the later reads do not reuse its old value',{timeout:5000},async()=>{
 let n=0;const id='a'.repeat(64),record=()=>({digest:id,body:{n}}),page=()=>({items:[record()],next:null});
 const store={getMany:async()=>new Map([[id,record()]]),get:async()=>record(),findBatch:async(queries:unknown[])=>queries.map(()=>page()),find:async()=>page(),countIndexedBatch:async(queries:unknown[])=>queries.map(()=>({count:n,capped:false})),countIndexed:async()=>({count:n,capped:false}),put:async()=>{n=1;return record();}} as unknown as RecordStore;
 await withReadScope(async()=>{const scoped=scopedRecordStore(store),query={key:'synthetic.changed',value:'one'},count={index:[{key:query.key,value:query.value}]};
  const before=[scoped.get<{n:number}>(id),scoped.find<{n:number}>(query),scoped.countIndexed!(count)];
  const write=scoped.put({kind:'action',schema:'synthetic-change@1',provenance:'declared',body:{n:1}});
  const after=[scoped.get<{n:number}>(id),scoped.find<{n:number}>(query),scoped.countIndexed!(count)];
  const old=await Promise.all(before),now=await Promise.all(after);await write;
  assert.deepEqual(old,[{digest:id,body:{n:0}},{items:[{digest:id,body:{n:0}}],next:null},{count:0,capped:false}]);
  assert.deepEqual(now,[{digest:id,body:{n:1}},{items:[{digest:id,body:{n:1}}],next:null},{count:1,capped:false}]);
 });
});

test('memo keys distinguish undefined from null and decline non-JSON argument values',async()=>{
 let calls=0;const port={read:async(..._args:unknown[])=>++calls};
 await withReadScope(async()=>{
  const scoped=memoReadPort(port,['read']);
  const missing=await scoped.read(undefined),nil=await scoped.read(null);assert.notEqual(missing,nil);assert.equal(await scoped.read(undefined),missing);assert.equal(await scoped.read(null),nil);
  assert.notEqual(await scoped.read({value:undefined}),await scoped.read({value:null}));
  assert.notEqual(await scoped.read(-0),await scoped.read(0));
  const cyclic:any={};cyclic.self=cyclic;
  let getterCalls=0;const getter=Object.defineProperty({},'value',{enumerable:true,get(){getterCalls++;return 1;}});
  for(const unsupported of [new Proxy({},{}),{toJSON(){return {};}},new Set(['a']),new Map([['a',1]]),()=>1,()=>2,new Date(0),/a/,1n,Symbol('x'),NaN,Infinity,cyclic,getter]){
   assert.notEqual(await scoped.read(unsupported),await scoped.read(unsupported),'unsupported arguments are passed through without memoization');
  }
  assert.equal(getterCalls,0,'key construction never invokes an argument getter');
  const json={a:[true,'x',null],b:{value:undefined}};const first=await scoped.read(json);assert.equal(await scoped.read({a:[true,'x',null],b:{value:undefined}}),first);
 });
});
test('memoized method sets are independent of call order and the specialized record view',async()=>{
 let a=0,b=0;const port={a:async()=>++a,b:async()=>++b};
 for(const reverse of [false,true])await withReadScope(async()=>{
  const first=memoReadPort(port,reverse?['b']:['a']),second=memoReadPort(port,reverse?['a']:['b']);
  assert.notEqual(first,second);assert.equal(await first[reverse?'b':'a'](),await first[reverse?'b':'a']());assert.equal(await second[reverse?'a':'b'](),await second[reverse?'a':'b']());
  assert.notEqual(await first[reverse?'a':'b'](),await first[reverse?'a':'b'](),'an unlisted method is never memoized by a different proxy');
  const both=memoReadPort(port,['a','b']);assert.equal(both,memoReadPort(port,['b','a','a']));
 });
 const store={getMany:async(ids:string[])=>new Map(ids.map(id=>[id,{digest:id,body:{}}]))} as unknown as RecordStore;
 await withReadScope(async()=>{const generic=memoReadPort(store,['getMany']);assert.notEqual(scopedRecordStore(store),generic);});
});
test('generic store memo arguments retain null and undefined and bypass Sets and Maps',async()=>{
 let calls=0;const store={list:async(..._args:unknown[])=>({items:[],next:String(++calls)})} as unknown as RecordStore;
 await withReadScope(async()=>{
  const scoped=scopedRecordStore(store),read=(arg:unknown)=>scoped.list(arg as never);
  const nil=await read(null),missing=await read(undefined);assert.notDeepEqual(nil,missing);assert.deepEqual(await read(null),nil);assert.deepEqual(await read(undefined),missing);
  for(const arg of [new Set(['a']),new Map([['a',1]]),()=>1])assert.notDeepEqual(await read(arg),await read(arg));
 });
});
test('raw service writes are outside memo invalidation and a new outer read scope observes them',async()=>{
 let value=0;const service={read:async()=>value,write:()=>{value++;}};
 await withReadScope(async()=>{const scoped=memoReadPort(service,['read']);assert.equal(await scoped.read(),0);service.write();assert.equal(await scoped.read(),0,'raw writers are explicitly unsupported inside a read scope');});
 await withReadScope(async()=>assert.equal(await memoReadPort(service,['read']).read(),1));
});

test('value memo uses explicit JSON keys, isolates owners and clears with intercepted writes',async()=>{
 const owner={},other={};let calls=0;const load=async()=>({value:++calls});
 const store={put:async()=>({})} as unknown as RecordStore;
 await withReadScope(async()=>{
  const first=await memoReadValue(owner,['key',undefined],load);first.value=99;
  assert.deepEqual(await memoReadValue(owner,['key',undefined],load),{value:1});
  assert.deepEqual(await memoReadValue(owner,['key',null],load),{value:2});
  assert.deepEqual(await memoReadValue(other,['key',undefined],load),{value:3});
  await scopedRecordStore(store).put({kind:'action',schema:'synthetic-value@1',provenance:'declared',body:{}});
  assert.deepEqual(await memoReadValue(owner,['key',undefined],load),{value:4});
  await assert.rejects(memoReadValue(owner,['failure'],async()=>{throw Error('synthetic');}));
  assert.deepEqual(await memoReadValue(owner,['failure'],load),{value:5});
 });
 await withReadScope(async()=>assert.deepEqual(await memoReadValue(owner,['key',undefined],load),{value:6}));
 const left=Symbol('read'),right=Symbol('read'),port={[left]:async()=>1,[right]:async()=>2};
 await withReadScope(async()=>{const scoped=memoReadPort(port,[left,right]);assert.equal(await scoped[left](),1);assert.equal(await scoped[right](),2);});
});

test('batched record pages, counts and entry headers read logical personal payloads and exclude purged epochs',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-batch-admin'),owner=await kit.principals.createUser(admin,'synthetic-batch-owner');
 const at='2026-11-03T02:00:00.000Z',store=kit.store;const records:Awaited<ReturnType<typeof store.put>>[]=[];
 for(let n=0;n<3;n++)records.push(await store.put({kind:'knowledge_space_entry',schema:'synthetic-header@1',provenance:'declared',body:{space:owner.id,at,text:'synthetic-private-'+n},index:[{key:'synthetic.logical',value:'personal'}]}));
 const team=await store.put({kind:'knowledge_space_entry',schema:'synthetic-header@1',provenance:'declared',body:{space:'team',at},index:[{key:'synthetic.logical',value:'personal'}]});
 const query={kind:'knowledge_space_entry' as const,key:'synthetic.logical',value:'personal',limit:2};
 const first=(await store.findBatch!([query]))[0];assert.deepEqual(first,await store.find(query));assert.equal(first.items.length,2);assert.ok(first.items.every(r=>r.body&&JSON.stringify(r.body).includes('synthetic-private')));
 assert.deepEqual(await store.findBatch!([{...query,cursor:first.next}]),[await store.find({...query,cursor:first.next})]);
 const count={index:[{key:query.key,value:query.value}]};assert.deepEqual(await store.countIndexedBatch!([count]),[await store.countIndexed!(count)]);
 const digests=records.map(r=>r.digest),spaces=digests.map(()=>owner.id);
 assert.equal((await store.entryCandidates!({digests,spaces,offset:0,limit:1})).total,3);assert.equal((await store.entryTimes!(digests)).size,3);
 const epoch=(await kit.personalPayloads!.scope(owner.id)).epoch;await kit.personalPayloads!.purge(owner,epoch);
 const page=(await store.findBatch!([query]))[0];assert.deepEqual(page,await store.find(query));assert.deepEqual(page.items.map(r=>r.digest),[team.digest]);
 assert.deepEqual(await store.countIndexedBatch!([count]),[{count:1,capped:false}]);assert.equal((await store.entryCandidates!({digests,spaces,offset:0,limit:100})).total,0);assert.equal((await store.entryTimes!(digests)).size,0);
 const local=await kit.personalSync!.state(owner);await kit.personalSync!.resume(owner,local.epoch,local.state_version);
 assert.equal((await store.entryCandidates!({digests,spaces,offset:0,limit:100})).total,0);
 const fresh=await store.put({kind:'knowledge_space_entry',schema:'synthetic-header@1',provenance:'declared',body:{space:owner.id,at,text:'synthetic-fresh'},index:[{key:query.key,value:query.value}]});
 assert.deepEqual((await store.findBatch!([query]))[0].items.map(r=>r.digest),[team.digest,fresh.digest]);
});

test('space header filtering does not hide a missing active personal payload as an empty candidate set',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const {user:owner}=await kit.principals.bootstrapAdmin('synthetic-missing-payload');
 const row=await kit.store.put({kind:'knowledge_space_entry',schema:'synthetic-header@1',provenance:'declared',body:{space:owner.id,at:'2026-11-03T02:00:00.000Z',text:'synthetic missing active body'}});
 const {Database,createPool}=await import('./db.ts');const db=new Database(createPool(kit.database));t.after(()=>db.end());await db.query('DELETE FROM personal_payloads WHERE owner=$1',[owner.id]);
 const query={digests:[row.digest],spaces:[owner.id],reader:owner.id,offset:0,limit:1};
 await assert.rejects(kit.store.get(row.digest),IntegrityError);
 await assert.rejects(kit.store.entryCandidates!(query),IntegrityError);
 const epoch=(await kit.personalPayloads!.scope(owner.id)).epoch;await kit.personalPayloads!.purge(owner,epoch);
 assert.deepEqual(await kit.store.entryCandidates!(query),{items:[],total:0},'a completed purge, unlike lost active bytes, is ordinary absence');
});
