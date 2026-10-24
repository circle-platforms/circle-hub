// Slot declarations opt in to a complete predecessor validation record; selection is frozen once per start.
import type {InputBinding,InputDefault,RunRecord} from '../../../contracts/src/run.ts';
import type {ValidationResult} from '../../../contracts/src/validation.ts';
import type {Page,RecordStore,StoredRecord} from '../../records/api.ts';
import type {LoadedWorkflow} from '../../ports.ts';
import {recReference} from '../../refs/api.ts';
import type {EngineContext} from './deps.ts';
import {Refusal,protocolError} from './errors.ts';
import {packIdOf} from './lineage.ts';
import {isAbandonedResult} from './management.ts';
import {INDEX,submissionByDigest} from './store.ts';

/** Newest accepted submitted validation, never a production result or a system/management delivery. */
export async function latestSubmittedResult(store:RecordStore,predecessor:StoredRecord<RunRecord>):Promise<StoredRecord<ValidationResult>|null>{
  let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<ValidationResult>>=await store.find<ValidationResult>({kind:'validation_result',key:INDEX.resultRun,value:predecessor.body.run,limit:100,cursor,newestFirst:true});
    for(const result of page.items){
      if(result.body.acceptance!=='accepted'||result.body.system_input!==undefined||result.body.submission===predecessor.digest||isAbandonedResult(result.body))continue;
      if(await submissionByDigest(store,predecessor.body.run,result.body.submission))return result;
    }
    cursor=page.next;
  }while(cursor!==null);
  return null;
}

export async function defaultPredecessorInputs(ctx:EngineContext,workflow:LoadedWorkflow,predecessor:StoredRecord<RunRecord>|null,inputs:Record<string,InputBinding|InputBinding[]>):Promise<{inputs:Record<string,InputBinding|InputBinding[]>;defaults:InputDefault[]}>{
  const needed=workflow.workflow.inputs.filter(slot=>slot.role==='artifact_under_verification'&&slot.default_from_predecessor!==undefined&&!Object.hasOwn(inputs,slot.slot));
  if(predecessor===null||needed.length===0)return{inputs,defaults:[]};
  for(const slot of needed){
    const expected=slot.default_from_predecessor!.pack;
    if(packIdOf(predecessor.body.pack)!==expected)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`输入槽 ${slot.slot} 声明的前驱包是 ${expected}，给出的前驱来自 ${predecessor.body.pack}`,{path:'/predecessor',fix:`用 ${expected} 的运行作为 predecessor，或显式提供输入并按任务包规则核对`})]);
  }
  const result=await latestSubmittedResult(ctx.deps.records.store,predecessor);
  if(result===null)throw new Refusal(needed.map(slot=>protocolError('SUBMISSION_SCHEMA_VIOLATION',`输入槽 ${slot.slot} 缺少前驱 ${predecessor.body.run} 的已受理提交验证结果`,{path:'/inputs/'+slot.slot,fix:'先让前驱运行按回执改正并重新提交，被受理后再开始复核；也可在此槽显式给出待核对的结果引用'})));
  const reference=recReference(result.digest);
  const bindings=needed.map(slot=>[slot.slot,slot.many?[{reference}]:{reference}] as const);
  const bound=Object.fromEntries<InputBinding|InputBinding[]>([...Object.entries(inputs),...bindings]);
  const defaults=needed.map(slot=>({slot:slot.slot,predecessor:predecessor.body.run,reference}));
  return{inputs:bound,defaults};
}
