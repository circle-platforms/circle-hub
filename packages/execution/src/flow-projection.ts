import {canonicalJson,EXECUTION_TRANSITION_LIMITS} from '../../contracts/src/index.ts';

// Results sit at observations[].facts.result (depth 5 in the F frame).
// Metadata callers provide their actual wrapper depth instead. Moving the
// complete original to B changes its projection, never the F budgets.
export function requiresControlledProjection(value:unknown,startDepth=5):boolean{
 const limits=EXECUTION_TRANSITION_LIMITS,ancestors=new Set<object>();
 const oversized=(item:unknown,depth:number):boolean=>{
  if(depth>limits.jsonDepth)return true;
  if(typeof item==='string')return Buffer.byteLength(item)>limits.jsonStringBytes;
  if(!item||typeof item!=='object')return false;
  if(ancestors.has(item))return true;
  if(Array.isArray(item)&&item.length>limits.arrayItems)return true;
  ancestors.add(item);
  const result=Object.entries(item).some(([key,child])=>Buffer.byteLength(key)>limits.jsonStringBytes||oversized(child,depth+1));
  ancestors.delete(item);return result;
 };
 return oversized(value,startDepth)||Buffer.byteLength(canonicalJson(value))>limits.stateBytes;
}
