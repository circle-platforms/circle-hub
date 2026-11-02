// A read operation owns its caches. Nothing survives its asynchronous boundary or participates in a write transaction.
import {AsyncLocalStorage} from 'node:async_hooks';
import type {RecordStore,FindQuery,Page,StoredRecord} from './api.ts';
interface Scope {active:boolean;ports:WeakMap<object,object>;clearers:Set<()=>void>}
const scopes=new AsyncLocalStorage<Scope>();
export function withReadScope<T>(read:()=>T):T{
 if(scopes.getStore()?.active)return read();
 const scope:Scope={active:true,ports:new WeakMap(),clearers:new Set()};
 const close=()=>{scope.active=false;for(const clear of scope.clearers)clear();};
 return scopes.run(scope,()=>{try{const result=read();if(result&&typeof (result as {then?:unknown}).then==='function')return Promise.resolve(result).finally(close) as T;close();return result;}catch(error){close();throw error;}});
}
const clone=<T>(value:T):T=>structuredClone(value);
const findKey=(q:FindQuery)=>JSON.stringify([q.kind??null,q.key,q.value,q.limit??50,q.cursor??null,q.newestFirst===true]);
/** Only explicitly named, read-only methods may be memoized; callers keep every authorization predicate. */
export function memoReadPort<T extends object>(port:T,methods:readonly (keyof T)[]):T{
 const scope=scopes.getStore();if(!scope?.active)return port;
 const existing=scope.ports.get(port);if(existing)return existing as T;
 const allowed=new Set<PropertyKey>(methods);const memo=new Map<string,Promise<unknown>>();scope.clearers.add(()=>memo.clear());
 const proxy=new Proxy(port,{get(target,key){const method=Reflect.get(target,key,target);if(typeof method!=='function')return method;
  if(!allowed.has(key))return method.bind(target);
  return async(...args:unknown[])=>{if(!scope.active||scopes.getStore()!==scope)return method.apply(target,args);const id=String(key)+JSON.stringify(args);let value=memo.get(id);if(!value){value=Promise.resolve().then(()=>method.apply(target,args));memo.set(id,value);value.catch(()=>{if(memo.get(id)===value)memo.delete(id);});}return clone(await value);};
 }});scope.ports.set(port,proxy);return proxy;
}
/** Verified records are batched once and copied for each caller, preserving the store's mutable-return isolation. */
export function scopedRecordStore(store:RecordStore):RecordStore{
 const scope=scopes.getStore();if(!scope?.active)return store;
 const old=scope.ports.get(store);if(old)return old as RecordStore;
 let gets=new Map<string,Promise<StoredRecord|null>>(),finds=new Map<string,Promise<Page<StoredRecord>>>(),other=new Map<string,Promise<unknown>>();
 let pendingGets=new Map<string,{resolve:(r:StoredRecord|null)=>void;reject:(e:unknown)=>void}>();
 let pendingFinds=new Map<string,{query:FindQuery;resolve:(r:Page<StoredRecord>)=>void;reject:(e:unknown)=>void}>();
 const flushGets=async()=>{const batch=pendingGets;pendingGets=new Map();try{const rows=await store.getMany([...batch.keys()]);for(const [id,p]of batch)p.resolve(rows.get(id)??null);}catch{
  // A corrupt sibling must not make a healthy record unavailable merely because both reads were coalesced.
  await Promise.all([...batch].map(async([id,p])=>{try{p.resolve(await store.get(id));}catch(error){p.reject(error);}}));
 }};
 const flushFinds=async()=>{const batch=pendingFinds;pendingFinds=new Map();try{const input=[...batch.values()],rows=store.findBatch?await store.findBatch(input.map(p=>p.query)):await Promise.all(input.map(p=>store.find(p.query)));input.forEach((p,i)=>p.resolve(rows[i]));}catch{
  await Promise.all([...batch.values()].map(async p=>{try{p.resolve(await store.find(p.query));}catch(error){p.reject(error);}}));
 }};
 scope.clearers.add(()=>{gets=new Map();finds=new Map();other=new Map();});
 const clear=()=>{for(const invalidate of scope.clearers)invalidate();};
 const proxy=new Proxy(store,{get(target,key){
  if(key==='get')return async(id:string,tx?:unknown)=>{if(tx||!scope.active||scopes.getStore()!==scope)return target.get(id,tx as never);let value=gets.get(id);if(!value){value=new Promise((resolve,reject)=>{pendingGets.set(id,{resolve,reject});if(pendingGets.size===1)queueMicrotask(()=>{void flushGets();});});gets.set(id,value);value.catch(()=>{if(gets.get(id)===value)gets.delete(id);});}return clone(await value);};
  if(key==='find')return async(query:FindQuery,tx?:unknown)=>{if(tx||!scope.active||scopes.getStore()!==scope)return target.find(query,tx as never);const id=findKey(query);let value=finds.get(id);if(!value){value=new Promise((resolve,reject)=>{pendingFinds.set(id,{query,resolve,reject});if(pendingFinds.size===1)queueMicrotask(()=>{void flushFinds();});});finds.set(id,value);value.catch(()=>{if(finds.get(id)===value)finds.delete(id);});}return clone(await value);};
  const method=Reflect.get(target,key,target);if(typeof method!=='function')return method;
  if(['put','addIndex','withTransaction'].includes(String(key)))return(...args:unknown[])=>{clear();const result=method.apply(target,args);return Promise.resolve(result).finally(clear);};
  if(['getMany','findMany','findFirstMany','getByKey','getById','list','runCandidates','countIndexed'].includes(String(key)))return async(...args:unknown[])=>{
   if(args[1]||!scope.active||scopes.getStore()!==scope)return method.apply(target,args);const id=String(key)+JSON.stringify(args);let value=other.get(id);if(!value){value=Promise.resolve().then(()=>method.apply(target,args));other.set(id,value);value.catch(()=>{if(other.get(id)===value)other.delete(id);});}const result=await value;
   if(key==='getMany')for(const [digest,record]of result as Map<string,StoredRecord>)if(!gets.has(digest))gets.set(digest,Promise.resolve(record));
   return clone(result);
  };
  return method.bind(target);
 }});scope.ports.set(store,proxy);return proxy;
}
