import type {TaskResult} from '../../contracts/generated/vocabulary.ts';
import {isUnknownTerminal} from '../../contracts/src/validation.ts';
import type {RunSummary,RunStatistics} from '../ports.ts';
import {isAbandonedResult} from './engine/management.ts';

export function primaryRunResult(detail:RunSummary):RunSummary['latest']{
 if(detail.latest?.result.system_input)return detail.latest;
 return detail.run.requirements.length>0&&detail.run.requirements.every(row=>row.accepted_producer==='fact')?detail.production:detail.latest;
}
export function runTaskResult(detail:RunSummary):TaskResult{
 if(detail.management!==undefined)return 'abandoned';
 const primary=primaryRunResult(detail);if(primary===null||primary.result.acceptance!=='accepted')return 'awaiting';
 const result=primary.result;if(isAbandonedResult(result))return 'abandoned';
 const parts=result.partitions;if(parts.quarantined.length)return 'held';if(parts.incomplete.length)return 'incomplete';if(parts.rejected.length)return 'rejected';
 const requirements=parts.delivered.flatMap(item=>item.requirements);
 if(requirements.some(row=>row.status==='pending'||row.layers.some(isUnknownTerminal)))return 'delivered_pending';
 return requirements.some(row=>row.status==='unsatisfied')?'delivered_unsatisfied':'passed';
}
export function runPendingCount(detail:RunSummary):number{
 const primary=primaryRunResult(detail);if(primary===null||primary.result.acceptance!=='accepted')return 0;
 return primary.result.partitions.delivered.flatMap(item=>item.requirements).filter(row=>row.status==='pending'||row.layers.some(isUnknownTerminal)).length;
}
export function runStatistics(detail:RunSummary):RunStatistics{
 const output:RunStatistics={result:runTaskResult(detail),pending:runPendingCount(detail),checks:[],blockers:[]};
 const primary=primaryRunResult(detail);if(primary===null||primary.result.acceptance!=='accepted')return output;
 const checks=new Map<string,RunStatistics['checks'][number]>();
 for(const item of Object.values(primary.result.partitions).flat())for(const requirement of item.requirements)for(const row of requirement.layers){
  const key=row.layer+':'+row.terminal,held=checks.get(key);if(held)held.count++;else checks.set(key,{layer:row.layer,terminal:row.terminal,unknown:isUnknownTerminal(row),count:1});
 }
 output.checks=[...checks.values()];
 const parts=primary.result.partitions,blockers=new Map<string,RunStatistics['blockers'][number]>();
 for(const row of [...parts.rejected,...parts.incomplete,...parts.quarantined]){
  const value='code'in row?{code:row.code}:'reason'in row?{reason:row.reason}:null;if(!value)continue;
  const key=JSON.stringify(value),held=blockers.get(key);if(held)held.count++;else blockers.set(key,{...value,count:1});
 }
 output.blockers=[...blockers.values()];return output;
}
