// Slot declarations opt in to a complete predecessor validation record; selection is frozen once per start.
import type {InputBinding,InputDefault,RunRecord} from '../../../contracts/src/run.ts';
import type {ValidationResult} from '../../../contracts/src/validation.ts';
import type {Page,Principal,StoredRecord} from '../../records/api.ts';
import type {LoadedWorkflow} from '../../ports.ts';
import {recReference} from '../../refs/api.ts';
import type {EngineContext} from './deps.ts';
import {Refusal,protocolError} from './errors.ts';
import {packIdOf} from './lineage.ts';
import {isAbandonedResult} from './management.ts';
import {canSeeRun} from './readers.ts';
import {INDEX,runById,submissionByDigest} from './store.ts';

/**
 * Newest accepted submitted validation, never a production result or a system/management delivery. start_run reads it under the
 * run's submit lock; an input bound after the start (W06 R[7]) reads it with locked false, so a validation of the binding run never
 * waits on the bound run's own validation: records are appended atomically and only whole accepted results are seen.
 */
export async function latestSubmittedResult(ctx:EngineContext,predecessor:StoredRecord<RunRecord>,options:{locked?:boolean}={}):Promise<StoredRecord<ValidationResult>|null>{
  const read=async()=>{
    const store=ctx.deps.records.store;
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
  };
  return options.locked===false?read():ctx.lock('submit:'+predecessor.body.run,read);
}

const REVISION=/@([0-9a-f]{64}(?:\.\.[0-9a-f]{64})?)$/;
const bare=(id:string):string=>id.replace(REVISION,'');
const listOf=(value:InputBinding|InputBinding[]|undefined):InputBinding[]=>value===undefined?[]:Array.isArray(value)?value:[value];

function matchesFrozen(given:InputBinding,source:{reference:string;external?:string|null;artifact?:string}):boolean{
  if('run' in given)return false;
  if('external' in given)return typeof source.external==='string'&&bare(given.external)===bare(source.external);
  return given.reference===source.reference&&(given.artifact===undefined||given.artifact===source.artifact);
}

async function ancestors(ctx:EngineContext,start:StoredRecord<RunRecord>):Promise<StoredRecord<RunRecord>[]>{
  const out:StoredRecord<RunRecord>[]=[];
  const seen=new Set<string>();
  let at:StoredRecord<RunRecord>|null=start;
  for(let depth=0;depth<20&&at!==null&&!seen.has(at.body.run);depth++){
    seen.add(at.body.run);
    out.push(at);
    if(at.body.predecessor_access==='view'||at.body.predecessor===undefined)break;
    at=await runById(ctx.deps.records.store,at.body.predecessor);
  }
  return out;
}

async function acceptedOf(ctx:EngineContext,user:Principal,runId:string,expected:string,path:string):Promise<{run:string;reference:string}>{
  const record=await runById(ctx.deps.records.store,runId);
  if(record===null||!canSeeRun(user,record.body))throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`运行 ${runId} 不存在或当前用户不可见`,{path,fix:`改为一个可见的 ${expected} 运行编号，或直接给出该运行已受理结果的 rec:`})]);
  if(packIdOf(record.body.pack)!==expected)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`运行 ${runId} 的任务包是 ${record.body.pack}，此槽要求 ${expected}`,{path,fix:`改为 ${expected} 的运行编号，或直接给出已受理结果的 rec:`})]);
  const result=await latestSubmittedResult(ctx,record);
  if(result===null)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`运行 ${runId} 没有已受理提交`,{path,fix:'先让该运行按回执改正并重新提交，被受理后再引用；也可直接给出已受理结果的 rec:'})]);
  return{run:record.body.run,reference:recReference(result.digest)};
}

/**
 * A run a slot binds after the start (W06 R[6] exception): only that it exists, the caller may see it and it is a run of the
 * declared workflow; an accepted submission is not required. A run of the starting workflow itself is refused: its own revisions
 * continue through predecessor.
 */
async function lateRunOf(ctx:EngineContext,user:Principal,workflow:LoadedWorkflow,slot:string,runId:string,expected:string,path:string):Promise<StoredRecord<RunRecord>>{
  const record=await runById(ctx.deps.records.store,runId);
  if(record===null||!canSeeRun(user,record.body))throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`运行 ${runId} 不存在或当前用户不可见`,{path,fix:`改为一个可见的 ${expected} 运行编号；这个槽开运行后才取该运行的已受理结果，开始时不要求已有受理`})]);
  if(packIdOf(record.body.pack)!==expected)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`运行 ${runId} 的任务包是 ${record.body.pack}，输入槽 ${slot} 只接受 ${expected} 的运行`,{path,fix:`改为 ${expected} 的运行编号，或直接给出已受理结果的 rec:`})]);
  if(expected===workflow.pack.id)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`输入槽 ${slot} 开运行后再绑定的运行 ${runId} 是本工作流 ${workflow.pack.id} 自己的运行；这个槽只接受别的工作流的运行`,{path,fix:`本工作流的前一版本用 predecessor 接续；请任务包作者把 from_runs.pack 改为前序阶段的工作流`})]);
  return record;
}

export async function defaultPredecessorInputs(ctx:EngineContext,workflow:LoadedWorkflow,predecessor:StoredRecord<RunRecord>|null,inputs:Record<string,InputBinding|InputBinding[]>,user:Principal):Promise<{inputs:Record<string,InputBinding|InputBinding[]>;defaults:InputDefault[];late:NonNullable<RunRecord['late_inputs']>}>{
  let current={...inputs};
  const defaults:InputDefault[]=[];
  const late:NonNullable<RunRecord['late_inputs']>=[];
  // An input bound after the start leaves the inputs: bindInputs and the projection never see it, only context.late_inputs.
  const without=(slot:string)=>{const {[slot]:_dropped,...rest}=current;current=rest;};
  const resultSlots=workflow.workflow.inputs.filter(slot=>slot.default_from_predecessor?.slot===undefined&&slot.role==='artifact_under_verification'&&slot.default_from_predecessor!==undefined&&!Object.hasOwn(current,slot.slot));
  if(predecessor!==null&&resultSlots.length>0){
    for(const slot of resultSlots){
      const expected=slot.default_from_predecessor!.pack;
      if(packIdOf(predecessor.body.pack)!==expected)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`输入槽 ${slot.slot} 声明的前驱包是 ${expected}，给出的前驱来自 ${predecessor.body.pack}`,{path:'/predecessor',fix:`用 ${expected} 的运行作为 predecessor，或显式提供输入并按任务包规则核对`})]);
    }
    const result=await latestSubmittedResult(ctx,predecessor);
    if(result===null)throw new Refusal(resultSlots.map(slot=>protocolError('SUBMISSION_SCHEMA_VIOLATION',`输入槽 ${slot.slot} 缺少前驱 ${predecessor.body.run} 的已受理提交验证结果`,{path:'/inputs/'+slot.slot,fix:'先让前驱运行按回执改正并重新提交，被受理后再开始复核；也可在此槽显式给出待核对的结果引用'})));
    const reference=recReference(result.digest);
    for(const slot of resultSlots){
      current={...current,[slot.slot]:slot.many?[{reference}]:{reference}};
      defaults.push({slot:slot.slot,predecessor:predecessor.body.run,reference});
    }
  }
  if(predecessor!==null){
    for(const slot of workflow.workflow.inputs){
      const named=slot.default_from_predecessor?.slot;
      if(named===undefined)continue;
      const expected=slot.default_from_predecessor!.pack;
      if(packIdOf(predecessor.body.pack)!==expected)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`输入槽 ${slot.slot} 声明的前驱包是 ${expected}，给出的前驱来自 ${predecessor.body.pack}`,{path:'/predecessor',fix:`用 ${expected} 的运行作为 predecessor，或显式提供输入并按任务包规则核对`})]);
      const found=predecessor.body.sources.filter(source=>source.slot===named);
      if(found.length!==1)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`前驱 ${predecessor.body.run} 没有唯一的冻结输入槽 ${named}`,{path:'/inputs/'+slot.slot,fix:`在 inputs.${slot.slot} 显式给出对象，或换一个绑定了 ${named} 的前驱运行`})]);
      const source=found[0];
      const identity=source.external??source.reference;
      const given=current[slot.slot];
      if(given===undefined){
        const binding:InputBinding=source.external!==undefined?{external:source.external}:{reference:source.reference,...(source.artifact?{artifact:source.artifact}:{})};
        current={...current,[slot.slot]:slot.many?[binding]:binding};
        defaults.push({slot:slot.slot,predecessor:predecessor.body.run,reference:identity,kind:'input'});
        continue;
      }
      const mismatched=listOf(given).filter(binding=>!matchesFrozen(binding,source));
      if(mismatched.length)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`输入槽 ${slot.slot} 与前驱 ${predecessor.body.run} 冻结的输入 ${named}（${identity}）不一致`,{path:'/inputs/'+slot.slot,fix:`改为 ${identity}，或省略 inputs.${slot.slot} 由 Hub 按前驱绑定`})]);
    }
  }
  for(const slot of workflow.workflow.inputs){
    if(slot.from_runs===undefined)continue;
    const expected=slot.from_runs.pack;
    const given=current[slot.slot];
    if(given===undefined){
      if(predecessor===null||!slot.required)continue;
      const matches=(await ancestors(ctx,predecessor)).filter(record=>packIdOf(record.body.pack)===expected);
      if(matches.length===0)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`血缘里没有 ${expected} 的运行`,{path:'/inputs/'+slot.slot,fix:`在 predecessor 中给出 ${expected} 的运行，或在 inputs.${slot.slot} 按运行编号给出`})]);
      if(!slot.many&&matches.length>1)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`血缘里有多个 ${expected} 运行`,{path:'/inputs/'+slot.slot,fix:`在 inputs.${slot.slot} 给出要绑定的那一个运行编号`})]);
      if(slot.from_runs.after_start===true){
        const record=await lateRunOf(ctx,user,workflow,slot.slot,matches[0].body.run,expected,'/inputs/'+slot.slot);
        late.push({slot:slot.slot,run:record.body.run,defaulted:true});
        without(slot.slot);
        continue;
      }
      const resolved=[];
      for(const record of matches){
        const result=await latestSubmittedResult(ctx,record);
        if(result===null)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`运行 ${record.body.run} 没有已受理提交`,{path:'/inputs/'+slot.slot,fix:'先让该运行按回执改正并重新提交，被受理后再开始；也可在此槽直接给出已受理结果的 rec:'})]);
        const reference=recReference(result.digest);
        resolved.push({reference});
        defaults.push({slot:slot.slot,predecessor:record.body.run,reference});
      }
      current={...current,[slot.slot]:slot.many?resolved:resolved[0]};
      continue;
    }
    if(slot.from_runs.after_start===true&&listOf(given).some(binding=>'run' in binding)){
      const list=listOf(given);
      const path=Array.isArray(given)?`/inputs/${slot.slot}/0`:`/inputs/${slot.slot}`;
      if(list.length!==1)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`输入槽 ${slot.slot} 开运行后只绑定一个运行，给了 ${list.length} 个绑定`,{path:'/inputs/'+slot.slot,fix:`只给一个 ${expected} 的运行编号 {run}；要冻结某一份已受理结果，改给它的 rec:`})]);
      const binding=list[0] as {run:string};
      const record=await lateRunOf(ctx,user,workflow,slot.slot,binding.run,expected,path);
      late.push({slot:slot.slot,run:record.body.run});
      without(slot.slot);
      continue;
    }
    const resolved:InputBinding[]=[];
    for(const [index,binding] of listOf(given).entries()){
      if(!('run' in binding)){resolved.push(binding);continue;}
      const path=Array.isArray(given)?`/inputs/${slot.slot}/${index}`:`/inputs/${slot.slot}`;
      const accepted=await acceptedOf(ctx,user,binding.run,expected,path);
      resolved.push({reference:accepted.reference});
      defaults.push({slot:slot.slot,predecessor:accepted.run,reference:accepted.reference});
    }
    current={...current,[slot.slot]:Array.isArray(given)||slot.many?resolved:resolved[0]};
  }
  return{inputs:current,defaults,late};
}

/** Visibility of predecessor must already have been checked by startFresh; this adds facts, never defaults or grants. */
export function predecessorInputRefusal(error:unknown,predecessor:RunRecord|null,workflow:LoadedWorkflow):never{
 if(!(error instanceof Refusal)||!predecessor)throw error;
 const slots=new Set(workflow.workflow.inputs.map(input=>input.slot));
 const sources=predecessor.sources.filter(source=>source.slot!==undefined&&slots.has(source.slot));
 if(!sources.length)throw error;
 const hint=`前序冻结输入：${sources.map(source=>`${source.slot}=${source.external??source.reference}`).join('；')}。按本工作流输入说明核对后显式填写，未自动沿用或改变绑定`;
 throw new Refusal(error.errors.map(row=>({...row,fix:`${row.fix??''}；${hint}`})),error.adminNote);
}
