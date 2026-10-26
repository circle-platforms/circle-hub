// Administrative run disposition is a record-backed view, never a change to old technical evidence or remote effects.
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {DispositionSchema} from '../../../contracts/generated/vocabulary.ts';
import {RunId,UserId,Sha256,IsoTime,TraceId} from '../../../contracts/src/common.ts';
import {Claim} from '../../../contracts/src/claim.ts';
import type {RunRecord} from '../../../contracts/src/run.ts';
import {ValidationResult,partitionCountsOf,type ItemResult} from '../../../contracts/src/validation.ts';
import {canonicalBytes,digestOf,RecordsError,IntegrityError,scanForCredentials,type Principal,type ActionBody,type StoredRecord} from '../../records/api.ts';
import {createRequestService} from '../../requests/api.ts';
import {recReference} from '../../refs/api.ts';
import {ENGINE_COMPONENT,type EngineContext} from './deps.ts';
import {canSeeRun} from './readers.ts';
import {INDEX,SCHEMAS,actionsOf,latestAccepted,putResult,runById} from './store.ts';

const Input=z.strictObject({run:RunId,run_record:Sha256,request:Sha256,disposition:DispositionSchema.extract(['abandon']),decided_by:UserId,decided_at:IsoTime,reason:z.string().min(1).max(2000),prior_result:Sha256.nullable(),trace:TraceId});
export interface ManagementReceipt {record:string;result:ValidationResult;decision:string;created:boolean;current:boolean}
export function isAbandonedResult(result:ValidationResult):boolean{return result.cross_item.some(c=>c.warrant.producer==='function'&&c.warrant.id===ENGINE_COMPONENT&&c.statement.data?.run_disposition==='abandon');}
export async function abandonDecision(ctx:EngineContext,run:string):Promise<StoredRecord<ActionBody>|null>{
  return [...await actionsOf(ctx.deps.records.store,run)].reverse().find(a=>a.body.component===ENGINE_COMPONENT&&a.body.detail.run_disposition==='abandon')??null;
}
const unavailable=()=>new RecordsError('运行或管理请求对操作者不可用',{fix:'用运行者本人或管理员的有效令牌，核对本运行的待回答管理处置请求'});
export async function abandonRun(ctx:EngineContext,by:Principal,runId:string,requestId:string,reason:string):Promise<ManagementReceipt>{
  const account=await ctx.deps.records.principals?.get(by.id);
  const stored=await runById(ctx.deps.records.store,runId);
  if(!account||account.disabled||!stored||!canSeeRun(account,stored.body))throw unavailable();
  if(typeof reason!=='string'||!reason.isWellFormed()||!reason.trim()||reason.length>2000)throw new RecordsError('放弃理由必须是 1 到 2000 字符的完整文本',{fix:'给出不含凭据的管理理由后重试'});
  if(!scanForCredentials(canonicalBytes({reason})).clean)throw new RecordsError('放弃理由包含疑似凭据',{fix:'从理由中去掉凭据后重试，不在命令参数里填写秘密'});
  return ctx.lock('submit:'+runId,async()=>{
    const requests=createRequestService(ctx.deps.records,ctx.now);
    const question=await requests.inspect(requestId);
    if(!question||question.run!==runId||question.kind!=='disposition'||question.job||question.pack_digest||question.sources?.length||account.role!=='admin'&&question.audience!==account.id)throw unavailable();
    if(question.answered_by!==null){const source=await ctx.deps.records.store.get<ActionBody>(question.answered_by);if(source?.kind!=='action'||source.body.detail.run_disposition!=='abandon')throw new RecordsError('这个请求已有其他作答，不改写原回答',{fix:'查看原作答；继续工作需以原运行为前驱开新修订'});}
    const old=await ctx.deps.records.store.find<ActionBody>({kind:'action',key:'runs.disposition.request',value:requestId,limit:1});
    let decision=old.items[0];
    if(!decision){
      const prior=await latestAccepted(ctx.deps.records.store,runId);
      const input=Input.parse({run:runId,run_record:stored.digest,request:requestId,disposition:'abandon',decided_by:account.id,decided_at:ctx.now().toISOString(),reason,prior_result:prior?.digest??null,trace:randomBytes(16).toString('hex')});
      decision=await ctx.deps.records.store.put<ActionBody>({kind:'action',schema:SCHEMAS.action,provenance:'observed',created_at:input.decided_at,unique_key:'runs.disposition:'+runId+':'+requestId,body:{action:'validate',run:runId,item:null,inputs:[recReference(stored.digest),recReference(requestId),...(prior?[recReference(prior.digest)]:[])],component:ENGINE_COMPONENT,lease:null,started_at:input.decided_at,ended_at:ctx.now().toISOString(),result:'completed',error_code:null,acceptance:null,codes:[],detail:{input,run_disposition:'abandon',decided_by:account.id,administrative:true}},index:[{key:INDEX.actionRun,value:runId},{key:'action.run',value:runId},{key:'action.kind',value:'validate'},{key:'runs.disposition.request',value:requestId}]});
    }
    const input=Input.parse(decision.body.detail.input);
    if(input.reason!==reason||input.decided_by!==account.id)throw new RecordsError('同一处置请求的输入与已记录选择不同',{code:'IDEMPOTENCY_MISMATCH',fix:'不覆盖原管理选择；查看原记录，继续工作用新修订'});
    return finishAbandon(ctx,stored,decision);
  });
}
export async function finishAbandon(ctx:EngineContext,stored:StoredRecord<RunRecord>,decision:StoredRecord<ActionBody>):Promise<ManagementReceipt>{
  const input=Input.parse(decision.body.detail.input),run=stored.body;
  if(input.run!==run.run||input.run_record!==stored.digest)throw new IntegrityError('管理输入与冻结运行不符',{fix:'管理员从可信记录恢复对应关系后重放，不改写原运行'});
  const requests=createRequestService(ctx.deps.records,ctx.now),question=await requests.inspect(input.request);
  if(!question||question.run!==run.run)throw new IntegrityError('管理输入缺少原请求',{fix:'管理员恢复原请求记录后重放'});
  const system_input=recReference(decision.digest);
  const previous=await ctx.deps.records.store.find<ValidationResult>({kind:'validation_result',key:INDEX.resultSystemInput,value:system_input,limit:1});
  let saved=previous.items[0];let current=true;
  if(!saved){
    const prior=input.prior_result?await ctx.deps.records.store.get<ValidationResult>(input.prior_result):null;
    if(input.prior_result&&(prior?.kind!=='validation_result'||prior.body.run!==run.run))throw new IntegrityError('管理输入指向的原结果不可核对',{fix:'管理员恢复所指原结果后重放；不补造旧终态'});
    const old=prior?.body,counts=old?partitionCountsOf(old.partitions):null;
    const parts:ValidationResult['partitions']={delivered:[],rejected:[],quarantined:[],incomplete:[]};
    const source=new Map(Object.entries(old?.partitions??{}).flatMap(([partition,items])=>(items as ItemResult[]).map(item=>[item.item,{partition,item}] as const)));
    let unwritten=0;
    for(const item of run.items){
      const original=source.get(item.id);
      const requirements=original?.item.requirements.map(r=>({...structuredClone(r),claims:[],status:'unsatisfied' as const,unsatisfied_reason:'abandoned' as const,layers:r.layers.map(layer=>{
        const copy=structuredClone(layer);
        if(copy.terminal==='unchecked'||copy.terminal==='incomplete'||copy.terminal==='no_verdict'||copy.terminal==='not_run'){
          if(!copy.missing){unwritten++;copy.missing='旧技术记录未写具体缺失事实；本次是管理投影，未重验，原记录不回填';}
          if(!copy.exit){unwritten++;copy.exit={action:'request',request_kind:'disposition',audience:{user:question.audience},due:question.due};}
        }
        return copy;
      })}))??run.requirements.map(r=>({requirement:r.key,claims:[],status:'unsatisfied' as const,unsatisfied_reason:'abandoned' as const,layers:r.layers.map(layer=>({layer,terminal:'incomplete' as const,reason:'not_covered' as const,missing:'没有已受理的条目提交；本次只记录管理放弃',exit:{action:'request' as const,request_kind:'disposition' as const,audience:{user:question.audience},due:question.due}}))}));
      const projected={item:item.id,label:item.label,location:item.location,requirements};
      if(original?.partition==='quarantined')parts.quarantined.push({...projected,reason:'integrity_unproven'});else parts.delivered.push(projected);
    }
    const result:ValidationResult={schema:'validation@1',run:run.run,submission:digestOf(input),system_input,acceptance:'accepted',errors:[],rounds:old?.rounds??{used:0,max:Math.max(0,...run.requirements.map(r=>r.repair_rounds))},partitions:parts,cross_item:[Claim.parse({statement:{text:'已记录管理放弃；技术层沿用来源记录，未重新核验，原效果及冻结不改写',data:{run_disposition:'abandon',decided_by:input.decided_by,reason:input.reason,previous_result:input.prior_result,previous_counts:counts,legacy_unwritten_fields:unwritten}},qualifier:{nature:'fact',provenance:'observed',basis_rank:'rule_over_observation',marks:[]},grounds:[system_input,...(input.prior_result?[recReference(input.prior_result)]:[])],warrant:{producer:'function',id:ENGINE_COMPONENT},validity:{status:'valid',bound:[stored.digest,decision.digest,...(input.prior_result?[input.prior_result]:[])],premises:[]}})],coverage:{complete:true,examined:run.items.length,total:run.items.length,note:'管理处置覆盖全部条目；技术层未重验，原未知计数保留；旧缺字段只引用本次真实管理出口，不回填原件'},locks:{...(run.feeding_offset?{feeding_offset:run.feeding_offset}:{}),pack:run.pack,pack_digest:run.pack_digest,...(run.root?{root:run.root}:{})},trace:input.trace};
    saved=await putResult(ctx.deps.records.store,result,ctx.now().toISOString());
  }else current=(await abandonDecision(ctx,run.run))?.digest===decision.digest;
  for(const request of await requests.all(run.run))if(request.answered_by===null&&(request.record===input.request||request.audience===(run.runner??run.configurer)&&!request.job&&!request.pack_digest&&!request.sources?.length))await requests.answer(request.record,decision.digest);
  return {record:saved.digest,result:saved.body,decision:decision.digest,created:previous.items.length===0,current};
}
