import assert from 'node:assert/strict';
import {test} from 'node:test';
import {withReadScope,retireReadScope} from '../../records/api.ts';
import type {EngineContext} from './deps.ts';
import {withQueryReads,queryRead} from './query-scope.ts';
const context=()=>({deps:{records:{store:{},artifacts:{}}}} as EngineContext);
test('query derivation shares complete input identities only within one read request and one engine',async()=>{
 const ctx=context(),other=context();let calls=0;const load=async()=>({value:++calls});
 await withReadScope(async()=>{
  await withQueryReads(ctx,async current=>{
   const first=await queryRead(current,['proof',{reader:'a',body:{capture:1}}],load);assert.throws(()=>{first.value=999;},TypeError);
   assert.deepEqual(await queryRead(current,['proof',{reader:'a',body:{capture:1}}],load),{value:1});
   assert.deepEqual(await queryRead(current,['proof',{reader:'b',body:{capture:1}}],load),{value:2});
   assert.deepEqual(await queryRead(current,['proof',{reader:'a',body:{capture:2}}],load),{value:3});
  });
  await withQueryReads(ctx,async current=>assert.deepEqual(await queryRead(current,['proof',{reader:'a',body:{capture:1}}],load),{value:1}));
  await withQueryReads(other,async current=>assert.deepEqual(await queryRead(current,['proof',{reader:'a',body:{capture:1}}],load),{value:4}));
 });
 await withQueryReads(ctx,async current=>assert.deepEqual(await queryRead(current,['proof',{reader:'a',body:{capture:1}}],load),{value:5}));
 assert.equal(calls,5);
});
test('query failures are evicted and escaped contexts never keep authorization after their scope ends',async()=>{
 const ctx=context();let current:EngineContext=ctx,calls=0;
 await withQueryReads(ctx,async scoped=>{
  current=scoped;
  await assert.rejects(queryRead(scoped,['proof'],async()=>{calls++;throw new Error('synthetic unavailable');}));
  assert.equal(await queryRead(scoped,['proof'],async()=>++calls),2);
 });
 assert.equal(await queryRead(current,['proof'],async()=>++calls),3);
 assert.equal(await queryRead(current,['proof'],async()=>++calls),4);
 // A write/admission context never installs a query cache.
 assert.equal(await queryRead(ctx,['proof'],async()=>++calls),5);
 assert.equal(await queryRead(ctx,['proof'],async()=>++calls),6);
});
test('proof input and cache identity are one snapshot even when caller input changes before the first await',async()=>{
 await withQueryReads(context(),async current=>{
  const input={reader:'member',capture:'private'};
  const proof=queryRead(current,['proof',input] as const,async([,snapshot])=>snapshot.reader==='administrator'||snapshot.capture==='public');
  input.reader='administrator';input.capture='public';
  assert.equal(await proof,false,'mutation never lends administrator authority to a member/private cache key');
  assert.equal(await queryRead(current,['proof',{reader:'member',capture:'private'}] as const,async()=>true),false);
 });
});

test('a frozen engine proof cache hit reloads its call-time input after generation retirement',async()=>{
 let deleted=false,calls=0;const seen:string[]=[];
 await withQueryReads(context(),async current=>{
  const load=async([,input]:readonly [string,{reader:string}])=>{calls++;seen.push(input.reader);return deleted?null:{body:{private:'synthetic proof'}};};
  const first=await queryRead(current,['proof',{reader:'owner'}] as const,load);assert.ok(Object.isFrozen(first!.body));
  assert.equal(await queryRead(current,['proof',{reader:'owner'}] as const,load),first);
  const input={reader:'owner'},pending=queryRead(current,['proof',input] as const,load);input.reader='other';deleted=true;retireReadScope();
  assert.equal(await pending,null);assert.deepEqual(seen,['owner','owner']);assert.equal(calls,2);
 });
});
