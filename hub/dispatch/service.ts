import { canonicalBytes, canonicalize, sha256Hex, type ActionBody, type Principal, type RecordsKit } from '../records/api.ts';
import type { LeaseService, HolderSnapshot } from '../leases/api.ts';
import type { WorkflowStore } from '../ports.ts';
import { labelOf, type EffectOutcome, type Disposition, type EffectMark, type RequestKind, type ActionKind, type ActionResult, type LeaseOp, type EffectClass, type RetrySafety, type Signing, isDisposition } from '../../contracts/generated/vocabulary.ts';
import { at, bind, mapped, readDeclaredTime, registrationMissing, type CallRole, type ExecutorDefinition } from './definition.ts';
import { ExecutorRegistry } from './executors.ts';
import { Journal, digestOfValue, eventOf, receiptOf, openRequests, isDone, isFrozen, newJob, type JobBinding, type Event } from './journal.ts';
import { RpcClient, CapabilityPolicyError, InvocationDefinitionError, SubmissionNotSentError, object, type Exchange } from './transport.ts';
import type { BuildKnowledge } from './probes.ts';
import {requestIdentity,sameRequestIdentity} from './request-identity.ts';
import {PrecheckFactError,precheckFailure} from './precheck-failure.ts';
import { canRetryRead } from './read-policy.ts';
import { dynamicDisposition, DISPATCH_QUALIFICATIONS } from './dynamic.ts';
import { verifyInput, lockedBuildBase, InputVerificationError, type VerificationPort } from './proof.ts';
export interface DispatchOptions {
  knowledge?: BuildKnowledge;
  records: RecordsKit; leases: Pick<LeaseService, 'holderSnapshot'>; runs: VerificationPort;
  workflows: Pick<WorkflowStore, 'byDigest'>; close?: () => Promise<void>; now?: () => Date; sleep?: (ms: number) => Promise<void>;
}
export interface JobStatus { failed_checks?:Array<{step:string;seat?:string;check?:string;missing_fact:string;next_action:string}>; failed_conditions?:Array<{pointer:string;operator:string}>; requests?:Array<{id:string;question_sha256:string|null;deadline:string|null}>; marks?:EffectMark[];disposition?:Disposition;decided_by?:string;decided_at?:string; reason?: string; job: string; phase: string; outcome: EffectOutcome; frozen: boolean; result?: string; events: number; next_action?: string; missing_fact?: string; }
interface Heartbeat {stop:()=>Promise<void>;held:()=>boolean;lastConfirmedAt:()=>number|null;}
interface LeaseClock {at:number;mono:number;ttl:number;}
interface RemoteLease { id: unknown; token: unknown; ttl: number; }
const operationDefinition = (d:ExecutorDefinition) => ({target:d.target,endpoint:d.endpoint,ca:d.ca,resources:[...d.resources].sort(),manifest_sha256:d.manifest_sha256,actor_header:d.actor?.header.toLowerCase() ?? null,slot:d.proof.slot,payload_argument:d.payload_argument,submit:{tool:d.calls.submit.tool,arguments:d.calls.submit.arguments}});
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
  readonly sleep: (ms: number) => Promise<void>;
  #leaseClocks = new WeakMap<RemoteLease,LeaseClock>();
  #closing: Promise<void> | null = null;
  constructor(options: DispatchOptions) {
    this.options = options; this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.registry = new ExecutorRegistry(options.records); this.journal = new Journal(options.records, this.now);
  }
  async close(): Promise<void> { await (this.#closing ??= this.options.close?.() ?? Promise.resolve()); }
  async status(by: Principal, job: string): Promise<JobStatus> {
    await this.registry.admin(by); const events = await this.journal.events(job);
    if (!events.length) throw new Error('作业对你不可用');
    const probeIntent=eventOf(events,'probe_intent');
    const missingReceipt = !events.some(e => e.body.detail.done === true && (probeIntent && e.body.detail.effect_accounted===true || ['target_rejected','proven_not_executed'].includes(String(e.body.detail.outcome)) || e.body.detail.outcome==='not_dispatched' && e.body.detail.submit_invoked===false)) && !!(eventOf(events, 'intent') ?? probeIntent) && !receiptOf(events) && !events.some(e => e.body.detail.unfreeze === true);
    const unknown = isFrozen(events); const result = eventOf(events, 'result'); const end = eventOf(events, 'complete');
    const intent = eventOf(events, 'intent'); const receipt = receiptOf(events);
    const uncertainty = [...events].reverse().find(e => e.body.detail.uncertain === true && typeof e.body.detail.missing_fact === 'string');
    const decision=eventOf(events,'dispose');const choice=decision?.body.detail.disposition;
    const riskDisposed=choice==='mark_failed' && decision?.body.detail.risk_confirmed===true;
    const marks:EffectMark[]=decision?.body.detail.effect_mark==='disposed' && (riskDisposed || choice==='reconcile' && decision.body.detail.identity_matched===true)?['disposed']:[];
    const missingFact = riskDisposed ? '原效果是否完成仍未证明；管理员已具名接受风险并完成处置，不把它当作未执行' : unknown || missingReceipt ? String(uncertainty?.body.detail.missing_fact ?? '已写意图但缺少可信提交回执；不能证明未执行') : end?.body.detail.registration_ready === false ? `登记缺事实：${(end.body.detail.registration_missing as string[] ?? []).join('、')}` : typeof end?.body.detail.missing_fact==='string'?end.body.detail.missing_fact:undefined;
    const failedConditions=events.flatMap(e=>Array.isArray(e.body.detail.conditions)?e.body.detail.conditions.filter(object).filter(c=>c.matched===false && typeof c.pointer==='string' && typeof c.operator==='string').map(c=>({pointer:String(c.pointer),operator:String(c.operator)})):[]);
    const failedChecks=precheckIssues(events);
    return { job,...(failedChecks.length?{failed_checks:failedChecks}:{}),...(failedConditions.length?{failed_conditions:failedConditions}:{}),requests:openRequests(events).map(e=>({id:e.digest,question_sha256:typeof e.body.detail.question_sha256==='string'?e.body.detail.question_sha256:null,deadline:typeof e.body.detail.deadline==='string'?e.body.detail.deadline:null})),marks,...(isDisposition(choice)?{disposition:choice}:{}),...(typeof decision?.body.detail.decided_by==='string'?{decided_by:decision.body.detail.decided_by}:{}),...(typeof decision?.body.detail.decided_at==='string'?{decided_at:decision.body.detail.decided_at}:{}), ...(typeof end?.body.detail.public_reason === 'string' ? {reason:end.body.detail.public_reason} : {}), phase: String(events.at(-1)!.body.detail.phase),
      outcome: riskDisposed ? 'unknown' : end?.body.detail.outcome==='not_dispatched' && end.body.detail.submit_invoked===false ? 'not_dispatched' : end && ['target_rejected','proven_not_executed'].includes(String(end.body.detail.outcome)) ? end.body.detail.outcome as EffectOutcome : unknown || missingReceipt || (intent && !receipt) ? 'unknown' : end?.body.detail.outcome === 'not_dispatched' ? 'not_dispatched' : end ? 'effective' : intent ? 'issued' : 'not_dispatched',
      frozen: unknown || missingReceipt, ...(typeof result?.body.detail.reference === 'string' ? { result: result.body.detail.reference } : {}), events: events.length, ...(missingFact ? { missing_fact: missingFact } : {}),
      ...(riskDisposed ? {next_action:'处置已完成，原效果保留未知；后续作业须重新核验与授权，不得将原请求当作未执行重交'} : unknown || missingReceipt ? { next_action: typeof uncertainty?.body.detail.next_action==='string'?uncertainty.body.detail.next_action:`circle-hub job resume ${job}；只读原请求，不重交` } : typeof end?.body.detail.next_action === 'string' ? { next_action: end.body.detail.next_action } : !isDone(events) ? { next_action: `circle-hub job resume ${job}` } : {}) };
  }
  async list(by:Principal,executor:string):Promise<JobStatus[]> {
    await this.registry.admin(by);const current=await this.registry.get(executor);
    if(!current)throw new Error('执行器对你不可用；先用 executor list 核对编号');
    const jobs=await this.journal.blockers(executor,current.definition.target,new URL(current.definition.endpoint).origin,current.definition.resources);
    return Promise.all(jobs.map(job=>this.status(by,job)));
  }
  async precheck(by: Principal, executor: string, booking?: string): Promise<JobStatus> {
    await this.registry.admin(by);
    const registered = await this.registry.get(executor);
    if (!registered?.definition.enabled) throw new Error('执行器不可用或已禁用');
    const d = registered.definition;
    const booked = booking ? await this.options.runs.getRun(by, booking) : null;
    if (booking && !booked) throw new Error('预订运行对你不可用');
    const binding: JobBinding = { job: newJob(), initiated_by: by.id, executor, executor_digest: registered.digest, scope:{target:d.target,origin:new URL(d.endpoint).origin}, target_key: digestOfValue([...d.resources].sort()), input: null,
      user: booked?.run.runner ?? by.id, resources: [], context: { ...d.precheck_context, ...(booked?.run.build ? { build: booked.run.build } : {}), ...(booked && lockedBuildBase(booked.run) ? {build_base:lockedBuildBase(booked.run)} : {}), ...(booked?.run.product ? {product:booked.run.product} : {}), ...(booked?.run.root ? {root:booked.run.root} : {}), target: d.target, ...(d.resources.length ? { seats: d.resources.length } : {}), ...(d.manifest_sha256 ? { manifest_sha256: d.manifest_sha256 } : {}) } };
    await this.journal.append(binding, 'reservation', 'validate', 'completed', { binding, read_only: true });
    const client = this.session(binding, d, await this.secret(executor));
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
    if (!d.conformance || !d.reconciliation || !d.calls.query || !d.receipt.stage || !d.receipt.reached_device) throw new Error('缺少只读查账、拒绝阶段或一致性探测字节声明；请补齐定义');
    const binding: JobBinding = {job:newJob(),initiated_by:by.id,executor,executor_digest:registered.digest,scope:{target:d.target,origin:new URL(d.endpoint).origin},target_key:digestOfValue([...d.resources].sort()),input:null,user:by.id,resources:d.resources,context:d.precheck_context};
    await this.reserve(binding);
    const client = this.session(binding,d,await this.secret(executor));
    let lease: RemoteLease | undefined; const observations: Exchange[] = []; const checks: boolean[] = [];let failure:Record<string,string>|undefined;let ambiguous=false;
    try {
      await client.connect(); lease = await this.acquire(binding,d,client,this.context(binding));
      const context = {...this.context(binding),lease_id:lease.id,lease_token:lease.token,request_id:`${binding.job}:absent`,not_after:new Date(this.now().getTime()-d.conformance.expiry_margin_ms-1000).toISOString(),items:[]};
      const missing = await this.read(binding,client,'query',context); observations.push(missing);
      const r = d.reconciliation;
      const wireTime = (v:unknown) => readDeclaredTime(v,r.time_scale_ms);
      const expectedIdentity=requestIdentity(missing.value,r.identity,r.time_scale_ms);
      checks.push(wireTime(at(missing.value,r.gateway_time))>Date.parse(context.not_after)+d.conformance.expiry_margin_ms && !!expectedIdentity && at(missing.value,r.found) === false && Number.isFinite(wireTime(at(missing.value,r.gateway_time))) && Number.isFinite(wireTime(at(missing.value,r.gc_before))) && wireTime(at(missing.value,r.gc_before))>=expectedIdentity.since);
      if(!checks[0]) {const gaps=[...(at(missing.value,r.found)!==false?['探测编号没有取得查空回答']:[]),...(!expectedIdentity?['缺少日志身份、记账起点或完整主体']:[]),...(!(wireTime(at(missing.value,r.gateway_time))>Date.parse(context.not_after)+d.conformance.expiry_margin_ms)?['目标时刻未越过探测截止及声明余量，不能保证按过期拒收']:[]),...(!Number.isFinite(wireTime(at(missing.value,r.gc_before))) || expectedIdentity && wireTime(at(missing.value,r.gc_before))<expectedIdentity.since?['缺少覆盖记账起点的有效保留边界']:[])];failure={missing_fact:gaps.join('；'),next_action:'管理员先核对目标与 Hub 时钟、时区和日志身份声明，取得越过截止及余量的目标时刻后再运行 conformance；本次未提交'};throw new Error('探测过期前提不成立');}
      context.request_id = `${binding.job}:1`;
      const first = Buffer.from(d.conformance.payloads[0],'base64'); const second = Buffer.from(d.conformance.payloads[1],'base64');
      const refused = (v:unknown) => sameRequestIdentity(expectedIdentity,requestIdentity(v,d.receipt.identity,r.time_scale_ms)) && at(v,d.receipt.stage!) === d.conformance!.expected_stage && mapped(d.receipt.map,at(v,d.receipt.acceptance)) === 'not_accepted' && mapped(d.receipt.stages,at(v,d.receipt.stage!)) === 'target_rejected' && at(v,d.receipt.reached_device!) === false;
      await this.journal.append(binding,'probe_intent','validate','completed',{request_id:context.request_id,not_after:context.not_after,sha256:sha256Hex(first),remote_lease:lease,request_identity:expectedIdentity,request_protocol_version:client.serverVersion,request_protocol_verified:r.protocol_versions.includes(client.serverVersion??'')},[missing.source]);
      for (const payload of [first,second]) {
        await this.journal.append(binding,'probe_attempt','validate','completed',{request_id:context.request_id,sha256:sha256Hex(payload)});
        let reply:Exchange;
        try{reply=await client.call('submit',{...context,payload_base64:payload.toString('base64'),sha256:sha256Hex(payload)});}
        catch(error){checks.push(false);if(error instanceof SubmissionNotSentError || error instanceof InvocationDefinitionError){failure={missing_fact:'探测提交明确没有写出请求字节；未取得协议拒收事实',next_action:'管理员核对本地调用声明和连接后重新采证；本次没有调用效果'};break;}ambiguous=true;break;}
        observations.push(reply);checks.push(refused(reply.value));
        const remoteId=at(reply.value,d.receipt.id);
        const safe=mapped(d.receipt.map,at(reply.value,d.receipt.acceptance))==='not_accepted' && mapped(d.receipt.stages,at(reply.value,d.receipt.stage!))==='target_rejected' && at(reply.value,d.receipt.reached_device!)===false && (remoteId===undefined || remoteId===null) && sameRequestIdentity(expectedIdentity,requestIdentity(reply.value,d.receipt.identity,r.time_scale_ms));
        if(!safe){ambiguous=true;break;}
        if(!checks.at(-1)){failure={missing_fact:'探测虽明确拒收，但没有取得预期受理阶段的过期拒收事实',next_action:'管理员核对拒收阶段原件及映射，确认截止检查位置；不得仅靠重跑补证'};break;}
      }
      if(ambiguous)await this.probeFollowup(by,binding,d,client);
      else if(checks.length===3) {
      const recorded = await this.read(binding,client,'query',context); observations.push(recorded);
      checks.push(sameRequestIdentity(expectedIdentity,requestIdentity(recorded.value,r.identity,r.time_scale_ms)) && at(recorded.value,r.found) === true && at(recorded.value,r.request_id) === context.request_id && at(recorded.value,r.sha256) === sha256Hex(first) && mapped(r.map,at(recorded.value,r.state)) === 'target_rejected' && at(recorded.value,r.reached_device) === false && at(recorded.value,r.stage) === d.conformance.expected_stage && mapped(d.receipt.stages,at(recorded.value,r.stage)) === 'target_rejected');
      }
    } catch { checks.push(false);failure??={missing_fact:'探测所需的连接、租约或请求记录未完整取得；未确认四项协议事实',next_action:'管理员检查受限调用原件、目标连接和租约配置，恢复缺失的读取事实后再采证'}; }
    finally { if (lease) await this.release(binding,client,lease); }
    const init = eventOf(await this.journal.events(binding.job),'initialize.response');
    const artifact = await this.options.records.artifacts.ingest({bytes:canonicalBytes({target:d.target,version:client.serverVersion,checks,sources:observations.map(o=>o.source)}),mediaType:'application/json',origin:{generated:{generator:'dispatch@1',inputs:[...observations.map(o=>o.source),...(init?.body.inputs.filter(r=>r.startsWith('src:')) ?? [])]}},author:{user:null},provenanceType:'projected',visibility:{readers:[by.id],admins:true,packs:[],shareable:false}});
    await this.journal.append(binding,'result','read_back','completed',{reference:`src:${artifact.body.sha256}`,observations:observations.length},observations.map(o=>o.source));
    await this.journal.append(binding,'complete','read_back','completed',{done:!ambiguous,effect_accounted:!ambiguous,outcome:ambiguous?'unknown':'not_dispatched',conformance_verified:!ambiguous && checks.length === 4 && checks.every(Boolean),...(failure??{}),next_action:ambiguous?'探测效果未决；只读核对原请求后由管理员处置，不得重跑 conformance':failure?.next_action ?? (checks.length === 4 && checks.every(Boolean) ? '管理员复核这些源记录后，将目标版本和证据引用登记到执行器前提；不会自动认证' : '一致性探测未取得四项相符事实；管理员核对定义和原始回答后重跑 conformance')});
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
      if(allowResolution && bound && (negative || absent) && await this.certified(binding,d,client,'request_journal')) {
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
    if (registrationMissing(d).length) throw new Error(`派发登记缺事实：${registrationMissing(d).join('、')}；请先 precheck 采证、转换并发布清单，再 update 补齐`);
    const input = await verifyInput(by, run, d, this.options.records, this.options.runs, this.options.workflows, this.now());
    const previous = await this.options.records.store.getByKey('action', `dispatch.bytes:${input.sha256}`);
    const attempts = (await this.options.records.store.findMany<import('../records/api.ts').ActionBody>({ kind: 'action', key: 'dispatch.bytes', values: [input.sha256] })).filter(e => e.body.detail.phase === 'intent');
    if (previous) throw new Error('这份字节已有旧版派发意图；只能查询或对账，不能重交');
    for (const prior of attempts) {
      const priorJob = String(prior.body.detail.job); const priorEvents = await this.journal.events(priorJob);
      const end = eventOf(priorEvents,'complete'); const pinned = await this.journal.binding(priorJob);
      if (!end || isFrozen(priorEvents) || !(['target_rejected','proven_not_executed'].includes(String(end.body.detail.outcome)) || end.body.detail.outcome==='not_dispatched' && end.body.detail.submit_invoked===false) || pinned.input?.run !== input.run || digestOfValue(operationDefinition(await this.pinned(pinned))) !== digestOfValue(operationDefinition(d)) || !same({...pinned.input,result:null},{...input,result:null})) throw new Error(`这份字节已有派发意图；作业摘要 ${priorJob}；只能查询或对账，不能重交`);
    }
    const attempt = attempts.length + 1;
    const source = await this.options.records.artifacts.source({ id: input.user, name: '', role: 'user' }, input.sha256, { consumer: 'function' });
    if (!source?.bytes) throw new Error('核验字节不可读取，未提交');
    const initial = await this.holders(input.ancestors, input.user, d.resources, d.submit_timeout_ms+d.max_run_ms);
    const secret = await this.secret(executor);
    const binding: JobBinding = { job: newJob(), initiated_by: by.id, executor, executor_digest: registered.digest, input, user: input.user, resources: d.resources, fences: initial, scope:{target:d.target,origin:new URL(d.endpoint).origin}, target_key: digestOfValue([...d.resources].sort()) };
    if (JSON.stringify(binding).includes(secret)) throw new Error('绑定元数据不能包含执行器密钥');
    await this.reserve(binding);
    try { onReserved?.(binding.job); } catch { /* A terminal sink never controls an effect already authorized by the command. */ }
    const session = this.session(binding, d, secret);
    let remote: RemoteLease | undefined; let stop = async () => {}; let pulse:Heartbeat|undefined;
    let intended = false;let submitInvoked=false;
    try {
      await session.connect();
      remote = await this.acquire(binding, d, session, this.context(binding));
      pulse = this.heartbeat(binding,d,session,remote);stop=pulse.stop;
      const context: Record<string, unknown> = { ...this.context(binding), lease_id: remote.id, lease_token: remote.token, payload_base64: Buffer.from(source.bytes).toString('base64') };
      const precheck = await this.retryRead(binding, session, 'precheck', context, Infinity);
      if (!await this.assessConditions(binding,d.conditions,precheck,context,'precheck.evaluated')) throw new Error('只读核对未满足；未提交，请核对当前环境后重新核验');
      if (!await this.extraPrechecks(binding, d, session, context, false)) throw new Error('附加只读核对未满足；未提交，请重新核对缓存来源');
      const deviceIdentity = await this.probeSeats(binding,d,session,context);
      if (!deviceIdentity) throw new Error('逐座位只读探测不符；见受限探测原件中的座位及 version/interfaces 核对');
      const latest = await this.registry.get(executor);
      if (!latest?.definition.enabled || latest.digest !== registered.digest) throw new Error('执行器配置已变；未提交，请按当前配置重新核验');
      await this.registry.admin(by);
      const ownerNow = await this.options.records.principals.get(input.user);
      if (!ownerNow || ownerNow.disabled) throw new Error('发起用户已经不可用；未提交');
      const fresh = await this.holders(input.ancestors, input.user, d.resources, d.submit_timeout_ms+d.max_run_ms);
      if (!this.sameFences(initial, fresh)) throw new Error('派发前围栏已变；未提交，请重新证明基线');
      const currentProof = await verifyInput(by,run,d,this.options.records,this.options.runs,this.options.workflows,this.now());
      if(!same({...input,result:null},{...currentProof,result:null}))throw new InputVerificationError('只读核对期间核验数据已改变；请按当前核验结果重新派发，尚未提交');
      const notAfter = new Date(this.now().getTime() + d.submit_timeout_ms).toISOString();
      const sequence = attempts.length ? Number(attempts[0].body.detail.sequence) : (await this.options.records.store.findMany({ kind: 'action', key: 'dispatch.lineage', values: [input.lineage] })).filter(e => (e.body as Record<string, unknown>)?.detail && ((e.body as { detail: Record<string, unknown> }).detail.phase === 'intent')).length + 1;
      const key = attempts.length ? String(attempts[0].body.detail.intent_key) : digestOfValue([input.lineage, input.item, d.proof.slot, sequence]);
      context.request_id = `${key}:${attempt}`; context.not_after = notAfter;
      let requestSnapshot:Record<string,unknown>={};let requestSources:string[]=[];
      if(d.reconciliation) {
        const r=d.reconciliation;
        if(!r.identity || !d.receipt.identity || !session.serverVersion || !r.protocol_versions.includes(session.serverVersion))throw new Error('投递会话版本未登记请求协议支持，或缺少身份字段声明；管理员核对该版本并更新定义后重新派发，尚未提交');
        const response=await this.retryRead(binding,session,'query',context,Infinity);
        const identity=requestIdentity(response.value,r.identity,r.time_scale_ms);
        const clock=readDeclaredTime(at(response.value,r.gateway_time),r.time_scale_ms),floor=readDeclaredTime(at(response.value,r.gc_before),r.time_scale_ms);
        if(at(response.value,r.found)!==false || !identity || !Number.isFinite(clock) || !Number.isFinite(floor) || clock<floor || floor<identity.since)throw new Error('缺少本租约下投递前的可靠请求日志身份、完整主体或记账边界；管理员核对查询原件与声明后重跑预检，尚未提交');
        const initialization=eventOf(await this.journal.events(binding.job),'initialize.response');
        requestSnapshot={request_identity:identity,request_protocol_version:session.serverVersion,request_protocol_verified:true};requestSources=[...new Set([response.source,...(initialization?.body.inputs??[])])];
        await this.journal.append(binding,'request_identity','validate','completed',requestSnapshot,requestSources);
      }
      const intentSemantics:{effect_class:EffectClass;retry_safety:RetrySafety;signing:Signing}={effect_class:'job',retry_safety:d.retry_safety,signing:'service_on_behalf'};
      const precheckSources=[...new Set((await this.journal.events(binding.job)).filter(e=>e.body.detail.phase==='precheck.evaluated' || /^precheck\.[0-9]+$/.test(String(e.body.detail.phase)) || e.body.detail.phase==='device_probe').flatMap(e=>e.body.inputs))];
      const actionDigest = digestOfValue({ content: input.sha256, tool: d.calls.submit.tool, arguments: session.prepareSubmit(context) });
      if(!pulse.held())throw new Error('目标租约中断或近期确认已过期；恢复租约后重新预检，尚未提交');
      await this.options.records.store.withTransaction(async tx => {
        const gate = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: true }, [], `dispatch.gate:${binding.job}`, tx);
        if (!gate.created) throw new Error('作业已经恢复或关闭，不能再提交');
        const ordinal = attempt === 1 ? await this.journal.append(binding, 'sequence', 'validate', 'completed', { sequence }, [], `dispatch.sequence:${input.lineage}:${sequence}`, tx) : { created: true };
        if (!ordinal.created) throw new Error('血缘次序已由另一派发占用；未提交');
        const intent = await this.journal.append(binding, 'intent', 'validate', 'completed', { intent_key: key, verification_result:currentProof.result, request_id: context.request_id, ...requestSnapshot, device_identity_proven: !!d.probes && deviceIdentity, device_lease_digest: digestOfValue([context.lease_id,context.lease_token]), attempt, not_after: notAfter, sequence, action_digest: actionDigest,
          dispatch_binding_digest: digestOfValue([input.run, input.item, input.sha256, fresh, remote]), target_key: binding.target_key, ...intentSemantics, on_behalf_of: input.user,
          before_state_bound: false, fences: fresh, remote_lease: remote, window: { from: this.now().toISOString(), to: notAfter } }, [`src:${input.sha256}`, `rec:${currentProof.result}`,...precheckSources,...requestSources], `dispatch.bytes:${input.sha256}:${attempt}`, tx);
        if (!intent.created) throw new Error('这份字节已经写过意图；未重复提交');
      });
      intended = true;
      if (this.now().getTime() >= Date.parse(notAfter)) { await this.notSent(binding,session,remote,stop,'意图后派发窗口已过，尚未调用提交');return this.status(by,binding.job); }
      if (!this.sameFences(fresh, await this.options.leases.holderSnapshot(d.resources))) { await this.notSent(binding,session,remote,stop,'意图后围栏改变，尚未调用提交');return this.status(by,binding.job); }
      if(!pulse.held() || this.now().getTime()>=Date.parse(notAfter)) { await stop();await this.release(binding,session,remote);await this.journal.append(binding,'complete','validate','completed',{done:true,outcome:'not_dispatched',submit_invoked:false,public_reason:'目标租约确认失效，尚未调用提交',next_action:'恢复目标租约后重新预检与派发'});return this.status(by,binding.job); }
      // Signals must not cancel an in-flight effect; SIGKILL is recovered from the already committed intent.
      const ignore = () => {}; process.on('SIGINT', ignore); process.on('SIGTERM', ignore); process.on('SIGHUP',ignore);
      let answer: Exchange;
      try { submitInvoked=true;answer = await session.call('submit', context,Math.max(1,Date.parse(notAfter)-this.now().getTime())); } finally { process.off('SIGINT', ignore); process.off('SIGTERM', ignore); process.off('SIGHUP',ignore); }
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
      if (intended || eventOf(await this.journal.events(binding.job), 'intent')) {
        if((!submitInvoked || error instanceof SubmissionNotSentError || error instanceof InvocationDefinitionError) && remote) {await this.notSent(binding,session,remote,stop,'当前进程证明未调用提交或未写出请求字节',error instanceof SubmissionNotSentError?[error.source]:[]);return this.status(by,binding.job);}
        if (receiptOf(await this.journal.events(binding.job))) await this.pendingRead(binding);
        else if (d.reconciliation && d.calls.query) return await this.reconcileRequest(by,binding,d,session,stop);
        else await this.unknown(binding, '提交未取得完整可信回执；缺远端作业身份或结果，必须管理员对账');
      }
      else {
        await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', ...(error instanceof CapabilityPolicyError || error instanceof InvocationDefinitionError || error instanceof InputVerificationError ? {public_reason:error.message} : {}), reason: session.redact(error instanceof Error ? error.message.toWellFormed().slice(0, 1000) : '前提核对出错'), next_action: '核对只读条件、租约和执行器定义后重新核验；没有提交' });
        if (remote) await this.release(binding, session, remote);
      }
      return await this.status(by, binding.job);
    } finally { await stop(); }
  }
  async resume(by: Principal, job: string): Promise<JobStatus> {
    await this.registry.admin(by);
    const binding = { ...await this.journal.binding(job), acting_by: by.id }; const events = await this.journal.events(job);
    if (isDone(events) && !isFrozen(events)) return this.status(by, job);
    if(eventOf(events,'probe_intent')) {const d=await this.readingDefinition(binding);const client=this.session(binding,d,await this.secret(binding.executor));await client.connect();await this.probeFollowup(by,binding,d,client,true);return this.status(by,job);}
    const intent = eventOf(events, 'intent'); const receipt = receiptOf(events);
    if (!intent) {
      const gate = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: false }, [], `dispatch.gate:${job}`);
      if (!gate.created && gate.body.detail.allow_submit === true) { await this.unknown(binding, '派发可能正在进行；没有完整回执，不能重交'); return this.status(by, job); }
      await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', next_action: '从未写入派发意图，必要时重新核对后派发' });
      return this.status(by, job);
    }
    const d = await this.readingDefinition(binding);
    if ((!receipt || isFrozen(events)) && (!d.reconciliation || !d.calls.query)) { await this.unknown(binding, '有意图但无完整可信回执或仍被冻结；下一步由管理员对账'); return this.status(by, job); }
    const client = this.session(binding, d, await this.secret(binding.executor));
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
      const secret = await this.options.records.vault.getText(`executor.${binding.executor}.bearer`);
      const reason = secret ? options.reason.split(secret).join('[已隐藏]') : options.reason;
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
    if (options.choice !== 'reconcile' || remoteId === undefined) throw new Error('本轮只允许核对、保持未知或标记失败；核对必须给远端编号');
    const d = await this.readingDefinition(binding); const client = this.session(binding, d, await this.secret(binding.executor));
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
    const certified = await this.certified(binding,d,client,'request_journal');
    if (found === true && identity && reported === 'target_rejected') {
      const remapped = {...d,receipt:{...d.receipt,identity:r.identity,stage:r.stage,reached_device:r.reached_device}};
      if (await this.refused(binding,remapped,client,response,lease)) return this.status(by,binding.job);
    }
    const time = (v: unknown) => readDeclaredTime(v,r.time_scale_ms);
    const clock = time(at(value,r.gateway_time)), floor = time(at(value,r.gc_before));
    const currentIdentity=requestIdentity(value,r.identity,r.time_scale_ms);
    const originalProtocol=intent.body.detail.request_protocol_verified===true && typeof intent.body.detail.request_protocol_version==='string';
    const identityBound=originalProtocol && sameRequestIdentity(intent.body.detail.request_identity,currentIdentity);
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
    if(!certified)missing.push('当前目标版本的请求记录前提未认证');
    await this.unknown(binding,missing.join('；') || '缺少可终结原请求的执行记录，请核对状态映射与原件',[response.source],{next_action:!identityBound?`请管理员 ${binding.acting_by ?? binding.initiated_by} 人工核对原投递事实、原日志和发送会话版本；不得重交`:!certified?`请管理员 ${binding.acting_by ?? binding.initiated_by} 运行 circle-hub job conformance --executor ${binding.executor} 采证并登记目标版本，再运行 circle-hub job resume ${binding.job}`:`请管理员 ${binding.acting_by ?? binding.initiated_by} 核对本次查账原件和字段映射，修复后运行 circle-hub job resume ${binding.job}；不得重交`});
    return this.status(by,binding.job);
  }

  private async certified(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, premise: keyof ExecutorDefinition['premises']): Promise<boolean> {
    const current = await this.registry.get(binding.executor);
    if (!current || current.definition.target !== d.target || current.definition.endpoint !== d.endpoint || current.definition.ca !== d.ca) return false;
    const proof = current.definition.premises[premise];
    if (!proof || proof.version !== client.serverVersion) return false;
    const by = await this.options.records.principals.get(binding.acting_by ?? binding.initiated_by);
    if (!by || by.disabled) return false;
    for (const ref of proof.evidence) {
      try { const source = await this.options.records.artifacts.source(by,ref.slice(4),{consumer:'function'});
        if (!source?.bytes || sha256Hex(source.bytes) !== ref.slice(4)) return false;
      } catch { return false; }
    }
    const init=eventOf(await this.journal.events(binding.job),'initialize.response');
    await this.journal.append(binding,'premise','validate','completed',{premise,version:client.serverVersion,definition_sha256:current.digest,certified:true},[...proof.evidence,...(init?.body.inputs ?? [])]);
    return true;
  }
  private async refused(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, answer: Exchange, lease: RemoteLease): Promise<boolean> {
    if (mapped(d.receipt.map,at(answer.value,d.receipt.acceptance)) !== 'not_accepted' || !d.receipt.stage || !d.receipt.reached_device || mapped(d.receipt.stages,at(answer.value,d.receipt.stage)) !== 'target_rejected' || at(answer.value,d.receipt.reached_device) !== false || !await this.certified(binding,d,client,'request_journal')) return false;
    await this.answerRequests(binding,'rejection','read_back','completed',{outcome:'target_rejected',acceptance:'not_accepted',stage:at(answer.value,d.receipt.stage),reached_device:false,unfreeze:true},[answer.source]);
    await this.release(binding,client,lease);
    await this.answerRequests(binding,'complete','read_back','completed',{done:true,outcome:'target_rejected',unfreeze:true,next_action:'按拒绝阶段补齐事实后，可用新的请求尝试派发；不要重发原请求'});
    return true;
  }

  private async reserve(binding: JobBinding): Promise<void> {
    const definition=await this.pinned(binding);
    // Read the CAS heads before checking occupancy. A reservation committed during
    // that check must either be observed as a blocker or invalidate our CAS head.
    const history=await this.options.records.store.findMany<ActionBody>({kind:'action',key:'dispatch.phase',values:['reservation']});
    const blocked=await this.journal.blockers(binding.executor,definition.target,new URL(definition.endpoint).origin,binding.resources);
    if(blocked.length){const actions=await Promise.all(blocked.map(async job=>isFrozen(await this.journal.events(job))?`circle-hub job dispose ${job} --reconcile <原远端编号>`:`circle-hub job resume ${job}`));throw new Error(`物理目标被作业 ${blocked.join('、')} 占用；下一步：${actions.join('；')}`);}
    const resources = binding.resources.map(r => sha256Hex(r)).sort();
    const identities=[['executor',binding.executor],['target',definition.target],['origin',new URL(definition.endpoint).origin]].map(digestOfValue).sort();
    await this.options.records.store.withTransaction(async tx => {
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
    if (rows.length !== keys.length || rows.some(r => r.released || r.user !== user || !ancestors.includes(r.run) || Date.parse(r.expires_at) <= this.now().getTime() + requiredMs)) throw new Error('血缘不持有全部物理资源，或租约到期早于最长运行时间；请重新预订后核验');
    return rows;
  }
  private sameFences(before: readonly HolderSnapshot[], after: readonly HolderSnapshot[]): boolean {
    return before.length === after.length && before.every(a => after.some(b => a.key === b.key && a.lease === b.lease && b.fencing >= a.fencing && !b.released && Date.parse(b.expires_at) > this.now().getTime()));
  }
  private async secret(id: string): Promise<string> { const secret = await this.options.records.vault.getText(`executor.${id}.bearer`); if (!secret) throw new Error('执行器密钥不可用'); return secret; }
  private async pinned(binding: JobBinding): Promise<ExecutorDefinition> {
    const bytes = await this.options.records.objects.get(binding.executor_digest);
    if (!bytes) throw new Error('冻结的执行器定义缺失');
    const { ExecutorDefinition: schema } = await import('./definition.ts'); return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }
  private async readingDefinition(binding:JobBinding):Promise<ExecutorDefinition> {
    const pinned=await this.pinned(binding);const current=await this.registry.get(binding.executor);
    if(!current || !same(operationDefinition(pinned),operationDefinition(current.definition)))return pinned;
    const auth=await this.options.records.authorizations.resourceConfig(`executor.${binding.executor}`);
    await this.journal.append(binding,'reading_definition','validate','completed',{operation_definition_sha256:binding.executor_digest,reading_definition_sha256:current.digest},auth?[`rec:${auth.digest}`]:[]);
    return current.definition;
  }
  private context(binding: JobBinding): Record<string, unknown> { return { ...binding.context, job: binding.job, user: binding.user, actor: binding.acting_by ?? binding.initiated_by, build_base:binding.input?.build_base ?? binding.context?.build_base, product:binding.input?.product ?? binding.context?.product, root:binding.input?.root ?? binding.context?.root, target: binding.input?.target ?? binding.context?.target, build: binding.input?.build ?? binding.context?.build, sha256: binding.input?.sha256, items: binding.input?.items, seats: binding.context?.seats ?? (binding.resources.length ? binding.resources.length : undefined), manifest_sha256: binding.input?.manifest_sha256 ?? binding.context?.manifest_sha256 }; }
  private session(binding: JobBinding, d: ExecutorDefinition, secret: string): RpcClient {
    return new RpcClient(d, secret, `${binding.user}/${binding.job}`, async (bytes, status, operation, complete = true, metadata) => {
      const captured = await this.journal.raw(binding, bytes, operation, complete);
      const source = captured.reference;
      const op:LeaseOp|undefined=operation==='acquire'?'acquire':operation==='heartbeat'?'extend':operation==='release'?'release':undefined;
      await this.journal.append(binding, `${operation}.response`, op?'lease':operation === 'submit' ? 'dispatch' : 'read', complete ? 'completed' : operation==='submit' ? 'unknown' : 'error', { ...(op?{op}:{}),http_status: status, complete, source_record: captured.record, ...metadata }, [source, captured.record]);
      return source;
    }, this.now);
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
        drift = true; await this.journal.append(binding, 'fencing', 'validate', 'completed', { drift: true,missing_fact:'同一 Hub 租约连续性未证明',next_action:'复用前重新证明基线；当前只读原作业，不重交',expired:observedHolders.some(row=>Date.parse(row.expires_at)<=this.now().getTime()), note: '派发后租约到期或围栏改变，不能声称保持同一租约；继续只读状态' });
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
      drift = true; await this.journal.append(binding, 'fencing', 'validate', 'completed', { drift: true,missing_fact:'同一 Hub 租约连续性未证明',next_action:'复用前重新证明基线；当前只读原作业，不重交',expired:finalHolders.some(row=>Date.parse(row.expires_at)<=this.now().getTime()), note: '结果读取期间租约到期或围栏改变，不能声称保持同一租约' });
    }
    await stopHeartbeat();
    const leaseInterrupted = (await this.journal.events(binding.job)).some(e => e.body.detail.lease_interrupted === true);
    const ownershipCertified = await this.certified(binding,d,client,'result_ownership');
    const attribution=d.result.ownership;
    const ownershipReported=attribution?at(response.value,attribution.pointer):undefined;
    const ownershipReason=attribution?at(response.value,attribution.reason):undefined;
    const ownership=ownershipCertified && !!attribution && ownershipReported===attribution.value;
    const ownershipObservation={certified:ownershipCertified,matched:ownership,reported:typeof ownershipReported==='string'?ownershipReported:null,reason:typeof ownershipReason==='string'?ownershipReason:null};
    const projected = input.items.map(id => {
      const found = Array.isArray(rows) ? rows.filter(r => at(r, d.result.item_id) === id) : [];
      const reported = complete && found.length === 1 ? mapped(d.result.map, at(found[0], d.result.item_outcome)) ?? null : null;
      const row = found.length === 1 ? found[0] : null;
      const log = d.result.log ? at(row,d.result.log) : undefined;
      const disposition = dynamicDisposition(reported,{owned:ownership,request:!!d.result.request_id && at(response.value,d.result.request_id) === intent.body.detail.request_id,remote:same(at(response.value,d.result.id),remoteId),digest:at(response.value,d.result.sha256) === input.sha256,complete:complete && Array.isArray(rows) && rows.length === input.items.length,unique:found.length === 1,closed:!!d.result.closing_marker && typeof log === 'string' && log.includes(d.result.closing_marker),device:intent.body.detail.device_identity_proven === true && intent.body.detail.device_lease_digest === digestOfValue([remoteLease.id,remoteLease.token]),continuity:!drift && !leaseInterrupted});
      return {item:id,reported_terminal:reported,...disposition,...(disposition.dynamic_terminal==='no_verdict'?{missing_fact:!ownership?'本结果没有取得已认证的唯一派发归属事实；该值只转述目标报告':'动态完整性事实尚不齐全；见 missing_facts 和下一步',...(!ownership?{next_action:`请管理员 ${binding.acting_by ?? binding.initiated_by} 检查原派发日志、收集器目录和保留证据，恢复唯一归属并认证后重读原作业；该版本缺归属能力时明确登记能力缺口，不以重复读取代替恢复；不得重交`}:{})}:{}),limits:disposition.qualifier.marks.map(mark=>labelOf('qualifier_mark',mark))};
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
    await this.journal.append(binding, 'complete', 'read_back', 'completed', { done: true, outcome: 'effective' });
    return this.status(by, binding.job);
  }
}
