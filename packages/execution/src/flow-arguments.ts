import {z} from 'zod';
import {canonicalJson,EXECUTION_TRANSITION_LIMITS,requireCondition,ToolName} from '../../contracts/src/index.ts';

const safeKey=(key:string)=>!['__proto__','prototype','constructor'].includes(key)&&!/[\x00-\x1f]/.test(key);
const inputPath=z.array(z.string().min(1).max(100).refine(safeKey)).min(1).max(16);
function field(value:any,path:string[]){for(const key of path){if(!value||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=value[key];}return value;}
export const ProviderArgumentMapping=z.record(ToolName,z.record(ToolName,z.union([
 z.object({inputPath}).strict(),z.object({literal:z.unknown()}).strict(),
]))).superRefine((value,ctx)=>{try{for(const argumentsValue of Object.values(value))for(const source of Object.values(argumentsValue))if('literal' in source)bounded(source.literal);}catch{ctx.addIssue({code:'custom',message:'Mapped literals must be finite bounded JSON'});}});
export const ProviderByteArgumentMapping=z.record(ToolName,z.record(ToolName,ToolName));

export function providerMappedByteArguments(policy:any,tool:string,bytes:Record<string,string>={}){
 const mapping=policy.byteArguments?.[tool];if(!mapping)return {...bytes};
 const result:Record<string,string>={},used=new Set<string>();for(const [target,logical]of Object.entries(mapping) as [string,string][]){
  requireCondition(safeKey(target)&&Object.hasOwn(bytes,logical)&&!used.has(logical),'INVALID_PAYLOAD','Approved byte mapping requires each declared logical argument exactly once');result[target]=bytes[logical];used.add(logical);
 }
 requireCondition(used.size===Object.keys(bytes).length,'INVALID_PAYLOAD','Byte mapping cannot omit a controlled original');return result;
}

function bounded(value:any,depth=0,seen=new Set<object>()){
 const limits=EXECUTION_TRANSITION_LIMITS;
 requireCondition(depth<limits.jsonDepth,'BODY_TOO_LARGE','Mapped parameter nesting exceeds its budget');
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
 if(typeof value==='string'){requireCondition(Buffer.byteLength(value)<=limits.jsonStringBytes,'BODY_TOO_LARGE','Mapped strings require a controlled byte argument when oversized');return;}
 requireCondition(typeof value==='object'&&value!==null,'INVALID_PAYLOAD','Mapped arguments must be finite JSON');
 requireCondition(!seen.has(value),'INVALID_PAYLOAD','Mapped arguments cannot contain cycles');
 const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);requireCondition(prototype===(array?Array.prototype:Object.prototype)||!array&&prototype===null,'INVALID_PAYLOAD','Mapped arguments require plain JSON');
 if(array)requireCondition(value.length<=limits.arrayItems,'BODY_TOO_LARGE','Mapped array exceeds its budget');
 seen.add(value);const descriptors=Object.getOwnPropertyDescriptors(value);
 for(const key of Reflect.ownKeys(descriptors)){
  if(array&&key==='length')continue;const descriptor=descriptors[key as string];
  requireCondition(typeof key==='string'&&safeKey(key)&&descriptor.enumerable&&Object.hasOwn(descriptor,'value')&&(!array||/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<value.length),'INVALID_PAYLOAD','Mapped parameters cannot contain hidden properties accessors or prototype keys');
  requireCondition(Buffer.byteLength(key)<=limits.jsonStringBytes,'BODY_TOO_LARGE','Mapped parameter key exceeds its budget');bounded(descriptor.value,depth+1,seen);
 }
 if(array)for(let i=0;i<value.length;i++)requireCondition(Object.hasOwn(descriptors,String(i)),'INVALID_PAYLOAD','Mapped parameters cannot contain sparse arrays');seen.delete(value);
}

// The approved resource revision owns mappings; the product cannot replace
// them with action arguments or use ordinary JSON to smuggle binary originals.
export function providerMappedArguments(policy:any,tool:string,args:Record<string,any>,input:any,byteArgs:Record<string,string>={}){
 const result={...args};for(const [parameter,source]of Object.entries(policy.toolArguments?.[tool]??{}) as [string,any][]){
  requireCondition(safeKey(parameter)&&!Object.hasOwn(args,parameter)&&!Object.hasOwn(byteArgs,parameter),'INVALID_PAYLOAD','Product parameter collides with an approved provider mapping');
  const value=Object.hasOwn(source,'inputPath')?field(input,source.inputPath):source.literal;bounded(value);result[parameter]=value;
 }
 bounded(result);requireCondition(Buffer.byteLength(canonicalJson(result))<=EXECUTION_TRANSITION_LIMITS.metadataBytes,'BODY_TOO_LARGE','Mapped parameters exceed their cumulative budget');return result;
}
