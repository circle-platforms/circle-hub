// Exact path segments and product-authored structure only. No command words are classified here.
import {isRecord} from './text.ts';
export interface CommandPolicy {schema:'command-policy@1';read_only:string[];inverse_rules:Array<{source_prefix:string;inverse_prefix:string;leading_parameters?:number}>;inverse_alternatives?:Array<[string,string]>}
export function pathSegments(path:unknown):string[]|null {
 if(typeof path!=='string'||!path.startsWith('/'))return null;
 const parts=path.slice(1).split('/');if(parts[0]!=='commands'||parts.some(part=>!part||part==='.'||part==='..'||/[\u0000-\u0020]/.test(part)))return null;
 try{parts.forEach(part=>decodeURIComponent(part));}catch{return null;}return parts;
}
export function within(path:string,prefix:string):boolean {const a=pathSegments(path),b=pathSegments(prefix);return !!a&&!!b&&a.length>=b.length&&b.every((part,index)=>a[index]===part);}
export function readCommandPolicy(value:unknown):CommandPolicy|null {
 if(!isRecord(value)||value.schema!=='command-policy@1'||Object.keys(value).some(key=>!['schema','read_only','inverse_rules','inverse_alternatives'].includes(key))||!Array.isArray(value.read_only)||value.read_only.length>64||value.read_only.some(path=>!pathSegments(path))||!Array.isArray(value.inverse_rules)||value.inverse_rules.length>64)return null;
 for(const rule of value.inverse_rules)if(!isRecord(rule)||Object.keys(rule).some(key=>!['source_prefix','inverse_prefix','leading_parameters'].includes(key))||!pathSegments(rule.source_prefix)||!pathSegments(rule.inverse_prefix)||rule.leading_parameters!==undefined&&(!Number.isSafeInteger(rule.leading_parameters)||Number(rule.leading_parameters)<0||Number(rule.leading_parameters)>128))return null;
 // Inverse alternatives are exact closed-set pairs of non-space values; a value paired with itself is meaningless.
 if(value.inverse_alternatives!==undefined){
  if(!Array.isArray(value.inverse_alternatives)||value.inverse_alternatives.length>64)return null;
  const partners=new Map<string,string>();
  for(const pair of value.inverse_alternatives){
   if(!Array.isArray(pair)||pair.length!==2||pair.some(member=>typeof member!=='string'||!/\S/.test(member))||pair[0]===pair[1])return null;
   for(const [from,to]of [[pair[0],pair[1]],[pair[1],pair[0]]]){if(partners.has(from)&&partners.get(from)!==to)return null;partners.set(from,to);}
  }
 }
 return value as unknown as CommandPolicy;
}
export function authorTexts(value:unknown):string[]{const fields=isRecord(value)?value:{},out:string[]=[];if(typeof fields.title==='string')out.push(fields.title);if(Array.isArray(fields.expected))out.push(...fields.expected.filter((text):text is string=>typeof text==='string'));for(const step of Array.isArray(fields.steps)?fields.steps:[])if(isRecord(step)){if(typeof step.text==='string')out.push(step.text);if(Array.isArray(step.expected))out.push(...step.expected.filter((text):text is string=>typeof text==='string'));}return out;}
