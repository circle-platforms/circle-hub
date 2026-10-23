import { submitResult } from './submit.ts';
import { isObject, receivedDigest } from './util.ts';
import { randomBytes } from 'node:crypto';
// Startup and periodic deterministic maintenance. It writes new records; no historical run/result is changed.
import { digestOf, type Page, type StoredRecord } from '../../records/api.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { PARTITION } from '../../../contracts/generated/vocabulary.ts';
import type { EngineContext } from './deps.ts';
import { latestAccepted, listRunRecords, putAction, putResult, submissionsOf, actionOfSubmission, actionsOf, isVerbatimObject } from './store.ts';
import { putRequest, recordResultRequests } from './requests.ts';

export async function maintainRuns(ctx:EngineContext):Promise<void>{
  let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<RunRecord>>=await listRunRecords(ctx.deps.records.store,{}, {limit:200,cursor});
    for(const run of page.items){await recoverRun(ctx,run);await ctx.lock(`submit:${run.body.run}`,()=>expireRun(ctx,run));}
    cursor=page.next;
  }while(cursor!==null);
}
async function expireRun(ctx:EngineContext,stored:StoredRecord<RunRecord>):Promise<void>{
  const run=stored.body;
  if(await latestAccepted(ctx.deps.records.store,run.run))return;
  const runner=run.runner??run.configurer;
  if(!runner)throw new Error('运行缺少具名接收者');
  const now=ctx.now();
  if(!run.submission_due){
    await putRequest(ctx,{run:run.run,kind:'disposition',audience:runner,due:new Date(now.getTime()+86400000).toISOString(),source:stored.digest,code:'not_covered',missing:'旧运行没有记录提交期限',next_action:'用 start_run 以本运行为 predecessor 开带 submission_due 的新修订，或由运行者明确放弃'});
    return;
  }
  if(Date.parse(run.submission_due)>now.getTime())return;
  const submission=digestOf({run:stored.digest,submission_due:run.submission_due});
  const due=new Date(now.getTime()+86400000).toISOString();
  const request=await putRequest(ctx,{run:run.run,kind:'disposition',audience:runner,due,source:stored.digest,code:'not_covered',missing:`到 ${run.submission_due} 仍没有已受理的完整提交`,next_action:'用 start_run 以本运行为 predecessor 续跑新修订，或由运行者明确放弃；完整的新提交仍可用 submit_result 交到原运行'});
  const partitions=Object.fromEntries(PARTITION.map(p=>[p,[]])) as unknown as ValidationResult['partitions'];
  partitions.incomplete=run.items.map(item=>({item:item.id,label:item.label,location:item.location,reason:'not_covered',requirements:run.requirements.map(r=>({requirement:r.key,status:'pending',claims:[],layers:r.layers.map(layer=>({layer,terminal:'incomplete' as const,reason:'not_covered' as const,missing:`未在 ${run.submission_due} 前收到条目 ${item.id} / ${r.key} 的完整提交`,exit:{action:'request' as const,request_kind:'disposition' as const,audience:{user:runner},due:request.body.due}}))}))}));
  const result:ValidationResult={schema:'validation@1',run:run.run,submission,acceptance:'accepted',errors:[{code:'not_covered',message:request.body.missing,fix:`请求 rec:${request.digest}：${request.body.next_action}`}],rounds:{used:0,max:Math.max(0,...run.requirements.map(r=>r.repair_rounds))},partitions,cross_item:[],coverage:{complete:false,examined:0,total:run.items.length,note:'提交期限已过，Hub 按未覆盖交付'},locks:{pack:run.pack,pack_digest:run.pack_digest,...(run.root?{root:run.root}:{})},trace:randomBytes(16).toString('hex')};
  await recordResultRequests(ctx,run,result);
  const saved=await putResult(ctx.deps.records.store,result,now.toISOString());
  await putAction(ctx.deps.records.store,{action:'validate',run:run.run,inputs:[`rec:${stored.digest}`],startedAt:now.toISOString(),endedAt:ctx.now().toISOString(),acceptance:null,codes:['not_covered'],detail:{deadline:true,submission,result:saved.digest,repair:[]}});
}

async function recoverRun(ctx:EngineContext,stored:StoredRecord<RunRecord>):Promise<void>{
  const run=stored.body;
  const account=await ctx.deps.records.principals?.get(run.runner??run.configurer??'');
  if(!account||account.disabled)return;
  for(const submission of await submissionsOf(ctx.deps.records.store,run.run)){
    const action=await actionOfSubmission(ctx.deps.records.store,submission.digest);
    if(action&&action.body.detail.hub_error!==true)continue;
    const detail=action?.body.detail;
    const independent=run.requirements.some(r=>r.accepted_producer==='independent_judgment');
    const historicalSession=detail&&typeof detail.session==='string'?detail.session:null;
    const failures=(await actionsOf(ctx.deps.records.store,run.run)).filter(a=>a.body.detail.hub_error===true&&a.body.detail.submission===(isObject(submission.body)?receivedDigest(submission.body).digest:null)).length;
    if(isVerbatimObject(submission)||!isObject(submission.body)||independent&&historicalSession===null||failures>=3){
      const admin=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled);
      if(!admin)throw new Error('中断重验缺少具名管理员');
      const missing=independent&&historicalSession===null?`提交记录 ${submission.digest} 当时没有记录会话 id`:`提交记录 ${submission.digest} 的核验仍未完成`;
      await putRequest(ctx,{run:run.run,kind:'repair',audience:admin.id,due:new Date(ctx.now().getTime()+86400000).toISOString(),missing,source:submission.digest,code:'check_error',next_action:independent&&historicalSession===null?'请原提交者带 Circle-Session-Id 原样 submit_result；不能补造历史会话':'管理员修复核验故障后，请原提交者带原会话原样 submit_result'});
      continue;
    }
    await submitResult(ctx,{id:account.id,name:account.name,role:account.role},submission.body,{traceId:randomBytes(16).toString('hex'),sessionId:historicalSession});
  }
}
