import assert from 'node:assert/strict';
import {test} from 'node:test';
import {roundsUsedOf} from './submit.ts';
import type {EngineContext} from './deps.ts';
function context(details: Record<string,unknown>[]):EngineContext {
  return {deps:{records:{store:{find:async()=>({items:details.map(detail=>({body:{action:'validate',detail}})),next:null})}}}} as unknown as EngineContext;
}
test('revalidating the same digest excludes itself without hiding other attempts',async()=>{
  const ctx=context([{submission:'a',repair:['item']},{submission:'b',repair:['item']},{submission:'b',repair:['item']}]);
  assert.equal((await roundsUsedOf(ctx,'run','b')).get('item'),1);
  assert.equal((await roundsUsedOf(ctx,'run','a')).get('item'),1);
  assert.equal((await roundsUsedOf(ctx,'run','c')).get('item'),2);
  assert.equal((await roundsUsedOf(ctx,'run')).get('item'),2);
});
test('Hub errors and in-flight refusals remain outside the count',async()=>{
  const ctx=context([{submission:'a',repair:['item'],hub_error:true},{submission:'b',repair:['item'],refusal:'dispatch_in_flight'},{submission:'c',repair:['item']}]);
  assert.equal((await roundsUsedOf(ctx,'run','c')).size,0);
});
