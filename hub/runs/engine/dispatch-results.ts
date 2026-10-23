import { requestRecords } from './requests.ts';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
// Read existing dispatch observations only. No planning, dispatching or resubmission lives here.
import { z } from 'zod';
import { DynamicTerminalSchema, NatureSchema, QualifierMarkSchema, labelOf, type Reason } from '../../../contracts/generated/vocabulary.ts';
import { Claim } from '../../../contracts/src/claim.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ValidationResult, LayerResult } from '../../../contracts/src/validation.ts';
import type { RunJob } from '../../dispatch/api.ts';
import { parseReference } from '../../refs/api.ts';
import type { EngineContext } from './deps.ts';
import { partitionItems, type PartitionInput } from './partitions.ts';
import { bindRecovery, expectationFor, requirementStatus } from './terminals.ts';

const Row=z.object({item:z.string(),dynamic_terminal:DynamicTerminalSchema,qualifier:z.object({nature:NatureSchema.extract(['judgment','unknown']),marks:z.array(QualifierMarkSchema)}),accepted_as_fact:z.literal(false),missing_facts:z.array(z.string()).optional(),code:z.string().optional()});
const Projection=z.object({job:z.string(),sha256:z.string(),rows:z.array(Row)});
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
      const terminal=notExecuted?'not_run':allKnown&&rows.every(r=>r.dynamic_terminal==='pass')?'pass':allKnown&&rows.some(r=>r.dynamic_terminal==='fail')?'fail':'no_verdict';
      const due=new Date(ctx.now().getTime()+86400000).toISOString();
      let dynamic:LayerResult;
      if(terminal==='pass'||terminal==='fail')dynamic={layer:'dynamic',terminal,...(terminal==='fail'&&rows.find(r=>r.code)?.code?{code:rows.find(r=>r.code)!.code}:{}),...(terminal==='fail'?{attribution:'unattributed' as const}:{})};
      else dynamic=bindRecovery({layer:'dynamic',terminal,reason:notExecuted?'awaiting_step':'integrity_unproven'},{runner:run.runner??run.configurer!,owner:admin.id,administrator:admin.id,due,location:`作业 ${relevant.map(j=>j.job).join('、')} / ${item.item}`},[{verdict:'unknown',reason:notExecuted?'awaiting_step':'integrity_unproven',missing:notExecuted?'原派发已证明未执行，缺少新一次执行后的目标观察':relevant.map(j=>'作业 '+j.job+'：'+(reports.get(j.job)===null?'缺少与原作业及产物摘要绑定的完整观察':'缺少完整的逐条目动态结论')).concat(rows.flatMap(r=>r.missing_facts??[])).join('；'),statement:'派发观察尚未证明完整性',grounds:[],tier:'advisory'}]);
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
        requirement.claims.push(Claim.parse({item:item.item,requirement:requirement.requirement,statement:{text:`作业 ${job.job} 的条目 ${row.item} 动态观察：${labelOf('dynamic_terminal',row.dynamic_terminal)}`,data:{job:job.job,item:row.item,terminal:row.dynamic_terminal,accepted_as_fact:row.accepted_as_fact,missing_facts:row.missing_facts??[]}},qualifier:{nature:row.qualifier.nature,provenance:'projected',marks:row.qualifier.marks},grounds:[job.status.result!],warrant:{producer:'function',id:'dispatch@1'},validity:{status:'valid',bound:[run.pack_digest,job.sha256],premises:[]}}));
      }
      const expectation=expectationFor(template,run.items.find(i=>i.id===item.item)?.fields??{});
      const staticRefutes=requirement.claims.filter(c=>c.statement.verdict==='refute');
      const status=requirementStatus({layers:requirement.layers,hasProducer:!((terminal==='pass'||terminal==='fail')&&template.accepted_producer==='fact'&&rows.some(r=>!r.accepted_as_fact)),expectation,expectedRefutation:staticRefutes.length>0&&staticRefutes.every(c=>c.statement.code!==undefined&&expectation.codes.includes(c.statement.code)),independence:requirement.unsatisfied_reason==='independence_unknown'?'unknown':null,acceptsDeclared:template.accepts_declared_independence===true});
      delete requirement.unsatisfied_reason;Object.assign(requirement,status);
      if(abandonDisposed){requirement.status='unsatisfied';requirement.unsatisfied_reason='abandoned';}
    }
    inputs.push({item:item.item,label:item.label,location:item.location,requirements:item.requirements,required,notCovered:partition==='incomplete'&&'reason'in item&&item.reason==='not_covered',rejection:partition==='rejected'&&'code'in item?item.code:null,hooks:{...(frozen?{quarantine:'integrity_unproven' satisfies Reason}:{}),...(rejectDisposed?{dispositionReject:'EFFECT_UNKNOWN_DISPOSED' satisfies keyof typeof PROTOCOL_CODES}:{}),...(abandonDisposed?{abandon:true}:{})},...(item.skip_reason?{skipReason:item.skip_reason}:{}),...(item.carried_over?{carriedOver:item.carried_over}:{})});
  }
  result.partitions=partitionItems(inputs,run.items.map(i=>i.id));
  return true;
}
