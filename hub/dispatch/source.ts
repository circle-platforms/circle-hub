// Deployment references are accepted only in explicitly designated expected-value positions.
import {z} from 'zod';
import {VariableValue,referencesIn,resolve,VariableInputError,type VariableUse} from '../../contracts/src/variables.ts';
import {ExecutorDefinition,at} from './definition.ts';
import {canonicalBytes,type RecordsKit,type VariableSnapshot} from '../records/api.ts';
type Condition=ExecutorDefinition['conditions'][number];
type SourceCondition=Omit<Condition,'at_least'> & {at_least?:Condition['at_least']|string};
export type ExecutorSource=Omit<ExecutorDefinition,'conditions'|'precheck_reads'> & {conditions:SourceCondition[];precheck_reads:Array<Omit<ExecutorDefinition['precheck_reads'][number],'conditions'>&{conditions:SourceCondition[]}>};
function expected(pointer:string):boolean {return pointer==='/target'||pointer==='/manifest_sha256'||/^\/(?:conditions\/\d+|precheck_reads\/\d+\/conditions\/\d+)\/(?:equals(?:\/.*)?|at_least|sha256)$/.test(pointer);}
function put(target:unknown,pointer:string,value:unknown) {const parts=pointer.slice(1).split('/').map(s=>s.replaceAll('~1','/').replaceAll('~0','~'));let node=target as Record<string,unknown>;for(const key of parts.slice(0,-1))node=node[key] as Record<string,unknown>;node[parts.at(-1)!]=value;}
export const ExecutorSource=z.unknown().transform((input,ctx):ExecutorSource=>{
 try {
  const refs=referencesIn(input);
  for(const ref of refs)if(!(ref.kind==='secret'&&ref.at==='/credential')&&!(ref.kind==='var'&&expected(ref.at)))throw new VariableInputError('这一处不许引用变量；只有期望值可引用普通变量，credential 只引用密钥',ref.at);
  const candidate=resolve(input,(kind,name,pointer)=>kind==='secret'?'${secret:'+name+'}':pointer==='/target'?'DEMO_TARGET':pointer==='/manifest_sha256'||pointer.endsWith('/sha256')?'0'.repeat(64):pointer.endsWith('/at_least')?0:null);
  const parsed=ExecutorDefinition.safeParse(candidate);
  if(!parsed.success){for(const issue of parsed.error.issues)ctx.addIssue({code:'custom',path:issue.path,message:issue.message});return z.NEVER;}
  const output=structuredClone(parsed.data);
  for(const ref of refs)put(output,ref.at,at(input,ref.at));
  return output as ExecutorSource;
 }catch(error){ctx.addIssue({code:'custom',message:error instanceof VariableInputError?error.message:'定义不是可安全解析的 JSON'});return z.NEVER;}
});
export async function resolveExecutor(records:RecordsKit,source:ExecutorSource,snapshot?:VariableSnapshot):Promise<{definition:ExecutorDefinition;variables:VariableUse[]}> {
 const ordinary={...source};delete ordinary.credential;
 const resolved=await records.variables.resolveVariables(ordinary,source.id??'executor',snapshot);
 const parsed=ExecutorDefinition.safeParse({...resolved.value as object,...(source.credential?{credential:source.credential}:{})});
 if(!parsed.success)throw new VariableInputError('变量解析后的执行器定义不合模式：请修正变量或 executor update 后重做');
 canonicalBytes(parsed.data); // Enforce the same JSON domain as literal definitions.
 return {definition:parsed.data,variables:resolved.uses};
}

/** Same complete-reference replacement for offline source checks; no network, database or secret resolution. */
export function resolveExecutorValues(source:ExecutorSource,values:ReadonlyMap<string,unknown>):ExecutorDefinition {
 const resolved=resolve(source,(kind,name)=>{
  if(kind==='secret')return '${secret:'+name+'}';
  if(!values.has(name))throw new VariableInputError('缺少普通变量 '+name+' 的当前值；先 var set 再重做第零步');
  return VariableValue.parse(values.get(name));
 });
 return ExecutorDefinition.parse(resolved);
}
