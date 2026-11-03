// A read operation owns its caches. Nothing survives its asynchronous boundary or participates in a write transaction.
// Invalidation sees writes through scopedRecordStore only. Raw artifacts/principals/knowledge writers are not universally hooked:
// finish the outer read scope before using them to write, then start a new scope for subsequent reads.
import {AsyncLocalStorage} from 'node:async_hooks';
import {types} from 'node:util';
import type {RecordStore,FindQuery,Page,StoredRecord,IndexEntry} from './api.ts';
interface Variant {methods:Set<PropertyKey>;proxy:object}
interface Scope {active:boolean;ports:WeakMap<object,Variant[]>;stores:WeakMap<object,RecordStore>;values:WeakMap<object,Map<string,Promise<unknown>>>;clearers:Set<()=>void>}
const scopes=new AsyncLocalStorage<Scope>();
export function withReadScope<T>(read:()=>T):T{
 if(scopes.getStore()?.active)return read();
 const scope:Scope={active:true,ports:new WeakMap(),stores:new WeakMap(),values:new WeakMap(),clearers:new Set()};
 const close=()=>{scope.active=false;for(const clear of scope.clearers)clear();};
 return scopes.run(scope,()=>{try{const result=read();if(result&&typeof (result as {then?:unknown}).then==='function')return Promise.resolve(result).finally(close) as T;close();return result;}catch(error){close();throw error;}});
}
const clone=<T>(value:T):T=>structuredClone(value);
/** Tagged JSON is injective for supported data, including undefined and -0. Unsupported graphs bypass the memo. */
function memoKey(value:unknown):string|null{
 const seen=new Set<object>();
 const encode=(value:unknown):unknown=>{
  if(value===undefined)return ['undefined'];
  if(value===null)return ['null'];
  if(typeof value==='string'||typeof value==='boolean')return [typeof value,value];
  if(typeof value==='number'&&Number.isFinite(value))return ['number',Object.is(value,-0)?'-0':value];
  if(typeof value!=='object')throw new TypeError('not JSON data');
  if(types.isProxy(value))throw new TypeError('not plain JSON');
  const prototype=Object.getPrototypeOf(value),array=Array.isArray(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw new TypeError('not plain JSON');
  if(seen.has(value))throw new TypeError('not a JSON tree');seen.add(value);
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if(array){
   const rows=[];if(keys.length!==(value as unknown[]).length+1)throw new TypeError('not a JSON array');
   for(let i=0;i<(value as unknown[]).length;i++){const field=descriptors[String(i)];if(!field||!field.enumerable||!('value'in field))throw new TypeError('not a JSON element');rows.push(encode(field.value));}
   return ['array',rows];
  }
  const fields=[];
  for(const key of keys){if(typeof key!=='string')throw new TypeError('not a JSON key');const field=descriptors[key];if(!field.enumerable||!('value'in field))throw new TypeError('not a JSON field');fields.push([key,encode(field.value)]);}
  return [prototype===null?'null-object':'object',fields];
 };
 try{return JSON.stringify(encode(value));}catch{return null;}
}
const findKey=(query:FindQuery)=>memoKey([query])===null?null:memoKey([query.kind,query.key,query.value,query.limit??50,query.cursor??null,query.newestFirst===true]);
/** Loader is control flow, not a memo argument. Only its explicit data key is memoized, within the caller's owner/scope. */
export async function memoReadValue<T>(owner:object,key:readonly unknown[],load:()=>Promise<T>):Promise<T>{
 const scope=scopes.getStore(),id=memoKey(key);if(!scope?.active||id===null)return load();
 let memo=scope.values.get(owner);if(!memo){memo=new Map();scope.values.set(owner,memo);const values=memo;scope.clearers.add(()=>values.clear());}
 let value=memo.get(id);if(!value){value=Promise.resolve().then(load);memo.set(id,value);const values=memo;value.catch(()=>{if(values.get(id)===value)values.delete(id);});}
 return value.then(result=>clone(result as T));
}
/** Only explicitly named, read-only methods may be memoized; callers keep every authorization predicate. */
export function memoReadPort<T extends object>(port:T,methods:readonly (keyof T)[]):T{
 const scope=scopes.getStore();if(!scope?.active)return port;
 const allowed=new Set<PropertyKey>(methods.map(key=>typeof key==='symbol'?key:String(key))),variants=scope.ports.get(port)??[];
 const existing=variants.find(variant=>variant.methods.size===allowed.size&&[...allowed].every(key=>variant.methods.has(key)));if(existing)return existing.proxy as T;
 const memos=new Map<PropertyKey,Map<string,Promise<unknown>>>();scope.clearers.add(()=>{for(const memo of memos.values())memo.clear();});
 const proxy=new Proxy(port,{get(target,key){const method=Reflect.get(target,key,target);if(typeof method!=='function')return method;
  if(!allowed.has(key))return method.bind(target);
  let memo=memos.get(key);if(!memo){memo=new Map();memos.set(key,memo);}const values=memo;
  return async(...args:unknown[])=>{if(!scope.active||scopes.getStore()!==scope)return method.apply(target,args);const id=memoKey(args);if(id===null)return method.apply(target,args);let value=values.get(id);if(!value){const snapshot=clone(args);value=Promise.resolve().then(()=>method.apply(target,snapshot));values.set(id,value);value.catch(()=>{if(values.get(id)===value)values.delete(id);});}return clone(await value);};
 }});variants.push({methods:allowed,proxy});scope.ports.set(port,variants);return proxy;
}
/** Verified records are batched once and copied for each caller, preserving the store's mutable-return isolation. */
export function scopedRecordStore(store:RecordStore):RecordStore{
 const scope=scopes.getStore();if(!scope?.active)return store;
 const old=scope.stores.get(store);if(old)return old;
 type CountQuery={index:readonly IndexEntry[];kind?:import('./api.ts').RecordKind;since?:string;cap?:number};
 let counts=new Map<string,Promise<{count:number;capped:boolean}>>();
 let pendingCounts=new Map<string,{query:CountQuery;resolve:(value:{count:number;capped:boolean})=>void;reject:(error:unknown)=>void}>();
 const flushCounts=async()=>{if(!pendingCounts.size)return;const batch=pendingCounts;pendingCounts=new Map();try{const input=[...batch.values()],rows=store.countIndexedBatch?await store.countIndexedBatch(input.map(p=>p.query)):await Promise.all(input.map(p=>store.countIndexed!(p.query)));input.forEach((p,i)=>p.resolve(rows[i]));}catch{await Promise.all([...batch.values()].map(async p=>{try{p.resolve(await store.countIndexed!(p.query));}catch(error){p.reject(error);}}));}};
 let gets=new Map<string,Promise<StoredRecord|null>>(),finds=new Map<string,Promise<Page<StoredRecord>>>(),other=new Map<string,Promise<unknown>>();
 let pendingGets=new Map<string,{resolve:(r:StoredRecord|null)=>void;reject:(e:unknown)=>void}>();
 let pendingFinds=new Map<string,{query:FindQuery;resolve:(r:Page<StoredRecord>)=>void;reject:(e:unknown)=>void}>();
 const flushGets=async()=>{if(!pendingGets.size)return;const batch=pendingGets;pendingGets=new Map();try{const rows=await store.getMany([...batch.keys()]);for(const [id,p]of batch)p.resolve(rows.get(id)??null);}catch{
  // A corrupt sibling must not make a healthy record unavailable merely because both reads were coalesced.
  await Promise.all([...batch].map(async([id,p])=>{try{p.resolve(await store.get(id));}catch(error){p.reject(error);}}));
 }};
 const flushFinds=async()=>{if(!pendingFinds.size)return;const batch=pendingFinds;pendingFinds=new Map();try{const input=[...batch.values()],rows=store.findBatch?await store.findBatch(input.map(p=>p.query)):await Promise.all(input.map(p=>store.find(p.query)));input.forEach((p,i)=>p.resolve(rows[i]));}catch{
  await Promise.all([...batch.values()].map(async p=>{try{p.resolve(await store.find(p.query));}catch(error){p.reject(error);}}));
 }};
 scope.clearers.add(()=>{
  // Detach queued batches before clearing memo identities: a new read across a write must not replace an old resolver.
  if(pendingGets.size)void flushGets();if(pendingFinds.size)void flushFinds();if(pendingCounts.size)void flushCounts();
  gets=new Map();finds=new Map();other=new Map();counts=new Map();
 });
 const clear=()=>{for(const invalidate of scope.clearers)invalidate();};
 const proxy=new Proxy(store,{get(target,key){
  if(key==='get')return async(id:string,tx?:unknown)=>{if(tx||typeof id!=='string'||!scope.active||scopes.getStore()!==scope)return target.get(id,tx as never);let value=gets.get(id);if(!value){value=new Promise((resolve,reject)=>{pendingGets.set(id,{resolve,reject});if(pendingGets.size===1)queueMicrotask(()=>{void flushGets();});});gets.set(id,value);value.catch(()=>{if(gets.get(id)===value)gets.delete(id);});}return clone(await value);};
  if(key==='find')return async(query:FindQuery,tx?:unknown)=>{if(tx||!scope.active||scopes.getStore()!==scope)return target.find(query,tx as never);const id=findKey(query);if(id===null)return target.find(query,tx as never);let value=finds.get(id);if(!value){value=new Promise((resolve,reject)=>{pendingFinds.set(id,{query:clone(query),resolve,reject});if(pendingFinds.size===1)queueMicrotask(()=>{void flushFinds();});});finds.set(id,value);value.catch(()=>{if(finds.get(id)===value)finds.delete(id);});}return clone(await value);};
  if(key==='countIndexed'&&target.countIndexed)return async(query:CountQuery,tx?:unknown)=>{if(tx||!scope.active||scopes.getStore()!==scope)return target.countIndexed!(query,tx as never);const id=memoKey([query]);if(id===null)return target.countIndexed!(query,tx as never);let value=counts.get(id);if(!value){value=new Promise((resolve,reject)=>{pendingCounts.set(id,{query:clone(query),resolve,reject});if(pendingCounts.size===1)queueMicrotask(()=>{void flushCounts();});});counts.set(id,value);value.catch(()=>{if(counts.get(id)===value)counts.delete(id);});}return clone(await value);};
  const method=Reflect.get(target,key,target);if(typeof method!=='function')return method;
  if(['put','addIndex','withTransaction'].includes(String(key)))return(...args:unknown[])=>{clear();const result=method.apply(target,args);return Promise.resolve(result).finally(clear);};
  if(['getMany','findMany','findFirstMany','getByKey','getById','list','runCandidates','entryTimes','entryCandidates'].includes(String(key)))return async(...args:unknown[])=>{
   if(args[1]||!scope.active||scopes.getStore()!==scope)return method.apply(target,args);const encoded=memoKey(args);if(encoded===null)return method.apply(target,args);const id=String(key)+encoded;let value=other.get(id);if(!value){const snapshot=clone(args);value=Promise.resolve().then(()=>method.apply(target,snapshot));other.set(id,value);value.catch(()=>{if(other.get(id)===value)other.delete(id);});}const result=await value;
   if(key==='getMany')for(const [digest,record]of result as Map<string,StoredRecord>)if(!gets.has(digest))gets.set(digest,Promise.resolve(record));
   return clone(result);
  };
  return method.bind(target);
 }});scope.stores.set(store,proxy);return proxy;
}
