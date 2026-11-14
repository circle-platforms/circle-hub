import type {TestEnvironment} from '../../../contracts/api.ts';
import type {Principal,RecordsKit} from '../../records/api.ts';

/** Explicit synthetic catalog facts; this helper never grants use or completes inheritance. */
export async function registerEnvironment(records:RecordsKit,by:Principal,input:{name:string;target:string;executors?:string[];resources?:string[];prefixes?:string[];owner:string;at?:string}):Promise<TestEnvironment> {
  const at=input.at??new Date().toISOString();
  return records.testEnvironments.register(by,{name:input.name,target:input.target,executors:input.executors??[],resources:(input.resources??[]).map(key=>({key,owner:input.owner,registered_at:at})),prefixes:(input.prefixes??[]).map(prefix=>({prefix,owner:input.owner,registered_at:at})),enabled:true,missing_facts:[]});
}

export async function setPrefixOwner(records:RecordsKit,by:Principal,environment:TestEnvironment,prefix:string,owner:string,keys:readonly string[]):Promise<TestEnvironment> {
  if(environment.name===null||environment.target===null)throw new Error('synthetic owner fixture requires a known environment');
  for(const key of keys)if(!key.startsWith(prefix)||!environment.resources.some(row=>row.key===key))throw new Error('synthetic owner keys must be explicitly declared under the chosen prefix');
  const {id,schema,...input}=environment;
  const prefixes=[...input.prefixes.filter(row=>row.prefix!==prefix),{prefix,owner,registered_at:new Date().toISOString()}];
  let updated=await records.testEnvironments.update(by,id,{...input,name:environment.name,target:environment.target,prefixes});
  for(const key of keys)updated=await records.testEnvironments.reassignOwner(by,id,{key,owner});
  return updated;
}
