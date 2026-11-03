// A generation change takes precedence over sharing an already frozen cache hit.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {withReadScope,retireReadScope,scopedRecordStore,memoReadPort,memoReadValue,memoReadCall,type RecordStore} from './api.ts';

test('retirement discards already frozen shared hits for every cache path before delivering them',async()=>{
 let generation=0;const id='b'.repeat(64),snapshot=()=>generation===2?null:{digest:id,body:{generation}},page=()=>({items:generation===2?[]:[snapshot()],next:null});
 const raw={get:async()=>snapshot(),getMany:async()=>new Map(generation===2?[]:[[id,snapshot()]]),find:async()=>page(),countIndexed:async()=>({count:generation===2?0:1,capped:false}),list:async()=>page()} as unknown as RecordStore;
 const port={read:async()=>snapshot()},owner={};
 await withReadScope(async()=>{
  const store=scopedRecordStore(raw),scoped=memoReadPort(port,['read']),query={key:'synthetic.retirement',value:'owner'};
  const readers:Array<()=>Promise<any>>=[()=>store.get(id),()=>store.getMany([id]),()=>store.find(query),()=>store.countIndexed!({index:[query]}),()=>store.list({kind:'memory_version'}),()=>scoped.read(),()=>memoReadValue(owner,['value'],async()=>snapshot()),()=>memoReadCall(owner,['call'],async()=>snapshot())];
  const before=await Promise.all(readers.map(read=>read())),shared=await Promise.all(readers.map(read=>read()));
  before.forEach((value,i)=>{assert.ok(Object.isFrozen(value));assert.equal(shared[i],value);});
  assert.throws(()=>{before[0].body.generation=99;},TypeError);
  const pending=readers.map(read=>read());generation=1;retireReadScope();
  const next=await Promise.all(pending);next.forEach((value,i)=>assert.notEqual(value,before[i],'a retired frozen identity cannot be delivered again'));
  const values=(rows:any[])=>[rows[0]?.body.generation??null,rows[1].get(id)?.body.generation??null,rows[2].items[0]?.body.generation??null,rows[3].count,rows[4].items[0]?.body.generation??null,...rows.slice(5).map(row=>row?.body.generation??null)];
  assert.deepEqual(values(next),[1,1,1,1,1,1,1,1]);
  generation=2;retireReadScope();assert.deepEqual(values(await Promise.all(readers.map(read=>read()))),[null,null,null,0,null,null,null,null]);
  assert.equal(before[0].body.generation,0,'retirement cannot rewrite values already held by the earlier caller');
  await withReadScope(async()=>{generation=1;const fresh=scopedRecordStore(raw),a=await fresh.get(id);assert.ok(Object.isFrozen(a));assert.notEqual(a,before[0]);assert.equal(await fresh.get(id),a,'a fresh generation still shares a single immutable result');});
 });
});
