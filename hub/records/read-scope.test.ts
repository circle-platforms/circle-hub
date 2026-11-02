import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {startPostgres} from '../testing/postgres.ts';
import {openTestRecords} from '../testing/records.ts';
import {withReadScope,scopedRecordStore,memoReadPort,IntegrityError,type RecordStore} from './api.ts';
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
