// Deployment references are accepted only in explicitly designated expected-value positions.
import {VariableValue,referencesIn,resolve,VariableInputError,type VariableUse} from '../../contracts/src/variables.ts';
import {ExecutorDefinition,at} from './definition.ts';
import {canonicalBytes,type RecordsKit,type VariableSnapshot} from '../records/api.ts';
export {ExecutorSource,checkedExecutorReferences as checkedReferences} from '../../contracts/src/resources.ts';
import {ExecutorSource,checkedExecutorReferences as checkedReferences} from '../../contracts/src/resources.ts';
export async function resolveExecutor(records:RecordsKit,source:ExecutorSource,snapshot?:VariableSnapshot):Promise<{definition:ExecutorDefinition;variables:VariableUse[]}> {
 checkedReferences(source);
 const ordinary={...source};delete ordinary.credential;
 const resolved=await records.variables.resolveVariables(ordinary,source.id??'executor',snapshot);
 const parsed=ExecutorDefinition.safeParse({...resolved.value as object,...(source.credential?{credential:source.credential}:{})});
 if(!parsed.success)throw new VariableInputError('变量解析后的执行器定义不合模式：请修正变量或 executor update 后重做');
 canonicalBytes(parsed.data); // Enforce the same JSON domain as literal definitions.
 return {definition:parsed.data,variables:resolved.uses};
}

/** Same complete-reference replacement for offline source checks; no network, database or secret resolution. */
export function resolveExecutorValues(source:ExecutorSource,values:ReadonlyMap<string,unknown>):ExecutorDefinition {
 checkedReferences(source);
 const resolved=resolve(source,(kind,name)=>{
  if(kind==='secret')return '${secret:'+name+'}';
  if(!values.has(name))throw new VariableInputError('缺少普通变量 '+name+' 的当前值；先 var set 再重做第零步');
  return VariableValue.parse(values.get(name));
 });
 return ExecutorDefinition.parse(resolved);
}
