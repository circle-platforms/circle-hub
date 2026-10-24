import {RETRY_RULES} from './retry-policy.ts';
import {prepareEffectGate,EffectBoundaryError} from './effect-gate.ts';
import {checkEffectBoundary,incompleteEffectBoundary,deny,type BoundaryFailure} from './boundary.ts';
import {verifiedContent} from './content.ts';
import { WHOLE_HUB, canonicalBytes, canonicalize, sha256Hex, type AuthorizationRecord, type ActionBody, type Principal, type RecordsKit, type Transaction } from '../records/api.ts';
import type { LeaseService, HolderSnapshot } from '../leases/api.ts';
import type { WorkflowStore } from '../ports.ts';
import { labelOf, type EffectOutcome, type Disposition, type EffectMark, type RequestKind, type ActionKind, type ActionResult, type LeaseOp, type EffectClass, type RetrySafety, type Signing, isDisposition, isEffectOutcome } from '../../contracts/generated/vocabulary.ts';
import { at, bind, mapped, readDeclaredTime, registrationMissing, type CallRole, type ExecutorDefinition } from './definition.ts';
import {Redactor} from '../connectors/api.ts';
import {resolveExecutor} from './source.ts';
import { ExecutorRegistry, ExecutorAccessError, ExecutorCredentialError, lockExecutorConfiguration, containsSecret } from './executors.ts';
import { Journal, digestOfValue, eventOf, receiptOf, openRequests, isDone, isFrozen, newJob, type JobBinding, type Event } from './journal.ts';
import { RpcClient, CapabilityPolicyError, InvocationDefinitionError, SubmissionNotSentError, object, type Exchange } from './transport.ts';
import type { BuildKnowledge } from './probes.ts';
import {requestIdentity,sameRequestIdentity} from './request-identity.ts';
import {PrecheckFactError,precheckFailure} from './precheck-failure.ts';
import { canRetryRead } from './read-policy.ts';
import { dynamicDisposition, DISPATCH_QUALIFICATIONS } from './dynamic.ts';
import { verifyInput, lockedBuildBase, InputVerificationError, type VerificationPort } from './proof.ts';
/** Only validated generated outcomes can prove a submission retry is safe. */
function retrySafeOutcome(value:unknown):boolean {
  if(!isEffectOutcome(value))return false;
  const outcome:EffectOutcome=value;
  return outcome==='target_rejected'||outcome==='proven_not_executed';
}
export interface DispatchOptions {
  recheckChecks?:import('../ports.ts').EffectCheckReplay;
  redactor?:Redactor;
  knowledge?: BuildKnowledge;
  records: RecordsKit; leases: Pick<LeaseService, 'holderSnapshot' | 'withMutationLock'>; runs: VerificationPort;
  workflows: Pick<WorkflowStore, 'byDigest'>; close?: () => Promise<void>; now?: () => Date; sleep?: (ms: number) => Promise<void>;
}
export interface JobStatus { failed_checks?:Array<{step:string;seat?:string;check?:string;missing_fact:string;next_action:string}>; failed_conditions?:Array<{pointer:string;operator:string}>; requests?:Array<{id:string;question_sha256:string|null;deadline:string|null}>; marks?:EffectMark[];disposition?:Disposition;decided_by?:string;decided_at?:string; reason?: string; job: string; phase: string; outcome: EffectOutcome; frozen: boolean; result?: string; events: number; next_action?: string; missing_fact?: string; }
interface Heartbeat {stop:()=>Promise<void>;held:()=>boolean;lastConfirmedAt:()=>number|null;}
interface LeaseClock {at:number;mono:number;ttl:number;}
interface RemoteLease { id: unknown; token: unknown; ttl: number; }
const operationDefinition = (d:ExecutorDefinition) => ({target:d.target,endpoint:d.endpoint,ca:d.ca,resources:[...d.resources].sort(),manifest_sha256:d.manifest_sha256,actor_header:d.actor?.header.toLowerCase() ?? null,slot:d.proof.slot,payload_argument:d.payload_argument,submit:{tool:d.calls.submit.tool,arguments:d.calls.submit.arguments}});
// Every future field stays fixed unless explicitly admitted as a read-only repair here.
const fixedForReading = (d:ExecutorDefinition) => {
 const {status,result,reconciliation,premises,read_retry_when,allowed_tools,refused_tools,limitations,side_effects,clock_skew_ms,receipt,max_bytes,poll_ms,...fixed}=d;
 const {status:statusCall,result:resultCall,query,...calls}=fixed.calls;
 return {...fixed,calls};
};
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && canonicalize(a) === canonicalize(b);
function precheckIssues(events:readonly Event[]):NonNullable<JobStatus['failed_checks']> {
  return events.filter(e=>e.body.detail.phase==='device_probe' || e.body.detail.phase==='precheck.failure' || e.body.detail.phase==='precheck.evaluated' || /^precheck\.[0-9]+$/.test(String(e.body.detail.phase))).flatMap(e=>{
    const d=e.body.detail;if(typeof d.missing_fact!=='string')return [];
    return [{step:typeof d.step==='string'?d.step:String(d.phase),...(typeof d.seat==='string'?{seat:d.seat}:{}),...(typeof d.check==='string'?{check:d.check}:{}),missing_fact:d.missing_fact,next_action:typeof d.next_action==='string'?d.next_action:'管理员核对附加只读来源及期望条件声明，补齐来源与期望事实后再采证'}];
  });
}
export class DispatchService {
  readonly options: DispatchOptions;
  readonly registry: ExecutorRegistry;
  readonly journal: Journal;
  readonly now: () => Date;
  readonly redactor:Redactor;
  readonly sleep: (ms: number) => Promise<void>;
  #leaseClocks = new WeakMap<RemoteLease,LeaseClock>();
  #closing: Promise<void> | null = null;
  constructor(options: DispatchOptions) {
    this.redactor=options.redactor??new Redactor();
    this.options = options; this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.registry = new ExecutorRegistry(options.records); this.journal = new Journal(options.records, this.now);
  }
  async close(): Promise<void> { await (this.#closing ??= this.options.close?.() ?? Promise.resolve()); }
  async status(by: Principal, job: string): Promise<JobStatus> {
    await this.registry.admin(by); const events = await this.journal.events(job);
    if (!events.length) throw new Error('作业对你不可用');
    const probeIntent=eventOf(events,'probe_intent');
    const missingReceipt = !events.some(e => e.body.detail.done === true && (probeIntent && e.body.detail.effect_accounted===true || retrySafeOutcome(e.body.detail.outcome) || e.body.detail.outcome==='not_dispatched' && e.body.detail.submit_invoked===false)) && !!(eventOf(events, 'intent') ?? probeIntent) && !receiptOf(events) && !events.some(e => e.body.detail.unfreeze === true);
    const unknown = isFrozen(events); const result = eventOf(events, 'result'); const end = eventOf(events, 'complete')??eventOf(events,'boundary_refused');
    const intent = eventOf(events, 'intent'); const receipt = receiptOf(events);
    const uncertainty = [...events].reverse().find(e => e.body.detail.uncertain === true && typeof e.body.detail.missing_fact === 'string');
    const decision=eventOf(events,'dispose');const choice=decision?.body.detail.disposition;
    const riskDisposed=choice==='mark_failed' && decision?.body.detail.risk_confirmed===true;
    const marks:EffectMark[]=decision?.body.detail.effect_mark==='disposed' && (riskDisposed || choice==='reconcile' && decision.body.detail.identity_matched===true)?['disposed']:[];
    const missingFact = riskDisposed ? '原效果是否完成仍未证明；管理员已具名接受风险并完成处置，不把它当作未执行' : unknown || missingReceipt ? String(uncertainty?.body.detail.missing_fact ?? '已写意图但缺少可信提交回执；不能证明未执行') : end?.body.detail.registration_ready === false ? `登记缺事实：${(end.body.detail.registration_missing as string[] ?? []).join('、')}` : typeof end?.body.detail.missing_fact==='string'?end.body.detail.missing_fact:undefined;
    const failedConditions=events.flatMap(e=>Array.isArray(e.body.detail.conditions)?e.body.detail.conditions.filter(object).filter(c=>c.matched===false && typeof c.pointer==='string' && typeof c.operator==='string').map(c=>({pointer:String(c.pointer),operator:String(c.operator)})):[]);
    const lastCredential=[...events].reverse().find(e=>e.body.detail.phase==='session_unavailable'||e.body.detail.phase==='credential_used');
    const gap=!riskDisposed&&lastCredential?.body.detail.phase==='session_unavailable'?lastCredential.body.detail:undefined;
    const failedChecks=precheckIssues(events);
    return { job,...(failedChecks.length?{failed_checks:failedChecks}:{}),...(failedConditions.length?{failed_conditions:failedConditions}:{}),requests:openRequests(events).map(e=>({id:e.digest,question_sha256:typeof e.body.detail.question_sha256==='string'?e.body.detail.question_sha256:null,deadline:typeof e.body.detail.deadline==='string'?e.body.detail.deadline:null})),marks,...(isDisposition(choice)?{disposition:choice}:{}),...(typeof decision?.body.detail.decided_by==='string'?{decided_by:decision.body.detail.decided_by}:{}),...(typeof decision?.body.detail.decided_at==='string'?{decided_at:decision.body.detail.decided_at}:{}), ...(typeof end?.body.detail.public_reason === 'string' ? {reason:end.body.detail.public_reason} : {}), phase: String(events.at(-1)!.body.detail.phase),
      outcome: riskDisposed ? 'unknown' : end?.body.detail.outcome==='not_dispatched' && end.body.detail.submit_invoked===false ? 'not_dispatched' : end && retrySafeOutcome(end.body.detail.outcome) ? end.body.detail.outcome as EffectOutcome : unknown || missingReceipt || (intent && !receipt) ? 'unknown' : end?.body.detail.outcome === 'not_dispatched' ? 'not_dispatched' : end ? 'effective' : intent ? 'issued' : 'not_dispatched',
      frozen: unknown || missingReceipt, ...(typeof result?.body.detail.reference === 'string' ? { result: result.body.detail.reference } : {}), events: events.length, ...(gap||missingFact ? { missing_fact:[missingFact,gap?.missing_fact].filter(Boolean).join('；') } : {}),
      ...(gap?{next_action:String(gap.next_action)}:riskDisposed ? {next_action:'处置已完成，原效果保留未知；后续作业须重新核验与授权，不得将原请求当作未执行重交'} : unknown || missingReceipt ? { next_action: typeof uncertainty?.body.detail.next_action==='string'?uncertainty.body.detail.next_action:`circle-hub job resume ${job}；只读原请求，不重交` } : typeof end?.body.detail.next_action === 'string' ? { next_action: end.body.detail.next_action } : !isDone(events) ? { next_action: `circle-hub job resume ${job}` } : {}) };
  }
  async list(by:Principal,executor:string):Promise<JobStatus[]> {
    await this.registry.admin(by);const current=await this.registry.get(executor);
    if(!current)throw new Error('执行器对你不可用；先用 executor list 核对编号');
    const jobs=await this.journal.blockers(executor,current.definition.target,new URL(current.definition.endpoint).origin,current.definition.resources);
    return Promise.all(jobs.map(job=>this.status(by,job)));
  }
  /** Trusted lease boundary: unresolved effects block local release even after a terminal observation. */
  async activeLeaseJobs(keys: readonly string[]): Promise<Array<{key:string;job:string}>> {
    if (!keys.length) return [];
    const keysSet=new Set(keys);const events=await this.journal.targets(keys);
    const jobs=[...new Set(events.map(e=>String(e.body.detail.job)))].sort();
    const rows:Array<{key:string;job:string}>=[];
    for(const job of jobs){
      const history=await this.journal.events(job);
      const reservation=history.find(e=>e.body.detail.phase==='reservation');
      const binding=reservation?.body.detail.binding as JobBinding|undefined;
      if(!binding)throw new Error('作业缺少资源登记，请管理员恢复作业登记后核验');
      if(reservation?.body.detail.read_only===true || isDone(history) && !isFrozen(history))continue;
      for(const key of binding.resources)if(keysSet.has(key))rows.push({key,job});
    }
    return rows.sort((a,b)=>a.key.localeCompare(b.key)||a.job.localeCompare(b.job));
  }
  async precheck(by: Principal, executor: string, booking?: string): Promise<JobStatus> {
    await this.registry.admin(by);
    const registered = await this.registry.get(executor);
    if (!registered?.definition.enabled) throw new Error('执行器不可用或已禁用');
    const d = registered.definition;
    await this.assertNoSecrets(d);
    await this.options.records.objects.put(canonicalBytes(d),'application/json');
    const booked = booking ? await this.options.runs.getRun(by, booking) : null;
    if (booking && !booked) throw new Error('预订运行对你不可用');
    const binding: JobBinding = { job: newJob(), initiated_by: by.id, executor, executor_digest: registered.resolved_digest, executor_source_digest:registered.digest,variables:registered.variables, scope:{target:d.target,origin:new URL(d.endpoint).origin}, target_key: digestOfValue([...d.resources].sort()), input: null,
      user: booked?.run.runner ?? by.id, resources: [], context: { ...d.precheck_context, ...(booked?.run.build ? { build: booked.run.build } : {}), ...(booked && lockedBuildBase(booked.run) ? {build_base:lockedBuildBase(booked.run)} : {}), ...(booked?.run.product ? {product:booked.run.product} : {}), ...(booked?.run.root ? {root:booked.run.root} : {}), target: d.target, ...(d.resources.length ? { seats: d.resources.length } : {}), ...(d.manifest_sha256 ? { manifest_sha256: d.manifest_sha256 } : {}) } };
    await this.assertNoSecrets(binding);
    await this.journal.append(binding, 'reservation', 'validate', 'completed', { binding, read_only: true });
    const material=await this.secret(binding,d);if(material===null)return this.credentialUnavailable(by,binding,true);
    const client = this.session(binding, d, material);
    let lease: RemoteLease | undefined; let stop = async () => {}; let verified = false; let publicReason: string | undefined;let stage='connect';
    try {
      await client.connect();stage='acquire'; lease = await this.acquire(binding, d, client, this.context(binding));
      stop = this.heartbeat(binding, d, client, lease).stop;
      const context = { ...this.context(binding), lease_id: lease.id, lease_token: lease.token };
      stage='precheck';
      try { const response = await this.retryRead(binding, client, 'precheck', context, Infinity); verified = await this.assessConditions(binding,d.conditions,response,context,'precheck.evaluated'); } catch(error) { verified = false;const failure=precheckFailure(error,stage);publicReason=failure.missing_fact;await this.journal.append(binding,'precheck.failure','validate','completed',{step:stage,...failure}); }
      const extra = await this.extraPrechecks(binding, d, client, context, true);
      stage='probe';const probed = await this.probeSeats(binding,d,client,context);
      verified = verified && extra && probed;
    } catch (error) { verified = false;const failure=precheckFailure(error instanceof CapabilityPolicyError?new PrecheckFactError(error.message,'管理员更换仅允许运行的密钥，并复核该身份可见的工具目录后再采证'):error,stage);publicReason=failure.missing_fact;await this.journal.append(binding,'precheck.failure','validate','completed',{step:stage,...failure}); }
    finally { await stop(); if (lease) await this.release(binding, client, lease); }
    const issues=precheckIssues(await this.journal.events(binding.job));
    await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', ...(issues.length?{missing_fact:issues.map(i=>i.missing_fact).join('；')}:{}), ...(publicReason?{public_reason:publicReason}:{}), readonly_verified: verified, registration_ready: registrationMissing(d).length === 0, registration_missing: registrationMissing(d),
      ...(registrationMissing(d).length ? { next_action: '请将预检原件交转换脚本生成清单，经管理员发布后 update 补齐清单摘要和全部资源键；当前不能派发' } : verified ? {} : { next_action: issues.length?[...new Set(issues.map(i=>i.next_action))].join('；'):'管理员核对执行器声明和受限只读原件，补齐匹配事实后再采证；未提交' }) });
    return this.status(by, binding.job);
  }

  async conformance(by: Principal, executor: string): Promise<JobStatus> {
    await this.registry.admin(by); const registered = await this.registry.get(executor);
    if (!registered?.definition.enabled) throw new Error('执行器不可用或已禁用');
    const d = registered.definition;
    await this.assertNoSecrets(d);
    await this.options.records.objects.put(canonicalBytes(d),'application/json');
    if (!d.conformance || !d.reconciliation || !d.calls.query || !d.receipt.stage || !d.receipt.reached_device) throw new Error('缺少只读查账、拒绝阶段或一致性探测字节声明；请补齐定义');
    const binding: JobBinding = {job:newJob(),initiated_by:by.id,executor,executor_digest:registered.resolved_digest,executor_source_digest:registered.digest,variables:registered.variables,scope:{target:d.target,origin:new URL(d.endpoint).origin},target_key:digestOfValue([...d.resources].sort()),input:null,user:by.id,resources:d.resources,context:d.precheck_context};
    await this.options.leases.withMutationLock(tx=>this.reserve(binding,tx));
    const material=await this.secret(binding,d);if(material===null)return this.credentialUnavailable(by,binding,true);
    const client = this.session(binding,d,material);
    let lease: RemoteLease | undefined; const observations: Exchange[] = []; const checks: boolean[] = [];let failure:Record<string,string>|undefined;const ambiguous=false;
    try {
      await client.connect(); lease = await this.acquire(binding,d,client,this.context(binding));
      const context = {...this.context(binding),lease_id:lease.id,lease_token:lease.token,request_id:`${binding.job}:absent`,not_after:new Date(this.now().getTime()-d.conformance.expiry_margin_ms-1000).toISOString(),items:[]};
      const missing = await this.read(binding,client,'query',context); observations.push(missing);
      const r = d.reconciliation;
      const wireTime = (v:unknown) => readDeclaredTime(v,r.time_scale_ms);
      const expectedIdentity=requestIdentity(missing.value,r.identity,r.time_scale_ms);
      checks.push(wireTime(at(missing.value,r.gateway_time))>Date.parse(context.not_after)+d.conformance.expiry_margin_ms && !!expectedIdentity && at(missing.value,r.found) === false && Number.isFinite(wireTime(at(missing.value,r.gateway_time))) && Number.isFinite(wireTime(at(missing.value,r.gc_before))) && wireTime(at(missing.value,r.gc_before))>=expectedIdentity.since);
      if(!checks[0]) {const gaps=[...(at(missing.value,r.found)!==false?['探测编号没有取得查空回答']:[]),...(!expectedIdentity?['缺少日志身份、记账起点或完整主体']:[]),...(!(wireTime(at(missing.value,r.gateway_time))>Date.parse(context.not_after)+d.conformance.expiry_margin_ms)?['目标时刻未越过探测截止及声明余量，不能保证按过期拒收']:[]),...(!Number.isFinite(wireTime(at(missing.value,r.gc_before))) || expectedIdentity && wireTime(at(missing.value,r.gc_before))<expectedIdentity.since?['缺少覆盖记账起点的有效保留边界']:[])];failure={missing_fact:gaps.join('；'),next_action:'管理员先核对目标与 Hub 时钟、时区和日志身份声明，取得越过截止及余量的目标时刻后再运行 conformance；本次未提交'};throw new Error('探测过期前提不成立');}
      failure={missing_fact:'只有只读查空原件，缺少已核验的过期拒收和同键去重事实；管理员提供的探测字节未经核验，不得外发，须补受限审计证据',next_action:'管理员从目标自己的受限审计记录只读取证，将完整协议事实、目标版本和证据引用登记到执行器前提；conformance 不提交探测字节'};
    } catch { checks.push(false);failure??={missing_fact:'探测所需的连接、租约或请求记录未完整取得；未确认四项协议事实',next_action:'管理员检查受限调用原件、目标连接和租约配置，恢复缺失的读取事实后再采证'}; }
    finally { if (lease) await this.release(binding,client,lease); }
    const init = eventOf(await this.journal.events(binding.job),'initialize.response');
    const artifact = await this.options.records.artifacts.ingest({bytes:canonicalBytes({target:d.target,version:client.serverVersion,checks,sources:observations.map(o=>o.source)}),mediaType:'application/json',origin:{generated:{generator:'dispatch@1',inputs:[...observations.map(o=>o.source),...(init?.body.inputs.filter(r=>r.startsWith('src:')) ?? [])]}},author:{user:null},provenanceType:'projected',visibility:{readers:[by.id],admins:true,packs:[],shareable:false}});
    await this.journal.append(binding,'result','read_back','completed',{reference:`src:${artifact.body.sha256}`,observations:observations.length},observations.map(o=>o.source));
    await this.journal.append(binding,'complete','read_back','completed',{done:!ambiguous,effect_accounted:!ambiguous,outcome:ambiguous?'unknown':'not_dispatched',conformance_verified:false,readonly_observed:checks.length===1&&checks[0],...(failure??{}),next_action:ambiguous?'探测效果未决；只读核对原请求后由管理员处置，不得重跑 conformance':failure?.next_action ?? (checks.length === 4 && checks.every(Boolean) ? '管理员复核这些源记录后，将目标版本和证据引用登记到执行器前提；不会自动认证' : '一致性探测未取得四项相符事实；管理员核对定义和原始回答后重跑 conformance')});
    return this.status(by,binding.job);
  }

  private async probeFollowup(by:Principal,binding:JobBinding,d:ExecutorDefinition,client:RpcClient,allowResolution=false):Promise<void> {
    const intent=eventOf(await this.journal.events(binding.job),'probe_intent')!;
    const lease=intent.body.detail.remote_lease as unknown as RemoteLease;
    const r=d.reconciliation;let sources:string[]=[];
    let fact='探测提交可能已被受理或请求字节已发出，但缺少原请求的开始及收尾事实';
    try {
      if(!r || !d.calls.query)throw new Error('缺少请求查询声明');
      const response=await this.retryRead(binding,client,'query',{...this.context(binding),request_id:intent.body.detail.request_id,lease_id:lease.id,lease_token:lease.token},Infinity);sources=[response.source];
      const found=at(response.value,r.found),identity=at(response.value,r.request_id)===intent.body.detail.request_id && at(response.value,r.sha256)===intent.body.detail.sha256 && sameRequestIdentity(intent.body.detail.request_identity,requestIdentity(response.value,r.identity,r.time_scale_ms));
      const remote=at(response.value,r.id);
      await this.journal.append(binding,'probe_read_back','read_back','completed',{request_id:intent.body.detail.request_id,found:found===true,identity_matched:identity,...(this.opaque(remote)?{remote_id:remote}:{})},sources);
      const clock=readDeclaredTime(at(response.value,r.gateway_time),r.time_scale_ms),floor=readDeclaredTime(at(response.value,r.gc_before),r.time_scale_ms),deadline=Date.parse(String(intent.body.detail.not_after));
      const snapshot=requestIdentity(response.value,r.identity,r.time_scale_ms);
      const bound=intent.body.detail.request_protocol_verified===true && sameRequestIdentity(intent.body.detail.request_identity,snapshot);
      const negative=found===true && identity && at(response.value,r.reached_device)===false && (mapped(r.map,at(response.value,r.state))==='proven_not_executed' || mapped(r.map,at(response.value,r.state))==='target_rejected' && mapped(d.receipt.stages,at(response.value,r.stage))==='target_rejected');
      const absent=found===false && !!snapshot && clock>deadline && deadline>floor && floor>=snapshot.since;
      if(allowResolution && bound && (negative || absent) && await this.certified(binding,d,client,'request_journal') && await this.certified(binding,d,client,'request_journal',{version:intent.body.detail.request_protocol_version})) {
        await this.answerRequests(binding,'complete','read_back','completed',{done:true,outcome:'proven_not_executed',unfreeze:true,effect_accounted:true,next_action:'原探测请求的未执行事实已按认证协议回读；管理员核对探测前提后才可重新采证'},sources);return;
      }
      fact=found===true && identity && at(response.value,r.reached_device)===true?'原探测请求已有开始标记；缺少本次探测收尾及设备现场恢复事实':'探测提交的原请求尚缺相符的开始、拒收或未执行事实，不能证明没有设备效果';
    } catch {fact='探测提交可能已有设备效果；原请求只读对账未取得可用应答，缺开始及收尾事实';}
    await this.unknown(binding,fact,sources,{request_id:intent.body.detail.request_id,next_action:`请管理员 ${by.id} 核对该请求的审计、收尾和设备现场；读取通道需修复时先修复后运行 circle-hub job resume ${binding.job}，再用 circle-hub job dispose ${binding.job} 具名处置；不得重跑 conformance 或重交`});
  }

  async dispatch(by: Principal, run: string, executor: string, onReserved?: (job: string) => void): Promise<JobStatus> {
    await this.registry.admin(by);
    const registered = await this.registry.get(executor);
    if (!registered?.definition.enabled) throw new Error('执行器不可用或已禁用');
    const d = registered.definition;
    await this.assertNoSecrets(d);
    await this.options.records.objects.put(canonicalBytes(d),'application/json');
    if (registrationMissing(d).filter(name=>name!=='environment').length) throw new Error(`派发登记缺事实：${registrationMissing(d).filter(name=>name!=='environment').join('、')}；请先 precheck 采证、转换并发布清单，再 update 补齐`);
    const gate=await prepareEffectGate({records:this.options.records,runs:this.options.runs,workflows:this.options.workflows,recheck:this.options.recheckChecks,by,run,executor,definition:d,resolved_digest:registered.resolved_digest,now:this.now});
    const provisional:JobBinding={run,job:newJob(),initiated_by:by.id,executor,executor_digest:registered.resolved_digest,executor_source_digest:registered.digest,variables:registered.variables,input:null,user:gate.detail.run.runner??by.id,resources:d.resources,scope:{target:d.target,origin:new URL(d.endpoint).origin},target_key:digestOfValue([...d.resources].sort())};
    const preflight=await gate.preflight();if(!preflight.ok)return this.boundaryRefused(by,provisional,preflight);
    const input=preflight.input;
    const previous = await this.options.records.store.getByKey('action', `dispatch.bytes:${input.sha256}`);
    const attempts = (await this.options.records.store.findMany<import('../records/api.ts').ActionBody>({ kind: 'action', key: 'dispatch.bytes', values: [input.sha256] })).filter(e => e.body.detail.phase === 'intent');
    if (previous) throw new Error('这份字节已有旧版派发意图；只能查询或对账，不能重交');
    for (const prior of attempts) {
      const priorJob = String(prior.body.detail.job); const priorEvents = await this.journal.events(priorJob);
      const end = eventOf(priorEvents,'complete'); const pinned = await this.journal.binding(priorJob);
      if (!end || isFrozen(priorEvents) || !(retrySafeOutcome(end.body.detail.outcome) || end.body.detail.outcome==='not_dispatched' && end.body.detail.submit_invoked===false) || pinned.input?.run !== input.run || digestOfValue(operationDefinition(await this.pinned(pinned))) !== digestOfValue(operationDefinition(d)) || !same({...pinned.input,result:null},{...input,result:null})) throw new Error(`这份字节已有派发意图；作业摘要 ${priorJob}；只能查询或对账，不能重交`);
    }
    const attempt = attempts.length + 1;
    const source = await this.options.records.artifacts.source({ id: input.user, name: '', role: 'user' }, input.sha256, { consumer: 'function' });
    let initial:HolderSnapshot[];try{initial=await this.holders(input.ancestors,input.user,d.resources,d.submit_timeout_ms+d.max_run_ms);}catch{return this.boundaryRefused(by,{...provisional,input},deny(5,'LEASE_UNAVAILABLE','缺少覆盖派发窗口的同血缘资源租约；请取得租约并重证基线'));}
    const binding: JobBinding = { ...provisional, input, user: input.user, resources: d.resources, fences: initial, scope:{target:d.target,origin:new URL(d.endpoint).origin}, target_key: digestOfValue([...d.resources].sort()) };
    if(d.calls.submit.write)binding.target_key=digestOfValue(bind(d.calls.submit.write.target_key,this.context(binding)));
    delete binding.run; // Restricted response captures deliberately clear input; never leave a second run binding behind.
    await this.options.leases.withMutationLock(tx=>this.reserve(binding,tx));
    try { onReserved?.(binding.job); } catch { /* A terminal sink never controls an effect already authorized by the command. */ }
    const secret=await this.secret(binding,d);if(secret===null)return this.credentialUnavailable(by,binding,true);
    const session = this.session(binding, d, secret);
    let remote: RemoteLease | undefined; let stop = async () => {}; let pulse:Heartbeat|undefined;
    let intended = false;let submitInvoked=false;
    try {
      await session.connect();
      remote = await this.acquire(binding, d, session, this.context(binding));
      pulse = this.heartbeat(binding,d,session,remote);stop=pulse.stop;
      const context: Record<string, unknown> = { ...this.context(binding), lease_id: remote.id, lease_token: remote.token, payload_base64: Buffer.from(source?.bytes??[]).toString('base64') };
      const precheck = await this.retryRead(binding, session, 'precheck', context, Infinity);
      if (!await this.assessConditions(binding,d.conditions,precheck,context,'precheck.evaluated')) throw new Error('只读核对未满足；未提交，请核对当前环境后重新核验');
      if (!await this.extraPrechecks(binding, d, session, context, false)) throw new Error('附加只读核对未满足；未提交，请重新核对缓存来源');
      const deviceIdentity = await this.probeSeats(binding,d,session,context);
      if (!deviceIdentity) throw new Error('逐座位只读探测不符；见受限探测原件中的座位及 version/interfaces 核对');
      const latest = await this.registry.get(executor);
      if (!latest?.definition.enabled || latest.digest !== registered.digest || latest.resolved_digest !== registered.resolved_digest) throw new PrecheckFactError('执行器配置已变；未提交，请按当前配置重新核验','用当前配置重新核验后再派发；没有提交');
      await this.registry.admin(by);
      const ownerNow = await this.options.records.principals.get(input.user);
      if (!ownerNow || ownerNow.disabled) throw new Error('发起用户已经不可用；未提交');
      let fresh:HolderSnapshot[];try{fresh=await this.holders(input.ancestors,input.user,d.resources,d.submit_timeout_ms+d.max_run_ms);}catch{throw new EffectBoundaryError(deny(5,'LEASE_EXPIRED','资源租约已到期或不再覆盖窗口；请恢复租约并重证基线'));}
      if (!this.sameFences(initial, fresh)) throw new EffectBoundaryError(deny(5,'FENCING_STALE','派发前围栏已变；请重新证明基线'));
      const currentProof = await verifyInput(by,run,d,this.options.records,this.options.runs,this.options.workflows,this.now());
      if(!same({...input,result:null},{...currentProof,result:null}))throw new InputVerificationError('只读核对期间核验数据已改变；请按当前核验结果重新派发，尚未提交');
      const notAfter = new Date(this.now().getTime() + d.submit_timeout_ms).toISOString();
      const sequence = attempts.length ? Number(attempts[0].body.detail.sequence) : (await this.options.records.store.findMany({ kind: 'action', key: 'dispatch.lineage', values: [input.lineage] })).filter(e => (e.body as Record<string, unknown>)?.detail && ((e.body as { detail: Record<string, unknown> }).detail.phase === 'intent')).length + 1;
      const key = attempts.length ? String(attempts[0].body.detail.intent_key) : digestOfValue([input.lineage, input.item, d.proof.slot, sequence]);
      context.request_id = `${key}:${attempt}`; context.not_after = notAfter;
      let requestSnapshot:Record<string,unknown>={};let requestSources:string[]=[];
      if(d.reconciliation) {
        const r=d.reconciliation;
        if(!r.identity || !d.receipt.identity)throw new PrecheckFactError('缺少查询或投递回答的日志身份字段声明','管理员核对目标协议，补齐查询与投递回答的身份、起点及主体字段声明后重新派发；尚未提交');
        if(!session.serverVersion || !r.protocol_versions.includes(session.serverVersion))throw new PrecheckFactError('投递会话版本未登记请求协议支持','管理员核对发送会话版本及协议证据，登记该版本支持或更换受支持版本后重新派发；尚未提交');
        const response=await this.retryRead(binding,session,'query',context,Infinity);
        const identity=requestIdentity(response.value,r.identity,r.time_scale_ms);
        const clock=readDeclaredTime(at(response.value,r.gateway_time),r.time_scale_ms),floor=readDeclaredTime(at(response.value,r.gc_before),r.time_scale_ms);
        if(at(response.value,r.found)!==false || !identity || !Number.isFinite(clock) || !Number.isFinite(floor) || clock<floor || floor<identity.since) {
          const gaps=[...(at(response.value,r.found)!==false?['本请求号的查空记录']:[]),...(!identity?['可靠日志身份、完整主体及记账起点']:[]),...(!Number.isFinite(clock) || !Number.isFinite(floor)?['符合声明格式的目标时刻与回收边界']:[]),...(clock<floor || identity && floor<identity.since?['覆盖记账起点且不晚于目标时刻的回收边界']:[])];
          throw new PrecheckFactError(`投递前缺少本租约下的${gaps.join('、')}`,'管理员读取本租约的查询原件，核对日志身份、主体、目标时钟与边界声明，恢复可靠记账事实后重新派发；尚未提交');
        }
        const initialization=eventOf(await this.journal.events(binding.job),'initialize.response');
        requestSnapshot={request_identity:identity,request_protocol_version:session.serverVersion,request_protocol_verified:true};requestSources=[...new Set([response.source,...(initialization?.body.inputs??[])])];
        await this.journal.append(binding,'request_identity','validate','completed',requestSnapshot,requestSources);
      }
      let beforeState:{bound:boolean;sha256:string|null;reference:string|null}={bound:false,sha256:null,reference:null};
      const readBeforeState=async()=>{
        const declaration=d.calls.submit.write?.before_state;if(!declaration)return;
        const response=await session.declaredRead(declaration.call,context,'before_state');
        const expected=bind(declaration.expected,context),actual=at(response.value,declaration.pointer);
        const matched=same(expected,actual);
        const conditionalCertified=declaration.conditional_write&&await this.certified(binding,d,session,'conditional_write');
        await this.journal.append(binding,'before_state','read','completed',{matched,remote_lease:remote,expected_sha256:digestOfValue(expected),observed_sha256:actual===undefined?null:digestOfValue(actual),bound:matched&&conditionalCertified,conditional_write_declared:declaration.conditional_write,conditional_write_certified:conditionalCertified,...(declaration.conditional_write&&!conditionalCertified?{missing_fact:'目标这个版本的条件写尚未认证；只读比较不证明原子绑定',next_action:'管理员从目标受限审计和协议证据认证此版本的条件写前提；当前记录未绑定前状态'}:{})},[response.source]);
        if(!matched)throw new EffectBoundaryError(deny(5,'FENCING_STALE','前状态与绑定值不符；请只读核对目标状态并重证基线'));
        beforeState={bound:conditionalCertified,sha256:digestOfValue(actual),reference:response.source};
        if(declaration.conditional_write)context.before_state=actual;
      };
      await readBeforeState();
      const finalBoundary={...gate.context,
        lease:async()=>{if(!pulse?.held())return {ok:false,code:'LEASE_EXPIRED',message:'目标租约心跳或确认时效中断；请恢复租约并重证基线'};const current=await this.options.leases.holderSnapshot(d.resources);return this.sameFences(initial,current)?{ok:true}:{ok:false,code:'FENCING_STALE',message:'Hub 围栏改变；请重证基线后开新修订'};},
        content:async proof=>!!source?.bytes&&proof.sha256===input.sha256&&verifiedContent(source.bytes,input.sha256,source.mediaType),audience:async()=>!d.calls.submit.write?.audience} satisfies import('./boundary.ts').BoundaryContext;
      const boundary=await checkEffectBoundary(finalBoundary);
      if(!boundary.ok||boundary.checked!==9){const failure=boundary.ok?incompleteEffectBoundary(boundary):boundary;await stop();await this.release(binding,session,remote);return this.boundaryRefused(by,binding,failure);}
      const intentSemantics:{effect_class:EffectClass;retry_safety:RetrySafety;signing:Signing}={effect_class:d.calls.submit.write?.effect_class??'job',retry_safety:d.calls.submit.write?.retry_safety??'unsafe',signing:d.calls.submit.write?.signing??'service_on_behalf'};
      const precheckSources=[...new Set((await this.journal.events(binding.job)).filter(e=>e.body.detail.phase==='precheck.evaluated' || /^precheck\.[0-9]+$/.test(String(e.body.detail.phase)) || e.body.detail.phase==='device_probe').flatMap(e=>e.body.inputs))];
      const actionDigest = digestOfValue({ content: input.sha256, tool: d.calls.submit.tool, arguments: session.prepareSubmit(context) });
      if(!pulse.held())throw new Error('目标租约中断或近期确认已过期；恢复租约后重新预检，尚未提交');
      await this.options.records.store.withTransaction(async tx => {
        await lockExecutorConfiguration(this.options.records.store,tx,binding.executor,binding.resources,[d.target],[new URL(d.endpoint).origin]);
        await this.options.records.variables.lockNames((binding.variables??[]).map(use=>use.name),tx);
        const config=await this.options.records.store.find<AuthorizationRecord['body']>({key:'authz.key',value:`resource_config|${WHOLE_HUB}|executor.${binding.executor}`,kind:'authorization',newestFirst:true,limit:1},tx);
        if(config.items[0]?.body.revoked||config.items[0]?.body.bound!==registered.digest)throw new PrecheckFactError('执行器配置已变；未提交，请按当前配置重新核验','用当前配置重新核验后再派发；没有提交');
        for(const use of new Map((binding.variables??[]).map(use=>[use.name,use])).values()){
          const row=await this.options.records.store.find<AuthorizationRecord['body']>({key:'authz.key',value:`resource_config|${WHOLE_HUB}|var:${use.name}`,kind:'authorization',newestFirst:true,limit:1},tx);
          if(row.items[0]?.body.revoked||row.items[0]?.digest!==use.decision)throw new PrecheckFactError('执行器配置已变；未提交，请按当前配置重新核验','用当前配置重新核验后再派发；没有提交');
        }
        await gate.reserveBudget(boundary.row,tx);
        const permitted = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: true }, [], `dispatch.gate:${binding.job}`, tx);
        if (!permitted.created) throw new Error('作业已经恢复或关闭，不能再提交');
        const ordinal = attempt === 1 ? await this.journal.append(binding, 'sequence', 'validate', 'completed', { sequence }, [], `dispatch.sequence:${input.lineage}:${sequence}`, tx) : { created: true };
        if (!ordinal.created) throw new Error('血缘次序已由另一派发占用；未提交');
        const intent = await this.journal.append(binding, 'intent', 'dispatch', 'completed', { effect_row:boundary.row.id,effect_duration_ms:d.max_run_ms,intent_key: key, verification_result:currentProof.result, request_id: context.request_id, ...requestSnapshot, device_identity_proven: !!d.probes && deviceIdentity, device_lease_digest: digestOfValue([context.lease_id,context.lease_token]), attempt, not_after: notAfter, sequence, action_digest: actionDigest,
          dispatch_binding_digest: digestOfValue([input.run, input.item, input.sha256, fresh, remote]), target_key: binding.target_key, ...intentSemantics, on_behalf_of: input.user,
          before_state_bound: beforeState.bound,before_state:beforeState,fences: fresh, remote_lease: remote, window: { from: this.now().toISOString(), to: notAfter } }, [`src:${input.sha256}`, `rec:${currentProof.result}`,...precheckSources,...requestSources], `dispatch.bytes:${input.sha256}:${attempt}`, tx);
        if (!intent.created) throw new Error('这份字节已经写过意图；未重复提交');
      });
      intended = true;
      if (this.now().getTime() >= Date.parse(notAfter)) { await this.notSent(binding,session,remote,stop,'意图后派发窗口已过，尚未调用提交');return this.status(by,binding.job); }
      if (!this.sameFences(fresh, await this.options.leases.holderSnapshot(d.resources))) { await this.notSent(binding,session,remote,stop,'意图后围栏改变，尚未调用提交');return this.status(by,binding.job); }
      if(!pulse.held() || this.now().getTime()>=Date.parse(notAfter)) { await stop();await this.release(binding,session,remote);await this.journal.append(binding,'complete','validate','completed',{done:true,outcome:'not_dispatched',submit_invoked:false,public_reason:'目标租约确认失效，尚未调用提交',next_action:'恢复目标租约后重新预检与派发'});return this.status(by,binding.job); }
      // Signals must not cancel an in-flight effect; SIGKILL is recovered from the already committed intent.
      const ignore = () => {}; process.on('SIGINT', ignore); process.on('SIGTERM', ignore); process.on('SIGHUP',ignore);
      let answer: Exchange;
      try {
        submitInvoked=true;
        try{answer=await session.call('submit',context,Math.max(1,Date.parse(notAfter)-this.now().getTime()));}
        catch(error){
          if(error instanceof SubmissionNotSentError||error instanceof InvocationDefinitionError)throw error;
          const rule=RETRY_RULES[intentSemantics.retry_safety];
          const retryDeadline=rule.window?Math.min(Date.parse(notAfter),Date.parse(notAfter)-d.submit_timeout_ms+(d.premises.window_resend?.window_ms??0)):Date.parse(notAfter);
          if(!rule.resend||this.now().getTime()>=retryDeadline||!pulse.held()||!await this.certified(binding,d,session,'retry_safety')||rule.window&&!await this.certified(binding,d,session,'window_resend'))throw error;
          try{await readBeforeState();}catch{await this.journal.append(binding,'retry_refused','dispatch','completed',{missing_fact:'丢回复后前状态不再匹配或读不到；原请求是否执行须对账',next_action:'自动只读原请求记录，不把重发前提失败当作未执行'});throw error;}
          const retryBoundary=await checkEffectBoundary({...finalBoundary,budget:async row=>{const used=await finalBoundary.budget(row);return {count:used.count-1,duration_ms:used.duration_ms-d.max_run_ms};}});
          if(!retryBoundary.ok||retryBoundary.checked!==9){const failure=retryBoundary.ok?incompleteEffectBoundary(retryBoundary):retryBoundary;await this.journal.append(binding,'retry_refused','dispatch','completed',{missing_fact:failure.message,next_action:failure.fix},[]);throw error;}
          await this.journal.append(binding,'resend','dispatch','completed',{outcome:'issued',request_id:context.request_id,intent_key:key,possibly_duplicated:rule.mark==='possible_duplicate',retry_once:true});
          if(!pulse.held()||this.now().getTime()>=retryDeadline)throw error;
          try{answer=await session.call('submit',context,Math.max(1,retryDeadline-this.now().getTime()));}
          catch(retryError){
            await this.journal.append(binding,'resend_failed','dispatch','unknown',{retry_locally_unsent:retryError instanceof SubmissionNotSentError||retryError instanceof InvocationDefinitionError,missing_fact:'第一次投递的执行事实尚未对账；第二次本地失败不能证明第一次未发出',next_action:'自动核对原请求记录；没有请求接口时交管理员按原投递事实处置'});
            throw error; // Only the first invocation's failure can classify whether the original effect was sent.
          }
        }
      } finally { process.off('SIGINT', ignore); process.off('SIGTERM', ignore); process.off('SIGHUP',ignore); }
      const accepted = !answer.tool_error && mapped(d.receipt.map, at(answer.value, d.receipt.acceptance)) === 'accepted';
      const remoteId = at(answer.value, d.receipt.id);
      if (d.receipt.request_id && at(answer.value, d.receipt.request_id) !== context.request_id) {
        await this.unknown(binding, '回执请求身份与意图不符；须按原请求记录核对，不能重交', [answer.source], { observed_outcome: 'read_back_mismatch' }); return this.status(by, binding.job);
      }
      if(requestSnapshot.request_identity && !sameRequestIdentity(requestSnapshot.request_identity,requestIdentity(answer.value,d.receipt.identity,d.reconciliation?.time_scale_ms))) {
        await this.unknown(binding,'投递回答的日志身份、记账起点或完整主体与投递前快照不一致；缺少原投递归属事实',[answer.source],{next_action:`请管理员 ${binding.initiated_by} 人工核对原投递事实、日志迁移和调用身份；不得重交`});return this.status(by,binding.job);
      }
      if (!accepted) {
        if (await this.refused(binding,d,session,answer,remote)) return this.status(by,binding.job);
        await this.unknown(binding, '目标拒绝缺少已认证的阶段或未上机事实；须按原请求记录核对，不能重交', [answer.source]); return await this.status(by, binding.job);
      }
      if ((typeof remoteId !== 'string' && typeof remoteId !== 'number') || (typeof remoteId === 'number' && !Number.isSafeInteger(remoteId)) || !String(remoteId) || String(remoteId).length > 512 || String(remoteId).includes('[已隐藏]')) {
        await this.unknown(binding, '已受理但缺少可用的远端作业身份；请管理员从审计找出编号', [answer.source]); return await this.status(by, binding.job);
      }
      if (at(answer.value, d.receipt.sha256) !== input.sha256 || !same(at(answer.value, d.receipt.items), input.items)) {
        await this.unknown(binding, '已受理但回执内容不符；请管理员核对原作业', [answer.source], { observed_outcome: 'read_back_mismatch', differences: { sha256: at(answer.value, d.receipt.sha256) !== input.sha256, items: !same(at(answer.value, d.receipt.items), input.items) } });
        return await this.status(by, binding.job);
      }
      await this.journal.append(binding, 'receipt', 'read', 'completed', { remote_id: remoteId, acceptance: 'accepted', outcome: 'issued' }, [answer.source]);
      return await this.observe(by, binding, d, session, remoteId, fresh, stop);
    } catch (error) {
      if(error instanceof EffectBoundaryError&&!intended&&!eventOf(await this.journal.events(binding.job),'intent')){await stop();if(remote)await this.release(binding,session,remote);return this.boundaryRefused(by,binding,error.failure);}
      if (intended || eventOf(await this.journal.events(binding.job), 'intent')) {
        if((!submitInvoked || error instanceof SubmissionNotSentError || error instanceof InvocationDefinitionError) && remote) {await this.notSent(binding,session,remote,stop,'当前进程证明未调用提交或未写出请求字节',error instanceof SubmissionNotSentError?[error.source]:[]);return this.status(by,binding.job);}
        if (receiptOf(await this.journal.events(binding.job))) await this.pendingRead(binding);
        else if (d.reconciliation && d.calls.query) return await this.reconcileRequest(by,binding,d,session,stop);
        else await this.unknown(binding, '提交未取得完整可信回执；缺远端作业身份或结果，必须管理员对账');
      }
      else {
        await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', ...(error instanceof CapabilityPolicyError || error instanceof InvocationDefinitionError || error instanceof InputVerificationError || error instanceof PrecheckFactError ? {public_reason:error.message} : {}),...(error instanceof PrecheckFactError?{missing_fact:error.missing_fact}:{}), reason: session.redact(error instanceof Error ? error.message.toWellFormed().slice(0, 1000) : '前提核对出错'), next_action:error instanceof PrecheckFactError?error.next_action:'核对只读条件、租约和执行器定义后重新核验；没有提交' });
        if (remote) await this.release(binding, session, remote);
      }
      return await this.status(by, binding.job);
    } finally { await stop(); }
  }
  private async boundaryRefused(by:Principal,binding:JobBinding,failure:BoundaryFailure):Promise<JobStatus>{
    if(!(await this.journal.events(binding.job)).length)await this.journal.append(binding,'reservation','dispatch','completed',{binding,read_only:true});
    await this.journal.append(binding,'boundary_refused','dispatch','error',{done:true,outcome:'not_dispatched',submit_invoked:false,boundary_clause:failure.clause,effect_row:failure.row??null,requirements:failure.requirements??[],public_reason:failure.message,missing_fact:failure.message,next_action:failure.fix},[],undefined,undefined,failure.code);
    return this.status(by,binding.job);
  }
  async resume(by: Principal, job: string): Promise<JobStatus> {
    await this.registry.admin(by);
    const binding = { ...await this.journal.binding(job), acting_by: by.id }; const events = await this.journal.events(job);
    if (isDone(events) && !isFrozen(events)) return this.status(by, job);
    if(eventOf(events,'probe_intent')) {const d=await this.readingDefinition(binding);const material=await this.secret(binding,d);if(material===null)return this.status(by,job);const client=this.session(binding,d,material);await client.connect();await this.probeFollowup(by,binding,d,client,true);return this.status(by,job);}
    const intent = eventOf(events, 'intent'); const receipt = receiptOf(events);
    if (!intent) {
      const gate = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: false }, [], `dispatch.gate:${job}`);
      if (!gate.created && gate.body.detail.allow_submit === true) { await this.unknown(binding, '派发可能正在进行；没有完整回执，不能重交'); return this.status(by, job); }
      await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', next_action: '从未写入派发意图，必要时重新核对后派发' });
      return this.status(by, job);
    }
    const d = await this.readingDefinition(binding);
    if ((!receipt || isFrozen(events)) && (!d.reconciliation || !d.calls.query)) { await this.unknown(binding, '有意图但无完整可信回执或仍被冻结；下一步由管理员对账'); return this.status(by, job); }
    const material=await this.secret(binding,d);if(material===null)return this.status(by,job);
    const client = this.session(binding, d, material);
    await client.connect();
    const remote = intent.body.detail.remote_lease as unknown as RemoteLease;
    const stop = this.heartbeat(binding, d, client, remote).stop;
    if (!receipt || isFrozen(events)) { try { return await this.reconcileRequest(by,binding,d,client,stop); } finally { await stop(); } }
    await this.checkContinuity(binding,d,client,remote);
    try { return await this.observe(by, binding, d, client, receipt!.body.detail.remote_id, intent.body.detail.fences as unknown as HolderSnapshot[], stop); }
    catch { await this.pendingRead(binding); return this.status(by, job); }
    finally { await stop(); }
  }
  async dispose(by: Principal, job: string, options: { choice: Disposition; remote_id?: string | number; reason?: string; acceptPossibleDuplicateEffects?: boolean }): Promise<JobStatus> {
    await this.registry.admin(by);
    const binding = { ...await this.journal.binding(job), acting_by: by.id }; const events = await this.journal.events(job);
    if (isDone(events) && !isFrozen(events)) return this.status(by, job);
    const requestRefs=openRequests(events).map(e=>`rec:${e.digest}`);
    const intent = eventOf(events, 'intent') ?? eventOf(events,'probe_intent');
    if (!intent) throw new Error('没有派发意图；请用 resume 核对未发出的作业');
    if(!isFrozen(events))throw new Error(`没有待回答的效果未知处置请求；已受理作业须先运行 circle-hub job resume ${job}`);
    if (options.choice === 'keep_unknown') {
      await this.answerRequests(binding, 'dispose', 'validate', 'completed', { disposition: options.choice, decided_by: by.id, decided_at: this.now().toISOString(), uncertain: true, unfreeze: false, next_action: '继续取得原作业审计与结果；不能重交' },[],requestRefs);
      return this.status(by, job);
    }
    if (options.choice === 'mark_failed') {
      if (!options.reason?.trim() || options.reason.length > 1000) throw new Error('标记失败必须给出非空原因，最多 1000 字符');
      const confirmed = options.acceptPossibleDuplicateEffects === true;
      const reason = this.redactor.maskText(options.reason);
      await this.answerRequests(binding, 'dispose', 'validate', 'completed', { disposition: options.choice, reason, decided_by: by.id, decided_at: this.now().toISOString(),
        risk_confirmed: confirmed, confirmed_by: confirmed ? by.id : null, confirmed_at: confirmed ? this.now().toISOString() : null,
        confirmation: confirmed ? '接受可能重复执行的副作用' : null, unfreeze: confirmed, done: confirmed,
        original_outcome: receiptOf(events) && !isFrozen(events) ? 'issued' : 'unknown', effect_mark: 'disposed', ...(confirmed ? {} : { next_action: '仍冻结；需要管理员对账或显式确认接受可能重复执行的副作用' }) },[],requestRefs);
      return this.status(by, job);
    }
    if(eventOf(events,'probe_intent'))return this.resume(by,job);
    const known=receiptOf(events)?.body.detail.remote_id;
    const remoteId=options.remote_id ?? known;
    if(known!==undefined && options.remote_id!==undefined && !same(known,remoteId))throw new Error('已有原回执，不得改绑为其他远端编号；请按原作业对账');
    if (options.choice !== 'reconcile' || remoteId === undefined) throw new Error(`本轮只允许${labelOf('disposition','reconcile')}、${labelOf('disposition','keep_unknown')}或${labelOf('disposition','mark_failed')}；核对必须给远端编号`);
    const d = await this.readingDefinition(binding); const material=await this.secret(binding,d);if(material===null)return this.status(by,job);const client = this.session(binding, d, material);
    const originalLease=intent.body.detail.remote_lease as unknown as RemoteLease;
    const context={...this.context(binding),request_id:intent.body.detail.request_id,not_after:intent.body.detail.not_after,remote_id:remoteId,lease_id:originalLease.id,lease_token:originalLease.token};
    let state!:Exchange;let result!:Exchange;let readable=false;
    try {
      await client.connect();
      state=await this.read(binding,client,'status',context,true);result=await this.read(binding,client,'result',context,true);readable=true;
      const rawTime = at(result.value, d.result.submitted_at);
      const time = readDeclaredTime(rawTime,d.result.submitted_at_scale_ms);
      const window = intent.body.detail.window as { from: string; to: string };
      if (!mapped(d.status.map, at(state.value, d.status.pointer)) || !same(at(result.value, d.result.id), remoteId) || at(result.value, d.result.sha256) !== binding.input!.sha256 || !Number.isFinite(time) || time < Date.parse(window.from)-d.clock_skew_ms || time > Date.parse(window.to)+d.clock_skew_ms) throw new Error('对账身份、摘要或投递窗口不符；查无记录不能证明未执行');
    }catch {
      await this.journal.append(binding,'reconcile_pending','read_back','error',{unfreeze:false,missing_fact:readable?'已读到原件，但身份、摘要或投递时间不符':'未取得完整可用的对账回答，不等于目标没有记录',next_action:`修复只读连接或映射后重跑 circle-hub job dispose ${job} --reconcile <原远端编号>`});
      throw new Error(readable?'对账身份、摘要或时间不符，仍冻结':'对账读取尚未成功；修复读取后重试本次对账，仍冻结');
    }
    await this.answerRequests(binding,'dispose','validate','completed',{disposition:'reconcile',decided_by:by.id,decided_at:this.now().toISOString(),unfreeze:true,remote_id:remoteId,effect_mark:'disposed',identity_matched:true,digest_matched:true,window_matched:true},[state.source,result.source],requestRefs);
    await this.answerRequests(binding,'reconciled','read_back','completed',{remote_id:remoteId,reconciled:true,acceptance:'accepted'},[result.source]);
    const stop=this.heartbeat(binding,d,client,originalLease).stop;
    try{return await this.observe(by,binding,d,client,remoteId,intent.body.detail.fences as unknown as HolderSnapshot[],stop);}
    catch{await this.pendingRead(binding);return this.status(by,job);}
    finally{await stop();}
  }

  private async answerRequests(binding:JobBinding,phase:string,action:ActionKind,result:ActionResult,detail:Record<string,unknown>,inputs:string[]=[],snapshot?:string[]):Promise<void> {
    const answers=snapshot ?? openRequests(await this.journal.events(binding.job)).map(e=>`rec:${e.digest}`);
    await this.journal.append(binding,phase,action,result,{...detail,answers,answer_source:typeof detail.decided_by==='string'?{user:detail.decided_by,at:detail.decided_at}:{component:'dispatch@1',at:this.now().toISOString()}},[...new Set([...inputs,...answers])]);
  }
  private async notSent(binding:JobBinding,client:RpcClient,lease:RemoteLease,stop:()=>Promise<void>,reason:string,sources:string[]=[]):Promise<void> {
    await stop();await this.release(binding,client,lease);
    const intent=eventOf(await this.journal.events(binding.job),'intent');
    await this.journal.append(binding,'complete','validate','completed',{done:true,outcome:'not_dispatched',submit_invoked:false,public_reason:reason,next_action:'当前进程证明未发出；恢复前提后可开启下一请求尝试'},[...(intent?[`rec:${intent.digest}`]:[]),...sources]);
  }
  private async checkContinuity(binding:JobBinding,d:ExecutorDefinition,client:RpcClient,lease:RemoteLease):Promise<void> {
    try {
      const reply=await this.read(binding,client,'heartbeat',{...this.context(binding),lease_id:lease.id,lease_token:lease.token});
      if(mapped(d.lease.map,at(reply.value,d.lease.acceptance))!=='accepted')throw new Error('原租约未核实');
    }catch{await this.journal.append(binding,'heartbeat','lease','error',{op:'extend' satisfies LeaseOp,lease_interrupted:true,missing_fact:'原目标租约已无法核实连续性；动态层不得据此判定',next_action:'继续只读原作业，并核对原租约和设备观察，不重交'});}
  }
  private async reconcileRequest(by: Principal, binding: JobBinding, d: ExecutorDefinition, client: RpcClient, stop: () => Promise<void>): Promise<JobStatus> {
    const intent = eventOf(await this.journal.events(binding.job),'intent')!;
    const lease = intent.body.detail.remote_lease as unknown as RemoteLease;
    const context = {...this.context(binding),request_id:intent.body.detail.request_id,not_after:intent.body.detail.not_after,lease_id:lease.id,lease_token:lease.token};
    const deadline = Date.parse(String(intent.body.detail.not_after));
    await this.journal.append(binding,'receipt_pending','read','completed',{missing_fact:'提交回执未取得，须取得原请求记录',next_action:'到请求截止时自动只读核对；进程退出后用 job resume 继续，不重发提交'});
    const wait = deadline - this.now().getTime(); if (wait > 0) await this.sleep(wait);
    const r = d.reconciliation!;
    let response: Exchange;
    for(;;) {
      try { response = await this.retryRead(binding,client,'query',context,Infinity); }
      catch { await this.unknown(binding,'原请求记录没有可用应答；已明确拒绝或已到重读上限，管理员修复读取通道或存储后 resume，不得重交',[],{next_action:`请管理员 ${binding.acting_by ?? binding.initiated_by} 恢复只读通道后运行 circle-hub job resume ${binding.job}；不得重交`}); return this.status(by,binding.job); }
      if(intent.body.detail.request_identity && !sameRequestIdentity(intent.body.detail.request_identity,requestIdentity(response.value,r.identity,r.time_scale_ms))) {
        await this.unknown(binding,'请求日志身份、记账起点或完整调用主体已改变或缺失；缺少原投递事实，当前查空不能证明未执行',[response.source],{next_action:`请管理员 ${binding.acting_by ?? binding.initiated_by} 人工核对原投递事实、原日志和调用身份；不得重交`});return this.status(by,binding.job);
      }
      const state=at(response.value,r.state);
      const pending=mapped(Object.fromEntries(r.pending_states.map(word=>[word,true])),state)===true;
      const targetTime=readDeclaredTime(at(response.value,r.gateway_time),r.time_scale_ms);
      const waitingForClock=at(response.value,r.found)===false && Number.isFinite(targetTime) && targetTime<=deadline;
      const waitingForRequest=at(response.value,r.found)===true && at(response.value,r.request_id)===context.request_id && at(response.value,r.sha256)===binding.input!.sha256 && pending;
      if(!waitingForClock && !waitingForRequest)break;
      await this.journal.append(binding,'query_pending','read','completed',{missing_fact:waitingForClock?'目标时刻尚未越过原请求截止，缺少截止后的查账记录':'目标明确报告原请求仍在处理中，尚未取得启动或拒收事实',next_action:'按登记间隔自动继续只读查询，不重交'},[response.source]);
      if(this.now().getTime()>=deadline+d.max_run_ms) {
        await this.unknown(binding,waitingForClock?'目标时刻在登记窗口内仍未越过原请求截止；需核对时刻声明和目标时钟':'目标仍报告处理中且超出登记窗口；需原操作者核对目标处理进程',[response.source],{next_action:`请管理员 ${binding.acting_by ?? binding.initiated_by} 核对目标处理进程，恢复后运行 circle-hub job resume ${binding.job}；不得重交`});
        return this.status(by,binding.job);
      }
      await this.sleep(d.poll_ms);
    }
    const value = response.value; const found = at(value,r.found);
    const reported = mapped(r.map,at(value,r.state));
    const identity = at(value,r.request_id) === context.request_id && at(value,r.sha256) === binding.input!.sha256;
    const knownIdentity=receiptOf(await this.journal.events(binding.job));
    if (found === true && identity && reported === 'issued' && at(value,r.reached_device)===true && this.opaque(at(value,r.id)) && (!knownIdentity || same(knownIdentity.body.detail.remote_id,at(value,r.id)))) {
      await this.answerRequests(binding,'reconciled','read_back','completed',{remote_id:at(value,r.id),acceptance:'accepted',outcome:'issued',unfreeze:true,reconciled:true},[response.source]);
      await this.checkContinuity(binding,d,client,lease);
      try { return await this.observe(by,binding,d,client,at(value,r.id),intent.body.detail.fences as unknown as HolderSnapshot[],stop); }
      catch { await this.pendingRead(binding); return this.status(by,binding.job); }
    }
    const queryCertified = await this.certified(binding,d,client,'request_journal');
    const deliveryCertified = await this.certified(binding,d,client,'request_journal',{version:intent.body.detail.request_protocol_version});
    const certified=queryCertified && deliveryCertified;
    const time = (v: unknown) => readDeclaredTime(v,r.time_scale_ms);
    const clock = time(at(value,r.gateway_time)), floor = time(at(value,r.gc_before));
    const currentIdentity=requestIdentity(value,r.identity,r.time_scale_ms);
    const originalProtocol=intent.body.detail.request_protocol_verified===true && typeof intent.body.detail.request_protocol_version==='string';
    const identityBound=originalProtocol && sameRequestIdentity(intent.body.detail.request_identity,currentIdentity);
    if(certified && identityBound && found===true && identity && reported==='target_rejected' && mapped(d.receipt.stages,at(value,r.stage))==='target_rejected' && at(value,r.reached_device)===false) {
      await this.answerRequests(binding,'rejection','read_back','completed',{outcome:'target_rejected',acceptance:'not_accepted',stage:at(value,r.stage),reached_device:false,unfreeze:true},[response.source]);
      await stop();await this.release(binding,client,lease);
      await this.answerRequests(binding,'complete','read_back','completed',{done:true,outcome:'target_rejected',unfreeze:true,next_action:'原请求记录明确拒收且未触达设备；修正拒收前提后可用新的请求尝试派发'});
      return this.status(by,binding.job);
    }
    const absent = identityBound && !!currentIdentity && floor>=currentIdentity.since && found === false && Number.isFinite(clock) && Number.isFinite(floor) && clock > deadline && deadline > floor;
    if (certified && identityBound && (absent || (found === true && identity && reported === 'proven_not_executed' && at(value,r.reached_device) === false))) {
      await this.answerRequests(binding,'reconciled','read_back','completed',{outcome:'proven_not_executed',unfreeze:true,reached_device:false},[response.source]);
      await stop(); await this.release(binding,client,lease);
      await this.answerRequests(binding,'complete','read_back','completed',{done:true,outcome:'proven_not_executed',unfreeze:true,next_action:'原请求记录证明未执行；修正前提后可开启新的请求尝试'});
      return this.status(by,binding.job);
    }
    const missing:string[]=[];
    if(!identityBound)missing.push('缺少投递前冻结的日志身份、完整主体或发送会话的协议支持事实；须人工核对原投递事实');
    if(found!==true && found!==false)missing.push('缺少布尔型查账结果');
    if(found===true) {
      if(at(value,r.request_id)!==context.request_id)missing.push('查账返回了不同请求标识，缺本请求记录');
      if(at(value,r.sha256)!==binding.input!.sha256)missing.push('记录字节摘要与原意图不符');
      if(!reported)missing.push('该目标状态尚未登记映射');
      if(reported==='issued' && !this.opaque(at(value,r.id)))missing.push('启动记录缺少有效远端编号');
      if(reported==='issued' && at(value,r.reached_device)!==true)missing.push('缺少设备开始标记；尚未确定是否触达，不能当作已发出或未触达');
      if((reported==='target_rejected' || reported==='proven_not_executed') && at(value,r.reached_device)!==false)missing.push('记录未明确证明未触达设备');
      if(reported==='target_rejected' && mapped(d.receipt.stages,at(value,r.stage))!=='target_rejected')missing.push('拒绝阶段未获明确映射');
    }
    if(found===false) {
      if(!Number.isFinite(clock))missing.push('目标时刻不符合声明的时间格式');
      if(!Number.isFinite(floor))missing.push('缺少有效的保留边界');
      else if(currentIdentity && floor<currentIdentity.since)missing.push('回收边界早于可靠记账起点，不能证明原请求未执行');
      else if(deadline<=floor)missing.push('原请求截止已落入可能清理区间，查空不证明未执行');
    }
    if(!queryCertified)missing.push('当前查询会话版本的请求记录前提未认证');
    if(!deliveryCertified)missing.push('发送会话版本的请求记录前提未认证，或协议支持已撤销');
    await this.unknown(binding,missing.join('；') || '缺少可终结原请求的执行记录，请核对状态映射与原件',[response.source],{next_action:!identityBound?`请管理员 ${binding.acting_by ?? binding.initiated_by} 人工核对原投递事实、原日志和发送会话版本；不得重交`:!certified?`请管理员 ${binding.acting_by ?? binding.initiated_by} 运行 circle-hub job conformance --executor ${binding.executor} 采证并登记目标版本，再运行 circle-hub job resume ${binding.job}`:`请管理员 ${binding.acting_by ?? binding.initiated_by} 核对本次查账原件和字段映射，修复后运行 circle-hub job resume ${binding.job}；不得重交`});
    return this.status(by,binding.job);
  }

  private async certified(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, premise: keyof ExecutorDefinition['premises'],delivery?:{version:unknown}): Promise<boolean> {
    const current = await this.registry.get(binding.executor);
    if (!current || current.definition.target !== d.target || current.definition.endpoint !== d.endpoint || current.definition.ca !== d.ca) return false;
    const proof = current.definition.premises[premise];
    const version=delivery?delivery.version:client.serverVersion;
    if (!proof || typeof version!=='string' || proof.version !== version || delivery && version!==client.serverVersion || delivery && !current.definition.reconciliation?.protocol_versions.includes(version)) return false;
    const by = await this.options.records.principals.get(binding.acting_by ?? binding.initiated_by);
    if (!by || by.disabled) return false;
    for (const ref of proof.evidence) {
      try { const source = await this.options.records.artifacts.source(by,ref.slice(4),{consumer:'function'});
        if (!source?.bytes || sha256Hex(source.bytes) !== ref.slice(4)) return false;
      } catch { return false; }
    }
    const events=await this.journal.events(binding.job);
    const origin=delivery?eventOf(events,'intent') ?? eventOf(events,'probe_intent'):eventOf(events,'initialize.response');
    await this.journal.append(binding,'premise','validate','completed',{premise,version,delivery_session:!!delivery,definition_sha256:current.digest,certified:true},[...proof.evidence,...(origin?.body.inputs ?? [])]);
    return true;
  }
  private async refused(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, answer: Exchange, lease: RemoteLease): Promise<boolean> {
    if (mapped(d.receipt.map,at(answer.value,d.receipt.acceptance)) !== 'not_accepted' || !d.receipt.stage || !d.receipt.reached_device || mapped(d.receipt.stages,at(answer.value,d.receipt.stage)) !== 'target_rejected' || at(answer.value,d.receipt.reached_device) !== false || !await this.certified(binding,d,client,'request_journal')) return false;
    await this.answerRequests(binding,'rejection','read_back','completed',{outcome:'target_rejected',acceptance:'not_accepted',stage:at(answer.value,d.receipt.stage),reached_device:false,unfreeze:true},[answer.source]);
    await this.release(binding,client,lease);
    await this.answerRequests(binding,'complete','read_back','completed',{done:true,outcome:'target_rejected',unfreeze:true,next_action:'按拒绝阶段补齐事实后，可用新的请求尝试派发；不要重发原请求'});
    return true;
  }

  private async reserve(binding: JobBinding, tx?: Transaction): Promise<void> {
    await this.assertNoSecrets(binding);
    if(binding.fences?.length && !this.sameFences(binding.fences,await this.options.leases.holderSnapshot(binding.resources,tx)))throw new Error('预留前围栏或血缘已改变，尚未提交；重新读取登记和租约后重开核验');
    const definition=await this.pinned(binding);
    // Read the CAS heads before checking occupancy. A reservation committed during
    // that check must either be observed as a blocker or invalidate our CAS head.
    const history=await this.options.records.store.findMany<ActionBody>({kind:'action',key:'dispatch.phase',values:['reservation']});
    const blocked=await this.journal.blockers(binding.executor,definition.target,new URL(definition.endpoint).origin,binding.resources);
    if(blocked.length){const actions=await Promise.all(blocked.map(async job=>isFrozen(await this.journal.events(job))?`circle-hub job dispose ${job} --reconcile <原远端编号>`:`circle-hub job resume ${job}`));throw new Error(`物理目标被作业 ${blocked.join('、')} 占用；下一步：${actions.join('；')}`);}
    const resources = binding.resources.map(r => sha256Hex(r)).sort();
    const identities=[['executor',binding.executor],['target',definition.target],['origin',new URL(definition.endpoint).origin]].map(digestOfValue).sort();
    await this.options.records.store.withTransaction(async tx => {
      await lockExecutorConfiguration(this.options.records.store,tx,binding.executor,binding.resources,[definition.target],[new URL(definition.endpoint).origin]);
      const config=await this.options.records.store.find<AuthorizationRecord['body']>({key:'authz.key',value:`resource_config|${WHOLE_HUB}|executor.${binding.executor}`,kind:'authorization',newestFirst:true,limit:1},tx);
      if(config.items[0]?.body.revoked||config.items[0]?.body.bound!==(binding.executor_source_digest??binding.executor_digest))throw new PrecheckFactError('执行器配置已变；未提交，请按当前配置重新核验','用当前配置重新核验后再派发；没有提交');
      for(const identity of identities) {
        const previous=[...history].reverse().find(e=>e.body.detail.reserved_identity===identity);
        const claim=await this.journal.append(binding,'reservation','validate','completed',{binding,reserved_identity:identity,previous_reservation:previous?.digest??null},previous?[`rec:${previous.digest}`]:[],`dispatch.reserve.identity:${identity}:${previous?.digest??'first'}`,tx);
        if(!claim.created)throw new Error('另一进程已经预留执行器或目标；未提交');
      }
      for (const resource of resources) {
        const previous = [...history].reverse().find(e => e.body.detail.phase === 'reservation' && e.body.detail.reserved_resource === resource);
        const claim = await this.journal.append(binding, 'reservation', 'validate', 'completed', { binding, reserved_resource: resource, previous_reservation: previous?.digest ?? null }, previous ? [`rec:${previous.digest}`] : [], `dispatch.reserve:${resource}:${previous?.digest ?? 'first'}`, tx);
        if (!claim.created) throw new Error('另一进程已经预留物理目标；未提交');
      }
    });
  }
  private async holders(ancestors: string[], user: string, keys: string[], requiredMs: number): Promise<HolderSnapshot[]> {
    const rows = await this.options.leases.holderSnapshot(keys);
    if (rows.length !== keys.length || rows.some(r => r.released || r.user !== user || !ancestors.includes(r.run) || (r.expires_at !== null && Date.parse(r.expires_at) <= this.now().getTime() + requiredMs))) throw new Error('血缘不持有全部物理资源，或租约到期早于最长运行时间；请重新预订后核验');
    return rows;
  }
  private sameFences(before: readonly HolderSnapshot[], after: readonly HolderSnapshot[]): boolean {
    return before.length === after.length && before.every(a => after.some(b => a.key === b.key && a.lease === b.lease && b.fencing >= a.fencing && !b.released && (b.expires_at === null || Date.parse(b.expires_at) > this.now().getTime())));
  }
  private async assertNoSecrets(value:unknown):Promise<void>{
    for(const material of await this.options.records.variables.recentSecrets()){
      this.redactor.add(material.value);
      if(containsSecret(value,material.value))throw new Error('绑定元数据不能包含任何当前或上一版密钥的原文');
    }
  }
  private async secret(binding:JobBinding,d:ExecutorDefinition):Promise<string|null>{
    for(const material of await this.options.records.variables.recentSecrets())this.redactor.add(material.value);
    try {
      const material=await this.registry.material(binding.executor,d);
      this.redactor.addSent('Bearer '+material.value);
      await this.journal.append(binding,'credential_used','read','completed',{name:material.name,version:material.version,variables:[{at:binding.executor+'#/credential',name:material.name,decision:material.decision}]},['rec:'+material.decision]);
      return material.value;
    }catch(error){if(!(error instanceof ExecutorAccessError))throw error;
      const events=await this.journal.events(binding.job);
      const next=eventOf(events,'intent')||eventOf(events,'probe_intent')?'circle-hub job resume '+binding.job:binding.input?'circle-hub job dispatch --run '+binding.input.run+' --executor '+binding.executor:'circle-hub job precheck --executor '+binding.executor;
      await this.journal.append(binding,'session_unavailable','read','error',{missing_fact:error.message,next_action:error.next_action+'；完成后运行 '+next});return null;
    }
  }
  private async credentialUnavailable(by:Principal,binding:JobBinding,complete:boolean):Promise<JobStatus>{
    const gap=eventOf(await this.journal.events(binding.job),'session_unavailable')!;
    if(complete)await this.journal.append(binding,'complete','validate','completed',{done:true,outcome:'not_dispatched',submit_invoked:false,missing_fact:gap.body.detail.missing_fact,next_action:gap.body.detail.next_action});
    return this.status(by,binding.job);
  }
  private async pinned(binding: JobBinding): Promise<ExecutorDefinition> {
    const bytes = await this.options.records.objects.get(binding.executor_digest);
    if (!bytes) throw new Error('冻结的执行器定义缺失');
    const { ExecutorDefinition: schema } = await import('./definition.ts'); return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }
  private async readingDefinition(binding:JobBinding):Promise<ExecutorDefinition> {
    const pinned=await this.pinned(binding);
    const source=await this.registry.readSource(binding.executor);
    const snapshot=await this.options.records.variables.snapshot();
    const changed=(binding.variables??[]).filter(use=>snapshot.get(use.name)!==use.decision);
    if(changed.length || source?.digest!==(binding.executor_source_digest??binding.executor_digest)) {
      const prior=eventOf(await this.journal.events(binding.job),'configuration_drift');
      if(!prior)await this.journal.append(binding,'configuration_drift','validate','completed',{names:[...new Set(changed.map(u=>u.name))],source_changed:source?.digest!==(binding.executor_source_digest??binding.executor_digest),note:'写意图后的定义和变量变更只记漂移；继续读原先固定的定义，不重新解析'});
    }
    if(!source)return pinned;
    let repaired;
    try {repaired=await resolveExecutor(this.options.records,source.source,new Map((binding.variables??[]).map(use=>[use.name,use.decision])));}
    catch {
      await this.journal.append(binding,'reading_repair_refused','validate','completed',{missing_fact:'这份只读修补不能用原作业的固定变量决定解析；缺原决定或旧值不合新模式',next_action:'沿用原变量名字或将只读修补写成字面声明，保持派发字段不变；executor update 后重读原作业，不重交'});return pinned;
    }
    if(!same(fixedForReading(pinned),fixedForReading(repaired.definition))){
      await this.journal.append(binding,'reading_repair_refused','validate','completed',{missing_fact:'新源定义改变了原作业的派发字段；不能用于修补读取',next_action:'保持原派发字段和原变量名字，只更新只读策略或认证；executor update 后重读原作业，不重交'});return pinned;
    }
    await this.assertNoSecrets(repaired.definition);
    const stored=await this.options.records.objects.put(canonicalBytes(repaired.definition),'application/json');
    if(stored.sha256===binding.executor_digest)return pinned;
    const auth=await this.options.records.authorizations.resourceConfig('executor.'+binding.executor);
    await this.journal.append(binding,'reading_definition','validate','completed',{operation_definition_sha256:binding.executor_digest,source_definition_sha256:source.digest,reading_definition_sha256:stored.sha256,variables:repaired.variables,note:'只读修补只用原作业固定的变量决定；未取当前变量'},[...(auth?['rec:'+auth.digest]:[]),...repaired.variables.map(use=>'rec:'+use.decision)]);
    return repaired.definition;
  }

  private context(binding: JobBinding): Record<string, unknown> { return { ...binding.context, job: binding.job, user: binding.user, actor: binding.acting_by ?? binding.initiated_by, build_base:binding.input?.build_base ?? binding.context?.build_base, product:binding.input?.product ?? binding.context?.product, root:binding.input?.root ?? binding.context?.root, target: binding.input?.target ?? binding.context?.target, build: binding.input?.build ?? binding.context?.build, sha256: binding.input?.sha256, items: binding.input?.items, seats: binding.context?.seats ?? (binding.resources.length ? binding.resources.length : undefined), manifest_sha256: binding.input?.manifest_sha256 ?? binding.context?.manifest_sha256 }; }
  private session(binding: JobBinding, d: ExecutorDefinition, secret: string): RpcClient {
    return new RpcClient(d, secret, `${binding.user}/${binding.job}`, async (bytes, status, operation, complete = true, metadata) => {
      const captured = await this.journal.raw(binding, bytes, operation, complete);
      const source = captured.reference;
      const op:LeaseOp|undefined=operation==='acquire'?'acquire':operation==='heartbeat'?'extend':operation==='release'?'release':undefined;
      const {received_sha256,...publicMetadata}=metadata??{};
      if(metadata?.redacted && binding.input)await this.journal.append({...binding,input:null},`${operation}.private_response`,'read','completed',{received_sha256,redacted:true});
      const visibleMetadata=metadata?.redacted && binding.input?publicMetadata:metadata;
      await this.journal.append(binding, `${operation}.response`, op?'lease':operation === 'submit' ? 'dispatch' : 'read', complete ? 'completed' : operation==='submit' ? 'unknown' : 'error', { ...(op?{op}:{}),http_status: status, complete, source_record: captured.record, ...visibleMetadata }, [source, captured.record]);
      return source;
    }, this.now,this.redactor);
  }
  private async read(binding: JobBinding, client: RpcClient, role: CallRole, context: Record<string, unknown>, readBack = false): Promise<Exchange> {
    const result = await client.call(role, context);
    const op:LeaseOp|undefined=role==='acquire'?'acquire':role==='heartbeat'?'extend':role==='release'?'release':undefined;
    await this.journal.append(binding, role, op?'lease':readBack ? 'read_back' : 'read', 'completed', { ...(op?{op,remote_lease:{id:context.lease_id,token:context.lease_token}}:{}), started_at: result.started_at, ended_at: result.received_at }, [result.source]);
    return result;
  }
  private async retryRead(binding: JobBinding, client: RpcClient, role: CallRole, context: Record<string, unknown>, deadline: number): Promise<Exchange> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await this.read(binding, client, role, context); }
      catch (error) {
        const retry=canRetryRead(error,client.definition,context);
        await this.journal.append(binding, `${role}.retry`, 'read', 'error', { attempt, missing_fact: '本次只读应答不可用，不等于未执行', next_action: retry && attempt < 3 ? '自动重读原作业，绝不重交' : `circle-hub job resume ${binding.job}` });
        if (!retry || attempt === 3 || this.now().getTime() >= deadline) throw new Error('原作业只读查询待恢复');
        await this.sleep(client.definition.poll_ms);
      }
    }
    throw new Error('原作业只读查询待恢复');
  }
  private async pendingRead(binding: JobBinding): Promise<void> {
    const cycles=(await this.journal.events(binding.job)).filter(e=>e.body.detail.phase==='read_pending').length+1;
    await this.journal.append(binding, 'read_pending', 'read', 'error', { cycle:cycles, missing_fact: '已有受理回执，原作业状态或结果原件尚未完整取得或保存；不是未执行',  next_action: `只读未成功；修复连接、读取声明或本地存储后运行 circle-hub job resume ${binding.job}；不得重交` });
    await this.journal.append(binding, 'heartbeat', 'lease', 'error', {op:'extend' satisfies LeaseOp, lease_interrupted: true, note: '命令暂停，目标租约连续性未证实；恢复时只读原作业' });
    if(cycles>=3)await this.unknown(binding,'原作业连续三轮未取得可用状态或结果；并非未执行，请具名管理员修复读取后继续，或按处置请求决定后续');
  }
  private async acquire(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>): Promise<RemoteLease> {
    const started={at:this.now().getTime(),mono:performance.now()};
    const response = await client.call('acquire', context);
    const lease = { id: at(response.value, d.lease.id), token: at(response.value, d.lease.token), ttl: Number(at(response.value, d.lease.ttl_ms)) * d.lease.ttl_scale_ms };
    if (mapped(d.lease.map, at(response.value, d.lease.acceptance)) !== 'accepted' || !this.opaque(lease.id) || !this.opaque(lease.token) || !Number.isFinite(lease.ttl) || lease.ttl < 3) throw new Error('目标租约未取得，未提交');
    await this.journal.append(binding, 'acquire', 'lease', 'completed', { op:'acquire' satisfies LeaseOp,remote_lease: lease }, [response.source]);this.#leaseClocks.set(lease,{...started,ttl:lease.ttl}); return lease;
  }
  private opaque(value: unknown): boolean { return (typeof value === 'string' && !/[\x00-\x1f\x7f-\x9f]/.test(value) && value.length > 0 && value.length <= 4096 && !value.includes('[已隐藏]')) || (typeof value === 'number' && Number.isSafeInteger(value)); }
  private async assessConditions(binding:JobBinding,conditions:ExecutorDefinition['conditions'],response:Exchange,context:Record<string,unknown>,phase:string):Promise<boolean> {
    const checks=conditions.map(c=>{
      const operator=Object.hasOwn(c,'equals')?'equals':c.at_least!==undefined?'at_least':'sha256';
      let expected:unknown;let matched=false;
      try{expected=bind(operator==='equals'?c.equals:operator==='at_least'?c.at_least:c.sha256,context);matched=this.conditions([c],response.value,context);}catch{}
      return {pointer:c.pointer,operator,expected_sha256:expected===undefined?null:digestOfValue(expected),matched};
    });
    const matched=checks.length>0 && checks.every(c=>c.matched);
    await this.journal.append(binding,phase,'validate','completed',{matched:checks.length?matched:null,conditions:checks,...(!matched?{missing_fact:'条件没有满足或缺少期望绑定；见未匹配的指针和运算符',next_action:'核对受限原件和声明条件后重跑预检，未提交'}:{})},[response.source]);
    return matched;
  }
  private conditions(conditions: ExecutorDefinition['conditions'], value: unknown, context: Record<string, unknown>): boolean {
    return conditions.length > 0 && conditions.every(c => { const actual = at(value, c.pointer);
      if (Object.hasOwn(c, 'equals')) return same(actual, bind(c.equals, context));
      if (c.at_least !== undefined) return typeof actual === 'number' && typeof bind(c.at_least, context) === 'number' && actual >= (bind(c.at_least, context) as number);
      return actual !== undefined && digestOfValue(actual) === bind(c.sha256, context);
    });
  }
  private async probeSeats(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string,unknown>): Promise<boolean> {
    if (!d.probes) return false;
    const { assessProbes } = await import('./probes.ts');
    return assessProbes(this.options.records,this.options.knowledge,binding,d,client,context,this.journal,this.sleep);
  }
  private async extraPrechecks(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>, collectAll: boolean): Promise<boolean> {
    let verified = true;
    for (const [index, check] of d.precheck_reads.entries()) {
      let ok = false;
      try {
        let reply: Exchange | undefined;
        for(let attempt=1;attempt<=3;attempt++) {
          try{reply=await client.precheckRead(index,context);break;}
          catch(error){const retry=canRetryRead(error,d,context);await this.journal.append(binding,`precheck.${index+1}.retry`,'read','error',{attempt,next_action:retry && attempt<3?'自动重读该来源，未提交':'修复读取声明、权限或存储后重跑预检，未提交'});if(!retry)break;if(attempt<3)await this.sleep(d.poll_ms);}
        }
        if(!reply)throw new Error('只读来源连续三次读取失败');
        ok = await this.assessConditions(binding,check.conditions,reply,context,`precheck.${index+1}`);
        await this.journal.append(binding, `precheck.${index + 1}`, 'validate', 'completed', { matched: check.conditions.length ? ok : null, ...(check.conditions.length ? {} : { missing_fact: '只读原件已取得，但尚未登记期望条件；请转换核对后 update' }), started_at: reply.started_at, ended_at: reply.received_at }, [reply.source]);
      } catch { await this.journal.append(binding, `precheck.${index + 1}`, 'read', 'error', {step:`precheck.${index+1}`,missing_fact:`第 ${index+1} 个附加读取没有完整且可保存的应答或期望输入`,next_action:'管理员核对该附加来源的受限原件、权限、读取参数及本地存储，恢复缺失应答并登记期望条件后再采证'}); }
      verified = verified && ok;
      if (!ok && !collectAll) break;
    }
    return verified;
  }
  private heartbeat(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, lease: RemoteLease): Heartbeat {
    let flight:Promise<void>|null=null;let available=true;let stopped=false;let overrun=false;
    let confirmed=this.#leaseClocks.get(lease);
    const notices=new Set<Promise<unknown>>();
    const notice=(text:string)=>{const p=this.journal.append(binding,'heartbeat','lease','error',{op:'extend' satisfies LeaseOp,lease_interrupted:true,note:text,next_action:'发出前须恢复本租约确认；已发出则继续读原作业，不重交'}).catch(()=>{});notices.add(p);void p.finally(()=>notices.delete(p));};
    const held=()=>available && !!confirmed && Math.max(this.now().getTime()-confirmed.at,performance.now()-confirmed.mono,0)<confirmed.ttl;
    const timer=setInterval(()=>{
      if(stopped)return;
      if(flight){available=false;if(!overrun){overrun=true;notice('心跳未按期完成，租约连续性未获确认');}return;}
      const started={at:this.now().getTime(),mono:performance.now()};
      flight=(async()=>{
        try {
          const response=await client.call('heartbeat',{...this.context(binding),lease_id:lease.id,lease_token:lease.token},Math.max(1,Math.min(d.calls.heartbeat.timeout_ms,Math.floor(lease.ttl/3))));
          const ttl=Number(at(response.value,d.lease.ttl_ms))*d.lease.ttl_scale_ms;
          if(mapped(d.lease.map,at(response.value,d.lease.acceptance))!=='accepted' || !same(at(response.value,d.lease.id),lease.id) || !same(at(response.value,d.lease.token),lease.token) || !Number.isFinite(ttl) || ttl<3)throw new Error('原租约没有有效确认');
          await this.journal.append(binding,'heartbeat','lease','completed',{op:'extend' satisfies LeaseOp,last_confirmed_at:new Date(started.at).toISOString()},[response.source]);
          confirmed={...started,ttl};this.#leaseClocks.set(lease,confirmed);available=true;overrun=false;
        }catch{available=false;notice('目标租约未获确认；后续心跳继续尝试，已发出作业只读恢复');}
      })().finally(()=>{flight=null;});
    },Math.max(1,Math.floor(lease.ttl/3)));
    return {held,lastConfirmedAt:()=>confirmed?.at ?? null,stop:async()=>{stopped=true;clearInterval(timer);if(flight)await flight;await Promise.allSettled([...notices]);}};
  }
  private async release(binding: JobBinding, client: RpcClient, lease: RemoteLease): Promise<void> {
    try { await this.read(binding, client, 'release', { ...this.context(binding), lease_id: lease.id, lease_token: lease.token }); }
    catch { await this.journal.append(binding, 'release', 'lease', 'error', {op:'release' satisfies LeaseOp, next_action: '目标租约释放未核实；请管理员只读核对，不能重交' }); }
  }
  private async unknown(binding: JobBinding, reason: string, sources: string[] = [], observation: Record<string, unknown> = {}): Promise<void> {
    const history=await this.journal.events(binding.job);
    const intent=eventOf(history,'intent') ?? eventOf(history,'probe_intent');const d=await this.pinned(binding);
    const requestKind:RequestKind='disposition';
    const question_sha256=digestOfValue({job:binding.job,run:binding.input?.run ?? null,item:binding.input?.item ?? null,intent_key:intent?.body.detail.intent_key ?? null,question:reason});
    const deadline=new Date(Date.parse(String(intent?.body.detail.not_after ?? this.now().toISOString()))+d.max_run_ms).toISOString();
    const identity=receiptOf(history);
    const value=identity?.body.detail.remote_id;
    const command=this.opaque(value)?`circle-hub job dispose ${binding.job} --reconcile='${String(value).replaceAll("'","'\"'\"'")}'${typeof value==='number'?' --numeric-id':''}`:`circle-hub job dispose ${binding.job} --reconcile <原远端编号>`;
    await this.journal.append(binding, 'unknown', 'validate', 'unknown', { ...observation, uncertain: true, outcome: 'unknown', missing_fact: reason,
      request_kind: requestKind,question_sha256,deadline,channel:{component:'cli-job',command:`circle-hub job dispose ${binding.job}`},audience_user:binding.acting_by ?? binding.initiated_by, audience_role: 'admin', next_action: typeof observation.next_action==='string' ? observation.next_action : identity?`管理员按已存原作业编号运行 ${command}；不得重交`:`管理员从原请求记录或审计取得编号后运行 ${command}；不得重交` }, sources);
  }
  private async observe(by: Principal, binding: JobBinding, d: ExecutorDefinition, client: RpcClient, remoteId: unknown, fences: HolderSnapshot[], stopHeartbeat: () => Promise<void> = async () => {}): Promise<JobStatus> {
    const input = binding.input!; const events = await this.journal.events(binding.job); const intent = eventOf(events, 'intent')!;
    const remoteLease = intent.body.detail.remote_lease as unknown as RemoteLease;
    const context = { ...this.context(binding),request_id:intent.body.detail.request_id,not_after:intent.body.detail.not_after, remote_id: remoteId, lease_id: remoteLease.id, lease_token: remoteLease.token };
    const deadline = Date.parse(String(intent.body.detail.not_after)) + d.max_run_ms; let drift = false;
    for (;;) {
      const response = await this.retryRead(binding, client, 'status', context, deadline);
      const observedHolders=!drift?await this.options.leases.holderSnapshot(binding.resources):[];
      if (!drift && !this.sameFences(fences, observedHolders)) {
        drift = true; await this.journal.append(binding, 'fencing', 'validate', 'completed', { drift: true,missing_fact:'同一 Hub 租约连续性未证明',next_action:'复用前重新证明基线；当前只读原作业，不重交',expired:observedHolders.some(row=>row.expires_at!==null && Date.parse(row.expires_at)<=this.now().getTime()), note: '派发后租约到期或围栏改变，不能声称保持同一租约；继续只读状态' });
      }
      const mapping = mapped(d.status.map, at(response.value, d.status.pointer));
      if (!mapping || mapping.effect_outcome === 'unknown' || mapping.action_result === 'unknown' || mapping.acceptance === 'not_accepted' || mapping.effect_outcome === 'read_back_mismatch' || mapping.effect_outcome === 'target_rejected' || mapping.effect_outcome === 'not_dispatched' || mapping.effect_outcome === 'proven_not_executed') { await this.unknown(binding, '目标状态不能作为可信终态（未映射或缺拒绝阶段、未执行证明）；下一步管理员对账', [response.source], { reported_state: mapping ?? null }); return this.status(by, binding.job); }
      if (mapping.action_result === 'completed' || mapping.action_result === 'error' || mapping.effect_outcome === 'effective' || mapping.effect_outcome === 'read_back_consistent' || mapping.dynamic_terminal !== undefined) {
        await this.journal.append(binding, 'terminal', 'read', 'completed', { reported_state: mapping, ...(d.status.exit_code ? { exit_code: at(response.value, d.status.exit_code) ?? null } : {}) }, [response.source]);
        break;
      }
      if (this.now().getTime() >= deadline) { await this.unknown(binding, '最长运行窗口已过且没有可信终态；下一步管理员对账'); return this.status(by, binding.job); }
      await this.sleep(d.poll_ms);
    }
    const response = await this.retryRead(binding, client, 'result', context, deadline);
    if (!same(at(response.value, d.result.id), remoteId) || at(response.value, d.result.sha256) !== input.sha256) {
      await this.unknown(binding, '结果身份或摘要不符，整份不采信；请管理员对账', [response.source], { observed_outcome: 'read_back_mismatch' }); return this.status(by, binding.job);
    }
    const rows = at(response.value, d.result.items); const complete = at(response.value, d.result.complete) === true;
    const finalHolders=!drift?await this.options.leases.holderSnapshot(binding.resources):[];
    if (!drift && !this.sameFences(fences, finalHolders)) {
      drift = true; await this.journal.append(binding, 'fencing', 'validate', 'completed', { drift: true,missing_fact:'同一 Hub 租约连续性未证明',next_action:'复用前重新证明基线；当前只读原作业，不重交',expired:finalHolders.some(row=>row.expires_at!==null && Date.parse(row.expires_at)<=this.now().getTime()), note: '结果读取期间租约到期或围栏改变，不能声称保持同一租约' });
    }
    await stopHeartbeat();
    const leaseInterrupted = (await this.journal.events(binding.job)).some(e => e.body.detail.lease_interrupted === true);
    const ownershipCertified = await this.certified(binding,d,client,'result_ownership');
    const attribution=d.result.ownership;
    const ownershipReported=attribution?at(response.value,attribution.pointer):undefined;
    const ownershipReason=attribution?at(response.value,attribution.reason):undefined;
    const ownershipMatched=!!attribution && ownershipReported===attribution.value;
    const ownershipConflict=ownershipMatched && ownershipReason!==null && ownershipReason!==undefined;
    const ownership=ownershipCertified && ownershipMatched && !ownershipConflict;
    const ownershipObservation={declared:!!attribution,certified:ownershipCertified,matched:ownershipMatched,consistent:!ownershipConflict,reported:typeof ownershipReported==='string'?ownershipReported:null,reason:ownershipReason===undefined?null:ownershipReason,source:response.source};
    const admin=binding.acting_by ?? binding.initiated_by;
    const ownershipFailure=!attribution?{missing_fact:'执行器尚未声明本次结果的归属字段和唯一归属值',next_action:`请管理员 ${admin} 核对 ${response.source} 并登记 result.ownership 的字段、唯一归属值及原因指针声明；本作业保留无判定，不重交`}:!ownershipMatched?{missing_fact:'本结果未报告声明的唯一归属；具体原因见归属观察及原件',next_action:`请管理员 ${admin} 依据 ${response.source} 检查原派发日志、收集器目录和保留证据，恢复归属或登记该版本的能力缺口；本作业保留无判定，不重交`}:ownershipConflict?{missing_fact:'本结果的唯一归属值与原因字段相互矛盾，不能采用为归属事实',next_action:`请管理员 ${admin} 依据 ${response.source} 核对目标协议实现及报告归属，修复肯定值与原因的矛盾或登记能力缺口；本作业保留无判定，不重交`}:{missing_fact:'本结果的归属值相符，但当前目标版本的归属前提尚未认证',next_action:`请管理员 ${admin} 复核 ${response.source} 的归属证据，为该目标版本登记 result_ownership 认证；认证用于后续核验，本作业保留无判定，不重交`};
    const projected = input.items.map(id => {
      const found = Array.isArray(rows) ? rows.filter(r => at(r, d.result.item_id) === id) : [];
      const reported = complete && found.length === 1 ? mapped(d.result.map, at(found[0], d.result.item_outcome)) ?? null : null;
      const row = found.length === 1 ? found[0] : null;
      const log = d.result.log ? at(row,d.result.log) : undefined;
      const disposition = dynamicDisposition(reported,{owned:ownership,request:!!d.result.request_id && at(response.value,d.result.request_id) === intent.body.detail.request_id,remote:same(at(response.value,d.result.id),remoteId),digest:at(response.value,d.result.sha256) === input.sha256,complete:complete && Array.isArray(rows) && rows.length === input.items.length,unique:found.length === 1,closed:!!d.result.closing_marker && typeof log === 'string' && log.includes(d.result.closing_marker),device:intent.body.detail.device_identity_proven === true && intent.body.detail.device_lease_digest === digestOfValue([remoteLease.id,remoteLease.token]),continuity:!drift && !leaseInterrupted});
      return {item:id,reported_terminal:reported,...disposition,...(disposition.dynamic_terminal==='no_verdict'?(!ownership?ownershipFailure:{missing_fact:'动态完整性事实尚不齐全；见 missing_facts 和下一步'}):{}),limits:disposition.qualifier.marks.map(mark=>labelOf('qualifier_mark',mark))};
    });
    const savedLogs = Array.isArray(rows) ? rows.flatMap(row=>[
      ...(d.result.log && typeof at(row,d.result.log)==='string' ? [String(at(row,d.result.log))] : []),
      ...(d.result.sessions && object(at(row,d.result.sessions)) ? Object.values(at(row,d.result.sessions) as Record<string,unknown>).filter((v):v is string=>typeof v==='string') : []),
    ]) : [];
    const sideEffects = d.side_effects.map(declaration=>declaration.marker ? {message:declaration.message,marker_present:savedLogs.some(log=>log.includes(declaration.marker!)),text:savedLogs.some(log=>log.includes(declaration.marker!))?'本次日志里有这一项的标记':'本次日志里没有这一项的标记',reference:response.source,complete,scope:'只核对本次已保存字节中的标记，不推断动作是否发生'} : {message:declaration.message,text:'运行器会这样做（执行器定义声明，Hub 看不见）',provenance:'declared',definition_sha256:digestOfValue(d)});
    const artifact = await this.options.records.artifacts.ingest({ bytes: canonicalBytes({ job: binding.job, sha256: input.sha256, rows: projected, ownership:ownershipObservation, side_effects:sideEffects, executor_declarations: { provenance: 'declared', definition_sha256: digestOfValue(d), operation_definition_sha256:binding.executor_digest, limitations: d.limitations }, lease_drift: drift, lease_interrupted: leaseInterrupted, qualifier_marks:[...DISPATCH_QUALIFICATIONS],limits:DISPATCH_QUALIFICATIONS.map(mark=>labelOf('qualifier_mark',mark)) }), mediaType: 'application/json',
      origin: { generated: { generator: 'dispatch@1', inputs: [response.source, `src:${input.sha256}`] } }, author: { user: null }, provenanceType: 'projected', visibility: { readers: [binding.user], admins: true, packs: [], shareable: false } });
    await this.journal.append(binding, 'result', 'read_back', 'completed', { reference: `src:${artifact.body.sha256}`, items: projected.length, no_verdict: projected.filter(row=>row.dynamic_terminal==='no_verdict').length }, [response.source]);
    await this.release(binding, client, remoteLease);
    const unresolved=projected.filter(row=>row.dynamic_terminal==='no_verdict');
    await this.journal.append(binding, 'complete', 'read_back', 'completed', { done: true, outcome: 'effective',...(unresolved.length?{missing_fact:[...new Set(unresolved.map(row=>'missing_fact' in row?row.missing_fact:'动态完整性事实尚不齐全；见 missing_facts'))].join('；'),next_action:[...new Set(unresolved.map(row=>row.next_action))].join('；')}:{} ) });
    return this.status(by, binding.job);
  }
}
