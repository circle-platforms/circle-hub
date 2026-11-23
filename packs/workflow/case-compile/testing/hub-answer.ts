import REQUIREMENTS from '../requirements.json' with {type:'json'};
import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';
import type {Hub} from './hub.ts';

export const inItem=(text:string,index:number):string=>text.replaceAll(`/items/${index}`,'');
export const stripData=(pointer:string):string=>pointer==='/data'?'':pointer.startsWith('/data/')?pointer.slice('/data'.length):pointer;
export const canonical=(value:unknown):string=>JSON.stringify(value,(_key,inner)=>inner!==null&&typeof inner==='object'&&!Array.isArray(inner)?Object.fromEntries(Object.entries(inner).sort(([a],[b])=>a<b?-1:1)):inner);
export const unique=(rows:unknown[]):string[]=>[...new Set(rows.map(canonical))].sort();
const PLAN_STAGE_CHECKS=['contract_shape','bed_addresses','commands_catalog','expected_sources','expected_quotes'];
export const PLAN_REQUIREMENTS=new Set(REQUIREMENTS.requirements.filter(row=>(row.checks as string[]).length>0&&(row.checks as string[]).every(id=>PLAN_STAGE_CHECKS.includes(id))).map(row=>row.key));

export function hubProblems(answer:Awaited<ReturnType<Hub['service']['submitResult']>>,item:string,index:number){
 const structure=(answer.errors??[]).filter(error=>error.item===item&&error.code==='SUBMISSION_SCHEMA_VIOLATION').map(error=>({code:error.code,pointer:inItem(error.path??'',index),message:inItem(error.message,index)}));
 const checks:unknown[]=[];
 for(const rows of Object.values(answer.result?.partitions??{}))for(const row of rows)if(row.item===item)for(const requirement of row.requirements)if(PLAN_REQUIREMENTS.has(requirement.requirement))for(const entry of requirement.claims){
  const statement=entry.statement as {verdict?:Verdict;code?:string;reason?:string;text?:string;data?:{problems?:Array<Record<string,unknown>>}};
  if(statement.verdict!=='refute'&&statement.verdict!=='unknown'||statement.reason==='awaiting_step')continue;
  const code=statement.code??statement.reason,gaps=statement.data?.problems??[];
  if(gaps.length)checks.push(...gaps.map(gap=>({...gap,...(code!==undefined?{code}:{})})));
  else checks.push({...(code!==undefined?{code}:{}),pointer:stripData(String((entry as {pointer?:string}).pointer??'')),message:statement.text,verdict:statement.verdict});
 }
 return {structure,checks};
}
