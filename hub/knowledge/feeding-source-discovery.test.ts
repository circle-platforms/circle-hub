import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from './test-support.ts';
import { world } from './testing/feeding-bounds-fixture.ts';

test('an unbound source uses one readable witness for thousands of identical product records', async t => {
  const pg=await startPostgres();let close=async():Promise<void>=>{};
  t.after(async()=>{await close();await pg.stop();});
  const w=await world(pg),layer=w.knowledge.feeding!;
  close=async()=>{await layer.drain();await w.close();};
  const initial=await layer.observeSource(w.user,w.document.body.sha256,w.scope);
  assert.equal(initial.objects.length,40);
  const rows=await w.knowledge.store.all({key:'knowledge.feeding.source',value:w.document.body.sha256,kind:'claim'});
  assert.ok(rows.length);
  const first=rows[0],internal=layer as any,all=internal.all.bind(layer),visible=internal.recordVisible.bind(layer);
  assert.equal(await visible(first,w.user),true,'the representative is actually readable in the temporary database');
  t.mock.method(internal,'all',async(key:string,value:string,tx?:unknown)=>key==='knowledge.feeding.source'&&value===w.document.body.sha256?Array(4000).fill(first):all(key,value,tx));
  let checks=0;
  t.mock.method(internal,'recordVisible',async(row:any,principal:unknown)=>{if(row.digest===first.digest){checks++;return true;}return visible(row,principal);});
  const result=await layer.observeSource(w.user,w.document.body.sha256,{...w.scope,product:undefined});
  assert.deepEqual(result.objects,initial.objects);
  assert.equal(checks,1,'one established product uses exactly one readable witness');
});

test('product discovery requires a readable witness and does not choose between distinct visible products', async t => {
  const pg=await startPostgres();let close=async():Promise<void>=>{};
  t.after(async()=>{await close();await pg.stop();});
  const w=await world(pg),layer=w.knowledge.feeding!;
  close=async()=>{await layer.drain();await w.close();};
  const initial=await layer.observeSource(w.user,w.document.body.sha256,w.scope);
  const records=await w.knowledge.store.all({key:'knowledge.feeding.source',value:w.document.body.sha256,kind:'claim'});
  assert.ok(records.length);
  const make=(digest:string,product:string)=>{const record=structuredClone(records[0]) as any;record.digest=digest;record.body.statement.data.feeding.product=product;return record;};
  const hidden=make('a'.repeat(64),w.product.id),allowed=make('b'.repeat(64),w.product.id),other=make('c'.repeat(64),'lumen-api');
  const internal=layer as any,all=internal.all.bind(layer),visible=internal.recordVisible.bind(layer);
  t.mock.method(internal,'all',async(key:string,value:string,tx?:unknown)=>key==='knowledge.feeding.source'&&value===w.document.body.sha256?[hidden,allowed,allowed,other]:all(key,value,tx));
  let otherVisible=false,hiddenChecks=0,allowedChecks=0,otherChecks=0;
  t.mock.method(internal,'recordVisible',async(row:any,principal:unknown)=>{
    if(row.digest===hidden.digest){hiddenChecks++;return false;}
    if(row.digest===allowed.digest){allowedChecks++;return true;}
    if(row.digest===other.digest){otherChecks++;return otherVisible;}
    return visible(row,principal);
  });
  const single=await layer.observeSource(w.user,w.document.body.sha256,{...w.scope,product:undefined});
  assert.deepEqual(single.objects,initial.objects);
  assert.equal(hiddenChecks,1);assert.equal(allowedChecks,1);assert.equal(otherChecks,1);
  otherVisible=true;
  const ambiguous=await layer.observeSource(w.user,w.document.body.sha256,{...w.scope,product:undefined});
  assert.equal(ambiguous.objects.length,0);
  assert.ok(ambiguous.pending.some(row=>row.missing.includes('缺少产品及树苗上下文')));
});
