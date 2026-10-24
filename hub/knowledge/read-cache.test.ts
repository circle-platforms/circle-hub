import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { withReadCache, currentReadCache } from './read-cache.ts';
import { Lru } from './store.ts';

test('read payloads reuse one cache inside a read and release it on success, rejection and late callbacks',async()=>{
  const cache=new Lru<string,object>(4,1024,true);
  let retained:ReturnType<typeof currentReadCache>;
  let late:(()=>void)|undefined;
  await withReadCache(async()=>{
    const value={synthetic:'owned by this read'};cache.set('root',value,50);
    assert.equal(cache.get('root'),value);assert.equal(cache.weight,50);
    await withReadCache(async()=>assert.equal(cache.get('root'),value));
    retained=currentReadCache();
    late=()=>cache.set('late',{synthetic:'late'},50);
    // Async work keeps this context even after the parent completes.
    const asyncResource=await import('node:async_hooks');
    late=asyncResource.AsyncResource.bind(late);
  });
  assert.equal(retained?.states.size,0);assert.equal(cache.size,0);assert.equal(cache.weight,0);
  late!();assert.equal(retained?.states.size,0);assert.equal(cache.size,0);
  await assert.rejects(withReadCache(async()=>{cache.set('error',{},100);throw new Error('synthetic failure');}),{message:'synthetic failure'});
  assert.equal(cache.size,0);assert.equal(cache.get('error'),undefined);
  cache.set('outside',{},10);assert.equal(cache.size,0,'payloads cannot become persistent when called without a read scope');
});

test('concurrent reads do not share root objects or clear each other caches',async()=>{
  const cache=new Lru<string,object>(4,1024,true);
  let entered!:()=>void,finish!:()=>void;
  const ready=new Promise<void>(r=>entered=r),released=new Promise<void>(r=>finish=r);
  const first={read:1},second={read:2};
  const pending=withReadCache(async()=>{cache.set('same-root',first);entered();await released;assert.equal(cache.get('same-root'),first);});
  await ready;
  await withReadCache(async()=>{assert.equal(cache.get('same-root'),undefined);cache.set('same-root',second);await setImmediate();assert.equal(cache.get('same-root'),second);});
  finish();await pending;assert.equal(cache.size,0);
});
