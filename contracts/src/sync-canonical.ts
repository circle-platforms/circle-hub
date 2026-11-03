// Portable sync encoding reference. No server, storage, client state or locale dependencies.
import {createHash} from 'node:crypto';
import {PersonalSyncObject,PERSONAL_SYNC_LIMITS} from './sync.ts';
import {parseStrictJson} from './sync-json.ts';
export function normalizePersonalSyncText(value:string):string{
 if(!value.isWellFormed())throw new TypeError('Malformed Unicode');
 return value.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').normalize('NFC');
}
function canonical(value:unknown,depth=0):string{
 if(depth>64)throw new TypeError('Sync nesting limit');
 if(value===null)return 'null';
 if(typeof value==='string')return JSON.stringify(normalizePersonalSyncText(value));
 if(typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isFinite(value))throw new TypeError('Non-finite number');return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
 if(value&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)){
  const mapped=new Map<string,unknown>();
  for(const [key,item]of Object.entries(value)){const normalized=normalizePersonalSyncText(key);if(mapped.has(normalized))throw new TypeError('Normalized member collision');mapped.set(normalized,item);}
  return '{'+[...mapped.keys()].sort().map(k=>JSON.stringify(k)+':'+canonical(mapped.get(k),depth+1)).join(',')+'}';
 }
 throw new TypeError('Non-JSON sync value');
}
export function encodePersonalSyncObject(input:unknown):Uint8Array{
 // Validate without using Zod's transformed output: defaults must not silently alter input identities.
 PersonalSyncObject.parse(input);
 const bytes=Buffer.from(canonical(input));
 if(bytes.length>PERSONAL_SYNC_LIMITS.objectBytes)throw new RangeError('Sync object size');
 PersonalSyncObject.parse(JSON.parse(bytes.toString('utf8')));
 return bytes;
}
export function personalSyncObjectId(input:unknown):string{return createHash('sha256').update(encodePersonalSyncObject(input)).digest('hex');}
export function decodePersonalSyncObject(bytes:Uint8Array,expected:string):PersonalSyncObject{
 if(bytes.byteLength>PERSONAL_SYNC_LIMITS.objectBytes)throw new RangeError('Sync object size');
 if(!/^[0-9a-f]{64}$/.test(expected))throw new TypeError('Invalid object identity');
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
 const value=parseStrictJson(text),encoded=encodePersonalSyncObject(value);
 if(!Buffer.from(bytes).equals(encoded))throw new TypeError('Noncanonical sync object');
 if(createHash('sha256').update(encoded).digest('hex')!==expected)throw new TypeError('Sync object hash mismatch');
 return PersonalSyncObject.parse(value);
}
