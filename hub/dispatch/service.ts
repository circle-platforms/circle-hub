import { isAdmin } from '../records/api.ts';
import type { Heartbeat, LeaseClock, RemoteLease } from './session-types.ts';
import * as bedOperations from './bed-lifecycle.ts';
import * as deviceOperations from './devices.ts';
import * as baselineOperations from './baselines.ts';
import { environmentOf, runBound } from './precheck-context.ts';
import { reportOutcome } from './report-outcome.ts';
import { REPORT_READ_ATTEMPTS, REPORT_READ_WINDOW_MS, reportPending, reportReadDelay, trustedStatus } from './report-read.ts';
import { releaseDigest, releaseField, releaseFailure, type ReleaseCheck } from './release-diagnostics.ts';
import { formatReleaseRefusal } from './refusal-text.ts';
import { readConditionFact } from './reasons.ts';
import type { AdminLogEntry } from '../runs/api.ts';
import { RETRY_RULES } from './retry-policy.ts';
import { prepareEffectGate, EffectBoundaryError } from './effect-gate.ts';
import { checkEffectBoundary, incompleteEffectBoundary, deny, refusalText, type BoundaryFailure } from './boundary.ts';
import { verifiedContent } from './content.ts';
import { WHOLE_HUB, canonicalBytes, canonicalize, sha256Hex, type AuthorizationRecord, type ActionBody, type ArtifactSource, type Principal, type RecordsKit, type Transaction } from '../records/api.ts';
import type { LeaseService, HolderSnapshot } from '../leases/api.ts';
import type { WorkflowStore } from '../ports.ts';
import { labelOf, isCallErrorCategory, type CallErrorCategory, type EffectOutcome, type Disposition, type EffectMark, type QualifierMark, type RequestKind, type ActionKind, type ActionResult, type LeaseOp, type EffectClass, type RetrySafety, type Signing, type DynamicTerminal, type Reason, isDisposition, isEffectOutcome, isDynamicTerminal } from '../../contracts/generated/vocabulary.ts';
import { at, bind, mapped, registrationMissing, type CallRole, type ExecutorDefinition } from './definition.ts';
import { Redactor } from '../connectors/api.ts';
import { background } from '../telemetry/api.ts';
import { resolveExecutor } from './source.ts';
import { ExecutorRegistry, ExecutorAccessError, lockExecutorConfiguration, containsSecret, type RegisteredExecutor } from './executors.ts';
import { Journal, digestOfValue, eventOf, receiptOf, openRequests, isDone, isFrozen, newJob, type JobBinding, type Event } from './journal.ts';
import { RpcClient, CapabilityPolicyError, HttpReplyError, IncompleteReplyError, InvocationDefinitionError, ResponseStorageError, RpcReplyError, SubmissionNotSentError, ToolReplyError, object, type Exchange } from './transport.ts';
import { type BuildKnowledge, type SeatEcho } from './probes.ts';
import { leaseGeneration, leasesLive } from './probe-replay.ts';
import { DeviceObservation, type DeviceHelpResult, type DeviceHelpTarget } from '../../contracts/src/pack.ts';
import { type AskedLine } from './help.ts';
import { requestIdentity, sameRequestIdentity } from './request-identity.ts';
import { PrecheckFactError, precheckFailure } from './precheck-failure.ts';
import { canRetryRead } from './read-policy.ts';
import { bindingRun, NEWEST_PAGE_SIZE, reportedVersion, scanNewest, type EnvironmentJob, type EnvironmentFacts } from './environment.ts';
import { dynamicDisposition, DISPATCH_QUALIFICATIONS, missingOwnershipCertification, ownershipUnmet, unmetPremises } from './dynamic.ts';

import { type BedBaselineRecord, type BedRead, type BedReport, type Canonical } from './bed-state.ts';
import { bytesKey, earlyStopSentence, repeats, roundAllowed, roundMeets, roundOf, roundPolicy, type RoundPolicy } from './rounds.ts';
import { expectationFor } from '../runs/engine/terminals.ts';
import { RunId, Sha256 } from '../../contracts/src/common.ts';
import { verifyInput, inspectInput, lockedBuildBase, InputVerificationError, type VerificationPort, type VerifiedInput } from './proof.ts';

/** Only validated generated outcomes can prove a submission retry is safe. */
function retrySafeOutcome(value:unknown):boolean {
  if(!isEffectOutcome(value))return false;
  const outcome:EffectOutcome=value;
  return outcome==='target_rejected'||outcome==='proven_not_executed';
}
const projectedResult=(events:readonly Event[])=>{const intent=events.findLastIndex(event=>event.body.detail.phase==='intent'||event.body.detail.phase==='probe_intent');return events.findLast((event,index)=>index>intent&&event.body.detail.phase==='result'&&typeof event.body.detail.reference==='string');};
const roundRecords=(events:readonly Event[])=>[...new Map(events.filter(event=>event.body.detail.phase==='round'&&typeof event.body.detail.round==='number').map(event=>[Number(event.body.detail.round),event])).values()];
export interface DispatchOptions {
  adminLog?:(entry:AdminLogEntry)=>void;
  recheckChecks?:import('../ports.ts').EffectCheckReplay;
  redactor?:Redactor;
  knowledge?: BuildKnowledge;
  records: RecordsKit; leases: Pick<LeaseService, 'holderSnapshot' | 'withMutationLock'>; runs: VerificationPort;
  /** Explicit staged policy switch. Only true enables the new environment-assignment guard. */
  enforceEnvironmentAssignments?: boolean;
  environmentAccess?: { canUse(actor: Principal, executor: string): Promise<boolean>; permission(actor: Principal, executor: string, tx: Transaction): Promise<boolean> };
  workflows: Pick<WorkflowStore, 'byDigest'>; close?: () => Promise<void>; now?: () => Date; sleep?: (ms: number) => Promise<void>;
  /** Test seam: called before a later round is opened. Production leaves it unset. */
  beforeRound?: (round: number) => Promise<void>;
}
interface BookingDiagnosis {
  target:string;
  coverage_complete:boolean|null;
  required_resources:number;
  missing_resources:number|null;
  /** A count of distinct declared device pointers, not an observation of actual devices. */
  declared_device_count:number|null;
}
export interface JobStatus { call_error_category?:CallErrorCategory|null; submission_verified?:boolean; booking?:BookingDiagnosis; error_code?:ActionBody['error_code']; member_missing_facts?:Array<{fact:string;next_action:string}>;/** The source holding what the target returned, word for word: see deviceReturn. */device_return?:string;/** The request id of the submit intent (issue 142): what the Hub asks the target about when no answer came. */request_id?:string;/** The stage at which the target refused, as the target names it, when the refusal is certified. */rejection_stage?:string;/** Ended before the submit was called: nothing was sent, and the cause may pass. */not_sent?:boolean;report_pending?:boolean;qualifier_marks?:QualifierMark[]; admin_release?:ReleaseCheck[];admin_release_missing?:boolean; unprobed_devices?:Array<{index:number;type:string|null}>; unjudged?:Array<{step:string;seat?:string;check?:string;pointer?:string}>; failed_checks?:Array<{step:string;seat?:string;check?:string;missing_fact:string;next_action:string}>; failed_conditions?:Array<{pointer:string;operator:string}>; requests?:Array<{id:string;question_sha256:string|null;deadline:string|null}>; marks?:EffectMark[];disposition?:Disposition;decided_by?:string;decided_at?:string; rounds?: Array<{ round: number; terminal: DynamicTerminal; reason?: Reason }>; reason?: string; job: string; phase: string; outcome: EffectOutcome; frozen: boolean; result?: string; events: number; next_action?: string; missing_fact?: string; }
/** One piece of what the target returned for a row; text is null when the credential scan holds it back. */
interface ReturnedPiece {name:string;text:string|null;}
interface ExecutionReadback {continuity:boolean;drift?:boolean;lease_interrupted?:boolean;intent:string}
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
/** What a precheck without a run's locked build only recorded: each seat's version report and the conditions bound to the build. */
function precheckUnjudged(events:readonly Event[]):NonNullable<JobStatus['unjudged']> {
  return events.flatMap((e):NonNullable<JobStatus['unjudged']>=>{
    const d=e.body.detail;
    if(d.phase==='device_probe' && d.judged===false)return [{step:'device_probe',...(typeof d.seat==='string'?{seat:d.seat}:{}),...(typeof d.check==='string'?{check:d.check}:{})}];
    if((d.phase==='precheck.evaluated' || /^precheck\.[0-9]+$/.test(String(d.phase))) && Array.isArray(d.conditions))return (d.conditions as Array<Record<string,unknown>|null>).filter(c=>c?.judged===false && typeof c.pointer==='string').map(c=>({step:String(d.phase),pointer:String(c!.pointer)}));
    return [];
  });
}
/** The physical resources a run's lineage does not hold for the whole dispatch window; the refusal names them (the reference compile skill reports a
 * failed bed check as it is). */
class LeaseCoverageError extends Error {
  missing: string[];
  occupied: boolean;
  expired: boolean;
  constructor(missing: string[], occupied: boolean, expired: boolean) { super('血缘不持有全部物理资源，或租约到期早于最长运行时间；请重新预订后核验'); this.missing = missing; this.occupied = occupied; this.expired = expired; }
}
/** Another job holds the physical target. The message names the jobs and the administrator's commands (the CLI shows it);
 * the Hub's own dispatch tells the runner only that the target is occupied, since those jobs may be other users'. */
/** The target did not grant its lease: nothing was submitted. */
export class TargetLeaseError extends Error { constructor(){super('目标租约未取得，未提交');} }
/**
 * What the runner is told when nothing was sent (issue 142): the kind of the cause, in the Hub's own fixed words. The
 * target's text, its address and the error's detail stay in the administrator's `reason`.
 */
function notSentReason(error:unknown):string|undefined {
  if(error instanceof TargetLeaseError)return '目标环境没有给出租约，可能正被占用';
  if(error instanceof IncompleteReplyError)return '目标没有给出完整应答：连不上、超时或应答超限';
  if(error instanceof HttpReplyError)return `目标的 HTTP 应答不成功（状态码 ${error.status}）`;
  if(error instanceof RpcReplyError)return '目标的应答不符合约定的协议';
  if(error instanceof ToolReplyError)return '目标拒绝了提交之前的调用（取得租约或只读核对）';
  if(error instanceof ResponseStorageError)return 'Hub 没能保存目标的应答';
  return undefined;
}
export class TargetOccupiedError extends Error {
  readonly jobs: readonly string[];
  constructor(jobs: readonly string[], message: string) { super(message); this.jobs = jobs; }
}
/** The at-most-once guard (V07): these bytes were already dispatched by `job`; `ended` when that job reached its end. */
export class AlreadyDispatchedError extends Error {
  readonly job: string;
  readonly ended: boolean;
  constructor(job: string, ended: boolean, message: string) { super(message); this.job = job; this.ended = ended; }
}
/** All applicable release checks from one explanation (rows that apply plus top-level checks). */
function releaseChecksOf(explanation: { checks: ReleaseCheck[]; rows: Array<{ applicable: boolean; checks: ReleaseCheck[] }> }): ReleaseCheck[] {
  return [...explanation.checks, ...explanation.rows.filter((row) => row.applicable).flatMap((row) => row.checks)];
}
/** Labels for the operator log only (may include unchecked); reader wording uses formatReleaseRefusal. */
function unmetReleaseLabels(explanation: { checks: ReleaseCheck[]; rows: Array<{ applicable: boolean; checks: ReleaseCheck[] }> }): string[] {
  return [...new Set(releaseChecksOf(explanation).filter((check) => check.satisfied !== true).map((check) => check.label))];
}
export class DispatchService {
  readonly options: DispatchOptions;
  readonly registry: ExecutorRegistry;
  readonly journal: Journal;
  readonly now: () => Date;
  readonly redactor:Redactor;
  readonly sleep: (ms: number) => Promise<void>;
  #leaseClocks = new WeakMap<RemoteLease,LeaseClock>();
  #asking = new Map<string, Promise<void>>();
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
    if (!events.length) throw new Error('作业对当前账户不可用');
    const modelPremises=(events.find(event=>event.body.detail.phase==='reservation')?.body.detail.binding as JobBinding|undefined)?.input?.judgments;
    const probeIntent=eventOf(events,'probe_intent');
    const missingReceipt = !events.some(e => e.body.detail.done === true && (probeIntent && e.body.detail.effect_accounted===true || retrySafeOutcome(e.body.detail.outcome) || e.body.detail.outcome==='not_dispatched' && e.body.detail.submit_invoked===false)) && !!(eventOf(events, 'intent') ?? probeIntent) && !receiptOf(events) && !events.some(e => e.body.detail.unfreeze === true);
    const unknown = isFrozen(events); const result = projectedResult(events); const end = eventOf(events, 'complete')??eventOf(events,'boundary_refused');
    const intent = eventOf(events, 'intent'); const receipt = receiptOf(events);
    // The stage word of a certified rejection is the target's own: handed on only when it is a short plain word.
    const stage=[...events].reverse().find(e=>e.body.detail.phase==='rejection')?.body.detail.stage;
    const rejectionStage=typeof stage==='string'&&/^[\p{L}\p{N}_. -]{1,64}$/u.test(stage)?stage:undefined;
    const uncertainty = [...events].reverse().find(e => e.body.detail.uncertain === true && typeof e.body.detail.missing_fact === 'string');
    const decision=eventOf(events,'dispose');const choice=decision?.body.detail.disposition;
    const riskDisposed=choice==='mark_failed' && decision?.body.detail.risk_confirmed===true;
    const marks:EffectMark[]=decision?.body.detail.effect_mark==='disposed' && (riskDisposed || choice==='reconcile' && decision.body.detail.identity_matched===true)?['disposed']:[];
    const waitingReport=projectedResult(events)?.body.detail.report_pending===true;
    const missingFact = waitingReport&&!unknown&&!missingReceipt?(typeof end?.body.detail.missing_fact==='string'?end.body.detail.missing_fact:'原请求执行已结束，完整报告仍待补齐；不是未执行'):riskDisposed ? '原效果是否完成仍未证明；管理员已具名接受风险并完成处置，不把它当作未执行' : unknown || missingReceipt ? String(uncertainty?.body.detail.missing_fact ?? '已写意图但缺少可信提交回执；不能证明未执行') : end?.body.detail.registration_ready === false ? `登记缺事实：${(end.body.detail.registration_missing as string[] ?? []).join('、')}` : typeof end?.body.detail.missing_fact==='string'?end.body.detail.missing_fact:undefined;
    const failedConditions=events.flatMap(e=>Array.isArray(e.body.detail.conditions)?e.body.detail.conditions.filter(object).filter(c=>c.matched===false && typeof c.pointer==='string' && typeof c.operator==='string').map(c=>({pointer:String(c.pointer),operator:String(c.operator)})):[]);
    const lastCredential=[...events].reverse().find(e=>e.body.detail.phase==='session_unavailable'||e.body.detail.phase==='credential_used');
    const gap=!riskDisposed&&lastCredential?.body.detail.phase==='session_unavailable'?lastCredential.body.detail:undefined;
    const failedChecks=precheckIssues(events),unjudged=precheckUnjudged(events);
    const rawBooking=end?.body.detail.booking;
    const booking=object(rawBooking)&&typeof rawBooking.target==='string'&&
      (rawBooking.coverage_complete===false||rawBooking.coverage_complete===null)&&typeof rawBooking.required_resources==='number'&&
      (typeof rawBooking.missing_resources==='number'||rawBooking.missing_resources===null)&&
      (typeof rawBooking.declared_device_count==='number'||rawBooking.declared_device_count===null)?{
        target:rawBooking.target,coverage_complete:rawBooking.coverage_complete,required_resources:rawBooking.required_resources,
        missing_resources:rawBooking.missing_resources,declared_device_count:rawBooking.declared_device_count,
      }:undefined;

    const ownershipPremise=[...events].reverse().find(event=>event.body.detail.phase==='premise'&&event.body.detail.premise==='result_ownership');
    const latestMemberFailure=[...events].reverse().find(event=>Array.isArray(event.body.detail.member_missing_facts)&&event.body.detail.member_missing_facts.length>0&&event.body.detail.phase!=='premise');
    const memberDetails=[...(Array.isArray(end?.body.detail.member_missing_facts)&&end.body.detail.member_missing_facts.length?end.body.detail.member_missing_facts:latestMemberFailure?.body.detail.member_missing_facts as unknown[]??[]),
      ...(ownershipPremise?.body.detail.certified===false&&Array.isArray(ownershipPremise.body.detail.member_missing_facts)?ownershipPremise.body.detail.member_missing_facts:[])];
    const memberFacts=memberDetails.filter(object).filter(fact=>typeof fact.fact==='string'&&typeof fact.next_action==='string').map(fact=>({fact:String(fact.fact),next_action:String(fact.next_action)}));
    // Manifest devices that are not declared dispatch targets: listed by manifest position and declared type, never probed
    // and never dispatched to (P07 R[1], C07 R[4]).
    const unprobed=[...events].reverse().find(e=>Array.isArray(e.body.detail.unprobed_non_targets))?.body.detail.unprobed_non_targets as Array<{index:number;type:string|null}>|undefined;
    let adminRelease:ReleaseCheck[]|undefined,adminReleaseMissing=false;
    const pendingReport=projectedResult(events)?.body.detail.report_pending===true;
    const note=end?.body.detail.admin_release_sha256;
    if(typeof note==='string'){try{const bytes=await this.options.records.objects.get(note);if(!bytes||sha256Hex(bytes)!==note)throw new Error('missing');adminRelease=JSON.parse(new TextDecoder().decode(bytes)).checks;}catch{adminReleaseMissing=true;}}
    if(end?.body.detail.admin_release_missing===true)adminReleaseMissing=true;
    const roundRefusal=[...events].reverse().find(event=>event.body.detail.phase==='round'&&event.body.detail.not_started===true&&event.body.error_code);
    const rounds=roundRecords(events).filter(e=>typeof e.body.detail.terminal==='string').map(e=>({round:Number(e.body.detail.round),terminal:e.body.detail.terminal as DynamicTerminal,...(typeof e.body.detail.reason==='string'?{reason:e.body.detail.reason as Reason}:{})})).sort((a,b)=>a.round-b.round);
    const deviceReturn=projectedResult(events)?.body.detail.device_return;
    const category=end?.body.detail.call_error_category;
    return { job,...(category===null||isCallErrorCategory(category)?{call_error_category:category}:{}),...(end?.body.detail.submission_verified===true?{submission_verified:true}:{}),...(booking?{booking}:{}),...((end?.body.error_code??roundRefusal?.body.error_code)?{error_code:end?.body.error_code??roundRefusal?.body.error_code}:{}),...(memberFacts.length?{member_missing_facts:memberFacts}:{}),...(typeof deviceReturn==='string'?{device_return:deviceReturn}:{}),...(pendingReport?{report_pending:true}:{}),...(modelPremises?.length?{qualifier_marks:['conditional_on_judgment' as const]}:{}),...(adminRelease?{admin_release:adminRelease}:{}),...(adminReleaseMissing?{admin_release_missing:true}:{}),...(rounds.length?{rounds}:{}),...(unprobed?.length?{unprobed_devices:unprobed}:{}),...(failedChecks.length?{failed_checks:failedChecks}:{}),...(unjudged.length?{unjudged}:{}),...(failedConditions.length?{failed_conditions:failedConditions}:{}),requests:openRequests(events).map(e=>({id:e.digest,question_sha256:typeof e.body.detail.question_sha256==='string'?e.body.detail.question_sha256:null,deadline:typeof e.body.detail.deadline==='string'?e.body.detail.deadline:null})),marks,...(isDisposition(choice)?{disposition:choice}:{}),...(typeof decision?.body.detail.decided_by==='string'?{decided_by:decision.body.detail.decided_by}:{}),...(typeof decision?.body.detail.decided_at==='string'?{decided_at:decision.body.detail.decided_at}:{}), ...(typeof end?.body.detail.public_reason === 'string' ? {reason:end.body.detail.public_reason} : {}),...(typeof intent?.body.detail.request_id==='string'?{request_id:intent.body.detail.request_id}:{}),...(rejectionStage!==undefined?{rejection_stage:rejectionStage}:{}),...(end?.body.detail.phase==='complete'&&end.body.detail.outcome==='not_dispatched'&&end.body.detail.submit_invoked===false?{not_sent:true}:{}), phase: String(events.at(-1)!.body.detail.phase),
      outcome: riskDisposed ? 'unknown' : end?.body.detail.outcome==='not_dispatched' && end.body.detail.submit_invoked===false ? 'not_dispatched' : end && retrySafeOutcome(end.body.detail.outcome) ? end.body.detail.outcome as EffectOutcome : unknown || missingReceipt || (intent && !receipt) ? 'unknown' : end?.body.detail.outcome === 'not_dispatched' ? 'not_dispatched' : end ? 'effective' : intent ? 'issued' : 'not_dispatched',
      frozen: unknown || missingReceipt, ...(typeof result?.body.detail.reference === 'string' ? { result: result.body.detail.reference } : {}), events: events.length, ...(gap||missingFact ? { missing_fact:[missingFact,gap?.missing_fact].filter(Boolean).join('；') } : {}),
      ...(gap?{next_action:String(gap.next_action)}:pendingReport&&!unknown&&!missingReceipt?{next_action:typeof end?.body.detail.next_action==='string'?end.body.detail.next_action:`circle-hub job resume ${job}；只读补报告，不重交`}:riskDisposed ? {next_action:'处置已完成，原效果保留未知；后续作业须重新核验与授权，不得将原请求当作未执行重交'} : unknown || missingReceipt ? { next_action: typeof uncertainty?.body.detail.next_action==='string'?uncertainty.body.detail.next_action:`circle-hub job resume ${job}；只读原请求，不重交` } : typeof end?.body.detail.next_action === 'string' ? { next_action: end.body.detail.next_action } : !isDone(events) ? { next_action: `circle-hub job resume ${job}` } : {}) };
  }
  /** Read-only clause-3 diagnosis: no connector session, policy replay, reservation or journal write. */
  async explainRelease(by:Principal,run:string,executor:string){
    await this.registry.admin(by);const registered=await this.registry.get(executor);
    if(!registered)throw new Error('执行器对当前账户不可用；先用 executor list 核对编号');
    const d=registered.definition;
    const no_verdict=missingOwnershipCertification(d);
    try{
      const gate=await prepareEffectGate({records:this.options.records,runs:this.options.runs,workflows:this.options.workflows,by,run,executor,definition:d,resolved_digest:registered.resolved_digest,now:this.now});
      const rows=[];
      for(const row of gate.context.effects){
        const applicable=row.resource_kind==='executor'&&row.action==='submit'&&row.effect_class===gate.context.write.effect_class&&row.trigger===gate.context.trigger;
        const report=await gate.inspectRelease(row);rows.push({row_sha256:releaseDigest(row.id),applicable,checks:report.checks});
      }
      // The gate dispatch applies after every release condition: the run's lineage holds every resource key the executor declares.
      // Reported beside the clause-3 verdict, not inside it: dispatchAccepted picks its executor by `satisfied` and then lets the dispatch itself refuse and tell the runner.
      const coverage=await this.explainCoverage(by,run,d);
      return {run_sha256:releaseDigest(run),executor_sha256:releaseDigest(executor),satisfied:registered.definition.enabled&&rows.some(row=>row.applicable&&row.checks.every(check=>check.satisfied===true)),checks:[{condition:'executor.enabled',label:'执行器已启用',satisfied:d.enabled,fields:[]} as ReleaseCheck,...(!rows.length?[{condition:'release.rows',label:'冻结包声明了效果行',satisfied:false,fields:[]} as ReleaseCheck]:[])],rows,no_verdict,lease_coverage:coverage};
    }catch(error){
      const proof=await inspectInput(by,run,d,this.options.records,this.options.runs,this.options.workflows,this.now());
      return {run_sha256:releaseDigest(run),executor_sha256:releaseDigest(executor),satisfied:false,checks:[...proof.checks,...releaseFailure(error)],rows:[],no_verdict,lease_coverage:null as ReleaseCheck|null};
    }
  }
  /** The lease-coverage clause of explain-release: read-only, names the declared keys the lineage lacks, never contacts the executor. */
  private async explainCoverage(by:Principal,run:string,d:ExecutorDefinition):Promise<ReleaseCheck>{
    const condition='lease.coverage',label='同一谱系持有执行器声明的全部资源键';
    const proof=await inspectInput(by,run,d,this.options.records,this.options.runs,this.options.workflows,this.now());
    if(!proof.input)return {condition,label,satisfied:null,fields:[],missing_fact:'派发前提尚未全部核对通过，无法确定运行的谱系和发起用户，因此还不能判断租约是否覆盖',next_action:'先处理上面未满足的放行条件，再重跑 job explain-release'};
    try{
      const {missing}=await this.coverage(proof.input.ancestors,proof.input.user,d.resources,d.submit_timeout_ms+d.max_run_ms);
      const fields=[releaseField('lease.resources.uncovered',0,missing.length,missing.length===0)];
      return missing.length===0?{condition,label,satisfied:true,fields}:{condition,label,satisfied:false,fields,missing_fact:`缺少覆盖派发窗口的同血缘有效租约：${[...new Set(missing)].join('、')}`,next_action:'先预订整个自动化测试环境（全部资源键），再从脚本编写开始新的运行，并重新核验脚本合并；不要只预订部分设备'};
    }catch(error){return {condition,label,satisfied:null,fields:[releaseField('exception',undefined,error instanceof Error?{name:error.name}:error,null)],missing_fact:'读不到租约持有记录，无法判断租约是否覆盖',next_action:'管理员恢复租约表的可读性后重跑 job explain-release'};}
  }
  async list(by:Principal,executor:string):Promise<JobStatus[]> {
    await this.registry.admin(by);const current=await this.registry.get(executor);
    if(!current)throw new Error('执行器对当前账户不可用；先用 executor list 核对编号');
    const jobs=await this.journal.blockers(executor,current.definition.target,new URL(current.definition.endpoint).origin,current.definition.resources);
    return Promise.all(jobs.map(job=>this.status(by,job)));
  }
  /** Trusted lease boundary: unresolved effects block local release even after a terminal observation. */
  async activeLeaseJobs(keys: readonly string[]): Promise<Array<{key:string;job:string}>> {
    if (!keys.length) return [];
    const keysSet=new Set(keys);const events=await this.journal.targets(keys);
    const jobs=[...new Set(events.map(e=>String(e.body.detail.job)))].sort(),histories=await this.journal.histories(jobs);
    const rows:Array<{key:string;job:string}>=[];
    for(const job of jobs){
      const history=histories.get(job)??[];
      const reservation=history.find(e=>e.body.detail.phase==='reservation');
      const binding=reservation?.body.detail.binding as JobBinding|undefined;
      if(!binding)throw new Error('作业缺少资源登记，请管理员恢复作业登记后核验');
      if(reservation?.body.detail.read_only===true || isDone(history) && !isFrozen(history))continue;
      for(const key of binding.resources)if(keysSet.has(key))rows.push({key,job});
    }
    return rows.sort((a,b)=>a.key.localeCompare(b.key)||a.job.localeCompare(b.job));
  }
  /**
   * The state of one runtime environment for administrators, read-only (environment.ts): the jobs holding its physical
   * target and whether they wait for a disposition, its open bed hold, the latest dispatch and the version the target
   * reported. Null for an id that is not a registered executor. A fact that cannot be read is named in `missing`.
   */
  async environment(by: Principal, executor: string): Promise<EnvironmentFacts | null> {
    await this.registry.admin(by);
    const source = await this.registry.readSource(executor);
    if (!source) return null;
    const missing: string[] = [];
    const decision = await this.options.records.authorizations.resourceConfig(`executor.${executor}`).catch(() => null);
    let holding: EnvironmentJob[] | null = null;
    try {
      const current = await this.registry.get(executor);
      if (!current) throw new Error('执行器登记已不可读');
      const jobs = await this.journal.blockers(executor, current.definition.target, new URL(current.definition.endpoint).origin, current.definition.resources);
      const held: EnvironmentJob[] = [];
      for (const job of jobs) {
        const status = await this.status(by, job);
        const binding = await this.journal.binding(job).catch(() => null);
        // Frozen is an open uncertain request (isFrozen), not JobStatus.frozen, which also counts an intent still waiting
        // for its receipt: a dispatch under way holds the environment without freezing it.
        held.push({ job, run: bindingRun(binding), frozen: isFrozen(await this.journal.events(job)), outcome: status.outcome, phase: status.phase });
      }
      holding = held.sort((left, right) => Number(right.frozen) - Number(left.frozen) || left.job.localeCompare(right.job));
    } catch {
      missing.push('占用该运行环境的作业暂不可读');
    }
    let bedHold: { job: string; bed: string } | null = null;
    let bedKnown = true;
    try {
      const hold = await this.latestExecutorHold(executor);
      bedHold = hold !== null && hold.state === 'open' ? { job: hold.job, bed: hold.bed } : null;
    } catch {
      bedKnown = false;
      missing.push('运行环境是否已恢复暂不可读');
    }
    let scan: Awaited<ReturnType<typeof scanNewest>> | null = null;
    try {
      scan = await scanNewest((cursor) => this.options.records.store.find<ActionBody>({ kind: 'action', key: 'dispatch.executor', value: executor, newestFirst: true, limit: NEWEST_PAGE_SIZE, cursor }));
    } catch {
      // Neither the latest dispatch nor the version is established.
    }
    let latest: EnvironmentFacts['latest'] = null;
    let latestKnown = scan !== null && scan.reservation === null && scan.exhausted;
    if (scan?.reservation) {
      try {
        const job = String(scan.reservation.body.detail.job);
        const status = await this.status(by, job);
        latest = { job, run: bindingRun(scan.reservation.body.detail.binding), at: scan.reservation.created_at, outcome: status.outcome, frozen: isFrozen(await this.journal.events(job)) };
        latestKnown = true;
      } catch {
        latest = null;
      }
    }
    if (!latestKnown) missing.push('最近派发暂不可读');
    let version: string | null = null;
    let versionKnown = scan !== null && scan.initialize === null && scan.exhausted;
    const kept = scan?.initialize?.body.inputs.find((input) => input.startsWith('src:'));
    if (kept !== undefined) {
      // Answer bytes the store no longer holds leave the version unknown, not unreported.
      const bytes = await this.options.records.objects.get(kept.slice(4)).catch(() => null);
      if (bytes) {
        version = reportedVersion(bytes);
        versionKnown = true;
      }
    }
    if (!versionKnown) missing.push('执行器版本暂不可读');
    return {
      executor,
      enabled: source.source.enabled,
      registration: { digest: source.digest, decided_at: decision?.created_at ?? null },
      known: { occupancy: holding !== null && bedKnown, latest: latestKnown, version: versionKnown },
      holding,
      bed_hold: bedHold,
      latest,
      reported_version: version,
      missing,
    };
  }
  async precheck(by: Principal, executor: string, booking?: string): Promise<JobStatus> {
    await this.registry.admin(by);
    const registered = await this.registry.get(executor);
    if (!registered?.definition.enabled) throw new Error('执行器不可用或已禁用');
    const d = registered.definition;
    await this.assertNoSecrets(d);
    await this.options.records.objects.put(canonicalBytes(d),'application/json');
    const booked = booking ? await this.options.runs.getRun(by, booking) : null;
    if (booking && !booked) throw new Error('预订运行对当前账户不可用');
    const binding: JobBinding = { job: newJob(), initiated_by: by.id, executor, executor_digest: registered.resolved_digest, executor_source_digest:registered.digest,variables:registered.variables, scope:{target:d.target,origin:new URL(d.endpoint).origin}, target_key: digestOfValue([...d.resources].sort()), input: null,
      user: booked?.run.runner ?? by.id, resources: [], context: { ...environmentOf(d.precheck_context), ...(booked?.run.build ? { build: booked.run.build } : {}), ...(booked && lockedBuildBase(booked.run) ? {build_base:lockedBuildBase(booked.run)} : {}), ...(booked?.run.product ? {product:booked.run.product} : {}), ...(booked?.run.root ? {root:booked.run.root} : {}), target: d.target, ...(d.resources.length ? { seats: d.resources.length } : {}), ...(d.manifest_sha256 ? { manifest_sha256: d.manifest_sha256 } : {}) } };
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
    const binding: JobBinding = {job:newJob(),initiated_by:by.id,executor,executor_digest:registered.resolved_digest,executor_source_digest:registered.digest,variables:registered.variables,scope:{target:d.target,origin:new URL(d.endpoint).origin},target_key:digestOfValue([...d.resources].sort()),input:null,user:by.id,resources:d.resources,context:environmentOf(d.precheck_context)};
    await this.options.leases.withMutationLock(tx=>this.reserve(binding,tx));
    const material=await this.secret(binding,d);if(material===null)return this.credentialUnavailable(by,binding,true);
    const client = this.session(binding,d,material);
    let lease: RemoteLease | undefined; const observations: Exchange[] = []; const checks: boolean[] = [];let failure:Record<string,string>|undefined;const ambiguous=false;
    try {
      await client.connect(); lease = await this.acquire(binding,d,client,this.context(binding));
      const context = {...this.context(binding),lease_id:lease.id,lease_token:lease.token,request_id:`${binding.job}:absent`,not_after:new Date(this.now().getTime()-d.conformance.expiry_margin_ms-1000).toISOString(),items:[]};
      const missing = await this.read(binding,client,'query',context); observations.push(missing);
      const r = d.reconciliation;
      const expectedIdentity=requestIdentity(missing.value,r.identity,r.time_scale_ms);
      checks.push(!!expectedIdentity && at(missing.value,r.found) === false);
      if (!checks[0]) {failure={missing_fact:'缺少可靠日志身份或本次探测查空回答；时间记录不作判据',next_action:'管理员核对日志身份和主体声明后重试；不提交探测字节'}; throw new Error('缺少查账事实');}
      failure={missing_fact:'只有只读查空原件，缺少已核验的序号回收拒收和同键去重事实；管理员提供的探测字节未经核验，不得外发，须补受限审计证据',next_action:'管理员从目标自己的受限审计记录只读取证，将完整协议事实、目标版本和证据引用登记到执行器前提；conformance 不提交探测字节'};
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
      const snapshot=requestIdentity(response.value,r.identity,r.time_scale_ms);
      const bound=intent.body.detail.request_protocol_verified===true && sameRequestIdentity(intent.body.detail.request_identity,snapshot);
      const negative=found===true && identity && at(response.value,r.reached_device)===false && (mapped(r.map,at(response.value,r.state))==='proven_not_executed' || mapped(r.map,at(response.value,r.state))==='target_rejected' && mapped(d.receipt.stages,at(response.value,r.stage))==='target_rejected');
      if(allowResolution && bound && negative && await this.certified(binding,d,client,'request_journal') && await this.certified(binding,d,client,'request_journal',{version:intent.body.detail.request_protocol_version})) {
        await this.answerRequests(binding,'complete','read_back','completed',{done:true,outcome:'proven_not_executed',unfreeze:true,effect_accounted:true,next_action:'原探测请求的未执行事实已按认证协议回读；管理员核对探测前提后才可重新采证'},sources);return;
      }
      fact=found===true && identity && at(response.value,r.reached_device)===true?'原探测请求已有开始标记；缺少本次探测收尾及设备现场恢复事实':'探测提交的原请求尚缺相符的开始、拒收或未执行事实，不能证明没有设备效果';
    } catch {fact='探测提交可能已有设备效果；原请求只读对账未取得可用应答，缺开始及收尾事实';}
    await this.unknown(binding,fact,sources,{request_id:intent.body.detail.request_id,next_action:`请管理员 ${by.id} 核对该请求的审计、收尾和设备现场；读取通道需修复时先修复后运行 circle-hub job resume ${binding.job}，再用 circle-hub job dispose ${binding.job} 具名处置；不得重跑 conformance 或重交`});
  }

  /** Decision 105 (model W03, D06): once the runner's submission is accepted and the release conditions hold, the Hub starts the
   * hub_template job itself for the runner's run; a named administrator stays responsible for an unknown outcome. Exactly one
   * enabled executor of the run's pack must release; none or several start nothing and say why. The byte and budget guards of
   * dispatch refuse a repeat, so an accepted submission dispatches at most once. */
  /**
   * The Hub's own dispatch of an accepted run for its runner (decision 105). Refusal wording (C14) lists only conditions
   * judged错误, discloses expectation/actual per the registry, and never claims「已记下」without an admin-visible record.
   */
  async dispatchAccepted(run: string, onReserved?: (job: string, executor: string) => void): Promise<{ started: boolean; executor?: string; status?: JobStatus; reason?: string; member_missing_facts?:Array<{fact:string;next_action:string}>; call_error_category?:CallErrorCategory|null; checks?: ReleaseCheck[]; error_code?:BoundaryFailure['code']; outcome?:EffectOutcome }> {
    const admin = (await this.options.records.principals.list()).find((p) => isAdmin(p) && !p.disabled);
    if (!admin) return { started: false, reason: '没有在职管理员负责作业未知结果的处置，Hub 不自动派发；等管理员开通账号' };
    const detail = await this.options.runs.getRun(admin, run);
    if (!detail?.run.runner) return { started: false, reason: '运行不可读或没有发起用户' };
    const log = (what: string, text: string) => { try { this.options.adminLog?.({ traceId: null, run, what: `hub dispatch ${what}`, detail: this.redactor.maskText(text).slice(0, 2000) }); } catch { /* the log never decides the answer */ } };
    const described = (error: unknown) => error instanceof Error ? error.message : String(error);
    const pack = detail.run.pack.split('@')[0];
    const candidates = (await this.registry.list(admin)).filter((e) => e.definition.enabled && e.definition.proof.package === pack);
    const released: typeof candidates = [];
    let permittedCandidates=0,environmentFailure:BoundaryFailure|undefined;
    let refusalChecks: ReleaseCheck[] | undefined;
    let refusalExecutor: string | undefined;
    for (const candidate of candidates) {
      const useFailure=await this.environmentUseFailure(detail.run.runner,candidate.id);
      if(useFailure){environmentFailure??=useFailure;continue;}
      permittedCandidates++;
      try {
        const explanation = await this.explainRelease(admin, run, candidate.id);
        if (explanation.satisfied) { released.push(candidate); continue; }
        const checks = releaseChecksOf(explanation);
        if (refusalChecks === undefined) { refusalChecks = checks; refusalExecutor = candidate.id; }
        log('release unmet', `${candidate.id}: ${unmetReleaseLabels(explanation).join('；')}`);
      } catch (error) {
        if (refusalChecks === undefined) {
          refusalChecks = releaseFailure(error);
          refusalExecutor = candidate.id;
        }
        log('release error', `${candidate.id}: ${described(error)}`);
      }
    }
    if (released.length > 1) { log('release ambiguous', released.map((e) => e.id).join('、')); return { started: false, reason: `有 ${released.length} 个执行器同时满足放行条件，请管理员指定执行器后再上机验证` }; }
    if (!released.length) {
      if(candidates.length&&permittedCandidates===0&&environmentFailure)return {started:false,error_code:environmentFailure.code,reason:environmentFailure.message};
      if (!candidates.length) return { started: false, reason: '没有为该任务包登记的启用执行器，上机验证没有发出；等管理员登记执行器' };
      const runner = await this.options.records.principals.get(detail.run.runner);
      return {
        started: false,
        call_error_category:refusalChecks?.some(check=>check.satisfied===false)?'not_found':null,
        ...(refusalExecutor ? { executor: refusalExecutor } : {}),
        ...(refusalChecks ? {checks:refusalChecks} : {}),
        reason: formatReleaseRefusal({
          checks: refusalChecks ?? [],
          run,
          executor: refusalExecutor ?? candidates[0].id,
          callerIsAdmin: runner !== null && isAdmin(runner),
        }),
      };
    }
    const chosen = released[0];
    try {
      const status = await this.dispatch(admin, run, chosen.id, (job) => onReserved?.(job, chosen.id), { initiatedBy: detail.run.runner });
      return { started: true, executor: chosen.id, status };
    } catch (error) {
      log('error', `${chosen.id}: ${described(error)}`);
      const memberFailure = error instanceof TargetOccupiedError
        ? {error_code:'LEASE_UNAVAILABLE' as const,call_error_category:'occupied' as const,member_missing_facts:[{fact:'自动化测试环境正被作业占用，这次上机验证没有发出',next_action:'等占用结束后原样重交'}]}
        : error instanceof AlreadyDispatchedError
          ? {error_code:'IDEMPOTENCY_MISMATCH' as const,member_missing_facts:[{
            fact:error.ended?'这份产物已经派发过，作业已结束；同一份字节只派发一次':'这份产物已经派发，原作业还没结束或结果未知；同一份字节只派发一次',
            next_action:error.ended?'读取原作业的结果；要再做一次，按任务包规程做一份新的产物，上传后重新开始上机验证':'等原作业结束或管理员对账后读取结果，不要用同一份字节再开运行',
          }]}
          : {};
      return { started: false, executor: chosen.id, ...memberFailure, ...(!(error instanceof TargetOccupiedError)&&!(error instanceof AlreadyDispatchedError)?{outcome:'unknown' as const}:{}), reason: error instanceof TargetOccupiedError ? '自动化测试环境正被作业占用，这次上机验证没有发出；等占用结束后原样重交'
        : error instanceof AlreadyDispatchedError
          ? error.ended ? `这份产物已经由作业 ${error.job} 派发过，作业已结束；同一份字节只派发一次。结果读那个作业；要再做一次，按任务包的规程做一份新的产物，上传后重新开始上机验证` : `这份产物已经由作业 ${error.job} 派发，那个作业还没结束或结果未知；等它结束（或管理员对账）后读它的结果，不要用同一份字节再开运行`
          : '本次派发状态尚未确认；请管理员只读核对作业记录，不要重新发送' };
    }
  }

  async dispatch(by: Principal, run: string, executor: string, onReserved?: (job: string) => void, options: { initiatedBy?: string } = {}): Promise<JobStatus> {
    await this.registry.admin(by);
    const registered = await this.registry.get(executor);
    if (!registered?.definition.enabled) throw new Error('执行器不可用或已禁用');
    const d = registered.definition;
    await this.assertNoSecrets(d);
    await this.options.records.objects.put(canonicalBytes(d),'application/json');
    if (registrationMissing(d).filter(name=>name!=='environment').length) throw new Error(`派发登记缺事实：${registrationMissing(d).filter(name=>name!=='environment').join('、')}；请先 precheck 采证、转换并发布清单，再 update 补齐`);
    const gate=await prepareEffectGate({records:this.options.records,runs:this.options.runs,workflows:this.options.workflows,recheck:this.options.recheckChecks,by,run,executor,definition:d,resolved_digest:registered.resolved_digest,now:this.now});
    const provisional:JobBinding={run,job:newJob(),initiated_by:options.initiatedBy??by.id,...(options.initiatedBy?{acting_by:by.id}:{}),executor,executor_digest:registered.resolved_digest,executor_source_digest:registered.digest,variables:registered.variables,input:null,user:gate.detail.run.runner??by.id,resources:d.resources,scope:{target:d.target,origin:new URL(d.endpoint).origin},target_key:digestOfValue([...d.resources].sort())};
    const preflight=await gate.preflight();if(!preflight.ok)return this.boundaryRefused(by,provisional,preflight);
    const input=preflight.input;
    const useFailure=await this.environmentUseFailure(input.user,executor);
    if(useFailure)return this.boundaryRefused(by,{...provisional,input},useFailure);
    const previous = await this.options.records.store.getByKey<ActionBody>('action', `dispatch.bytes:${input.sha256}`);
    const allAttempts = await this.lineageAttempts(input);
    const policy = roundPolicy(gate.detail.run, gate.context.effects, d.proof.requirement);
    const multi = repeats(policy);
    const round = multi ? await this.openRound(allAttempts, policy.count) : 1;
    if (multi && round > policy.count) throw new Error('同一（S，轮次）已派发成功；只能查询或对账，不能重交');
    const attempts = multi ? allAttempts.filter(e => roundOf(e.body.detail) === round) : allAttempts;
    if (previous&&await this.intentMatchesLineage(previous,input)) throw new Error('本血缘的这份字节已有旧版派发意图；只能查询或对账，不能重交');
    for (const prior of attempts) {
      const priorJob = String(prior.body.detail.job); const priorEvents = await this.journal.events(priorJob);
      const end = eventOf(priorEvents,'complete'); const pinned = await this.journal.binding(priorJob);
      const roundEnd=multi?[...priorEvents].reverse().find(event=>event.body.detail.phase==='round'&&event.body.detail.round===round&&event.body.detail.not_started===true&&event.body.detail.outcome==='not_dispatched'):undefined;
      const completion=roundEnd??end;
      if (!end || isFrozen(priorEvents) || !(retrySafeOutcome(completion?.body.detail.outcome) || completion?.body.detail.outcome==='not_dispatched' && completion.body.detail.submit_invoked===false) || pinned.input?.run !== input.run || digestOfValue(operationDefinition(await this.pinned(pinned))) !== digestOfValue(operationDefinition(d)) || !same({...pinned.input,result:null},{...input,result:null})) throw new AlreadyDispatchedError(priorJob, !!end && !isFrozen(priorEvents), `这份字节已有派发意图；作业摘要 ${priorJob}；只能查询或对账，不能重交`);
    }
    const attempt = attempts.length + 1;
    const source = await this.options.records.artifacts.source({ id: input.user, name: '', role: 'user' }, input.sha256, { consumer: 'function' });
    let initial:HolderSnapshot[];
    try{initial=await this.holders(input.ancestors,input.user,d.resources,d.submit_timeout_ms+d.max_run_ms);}
    catch(error){
      const known=error instanceof LeaseCoverageError;
      const booking:BookingDiagnosis={target:d.target,coverage_complete:known?false:null,required_resources:new Set(d.resources).size,
        missing_resources:known?new Set(error.missing).size:null,
        declared_device_count:d.probes?new Set(d.probes.seats.map(seat=>seat.manifest.device)).size:null};
      return this.boundaryRefused(by,{...provisional,input},deny(5,known?'LEASE_UNAVAILABLE':'SOURCE_UNAVAILABLE',
        known?`缺少覆盖派发窗口的同血缘有效租约：${[...new Set(error.missing)].join('、')}`:'本运行的环境预订覆盖尚未核对；先恢复租约记录读取再核对覆盖范围'),{submission_verified:true,booking,...(known?{call_error_category:error.occupied?'occupied' as const:'not_found' as const}:{})},known&&error.expired);
    }
    const binding: JobBinding = { ...provisional, input, user: input.user, resources: d.resources, fences: initial, scope:{target:d.target,origin:new URL(d.endpoint).origin}, target_key: digestOfValue([...d.resources].sort()) };
    if(d.calls.submit.write)binding.target_key=digestOfValue(bind(d.calls.submit.write.target_key,this.context(binding)));
    delete binding.run; // Restricted response captures deliberately clear input; never leave a second run binding behind.
    await this.options.leases.withMutationLock(tx=>this.reserve(binding,tx));
    try { onReserved?.(binding.job); } catch { /* A terminal sink never controls an effect already authorized by the command. */ }
    const secret=await this.secret(binding,d);if(secret===null)return this.credentialUnavailable(by,binding,true);
    let session = this.session(binding, d, secret);
    let remote: RemoteLease | undefined; let stop = async () => {}; let pulse:Heartbeat|undefined;
    const flags = { intended: false, submitInvoked: false };
    let unlockObservation: (() => Promise<void>) | undefined;
    const hold = {
      setStop: (fn: () => Promise<void>) => { stop = fn; },
      setSession: (client: RpcClient) => { session = client; },
      setRemote: (value: RemoteLease) => { remote = value; },
    };
    try {
      const held = await this.options.records.store.tryHold(`dispatch.observation:${binding.job}`);
      if (!held) throw new Error('同一作业的观察仍在进行；请等它结束，或在原进程退出后用 circle-hub job resume 只读继续');
      unlockObservation = held;
      await session.connect();
      remote = await this.acquire(binding, d, session, this.context(binding));
      pulse = this.heartbeat(binding,d,session,remote);stop=pulse.stop;
      const context: Record<string, unknown> = { ...this.context(binding), lease_id: remote.id, lease_token: remote.token, payload_base64: Buffer.from(source?.bytes??[]).toString('base64') };
      const precheck = await this.retryRead(binding, session, 'precheck', context, Infinity);
      if (!await this.assessConditions(binding,d.conditions,precheck,context,'precheck.evaluated')) throw new Error('只读核对未满足；未提交，请核对当前环境后重新核验');
      if (!await this.extraPrechecks(binding, d, session, context, false)) throw new Error('附加只读核对未满足；未提交，请重新核对缓存来源');
      const deviceIdentity = await this.probeSeats(binding,d,session,context);
      if (!deviceIdentity) throw new Error('设备版本、接口或残留核对有误。管理员查看设备输出后重新核对测试环境');
      await this.gateBed(binding, d, session, context);
      const latest = await this.registry.get(executor);
      if (!latest?.definition.enabled || latest.digest !== registered.digest || latest.resolved_digest !== registered.resolved_digest) throw new PrecheckFactError('执行器配置已变；未提交，请按当前配置重新核验','用当前配置重新核验后再派发；没有提交');
      await this.registry.admin(by);
      const ownerNow = await this.options.records.principals.get(input.user);
      if (!ownerNow || ownerNow.disabled) throw new Error('发起用户已经不可用；未提交');
      let fresh:HolderSnapshot[];try{fresh=await this.holders(input.ancestors,input.user,d.resources,d.submit_timeout_ms+d.max_run_ms);}catch{throw new EffectBoundaryError(deny(5,'LEASE_EXPIRED','资源租约已到期或不再覆盖窗口；请恢复租约并重证基线'));}
      if (!this.sameFences(initial, fresh)) throw new EffectBoundaryError(deny(5,'FENCING_STALE','派发前围栏已变；请重新证明基线'));
      const currentProof = await verifyInput(by,run,d,this.options.records,this.options.runs,this.options.workflows,this.now());
      if(!same({...input,result:null},{...currentProof,result:null}))throw new InputVerificationError('只读核对期间这个运行的最新核验结果改变了，没有提交');
      const notAfter = new Date(this.now().getTime() + d.submit_timeout_ms).toISOString();
      const sequence = attempts.length ? Number(attempts[0].body.detail.sequence) : (await this.options.records.store.findMany({ kind: 'action', key: 'dispatch.lineage', values: [input.lineage] })).filter(e => (e.body as Record<string, unknown>)?.detail && ((e.body as { detail: Record<string, unknown> }).detail.phase === 'intent')).length + 1;
      const key = attempts.length ? String(attempts[0].body.detail.intent_key) : digestOfValue([input.lineage, input.item, d.proof.slot, multi ? round : sequence]);
      context.request_id = `${key}:${attempt}`; context.not_after = notAfter;
      context.sequence_scope = binding.executor; context.dispatch_sequence = await this.journal.nextDispatchSequence(binding);
      let requestSnapshot:Record<string,unknown>={};let requestSources:string[]=[];
      if(d.reconciliation) {
        const r=d.reconciliation;
        if(!r.identity || !d.receipt.identity)throw new PrecheckFactError('缺少查询或投递回答的日志身份字段声明','管理员核对目标协议，补齐查询与投递回答的身份、起点及主体字段声明后重新派发；尚未提交');
        if(!session.serverVersion || !r.protocol_versions.includes(session.serverVersion))throw new PrecheckFactError('投递会话版本未登记请求协议支持','管理员核对发送会话版本及协议证据，登记该版本支持或更换受支持版本后重新派发；尚未提交');
        const response=await this.retryRead(binding,session,'query',context,Infinity);
        const identity=requestIdentity(response.value,r.identity,r.time_scale_ms);
        if(at(response.value,r.found)!==false || !identity) {
          throw new PrecheckFactError('投递前缺少本请求号的查空记录或可靠日志身份与主体','管理员核对日志身份及主体声明后重新派发；尚未提交，时间只作记录');
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
      if(multi && !roundAllowed(round, policy)){await stop();await this.release(binding,session,remote);return this.boundaryRefused(by,binding,deny(4,'EFFECT_BUDGET_EXHAUSTED',`第 ${round} 轮超过冻结次数或效果行的重复预算；请开始新修订`,boundary.row));}
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
        const useFailure=await this.environmentUseFailure(input.user,executor,tx);if(useFailure)throw new EffectBoundaryError(useFailure);
        await gate.reserveBudget(boundary.row,tx);
        const permitted = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: true }, [], `dispatch.gate:${binding.job}`, tx);
        if (!permitted.created) throw new Error('作业已经恢复或关闭，不能再提交');
        const ordinal = attempt === 1 ? await this.journal.append(binding, 'sequence', 'validate', 'completed', { sequence }, [], `dispatch.sequence:${input.lineage}:${sequence}`, tx) : { created: true };
        if (!ordinal.created) throw new Error('血缘次序已由另一派发占用；未提交');
        const intent = await this.journal.append(binding, 'intent', 'dispatch', 'completed', { effect_row:boundary.row.id,effect_duration_ms:d.max_run_ms,intent_key: key, verification_result:currentProof.result, request_id: context.request_id, dispatch_sequence:context.dispatch_sequence,sequence_scope:context.sequence_scope, ...requestSnapshot, device_identity_proven: !!d.probes && deviceIdentity, device_lease_digest: digestOfValue([context.lease_id,context.lease_token]), attempt, ...(multi ? { round } : {}), not_after: notAfter, sequence, action_digest: actionDigest,
          dispatch_binding_digest: digestOfValue([input.run, input.item, input.sha256, fresh, remote]), target_key: binding.target_key, ...intentSemantics, on_behalf_of: input.user,
          before_state_bound: beforeState.bound,before_state:beforeState,fences: fresh, remote_lease: remote, window: { from: this.now().toISOString(), to: notAfter } }, [`src:${input.sha256}`, `rec:${currentProof.result}`,...precheckSources,...requestSources], bytesKey(input.sha256, round, attempt, multi,input.lineage), tx);
        if (!intent.created) throw new Error('这份字节已经写过意图；未重复提交');
      });
      flags.intended = true;
      if (this.now().getTime() >= Date.parse(notAfter)) { await this.notSent(binding,session,remote,stop,'意图后派发窗口已过，尚未调用提交');return this.status(by,binding.job); }
      if (!this.sameFences(fresh, await this.options.leases.holderSnapshot(d.resources))) { await this.notSent(binding,session,remote,stop,'意图后围栏改变，尚未调用提交');return this.status(by,binding.job); }
      if(!pulse.held() || this.now().getTime()>=Date.parse(notAfter)) { await stop();await this.release(binding,session,remote);await this.journal.append(binding,'complete','validate','completed',{done:true,outcome:'not_dispatched',submit_invoked:false,public_reason:'目标租约确认失效，尚未调用提交',next_action:'恢复目标租约后重新预检与派发'});return this.status(by,binding.job); }
      // Signals must not cancel an in-flight effect; SIGKILL is recovered from the already committed intent.
      const ignore = () => {}; process.on('SIGINT', ignore); process.on('SIGTERM', ignore); process.on('SIGHUP',ignore);
      let answer: Exchange;
      try {
        flags.submitInvoked=true;
        try{answer=await session.call('submit',context,Math.max(1,Date.parse(notAfter)-this.now().getTime()));}
        catch(error){
          if(error instanceof SubmissionNotSentError||error instanceof InvocationDefinitionError)throw error;
          const rule=RETRY_RULES[intentSemantics.retry_safety];
          const retryDeadline=rule.window?Math.min(Date.parse(notAfter),Date.parse(notAfter)-d.submit_timeout_ms+(d.premises.window_resend?.window_ms??0)):Date.parse(notAfter);
          if(!rule.resend||this.now().getTime()>=retryDeadline||!pulse.held()||!await this.certified(binding,d,session,'retry_safety')||rule.window&&!await this.certified(binding,d,session,'window_resend'))throw error;
          try{await readBeforeState();}catch{await this.journal.append(binding,'retry_refused','dispatch','completed',{missing_fact:'丢回复后前状态不再匹配或读不到；原请求是否执行须对账',next_action:'自动只读原请求记录，不把重发前提失败当作未执行'});throw error;}
          const retryBoundary=await checkEffectBoundary({...finalBoundary,budget:async row=>{const used=await finalBoundary.budget(row);return {count:used.count-1,duration_ms:used.duration_ms-d.max_run_ms};}});
          // The first submit was already invoked: a refusal without a conclusion says that, never that nothing went out (decision 116).
          if(!retryBoundary.ok||retryBoundary.checked!==9){const failure=retryBoundary.ok?incompleteEffectBoundary(retryBoundary):retryBoundary;await this.journal.append(binding,'retry_refused','dispatch','completed',{missing_fact:refusalText(failure,true),next_action:failure.fix},[]);throw error;}
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
        await this.unknown(binding,'投递回答的日志身份、记账起点或完整主体与投递前快照不一致；缺少原投递归属事实',[answer.source],{next_action:`请管理员 ${binding.acting_by ?? binding.initiated_by} 人工核对原投递事实、日志迁移和调用身份；不得重交`});return this.status(by,binding.job);
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
      const observed = await this.observe(by, binding, d, session, remoteId, fresh, multi ? async () => {} : stop, multi ? { seal: false, round } : undefined);
      if (!multi) return observed;
      if (observed.report_pending||observed.frozen || observed.outcome === 'unknown' || observed.outcome === 'not_dispatched' || observed.outcome === 'target_rejected' || observed.outcome === 'proven_not_executed') return observed;
      return await this.continueRounds({ by, run, executor, binding, d, gate, policy, source, initial, input, registered, secret, round, deviceIdentity, flags, hold, session, remote, pulse: pulse!, fresh });
    } catch (error) {
      if(error instanceof EffectBoundaryError&&!flags.intended&&!eventOf(await this.journal.events(binding.job),'intent')){await stop();if(remote)await this.release(binding,session,remote);return this.boundaryRefused(by,binding,error.failure);}
      if (flags.intended || eventOf(await this.journal.events(binding.job), 'intent')) {
        if((!flags.submitInvoked || error instanceof SubmissionNotSentError || error instanceof InvocationDefinitionError) && remote) {await this.notSent(binding,session,remote,stop,'当前进程证明未调用提交或未写出请求字节',error instanceof SubmissionNotSentError?[error.source]:[]);return this.status(by,binding.job);}
        if (receiptOf(await this.journal.events(binding.job))) await this.pendingRead(binding);
        else if (d.reconciliation && d.calls.query) return await this.reconcileRequest(by,binding,d,session,stop);
        else await this.unknown(binding, '提交未取得完整可信回执；缺远端作业身份或结果，必须管理员对账');
      }
      else {
        await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', ...(error instanceof CapabilityPolicyError || error instanceof InvocationDefinitionError || error instanceof InputVerificationError || error instanceof PrecheckFactError ? {public_reason:error.message} : notSentReason(error)!==undefined ? {public_reason:notSentReason(error)} : {}),...(error instanceof PrecheckFactError?{missing_fact:error.missing_fact,member_missing_facts:error.member_missing_facts}:notSentReason(error)!==undefined?{member_missing_facts:[{fact:notSentReason(error)!,next_action:'联系管理员恢复目标连接或租约前提后，原样重交原提交；未取得新的核对结果前不要另开运行'}]}:{}), submit_invoked:false, reason: session.redact(error instanceof Error ? error.message.toWellFormed().slice(0, 1000) : '前提核对出错'), next_action:error instanceof PrecheckFactError?error.next_action:'核对只读条件、租约和执行器定义后重新核验；没有提交' });
        if (remote) await this.release(binding, session, remote);
      }
      return await this.status(by, binding.job);
    } finally { await stop(); await unlockObservation?.(); }
  }
  /** The scheduler administrator authorizes orchestration, never the runner's environment use. */
  private async environmentUseFailure(userId:string,executor:string,tx?:Transaction):Promise<BoundaryFailure|null> {
    if(this.options.enforceEnvironmentAssignments!==true)return null;
    if(!this.options.environmentAccess)return deny(1,'SOURCE_UNAVAILABLE','环境使用权限检查未装配，尚不能核对；请管理员恢复检查接线');
    try {
      if (tx) {
        // Config is already locked and its bound digest checked in this transaction. The guard reloads account and grants.
        if (typeof this.options.environmentAccess.permission !== 'function') return deny(1,'SOURCE_UNAVAILABLE','事务内环境权限读取未装配；不能派发，请管理员恢复接线');
        const allowed=await this.options.environmentAccess.permission({id:userId,name:'',role:'user'},executor,tx);
        return allowed?null:deny(1,'SOURCE_NOT_PERMITTED','运行发起账户没有本测试环境的使用权限；请管理员明确分配后重新核验');
      }
      const actor=await this.options.records.principals.get(userId);
      if(!actor||actor.disabled)return deny(1,'SOURCE_NOT_PERMITTED','运行发起账户当前不可用，不能使用本测试环境');
      if(!await this.options.environmentAccess.canUse(actor,executor))return deny(1,'SOURCE_NOT_PERMITTED','运行发起账户没有本测试环境的使用权限；请管理员明确分配后重新核验');
      return null;
    } catch { return deny(1,'SOURCE_UNAVAILABLE','本次环境使用权限尚未核对，不能派发；请管理员恢复权限读取后再核验'); }
  }
  private async boundaryRefused(by:Principal,binding:JobBinding,failure:BoundaryFailure,facts:Pick<JobStatus,'submission_verified'|'booking'|'call_error_category'>={},expiredBooking=false):Promise<JobStatus>{
    let adminReleaseSha:string|undefined,adminReleaseMissing=false;
    if(failure.admin_checks?.length){
      for(const check of failure.admin_checks.filter(check=>check.satisfied!==true)){
        const rows=check.fields.length?check.fields.map(field=>({...check,fields:[field]})):[check];
        for(const row of rows)try{this.options.adminLog?.({traceId:null,run:binding.input?.run??binding.run??null,what:'effect release '+binding.job,detail:JSON.stringify(row)});}catch{/* Logging does not authorize or change a refusal. */}
      }
      try{
        const bytes=canonicalBytes({checks:failure.admin_checks});
        const source=await this.options.records.artifacts.ingest({bytes,mediaType:'application/json',origin:{generated:{generator:'dispatch@1',inputs:[]}},author:{user:null},provenanceType:'projected',visibility:{readers:[],admins:true,packs:[],shareable:false}});
        adminReleaseSha=source.body.sha256;
      }catch{adminReleaseMissing=true;}
    }
    if(!(await this.journal.events(binding.job)).length)await this.journal.append(binding,'reservation','dispatch','completed',{binding,read_only:true});
    // The event records submit_invoked false, so a refusal without a conclusion may say that nothing went out (decision 116).
    const said=refusalText(failure,false);
    const bookingNext='先预订整个测试环境，再从脚本编写开始新的运行，并重新核验脚本合并';
    const memberFacts=facts.booking?[{fact:facts.booking.coverage_complete===false?(facts.call_error_category==='occupied'?`测试环境 ${facts.booking.target} 有资源由其他运行持有；`:expiredBooking?'当前账户的原预订已过期；':'')+`本运行没有覆盖测试环境 ${facts.booking.target} 的完整预订，缺少 ${facts.booking.missing_resources} 项所需资源（共 ${facts.booking.required_resources} 项）`:`测试环境 ${facts.booking.target} 的本运行预订覆盖尚未核对`,
      next_action:facts.booking.coverage_complete===false?bookingNext:'联系管理员恢复预订记录读取后重新核对覆盖范围；当前不能派发'}]:undefined;

    await this.journal.append(binding,'boundary_refused','dispatch','error',{done:true,outcome:'not_dispatched',submit_invoked:false,boundary_clause:failure.clause,effect_row:failure.row??null,requirements:failure.requirements??[],public_reason:said,missing_fact:said,...facts,...(failure.no_conclusion?{call_error_category:null}:{}),...(memberFacts?{member_missing_facts:memberFacts}:failure.no_conclusion?{member_missing_facts:failure.member_missing_facts??[{fact:'冻结包的政策或参数检查尚未给出结论',next_action:'请管理员核对该检查声明的输入与执行记录，补齐前提后重新核对'}]}:failure.code==='SOURCE_NOT_PERMITTED'?{member_missing_facts:[{fact:failure.message,next_action:'联系管理员核对本测试环境的有效分配及账户状态后重新核验'}]}:failure.code==='SOURCE_UNAVAILABLE'?{member_missing_facts:[{fact:'本次测试环境的使用权限尚未核对，缺少可读取的核对事实',next_action:'联系管理员恢复环境权限检查接线或读取能力后重新核验；当前不能派发'}]}:{}),next_action:facts.booking?(facts.booking.coverage_complete===false?bookingNext:'恢复预订记录的读取能力后重新核对覆盖范围；当前不能派发'):failure.fix,...(adminReleaseSha?{admin_release_sha256:adminReleaseSha}:{}),...(adminReleaseMissing?{admin_release_missing:true}:{})},[],undefined,undefined,failure.code);
    return this.status(by,binding.job);
  }

  /** Report absence is a native projected missing fact, not an inference from a legacy gateway spelling. */
  private async reportReadback(_by:Principal,binding:JobBinding,events:readonly Event[]):Promise<ExecutionReadback|null>{
    const intent=eventOf(events,'intent'),result=projectedResult(events),end=eventOf(events,'complete');
    const count=result?.body.detail.no_verdict;let incomplete=result?.body.detail.report_pending===true||typeof count==='number'&&count>0;
    const skip=(condition:string):null=>{if(incomplete)try{this.options.adminLog?.({traceId:null,run:binding.input?.run??binding.run??null,what:'report resume skipped '+binding.job,detail:JSON.stringify({condition})});}catch{}return null;};
    if(!binding.input)return skip('binding.input');
    if(!intent)return skip('intent');
    if(!receiptOf(events))return skip('receipt');
    if(!eventOf(events,'terminal'))return skip('terminal');
    if(!result)return skip('result.projection');
    if(eventOf(events,'dispose'))return skip('management.disposition');
    if(end?.body.detail.outcome==='not_dispatched')return skip('complete.outcome');
    const reference=result.body.detail.reference;
    if(typeof reference!=='string'||!reference.startsWith('src:'))return skip('result.reference');
    const bytes=await this.options.records.objects.get(reference.slice(4));
    if(!bytes||sha256Hex(bytes)!==reference.slice(4))return skip('result.original_bytes');
    let report:Record<string,unknown>;try{const value=JSON.parse(new TextDecoder().decode(bytes));if(!object(value))return skip('result.json_object');report=value;}catch{return skip('result.json_object');}
    if(report.job!==binding.job)return skip('result.job');
    if(report.sha256!==binding.input.sha256)return skip('result.sha256');
    if(!Array.isArray(report.rows))return skip('result.rows');
    const missingReport=report.rows.some(row=>object(row)&&typeof row.item==='string'&&binding.input!.items.includes(row.item)&&row.dynamic_terminal==='no_verdict'&&Array.isArray(row.missing_facts)&&(row.missing_facts.includes('report')||row.missing_facts.includes('complete')));
    incomplete ||= missingReport;
    // A completed transport/read may have a nonempty placeholder result. It does not establish a device verdict.
    // Manual resume is a new authorized read, even when old raw bytes or their old readiness flags are unavailable.
    if(result.body.detail.report_pending!==true&&!missingReport)return skip('result.missing_report');
    const saved=result.body.detail.execution_integrity;
    if(object(saved)&&saved.intent===intent.digest&&typeof saved.continuity==='boolean')return {intent:intent.digest,continuity:saved.continuity,...(typeof saved.drift==='boolean'?{drift:saved.drift}:{}),...(typeof saved.lease_interrupted==='boolean'?{lease_interrupted:saved.lease_interrupted}:{})};
    // Legacy report projections recorded these execution-window facts before normal remote lease release.
    const drift=typeof report.lease_drift==='boolean'?report.lease_drift:undefined,interrupted=typeof report.lease_interrupted==='boolean'?report.lease_interrupted:undefined;
    const continuity=drift!==undefined&&interrupted!==undefined?!drift&&!interrupted:report.rows.length>0&&report.rows.every(row=>object(row)&&Array.isArray(row.missing_facts)&&!row.missing_facts.includes('continuity'));
    return {intent:intent.digest,continuity,...(drift!==undefined?{drift}:{}),...(interrupted!==undefined?{lease_interrupted:interrupted}:{})};
  }
  async resume(by: Principal, job: string): Promise<JobStatus> {
    await this.registry.admin(by);
    const unlock = await this.options.records.store.tryHold(`dispatch.observation:${job}`);
    if (!unlock) return this.status(by, job);
    try { return await this.resumeHeld(by, job); }
    finally { await unlock(); }
  }
  private async resumeHeld(by: Principal, job: string): Promise<JobStatus> {
    const binding = { ...await this.journal.binding(job), acting_by: by.id }; const events = await this.journal.events(job);
    const reportRefresh=!isFrozen(events)?await this.reportReadback(by,binding,events):null;
    if (isDone(events) && !isFrozen(events)&&!reportRefresh) return this.status(by, job);
    if(eventOf(events,'probe_intent')) {const d=await this.readingDefinition(binding);const material=await this.secret(binding,d);if(material===null)return this.status(by,job);const client=this.session(binding,d,material);await client.connect();await this.probeFollowup(by,binding,d,client,true);return this.status(by,job);}
    const intent = eventOf(events, 'intent'); const receipt = receiptOf(events);
    if (!intent) {
      const gate = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: false }, [], `dispatch.gate:${job}`);
      if (!gate.created && gate.body.detail.allow_submit === true) { await this.unknown(binding, '派发可能正在进行；没有完整回执，不能重交'); return this.status(by, job); }
      await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', next_action: '从未写入派发意图，必要时重新核对后派发' });
      return this.status(by, job);
    }
    if(reportRefresh){const prior=projectedResult(events)!;await this.journal.append(binding,'result','read_back','completed',{reference:prior.body.detail.reference,...(typeof prior.body.detail.items==='number'?{items:prior.body.detail.items}:{}),...(typeof prior.body.detail.no_verdict==='number'?{no_verdict:prior.body.detail.no_verdict}:{}),report_pending:true,execution_integrity:reportRefresh,refresh_of:'rec:'+prior.digest},['rec:'+prior.digest]);}
    const d = await this.readingDefinition(binding);
    if ((!receipt || isFrozen(events)) && (!d.reconciliation || !d.calls.query)) { await this.unknown(binding, '有意图但无完整可信回执或仍被冻结；下一步由管理员对账'); return this.status(by, job); }
    const material=await this.secret(binding,d);if(material===null)return this.status(by,job);
    const client = this.session(binding, d, material);
    await client.connect();
    const remote = intent.body.detail.remote_lease as unknown as RemoteLease;
    const stop = reportRefresh?async()=>{}:this.heartbeat(binding, d, client, remote).stop;
    if (!receipt || isFrozen(events)) { try { return await this.reconcileRequest(by,binding,d,client,stop); } finally { await stop(); } }
    if(!reportRefresh)await this.checkContinuity(binding,d,client,remote);
    try { return await this.observe(by, binding, d, client, receipt!.body.detail.remote_id, intent.body.detail.fences as unknown as HolderSnapshot[], stop, {...(typeof intent.body.detail.round==='number'?{round:intent.body.detail.round}:{}),...(reportRefresh?{execution:reportRefresh}:{})}); }
    catch { if(reportRefresh)await this.journal.append(binding,'report_wait','read','error',{report_pending:true,missing_fact:'原执行已结束，报告只读补取尚未成功；未重交',next_action:`恢复只读通道后 circle-hub job resume ${job}`});else await this.pendingRead(binding); return this.status(by, job); }
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
      if (!mapped(d.status.map, at(state.value, d.status.pointer)) || !same(at(result.value, d.result.id), remoteId) || at(result.value, d.result.sha256) !== binding.input!.sha256 || d.result.request_id !== undefined && at(result.value,d.result.request_id) !== intent.body.detail.request_id) throw new Error('对账身份、摘要或请求身份不符；查无记录不能证明未执行');
    }catch {
      await this.journal.append(binding,'reconcile_pending','read_back','error',{unfreeze:false,missing_fact:readable?'已读到原件，但身份、摘要或请求身份不符':'未取得完整可用的对账回答，不等于目标没有记录',next_action:`修复只读连接或映射后重跑 circle-hub job dispose ${job} --reconcile <原远端编号>`});
      throw new Error(readable?'对账身份、摘要或请求身份不符，仍冻结':'对账读取尚未成功；修复读取后重试本次对账，仍冻结');
    }
    await this.answerRequests(binding,'dispose','validate','completed',{disposition:'reconcile',decided_by:by.id,decided_at:this.now().toISOString(),unfreeze:true,remote_id:remoteId,effect_mark:'disposed',identity_matched:true,digest_matched:true,timestamps_record_only:true},[state.source,result.source],requestRefs);
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
        await this.unknown(binding,'请求日志身份或完整调用主体已改变或缺失；缺少原投递事实，当前查空不能证明未执行',[response.source],{next_action:`请管理员 ${binding.acting_by ?? binding.initiated_by} 人工核对原投递事实、原日志和调用身份；不得重交`});return this.status(by,binding.job);
      }
      const state=at(response.value,r.state);
      const pending=mapped(Object.fromEntries(r.pending_states.map(word=>[word,true])),state)===true;
      const waitingForRequest=at(response.value,r.found)===true && at(response.value,r.request_id)===context.request_id && at(response.value,r.sha256)===binding.input!.sha256 && pending;
      if(!waitingForRequest)break;
      await this.journal.append(binding,'query_pending','read','completed',{missing_fact:'目标明确报告原请求仍在处理中，尚未取得启动或拒收事实',next_action:'按登记间隔自动继续只读查询，不重交'},[response.source]);
      if(this.now().getTime()>=deadline+d.max_run_ms) {
        await this.unknown(binding,'目标仍报告处理中且超出登记窗口；需原操作者核对目标处理进程',[response.source],{next_action:`请管理员 ${binding.acting_by ?? binding.initiated_by} 核对目标处理进程，恢复后运行 circle-hub job resume ${binding.job}；不得重交`});
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
    const currentIdentity=requestIdentity(value,r.identity,r.time_scale_ms);
    const originalProtocol=intent.body.detail.request_protocol_verified===true && typeof intent.body.detail.request_protocol_version==='string';
    const identityBound=originalProtocol && sameRequestIdentity(intent.body.detail.request_identity,currentIdentity);
    if(certified && identityBound && found===true && identity && reported==='target_rejected' && mapped(d.receipt.stages,at(value,r.stage))==='target_rejected' && at(value,r.reached_device)===false) {
      await this.answerRequests(binding,'rejection','read_back','completed',{outcome:'target_rejected',acceptance:'not_accepted',stage:at(value,r.stage),reached_device:false,unfreeze:true},[response.source]);
      await stop();await this.release(binding,client,lease);
      await this.answerRequests(binding,'complete','read_back','completed',{done:true,outcome:'target_rejected',unfreeze:true,next_action:'原请求记录明确拒收且未触达设备；修正拒收前提后可用新的请求尝试派发'});
      return this.status(by,binding.job);
    }
    if (certified && identityBound && (found === true && identity && reported === 'proven_not_executed' && at(value,r.reached_device) === false)) {
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
    if(found===false) missing.push('原请求查空不证明未执行；可能仍有在途请求或已回收记录，需原请求明确未启动的事实');
    if(!queryCertified)missing.push('当前查询会话版本的请求记录前提未认证');
    if(!deliveryCertified)missing.push('发送会话版本的请求记录前提未认证，或协议支持已撤销');
    await this.unknown(binding,missing.join('；') || '缺少可终结原请求的执行记录，请核对状态映射与原件',[response.source],{next_action:!identityBound?`请管理员 ${binding.acting_by ?? binding.initiated_by} 人工核对原投递事实、原日志和发送会话版本；不得重交`:!certified?`请管理员 ${binding.acting_by ?? binding.initiated_by} 运行 circle-hub job conformance --executor ${binding.executor} 采证并登记目标版本，再运行 circle-hub job resume ${binding.job}`:`请管理员 ${binding.acting_by ?? binding.initiated_by} 核对本次查账原件和字段映射，修复后运行 circle-hub job resume ${binding.job}；不得重交`});
    return this.status(by,binding.job);
  }

  private async certified(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, premise: keyof ExecutorDefinition['premises'],delivery?:{version:unknown}): Promise<boolean> {
    const reject = async (fact:string,next_action:string):Promise<boolean> => {await this.journal.append(binding,'premise','validate','completed',{premise,certified:false,member_missing_facts:[{fact,next_action}]}).catch(()=>{});return false;};
    const current = await this.registry.get(binding.executor);
    if (!current || current.definition.target !== d.target || current.definition.endpoint !== d.endpoint || current.definition.ca !== d.ca) return reject('本次认证绑定的目标或连接声明已经改变','联系管理员核对当前目标声明与认证，再只读核对原作业；不要重新发送');
    const proof = current.definition.premises[premise];
    const version=delivery?delivery.version:client.serverVersion;
    if (!proof || typeof version!=='string' || proof.version !== version || delivery && version!==client.serverVersion || delivery && !current.definition.reconciliation?.protocol_versions.includes(version)) return reject('本次目标版本缺少匹配的前提认证','联系管理员核对本次目标版本及前提认证，再只读核对原作业；不要重新发送');
    const by = await this.options.records.principals.get(binding.acting_by ?? binding.initiated_by);
    if (!by || by.disabled) return reject('本次认证证据缺少有效的读取主体','联系管理员恢复合法的证据读取主体后只读核对原作业；不要重新发送');
    for (const ref of proof.evidence) {
      try { const source = await this.options.records.artifacts.source(by,ref.slice(4),{consumer:'function'});
        if (!source?.bytes || sha256Hex(source.bytes) !== ref.slice(4)) { await this.journal.append(binding,'premise','validate','completed',{premise,certified:false,member_missing_facts:[{fact:'认证所需的证据文件不可读取或摘要未能核对',next_action:'联系管理员恢复本次认证证据的合法读取及完整性后，再只读核对原作业；不要重新发送'}]}).catch(()=>{}); return false; }
      } catch { await this.journal.append(binding,'premise','validate','completed',{premise,certified:false,member_missing_facts:[{fact:'认证所需的证据文件当前不可读取',next_action:'联系管理员恢复本次认证证据的合法读取后，再只读核对原作业；不要重新发送'}]}).catch(()=>{}); return false; }
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
    if(blocked.length){const actions=await Promise.all(blocked.map(async job=>isFrozen(await this.journal.events(job))?`circle-hub job dispose ${job} --reconcile <原远端编号>`:`circle-hub job resume ${job}`));throw new TargetOccupiedError(blocked,`物理目标被作业 ${blocked.join('、')} 占用；下一步：${actions.join('；')}`);}
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
  /** Which declared keys the lineage does not hold for the whole dispatch window; the one rule dispatch and explain-release share. */
  private async coverage(ancestors: string[], user: string, keys: string[], requiredMs: number): Promise<{ rows: HolderSnapshot[]; missing: string[] }> {
    const rows = await this.options.leases.holderSnapshot(keys);
    const held = (key: string) => rows.some(r => r.key === key && !r.released && r.user === user && ancestors.includes(r.run) && (r.expires_at === null || Date.parse(r.expires_at) > this.now().getTime() + requiredMs));
    const missing = keys.filter(key => !held(key));
    return { rows, missing: missing.length ? missing : rows.length !== keys.length ? keys : [] };
  }
  private async holders(ancestors: string[], user: string, keys: string[], requiredMs: number): Promise<HolderSnapshot[]> {
    const { rows, missing } = await this.coverage(ancestors, user, keys, requiredMs);
    if (missing.length) {
      const occupied=rows.some(row=>missing.includes(row.key)&&!row.released&&(row.expires_at===null||Date.parse(row.expires_at)>this.now().getTime())&&(row.user!==user||!ancestors.includes(row.run)));
      const expired=rows.some(row=>missing.includes(row.key)&&!row.released&&row.user===user&&ancestors.includes(row.run)&&row.expires_at!==null&&Date.parse(row.expires_at)<=this.now().getTime());
      throw new LeaseCoverageError(missing,occupied,expired);
    }
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
      await this.journal.append(binding,'credential_used','read','completed',{name:material.name,version:material.version,variables:[{kind:'secret',at:binding.executor+'#/credential',name:material.name,version:material.version,sealed_sha256:material.sealed_sha256}]});
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
  /**
   * Where the evidence of every row is, at the result's declared pointers, each piece saved on its own and readable by the
   * runner: the log of every row, and the per-device sessions of a row that did not pass. The reference engine reviews a pass
   * by its run log alone (it downgrades a pass whose log shows a command the device refused) and fetches device sessions only
   * for failures, so a passing row keeps its log, kept out of the device return the model reads. Rows that did not pass also
   * go into that device return (the reference compile skill hands the model the failed checks and the session dumps of every
   * non-pass case to attribute the failure). The raw report stays readable by functions only; a session the credential scan
   * holds back leaves the other sessions and the verdicts readable.
   */
  private async rowEvidence(binding: JobBinding, d: ExecutorDefinition, response: { value: unknown; source: string }, items: readonly string[]): Promise<{ found: Map<string, { log?: string; sessions?: Record<string, string> }>; returned: Map<string, ReturnedPiece[]> }> {
    const found = new Map<string, { log?: string; sessions?: Record<string, string> }>(), returned = new Map<string, ReturnedPiece[]>();
    if (!d.result.log && !d.result.sessions) return { found, returned };
    // A session name that is no valid source name (empty, over 300 characters, control characters) gets a positional one,
    // and a piece that cannot be saved is logged and left out: this runs after the receipt, so it must not stall the job.
    const sourceName = (name: string, index: number) => name.length > 0 && name.length <= 300 && !/\p{Cc}/u.test(name) && name.isWellFormed() ? name : `session-${index + 1}.txt`;
    const save = async (id: string, label: string, text: string, name: string, relay: boolean): Promise<string | undefined> => {
      try {
        const { body } = await this.saveText(binding, response.source, text, name);
        if (relay) returned.set(id, [...(returned.get(id) ?? []), { name: label, text: body.read_tier === 'retain_only' ? null : text }]);
        return `src:${body.sha256}`;
      }
      catch (error) { try { this.options.adminLog?.({ traceId: null, run: binding.input?.run ?? binding.run ?? null, what: 'failure evidence ' + binding.job, detail: error instanceof Error ? error.message : String(error) }); } catch { /* logging never stalls the job */ } return undefined; }
    };
    for (const id of items) {
      const { row, reported } = reportOutcome(response.value, d, id);
      if (!object(row)) continue;
      const relay = reported !== 'pass';
      const log = d.result.log ? at(row, d.result.log) : undefined;
      const sessions = relay && d.result.sessions ? at(row, d.result.sessions) : undefined;
      const evidence: { log?: string; sessions?: Record<string, string> } = {};
      if (typeof log === 'string' && log) { const saved = await save(id, '日志', log, 'log.txt', relay); if (saved) evidence.log = saved; }
      if (object(sessions)) for (const [index, [name, text]] of Object.entries(sessions).entries()) if (typeof text === 'string' && text) { const saved = await save(id, sourceName(name, index), text, sourceName(name, index), relay); if (saved) (evidence.sessions ??= {})[name] = saved; }
      if (evidence.log || evidence.sessions) found.set(id, evidence);
    }
    return { found, returned };
  }
  private saveText(binding: JobBinding, source: string, text: string, name: string) {
    return this.options.records.artifacts.ingest({ bytes: new TextEncoder().encode(text), mediaType: 'text/plain; charset=utf-8', origin: { generated: { generator: 'dispatch@1', inputs: [source] } }, author: { user: null }, provenanceType: 'projected', visibility: { readers: [binding.user], admins: true, packs: [], shareable: false }, name });
  }
  /**
   * What the target returned, in one text for the runner: every row's verdict, then the log and device sessions of each row
   * that did not pass, word for word. Judging them is the reader's work, so nothing here picks, groups or interprets them
   * (the reference engine passes device output through whole, with no keyword digest). Only two things touch the text: a
   * piece the credential scan holds back is named and not quoted, so one hit leaves the rest readable, and a piece several
   * rows share is written once.
   */
  private async deviceReturn(binding: JobBinding, source: string, rows: ReadonlyArray<{ item: string; dynamic_terminal: DynamicTerminal }>, returned: ReadonlyMap<string, readonly ReturnedPiece[]>): Promise<string | undefined> {
    const label = (row: { dynamic_terminal: DynamicTerminal }) => labelOf('dynamic_terminal', row.dynamic_terminal);
    const lines = [`作业 ${binding.job} 的设备返回。逐条结论：`, ...rows.map(row => `${row.item}：${label(row)}`)];
    const written = new Map<string, string>();
    for (const row of rows) for (const piece of returned.get(row.item) ?? []) {
      const head = `==== ${row.item}（${label(row)}）${piece.name} ====`;
      if (piece.text === null) { lines.push('', head, '（Hub 的凭据扫描扣住了这一段，这里不引用；管理员能在原件里看）'); continue; }
      const first = written.get(piece.text);
      if (first !== undefined) { lines.push('', head, `（和上面 ${first} 相同）`); continue; }
      written.set(piece.text, `${row.item} ${piece.name}`);
      lines.push('', head, piece.text);
    }
    try { return `src:${(await this.saveText(binding, source, lines.join('\n'), 'device-return.txt')).body.sha256}`; }
    catch (error) { try { this.options.adminLog?.({ traceId: null, run: binding.input?.run ?? binding.run ?? null, what: 'device return ' + binding.job, detail: error instanceof Error ? error.message : String(error) }); } catch { /* logging never stalls the job */ } return undefined; }
  }
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
  private async read(binding: JobBinding, client: RpcClient, role: CallRole, context: Record<string, unknown>, readBack = false,timeoutMs?:number): Promise<Exchange> {
    const result = await client.call(role, context,timeoutMs);
    const op:LeaseOp|undefined=role==='acquire'?'acquire':role==='heartbeat'?'extend':role==='release'?'release':undefined;
    await this.journal.append(binding, role, op?'lease':readBack ? 'read_back' : 'read', 'completed', { ...(op?{op,remote_lease:{id:context.lease_id,token:context.lease_token}}:{}), started_at: result.started_at, ended_at: result.received_at }, [result.source]);
    return result;
  }
  private async retryRead(binding: JobBinding, client: RpcClient, role: CallRole, context: Record<string, unknown>, deadline: number,remainingMs?:()=>number): Promise<Exchange> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { if(remainingMs&&remainingMs()<=0)throw new Error('只读窗口已用尽');return await this.read(binding,client,role,context,false,remainingMs?Math.max(1,Math.min(client.definition.calls[role]?.timeout_ms??30000,remainingMs())):undefined); }
      catch (error) {
        const retry=canRetryRead(error,client.definition,context);
        await this.journal.append(binding, `${role}.retry`, 'read', 'error', { attempt, missing_fact: '本次只读应答不可用，不等于未执行', next_action: retry && attempt < 3 ? '自动重读原作业，绝不重交' : `circle-hub job resume ${binding.job}` });
        if (!retry || attempt === 3 || this.now().getTime() >= deadline || remainingMs&&remainingMs()<=0) throw new Error('原作业只读查询待恢复');
        await this.sleep(remainingMs?Math.max(0,Math.min(client.definition.poll_ms,remainingMs())):client.definition.poll_ms);
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
    if (mapped(d.lease.map, at(response.value, d.lease.acceptance)) !== 'accepted' || !this.opaque(lease.id) || !this.opaque(lease.token) || !Number.isFinite(lease.ttl) || lease.ttl < 3) throw new TargetLeaseError();
    await this.journal.append(binding, 'acquire', 'lease', 'completed', { op:'acquire' satisfies LeaseOp,remote_lease: lease }, [response.source]);this.#leaseClocks.set(lease,{...started,ttl:lease.ttl}); return lease;
  }
  private opaque(value: unknown): boolean { return (typeof value === 'string' && !/[\x00-\x1f\x7f-\x9f]/.test(value) && value.length > 0 && value.length <= 4096 && !value.includes('[已隐藏]')) || (typeof value === 'number' && Number.isSafeInteger(value)); }
  private async assessConditions(binding:JobBinding,conditions:ExecutorDefinition['conditions'],response:Exchange,context:Record<string,unknown>,phase:string):Promise<boolean> {
    const checks=conditions.map(c=>{
      const operator=Object.hasOwn(c,'equals')?'equals':c.at_least!==undefined?'at_least':'sha256';
      const declared=operator==='equals'?c.equals:operator==='at_least'?c.at_least:c.sha256;
      // Bound to a value only a run supplies while none is locked (a precheck without a run): recorded, not judged (decision 120).
      if(runBound(declared).some(key=>context[key]===undefined))return {pointer:c.pointer,operator,expected_sha256:null,matched:null,judged:false};
      let expected:unknown;let matched=false;
      try{expected=bind(declared,context);matched=this.conditions([c],response.value,context);}catch{}
      return {pointer:c.pointer,operator,expected_sha256:expected===undefined?null:digestOfValue(expected),matched};
    });
    const matched=checks.length>0 && checks.every(c=>c.matched===true || 'judged' in c);
    const memberFacts = checks.filter(check=>check.matched===false).map(readConditionFact);
    await this.journal.append(binding,phase,'validate','completed',{matched:checks.length?matched:null,conditions:checks,...(!matched?{member_missing_facts:memberFacts.length?memberFacts:[{fact:'环境只读核对缺少可采用的声明条件',next_action:'请管理员补齐该环境的只读核对声明后重新核验'}],missing_fact:'条件没有满足或缺少期望绑定；见未匹配的指针和运算符',next_action:'核对受限原件和声明条件后重跑预检，未提交'}:{})},[response.source]);
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
    // What the version probe saw before a dispatch is also the device's latest observation (decision 112).
    const observed = d.manifest_sha256 ? (echo: SeatEcho) => this.recordObservation({ inventory: d.manifest_sha256!, ...echo, run: null, job: binding.job, executor: binding.executor, product: d.precheck_context?.product }).then(() => undefined) : undefined;
    return assessProbes(this.options.records,this.options.knowledge,binding,d,client,context,this.journal,this.sleep,observed,await this.bookingReplay(binding,d));
  }
  /**
   * What lets a job read again the version answers its booking kept (probe-replay.ts): the runs it continues, and the leases of
   * the executor's resources as they are held now. None for a read that is no job's (the administrator's precheck) and when a
   * lease is not held now; the job then reads every seat itself.
   */
  private async bookingReplay(binding: JobBinding, d: ExecutorDefinition): Promise<{ ancestors: readonly string[]; leases: string } | undefined> {
    if (!binding.input) return undefined;
    try {
      const rows = await this.options.leases.holderSnapshot(d.resources);
      return leasesLive(rows, this.now().getTime()) ? { ancestors: binding.input.ancestors, leases: leaseGeneration(rows) } : undefined;
    } catch { return undefined; }
  }

  private deviceContext() { return {
      now: this.now,
      options: this.options,
      registry: this.registry,
      observeSeats: this.observeSeats.bind(this),
      assertNoSecrets: this.assertNoSecrets.bind(this),
      secret: this.secret.bind(this),
      session: this.session.bind(this),
      acquire: this.acquire.bind(this),
      context: this.context.bind(this),
      heartbeat: this.heartbeat.bind(this),
      recordObservation: this.recordObservation.bind(this),
      release: this.release.bind(this),
      askDevice: this.askDevice.bind(this),
      activeLeaseJobs: this.activeLeaseJobs.bind(this),
      queued: this.queued.bind(this),
      askSeat: this.askSeat.bind(this),
      certified: this.certified.bind(this),
      journal: this.journal,
      sleep: this.sleep,
      saveText: this.saveText.bind(this),
    };
  }
  /** Stores one device observation whole, found again newest first by its inventory and device pointer (decision 112). */
  async recordObservation(input: deviceOperations.ObservationInput): Promise<DeviceObservation> { return deviceOperations.recordObservation.call(this.deviceContext(), input); }

  /** The newest observation of every version-probe seat of every enabled executor (decision 112); a seat never looked at is absent. */
  async latestDeviceObservations(): Promise<DeviceObservation[]> { return deviceOperations.latestDeviceObservations.call(this.deviceContext()); }

  /**
   * Looks at the installed build of devices a booking was just granted (decision 112): for each enabled executor bound to the
   * same inventory, the version-probe seats that point at a requested device are probed read-only inside one short gateway
   * lease; nothing is dispatched. Each observation is recorded and returned; what could not be looked at is said in `missing`.
   */
  async observeDevices(by: Principal, run: string, targets: ReadonlyArray<{ inventory: string; device: string; label: string }>): Promise<{ observed: DeviceObservation[]; missing: string | null }> { return deviceOperations.observeDevices.call(this.deviceContext(), by, run, targets); }

  private async observeSeats(by: Principal, run: string, registered: RegisteredExecutor, seats: NonNullable<ExecutorDefinition['probes']>['seats'], targets: ReadonlyMap<string, { label: string }>): Promise<DeviceObservation[]> { return deviceOperations.observeSeats.call(this.deviceContext(), by, run, registered, seats, targets); }
  async askDevices(by: Principal, run: string, targets: ReadonlyArray<DeviceHelpTarget>): Promise<DeviceHelpResult[]> { return deviceOperations.askDevices.call(this.deviceContext(), by, run, targets); }

  private async askDevice(by: Principal, run: string, target: DeviceHelpTarget): Promise<DeviceHelpResult> { return deviceOperations.askDevice.call(this.deviceContext(), by, run, target); }

  // The executor has one gateway lease, so concurrent writers must wait their turn.
  private async queued<T>(executor: string, work: () => Promise<T>): Promise<T> {
    const before = this.#asking.get(executor) ?? Promise.resolve();
    let done!: () => void;
    const tail = before.then(() => new Promise<void>((resolve) => { done = resolve; }));
    this.#asking.set(executor, tail);
    await before;
    try { return await work(); }
    finally { done(); if (this.#asking.get(executor) === tail) this.#asking.delete(executor); }
  }

  private async askSeat(by: Principal, run: string, registered: RegisteredExecutor, seat: NonNullable<ExecutorDefinition['probes']>['seats'][number], target: DeviceHelpTarget, asked: AskedLine): Promise<DeviceHelpResult> { return deviceOperations.askSeat.call(this.deviceContext(), by, run, registered, seat, target, asked); }

  private bedContext() { return {
      options: this.options,
      journal: this.journal,
      registry: this.registry,
      latestExecutorHold: this.latestExecutorHold.bind(this),
      frozenValue: this.frozenValue.bind(this),
      readBed: this.readBed.bind(this),
      noteBed: this.noteBed.bind(this),
      openBedHold: this.openBedHold.bind(this),
      getBaseline: this.getBaseline.bind(this),
      effectivelyComplete: this.effectivelyComplete.bind(this),
      restoredReport: this.restoredReport.bind(this),
    };
  }
  private async frozenValue(binding: JobBinding, d: ExecutorDefinition, pointer: string): Promise<unknown> { return bedOperations.frozenValue.call(this.bedContext(), binding, d, pointer); }
  async recordBaseline(by: Principal, executor: string, probeId: string, reason?: string | null): Promise<BedBaselineRecord> { return baselineOperations.recordBaseline.call({ registry: this.registry, options: this.options, now: this.now, getBaseline: this.getBaseline.bind(this), assertNoSecrets: this.assertNoSecrets.bind(this), secret: this.secret.bind(this), session: this.session.bind(this), acquire: this.acquire.bind(this), context: this.context.bind(this), heartbeat: this.heartbeat.bind(this), release: this.release.bind(this) }, by, executor, probeId, reason); }

  async setBaseline(by: Principal, executor: string, probeId: string, text: string, reason?: string | null): Promise<BedBaselineRecord> { return baselineOperations.setBaseline.call(this, by, executor, probeId, text, reason); }

  async getBaseline(executor: string, probeId: string): Promise<BedBaselineRecord | null> { return baselineOperations.getBaseline.call(this, executor, probeId); }

  async listBaselines(by: Principal, executor?: string): Promise<BedBaselineRecord[]> { return baselineOperations.listBaselines.call(this, by, executor); }

  async showBaseline(by: Principal, executor: string, probeId: string): Promise<BedBaselineRecord> { return baselineOperations.showBaseline.call(this, by, executor, probeId); }

  private async readBed(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>, when: 'pre' | 'post'): Promise<BedRead[]> { return bedOperations.readBed.call(this.bedContext(), binding, d, client, context, when); }
  private async noteBed(binding: JobBinding, when: 'pre' | 'post', bed: string, reads: readonly BedRead[], differences: BedReport['differences']): Promise<Record<string, Canonical>> { return bedOperations.noteBed.call(this.bedContext(), binding, when, bed, reads, differences); }
  private async openBedHold(bed: string): Promise<{ job: string; pre: Record<string, Canonical>; pre_reads?: BedRead[] } | null> { return bedOperations.openBedHold.call(this.bedContext(), bed); }

  /** Latest bed_hold for this executor. An open row is the hold an administrator can clear; a later clear hides it. */
  private async latestExecutorHold(executor: string): Promise<{ job: string; bed: string; state: string } | null> { return bedOperations.latestExecutorHold.call(this.bedContext(), executor); }

  /** Append a clear for the executor's open bed hold. Does not rewrite the open record. */
  async clearBedHold(by: Principal, executor: string, reason: string): Promise<{ cleared: false } | { cleared: true; job: string; bed: string }> { return bedOperations.clearBedHold.call(this.bedContext(), by, executor, reason); }
  /** Pre-dispatch bed gate. A residue, an open recovery diff, or a missing probe refuses before any intent. */
  private async gateBed(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>): Promise<void> { return bedOperations.gateBed.call(this.bedContext(), binding, d, client, context); }
  /** An effective complete already sealed this job. A later finish must not release the lease or append another conclusion. */
  private async effectivelyComplete(job: string): Promise<boolean> { return bedOperations.effectivelyComplete.call(this.bedContext(), job); }

  /** The post snapshot that already recorded a restored bed, if this job is sealed. */
  private async restoredReport(job: string): Promise<BedReport | null> { return bedOperations.restoredReport.call(this.bedContext(), job); }

  /** Post-terminal snapshot. Pass/fail stays as reported; only the shared-bed limit moves. */
  private async finishBed(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>): Promise<BedReport | null> { return bedOperations.finishBed.call(this.bedContext(), binding, d, client, context); }
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
      flight=background('renew-lease',async()=>{
        try {
          const response=await client.call('heartbeat',{...this.context(binding),lease_id:lease.id,lease_token:lease.token},Math.max(1,Math.min(d.calls.heartbeat.timeout_ms,Math.floor(lease.ttl/3))));
          const ttl=Number(at(response.value,d.lease.ttl_ms))*d.lease.ttl_scale_ms;
          if(mapped(d.lease.map,at(response.value,d.lease.acceptance))!=='accepted' || !same(at(response.value,d.lease.id),lease.id) || !same(at(response.value,d.lease.token),lease.token) || !Number.isFinite(ttl) || ttl<3)throw new Error('原租约没有有效确认');
          await this.journal.append(binding,'heartbeat','lease','completed',{op:'extend' satisfies LeaseOp,last_confirmed_at:new Date(started.at).toISOString()},[response.source]);
          confirmed={...started,ttl};this.#leaseClocks.set(lease,confirmed);available=true;overrun=false;
        }catch{available=false;notice('目标租约未获确认；后续心跳继续尝试，已发出作业只读恢复');}
      }).finally(()=>{flight=null;});
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
  private async observe(by: Principal, binding: JobBinding, d: ExecutorDefinition, client: RpcClient, remoteId: unknown, fences: HolderSnapshot[], stopHeartbeat: () => Promise<void> = async () => {}, options?: { seal?: boolean; round?: number;execution?:ExecutionReadback }): Promise<JobStatus> {
    const input = binding.input!; const events = await this.journal.events(binding.job); const intent = eventOf(events, 'intent')!;
    const remoteLease = intent.body.detail.remote_lease as unknown as RemoteLease;
    const context = { ...this.context(binding),request_id:intent.body.detail.request_id,not_after:intent.body.detail.not_after, remote_id: remoteId, lease_id: remoteLease.id, lease_token: remoteLease.token };
    const deadline = Date.parse(String(intent.body.detail.not_after)) + d.max_run_ms; let drift = options?.execution?.drift??false;
    for (;;) {
      const response = await this.retryRead(binding, client, 'status', context, deadline);
      const observedHolders=!options?.execution&&!drift?await this.options.leases.holderSnapshot(binding.resources):[];
      if (!options?.execution&&!drift && !this.sameFences(fences, observedHolders)) {
        drift = true; await this.journal.append(binding, 'fencing', 'validate', 'completed', { drift: true,missing_fact:'同一 Hub 租约连续性未证明',next_action:'复用前重新证明基线；当前只读原作业，不重交',expired:observedHolders.some(row=>row.expires_at!==null && Date.parse(row.expires_at)<=this.now().getTime()), note: '派发后租约到期或围栏改变，不能声称保持同一租约；继续只读状态' });
      }
      const mapping = mapped(d.status.map, at(response.value, d.status.pointer));
      if (!trustedStatus(mapping)) { await this.unknown(binding, '目标状态不能作为可信终态（未映射或缺拒绝阶段、未执行证明）；下一步管理员对账', [response.source], { reported_state: mapping ?? null }); return this.status(by, binding.job); }
      if (mapping && (mapping.action_result === 'completed' || mapping.action_result === 'error' || mapping.effect_outcome === 'effective' || mapping.effect_outcome === 'read_back_consistent' || mapping.dynamic_terminal !== undefined)) {
        await this.journal.append(binding, 'terminal', 'read', 'completed', { reported_state: mapping, ...(d.status.exit_code ? { exit_code: at(response.value, d.status.exit_code) ?? null } : {}) }, [response.source]);
        break;
      }
      if (this.now().getTime() >= deadline) {
        if (options?.round !== undefined) await this.noteRound(binding, { round: options.round, terminal: 'incomplete', meets: null, pending: true });
        await this.unknown(binding, '最长运行窗口已过且没有可信终态；下一步管理员对账'); return this.status(by, binding.job);
      }
      await this.sleep(d.poll_ms);
    }
    const reportStart=performance.now(),reportDeadline=this.now().getTime()+REPORT_READ_WINDOW_MS;
    const remaining=()=>REPORT_READ_WINDOW_MS-(performance.now()-reportStart);
    let response=await this.retryRead(binding,client,'result',context,reportDeadline,remaining);
    let pending=false;
    for(let attempt=1;attempt<=REPORT_READ_ATTEMPTS;attempt++){
      // A wrong identity is never a missing report and must take the existing reconciliation exit.
      if(!same(at(response.value,d.result.id),remoteId)||at(response.value,d.result.sha256)!==input.sha256)break;
      if(!reportPending(response.value,d,input.items))break;
      pending=true;
      if(attempt===REPORT_READ_ATTEMPTS||remaining()<=0)break;
      const delay=Math.min(reportReadDelay(d.poll_ms,attempt),Math.max(0,remaining()));
      await this.journal.append(binding,'report_wait','read','completed',{attempt,delay_ms:delay,missing_fact:'原请求报告尚未完整生成',next_action:'自动有界重取原请求状态与报告，绝不重发提交'},[response.source]);
      await this.sleep(delay);
      if(remaining()<=0)break;
      try{
        const status=await this.retryRead(binding,client,'status',context,reportDeadline,remaining),mapping=mapped(d.status.map,at(status.value,d.status.pointer));
        if(!trustedStatus(mapping)){await this.unknown(binding,'补读报告时原请求状态未取得可信映射；只读对账，不重交',[status.source]);return this.status(by,binding.job);}
        response=await this.retryRead(binding,client,'result',context,reportDeadline,remaining);pending=false;
      }catch{await this.journal.append(binding,'report_wait','read','error',{attempt:attempt+1,missing_fact:'报告补读未取得可用应答，已有投递不重交',next_action:`circle-hub job resume ${binding.job}`});break;}
    }
    pending=reportPending(response.value,d,input.items);
    if (!same(at(response.value, d.result.id), remoteId) || at(response.value, d.result.sha256) !== input.sha256) {
      await this.unknown(binding, '结果身份或摘要不符，整份不采信；请管理员对账', [response.source], { observed_outcome: 'read_back_mismatch' }); return this.status(by, binding.job);
    }
    const rows = at(response.value, d.result.items); const complete = at(response.value, d.result.complete) === true;
    const finalHolders=!options?.execution&&!drift?await this.options.leases.holderSnapshot(binding.resources):[];
    if (!options?.execution&&!drift && !this.sameFences(fences, finalHolders)) {
      drift = true; await this.journal.append(binding, 'fencing', 'validate', 'completed', { drift: true,missing_fact:'同一 Hub 租约连续性未证明',next_action:'复用前重新证明基线；当前只读原作业，不重交',expired:finalHolders.some(row=>row.expires_at!==null && Date.parse(row.expires_at)<=this.now().getTime()), note: '结果读取期间租约到期或围栏改变，不能声称保持同一租约' });
    }
    // Post probes need the remote lease. Heartbeats keep it alive; stopping or releasing first makes later probes fail.
    const bed = options?.seal === false && !pending ? null : await this.finishBed(binding, d, client, context);
    await stopHeartbeat();
    if (!options?.execution && await this.effectivelyComplete(binding.job)) return this.status(by, binding.job);
    const leaseInterrupted=options?.execution?(options.execution.lease_interrupted??false):(await this.journal.events(binding.job)).some(e=>e.body.detail.lease_interrupted===true);
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
    const { found: evidence, returned } = await this.rowEvidence(binding, d, response, input.items);
    const projected = input.items.map(id => {
      const resolution=reportOutcome(response.value,d,id),{row,reported}=resolution;
      if(!resolution.check.resolved)try{this.options.adminLog?.({traceId:null,run:binding.input?.run??binding.run??null,what:'result interpretation '+binding.job,detail:JSON.stringify(resolution.check)});}catch{}
      const log = d.result.log ? at(row,d.result.log) : undefined;
      const disposition = dynamicDisposition(reported,{owned:ownership,request:!!d.result.request_id && at(response.value,d.result.request_id) === intent.body.detail.request_id,remote:same(at(response.value,d.result.id),remoteId),digest:at(response.value,d.result.sha256) === input.sha256,complete:complete && Array.isArray(rows) && rows.length === input.items.length,unique:resolution.matches === 1,closed:!!d.result.closing_marker && typeof log === 'string' && log.includes(d.result.closing_marker),device:intent.body.detail.device_identity_proven === true && intent.body.detail.device_lease_digest === digestOfValue([remoteLease.id,remoteLease.token]),continuity:options?.execution?.continuity??(!drift&&!leaseInterrupted)},input.judgments?.length?['conditional_on_judgment']:[]);
      const gaps=disposition.dynamic_terminal==='no_verdict'?unmetPremises(disposition.missing_facts,ownershipUnmet(ownershipObservation,ownershipFailure)):[];
      const named=gaps.length?{missing_fact:gaps.map(gap=>gap.missing_fact).join('；'),next_action:gaps.map(gap=>gap.next_action).join('；')}:{missing_fact:'动态完整性事实尚不齐全；见 missing_facts 和下一步',next_action:'管理员按 unmet_premises 补齐所列前提；本结果保留无判定，不重交'};
      return {item:id,reported_terminal:reported,...disposition,report_check:resolution.check,...(evidence.has(id)?{evidence:evidence.get(id)}:{}),...(input.judgments?.length?{judgment_premises:input.judgments}:{}),...(disposition.dynamic_terminal==='no_verdict'?{unmet_premises:gaps,...(!resolution.check.resolved?{missing_fact:resolution.check.missing_fact!,next_action:resolution.check.next_action!}:!ownership?ownershipFailure:named)}:{}),limits:disposition.qualifier.marks.map(mark=>labelOf('qualifier_mark',mark))};
    });
    const savedLogs = Array.isArray(rows) ? rows.flatMap(row=>[
      ...(d.result.log && typeof at(row,d.result.log)==='string' ? [String(at(row,d.result.log))] : []),
      ...(d.result.sessions && object(at(row,d.result.sessions)) ? Object.values(at(row,d.result.sessions) as Record<string,unknown>).filter((v):v is string=>typeof v==='string') : []),
    ]) : [];
    const sideEffects = d.side_effects.map(declaration=>declaration.marker ? {message:declaration.message,marker_present:savedLogs.some(log=>log.includes(declaration.marker!)),text:savedLogs.some(log=>log.includes(declaration.marker!))?'本次日志里有这一项的标记':'本次日志里没有这一项的标记',reference:response.source,complete,scope:'只核对本次已保存字节中的标记，不推断动作是否发生'} : {message:declaration.message,text:'运行器会这样做（执行器定义声明，Hub 看不见）',provenance:'declared',definition_sha256:digestOfValue(d)});
    if (bed) for (const row of projected) row.limits = [...row.limits, ...bed.limits];
    if (options?.round !== undefined) await this.noteObservedRound(by,binding,d,options.round,projected,complete,pending,!!options.execution);
    if (options?.seal === false&&!pending) return this.status(by, binding.job);
    const roundList = this.roundList(await this.journal.events(binding.job));
    const vocabularyLimits=[...DISPATCH_QUALIFICATIONS,...(input.judgments?.length?['conditional_on_judgment' as const]:[])].map(mark=>labelOf('qualifier_mark',mark));
    const artifact = await this.options.records.artifacts.ingest({ bytes: canonicalBytes({ job: binding.job, sha256: input.sha256, rows: projected,...(pending?{report_pending:true}:{}), ...(roundList.length ? { rounds: roundList } : {}), ownership:ownershipObservation, side_effects:sideEffects, executor_declarations: { provenance: 'declared', definition_sha256: digestOfValue(d), operation_definition_sha256:binding.executor_digest, limitations: d.limitations }, lease_drift:options?.execution?(options.execution.drift??null):drift,lease_interrupted:options?.execution?(options.execution.lease_interrupted??null):leaseInterrupted, qualifier_marks:[...DISPATCH_QUALIFICATIONS,...(input.judgments?.length?['conditional_on_judgment' as const]:[])],limits:[...vocabularyLimits, ...(bed?.limits ?? [])],...(bed?{bed_state:bed}:{}),...(input.judgments?.length?{judgment_premises:input.judgments}:{}) }), mediaType: 'application/json',
      origin: { generated: { generator: 'dispatch@1', inputs: [response.source, `src:${input.sha256}`] } }, author: { user: null }, provenanceType: 'projected', visibility: { readers: [binding.user], admins: true, packs: [], shareable: false } });
    const deviceReturn = await this.deviceReturn(binding, response.source, projected, returned);
    await this.journal.append(binding, 'result', 'read_back', 'completed', {reference:`src:${artifact.body.sha256}`,items:projected.length,...(deviceReturn?{device_return:deviceReturn}:{}),no_verdict:projected.filter(row=>row.dynamic_terminal==='no_verdict').length,report_pending:pending,execution_integrity:options?.execution??{intent:intent.digest,continuity:!drift&&!leaseInterrupted,drift,lease_interrupted:leaseInterrupted}}, [response.source]);
    if(!options?.execution)await this.release(binding,client,remoteLease);
    const unresolved=projected.filter(row=>row.dynamic_terminal==='no_verdict');
    await this.journal.append(binding, 'complete', 'read_back', 'completed', { done: true, outcome: 'effective',...(pending?{report_pending:true,missing_fact:'原请求已执行结束，判定仍缺事实：'+unresolved.map(row=>'missing_fact' in row?row.missing_fact:row.missing_facts.join('、')).join('；'),next_action:unresolved.find(row=>'next_action'in row)?.next_action??`circle-hub job resume ${binding.job}；只读补齐报告，不重交`}:{}),...(!pending&&unresolved.length?{missing_fact:[...new Set(unresolved.map(row=>'missing_fact' in row?row.missing_fact:'动态完整性事实尚不齐全；见 missing_facts'))].join('；'),next_action:[...new Set(unresolved.map(row=>row.next_action))].join('；')}:{} ) });
    return this.status(by, binding.job);
  }

  /** The next round that has not already succeeded. A closed window or an early stop refuses another dispatch. */
  private async openRound(attempts: Event[], count: number): Promise<number> {
    const jobs = [...new Set(attempts.map(event => String(event.body.detail.job)))];
    for (const job of jobs) {
      const events = await this.journal.events(job);
      if (events.some(event => event.body.detail.phase === 'round' && (event.body.detail.early_stop === true || event.body.detail.reason === 'budget_exhausted'))) return count + 1;
    }
    for (let next = 1; next <= count; next++) {
      const ofRound = attempts.filter(event => roundOf(event.body.detail) === next);
      if (!ofRound.length) return next;
      let succeeded = false;
      for (const prior of ofRound) {
        const events = await this.journal.events(String(prior.body.detail.job));
        const end = eventOf(events, 'complete');
        if(projectedResult(events)?.body.detail.report_pending===true)throw new Error(`原轮次报告待补齐；circle-hub job resume ${String(prior.body.detail.job)}；不得重交`);
        const observation=roundRecords(events).find(event=>event.body.detail.round===next);
        if (end && !isFrozen(events) && end.body.detail.outcome === 'effective' && observation?.body.detail.not_started!==true) succeeded = true;
      }
      if (!succeeded) return next;
    }
    return count + 1;
  }

  private async noteRound(binding: JobBinding, detail: Record<string, unknown>): Promise<void> {
    await this.journal.append(binding, 'round', 'validate', 'completed', detail);
  }

  private async noteObservedRound(by: Principal, binding: JobBinding, d: ExecutorDefinition, round: number, projected: Array<{ dynamic_terminal: DynamicTerminal; code?: string }>, complete: boolean,pendingReport=false,refresh=false): Promise<void> {
    const events = await this.journal.events(binding.job);
    const previous=roundRecords(events).find(event=>event.body.detail.round===round);
    if(previous&&(!refresh||!isDynamicTerminal(previous.body.detail.terminal)||previous.body.detail.terminal==='pass'||previous.body.detail.terminal==='fail'))return;
    const terminals = projected.map(row => row.dynamic_terminal);
    const terminal: DynamicTerminal = terminals.length > 0 && terminals.every(item => item === 'pass') ? 'pass' : terminals.some(item => item === 'fail') ? 'fail' : terminals.find(item => item === 'incomplete') ?? terminals.find(item => item === 'no_verdict') ?? 'no_verdict';
    const code = projected.find(row => typeof row.code === 'string')?.code;
    const detail = binding.input ? await this.options.runs.getRun(by, binding.input.run) : null;
    const workflow = detail ? await this.options.workflows.byDigest(detail.run.pack_digest) : null;
    const template = workflow?.requirements.find(row => row.key === d.proof.requirement);
    const expectation = template ? expectationFor(template, {}) : { outcome: 'support' as const, codes: [] as string[] };
    const met = roundMeets(terminal, code, expectation);
    await this.noteRound(binding, { round, terminal, outcome:'effective', ...(code ? { code } : {}), meets: terminal === 'pass' || terminal === 'fail' ? met : null, rows:projected,...(pendingReport?{report_pending:true,pending:true,reason:'missing_input'}:{}),...(complete?{}:{lost:true}) });
  }

  private roundList(events: readonly Event[]) {
    return roundRecords(events).map(event => ({
      round: Number(event.body.detail.round),
      terminal: event.body.detail.terminal,
      ...(typeof event.body.detail.code === 'string' ? { code: event.body.detail.code } : {}),
      meets: event.body.detail.meets === true ? true : event.body.detail.meets === false ? false : null,
      ...(typeof event.body.detail.reason === 'string' ? { reason: event.body.detail.reason } : {}),
      ...(event.body.detail.early_stop === true ? { early_stop: true } : {}),
      ...(event.body.detail.pending === true ? { pending: true } : {}),
      ...(event.body.detail.lost === true ? { lost: true } : {}),
    })).sort((left, right) => left.round - right.round);
  }

  private async intentMatchesLineage(event:Event,input:VerifiedInput):Promise<boolean>{
    const job=Sha256.safeParse(event.body.detail.job);
    if(!job.success)throw new Error('历史派发意图缺少可核验的作业绑定；请管理员恢复记录并对账，不得重交');
    const binding=await this.journal.binding(job.data),prior=binding.input;
    if(binding.job!==job.data||!prior||prior.sha256!==input.sha256||!RunId.safeParse(prior.lineage).success||!Array.isArray(prior.ancestors)||prior.ancestors.length<2||!prior.ancestors.every(id=>RunId.safeParse(id).success)||new Set(prior.ancestors).size!==prior.ancestors.length||prior.ancestors[0]!==prior.run||prior.ancestors[1]!==prior.plan_run||prior.ancestors.at(-1)!==prior.lineage||event.body.run!==prior.run)throw new Error('历史派发意图的血缘绑定不完整或不一致；请管理员恢复记录并对账，不得重交');
    return prior.lineage===input.lineage;
  }

  private async lineageAttempts(input:VerifiedInput):Promise<Event[]>{
    const events=await this.options.records.store.findMany<ActionBody>({kind:'action',key:'dispatch.bytes',values:[input.sha256]}),out:Event[]=[];
    for(const event of events)if(event.body.detail.phase==='intent'&&await this.intentMatchesLineage(event,input))out.push(event);
    return out;
  }

  private async firstIntentAt(input:VerifiedInput): Promise<number | null> {
    const intents = (await this.lineageAttempts(input)).filter(event => roundOf(event.body.detail) === 1);
    const first = [...intents].sort((left, right) => left.created_at < right.created_at ? -1 : 1)[0];
    const at = first ? Date.parse(first.created_at) : NaN;
    return Number.isFinite(at) ? at : null;
  }

  private async outsideWindow(input: VerifiedInput, policy: RoundPolicy): Promise<boolean> {
    if (policy.window_seconds === undefined) return false;
    const first = await this.firstIntentAt(input);
    return first !== null && this.now().getTime() >= first + policy.window_seconds * 1000;
  }

  private async baselineOk(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, remote: RemoteLease): Promise<boolean> {
    const context: Record<string, unknown> = { ...this.context(binding), lease_id: remote.id, lease_token: remote.token };
    try {
      const precheck = await this.retryRead(binding, client, 'precheck', context, Infinity);
      if (!await this.assessConditions(binding, d.conditions, precheck, context, 'precheck.evaluated')) return false;
      if (!await this.extraPrechecks(binding, d, client, context, false)) return false;
      return await this.probeSeats(binding, d, client, context);
    } catch { return false; }
  }

  private async sealRounds(by: Principal, binding: JobBinding, d: ExecutorDefinition, client: RpcClient, remote: RemoteLease, stop: () => Promise<void>, refusal?: {round:number;failure:BoundaryFailure}): Promise<JobStatus> {
    const events = await this.journal.events(binding.job);
    const intent = eventOf(events, 'intent');
    const bed = intent ? await this.finishBed(binding, d, client, { ...this.context(binding), request_id: intent.body.detail.request_id, not_after: intent.body.detail.not_after, lease_id: remote.id, lease_token: remote.token }) : null;
    await stop();
    const notes = roundRecords(events);
    const carried = [...notes].reverse().find(event => Array.isArray(event.body.detail.rows));
    const input = binding.input!;
    const projected = Array.isArray(carried?.body.detail.rows) ? carried.body.detail.rows : input.items.map(item => ({ item, dynamic_terminal: 'not_run' as const, qualifier: { nature: 'unknown' as const, marks: [...DISPATCH_QUALIFICATIONS,...(input.judgments?.length?['conditional_on_judgment' as const]:[])] }, accepted_as_fact: false as const, missing_facts: ['integrity_unproven'] }));
    const rounds = this.roundList(events);
    const early = notes.filter(event => event.body.detail.early_stop === true);
    const passed = notes.find(event => event.body.detail.meets === true);
    const sentence = early.length > 0 && passed ? earlyStopSentence(Number(passed.body.detail.round), early.length) : undefined;
    const refusalFact=refusal?.failure.code==='SOURCE_NOT_PERMITTED'?'前轮已执行，后轮未开始：后续轮次的环境使用权限未成立':refusal?.failure.code==='SOURCE_UNAVAILABLE'?'前轮已执行，后轮未开始：后续轮次的权限核对事实尚未取得':'前轮已执行，后轮未开始：后续轮次的派发前提未满足';
    const refusalNext='读取本次结果引用核对已完成与未开始的轮次；需要恢复权限或核对事实时联系管理员，不要重新发送已执行的轮次';

    const artifact = await this.options.records.artifacts.ingest({ bytes: canonicalBytes({ job: binding.job, sha256: input.sha256, rows: projected,...(input.judgments?.length?{judgment_premises:input.judgments}:{}), ...(rounds.length ? { rounds } : {}), ...(refusal?{round_refusal:{round:refusal.round,error_code:refusal.failure.code,fact:refusalFact,next_action:refusalNext}}:{}), ...(bed ? { bed_state: bed } : {}) }), mediaType: 'application/json',
      origin: { generated: { generator: 'dispatch@1', inputs: [`src:${input.sha256}`] } }, author: { user: null }, provenanceType: 'projected', visibility: { readers: [binding.user], admins: true, packs: [], shareable: false } });
    await this.journal.append(binding, 'result', 'read_back', 'completed', { reference: `src:${artifact.body.sha256}`, items: Array.isArray(projected) ? projected.length : 0 });
    await this.release(binding, client, remote);
    // Round readbacks already recorded their effects. A job summary must not reclassify the last intent's effect.
    await this.journal.append({...binding,input:null,run:input.run}, 'complete', 'read_back', 'completed', { done: true, outcome: events.some(event => event.body.detail.phase === 'intent') ? 'effective' : 'not_dispatched', ...(refusal?{public_reason:'前轮已执行，后轮未开始：'+refusal.failure.message,member_missing_facts:[{fact:refusalFact,next_action:refusalNext}],next_action:`circle-hub job status ${binding.job}`} : sentence ? { public_reason: sentence } : {}) });
    return this.status(by, binding.job);
  }

  private async stopUnstartedRounds(by:Principal,binding:JobBinding,d:ExecutorDefinition,client:RpcClient,remote:RemoteLease,stop:()=>Promise<void>,first:number,count:number,failure:BoundaryFailure,admittedButUnsent=false):Promise<JobStatus> {
    for(let round=first;round<=count;round++)await this.journal.append(binding,'round','validate','error',{round,terminal:'not_run',meets:null,reason:'missing_input',not_started:true,...(admittedButUnsent&&round===first?{outcome:'not_dispatched',submit_invoked:false}:{})},[],undefined,undefined,failure.code);
    return this.sealRounds(by,binding,d,client,remote,stop,{round:first,failure});
  }

  private async continueRounds(args: {
    by: Principal; run: string; executor: string; binding: JobBinding; d: ExecutorDefinition;
    gate: Awaited<ReturnType<typeof prepareEffectGate>>; policy: RoundPolicy;
    source: ArtifactSource | null; initial: HolderSnapshot[]; input: NonNullable<JobBinding['input']>;
    registered: { digest: string; resolved_digest: string }; secret: string; round: number; deviceIdentity: boolean;
    flags: { intended: boolean; submitInvoked: boolean };
    hold: { setStop: (fn: () => Promise<void>) => void; setSession: (client: RpcClient) => void; setRemote: (value: RemoteLease) => void };
    session: RpcClient; remote: RemoteLease; pulse: Heartbeat; fresh: HolderSnapshot[];
  }): Promise<JobStatus> {
    let { session, remote, pulse, deviceIdentity } = args;
    const { by, binding, d, policy, hold } = args;
    const events = await this.journal.events(binding.job);
    if (policy.aggregation === 'first_pass' && events.some(event => event.body.detail.phase === 'round' && event.body.detail.round === args.round && event.body.detail.meets === true)) {
      for (let skipped = args.round + 1; skipped <= policy.count; skipped++) await this.noteRound(binding, { round: skipped, terminal: 'not_run', meets: null, early_stop: true });
      return this.sealRounds(by, binding, d, session, remote, pulse.stop);
    }
    for (let next = args.round + 1; next <= policy.count; next++) {
      await this.options.beforeRound?.(next);
      if (await this.outsideWindow(args.input, policy)) {
        for (let skipped = next; skipped <= policy.count; skipped++) await this.noteRound(binding, { round: skipped, terminal: 'not_run', meets: null, reason: 'budget_exhausted' });
        break;
      }
      const useFailure=await this.environmentUseFailure(args.input.user,binding.executor);
      if(useFailure)return this.stopUnstartedRounds(by,binding,d,session,remote,pulse.stop,next,policy.count,useFailure);
      if (!roundAllowed(next, policy)) return this.stopUnstartedRounds(by,binding,d,session,remote,pulse.stop,next,policy.count,deny(4, 'EFFECT_BUDGET_EXHAUSTED', `第 ${next} 轮超过冻结次数或效果行的重复预算；请开始新修订`, args.gate.context.effects.find(row => row.release.requirements.includes(d.proof.requirement))));
      if (policy.fresh_context) {
        await pulse.stop();
        await this.release(binding, session, remote);
        session = this.session(binding, d, args.secret);
        hold.setSession(session);
        await session.connect();
        remote = await this.acquire(binding, d, session, this.context(binding));
        hold.setRemote(remote);
        pulse = this.heartbeat(binding, d, session, remote);
        hold.setStop(pulse.stop);
      }
      if (policy.baseline_first || policy.fresh_context) {
        const ok = await this.baselineOk(binding, d, session, remote);
        if (!ok && policy.baseline_first) { await this.noteRound(binding, { round: next, terminal: 'not_run', meets: null, reason: 'integrity_unproven' }); continue; }
        if (!ok) throw new Error('设备版本、接口或残留核对有误。管理员查看设备输出后重新核对测试环境');
        deviceIdentity = true;
      }
      let status:JobStatus|BoundaryFailure;
      try { status=await this.submitRound({ ...args, session, remote, pulse, round: next, deviceIdentity }); }
      catch(error){if(error instanceof EffectBoundaryError)return this.stopUnstartedRounds(by,binding,d,session,remote,pulse.stop,next,policy.count,error.failure);throw error;}
      if('ok' in status)return this.stopUnstartedRounds(by,binding,d,session,remote,pulse.stop,next,policy.count,status);
      if (status.report_pending||status.frozen || status.outcome === 'unknown' || status.outcome === 'not_dispatched' || status.outcome === 'target_rejected' || status.outcome === 'proven_not_executed') return status;
      const noted = await this.journal.events(binding.job);
      if (policy.aggregation === 'first_pass' && noted.some(event => event.body.detail.phase === 'round' && event.body.detail.round === next && event.body.detail.meets === true)) {
        for (let skipped = next + 1; skipped <= policy.count; skipped++) await this.noteRound(binding, { round: skipped, terminal: 'not_run', meets: null, early_stop: true });
        break;
      }
    }
    return this.sealRounds(by, binding, d, session, remote, pulse.stop);
  }

  /** One later round: a new pre-effect boundary, its own intent, then a read of that round. It does not close the job. */
  private async submitRound(args: {
    by: Principal; run: string; executor: string; binding: JobBinding; d: ExecutorDefinition;
    gate: Awaited<ReturnType<typeof prepareEffectGate>>; policy: RoundPolicy;
    source: ArtifactSource | null; initial: HolderSnapshot[]; input: NonNullable<JobBinding['input']>;
    registered: { digest: string; resolved_digest: string }; secret: string; round: number; deviceIdentity: boolean;
    flags: { intended: boolean; submitInvoked: boolean }; session: RpcClient; remote: RemoteLease; pulse: Heartbeat; fresh: HolderSnapshot[];
  }): Promise<JobStatus|BoundaryFailure> {
    const { by, run, executor, binding, d, gate, source, initial, input, registered, session, remote, pulse, round, deviceIdentity, flags } = args;
    const context: Record<string, unknown> = { ...this.context(binding), lease_id: remote.id, lease_token: remote.token, payload_base64: Buffer.from(source?.bytes ?? []).toString('base64') };
    let fresh: HolderSnapshot[];
    try { fresh = await this.holders(input.ancestors, input.user, d.resources, d.submit_timeout_ms + d.max_run_ms); }
    catch { throw new EffectBoundaryError(deny(5, 'LEASE_EXPIRED', '资源租约已到期或不再覆盖窗口；请恢复租约并重证基线')); }
    if (!this.sameFences(initial, fresh)) throw new EffectBoundaryError(deny(5, 'FENCING_STALE', '派发前围栏已变；请重新证明基线'));
    const currentProof = await verifyInput(by, run, d, this.options.records, this.options.runs, this.options.workflows, this.now());
    if (!same({ ...input, result: null }, { ...currentProof, result: null })) throw new InputVerificationError('只读核对期间这个运行的最新核验结果改变了，没有提交');
    const notAfter = new Date(this.now().getTime() + d.submit_timeout_ms).toISOString();
    const sequence = (await this.options.records.store.findMany({ kind: 'action', key: 'dispatch.lineage', values: [input.lineage] })).filter(event => (event.body as { detail?: { phase?: string } }).detail?.phase === 'intent').length + 1;
    const attempt = 1;
    const key = digestOfValue([input.lineage, input.item, d.proof.slot, round]);
    context.request_id = `${key}:${attempt}`; context.not_after = notAfter;
      context.sequence_scope = binding.executor; context.dispatch_sequence = await this.journal.nextDispatchSequence(binding);
    const finalBoundary = { ...gate.context,
      lease: async () => { if (!pulse.held()) return { ok: false as const, code: 'LEASE_EXPIRED', message: '目标租约心跳或确认时效中断；请恢复租约并重证基线' }; const current = await this.options.leases.holderSnapshot(d.resources); return this.sameFences(initial, current) ? { ok: true as const } : { ok: false as const, code: 'FENCING_STALE', message: 'Hub 围栏改变；请重证基线后开新修订' }; },
      content: async proof => !!source?.bytes && !!source.mediaType && proof.sha256 === input.sha256 && verifiedContent(source.bytes, input.sha256, source.mediaType),
      audience: async () => !d.calls.submit.write?.audience } satisfies import('./boundary.ts').BoundaryContext;
    const boundary = await checkEffectBoundary(finalBoundary);
    if (!boundary.ok || boundary.checked !== 9) { const failure = boundary.ok ? incompleteEffectBoundary(boundary) : boundary; return failure; }
    const intentSemantics: { effect_class: EffectClass; retry_safety: RetrySafety; signing: Signing } = { effect_class: d.calls.submit.write?.effect_class ?? 'job', retry_safety: d.calls.submit.write?.retry_safety ?? 'unsafe', signing: d.calls.submit.write?.signing ?? 'service_on_behalf' };
    const actionDigest = digestOfValue({ content: input.sha256, tool: d.calls.submit.tool, arguments: session.prepareSubmit(context) });
    if (!pulse.held()) throw new Error('目标租约中断或近期确认已过期；恢复租约后重新预检，尚未提交');
    try {
      await this.options.records.store.withTransaction(async tx => {
        await lockExecutorConfiguration(this.options.records.store, tx, binding.executor, binding.resources, [d.target], [new URL(d.endpoint).origin]);
        await this.options.records.variables.lockNames((binding.variables ?? []).map(use => use.name), tx);
        const config = await this.options.records.store.find<AuthorizationRecord['body']>({ key: 'authz.key', value: `resource_config|${WHOLE_HUB}|executor.${binding.executor}`, kind: 'authorization', newestFirst: true, limit: 1 }, tx);
        if (config.items[0]?.body.revoked || config.items[0]?.body.bound !== registered.digest) throw new PrecheckFactError('执行器配置已变；未提交，请按当前配置重新核验', '用当前配置重新核验后再派发；没有提交');
        const useFailure=await this.environmentUseFailure(input.user,binding.executor,tx);if(useFailure)throw new EffectBoundaryError(useFailure);
        await gate.reserveBudget(boundary.row, tx);
        const permitted = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: true }, [], `dispatch.gate:${binding.job}:${round}`, tx);
        if (!permitted.created) throw new Error('作业已经恢复或关闭，不能再提交');
        const ordinal = await this.journal.append(binding, 'sequence', 'validate', 'completed', { sequence }, [], `dispatch.sequence:${input.lineage}:${sequence}`, tx);
        if (!ordinal.created) throw new Error('血缘次序已由另一派发占用；未提交');
        const intent = await this.journal.append(binding, 'intent', 'dispatch', 'completed', { effect_row: boundary.row.id, effect_duration_ms: d.max_run_ms, intent_key: key, verification_result: currentProof.result, request_id: context.request_id, dispatch_sequence:context.dispatch_sequence,sequence_scope:context.sequence_scope, device_identity_proven: !!d.probes && deviceIdentity, device_lease_digest: digestOfValue([context.lease_id, context.lease_token]), attempt, round, not_after: notAfter, sequence, action_digest: actionDigest,
          dispatch_binding_digest: digestOfValue([input.run, input.item, input.sha256, fresh, remote]), target_key: binding.target_key, ...intentSemantics, on_behalf_of: input.user,
          before_state_bound: false, before_state: { bound: false, sha256: null, reference: null }, fences: fresh, remote_lease: remote, window: { from: this.now().toISOString(), to: notAfter } }, [`src:${input.sha256}`, `rec:${currentProof.result}`], bytesKey(input.sha256, round, attempt, true,input.lineage), tx);
        if (!intent.created) throw new Error('这份字节已经写过意图；未重复提交');
      });
    } catch (error) {
      if (error instanceof EffectBoundaryError) return error.failure;
      throw error;
    }
    flags.intended = true;
    if (!pulse.held() || this.now().getTime() >= Date.parse(notAfter)) return this.stopUnstartedRounds(by,binding,d,session,remote,pulse.stop,round,args.policy.count,deny(5,'LEASE_EXPIRED','后续轮次的目标租约确认或投递窗口已失效，本轮尚未调用提交'),true);
    const ignore = () => {}; process.on('SIGINT', ignore); process.on('SIGTERM', ignore); process.on('SIGHUP', ignore);
    let answer: Exchange;
    try {
      flags.submitInvoked = true;
      answer = await session.call('submit', context, Math.max(1, Date.parse(notAfter) - this.now().getTime()));
    } finally { process.off('SIGINT', ignore); process.off('SIGTERM', ignore); process.off('SIGHUP', ignore); }
    const accepted = !answer.tool_error && mapped(d.receipt.map, at(answer.value, d.receipt.acceptance)) === 'accepted';
    const remoteId = at(answer.value, d.receipt.id);
    if (!accepted || ((typeof remoteId !== 'string' && typeof remoteId !== 'number') || !String(remoteId)) || at(answer.value, d.receipt.sha256) !== input.sha256 || !same(at(answer.value, d.receipt.items), input.items)) {
      await this.unknown(binding, '后续轮次没有完整可信回执；须按原请求记录核对，不能重交', [answer.source]); return this.status(by, binding.job);
    }
    await this.journal.append(binding, 'receipt', 'read', 'completed', { remote_id: remoteId, acceptance: 'accepted', outcome: 'issued', round }, [answer.source]);
    return this.observe(by, binding, d, session, remoteId, fresh, async () => {}, { seal: false, round });
  }
}
