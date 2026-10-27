import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRegistry, createDocumentCache, resolveReference, type ParsedDocument } from './api.ts';

function document(initial: number) {
  let bytes = initial;
  const listeners = new Set<() => void>();
  const value = {
    parser: 'synthetic@1', model: {}, summary: () => ({}), listSelectors: () => [], locate: () => null,
    retainedBytes: () => bytes,
    onRetainedBytesChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } satisfies ParsedDocument;
  return {value, resize(next: number) {bytes=next;for(const listener of listeners)listener();}, listeners};
}

test('the document cache applies byte budget and LRU independently of the entry limit', () => {
  const cache=createDocumentCache(10,100),a=document(45),b=document(45),c=document(45);
  cache.set('a',a.value);cache.set('b',b.value);assert.equal(cache.get('a'),a.value);
  cache.set('c',c.value);assert.equal(cache.get('b'),undefined);assert.equal(cache.get('a'),a.value);assert.equal(cache.get('c'),c.value);
  assert.equal(b.listeners.size,0);
  const oversized=document(101);
  assert.throws(()=>cache.set('large',oversized.value),{code:'SANDBOX_OUTPUT_TOO_LARGE',detail:{limit:'document_cache_bytes'}});
  assert.throws(()=>cache.get('large'),{code:'SANDBOX_OUTPUT_TOO_LARGE'});assert.equal(oversized.listeners.size,0);
});

test('growth of a lazy fragment cache immediately evicts entries over the byte budget', () => {
  const cache=createDocumentCache(10,100),a=document(30),b=document(30);
  cache.set('a',a.value);cache.set('b',b.value);a.resize(80);
  assert.equal(cache.get('a'),undefined);assert.equal(cache.get('b'),b.value);assert.equal(a.listeners.size,0);
  cache.dispose!();assert.equal(b.listeners.size,0);
});

test('legacy parser documents remain usable under conservative byte accounting', () => {
  const legacy={parser:'legacy@1',model:{nodes:['synthetic']},summary:()=>({}),listSelectors:()=>[],locate:()=>null} satisfies ParsedDocument;
  const roomy=createDocumentCache(2);roomy.set('old',legacy);assert.equal(roomy.get('old'),legacy);
  const small=createDocumentCache(2,1024);assert.throws(()=>small.set('old',legacy),{code:'SANDBOX_OUTPUT_TOO_LARGE'});
});

test('a single growing document over the budget fails explicitly and cannot cause repeated parses',async()=>{
  const cache=createDocumentCache(2,100),doc=document(50);cache.set('one',doc.value);
  assert.throws(()=>doc.resize(101),{code:'SANDBOX_OUTPUT_TOO_LARGE',detail:{limit:'document_cache_bytes'}});
  let parsed=0;
  await assert.rejects(cache.load!('one',async()=>{parsed++;return doc.value;}),{code:'SANDBOX_OUTPUT_TOO_LARGE'});
  assert.equal(parsed,0);cache.dispose!();
});

test('at most two different parses are in flight while identical loads coalesce', async () => {
  const cache=createDocumentCache(10,1024),releases:Array<()=>void>=[];let inFlight=0,peak=0,calls=0;
  const parse=async()=>{calls++;inFlight++;peak=Math.max(peak,inFlight);await new Promise<void>(r=>releases.push(r));inFlight--;return document(10).value;};
  const a=cache.load!('a',parse),again=cache.load!('a',parse),b=cache.load!('b',parse),c=cache.load!('c',parse);
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.equal(peak,2);
  releases.shift()!();await a;await again;await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(calls,3);
  for(const release of releases)release();await Promise.all([b,c]);assert.equal(peak,2);
});

test('one monotonic deadline is shared by documents throughout a request', async () => {
  const cache=createDocumentCache(10,1024,40), deadlines:number[]=[];
  const first={...document(10).value,setOperationDeadline:(deadline:number)=>deadlines.push(deadline)};
  const second={...document(10).value,setOperationDeadline:(deadline:number)=>deadlines.push(deadline)};
  cache.set('first',first);
  cache.set('second',second);
  assert.equal(deadlines.length,2);
  assert.equal(deadlines[0],deadlines[1]);
  await new Promise<void>(resolve=>setTimeout(resolve,50));
  assert.throws(()=>cache.get('first'),{code:'SANDBOX_TIMEOUT'});
  await assert.rejects(cache.load!('later',async()=>document(10).value),{code:'SANDBOX_TIMEOUT'});
});

test('a blocked parse returns at the request deadline and late completion cannot fill the cache', async () => {
  const cache=createDocumentCache(10,1024,30);
  let release!:()=>void;
  const parsed=cache.load!('a',async()=>{await new Promise<void>(resolve=>{release=resolve;});return document(10).value;});
  await assert.rejects(parsed,{code:'SANDBOX_TIMEOUT'});
  release();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.throws(()=>cache.get('a'),{code:'SANDBOX_TIMEOUT'});
  cache.dispose!();
});

test('a stalled source read shares the reference operation deadline',async()=>{
  const cache=createDocumentCache(2,1024,30);
  const reference='src:'+'a'.repeat(64)+'/text@1/l/1';
  let reads=0;
  const context={
    reader:{user:'synthetic',role:'user'},parsers:createDefaultRegistry(),documents:cache,
    sources:{read:()=>{reads++;return new Promise<null>(()=>{});}},
  } as const;
  await assert.rejects(resolveReference(reference,context),{code:'SANDBOX_TIMEOUT'});
  await assert.rejects(resolveReference(reference,context),{code:'SANDBOX_TIMEOUT'});
  assert.equal(reads,1,'deadline exhaustion does not start another source read');
  cache.dispose!();
});

test('a legacy document is weighed once and later eviction uses that stored weight', async () => {
  let reads = 0;
  const model: { body?: string } = {};
  Object.defineProperty(model, 'body', { enumerable: true, get() { reads += 1; return reads === 1 ? 'ok' : 'z'.repeat(8_000_000); } });
  const legacy = { parser: 'legacy@1', model, summary: () => ({}), listSelectors: () => [], locate: () => null } satisfies ParsedDocument;
  const budget = 24 * 1024 * 1024;
  const cache = createDocumentCache(4, budget);
  cache.set('kept', legacy);
  for (let i = 0; i < 16; i++) assert.equal(cache.get('kept'), legacy);
  for (let i = 0; i < 16; i++) assert.equal(await cache.load!('kept', async () => { throw new Error('cached document was parsed again'); }), legacy);
  cache.set('kept', legacy);
  assert.equal(reads, 1);
  const other = { parser: 'legacy@1', model: { note: 'synthetic' }, summary: () => ({}), listSelectors: () => [], locate: () => null } satisfies ParsedDocument;
  cache.set('other', other);
  assert.equal(cache.get('kept'), undefined);
  assert.equal(cache.get('other'), other);
  assert.equal(reads, 1);
  let heavyReads = 0;
  const heavyModel: { body?: string } = {};
  Object.defineProperty(heavyModel, 'body', { enumerable: true, get() { heavyReads += 1; return 'z'.repeat(8_000_000); } });
  const heavy = { parser: 'legacy@1', model: heavyModel, summary: () => ({}), listSelectors: () => [], locate: () => null } satisfies ParsedDocument;
  const full = createDocumentCache(2, budget);
  assert.throws(() => full.set('heavy', heavy), { code: 'SANDBOX_OUTPUT_TOO_LARGE', detail: { limit: 'document_cache_bytes' } });
  assert.equal(heavyReads, 1);
  assert.throws(() => full.get('heavy'), { code: 'SANDBOX_OUTPUT_TOO_LARGE' });
  assert.equal(heavyReads, 1);
});

test('a completed read cannot be used after the shared deadline even if the event loop was blocked',async()=>{
  const cache=createDocumentCache(2,1024,20);
  const result=cache.within!(Promise.resolve('synthetic'));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);
  await assert.rejects(result,{code:'SANDBOX_TIMEOUT'});
  cache.dispose!();
});
