import {parentUnavailable,needsParentRecovery} from './parent-recovery.ts';
import {ENGINE_COMPONENT} from './deps.ts';
import { abandonDecision,finishAbandon } from './management.ts';
import { canSeeRun } from './readers.ts';
import { recheckProduction } from './start.ts';
import { isUnsettled } from './terminals.ts';
import { applyDispatchResults } from './dispatch-results.ts';
import { parseReference } from '../../refs/api.ts';
import { submitResult, roundsUsedOf } from './submit.ts';
import { isObject, receivedDigest } from './util.ts';
import { randomBytes } from 'node:crypto';
// Startup and periodic deterministic maintenance. It writes new records; no historical run/result is changed.
import { digestOf, canonicalBytes, type Page, type StoredRecord } from '../../records/api.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { PARTITION } from '../../../contracts/generated/vocabulary.ts';
import type { EngineContext } from './deps.ts';
import { latestAccepted, listRunRecords, putAction, putResult, submissionsOf, submissionByDigest, actionOfSubmission, actionsOf, isVerbatimObject } from './store.ts';
import { putRequest, recordResultRequests, requestRecords, answerRequest, answerSuccessorRequests } from './requests.ts';

export async function maintainRuns(ctx:EngineContext):Promise<void>{
  let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<RunRecord>>=await listRunRecords(ctx.deps.records.store,{}, {limit:200,cursor});
    for(const run of page.items){const stopped=await abandonDecision(ctx,run.body.run);if(stopped){await recoverManagement(ctx,run,stopped);await reconcileDispatch(ctx,run);continue;}if(run.body.predecessor){const before=await import('./store.ts').then(m=>m.runById(ctx.deps.records.store,run.body.predecessor!));if(before)await answerSuccessorRequests(ctx,before.body,run);}await reconcileDispatch(ctx,run);await rootUpdateRequest(ctx,run);await legacyResultRequests(ctx,run);await recoverRun(ctx,run);await recoverParent(ctx,run);await ctx.lock(`submit:${run.body.run}`,()=>expireRun(ctx,run));}
    cursor=page.next;
  }while(cursor!==null);
  await repairedPackRequests(ctx);
  await acceptedSourceRequests(ctx);
  await escalateOverdueRequests(ctx);
}
/** A committed human choice is never repeated; only its deterministic delivery projection is retried. */
async function recoverManagement(ctx:EngineContext,stored:StoredRecord<RunRecord>,decision:StoredRecord<import('../../records/api.ts').ActionBody>):Promise<void>{
  const actions=await actionsOf(ctx.deps.records.store,stored.body.run);
  const failures=Math.max(actions.filter(a=>a.body.detail.management_interrupted===decision.digest).length,actions.filter(a=>a.body.detail.management_recovery_started===decision.digest).length);
  const projected=await ctx.deps.records.store.find({kind:'validation_result',key:'runs.result.system_input',value:'rec:'+decision.digest,limit:1});
  if(failures>=3&&!projected.items.length){
    const admin=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled);
    if(!admin)throw new Error('管理交付恢复缺少具名管理员');
    await putRequest(ctx,{run:stored.body.run,kind:'repair',audience:admin.id,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:decision.digest,code:'check_error',missing:'管理选择 rec:'+decision.digest+' 已记录，但三次自动恢复仍未形成交付投影',next_action:'管理员修复记录写入或投影故障后，核对原管理选择，用 circle-hub run abandon '+stored.body.run+' --answer-request <原处置请求摘要> --reason <原理由> 原样重试；只补交付，不重做人的选择、不改旧件'});
    return;
  }
  if(!projected.items.length){
    const reservedAt=ctx.now().toISOString();
    await putAction(ctx.deps.records.store,{action:'validate',run:stored.body.run,inputs:['rec:'+decision.digest],startedAt:reservedAt,endedAt:reservedAt,acceptance:null,result:'unknown',codes:[],detail:{management_recovery_started:decision.digest,retry_attempt:failures+1,result:null}});
  }
  try{
    const result=await ctx.lock('submit:'+stored.body.run,()=>finishAbandon(ctx,stored,decision));
    for(const request of await requestRecords(ctx,stored.body.run))if(request.answered_by===null&&request.source===decision.digest&&request.kind==='repair'&&request.code==='check_error')await answerRequest(ctx,request.record,result.record);
  }catch(error){
    ctx.log({traceId:null,run:stored.body.run,what:'management projection retry',detail:String(error)});
    const at=ctx.now().toISOString();
    await putAction(ctx.deps.records.store,{action:'validate',run:stored.body.run,inputs:['rec:'+decision.digest],startedAt:at,endedAt:ctx.now().toISOString(),acceptance:null,codes:['check_error'],result:'error',errorCode:'check_error',detail:{management_interrupted:decision.digest,hub_error:true,retry_attempt:failures+1,result:null,fix:'Hub 自动恢复管理交付，三次后转具名管理员修复请求'}});
  }
}
async function expireRun(ctx:EngineContext,stored:StoredRecord<RunRecord>):Promise<void>{
  const run=stored.body;
  if(await latestAccepted(ctx.deps.records.store,run.run))return;
  const runner=run.runner??run.configurer;
  if(!runner)throw new Error('运行缺少具名接收者');
  const now=ctx.now();
  const account=await ctx.deps.records.principals?.get(runner);
  if(!account||account.disabled||!canSeeRun(account,run))return; // recoverRun has already issued the named administrator request.
  if(!run.submission_due){
    await putRequest(ctx,{run:run.run,answer_action:'rerun',kind:'disposition',audience:runner,due:new Date(now.getTime()+86400000).toISOString(),source:stored.digest,code:'not_covered',missing:'旧运行没有记录提交期限',next_action:'用 start_run 以本运行为 predecessor 开带 submission_due 的新修订，或由运行者明确放弃'});
    return;
  }
  if(Date.parse(run.submission_due)>now.getTime())return;
  const input={run:run.run,run_record:stored.digest,submission_due:run.submission_due,observed_at:now.toISOString()};
  const evidence=await putAction(ctx.deps.records.store,{action:'validate',run:run.run,inputs:['rec:'+stored.digest],startedAt:now.toISOString(),endedAt:ctx.now().toISOString(),acceptance:null,codes:[],detail:{input,deadline_checked:true,accepted_submission_absent:true}});
  const submission=digestOf(input);
  const due=new Date(now.getTime()+86400000).toISOString();
  const request=await putRequest(ctx,{run:run.run,answer_action:'rerun',kind:'disposition',audience:runner,due,source:stored.digest,code:'not_covered',missing:`到 ${run.submission_due} 仍没有已受理的完整提交`,next_action:'用 start_run 以本运行为 predecessor 续跑新修订，或由运行者明确放弃；完整的新提交仍可用 submit_result 交到原运行'});
  const partitions=Object.fromEntries(PARTITION.map(p=>[p,[]])) as unknown as ValidationResult['partitions'];
  partitions.incomplete=run.items.map(item=>({item:item.id,label:item.label,location:item.location,reason:'not_covered',requirements:run.requirements.map(r=>({requirement:r.key,status:'pending',claims:[],layers:r.layers.map(layer=>({layer,terminal:'incomplete' as const,reason:'not_covered' as const,missing:`未在 ${run.submission_due} 前收到条目 ${item.id} / ${r.key} 的完整提交`,exit:{action:'request' as const,request_kind:'disposition' as const,audience:{user:runner},due:request.body.due}}))}))}));
  const result:ValidationResult={schema:'validation@1',run:run.run,submission,system_input:'rec:'+evidence.digest,acceptance:'accepted',errors:[{code:'not_covered',message:request.body.missing,fix:`请求 rec:${request.digest}：${request.body.next_action}`}],rounds:{used:0,max:Math.max(0,...run.requirements.map(r=>r.repair_rounds))},partitions,cross_item:[],coverage:{complete:false,examined:0,total:run.items.length,note:'提交期限已过，Hub 按未覆盖交付'},locks:{...(run.feeding_offset?{feeding_offset:run.feeding_offset}:{}),pack:run.pack,pack_digest:run.pack_digest,...(run.root?{root:run.root}:{})},trace:randomBytes(16).toString('hex')};
  const saved=await putResult(ctx.deps.records.store,result,now.toISOString());
  await putAction(ctx.deps.records.store,{action:'validate',run:run.run,inputs:[`rec:${stored.digest}`],startedAt:now.toISOString(),endedAt:ctx.now().toISOString(),acceptance:null,codes:['not_covered'],detail:{deadline:true,submission,result:saved.digest,repair:[]}});
}

async function recoverRun(ctx:EngineContext,stored:StoredRecord<RunRecord>):Promise<void>{
  const run=stored.body;
  const account=await ctx.deps.records.principals?.get(run.runner??run.configurer??'');
  if(!account||account.disabled||!canSeeRun(account,run)){
    const admin=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled);
    if(!admin)throw new Error('维护缺少可确认的运行者和具名启用管理员');
    await putRequest(ctx,{run:run.run,kind:'disposition',audience:admin.id,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:stored.digest,code:'awaiting_step',missing:account?.disabled?'原运行者已停用，不能按其身份自动重验':account?'原运行者当前无权读取冻结的运行，不能按其身份自动重验':'缺少原运行者账号或 principals.get 读取接线',next_action:'管理员补齐身份接线或按既有管理步骤恢复账号，再由原运行者以原运行为 predecessor 续跑；不代填原会话'});
    return;
  }
  if(run.requirements.every(r=>r.accepted_producer==='fact')&&!await latestAccepted(ctx.deps.records.store,run.run)){
    await ctx.lock('submit:'+run.run,async()=>{
      if(await latestAccepted(ctx.deps.records.store,run.run))return;
      const history=await actionsOf(ctx.deps.records.store,run.run);
      const failures=Math.max(history.filter(a=>a.body.detail.production_interrupted===true).length,history.filter(a=>a.body.detail.production_recovery_started===stored.digest).length);
      if(failures>=3){
        const admin=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled);
        if(!admin)throw new Error('事实生产重验缺少具名管理员');
        await putRequest(ctx,{run:run.run,kind:'repair',audience:admin.id,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:stored.digest,code:'check_error',missing:'事实生产缺少完整校验结果，三次有限重验均未完成',next_action:'管理员按本运行的中断动作修复核验能力或拆分输入，再以本运行为 predecessor 重跑；不补造旧结果'});
        return;
      }
      const reservedAt=ctx.now().toISOString();
      await putAction(ctx.deps.records.store,{action:'validate',run:run.run,inputs:['rec:'+stored.digest],startedAt:reservedAt,endedAt:reservedAt,acceptance:null,result:'unknown',codes:[],detail:{production_recovery_started:stored.digest,retry_attempt:failures+1,result:null,fix:'恢复尝试已持久占用；即使进程终止也计入三次上限，耗尽后管理员修复并开新修订'}});
      try{await recheckProduction(ctx,stored,{id:account.id,name:account.name,role:account.role},randomBytes(16).toString('hex'));}
      catch(error){
        ctx.log({traceId:null,run:run.run,what:'production validation interrupted',detail:String(error)});
        const at=ctx.now().toISOString();
        await putAction(ctx.deps.records.store,{action:'validate',run:run.run,inputs:['rec:'+stored.digest],startedAt:at,endedAt:at,acceptance:null,codes:['check_error'],result:'error',errorCode:'check_error',detail:{hub_error:true,production:true,production_interrupted:true,retry_attempt:failures+1,result:null,fix:'Hub 将自动重验，三次后向具名管理员发修复请求'}});
      }
    });
  }
  for(const submission of await submissionsOf(ctx.deps.records.store,run.run)){
    const action=await actionOfSubmission(ctx.deps.records.store,submission.digest);
    if(action&&action.body.detail.hub_error!==true)continue;
    const detail=action?.body.detail;
    const independent=run.requirements.some(r=>r.accepted_producer==='independent_judgment');
    const historicalSession=detail&&typeof detail.session==='string'?detail.session:null;
    const history=await actionsOf(ctx.deps.records.store,run.run);
    const failures=Math.max(history.filter(a=>a.body.detail.hub_error===true&&a.body.detail.submission===(isObject(submission.body)?receivedDigest(submission.body).digest:null)).length,history.filter(a=>a.body.detail.recovery_submission===submission.digest).length);
    if(isVerbatimObject(submission)||!isObject(submission.body)||independent&&historicalSession===null||failures>=3){
      const admin=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled);
      if(!admin)throw new Error('中断重验缺少具名管理员');
      const missing=independent&&historicalSession===null?`提交记录 ${submission.digest} 当时没有记录会话 id`:`提交记录 ${submission.digest} 的核验仍未完成（自动恢复至多三次，包含进程终止前已预约的尝试）`;
      await putRequest(ctx,{run:run.run,kind:'repair',audience:admin.id,due:new Date(ctx.now().getTime()+86400000).toISOString(),missing,source:submission.digest,code:'check_error',next_action:independent&&historicalSession===null?'请原提交者带 Circle-Session-Id 原样 submit_result；不能补造历史会话':'管理员修复核验故障后，请原提交者带原会话原样 submit_result'});
      continue;
    }
    const reservedAt=ctx.now().toISOString();
    await putAction(ctx.deps.records.store,{action:'validate',run:run.run,inputs:['rec:'+submission.digest],startedAt:reservedAt,endedAt:reservedAt,acceptance:null,result:'unknown',codes:[],detail:{recovery_submission:submission.digest,retry_attempt:failures+1,result:null,fix:'恢复尝试已持久占用；即使进程终止也计入三次上限，耗尽后管理员修复并原样重交或开新修订'}});
    await submitResult(ctx,{id:account.id,name:account.name,role:account.role},submission.body,{traceId:randomBytes(16).toString('hex'),sessionId:historicalSession});
  }
}

async function rootUpdateRequest(ctx:EngineContext,stored:StoredRecord<RunRecord>):Promise<void>{
  const run=stored.body;
  if(!run.runner||!run.product||!run.root||!run.requirements.some(r=>r.accepted_producer!=='fact'))return;
  const declared=run.target_basis.flatMap(claim=>claim.statement.data?.field==='build'&&typeof claim.statement.data.value==='string'?[claim.statement.data.value]:[]);
  const names=[...new Set(declared)];
  const build=run.build??(names.length===1?names[0]:undefined);
  if(!build){await putRequest(ctx,{run:run.run,answer_action:'rerun',kind:'clarification',audience:run.runner,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:stored.digest,code:'awaiting_step',missing:'旧运行没有唯一可核验的冻结构建名；不能用版本线的新构建猜原目标',next_action:'运行者用 start_run 以本运行为 predecessor 并明确指定 build，重新冻结新修订；不回填旧运行的目标'});return;}
  const current=await ctx.deps.knowledge.rootOfBuild(run.product,build);
  if(!current||current.root===run.root)return;
  const successors=await import('./store.ts').then(m=>m.successorsOf(ctx.deps.records.store,run.run));
  if(successors.some(s=>s.body.runner===run.runner&&s.body.pack.split('@')[0]===run.pack.split('@')[0]))return;
  await putRequest(ctx,{run:run.run,answer_action:'rerun',kind:'disposition',audience:run.runner,due:new Date(ctx.now().getTime()+86400000).toISOString(),missing:`锁定根 ${run.root} 与当前根 ${current.root} 不同，缺少新根上的复核`,source:stored.digest,code:'awaiting_step',next_action:'运行者用 start_run 以本运行为 predecessor、选当前构建开新修订重跑；原运行和原结果不改写'});
}
async function repairedPackRequests(ctx:EngineContext):Promise<void>{
  for(const request of await requestRecords(ctx)){
    if(request.answered_by===null||!request.pack_digest||request.kind!=='repair')continue;
    const old=await ctx.deps.workflows.byDigest(request.pack_digest);
    const answer=await ctx.deps.records.store.get<{pack:string;version:string;digest:string}>(request.answered_by);
    if(!old||answer?.kind!=='pack_version'||answer.body.pack!==old.pack.id||answer.body.digest===request.pack_digest)continue;
    const owner=await ctx.deps.workflows.ownerOf?.(answer.body.digest);
    if(owner!==request.audience)continue;
    let cursor:string|null=null;
    do{
      const page:Page<StoredRecord<RunRecord>>=await listRunRecords(ctx.deps.records.store,{pack:old.pack.id},{limit:200,cursor});
      for(const run of page.items){if(run.body.pack_digest!==request.pack_digest||!run.body.runner||await abandonDecision(ctx,run.body.run))continue;
        await putRequest(ctx,{run:run.body.run,answer_action:'rerun',kind:'disposition',audience:run.body.runner,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:answer.digest,code:'awaiting_step',missing:'请求 rec:'+request.record+' 已由版本 '+answer.body.pack+'@'+answer.body.version+' 作答；旧运行仍锁定原版本',next_action:'运行者用 start_run 以本运行为 predecessor、包 '+answer.body.pack+'@'+answer.body.version+' 开新修订重跑；发布作答不改变旧判决'});}
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
    const proofInputs:string[]=[];
    for(const reference of request.sources){
      const ref=parseReference(reference);
      if(ref.scheme!=='src'){available=false;break;}
      const source=await ctx.deps.records.artifacts.source({id:admin.id,name:admin.name,role:admin.role},ref.sha256,{consumer:'function'});
      if(!source||source.readTier==='retain_only'||source.bytes===null){available=false;break;}
      proofInputs.push(reference,'rec:'+source.artifact.digest);
      if(source.acceptance?.kind==='direct')proofInputs.push('rec:'+source.acceptance.acceptance.authorization);
      else if(source.acceptance?.kind==='derived')for(const origin of source.acceptance.acceptance.sources)for(const acceptance of origin.acceptances)proofInputs.push('rec:'+acceptance.authorization);
    }
    if(!available)continue;
    const staleSource=(result:ValidationResult)=>[...result.cross_item,...Object.values(result.partitions).flat().flatMap(i=>i.requirements.flatMap(r=>r.claims))].some(claim=>{const rows=claim.statement.data?.unread_sources;return Array.isArray(rows)&&rows.some(row=>isObject(row)&&typeof row.reference==='string'&&request.sources!.includes(row.reference));});
    const at=ctx.now().toISOString();
    const observed=await putAction(ctx.deps.records.store,{action:'read',run:run.run,inputs:[...new Set(proofInputs)],startedAt:at,endedAt:ctx.now().toISOString(),acceptance:null,codes:[],detail:{request:request.record,sources_available:true}});
    if(await abandonDecision(ctx,run.run)){await answerRequest(ctx,request.record,observed.digest);continue;}
    const submission=await submissionByDigest(ctx.deps.records.store,run.run,request.source);
    if(!submission){
      if(request.source===stored.digest&&run.requirements.every(r=>r.accepted_producer==='fact')){const refreshed=await recheckProduction(ctx,stored,{id:runner.id,name:runner.name,role:runner.role},randomBytes(16).toString('hex'));if(refreshed&&!staleSource(refreshed.result))await answerRequest(ctx,request.record,observed.digest);}
      continue;
    }
    if(!isObject(submission.body)||isVerbatimObject(submission))continue;
    const action=await actionOfSubmission(ctx.deps.records.store,submission.digest);
    const session=typeof action?.body.detail.session==='string'?action.body.detail.session:null;
    if(session===null&&run.requirements.some(r=>r.accepted_producer==='independent_judgment'))continue;
    const response=await submitResult(ctx,{id:runner.id,name:runner.name,role:runner.role},submission.body,{traceId:randomBytes(16).toString('hex'),sessionId:session},true);
    if(response.result?.acceptance==='accepted'&&!staleSource(response.result)){
      const result=await latestAccepted(ctx.deps.records.store,run.run);
      if(result)await answerRequest(ctx,request.record,observed.digest);
    }
  }
}

async function reconcileDispatch(ctx:EngineContext,stored:StoredRecord<RunRecord>):Promise<void>{
  if(!ctx.deps.dispatch)return;
  const run=stored.body;
  const admin=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled);
  if(!admin)throw new Error('派发核对缺少具名管理员');
  const by={id:admin.id,name:admin.name,role:admin.role};
  let jobs=await ctx.deps.dispatch.jobs(by,run.run);
  if(!jobs.length)return;
  const actions=await actionsOf(ctx.deps.records.store,run.run);
  for(const job of jobs){
    const prior=[...actions].reverse().find(a=>a.body.detail.reconciled_job===job.job);
    const finalized=job.status.decided_by&&job.status.decided_at&&(job.status.disposition==='mark_failed'||job.status.disposition==='abandon');
    const uncertain=!finalized&&(job.status.frozen||job.status.outcome==='unknown'||job.status.outcome==='read_back_mismatch'||job.status.outcome==='issued');
    if(!uncertain||prior?.body.detail.events_after===job.status.events)continue;
    const at=ctx.now().toISOString();
    let events=job.status.events;
    try{events=(await ctx.deps.dispatch.reconcile(by,job.job)).events;}
    catch(error){ctx.log({traceId:null,run:run.run,what:'dispatch reconciliation',detail:String(error)});}
    await putAction(ctx.deps.records.store,{action:'read_back',run:run.run,inputs:[],startedAt:at,endedAt:ctx.now().toISOString(),acceptance:null,codes:[],detail:{reconciled_job:job.job,events_before:job.status.events,events_after:events}});
  }
  jobs=await ctx.deps.dispatch.jobs(by,run.run);
  for(const job of jobs){
    const requestSnapshot=dispatchSnapshot([job]);
    let observed=actions.find(a=>a.body.detail.dispatch_request_snapshot===requestSnapshot);
    if(!observed){
      const at=ctx.now().toISOString();
      // Journal intent records contain operational secrets. Their references stay behind an administrator-only artifact.
      const proof=await ctx.deps.records.artifacts.ingest({bytes:canonicalBytes({job:job.job,record:job.record??null,events:job.status.events}),mediaType:'application/json',origin:{generated:{generator:'runs.engine@1',inputs:[]}},author:{user:null},provenanceType:'projected',visibility:{readers:[],admins:true,packs:[],shareable:false}});
      observed=await putAction(ctx.deps.records.store,{action:'read',run:run.run,inputs:['src:'+proof.body.sha256],startedAt:at,endedAt:ctx.now().toISOString(),acceptance:null,codes:[],detail:{dispatch_request_snapshot:requestSnapshot,job:job.job,outcome:job.status.outcome,frozen:job.status.frozen,...(job.status.disposition?{disposition:job.status.disposition}:{}),...(job.status.decided_by?{decided_by:job.status.decided_by}:{}),...(job.status.decided_at?{decided_at:job.status.decided_at}:{})}});
    }
    if((job.status.frozen||job.status.outcome==='unknown'||job.status.outcome==='read_back_mismatch')&&!(job.status.decided_by&&job.status.decided_at&&(job.status.disposition==='mark_failed'||job.status.disposition==='abandon')))await putRequest(ctx,{run:run.run,job:job.job,kind:'disposition',audience:admin.id,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:observed.digest,code:'integrity_unproven',...(job.verification_run===run.run?{item:job.verification_item}:{}),missing:'作业 '+job.job+' 的原效果结局尚未证明；管理员记录保留核对所需事实',next_action:'管理员用 circle-hub job resume '+job.job+' 核对原请求和原作业；仍无结论时重证基线，以本运行为 predecessor 重跑，原效果和冻结/解除记录不改写，不重交原请求'});
  }
  if(await abandonDecision(ctx,run.run)){for(const request of await requestRecords(ctx,run.run)){const job=jobs.find(j=>j.job===request.job);if(request.answered_by===null&&job&&(!job.status.frozen&&job.status.outcome!=='unknown'&&job.status.outcome!=='read_back_mismatch'&&job.status.outcome!=='issued'||job.status.decided_by&&job.status.decided_at&&(job.status.disposition==='mark_failed'||job.status.disposition==='abandon'))){const witness=(await actionsOf(ctx.deps.records.store,run.run)).find(a=>a.body.detail.dispatch_request_snapshot===dispatchSnapshot([job]));if(witness)await answerRequest(ctx,request.record,witness.digest);}}return;}
  const signature=dispatchSnapshot(jobs);
  if(actions.some(a=>a.body.detail.dispatch_snapshot===signature))return;
  await ctx.lock(`submit:${run.run}`,async()=>{
    const latest=await latestAccepted(ctx.deps.records.store,run.run);
    if(!latest)return;
    const result=structuredClone(latest.body);
    result.trace=randomBytes(16).toString('hex');
    const at=ctx.now().toISOString();
    if(!await applyDispatchResults(ctx,run,result,jobs))return;
    await recordResultRequests(ctx,run,result);
    const saved=await putResult(ctx.deps.records.store,result,at);
    for(const request of await requestRecords(ctx,run.run)){const job=jobs.find(j=>j.job===request.job);if(request.answered_by===null&&job&&(!job.status.frozen&&job.status.outcome!=='unknown'&&job.status.outcome!=='read_back_mismatch'&&job.status.outcome!=='issued'||job.status.decided_by&&job.status.decided_at&&(job.status.disposition==='mark_failed'||job.status.disposition==='abandon')))await answerRequest(ctx,request.record,saved.digest);}
    await putAction(ctx.deps.records.store,{action:'validate',run:run.run,inputs:[`rec:${latest.digest}`],startedAt:at,endedAt:ctx.now().toISOString(),acceptance:null,codes:[],detail:{dispatch_snapshot:signature,result:saved.digest}});
  });
}

async function legacyResultRequests(ctx:EngineContext,stored:StoredRecord<RunRecord>):Promise<void>{
  const latest=await latestAccepted(ctx.deps.records.store,stored.body.run);
  const runner=stored.body.runner??stored.body.configurer;
  if(!latest||!runner)return;
  for(const [partition,items] of Object.entries(latest.body.partitions))for(const [i,item] of items.entries())for(const [j,requirement] of item.requirements.entries())for(const [k,layer] of requirement.layers.entries()){
    if(!isUnsettled(layer)||!layer.reason||layer.exit&&layer.missing)continue;
    const path='/partitions/'+partition+'/'+i+'/requirements/'+j+'/layers/'+k;
    await putRequest(ctx,{run:stored.body.run,kind:'repair',audience:runner,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:latest.digest,code:layer.reason,item:item.item,requirement:requirement.requirement,missing:'旧结果 rec:'+latest.digest+' '+path+'：'+(!layer.exit?'出口未写；':'')+(!layer.missing?'缺失事实未写':''),next_action:'原提交者带 Circle-Session-Id 用 submit_result 原样重交，Hub 追加重评结果；旧运行或作者缺会话时，以原工作为 predecessor 开带会话的新修订后重新复核。旧记录不回填'});
  }
}

/** Cache identity contains only the safe status fields used by the projection, never remote error text or lease material. */
function dispatchSnapshot(jobs:import('../../dispatch/api.ts').RunJob[]):string{
  return digestOf(jobs.map(j=>({job:j.job,verification_run:j.verification_run,plan_run:j.plan_run,verification_item:j.verification_item,items:j.items,sha256:j.sha256,outcome:j.status.outcome,frozen:j.status.frozen,events:j.status.events,result:j.status.result??null,disposition:j.status.disposition??null,decided_by:j.status.decided_by??null,decided_at:j.status.decided_at??null})));
}

/** Replay the same frozen work, with its recorded observer, after trusted transient parent exhaustion. */
async function recoverParent(ctx:EngineContext,stored:StoredRecord<RunRecord>):Promise<void>{
  const run=stored.body,store=ctx.deps.records.store,actions=await actionsOf(store,run.run);
  const observed=(action:(typeof actions)[number])=>action.body.component===ENGINE_COMPONENT&&action.body.action==='validate'&&action.body.detail.parent_observed_success===true&&!parentUnavailable(action.body.detail.retry_attempts);
  const recoveredAt=actions.findLastIndex(observed);
  const successors=(await import('./store.ts').then(m=>m.successorsOf(store,run.run))).filter(s=>(s.body.runner??s.body.configurer)===(run.runner??run.configurer)&&s.body.pack.split('@')[0]===run.pack.split('@')[0]);
  for(const question of await requestRecords(ctx,run.run)){
    if(question.answered_by!==null)continue;
    const source=actions.findIndex(a=>a.digest===question.source&&typeof a.body.detail.parent_recovery_exhausted==='string');
    let proof=recoveredAt>source&&source>=0?actions[recoveredAt]:null;
    if(source>=0&&!proof)for(const successor of successors){
      proof=(await actionsOf(store,successor.body.run)).findLast(a=>observed(a)&&Date.parse(a.created_at)>Date.parse(actions[source].created_at))??null;
      if(proof)break;
    }
    if(proof&&typeof proof.body.detail.result==='string')await answerRequest(ctx,question.record,proof.body.detail.result);
  }
  const latest=await latestAccepted(store,run.run);if(!latest||!needsParentRecovery(latest.body))return;
  const superseded=successors.length>0;
  const validator=[...actions].reverse().find(a=>a.body.component===ENGINE_COMPONENT&&a.body.action==='validate'&&a.body.detail.submission===latest.body.submission&&Array.isArray(a.body.detail.retry_attempts));
  if(!validator||!parentUnavailable(validator.body.detail.retry_attempts))return;
  const account=await ctx.deps.records.principals?.get(run.runner??run.configurer??'');if(!account||account.disabled||!canSeeRun(account,run))return;
  const source=latest.body.submission,attempts=Math.max(actions.slice(recoveredAt+1).filter(a=>a.body.detail.parent_recheck===source).length,actions.slice(recoveredAt+1).filter(a=>a.body.detail.parent_recheck_started===source).length);
  const by={id:account.id,name:account.name,role:account.role};
  if(attempts<3&&!superseded){
    const reservedAt=ctx.now().toISOString();
    await putAction(store,{action:'validate',run:run.run,inputs:['rec:'+latest.digest],startedAt:reservedAt,endedAt:reservedAt,acceptance:null,result:'unknown',codes:[],detail:{parent_recheck_started:source,retry_attempt:attempts+1,result:null}});
    if(validator.body.detail.production===true)await ctx.lock('submit:'+run.run,()=>recheckProduction(ctx,stored,by,randomBytes(16).toString('hex')));
    else{
      const original=await submissionByDigest(store,run.run,source);if(!original||!isObject(original.body)||isVerbatimObject(original))return;
      const session=typeof validator.body.detail.session==='string'?validator.body.detail.session:null;
      if(session===null&&run.requirements.some(r=>r.accepted_producer==='independent_judgment'))return;
      await submitResult(ctx,by,original.body,{traceId:randomBytes(16).toString('hex'),sessionId:session},true);
    }
    const result=await latestAccepted(store,run.run),at=ctx.now().toISOString();
    await putAction(store,{action:'validate',run:run.run,inputs:['rec:'+latest.digest],startedAt:at,endedAt:ctx.now().toISOString(),acceptance:null,codes:[],detail:{parent_recheck:source,attempt:attempts+1,result:result?.digest??null,repair:[]}});
    if(attempts+1<3||!result||!needsParentRecovery(result.body))return;
    const fresh=(await actionsOf(store,run.run)).findLast(a=>a.body.detail.submission===source&&Array.isArray(a.body.detail.retry_attempts));if(!fresh||!parentUnavailable(fresh.body.detail.retry_attempts))return;
  }
  await ctx.lock('submit:'+run.run,async()=>{
    const result=await latestAccepted(store,run.run);if(!result||!needsParentRecovery(result.body))return;
    const admin=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled);if(!admin)throw new Error('父级核验恢复缺少具名管理员');
    const input={run:run.run,source_result:result.digest,source_submission:source,automatic_rechecks:superseded?attempts:3,...(superseded?{successors:successors.map(s=>s.body.run)}:{}),observed_at:ctx.now().toISOString()};
    const action=await putAction(store,{action:'validate',run:run.run,inputs:['rec:'+result.digest],startedAt:ctx.now().toISOString(),endedAt:ctx.now().toISOString(),acceptance:null,codes:['check_error'],detail:{input,parent_recovery_exhausted:source}});
    const question=await putRequest(ctx,{run:run.run,kind:'repair',audience:admin.id,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:action.digest,code:'check_error',missing:superseded?'父级核验失败后已有同包后继，旧运行不能再自动重交，缺少可用的宿主沙箱执行观察':'父级核验能力在三次自动重评后仍未恢复，缺少可用的宿主沙箱执行观察',next_action:superseded?'管理员核对并修复宿主沙箱及进程资源，请原运行者在同包后继运行带原会话提交；新的可信父级执行成功观察才关闭本请求，旧技术结果不改写':'管理员核对宿主沙箱及进程资源并修复；恢复后请原运行者带原会话用 submit_result 原样重交，实际父级执行成功后关闭本请求；不修改旧结果、不声称包作者已发布修复版本'});
    const projected=structuredClone(result.body);projected.submission=digestOf(input);projected.system_input='rec:'+action.digest;projected.trace=randomBytes(16).toString('hex');
    const exit={action:'request' as const,request_kind:'repair' as const,audience:{user:admin.id},due:question.body.due};
    for(const item of Object.values(projected.partitions).flat())for(const requirement of item.requirements)for(const layer of requirement.layers){if(layer.exit?.action==='reevaluate')layer.exit=structuredClone(exit);for(const gap of layer.gaps??[])if(gap.exit.action==='reevaluate')gap.exit=structuredClone(exit);}
    for(const error of projected.errors)if(error.code==='check_error')error.fix=question.body.missing+'；请求 rec:'+question.digest+'：'+question.body.next_action;
    projected.errors.push({code:'check_error',message:question.body.missing,path:'',fix:'请求 rec:'+question.digest+'：'+question.body.next_action});
    await putResult(store,projected,ctx.now().toISOString());
  });
}

/** Keep original deadlines immutable; each expired unanswered request advances to a named administrator. */
async function escalateOverdueRequests(ctx:EngineContext):Promise<void>{
  const requests=await requestRecords(ctx),byId=new Map(requests.map(request=>[request.record,request]));
  const answerOf=(request:(typeof requests)[number],seen=new Set<string>()):string|null=>{
    if(request.answered_by)return request.answered_by;
    if(seen.has(request.record))return null;
    seen.add(request.record);
    const parent=byId.get(request.source);
    return parent?answerOf(parent,seen):null;
  };
  for(const request of requests){
    if(request.answered_by!==null)continue;
    const answer=answerOf(request);
    if(answer){await answerRequest(ctx,request.record,answer);continue;}
    if(Date.parse(request.due)>ctx.now().getTime())continue;
    const admin=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled);
    if(!admin)throw new Error('到期请求升级缺少具名管理员');
    await putRequest(ctx,{...(request.run?{run:request.run}:{}),...(request.pack_digest?{pack_digest:request.pack_digest}:{}),kind:'clarification',audience:admin.id,due:new Date(ctx.now().getTime()+86400000).toISOString(),source:request.record,code:'awaiting_step',missing:'请求 rec:'+request.record+' 到期仍未作答，缺少该请求所列事实或处置',next_action:'管理员核对原请求 rec:'+request.record+' 的缺失事实、原受众和下一步，按其真实作答入口推进；只有原请求的实际回答才能关闭升级请求，不修改原期限或原记录'});
  }
}
