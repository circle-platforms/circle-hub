// A fail-closed reader for the JSON Schema vocabulary used by the generated identity snapshots.
// Local workbook tools cannot load third-party packages; the same declared schemas remain authoritative.
import {addressValue} from './manifest.ts';
type Shape={ [key:string]:unknown };
const record=(value:unknown):value is Shape=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const annotation=new Set(['$schema','title','description','type','properties','required','additionalProperties','anyOf','const','enum','items','minItems','maxItems','minimum','maximum','minLength','maxLength','pattern','format']);
export function schema(shape:unknown){
 function matches(node:unknown,value:unknown):boolean{
  if(!record(node)||Object.keys(node).some(key=>!annotation.has(key)))return false;
  if(Array.isArray(node.anyOf)&&!node.anyOf.some(arm=>matches(arm,value)))return false;
  if(Object.hasOwn(node,'const')&&value!==node.const)return false;
  if(Array.isArray(node.enum)&&!node.enum.includes(value))return false;
  if(node.type==='object'){
   const properties=node.properties===undefined&&node.additionalProperties!==undefined?{}:node.properties;
   if(!record(value)||!record(properties))return false;
   if(Array.isArray(node.required)&&node.required.some(key=>typeof key!=='string'||!Object.hasOwn(value,key)))return false;
   for(const [key,child]of Object.entries(value)){if(Object.hasOwn(properties,key)){if(!matches(properties[key],child))return false;}else if(node.additionalProperties===false)return false;else if(record(node.additionalProperties)&&!matches(node.additionalProperties,child))return false;}
  }else if(node.type==='array'){
   if(!Array.isArray(value)||typeof node.minItems==='number'&&value.length<node.minItems||typeof node.maxItems==='number'&&value.length>node.maxItems)return false;
   if(node.items!==undefined&&value.some(child=>!matches(node.items,child)))return false;
  }else if(node.type==='string'){
   if(typeof value!=='string'||typeof node.minLength==='number'&&[...value].length<node.minLength||typeof node.maxLength==='number'&&[...value].length>node.maxLength)return false;
   if(typeof node.pattern==='string'&&!new RegExp(node.pattern,'u').test(value))return false;
   if(node.format!==undefined){if(node.format==='ipv4'){if(addressValue('ipv4',value)===null)return false;}else if(node.format==='ipv6'){if(addressValue('ipv6',value)===null)return false;}else return false;}
  }else if(node.type==='integer'||node.type==='number'){
   if(typeof value!=='number'||!Number.isFinite(value)||node.type==='integer'&&!Number.isInteger(value)||typeof node.minimum==='number'&&value<node.minimum||typeof node.maximum==='number'&&value>node.maximum)return false;
  }else if(node.type==='boolean'){if(typeof value!=='boolean')return false;}
  else if(node.type==='null'){if(value!==null)return false;}
  else if(node.type!==undefined)return false;
  return true;
 }
 return {safeParse(value:unknown){return matches(shape,value)?{success:true as const,data:value}:{success:false as const};}};
}
