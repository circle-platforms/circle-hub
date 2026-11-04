// Immutable results and single-pass JSON argument snapshots for one asynchronous read scope.
import {createHash} from 'node:crypto';
import {types} from 'node:util';
const readonlyCollections=new WeakSet<object>();
const readonlyError=Object.freeze(()=>{throw new TypeError('A cached read value is immutable; copy it before editing');});
interface Argument {snapshot:unknown;encoded:string}
/**
 * An argument encoded at this length or longer enters a memo key as its SHA-256. A key can name a whole run and result, and
 * every concurrent caller holds its own key while it waits: thousands of callers of a megabyte key filled the heap.
 */
const LONG_KEY=1024;
const keyText=(encoded:string):string=>encoded.length<LONG_KEY?encoded:'["sha256","'+createHash('sha256').update(encoded).digest('hex')+'"]';
/** Deeply freezes what JSON.parse made: plain objects, arrays and data, so nothing ReadValues checks for can be there. */
function freezeParsed(value:unknown):void{
 if(value===null||typeof value!=='object')return;
 if(Array.isArray(value))for(const item of value)freezeParsed(item);
 else for(const key of Object.keys(value))freezeParsed((value as Record<string,unknown>)[key]);
 Object.freeze(value);
}
export class ReadValues{
 #frozen=new WeakMap<object,unknown>();
 #names=new WeakMap<object,number>();
 #named=0;
 clear(){this.#frozen=new WeakMap();this.#names=new WeakMap();}
 freeze<T>(value:T):T{
  const added:object[]=[];try{return this.#freeze(value,added);}catch(error){for(const item of added)this.#frozen.delete(item);throw error;}
 }
 /** A verified record: plain metadata around a parsed body. Every read passes here, so it skips the checks of an unknown value. */
 freezeRecord<T extends {body:unknown}>(record:T):T{
  freezeParsed(record);this.#frozen.set(record,record);
  if(record.body!==null&&typeof record.body==='object')this.#frozen.set(record.body,record.body);
  return record;
 }
 #freeze<T>(value:T,added:object[]):T{
  // A prior freeze may have installed our fixed, frozen collection guard on the producer's shell.
  if(typeof value==='function'&&value!==readonlyError)throw new TypeError('Cached reads require data');
  if(value===null||typeof value!=='object')return value;
  if(this.#frozen.has(value))return this.#frozen.get(value) as T;
  if(readonlyCollections.has(value)){this.#frozen.set(value,value);added.push(value);return value;}
  if(types.isProxy(value)||ArrayBuffer.isView(value)||value instanceof ArrayBuffer||value instanceof SharedArrayBuffer)throw new TypeError('Mutable binary or opaque read values must stay outside the memo');
  if(value instanceof Map||value instanceof Set){
   const map=value instanceof Map,mutators=map?['set','delete','clear']:['add','delete','clear'];
   const reads=map?['get','has','entries','keys','values']:['has','entries','keys','values','difference','intersection','union','symmetricDifference','isSubsetOf','isSupersetOf','isDisjointFrom'];
   // Object.freeze cannot seal native collection slots. A single private collection snapshot prevents raw producer aliases
   // and borrowed Map/Set.prototype mutators from changing the shared cached view.
   const backing=map?new Map():new Set(),methods=new Map<PropertyKey,unknown>();let proxy:Map<unknown,unknown>|Set<unknown>;
   proxy=new Proxy(backing,{get(target,key){
    if(mutators.includes(String(key)))return readonlyError;
    if(key==='forEach'){let method=methods.get(key);if(!method){method=Object.freeze((callback:Function,thisArg?:unknown)=>target.forEach((v:unknown,k:unknown)=>callback.call(thisArg,v,k,proxy)));methods.set(key,method);}return method;}
    if(key===Symbol.iterator||reads.includes(String(key))){let method=methods.get(key);if(!method){method=Object.freeze(Reflect.get(target,key,target).bind(target));methods.set(key,method);}return method;}
    return Reflect.get(target,key,key==='size'?target:proxy);
   }});
   this.#frozen.set(value,proxy);this.#frozen.set(proxy,proxy);added.push(value,proxy);
   if(map)for(const [key,item]of value)Map.prototype.set.call(backing,this.#freeze(key,added),this.#freeze(item,added));
   else for(const item of value)Set.prototype.add.call(backing,this.#freeze(item,added));
   for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key)!;if(!('value'in d))throw new TypeError('Cached reads require data properties');Object.defineProperty(backing,key,{...d,value:this.#freeze(d.value,added)});}
   for(const key of mutators){Object.defineProperty(backing,key,{value:readonlyError,configurable:false,writable:false});if(Object.isExtensible(value))Object.defineProperty(value,key,{value:readonlyError,configurable:false,writable:false});}
   Object.freeze(value);Object.freeze(backing);readonlyCollections.add(proxy);return proxy as T;
  }
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null&&prototype!==Array.prototype)throw new TypeError('Cached reads require plain data or readonly collections');
  this.#frozen.set(value,value);added.push(value);
  for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key)!;if(!('value'in d))throw new TypeError('Cached reads require data properties');const item=this.#freeze(d.value,added);if(item!==d.value)Object.defineProperty(value,key,{...d,value:item});}
  Object.freeze(value);return value;
 }
 #name(value:object):number{let name=this.#names.get(value);if(name===undefined){name=++this.#named;this.#names.set(value,name);}return name;}
 /** The encoding and executed arguments are derived from the same descriptor values, without invoking getters. */
 prepare<K extends readonly unknown[]>(args:K):{id:string;args:K}|null{
  const seen=new Set<object>();
  const visit=(value:unknown):Argument=>{
   if(value===undefined)return {snapshot:value,encoded:'["undefined"]'};
   if(value===null)return {snapshot:value,encoded:'["null"]'};
   if(typeof value==='string'||typeof value==='boolean')return {snapshot:value,encoded:JSON.stringify([typeof value,value])};
   if(typeof value==='number'&&Number.isFinite(value))return {snapshot:value,encoded:JSON.stringify(['number',Object.is(value,-0)?'-0':value])};
   if(typeof value!=='object'||types.isProxy(value))throw new TypeError('not plain JSON');
   // A value this scope froze cannot change and one read gives it one identity, so the identity is its key. Spelling out a
   // whole run and result to name them cost a third of a console page; an equal copy at worst reads once more.
   if(this.#frozen.get(value)===value){if(seen.has(value))throw new TypeError('not a JSON tree');seen.add(value);return {snapshot:value,encoded:`["frozen",${this.#name(value)}]`};}
   const prototype=Object.getPrototypeOf(value),array=Array.isArray(value);
   if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw new TypeError('not plain JSON');
   if(seen.has(value))throw new TypeError('not a JSON tree');seen.add(value);
   const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
   const snapshot:any=array?[]:Object.create(prototype),encoded:string[]=[];
   const field=(key:string)=>{const d=descriptors[key];if(!d||!d.enumerable||!('value'in d))throw new TypeError('not a JSON field');const item=visit(d.value);Object.defineProperty(snapshot,key,{value:item.snapshot,enumerable:true,writable:true,configurable:true});return item.encoded;};
   if(array){if(keys.length!==(value as unknown[]).length+1)throw new TypeError('not a JSON array');for(let i=0;i<(value as unknown[]).length;i++)encoded.push(field(String(i)));}
   else for(const key of keys){if(typeof key!=='string')throw new TypeError('not a JSON key');encoded.push('['+JSON.stringify(key)+','+field(key)+']');}
   return {snapshot,encoded:'["'+(array?'array':prototype===null?'null-object':'object')+'",['+encoded.join(',')+']]'};
  };
  try{
   // The rest/key array is private to this call.
   if(types.isProxy(args)||Object.getPrototypeOf(args)!==Array.prototype)throw new TypeError('not a JSON array');
   const root=Object.getOwnPropertyDescriptors(args);if(Reflect.ownKeys(root).length!==args.length+1)throw new TypeError('not a JSON array');
   const snapshots:unknown[]=[],encoded:string[]=[];seen.add(args);
   for(let i=0;i<args.length;i++){const d=root[String(i)];if(!d||!d.enumerable||!('value'in d))throw new TypeError('not a JSON element');const arg=d.value;const item=visit(arg);snapshots.push(item.snapshot);encoded.push(keyText(item.encoded));}
   return {id:'["array",['+encoded.join(',')+']]',args:snapshots as unknown as K};
  }catch{return null;}
 }
}
/** Validate only the root before normalizing find defaults; descendants are visited exactly once by prepare. */
export function plainFields(value:unknown):Record<string,unknown>|null{
 if(!value||typeof value!=='object'||types.isProxy(value))return null;
 const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return null;
 const fields=Object.create(null);
 for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key)!;if(typeof key!=='string'||!d.enumerable||!('value'in d))return null;Object.defineProperty(fields,key,{value:d.value,enumerable:true});}
 return fields;
}
