import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';

test('indexed batches preserve each key, insertion position and paging at a shared position', async t => {
  const pg=await startPostgres();let close=async():Promise<void>=>{};
  t.after(async()=>{await close();await pg.stop();});
  const kit=await openTestRecords({postgres:pg});close=()=>kit.close();
  const first=await kit.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{value:'first'},index:[{key:'synthetic.index',value:'a'},{key:'synthetic.index',value:'b'}]});
  const firstPosition=await kit.store.position!(first.digest);assert.ok(firstPosition);
  const second=await kit.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{value:'second'},index:[{key:'synthetic.index',value:'b'}]});
  const lastPosition=await kit.store.position!(second.digest);assert.ok(lastPosition);
  const rows=[];let cursor: {sequence:number;value:string}|null=null;
  do {
    const page: Awaited<ReturnType<NonNullable<typeof kit.store.findIndexed>>> = await kit.store.findIndexed!({key:'synthetic.index',values:['b','a','a'],kind:'action',through:lastPosition,limit:1,cursor});
    rows.push(...page.items);cursor=page.next;
  } while(cursor);
  assert.deepEqual(rows.map(row=>[row.value,row.position,row.record.digest]),[['a',firstPosition,first.digest],['b',firstPosition,first.digest],['b',lastPosition,second.digest]]);
  const frozen=await kit.store.findIndexed!({key:'synthetic.index',values:['a','b'],kind:'action',through:firstPosition,limit:10});
  assert.deepEqual(frozen.items.map(row=>row.record.digest),[first.digest,first.digest]);
  assert.equal(frozen.next,null);
  const absent=await kit.store.findIndexed!({key:'synthetic.index',values:['not-indexed'],kind:'action',through:lastPosition});
  assert.deepEqual(absent.items,[]);
});
