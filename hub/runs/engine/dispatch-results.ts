import { requestRecords } from './requests.ts';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
// Read existing dispatch observations only. No planning, dispatching or resubmission lives here.
import { z } from 'zod';
import { DYNAMIC_TERMINAL, DynamicTerminalSchema, NatureSchema, QualifierMarkSchema, ReasonSchema, labelOf, type DynamicTerminal, type QualifierMark, type Reason } from '../../../contracts/generated/vocabulary.ts';
import { Claim } from '../../../contracts/src/claim.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ValidationResult, LayerResult } from '../../../contracts/src/validation.ts';
import type { RunJob } from '../../dispatch/api.ts';
import { parseReference } from '../../refs/api.ts';
import type { EngineContext } from './deps.ts';
import { partitionItems, type PartitionInput } from './partitions.ts';
import { bindRecovery, expectationFor, meets, requirementStatus } from './terminals.ts';
import { aggregate, INTERMITTENT_MARK, repetitionSummary, type RoundOutcome } from './repetition.ts';
import { earlyStopSentence } from '../../dispatch/rounds.ts';

const Row=z.object({item:z.string(),dynamic_terminal:DynamicTerminalSchema,qualifier:z.object({nature:NatureSchema.extract(['judgment','unknown']),marks:z.array(QualifierMarkSchema)}),accepted_as_fact:z.literal(false),missing_facts:z.array(z.string()).optional(),code:z.string().optional(),judgment_premises:z.array(Claim).optional(),report_check:z.object({condition:z.string(),pointer:z.string(),declared_pointer:z.string(),resolved:z.boolean(),present:z.boolean(),actual_sha256:z.string(),result_definition_sha256:z.string(),mapped_terminal:DynamicTerminalSchema.optional(),missing_fact:z.string().optional(),next_action:z.string().optional()}).optional(),missing_fact:z.string().optional(),next_action:z.string().optional()});
const RoundNote=z.object({round:z.number().int(),terminal:DynamicTerminalSchema,code:z.string().optional(),meets:z.boolean().nullable().optional(),reason:ReasonSchema.optional(),early_stop:z.boolean().optional(),pending:z.boolean().optional(),lost:z.boolean().optional()});
const Projection=z.object({job:z.string(),sha256:z.string(),rows:z.array(Row),rounds:z.array(RoundNote).optional()});
export function appliesTo(job:RunJob,run:string,item:string):boolean{return job.verification_run===run?job.verification_item===item:job.plan_run===run&&job.items.includes(item);}
export async function applyDispatchResults(ctx:EngineContext,run:RunRecord,result:ValidationResult,jobs?:RunJob[]):Promise<boolean>{
  if(!ctx.deps.dispatch&&!jobs)return false;
  const admin=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled);
  if(!admin)throw new Error('派发观察缺少具名管理员');
  jobs??=await ctx.deps.dispatch!.jobs({id:admin.id,name:admin.name,role:admin.role},run.run);
  if(!jobs.length)return false;
  const workflow=await ctx.deps.workflows.byDigest(run.pack_digest);
  if(!workflow)throw new Error('派发观察缺少锁定的要求项模板');
  const questions=await requestRecords(ctx,run.run);
  const reports=new Map<string,z.infer<typeof Projection>|null>();
  for(const job of jobs){
    let report:z.infer<typeof Projection>|null=null;
    if(job.status.result){
      const ref=parseReference(job.status.result);
      if(ref.scheme==='src'){
        const source=await ctx.deps.records.artifacts.source({id:admin.id,name:admin.name,role:admin.role},ref.sha256,{consumer:'function'});
        if(source?.bytes&&'generated'in source.artifact.body.origin&&source.artifact.body.origin.generated.generator==='dispatch@1'&&source.artifact.body.author.user===null&&source.artifact.body.provenance_type==='projected'){
          let json:unknown;try{json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(source.bytes));}catch{json=null;}
          const parsed=Projection.safeParse(json);
          if(parsed.success&&parsed.data.job===job.job&&parsed.data.sha256===job.sha256&&parsed.data.rows.length===job.items.length&&new Set(parsed.data.rows.map(r=>r.item)).size===job.items.length&&parsed.data.rows.every(r=>job.items.includes(r.item)))report=parsed.data;
        }
      }
    }
    reports.set(job.job,report);
  }
  const required=new Set(workflow.requirements.filter(r=>r.required).map(r=>r.key));
  const inputs:PartitionInput[]=[];
  for(const [partition,items] of Object.entries(result.partitions))for(const item of items){
    const relevant=jobs.filter(job=>appliesTo(job,run.run,item.item));
    const disposed=(job:RunJob)=>Boolean(job.status.decided_by&&job.status.decided_at&&(job.status.disposition==='mark_failed'||job.status.disposition==='abandon'));
    const frozen=relevant.some(job=>!disposed(job)&&(job.status.frozen||job.status.outcome==='unknown'||job.status.outcome==='read_back_mismatch'));
    const rejectDisposed=relevant.some(job=>disposed(job)&&job.status.disposition==='mark_failed');
    const abandonDisposed=relevant.some(job=>disposed(job)&&job.status.disposition==='abandon');
    for(const requirement of item.requirements){
      const template=workflow.requirements.find(t=>t.key===requirement.requirement);
      if(!template?.layers.includes('dynamic')||template.observation!=='dispatch@1'||!relevant.length)continue;
      const rows=relevant.flatMap(job=>(reports.get(job.job)?.rows??[]).filter(r=>job.verification_run===run.run||r.item===item.item));
      const allKnown=rows.length>0&&relevant.every(j=>reports.get(j.job)!==null)&&!frozen;
      const notExecuted=relevant.every(j=>j.status.outcome==='not_dispatched'||j.status.outcome==='proven_not_executed'||j.status.outcome==='target_rejected')&&!frozen;
      const terminal:DynamicTerminal=notExecuted?'not_run':allKnown&&rows.every(r=>r.dynamic_terminal==='pass')?'pass':allKnown&&rows.some(r=>r.dynamic_terminal==='fail')?'fail':'no_verdict';
      const due=new Date(ctx.now().getTime()+86400000).toISOString();
      let dynamic:LayerResult;
      if(terminal==='pass'||terminal==='fail')dynamic={layer:'dynamic',terminal,...(terminal==='fail'&&rows.find(r=>r.code)?.code?{code:rows.find(r=>r.code)!.code}:{}),...(terminal==='fail'?{attribution:'unattributed' as const}:{})};
      else dynamic=bindRecovery({layer:'dynamic',terminal,reason:notExecuted?'awaiting_step':'integrity_unproven'},{runner:run.runner??run.configurer!,owner:admin.id,administrator:admin.id,due,location:`作业 ${relevant.map(j=>j.job).join('、')} / ${item.item}`},[{verdict:'unknown',reason:notExecuted?'awaiting_step':'integrity_unproven',missing:notExecuted?'原派发已证明未执行，缺少新一次执行后的目标观察':relevant.map(j=>'作业 '+j.job+'：'+(reports.get(j.job)===null?'缺少与原作业及产物摘要绑定的完整观察':'缺少完整的逐条目动态结论')).concat(rows.flatMap(r=>r.missing_fact?[r.missing_fact]:r.missing_facts??[])).join('；'),statement:'派发观察尚未证明完整性',grounds:[],tier:'advisory'}]);
      if(rejectDisposed||abandonDisposed){
        const final=relevant.find(job=>disposed(job));
        const recorded=final?.management_exit;
        const question=final?questions.find(q=>q.job===final.job):undefined;
        if(recorded)dynamic.exit=recorded;
        else if(question)dynamic.exit={action:'request',request_kind:question.kind,audience:{user:question.audience},due:question.due};
        else if(dynamic.terminal==='no_verdict'){dynamic.reason='check_error';dynamic.missing='已记录具名处置，但缺少可核对的原管理出口；从现成审计重读，原件确未写的只记录缺失事件，不回填受众或期限';}
      }
      requirement.layers=requirement.layers.map(layer=>layer.layer==='dynamic'?dynamic:layer);
      requirement.claims=requirement.claims.filter(c=>c.warrant.id!=='dispatch@1');
      for(const job of relevant)for(const row of reports.get(job.job)?.rows??[]){
        if(job.verification_run!==run.run&&row.item!==item.item)continue;
        requirement.claims.push(Claim.parse({item:item.item,requirement:requirement.requirement,statement:{text:`作业 ${job.job} 的条目 ${row.item} 动态观察：${labelOf('dynamic_terminal',row.dynamic_terminal)}`,data:{job:job.job,item:row.item,terminal:row.dynamic_terminal,accepted_as_fact:row.accepted_as_fact,missing_facts:row.missing_facts??[],...(row.judgment_premises?.length?{judgment_premises:row.judgment_premises}:{}),...(row.report_check?{report_check:row.report_check}:{}),...(row.missing_fact?{missing_fact:row.missing_fact,next_action:row.next_action}:{})}},qualifier:{nature:row.qualifier.nature,provenance:'projected',marks:row.qualifier.marks},grounds:[job.status.result!],warrant:{producer:'function',id:'dispatch@1'},validity:{status:'valid',bound:[run.pack_digest,job.sha256],premises:[]}}));
      }
      const expectation=expectationFor(template,run.items.find(i=>i.id===item.item)?.fields??{});
      const staticRefutes=requirement.claims.filter(c=>c.statement.verdict==='refute');
      // V07 R[0]-R[3]: every job of this item is one round, in journal order, and the policy frozen with the run
      // aggregates them. A round without a judgment keeps the weakest terminal and stays in the denominator. The count
      // comes from the frozen summary, so a run stored before the field existed aggregates its one round as 1/1.
      const frozenPolicy=run.requirements.find(row=>row.key===requirement.requirement)?.repetition;
      const policy=frozenPolicy??repetitionSummary({layers:template.layers,declared:template.repetition});
      const roundRefutation=staticRefutes.length>0&&staticRefutes.every(c=>c.statement.code!==undefined&&expectation.codes.includes(c.statement.code));
      const noted=relevant.flatMap(job=>(reports.get(job.job)?.rounds??[]).map(note=>({job:job.job,note})));
      const byRound=new Map<number,typeof noted[number]>();
      for(const entry of noted)byRound.set(entry.note.round,entry);
      const rounds:RoundOutcome[]=byRound.size>0?[...byRound.values()].map(({note})=>{
        const settled=note.terminal==='pass'||note.terminal==='fail';
        return {round:note.round,terminal:note.terminal,...(note.code?{code:note.code}:{}),...(settled?{meets:note.meets===true}:{})};
      }):relevant.map((job,at)=>{
        const row=(reports.get(job.job)?.rows??[]).find(r=>r.item===item.item);
        const terminal:DynamicTerminal=row?.dynamic_terminal??(job.status.outcome==='not_dispatched'||job.status.outcome==='proven_not_executed'||job.status.outcome==='target_rejected'?'not_run':'no_verdict');
        const settled=terminal==='pass'||terminal==='fail';
        const roundLayer={layer:'dynamic' as const,terminal,...(row?.code?{code:row.code}:{})};
        return {round:at+1,terminal,...(row?.code?{code:row.code}:{}),...(settled?{meets:meets(roundLayer,expectation,roundRefutation,template.accepted_producer)}:{})};
      });
      const rolled=aggregate(rounds,{count:policy.count,aggregation:policy.aggregation,...(policy.k===undefined?{}:{k:policy.k})});
      const early=noted.filter(entry=>entry.note.early_stop===true).length;
      const passedRound=noted.find(entry=>entry.note.meets===true)?.note.round;
      requirement.layers=requirement.layers.map(layer=>{
        if(layer.layer!=='dynamic')return layer;
        const openReason=noted.find(entry=>entry.note.terminal===rolled.terminal&&(entry.note.reason==='budget_exhausted'||entry.note.reason==='integrity_unproven'))?.note.reason;
        const unsettled=rolled.terminal==='not_run'||rolled.terminal==='no_verdict'||rolled.terminal==='incomplete';
        const reason:Reason=openReason==='budget_exhausted'||openReason==='integrity_unproven'?openReason:layer.reason??'integrity_unproven';
        const base=unsettled&&layer.reason===undefined?bindRecovery({layer:'dynamic',terminal:rolled.terminal,reason},{runner:run.runner??run.configurer!,owner:admin.id,administrator:admin.id,due,location:`作业 ${relevant.map(j=>j.job).join('、')} / ${item.item}`},[{verdict:'unknown',reason,missing:rolled.missing??'缺轮次判定',statement:'派发观察尚未证明完整性',grounds:[],tier:'advisory'}]):layer;
        const enriched={...base,terminal:rolled.terminal,...(rolled.terminal==='pass'||rolled.code===undefined?{}:{code:rolled.code}),...(unsettled?{reason}:{}),rounds:rolled.distribution.rounds,distribution:{count:rolled.distribution.count,by_terminal:rolled.distribution.byTerminal,...(early>0?{early_stop:early}:{})},...(rolled.marks.includes(INTERMITTENT_MARK)?{intermittent:true}:{}),observation:early>0&&passedRound!==undefined?earlyStopSentence(passedRound,early):rolled.text};
        if(rolled.outcome==='meets'||enriched.terminal==='pass'){delete enriched.attribution;if(enriched.terminal==='pass'){delete enriched.reason;delete enriched.missing;delete enriched.exit;delete enriched.code;}}
        else if(rolled.outcome==='misses')enriched.attribution='unattributed';
        if(rolled.missing!==undefined&&enriched.missing===undefined&&enriched.terminal!=='pass')enriched.missing=rolled.missing;
        return enriched as LayerResult;
      }) as typeof requirement.layers;
      if(byRound.size>0){
        const parts=DYNAMIC_TERMINAL.flatMap(name=>{const found=rolled.distribution.byTerminal[name];return found>0?[`${found} 次${labelOf('dynamic_terminal',name)}`]:[];});
        const grounds=relevant.flatMap(job=>job.status.result?[job.status.result]:[]);
        const marks:QualifierMark[]=[];
        marks.push('target_reported','report_for_dispatch','local_ops_not_excluded',...(rows.some(row=>row.qualifier.marks.includes('conditional_on_judgment'))?['conditional_on_judgment' as const]:[]));
        requirement.claims.push(Claim.parse({item:item.item,requirement:requirement.requirement,statement:{text:`目标报告：${rolled.distribution.count} 次里 ${parts.join('、')}${rolled.marks.includes(INTERMITTENT_MARK)?'（间歇）':''}`,verdict:'unknown',data:{distribution:rolled.distribution.byTerminal,count:rolled.distribution.count}},qualifier:{nature:'unknown',provenance:'projected',marks},grounds,warrant:{producer:'function',id:'dispatch@1'},validity:{status:'valid',bound:[run.pack_digest],premises:[]}}));
      }
      if(rolled.outcome==='misses'&&byRound.size>0)await writeHypothesis(ctx,run,item.item,requirement.requirement);
      const status=requirementStatus({producer:template.accepted_producer,layers:requirement.layers,hasProducer:!((terminal==='pass'||terminal==='fail')&&template.accepted_producer==='fact'&&rows.some(r=>!r.accepted_as_fact)),expectation,expectedRefutation:staticRefutes.length>0&&staticRefutes.every(c=>c.statement.code!==undefined&&expectation.codes.includes(c.statement.code)),independence:requirement.unsatisfied_reason==='independence_unknown'?'unknown':null,acceptsDeclared:template.accepts_declared_independence===true});
      delete requirement.unsatisfied_reason;Object.assign(requirement,status);
      if(abandonDisposed){requirement.status='unsatisfied';requirement.unsatisfied_reason='abandoned';}
    }
    inputs.push({item:item.item,label:item.label,location:item.location,requirements:item.requirements,required,notCovered:partition==='incomplete'&&'reason'in item&&item.reason==='not_covered',rejection:partition==='rejected'&&'code'in item?item.code:null,hooks:{...(frozen?{quarantine:'integrity_unproven' satisfies Reason}:{}),...(rejectDisposed?{dispositionReject:'EFFECT_UNKNOWN_DISPOSED' satisfies keyof typeof PROTOCOL_CODES}:{}),...(abandonDisposed?{abandon:true}:{})},...(item.skip_reason?{skipReason:item.skip_reason}:{}),...(item.carried_over?{carriedOver:item.carried_over}:{})});
  }
  result.partitions=partitionItems(inputs,run.items.map(i=>i.id));
  return true;
}

/** V04 R[1] / V08: the three causes of a miss stay a hypothesis set and never become the attribution. */
async function writeHypothesis(ctx:EngineContext,run:RunRecord,item:string,requirement:string):Promise<void>{
  const marker=`${run.run}:${item}:${requirement}`;
  const prior=await ctx.deps.records.store.find({kind:'claim',key:'runs.hypothesis.item',value:marker,limit:1});
  if(prior.items.length)return;
  await ctx.deps.records.store.put({kind:'claim',schema:'hypothesis-set@1',provenance:'projected',created_at:ctx.now().toISOString(),body:{run:run.run,item,requirement,question:'汇总不合期望',hypotheses:[{statement:'被测对象缺陷',status:'open'},{statement:'环境',status:'open'},{statement:'执行上下文',status:'open'}],residual:{statement:'其他',status:'open'}},index:[{key:'runs.hypothesis.item',value:marker}]});
}
