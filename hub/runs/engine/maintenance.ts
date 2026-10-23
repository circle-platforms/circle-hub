import { parseReference } from '../../refs/api.ts';
import { submitResult } from './submit.ts';
import { isObject, receivedDigest } from './util.ts';
import { randomBytes } from 'node:crypto';
// Startup and periodic deterministic maintenance. It writes new records; no historical run/result is changed.
import { digestOf, type Page, type StoredRecord } from '../../records/api.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { PARTITION } from '../../../contracts/generated/vocabulary.ts';
import type { EngineContext } from './deps.ts';
import { latestAccepted, listRunRecords, putAction, putResult, submissionsOf, submissionByDigest, actionOfSubmission, actionsOf, isVerbatimObject } from './store.ts';
import { putRequest, recordResultRequests, requestRecords, answerRequest } from './requests.ts';

export async function maintainRuns(ctx:EngineContext):Promise<void>{
  let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<RunRecord>>=await listRunRecords(ctx.deps.records.store,{}, {limit:200,cursor});
    for(const run of page.items){await rootUpdateRequest(ctx,run);await recoverRun(ctx,run);await ctx.lock(`submit:${run.body.run}`,()=>expireRun(ctx,run));}
    cursor=page.next;
  }while(cursor!==null);
  await repairedPackRequests(ctx);
  await acceptedSourceRequests(ctx);
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

async function rootUpdateRequest(ctx:EngineContext,stored:StoredRecord<RunRecord>):Promise<void>{
  const run=stored.body;
  if(!run.runner||!run.product||!run.version||!run.root||!run.requirements.some(r=>r.accepted_producer!=='fact'))return;
  const current=await ctx.deps.knowledge.currentRoot(run.product,run.version);
  if(!current||current.root===run.root)return;
  const successors=await import('./store.ts').then(m=>m.successorsOf(ctx.deps.records.store,run.run));
  if(successors.some(s=>s.body.runner===run.runner&&s.body.pack.split('@')[0]===run.pack.split('@')[0]))return;
  await putRequest(ctx,{run:run.run,kind:'disposition',audience:run.runner,due:new Date(ctx.now().getTime()+86400000).toISOString(),missing:`锁定根 ${run.root} 与当前根 ${current.root} 不同，缺少新根上的复核`,source:stored.digest,code:'awaiting_step',next_action:'运行者用 start_run 以本运行为 predecessor、选当前构建开新修订重跑；原运行和原结果不改写'});
}
async function repairedPackRequests(ctx:EngineContext):Promise<void>{
  for(const request of await requestRecords(ctx)){
    if(request.answered_by!==null||!request.pack_digest||request.kind!=='repair')continue;
    const old=await ctx.deps.workflows.byDigest(request.pack_digest);
    if(!old)continue;
    const latest=await ctx.deps.packs.pack(old.pack.id);
    if(!latest||latest.digest===request.pack_digest)continue;
    const owner=await ctx.deps.workflows.ownerOf?.(latest.digest);
    const published=await ctx.deps.workflows.publicationOf?.(latest.digest);
    if(owner!==request.audience||!published)continue;
    await answerRequest(ctx,request.record,published);
    // Existing frozen runs still use their own version: the next step is a successor, never rewriting the old run.
    let cursor:string|null=null;
    do{
      const page:Page<StoredRecord<RunRecord>>=await listRunRecords(ctx.deps.records.store,{pack:old.pack.id},{limit:200,cursor});
      for(const run of page.items){if(run.body.pack_digest!==request.pack_digest||!run.body.runner)continue;
        await putRequest(ctx,{run:run.body.run,kind:'disposition',audience:run.body.runner,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:published,code:'awaiting_step',missing:'修复后的包版本已发布，旧运行仍锁定原版本',next_action:`运行者用 start_run 以本运行为 predecessor、包 ${latest.id}@${latest.version} 开新修订重跑`});}
      cursor=page.next;
    }while(cursor!==null);
  }
}

async function acceptedSourceRequests(ctx:EngineContext):Promise<void>{
  for(const request of await requestRecords(ctx)){
    if(request.answered_by!==null||!request.run||!request.sources?.length||request.kind!=='disposition')continue;
    const stored=await import('./store.ts').then(m=>m.runById(ctx.deps.records.store,request.run!));
    if(!stored)continue;
    const run=stored.body;
    const admin=await ctx.deps.records.principals?.get(request.audience);
    const runner=await ctx.deps.records.principals?.get(run.runner??run.configurer??'');
    if(!admin||admin.disabled||admin.role!=='admin'||!runner||runner.disabled)continue;
    let available=true;
    for(const reference of request.sources){
      const ref=parseReference(reference);
      if(ref.scheme!=='src'){available=false;break;}
      const source=await ctx.deps.records.artifacts.source({id:admin.id,name:admin.name,role:admin.role},ref.sha256,{consumer:'function'});
      if(!source||source.readTier==='retain_only'||source.bytes===null){available=false;break;}
    }
    if(!available)continue;
    const submission=await submissionByDigest(ctx.deps.records.store,run.run,request.source);
    if(!submission||!isObject(submission.body)||isVerbatimObject(submission))continue;
    const action=await actionOfSubmission(ctx.deps.records.store,submission.digest);
    const session=typeof action?.body.detail.session==='string'?action.body.detail.session:null;
    if(session===null&&run.requirements.some(r=>r.accepted_producer==='independent_judgment'))continue;
    const response=await submitResult(ctx,{id:runner.id,name:runner.name,role:runner.role},submission.body,{traceId:randomBytes(16).toString('hex'),sessionId:session},true);
    if(response.result?.acceptance==='accepted'){
      const result=await latestAccepted(ctx.deps.records.store,run.run);
      if(result)await answerRequest(ctx,request.record,result.digest);
    }
  }
}
