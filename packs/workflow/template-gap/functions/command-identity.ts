// Structural identity from the product producer. No command text is parsed or guessed here.
import { fromJSONSchema } from 'zod';
import SCHEMA from '../tables/command-identity.schema.json' with {type:'json'};
import type { CommandIdentity } from '../../../../contracts/generated/shared-interfaces.ts';
const Identity = fromJSONSchema(SCHEMA as Parameters<typeof fromJSONSchema>[0]);
export function readCommandIdentity(value:unknown,root?:string):CommandIdentity|null{
 const result=Identity.safeParse(value);if(!result.success)return null;
 const identity=result.data as CommandIdentity;
 if(root!==undefined&&identity.tree_root!==root)return null;
 const signatureRoot=identity.signature.startsWith('src:')?identity.signature.slice(4).split('/')[0]:identity.signature.startsWith('tree:')?identity.signature.slice(5).split('/')[0]:null;
 if(signatureRoot!==identity.tree_root)return null;
 const positions=new Set<number>();
 for(const p of identity.parameters){if(positions.has(p.position))return null;positions.add(p.position);}
 return identity;
}
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>[key,canonical(v)]));
 return value;
}
/** model@13 identityRules.command: raw spelling and role evidence are annotations, not identity inputs. */
export function commandKey(identity:CommandIdentity):string{
 return JSON.stringify([identity.tree_root,identity.path,identity.signature,[...identity.parameters].sort((a,b)=>a.position-b.position).map(p=>[p.position,p.name,[p.type.name,p.type.grammar,p.type.declaration],canonical(p.parsed)])]);
}

/** Stable annotation carrier when several observations have the same complete identity. */
export function rememberIdentity(map:Map<string,CommandIdentity>,identity:CommandIdentity):void{
 const key=commandKey(identity),previous=map.get(key),ordered=JSON.stringify(canonical(identity));
 if(!previous||ordered<JSON.stringify(canonical(previous)))map.set(key,JSON.parse(ordered) as CommandIdentity);
}
