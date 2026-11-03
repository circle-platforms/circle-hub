// A read operation owns its caches. Nothing survives its asynchronous boundary or participates in a write transaction.
// Ordinary scoped writes clear caches; destructive account/payload writes retire the request generation, including nested scopes.
// Other raw service writers still require callers to finish their outer scope before writing.
import {AsyncLocalStorage} from 'node:async_hooks';
import {ReadValues,plainFields} from './read-value.ts';
import type {RecordStore,FindQuery,Page,StoredRecord,IndexEntry} from './api.ts';
interface Variant {methods:Set<PropertyKey>;proxy:object}
interface Scope {active:boolean;generation:number;version:{current:number};ports:WeakMap<object,Variant[]>;stores:WeakMap<object,RecordStore>;values:WeakMap<object,Map<string,Promise<unknown>>>;clearers:Set<()=>void>;data:ReadValues;verified:Map<string,Array<{parts:readonly string[];value:unknown}>>}
const scopes=new AsyncLocalStorage<Scope>();
const current=(scope:Scope)=>scope.active&&scope.generation===scope.version.current;
const retired=(scope:Scope)=>scope.generation!==scope.version.current;
/** Retire retained adapters and pending frozen results after a destructive account or payload write. */
export function retireReadScope():void{const scope=scopes.getStore();if(!scope)return;scope.version.current++;for(const clear of scope.clearers)clear();}
export function withReadScope<T>(read:()=>T):T{
 const parent=scopes.getStore();if(parent&&current(parent))return read();
 const version=parent?.version??{current:0};
 const scope:Scope={active:true,generation:version.current,version,ports:new WeakMap(),stores:new WeakMap(),values:new WeakMap(),clearers:new Set(),data:new ReadValues(),verified:new Map()};
 scope.clearers.add(()=>{scope.verified.clear();scope.data.clear();});
 const close=()=>{scope.active=false;for(const clear of scope.clearers)clear();};
 return scopes.run(scope,()=>{try{const result=read();if(result&&typeof (result as {then?:unknown}).then==='function')return Promise.resolve(result).finally(close) as T;close();return result;}catch(error){close();throw error;}});
}
/** Key and execute every validated field, retaining known defaults and deterministic top-level member order. */
function findInput(data:ReadValues,query:FindQuery):{id:string;query:FindQuery}|null{
 const source=plainFields(query);if(!source)return null;
 const fields={...source,kind:source.kind,limit:source.limit??50,cursor:source.cursor??null,newestFirst:source.newestFirst===true};
 const normalized={key:source.key,value:source.value,...Object.fromEntries(Object.entries(fields).sort(([a],[b])=>a<b?-1:a>b?1:0))} as FindQuery;
 const input=data.prepare([normalized]);return input?{id:input.id,query:input.args[0]}:null;
}
/** A single snapshot supplies both the complete key and the deferred read input. */
export async function memoReadCall<K extends readonly unknown[],T>(owner:object,key:K,load:(snapshot:K)=>Promise<T>):Promise<T>{
 const scope=scopes.getStore();if(!scope||!current(scope))return load(key);
 const input=scope.data.prepare(key);if(!input)return load(key);
 let memo=scope.values.get(owner);if(!memo){memo=new Map();scope.values.set(owner,memo);const values=memo;scope.clearers.add(()=>values.clear());}
 const id=input.id;let value=memo.get(id);
 if(!value){value=Promise.resolve().then(()=>load(input.args)).then(result=>scope.data.freeze(result));memo.set(id,value);const values=memo;value.catch(()=>{if(values.get(id)===value)values.delete(id);});}
 const result=await value as T;return retired(scope)?load(input.args):result;
}
/** Loader is trusted control flow; only its explicit data key participates in the memo identity. */
export function memoReadValue<T>(owner:object,key:readonly unknown[],load:()=>Promise<T>):Promise<T>{return memoReadCall(owner,key,()=>load());}
/** Integrity is pure, but identity includes the exact normalized raw envelope, not just its claimed digest. */
export function verifiedReadValue<T>(parts:readonly string[],load:()=>T,transaction?:unknown):T{
 const scope=scopes.getStore();if(!scope||!current(scope)||transaction)return load();
 const entries=scope.verified.get(parts[0])??[],cached=entries.find(entry=>entry.parts.length===parts.length&&entry.parts.every((value,i)=>value===parts[i]));
 if(cached)return cached.value as T;
 const value=scope.data.freeze(load());entries.push({parts:[...parts],value});scope.verified.set(parts[0],entries);return value;
}
/** Only explicitly named, read-only methods may be memoized; callers keep every authorization predicate. */
export function memoReadPort<T extends object>(port:T,methods:readonly (keyof T)[]):T{
 const scope=scopes.getStore();if(!scope||!current(scope))return port;
 const allowed=new Set<PropertyKey>(methods.map(key=>typeof key==='symbol'?key:String(key))),variants=scope.ports.get(port)??[];
 const existing=variants.find(variant=>variant.methods.size===allowed.size&&[...allowed].every(key=>variant.methods.has(key)));if(existing)return existing.proxy as T;
 const memos=new Map<PropertyKey,Map<string,Promise<unknown>>>();scope.clearers.add(()=>{for(const memo of memos.values())memo.clear();});
 const proxy=new Proxy(port,{get(target,key){const method=Reflect.get(target,key,target);if(typeof method!=='function')return method;
  if(!allowed.has(key))return method.bind(target);
  let memo=memos.get(key);if(!memo){memo=new Map();memos.set(key,memo);}const values=memo;
  return async(...args:unknown[])=>{if(!current(scope)||scopes.getStore()!==scope)return method.apply(target,args);const input=scope.data.prepare(args);if(input===null)return method.apply(target,args);const id=input.id;let value=values.get(id);if(!value){value=Promise.resolve().then(()=>method.apply(target,input.args)).then(result=>scope.data.freeze(result));values.set(id,value);value.catch(()=>{if(values.get(id)===value)values.delete(id);});}const result=await value;return retired(scope)?method.apply(target,input.args):result;};
 }});variants.push({methods:allowed,proxy});scope.ports.set(port,variants);return proxy;
}
/** Verified records are batched once; every caller receives the same deeply immutable value. */
export function scopedRecordStore(store:RecordStore):RecordStore{
 const scope=scopes.getStore();if(!scope||!current(scope))return store;
 const old=scope.stores.get(store);if(old)return old;
 type CountQuery={index:readonly IndexEntry[];kind?:import('./api.ts').RecordKind;since?:string;cap?:number};
 let counts=new Map<string,Promise<{count:number;capped:boolean}>>();
 let pendingCounts=new Map<string,{query:CountQuery;resolve:(value:{count:number;capped:boolean})=>void;reject:(error:unknown)=>void}>();
 const flushCounts=async()=>{if(!pendingCounts.size)return;const batch=pendingCounts;pendingCounts=new Map();try{const input=[...batch.values()],rows=store.countIndexedBatch?await store.countIndexedBatch(input.map(p=>p.query)):await Promise.all(input.map(p=>store.countIndexed!(p.query)));input.forEach((p,i)=>p.resolve(scope.data.freeze(rows[i])));}catch{await Promise.all([...batch.values()].map(async p=>{try{p.resolve(scope.data.freeze(await store.countIndexed!(p.query)));}catch(error){p.reject(error);}}));}};
 let gets=new Map<string,Promise<StoredRecord|null>>(),finds=new Map<string,Promise<Page<StoredRecord>>>(),other=new Map<string,Promise<unknown>>();
 let pendingGets=new Map<string,{resolve:(r:StoredRecord|null)=>void;reject:(e:unknown)=>void}>();
 let pendingFinds=new Map<string,{query:FindQuery;resolve:(r:Page<StoredRecord>)=>void;reject:(e:unknown)=>void}>();
 const flushGets=async()=>{if(!pendingGets.size)return;const batch=pendingGets;pendingGets=new Map();try{const rows=await store.getMany([...batch.keys()]);for(const [id,p]of batch)p.resolve(scope.data.freeze(rows.get(id)??null));}catch{
  // A corrupt sibling must not make a healthy record unavailable merely because both reads were coalesced.
  await Promise.all([...batch].map(async([id,p])=>{try{p.resolve(scope.data.freeze(await store.get(id)));}catch(error){p.reject(error);}}));
 }};
 const flushFinds=async()=>{if(!pendingFinds.size)return;const batch=pendingFinds;pendingFinds=new Map();try{const input=[...batch.values()],rows=store.findBatch?await store.findBatch(input.map(p=>p.query)):await Promise.all(input.map(p=>store.find(p.query)));input.forEach((p,i)=>p.resolve(scope.data.freeze(rows[i])));}catch{
  await Promise.all([...batch.values()].map(async p=>{try{p.resolve(scope.data.freeze(await store.find(p.query)));}catch(error){p.reject(error);}}));
 }};
 scope.clearers.add(()=>{
  // Detach queued batches before clearing memo identities: a new read across a write must not replace an old resolver.
  if(pendingGets.size)void flushGets();if(pendingFinds.size)void flushFinds();if(pendingCounts.size)void flushCounts();
  gets=new Map();finds=new Map();other=new Map();counts=new Map();
 });
 const clear=()=>{for(const invalidate of scope.clearers)invalidate();};
 const proxy=new Proxy(store,{get(target,key){
  if(key==='get')return async(id:string,tx?:unknown)=>{if(tx||typeof id!=='string'||!current(scope)||scopes.getStore()!==scope)return target.get(id,tx as never);let value=gets.get(id);if(!value){value=new Promise((resolve,reject)=>{pendingGets.set(id,{resolve,reject});if(pendingGets.size===1)queueMicrotask(()=>{void flushGets();});});gets.set(id,value);value.catch(()=>{if(gets.get(id)===value)gets.delete(id);});}const result=await value;return retired(scope)?target.get(id):result;};
  if(key==='find')return async(query:FindQuery,tx?:unknown)=>{if(tx||!current(scope)||scopes.getStore()!==scope)return target.find(query,tx as never);const input=findInput(scope.data,query);if(input===null)return target.find(query,tx as never);const id=input.id;let value=finds.get(id);if(!value){value=new Promise((resolve,reject)=>{pendingFinds.set(id,{query:input.query,resolve,reject});if(pendingFinds.size===1)queueMicrotask(()=>{void flushFinds();});});finds.set(id,value);value.catch(()=>{if(finds.get(id)===value)finds.delete(id);});}const result=await value;return retired(scope)?target.find(input.query):result;};
  if(key==='countIndexed'&&target.countIndexed)return async(query:CountQuery,tx?:unknown)=>{if(tx||!current(scope)||scopes.getStore()!==scope)return target.countIndexed!(query,tx as never);const input=scope.data.prepare([query]);if(input===null)return target.countIndexed!(query,tx as never);const id=input.id;let value=counts.get(id);if(!value){value=new Promise((resolve,reject)=>{pendingCounts.set(id,{query:input.args[0],resolve,reject});if(pendingCounts.size===1)queueMicrotask(()=>{void flushCounts();});});counts.set(id,value);value.catch(()=>{if(counts.get(id)===value)counts.delete(id);});}const result=await value;return retired(scope)?target.countIndexed!(input.args[0]):result;};
  const method=Reflect.get(target,key,target);if(typeof method!=='function')return method;
  if(['put','addIndex','withTransaction'].includes(String(key)))return(...args:unknown[])=>{clear();const result=method.apply(target,args);return Promise.resolve(result).finally(clear);};
  if(['getMany','findMany','findFirstMany','getByKey','getById','list','runCandidates','entryTimes','entryCandidates'].includes(String(key)))return async(...args:unknown[])=>{
   if(args[1]||!current(scope)||scopes.getStore()!==scope)return method.apply(target,args);const input=scope.data.prepare(args);if(input===null)return method.apply(target,args);const id=String(key)+input.id,getCache=gets;let value=other.get(id);if(!value){value=Promise.resolve().then(()=>method.apply(target,input.args)).then(result=>scope.data.freeze(result));other.set(id,value);value.catch(()=>{if(other.get(id)===value)other.delete(id);});}const result=await value;
   if(retired(scope))return method.apply(target,input.args);
   if(key==='getMany'&&current(scope)&&gets===getCache)for(const [digest,record]of result as Map<string,StoredRecord>)if(!gets.has(digest))gets.set(digest,Promise.resolve(record));
   return result;
  };
  return method.bind(target);
 }});scope.stores.set(store,proxy);return proxy;
}
