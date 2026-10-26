// Structural equality over explicit declarations; no title, wording, spelling or semantic similarity enters the key.
import {createHash} from 'node:crypto';
import {fromJSONSchema} from 'zod';
import COMMAND from '../tables/command-identity.schema.json' with {type:'json'};
import EXPECTED from '../tables/expected-quote-identity.schema.json' with {type:'json'};
import POLICY from '../tables/case-structure-rules.json' with {type:'json'};
import type {CommandIdentity,ExpectedQuoteIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import type {CatalogEntry} from '../../../../contracts/src/tables.ts';
const Command=fromJSONSchema(COMMAND as Parameters<typeof fromJSONSchema>[0]),Expected=fromJSONSchema(EXPECTED as Parameters<typeof fromJSONSchema>[0]);
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
function argument(raw:string):string|null {if(!raw.length||/[\r\n\u0000]/.test(raw))return null;if(raw[0]!=="'"&&raw[0]!=='"')return /[ \t]/.test(raw)?null:raw;const quote=raw[0];let value='';for(let at=1;at<raw.length;at++){const c=raw[at];if(c===quote)return at===raw.length-1?value:null;if(c==='\\'){if(raw[at+1]!==quote&&raw[at+1]!=='\\')return null;value+=raw[++at];}else value+=c;}return null;}
export function commandIdentity(value:unknown,catalog?:CatalogEntry[]):CommandIdentity|null {
 const r=Command.safeParse(value);if(!r.success)return null;const i=r.data as CommandIdentity;
 const source=i.signature.startsWith('src:')?i.signature.slice(4).split('/')[0]:i.signature.startsWith('tree:')?i.signature.slice(5).split('/')[0]:null;
 if(source!==i.tree_root||new Set(i.parameters.map(p=>p.position)).size!==i.parameters.length)return null;
 for(const p of i.parameters){const raw=argument(p.raw);if(raw===null)return null;const type=p.type.catalog_type,parsed=p.parsed;
  if(type==='int'||type==='port'){if(parsed.kind!=='int'||! /^-?[0-9]+$/.test(raw)||Number(raw)!==parsed.value)return null;}
  else if(type==='ipv4'||type==='ipv6'||type==='mask'){if(parsed.kind!=='address'||parsed.value.kind!==type||parsed.value.value!==raw)return null;}
  else if(type==='ip_or_hostname'){if(parsed.kind==='address'){if(parsed.value.kind!=='ipv4'&&parsed.value.kind!=='ipv6'||parsed.value.value!==raw)return null;}else if(parsed.kind!=='text'||parsed.value!==raw)return null;}
  else if(!type||parsed.kind!=='text'||parsed.value!==raw)return null;
 }
 if(catalog){const entry=catalog.find(e=>e.reference.startsWith('tree:')&&e.reference.slice(69).split('@')[0]===i.path);const signature=entry?.signatures.find(s=>s.reference===i.signature);if(!signature)return null;
  if(signature.params.some((p,position)=>p.type===undefined||p.unchecked_constraints?.length||!p.native_type||p.optional!==true&&!i.parameters.some(v=>v.position===position)))return null;
  for(const p of i.parameters){const declared=signature.params[p.position];if(!declared?.native_type||p.name!==declared.name||p.type.catalog_type!==declared.type||p.type.name!==declared.native_type.name||p.type.declaration!==declared.native_type.declaration||p.type.grammar!==declared.native_type.grammar)return null;
   const value=argument(p.raw)!,t=declared.type;
   if((t==='int'||t==='port')&&(declared.minimum!==undefined&&Number(value)<declared.minimum||declared.maximum!==undefined&&Number(value)>declared.maximum||t==='port'&&(Number(value)<0||Number(value)>65535)))return null;
   if(t==='enum'&&!declared.values?.includes(value)||t==='keyword'&&value!==(declared.keyword??declared.name))return null;
   if(declared.minLength!==undefined&&[...value].length<declared.minLength||declared.maxLength!==undefined&&[...value].length>declared.maxLength)return null;
   if(t==='mask'&&!/^1*0*$/.test(value.split('.').map(v=>Number(v).toString(2).padStart(8,'0')).join('')))return null;
   if(t==='hostname'||t==='ip_or_hostname'&&p.parsed.kind==='text'){const host=value.endsWith('.')?value.slice(0,-1):value;if(!host.length||host.length>253||!host.split('.').every(v=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(v)))return null;}
  }
 }
 return i;
}
export function expectedIdentity(value:unknown):ExpectedQuoteIdentity|null {const r=Expected.safeParse(value);return r.success?r.data as ExpectedQuoteIdentity:null;}
export function structure(value:unknown,catalog?:CatalogEntry[]):{key:string;commands:CommandIdentity[];expected:Array<{after:number;quote:ExpectedQuoteIdentity}>}|null {
 if(!object(value)||value.schema!==POLICY.structure_schema||!Array.isArray(value.commands)||!value.commands.length||!Array.isArray(value.expected)||!value.expected.length)return null;
 const commands=value.commands.map(c=>commandIdentity(c,catalog));if(commands.some(c=>c===null))return null;
 const expected=value.expected.map(v=>{if(!object(v)||!Number.isSafeInteger(v.after)||Number(v.after)<1||Number(v.after)>commands.length)return null;const q=expectedIdentity(v.quote);return q?{after:Number(v.after),quote:q}:null;});if(expected.some(e=>e===null))return null;
 const projection={commands:(commands as CommandIdentity[]).map(i=>[i.tree_root,i.path,i.signature,[...i.parameters].sort((a,b)=>a.position-b.position).map(p=>[p.position,p.name,[p.type.name,p.type.grammar,p.type.declaration],p.parsed])]),expected};
 return {key:createHash('sha256').update(JSON.stringify(canonical(projection))).digest('hex'),commands:commands as CommandIdentity[],expected:expected as Array<{after:number;quote:ExpectedQuoteIdentity}>};
}
export function draftStructure(draft:Record<string,unknown>,catalog?:CatalogEntry[]){const steps=Array.isArray(draft.steps)?draft.steps:[],expected=Array.isArray(draft.expected)?draft.expected:[];return structure({schema:POLICY.structure_schema,commands:steps.map(s=>object(s)?s.identity:undefined),expected:expected.map(e=>object(e)?{after:e.after,quote:e.identity}:undefined)},catalog);}
export const STRUCTURE_RULE=POLICY.id;
