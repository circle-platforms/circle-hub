// Only engine-owned parent observations can schedule automatic re-evaluation.
import {ReasonSchema} from '../../../contracts/generated/vocabulary.ts';
import type {ValidationResult,UnknownExit} from '../../../contracts/src/validation.ts';
const parentReasons=ReasonSchema.extract(['check_error','budget_exhausted']);
export const parentUnavailable=(attempts:unknown):boolean=>Array.isArray(attempts)&&attempts.some(value=>typeof value==='object'&&value!==null&&value.parent_unavailable===true);
export function attachParentRecovery(result:ValidationResult,attempts:unknown,now:Date):void{
  if(!parentUnavailable(attempts))return;
  const exit:UnknownExit={action:'reevaluate',audience:{hub:true},due:new Date(now.getTime()+86400000).toISOString()};
  for(const item of Object.values(result.partitions).flat())for(const requirement of item.requirements)for(const layer of requirement.layers){
    if(parentReasons.safeParse(layer.reason).success&&layer.exit)layer.exit=structuredClone(exit);
    for(const gap of layer.gaps??[])if(parentReasons.safeParse(gap.reason).success)gap.exit=structuredClone(exit);
  }
  for(const error of result.errors)if(parentReasons.safeParse(error.code).success)error.fix='父级核验能力暂时不可用；Hub 将按原输入与已观察会话有界自动重评，仍失败则交具名管理员修复；'+(error.fix??'');
}
export function needsParentRecovery(result:ValidationResult):boolean{
  return Object.values(result.partitions).flat().some(item=>item.requirements.some(r=>r.layers.some(layer=>layer.exit?.action==='reevaluate'||layer.gaps?.some(g=>g.exit.action==='reevaluate'))))||result.cross_item.some(c=>c.qualifier.nature==='unknown'&&parentReasons.safeParse(c.statement.reason).success);
}
