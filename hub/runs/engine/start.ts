import {commandPolicyForRoot} from './command-policy.ts';
import {criterionNotices,freezeCriteria,prepareCriterionReview} from './criterion-changes.ts';
import {defaultPredecessorInputs} from './predecessor-defaults.ts';
import { PublishableRequirementsFile } from '../../../contracts/src/pack.ts';
import { recordResultRequests, putRequest, answerSuccessorRequests } from './requests.ts';
import { authorOriginOf } from './lineage.ts';
import type { ExecutionHost } from '../../../contracts/generated/vocabulary.ts';
// start_run (W06): check the arguments, answer a repeated client key, authorize the pack, fix the target, bind the inputs,
// project the items, bind the expected sources, offer carry-overs, freeze everything in a run record and, for a pack whose
// requirements are all facts, compute the validation result at once (a production run; the same path serves runs the Hub
// executes for a standing obligation) and answer it as StartRunOutput.result. A client key repeated inside its window returns
// the same run and the same production result, even after the pack was unassigned (the run stays its runner's); other content
// under the same key is IDEMPOTENCY_MISMATCH. Arguments the records cannot hold are refused before anything is read, and
// nothing is stored that a record could not hold.
import { z } from 'zod';
import { NatureSchema, VerdictSchema, isSourceRole, type SourceRole } from '../../../contracts/generated/vocabulary.ts';
import { Ground } from '../../../contracts/src/reference.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { KnownBuild } from '../../../contracts/src/product.ts';
import type { ContextBuild, RequirementTemplate, RunContext, ProjectionOutput } from '../../../contracts/src/pack.ts';
import { RunRecord, RunSummary, type RequirementSummary, type RunRecordView } from '../../../contracts/src/run.ts';
import { StartRunInput, type StartRunOutput } from '../../../contracts/src/tools.ts';
import { partitionCountsOf, type PartitionCounts, type ValidationResult } from '../../../contracts/src/validation.ts';
import { CanonicalizationError, RecordsError, LimitError, scanForCredentials, canonicalize, newId, type VariableSnapshot, type Principal, type StoredRecord } from '../../records/api.ts';
import type { CallContext, LoadedWorkflow, Untraced } from '../../ports.ts';
import { parseReference, prefetchReferences, recReference, resolveReference } from '../../refs/api.ts';
import type { EngineContext } from './deps.ts';
import { Refusal, describe, protocolError, unavailable } from './errors.ts';
import { productionEvaluationInput, evaluate, type Evaluation } from './evaluate.ts';
import { factClaim, sourceCoverage, rootDigest, strongestRole } from './claims.ts';
import { buildScope, createResolver } from './exact.ts';
import { bindInputs } from './inputs.ts';
import { foreignArtifacts, packIdOf } from './lineage.ts';
import { bindExpected, projectItems } from './projection.ts';
import { canSeeRun, canViewRun, identityOf, recordReader, runOfRecord, sourceReader } from './readers.ts';
import { reuseOffers } from './reuse.ts';
import { issuesOf, packSchema, schemaProblems, slotSchemaOf } from './slots.ts';
import { actionsOf, keyOwner, putAction, putResult, putRun, resultFor, runByClientKey, runById, runRecordDigest } from './store.ts';
import { resolveTarget } from './target.ts';
import { repairRounds } from './terminals.ts';
import { dispatchCountOf, repetitionSummary } from './repetition.ts';
import { clipPointer, isObject, pointerOf, receivedDigest, sessionOf } from './util.ts';

export type StartRunAnswer = Untraced<z.infer<typeof StartRunOutput>>;

/** The validation result a production run computed at start_run, readable by reference. */
export interface ProductionResult {
  /** rec:<digest> of the validation_result record. */
  reference: string;
  record: string;
  result: ValidationResult;
  counts: PartitionCounts;
}

export interface StartRunDetail {
  /** The tool answer; for a production run it carries `result` ({reference, counts}, StartRunOutput.result). */
  answer: StartRunAnswer;
  /** Present for a run whose requirements are all facts: the result the Hub computed at once. */
  production: ProductionResult | null;
  /**
   * Digest of the run record (its items, procedure and slot schema are readable by rec: reference); null when refused. Always
   * set by the engine; optional so that callers holding an older detail keep compiling.
   */
  runRecord?: string | null;
  /** Expected sources the pack named that could not be bound: the run's evidence gaps (the reason only in the admin log). */
  unavailable?: { external: string; role: SourceRole }[];
  /**
   * What the pack's expected-sources function reported, its failure included (runs.expected_sources_failed: no expected
   * source was bound): further evidence gaps, as code and Chinese message. At most 100, like the parse action keeps them.
   */
  gaps?: { code: string; message: string }[];
}

export interface StartMode {
  /** local_circle for a caller's session; hub for a standing obligation the Hub executes (W06 F[1], W09 R[3]). */
  host: Extract<ExecutionHost, 'local_circle' | 'hub'>;
}

/** A pack whose requirements are all facts needs no model input: start_run computes its result (production run). */
export function isProduction(workflow: LoadedWorkflow): boolean {
  return workflow.requirements.every((r) => r.accepted_producer === 'fact');
}

/** The frozen summary of one requirement; `repetition` carries V07's policy in force, from the same projection the pack
 * listing uses, so a listing and a frozen run cannot disagree. */
export function requirementSummary(t: RequirementTemplate, ledger?: import('../../../contracts/src/pack.ts').LedgerFile | null, checks: readonly import('../../../contracts/src/pack.ts').CheckEntry[] = [], pack = '', repetition?: { workClass?: import('../../../contracts/generated/vocabulary.ts').WorkClass; effects?: readonly import('../../../contracts/src/pack.ts').AllowedEffect[] }): RequirementSummary {
  return { ...(t.independence_by_account?{independence_by_account:true}:{}), repetition: repetitionSummary({ workClass: repetition?.workClass, layers: t.layers, declared: t.repetition, dispatchCount: dispatchCountOf(repetition?.effects ?? [], t.key), fresh_context: t.repetition?.fresh_context, baseline_first: t.repetition?.baseline_first, window_seconds: t.repetition?.window_seconds }), key: t.key, name: t.name, description: t.description, layers: t.layers, done_rule: t.done_rule, accepted_producer: t.accepted_producer, rules: t.checks.flatMap(id=>{const c=checks.find(check=>check.id===id);return c ? [c.interpreter ?? `${pack.split('@')[0]}.${c.id}@${pack.split('@')[1]}`] : [];}), run_interpreters: t.run_table ? (ledger?.shapes.filter(row=>row.requirement===t.key).map(row=>row.interpreter) ?? []) : [], repair_rounds: repairRounds(t), ...(t.observation?{observation:t.observation}:{}) };
}

/** The summary part of a run record, as start_run returns it (the frozen context extras — groups, builds — stay out). */
export class MissingRulingSummaryError extends RecordsError {
  constructor(record:RunRecord,requirement:string){
    super(`旧运行的要求项 ${requirement} 缺少锁定任务包的判定声明`,{code:'SOURCE_UNAVAILABLE',fix:'请管理员从备份恢复该运行锁定的任务包原件，再重新读取或复用运行',detail:{pack_digest:record.pack_digest,requirement}});
    this.name='MissingRulingSummaryError';
  }
}
export function hasRulingSummary(record:RunRecord):record is RunRecordView {
  return record.requirements.every(row=>row.rules!==undefined && row.run_interpreters!==undefined);
}
export function summaryOf(record: RunRecord, workflow?:Pick<LoadedWorkflow,'pack'|'requirements'|'checks'|'ledger'> & { workflow?: Pick<import('../../../contracts/src/pack.ts').WorkflowFile,'work_class'>; effects?: LoadedWorkflow['effects'] }): RunSummary {
  const {product_pack_digest:_productPackDigest,command_policy:_commandPolicy,accepted_criteria:_ac,criterion_requests:_cr,criterion_review:_cv,predecessor_access:_pa, runner: _r, host: _h, trigger: _t, configurer: _c, parameters: _p, policy: _po, executors: _e, groups: _g, builds: _b, client_key: _k, request_digest: _d, client_key_expires_at: _x, leases: _l, lease_context: _lc, lease_registrations: _lr, ...summary } = record;
  const requirements=record.requirements.map(row=>{
    if(row.rules!==undefined && row.run_interpreters!==undefined)return row;
    const template=workflow?.requirements.find(t=>t.key===row.key);
    if(!workflow || !template || workflow.pack.digest!==record.pack_digest || `${workflow.pack.id}@${workflow.pack.version}`!==record.pack)throw new MissingRulingSummaryError(record,row.key);
    const ruling=requirementSummary(template,workflow.ledger,workflow.checks,`${workflow.pack.id}@${workflow.pack.version}`,{workClass:workflow.workflow?.work_class,effects:workflow.effects ?? []});
    return {...row,rules:ruling.rules,run_interpreters:ruling.run_interpreters};
  });
  return RunSummary.parse({...summary,requirements});
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The builds of the bound product for a workflow that asked (workflow.context): every build the knowledge base knows, both
 * name families, an alias carrying its base, sorted by (line, built_at, name); null when the workflow did not ask or the run
 * is bound to no product — absent then means "not asked", never an empty list.
 */
export async function contextBuilds(ctx: EngineContext, workflow: LoadedWorkflow, product: string | null, snapshot?: readonly KnownBuild[]): Promise<ContextBuild[] | null> {
  if (product === null || !(workflow.workflow.context ?? []).includes('builds')) return null;
  const known = snapshot ?? await ctx.deps.knowledge.builds(product);
  return known
    .map((b) => ({ name: b.name, family: b.family, line: b.line, base: b.base, platform: b.platform, built_at: b.built_at, released_at: b.released_at, has_root: b.root !== null }))
    .sort((a, b) => compareText(a.line, b.line) || compareText(a.built_at ?? '', b.built_at ?? '') || compareText(a.name, b.name));
}

/** The frozen lease rows of the workflow's declared prefix (W06, D04 R[0]), for the run context; null when it did not ask. */
export async function contextLeases(ctx: EngineContext, workflow: LoadedWorkflow, user: Principal): Promise<NonNullable<RunContext['leases']> | null> {
  if (!(workflow.workflow.context ?? []).includes('leases')) return null;
  if (!ctx.deps.leases || !ctx.deps.leaseJobs) throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION','租约或只读作业端口未配置',{path:'/pack',fix:'请管理员配置租约服务和按键只读作业端口后重开运行'})]);
  const prefix=workflow.workflow.leases?.prefix ?? workflow.pack.id+'/';
  const registered=await ctx.deps.leases.registrations(prefix);
  const rows=(await ctx.deps.leases.view(prefix,true)).entries;
  const jobs=await ctx.deps.leaseJobs(rows.map(row=>row.key));
  const identity=async(id:string)=>{
    const record=await ctx.deps.records.principals?.get(id);
    if(!record)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION','持有人用户资料缺失',{path:'/pack',fix:'请管理员恢复用户资料后重开运行'})]);
    return {user:id,name:record.name};
  };
  return {now:ctx.now().toISOString(),entries:await Promise.all(rows.map(async row=>({key:row.key,since:row.since,until:row.until,run:row.run,mine:false,
    jobs:jobs.filter(job=>job.key===row.key).map(job=>job.job),
    ...(user.role==='admin'||registered.some(r=>r.owner===user.id&&row.key.startsWith(r.prefix))?{holder:await identity(row.user)}:{})}))),
    registrations:await Promise.all(registered.map(async row=>({prefix:row.prefix,mine:row.owner===user.id,...(user.role==='admin'?{owner:await identity(row.owner)}:{})})))};
}

/** Grants the projection's lease requests for the workflow's declared prefix and cap (C3); a refusal answers LEASE_*
 * with the earliest free moment. Returns the granted leases for the run record. */
export type LeaseRequest = NonNullable<Extract<z.infer<typeof ProjectionOutput>,{items:unknown}>['lease_requests']>[number];
export type LeaseDone = NonNullable<RunRecord['leases']>[number];
const requestKeys = (request: LeaseRequest): string[] => 'keys' in request ? request.keys : [request.prefix];

/** The run ids of this run's lineage: itself and up to 20 predecessors (D04 R[0]: a booking lease is held by the lineage). */
async function lineageOf(ctx: EngineContext, runId: string, predecessor: string | undefined): Promise<Set<string>> {
  const lineage = new Set<string>([runId]);
  let at: string | undefined = predecessor;
  for (let depth = 0; depth < 20 && at !== undefined; depth++) {
    lineage.add(at);
    const record = await runById(ctx.deps.records.store, at);
    at = record?.body.predecessor_access==='view'?undefined:record?.body.predecessor;
  }
  return lineage;
}

export async function grantLeases(
  ctx: EngineContext,
  user: Principal,
  workflow: LoadedWorkflow,
  requests: ReadonlyArray<LeaseRequest>,
  runId: string,
  predecessor: string | undefined,
): Promise<Array<LeaseDone>> {
  if (requests.length === 0) return [];
  if (ctx.deps.leases === undefined) throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', `任务包 ${workflow.pack.id} 的投影要租约，但这个 Hub 没有配置租约服务`, { path: '/pack', fix: '请管理员配置租约服务' })]);
  const declared = workflow.workflow.leases;
  if (declared === undefined) {
    throw new Refusal([
      protocolError('SUBMISSION_SCHEMA_VIOLATION', `任务包 ${workflow.pack.id} 的投影要租约，但这个工作流没有声明 leases`, { path: `/inputs/${workflow.workflow.subject}`, fix: '联系任务包作者：要租约的工作流在 workflow.json 里声明 leases' }),
    ]);
  }
  const prefix = declared.prefix; const cap = declared.max_ttl_seconds;
  const now = ctx.now(); const service=ctx.deps.leases;
  const lineage=await lineageOf(ctx,runId,predecessor);
  const rows=await service.holders([...new Set(requests.flatMap(requestKeys))]);
  const registered=await service.registrations(prefix);
  function refuse(code:ProtocolError['code'],message:string,fix:string):never { throw new Refusal([{code,message,fix}]); }
  // Validate the entire operation list before any irreversible mutation.
  for(const request of requests){
    const keys=requestKeys(request); const op=request.op ?? 'acquire';
    if(!keys.length || new Set(keys).size!==keys.length || keys.some(key=>!key.startsWith(prefix)))refuse('LEASE_PREFIX','租约键不在声明的前缀下或有重复', '每个键仅写一次，且以前缀 '+prefix+' 开头');
    if(request.op==='register'){
      if(!request.prefix.endsWith('/') || request.prefix===prefix || !/^[a-z0-9][a-z0-9:._/-]{0,199}$/.test(request.prefix))refuse('LEASE_UNAVAILABLE','登记前缀须以 / 结尾并严格在声明前缀下','改用声明前缀下的键前缀');
      if(registered.some(row=>row.prefix.startsWith(request.prefix)||request.prefix.startsWith(row.prefix)))refuse('LEASE_UNAVAILABLE','这个前缀已经有主人或与已有登记互相包含','请管理员核对登记；不要重复登记');
      if(requests.some(other=>other!==request && other.op==='register' && (other.prefix.startsWith(request.prefix)||request.prefix.startsWith(other.prefix))))refuse('LEASE_UNAVAILABLE','同一请求里的登记前缀不能互相包含','每个互不包含的前缀只登记一次');
      continue;
    }
    if(request.op==='unregister'){
      const owner=registered.find(row=>row.prefix===request.prefix);
      if(!owner || user.role!=='admin'&&owner.owner!==user.id)refuse('LEASE_UNAVAILABLE','这个前缀不能由你注销','由主人或管理员带理由注销');
      if((await service.view(request.prefix)).entries.length)refuse('LEASE_UNAVAILABLE','这个前缀还有未释放的租约','先强制释放，或等它释放');
      continue;
    }
    if(request.op==='force_release'){
      if(!request.reason.trim())refuse('LEASE_UNAVAILABLE','强制释放须写理由','reason 写用户原话');
      for(const key of keys){
        if(user.role!=='admin'&&!registered.some(row=>row.owner===user.id&&key.startsWith(row.prefix)))refuse('LEASE_UNAVAILABLE','这些键不在你登记的前缀下','由主人或管理员带理由强制释放');
        const row=rows.find(r=>r.key===key);
        if(!row||row.released||(row.expires_at!==null&&Date.parse(row.expires_at)<=now.getTime()))refuse('LEASE_UNAVAILABLE','要强制释放的键没有未释放的租约','重新读取当前占用再决定是否释放');
      }
      if(!ctx.deps.leaseJobs)refuse('LEASE_UNAVAILABLE','缺少未终态作业事实','请管理员配置按键只读作业端口后重开运行');
      const jobs=await ctx.deps.leaseJobs!(keys);
      if(jobs.length)refuse('LEASE_UNAVAILABLE','作业 '+jobs.map(j=>j.job).join('、')+' 还没有终态，本地释放停不了网关上的作业','等它结束，或者请管理员用 circle-hub job status 看、用 job dispose 处置');
      continue;
    }
    if(op!=='release'){
      if(cap===undefined){if(op==='extend')refuse('LEASE_TTL','这个前缀的租约不到期，不用续','不用续期，用完由血缘释放');}
      else {const ttl='ttl_seconds' in request?request.ttl_seconds:undefined;if(!Number.isInteger(ttl)||ttl!<=0||ttl!>cap)refuse('LEASE_TTL','租约期限要在 1 到 '+cap+' 秒之间','缩短租约期限，或请任务包作者调高上限');}
    }
    if(op==='acquire')continue;
    for(const key of keys){const row=rows.find(r=>r.key===key);
      if(!row||row.user!==user.id||!lineage.has(row.run))refuse('LEASE_UNAVAILABLE','租约不在这次运行的血缘持有之下','由预订运行或同一用户的后继运行来续期或释放');
      if(row!.released||row!.expires_at!==null&&Date.parse(row!.expires_at)<=now.getTime())refuse('LEASE_EXPIRED','租约已释放或过期','重新取得租约并重新证明基线');
    }
  }
  const done:LeaseDone[]=[]; const acquired:string[]=[];
  const compensate=async()=>{if(acquired.length)await service.release({keys:acquired,holder:{user:user.id,run:runId}}).catch(()=>undefined);};
  try{
    for(const request of requests){
      if(request.op==='register'||request.op==='unregister'){
        const outcome=request.op==='register'?await service.register({prefix:request.prefix,declaredPrefix:prefix,owner:user.id,by:user.id,reason:'用户登记'}):await service.unregister({prefix:request.prefix,by:user.id,admin:user.role==='admin',reason:request.reason});
        if(!outcome.ok)refuse(outcome.code,outcome.message,'重新读取登记状态，注销前先强制释放，或等它释放');
        done.push({op:request.op,prefix:request.prefix,owner:outcome.owner});
      }
      if(request.op==='force_release'){
        const outcome=await service.forceRelease({keys:request.keys,by:user.id,reason:request.reason,guard:async()=>{
          const jobs=await ctx.deps.leaseJobs!(request.keys);
          if(jobs.length)refuse('LEASE_UNAVAILABLE','作业 '+jobs.map(job=>job.job).join('、')+' 还没有终态，本地释放停不了网关上的作业','等它结束，或者请管理员用 circle-hub job status 看、用 job dispose 处置');
        },...(user.role==='admin'?{}:{owner:user.id})});
        if(!outcome.ok)refuse(outcome.code,outcome.message,'重新读取占用和登记后再决定是否释放');
        done.push({op:'force_release',keys:request.keys,reason:request.reason,until:outcome.until,previous_holders:rows.filter(r=>request.keys.includes(r.key)).map(r=>({key:r.key,run:r.run}))});
      }
      if(request.op==='extend'||request.op==='release'){
        const selected=rows.filter(row=>request.keys.includes(row.key));const holder={user:selected[0]!.user,run:selected[0]!.run};
        const outcome=request.op==='extend'?await service.extend({keys:request.keys,holder,ttlSeconds:request.ttl_seconds,maxTtlSeconds:cap}):await service.release({keys:request.keys,holder});
        if(!outcome.ok)refuse(outcome.code,outcome.message,'重新读取租约状态并核对血缘');
        done.push(request.op==='extend'?{op:'extend',lease:outcome.lease,keys:request.keys,until:outcome.until}:{op:'release',keys:request.keys,until:outcome.until});
      }
    }
    for(const request of requests)if(request.op===undefined||request.op==='acquire'){
      const outcome=await service.acquire({keys:request.keys,ttlSeconds:request.ttl_seconds,holder:{user:user.id,run:runId},prefix,maxTtlSeconds:cap});
      if(!outcome.ok){const when=outcome.earliestFree?'，最早空闲时刻 '+outcome.earliestFree:'';refuse(outcome.code,outcome.message+when,outcome.code==='LEASE_UNAVAILABLE'?'等持有谱系释放、请主人带理由处置，或改用别的键'+when:'核对租约前缀和期限后重开运行');}
      acquired.push(...outcome.keys);done.push({lease:outcome.lease,keys:outcome.keys,until:outcome.until});
    }
  }catch(error){await compensate();throw error;}
  return done;
}

const SPLIT_FIX = '把被判对象分块（每块分别开运行），按分块评审的做法逐块提交';

export function refused(errors: ProtocolError[]): StartRunDetail {
  return { answer: { call_result: 'error', errors }, production: null, runRecord: null, unavailable: [], gaps: [] };
}

/** At most this many expected-sources warnings are kept in the parse action and answered as gaps. */
const MAX_WARNINGS = 100;

/** The ok answer of a run: its summary and, for a production run, the result the Hub computed (StartRunOutput.result). */
function okAnswer(record: RunRecord, production: ProductionResult | null, workflow?:LoadedWorkflow): StartRunAnswer {
  return { call_result: 'ok', errors: [], run: summaryOf(record,workflow), ...(production !== null ? { result: { reference: production.reference, counts: production.counts } } : {}) };
}

/** Why a client key cannot be an index value of the records (no NUL, at most 1000 UTF-8 bytes with its owner), or null. */
function clientKeyProblem(owner: string, key: string): string | null {
  if (key.includes('\u0000')) return '客户端键里不能有 NUL 字符';
  if (Buffer.byteLength(`${owner}:${key}`, 'utf8') > 1000) return '客户端键太长';
  return null;
}

/** Parameters against the workflow's declarations; a schema the Hub cannot enforce refuses the value (fail closed). */
function checkParameters(workflow: LoadedWorkflow, given: Record<string, unknown>): Record<string, unknown> {
  const errors: ProtocolError[] = [];
  const declared = new Map(workflow.workflow.parameters.map((p) => [p.name, p]));
  for (const name of Object.keys(given)) {
    if (!declared.has(name)) errors.push(protocolError('SUBMISSION_SCHEMA_VIOLATION', `任务包没有参数 ${name}`, { path: pointerOf('parameters', name) }));
  }
  for (const p of declared.values()) {
    if (!Object.hasOwn(given, p.name)) {
      if (p.required) errors.push(protocolError('SUBMISSION_SCHEMA_VIOLATION', `缺少必需的参数 ${p.name}：${p.description}`, { path: '/parameters' }));
      continue;
    }
    if (p.schema === undefined) continue;
    const compiled = packSchema(p.schema);
    if (!compiled.ok) {
      errors.push(protocolError('SUBMISSION_SCHEMA_VIOLATION', `任务包为参数 ${p.name} 声明的模式不能在 Hub 里执行，取值无法核对`, { path: pointerOf('parameters', p.name), fix: '请联系任务包作者' }));
      continue;
    }
    if (!compiled.schema.safeParse(given[p.name]).success) {
      errors.push(protocolError('SUBMISSION_SCHEMA_VIOLATION', `参数 ${p.name} 的取值不符合任务包声明的模式`, { path: pointerOf('parameters', p.name) }));
    }
  }
  if (errors.length > 0) throw new Refusal(errors);
  return given;
}

/** Canonical bytes of a body, or null when canonical JSON refuses it. */
function bodyBytes(body: unknown): number | null {
  try {
    return Buffer.byteLength(canonicalize(body), 'utf8');
  } catch (error) {
    if (error instanceof CanonicalizationError) return null;
    throw error;
  }
}

/** A refusal when a body would not fit in one record (the limit is known only with the kit's configuration). */
function tooLarge(ctx: EngineContext, body: unknown, what: string, path: string): Refusal | null {
  const size = bodyBytes(body);
  if (size !== null && (ctx.maxRecordBytes === null || size <= ctx.maxRecordBytes)) return null;
  const message =
    size === null
      ? `${what}超出 Hub 一条记录能存的范围，运行没有开始`
      : `${what}有 ${size} 字节，超过 Hub 一条记录的上限 ${ctx.maxRecordBytes} 字节，运行没有开始`;
  return new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', message, { path, fix: SPLIT_FIX })]);
}

/**
 * The result a production run computed at start_run: the one whose submission digest is the run record's (later commentary
 * submissions have results of their own), so that a repeated start answers what the first one did.
 */
async function productionOf(ctx: EngineContext, run: StoredRecord<RunRecord>): Promise<ProductionResult | null> {
  const stored = await resultFor(ctx.deps.records.store, run.body.run, run.digest);
  return stored === null ? null : { reference: recReference(stored.digest), record: stored.digest, result: stored.body, counts: partitionCountsOf(stored.body.partitions) };
}

/** The gap note of a run without items (an empty item set is a legal answer, W01 R[3]): said in the answer, never hidden. */
const EMPTY_ITEMS_NOTE = { code: 'runs.empty_items', message: '这次运行没有条目：投影函数成功返回了一个空的条目集（空条目集是合法的结果）' } as const;

/** The warnings of the expected-sources function as gaps: code and message only. */
const gapsFrom = (warnings: readonly unknown[]): NonNullable<StartRunDetail['gaps']> =>
  warnings.flatMap((w) => (isObject(w) && typeof w.code === 'string' && typeof w.message === 'string' ? [{ code: w.code, message: w.message }] : [])).slice(0, MAX_WARNINGS);

/** The evidence gaps of a stored run, from the parse action start_run wrote: unbound expected sources and the function's warnings. */
async function gapsOf(ctx: EngineContext, run: RunRecord): Promise<Pick<StartRunDetail, 'unavailable' | 'gaps'>> {
  const parse = (await actionsOf(ctx.deps.records.store, run.run)).find((a) => a.body.action === 'parse');
  const listed = parse?.body.detail.unavailable;
  const warnings = parse?.body.detail.expected_warnings;
  return {
    unavailable: Array.isArray(listed) ? listed.flatMap((u) => (isObject(u) && typeof u.external === 'string' && isSourceRole(u.role) ? [{ external: u.external, role: u.role }] : [])) : [],
    gaps: gapsFrom([...(run.items.length === 0 ? [EMPTY_ITEMS_NOTE, ...((parse?.body.detail.warnings as unknown[]) ?? [])] : []), ...((warnings as unknown[]) ?? [])]),
  };
}

export async function startRun(ctx: EngineContext, user: Principal, raw: unknown, call: CallContext, mode: StartMode): Promise<StartRunDetail> {
  const at = ctx.now();
  // Nothing is read for arguments the records could not hold (a lone surrogate, nesting past the canonical limit).
  const plain = receivedDigest(raw);
  // Scan before schema diagnostics can quote an unknown field name. This never resolves reference-looking text.
  let scanText:string|undefined;
  try {scanText=JSON.stringify(raw);}catch{/* Non-JSON values follow the canonical-domain refusal below. */}
  if(scanText!==undefined&&scanForCredentials(Buffer.from(scanText,'utf8')).findings.length)return refused([protocolError('SUBMISSION_SCHEMA_VIOLATION','start_run 不受理含凭据的参数',{fix:'参数里不能有凭据；移除凭据后重试'})]);
  if (!plain.canonical) {
    return refused([
      protocolError('SUBMISSION_SCHEMA_VIOLATION', '参数里有规范 JSON 表示不了的值（孤立的代理字符，或嵌套超过 1000 层）', {
        path: clipPointer(plain.nonCanonicalPath ?? ''),
        fix: '把这个值改成完整的 Unicode 文本（不要截断在代理对中间）、减少嵌套后重试',
      }),
    ]);
  }
  const parsed = StartRunInput.safeParse(raw);
  if (!parsed.success) return refused(issuesOf(parsed.error, ''));
  const input = parsed.data;
  try {
    const variables=await ctx.deps.records.variables.snapshot();
    const owner = mode.host === 'hub' ? keyOwner({ configurer: user.id }) : user.id;
    const requestDigest = receivedDigest(input).digest;
    const fresh = (): Promise<StartRunDetail> => authorizedStart(ctx, user, input, call, mode, at, requestDigest,variables);
    if (input.client_key === undefined) return await fresh();
    const key = input.client_key;
    const problem = clientKeyProblem(owner, key);
    if (problem !== null) throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', problem, { path: '/client_key', fix: '换一个不含 NUL 字符、不超过 200 个字符的客户端键' })]);
    return await ctx.lock(`start:${owner}:${key}`, async () => {
      // D05 R[5]: the repeat inside the window is answered from the run the key is bound to, before anything else.
      const existing = await runByClientKey(ctx.deps.records.store, owner, key);
      const expires = existing?.body.client_key_expires_at;
      if (existing !== null && expires !== undefined && Date.parse(expires) > at.getTime()) {
        if (existing.body.request_digest !== requestDigest) {
          throw new Refusal([protocolError('IDEMPOTENCY_MISMATCH', `客户端键 ${key} 已经用于内容不同的 start_run（运行 ${existing.body.run}）`, { path: '/client_key' })]);
        }
        const production = await productionOf(ctx, existing);
        const answer=okAnswer(existing.body, production, hasRulingSummary(existing.body)?undefined:(await ctx.deps.workflows.byDigest(existing.body.pack_digest))??undefined),notices=await criterionNotices(ctx,existing.body);
        if(notices.length)answer.run!.criterion_changes=notices;
        return {answer,production,runRecord:existing.digest,...await gapsOf(ctx,existing.body)};
      }
      return fresh();
    });
  } catch (error) {
    if(error instanceof MissingRulingSummaryError)return refused([protocolError('SOURCE_UNAVAILABLE',error.message,{path:'/pack',fix:error.fix!})]);
    if (!(error instanceof Refusal)) throw error;
    if (error.adminNote !== null) ctx.log({ traceId: call.traceId, run: null, what: 'start_run', detail: error.adminNote });
    return refused(error.errors);
  }
}

async function packRefusal(ctx:EngineContext,workflow:LoadedWorkflow,at:Date,errors:ProtocolError[],adminNote:string|null=null):Promise<Refusal>{
  const owner=await ctx.deps.workflows.ownerOf?.(workflow.pack.digest);
  if(!owner)return new Refusal(errors.map(e=>({...e,fix:`${e.fix??''}；管理员须补齐包 ownerOf 身份接线后重试`})),adminNote);
  const request=await putRequest(ctx,{pack_digest:workflow.pack.digest,kind:'repair',audience:owner,due:new Date(at.getTime()+86400000).toISOString(),missing:errors.map(e=>e.message).join('；'),source:workflow.pack.digest,code:'check_error',next_action:'包作者发布修复版本，运行者以原运行为 predecessor 用 start_run 重跑；本次未开始的运行直接重新开始'});
  return new Refusal(errors.map(e=>({...e,fix:`${e.fix??''}；请求 rec:${request.digest}：${request.body.next_action}`})),adminNote);
}

async function authorizedStart(
  ctx: EngineContext,
  user: Principal,
  input: z.infer<typeof StartRunInput>,
  call: CallContext,
  mode: StartMode,
  at: Date,
  requestDigest: string,
  variables: VariableSnapshot,
): Promise<StartRunDetail> {
  const workflow = await ctx.deps.workflows.forUser(user, input.pack);
  if (workflow === null || workflow.pack.kind !== 'workflow') throw unavailable('/pack', `pack ${input.pack} is unknown, not assigned to ${user.id}, withdrawn or not a workflow pack`);
  const declaration=PublishableRequirementsFile.safeParse({schema:'requirements@1',requirements:workflow.requirements});
  if(!declaration.success){
    const owner=await ctx.deps.workflows.ownerOf?.(workflow.pack.digest);
    if(!owner)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION','任务包声明有误，且没有包作者身份读取接线',{path:'/pack',fix:'管理员补齐 ownerOf 接线并修复包声明后重新开始'})]);
    const request=await putRequest(ctx,{pack_digest:workflow.pack.digest,kind:'repair',audience:owner,due:new Date(at.getTime()+86400000).toISOString(),missing:`任务包 ${workflow.pack.id}@${workflow.pack.version} 缺少已声明层的检查或观察：${declaration.error.issues.map(i=>i.path.join('/')+': '+i.message).join('；')}`,source:workflow.pack.digest,code:'check_error',next_action:'包作者发布带完整检查和观察声明的修复版本，运行者用 start_run 重新开始；已有运行以它为 predecessor 重跑'});
    throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',request.body.missing,{path:'/pack',fix:`请求 rec:${request.digest}：${request.body.next_action}`})]);
  }
  const contribution=workflow.workflow.contribution;
  if(contribution!==undefined&&(!workflow.slots.item[contribution.slot]||!workflow.requirements.some(r=>r.key===contribution.requirement&&r.target==='item'&&r.accepted_producer==='fact'))){
    throw await packRefusal(ctx,workflow,at,[protocolError('SUBMISSION_SCHEMA_VIOLATION','任务包缺少回注槽位或对应的逐条目事实核验要求项',{path:'/pack',fix:'请任务包维护人修正 workflow.contribution 的 slot 和 requirement 声明，再重开运行'})]);
  }
  if (mode.host === 'hub' && !isProduction(workflow)) {
    throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', '含模型槽位的任务包不能由 Hub 执行（W09 R[3]：常设义务只许确定性函数）', { path: '/pack', fix: '改用只含事实要求项的任务包' })]);
  }
  const unsafe = schemaProblems(workflow);
  if (unsafe.length > 0) throw await packRefusal(ctx,workflow,at,[protocolError('SUBMISSION_SCHEMA_VIOLATION',`任务包声明的 JSON Schema 不能安全执行：${unsafe.join('；')}`,{path:'/pack',fix:'包作者去掉不支持的模式关键字后发布修复版本'})],`pack ${workflow.pack.id}@${workflow.pack.version} declares schemas the engine cannot enforce: ${unsafe.join('; ')}`);
  return startFresh(ctx, user, input, call, mode, workflow, at, requestDigest,variables);
}

/**
 * A run with a requirement independent of its predecessor (A04) judges the work of the predecessor's lineage; a Hub record bound
 * as artifact under verification from another run's lineage would be verified against the wrong author. Checked before the
 * inputs are bound, so nothing is read or stored for a refused start.
 */
async function checkLineage(ctx: EngineContext, user: Principal, workflow: LoadedWorkflow, input: z.infer<typeof StartRunInput>, predecessor: RunRecord): Promise<void> {
  if (!workflow.requirements.some((r) => r.independent_of !== undefined)) return;
  const reader = recordReader(ctx.deps.records.store);
  const records: { record: string; run: string | null }[] = [];
  for (const slot of workflow.workflow.inputs.filter((s) => s.role === 'artifact_under_verification')) {
    const given = input.inputs[slot.slot];
    for (const binding of given === undefined ? [] : Array.isArray(given) ? given : [given]) {
      if (!('reference' in binding)) continue;
      let record: string;
      try {
        const ref = parseReference(binding.reference);
        if (ref.scheme !== 'rec') continue;
        record = ref.record;
      } catch {
        continue; // bindInputs reports the syntax
      }
      const read = await reader.read(record, identityOf(user));
      if (read !== null) records.push({ record, run: runOfRecord(read) });
    }
  }
  const foreign = await foreignArtifacts(ctx.deps.records.store, predecessor.run, records);
  if (foreign.length === 0) return;
  const first = foreign[0];
  throw new Refusal([
    protocolError('SUBMISSION_SCHEMA_VIOLATION', `交接的记录 ${first.record.slice(0, 12)} 属于运行 ${first.run}，不在前驱 ${predecessor.run} 的血缘里：独立性要对照它的作者，这个前驱说明不了`, {
      path: '/predecessor',
      fix: `把 predecessor 设为 ${first.run}（交接记录所属的运行），或它之后的修订`,
    }),
  ]);
}

async function startFresh(
  ctx: EngineContext,
  user: Principal,
  input: z.infer<typeof StartRunInput>,
  call: CallContext,
  mode: StartMode,
  workflow: LoadedWorkflow,
  at: Date,
  requestDigest: string,
  variables: VariableSnapshot,
): Promise<StartRunDetail> {
  const { store, artifacts } = ctx.deps.records;
  const dependencies=workflow.manifest?.dependencies??[];
  let skills:import('../../../contracts/src/skills.ts').SkillLock[]=[];
  if(ctx.parsers.freeze){
    try{const frozen=await ctx.parsers.freeze(dependencies);skills=frozen.skills;ctx={...ctx,parsers:frozen.parsers};}
    catch(error){throw new Refusal([protocolError('SOURCE_UNAVAILABLE',error instanceof Error?error.message:'技能包依赖不可读取',{path:'/pack',fix:'管理员安装工作包声明的技能包版本后重试；本次没有开始运行'})]);}
  }else if(dependencies.length)throw new Refusal([protocolError('SOURCE_UNAVAILABLE','没有已安装技能包的注册表',{fix:'管理员配置技能包注册表并安装声明依赖后重试'})]);
  const startedAt = at.toISOString();
  let predecessor: StoredRecord<RunRecord> | null = null;
  if (input.predecessor !== undefined) {
    predecessor = await runById(store, input.predecessor);
    if (predecessor === null || !(workflow.workflow.predecessor_access==='view'?await canViewRun(user,predecessor.body,store):canSeeRun(user, predecessor.body))) throw unavailable('/predecessor', `predecessor ${input.predecessor} is unknown or not visible to ${user.id}`);
  }
  if (workflow.requirements.some(t => t.independent_of !== undefined&&!t.independence_by_account)) {
    if (sessionOf(call) === null) throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', '独立复核运行缺少本会话的 id，运行没有开始', {path:'',fix:'在请求头 Circle-Session-Id 里带上本会话的 id（1 到 200 个可打印 ASCII 字符），原样再开始'})]);
    if (predecessor !== null) {
      const author = await authorOriginOf(ctx, {...predecessor.body, pack: `${workflow.pack.id}@${workflow.pack.version}`, predecessor: predecessor.body.run, sources: []});
      if (author?.missingSessions.length) throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', `被判工作的来源缺少会话 id：${author.missingSessions.join('；')}`, {path:'/predecessor',fix:'带上 Circle-Session-Id，以被判工作为前驱开新修订并重新提交，再对新修订开复核运行'})]);
    }
  }
  if(input.submission_due!==undefined&&Date.parse(input.submission_due)<=at.getTime())throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION','提交期限必须晚于开始时刻',{path:'/submission_due',fix:'给出未来的 submission_due 后重新开始'})]);
  if(workflow.workflow.predecessor==='required'&&!input.predecessor)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION','任务包要求显式前驱运行',{path:'/predecessor',fix:'在 predecessor 中给出前驱运行后重新开始'})]);
  const parameters = checkParameters(workflow, input.parameters ?? {});
  const defaulted=await defaultPredecessorInputs(ctx,workflow,predecessor,input.inputs,user);
  input={...input,inputs:defaulted.inputs};
  if (predecessor !== null) await checkLineage(ctx, user, workflow, input, predecessor.body);
  const target = await resolveTarget(ctx, user, workflow, input, startedAt, call.traceId);
  if(workflow.knowledge?.requires.length){
    const missing=[] as string[];
    for(const requirement of workflow.knowledge.requires){
      const catalog=target.root?await ctx.deps.knowledge.catalog(target.root.root,requirement.catalog):null;
      if(!catalog||requirement.complete&&!catalog.complete)missing.push(requirement.catalog);
    }
    if(missing.length){
      const candidates=[] as string[];
      if(target.product)for(const build of await ctx.deps.knowledge.builds(target.product.product.id)){
        if(!build.root)continue;
        let valid=true;
        for(const requirement of workflow.knowledge.requires){const catalog=await ctx.deps.knowledge.catalog(build.root,requirement.catalog);if(!catalog||requirement.complete&&!catalog.complete){valid=false;break;}}
        if(valid)candidates.push(build.name);
      }
      throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION',`所选知识根没有满足要求的完整目录：${missing.join('、')}`,{path:'/build',fix:`可选构建：${candidates.length?candidates.join('、'):'当前没有满足要求的构建，请先生产所缺目录后重新开始'}`})]);
    }
  }
  const runId = newId('run', at.getTime());
  return ctx.lock(`submit:${runId}`,async()=>{
  const knownBuilds=target.knownBuilds??(target.buildName===null?undefined:await ctx.deps.knowledge.builds(target.product!.product.id));
  const selectedBuild=target.buildName===null?undefined:knownBuilds!.find(build=>build.name.normalize('NFC').toLowerCase()===target.buildName!.normalize('NFC').toLowerCase())?.name??target.buildName;

  const feedingOffset=await ctx.deps.knowledge.feeding?.freeze(user,runId,target.root?.root??null);
  const feedingScope={composition:target.root?.composition??null,product:target.product?.product.id??null,root:target.root?.root??null,run:runId,line:target.line,feeding_offset:feedingOffset,declaredLine:workflow.workflow.feeding?.declared_line_parameter?parameters[workflow.workflow.feeding.declared_line_parameter] as string:undefined};
  const bound = await bindInputs(ctx, user, workflow, input.inputs, runId, call.traceId, target.root?.composition ?? null,selectedBuild,variables,target.unversionedRoot ? {root:target.unversionedRoot.root,composition:target.unversionedRoot.composition} : null,feedingScope);
  // The projection runs before any group exists; the expected sources and the checks see the frozen groups. The builds of
  // the bound product are known from the target and frozen with the run, so they are the same at projection and evaluation.
  const criterionReview=await prepareCriterionReview(ctx,user,workflow,bound,predecessor?.body??null);
  const criterionSnapshot=workflow.workflow.predecessor_access==='view'?{refs:[],requests:[],criteria:[],notices:[]}:await freezeCriteria(ctx,predecessor?.body??null,workflow.pack.id,startedAt);
  const builds = await contextBuilds(ctx, workflow, target.product?.product.id ?? null, knownBuilds);
  // The lease view is taken BEFORE the projection runs, so the projection sees real rows, none of them this run's own
  // acquisitions. Rows this run's lineage already holds (the holder run sits in the predecessor chain, same user; D04
  // R[0]) are marked `mine`, so an extend or release projection discovers the keys it may operate on (C6 item 5); a run
  // without a predecessor holds nothing yet and skips the lookup. The same view is frozen in the run record, so
  // replaying the projection from the record's context asks for the same keys again.
  const leaseView = await contextLeases(ctx, workflow, user);
  const leaseRows = leaseView?.entries ?? null;
  let leaseLineageHolders = new Set<string>();
  if (leaseRows !== null && leaseRows.length > 0 && predecessor !== null && workflow.workflow.predecessor_access!=='view' && ctx.deps.leases !== undefined) {
    const lineage = await lineageOf(ctx, runId, predecessor.body.run);
    const holders = await ctx.deps.leases.holders(leaseRows.map((row) => row.key));
    leaseLineageHolders = new Set(holders.filter((row) => row.user === user.id && lineage.has(row.run)).map((row) => row.key));
  }
  const context: RunContext = {
    run: runId,
    predecessor: predecessor?.body.run ?? null,
    ...(target.product ? {product_pack_digest:target.product.digest}:{}),
    ...(feedingOffset?{feeding_offset:feedingOffset}:{}),
    ...(criterionSnapshot.criteria.length?{accepted_criteria:criterionSnapshot.criteria}:{}),
    ...(criterionReview?{criterion_review:criterionReview.context}:{}),
    product: target.product?.product.id ?? null,
    names: target.product?.product.names ?? [],
    line: target.line,
    build: target.buildName,
    root: target.root?.root ?? null,
    parameters,
    groups: [],
    ...(builds !== null ? { builds } : {}),
    ...(leaseRows !== null ? { leases: { now: startedAt, registrations: leaseView!.registrations, entries: leaseRows.map((row) => ({ ...row, mine: leaseLineageHolders.has(row.key) })) } } : {}),
  };
  const projection = await projectItems(ctx, user, workflow, bound, parameters, context, call.traceId);
  const expected = await bindExpected(ctx, user, workflow, bound, projection.projected, parameters, { ...context, groups: projection.groups }, runId, call.traceId, target.root?.composition ?? null,selectedBuild,variables,target.unversionedRoot ? {root:target.unversionedRoot.root,composition:target.unversionedRoot.composition} : null);
  // The leases are granted after the projection asked for them and before anything is stored; every failure from here
  // on compensates by releasing what was granted (D04 R[0]: no lease outlives the run it was taken for).
  let grantedLeases: Array<LeaseDone> = [];
  try {
    grantedLeases = await grantLeases(ctx, user, workflow, projection.leaseRequests, runId, workflow.workflow.predecessor_access==='view'?undefined:predecessor?.body.run);
  let items = projection.items;
  const packId = workflow.pack.id;
  const previous = predecessor;
  const handover = previous !== null && bound.some((b) => b.record !== null && b.record.run === previous.body.run);
  if (previous !== null && workflow.workflow.predecessor_access!=='view' && !handover && packIdOf(previous.body.pack) === packId) {
    const shaOf = (reference: string): string | null => /^src:([0-9a-f]{64})$/.exec(reference)?.[1] ?? null;
    const boundShas = new Set<string>([...bound.map((b) => b.sha256), ...expected.sources.map((s) => shaOf(s.reference)).filter((s): s is string => s !== null)]);
    const boundRecords = new Set(bound.flatMap((b) => (b.record !== null ? [b.record.digest] : [])));
    const resolveCtx = { reader: identityOf(user), parsers: ctx.parsers, sources: sourceReader(artifacts, 'function'), consumer: 'function' as const, documents: ctx.documents };
    const offers = await reuseOffers(
      {
        ctx,
        user,
        predecessor: previous.body,
        workflow,
        packDigest: workflow.pack.digest,
        root: target.root?.root ?? null,
        unversionedRoot: target.unversionedRoot?.root ?? null,
        boundShas,
        boundRecords,
        subjectShas: bound.filter((b) => b.slot === workflow.workflow.subject).map((b) => b.sha256),
        prefetchFragments: references => prefetchReferences(references,resolveCtx),
        fragmentText: async (reference) => {
          const r = await resolveReference(reference, resolveCtx);
          return r.resolved ? r.text : null;
        },
      },
      items,
    );
    items = items.map((it) => {
      const reuse = criterionSnapshot.criteria.some(change=>change.item===it.id)?undefined:offers.get(it.id);
      return reuse === undefined ? it : { ...it, reuse };
    });
  }

  // The frozen rows carry `mine` for the rows held by this run's lineage (D04 R[0]): the projection of a successor
  // reads it to see which keys it may extend or release. (The view itself was taken before the projection.)
  const frozenLeaseRows =
    leaseRows === null
      ? null
      : leaseRows.map((row) => ({ ...row, mine: leaseLineageHolders.has(row.key) }));
  const slots = slotSchemaOf(workflow);
  const hub = mode.host === 'hub';
  const session = sessionOf(call);
  const effectRegistry=await ctx.deps.effectRegistry?.snapshot(variables);
  const frozenCommandPolicy=await commandPolicyForRoot(ctx.deps.records.store,target.root);
  const record: RunRecord = RunRecord.parse({
    ...(target.product ? {product_pack_digest:target.product.digest}:{}),
    skills,
    ...(frozenCommandPolicy?{command_policy:frozenCommandPolicy}:{}),
    ...(effectRegistry??{}),
    ...(criterionSnapshot.refs.length?{accepted_criteria:criterionSnapshot.refs}:{}),
    ...(criterionSnapshot.requests.length?{criterion_requests:criterionSnapshot.requests}:{}),
    run: runId,
    ...(feedingOffset?{feeding_offset:feedingOffset}:{}),
    pack: `${workflow.pack.id}@${workflow.pack.version}`,
    pack_digest: workflow.pack.digest,
    ...(target.product !== null ? { product: target.product.product.id } : {}),
    ...(target.line !== null ? { version: target.line } : {}),
    ...(target.buildName !== null ? { build: target.buildName } : {}),
    target_basis: target.basis,
    ...(target.root !== null ? { root: target.root.root } : {}),
    ...(target.unversionedRoot ? { unversioned_root: target.unversionedRoot.root } : {}),
    sources: [...bound.map((b) => b.binding), ...expected.sources],
    ...(defaulted.defaults.length?{input_defaults:defaulted.defaults}:{}),
    requirements: workflow.requirements.map(t=>requirementSummary(t,workflow.ledger,workflow.checks,`${workflow.pack.id}@${workflow.pack.version}`,{workClass:workflow.workflow.work_class,effects:workflow.effects ?? []})),
    items,
    ...(slots !== undefined ? { slots } : {}),
    ...(workflow.workflow.outputs===undefined?{}:{outputs:workflow.workflow.outputs}),
    instructions: workflow.instructions,
    instructions_digest: workflow.instructionsDigest,
    ...(predecessor !== null ? { predecessor: predecessor.body.run } : {}),
    ...(workflow.workflow.predecessor_access==='view'?{predecessor_access:'view' as const}:{}),
    ...(criterionReview?{criterion_review:criterionReview.marker}:{}),
    ...(session !== null ? { session } : {}),
    ...(input.model_identity !== undefined ? { model_identity: input.model_identity } : {}),
    started_at: startedAt,
    submission_due: input.submission_due ?? new Date(at.getTime()+86400000).toISOString(),
    ...(hub ? { host: 'hub' as const, trigger: 'standing_obligation' as const, configurer: user.id } : { runner: user.id, host: 'local_circle' as const, trigger: 'session' as const }),
    parameters,
    ...(projection.groups.length > 0 ? { groups: projection.groups } : {}),
    ...(builds !== null ? { builds } : {}),
    ...(input.client_key !== undefined
      ? { client_key: input.client_key, request_digest: requestDigest, client_key_expires_at: new Date(at.getTime() + ctx.clientKeyWindowMs).toISOString() }
      : {}),
    ...(grantedLeases.length > 0 ? { leases: grantedLeases } : {}),
    ...(frozenLeaseRows !== null ? { lease_context: frozenLeaseRows, lease_registrations: leaseView!.registrations } : {}),
  } satisfies RunRecord);
  const subjectPath = `/inputs/${workflow.workflow.subject}`;
  const runTooLarge = tooLarge(ctx, record, `这个被判对象投影出 ${items.length} 个条目，运行记录`, subjectPath);
  if (runTooLarge !== null) throw runTooLarge;
  // A production result names the run record digest; it is computed and sized before anything is stored.
  const runDigest = runRecordDigest(record, startedAt);
  const production = isProduction(workflow) ? await evaluateProduction(ctx, record, runDigest, workflow, call.traceId, user) : null;
  if (production !== null) {
    const resultTooLarge = tooLarge(ctx, production.evaluation.result, `这个被判对象的校验结果（${items.length} 个条目）`, subjectPath);
    if (resultTooLarge !== null) throw resultTooLarge;
  }
  let stored: StoredRecord<RunRecord>;
  try {
    stored = await putRun(store, record, startedAt);
  } catch (error) {
    if (!(error instanceof LimitError)) throw error;
    throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', `这个被判对象投影出 ${items.length} 个条目，运行记录超过 Hub 一条记录的上限，运行没有开始`, { path: subjectPath, fix: SPLIT_FIX })], describe(error));
  }
  if (stored.digest !== runDigest) throw new Error(`run record digest ${stored.digest} differs from the one computed before storing it (${runDigest})`);
  const fn = workflow.workflow.projection;
  await putAction(store, {
    action: 'parse',
    run: runId,
    inputs: bound.map((b) => b.binding.reference),
    startedAt,
    endedAt: ctx.now().toISOString(),
    acceptance: null,
    codes: [],
    component: `${packId}@${workflow.pack.version}/${fn.module}#${fn.export ?? 'default'}`,
    detail: {
      items: items.length,
      reuse: items.filter((it) => it.reuse !== undefined).length,
      warnings: projection.warnings.slice(0, 100),
      expected: expected.sources.map((s) => ({ external: s.external ?? null, reference: s.reference, role: s.role })),
      unavailable: expected.unavailable,
      expected_warnings: expected.warnings.slice(0, MAX_WARNINGS),
      handover,
    },
  });
  if(production!==null)await recordResultRequests(ctx,record,production.evaluation.result);
  const result = production === null ? null : await keepProduction(ctx, stored, production, call);
  if(predecessor!==null)await answerSuccessorRequests(ctx,predecessor.body,stored);
  return {
    answer: {...okAnswer(record, result),run:{...summaryOf(record),...(criterionSnapshot.notices.length?{criterion_changes:criterionSnapshot.notices}:{})}},
    production: result,
    runRecord: stored.digest,
    unavailable: expected.unavailable.map(({ external, role }) => ({ external, role })),
    // A run without items says so in the answer and carries the projection's notes; with items the projection warnings stay in the parse action.
    gaps: gapsFrom([...(items.length === 0 ? [EMPTY_ITEMS_NOTE, ...projection.warnings] : []), ...expected.warnings]),
  };
  } catch (error) {
    // The granted leases of a start that did not store its run are released at once (compensation): an acquire that
    // refused throws before anything was granted, so only a real failure reaches here with rows held.
    const acquiredKeys = grantedLeases.filter((entry) => entry.op === undefined || entry.op === 'acquire').flatMap((entry) => 'keys' in entry ? entry.keys : []);
    if (acquiredKeys.length > 0 && ctx.deps.leases !== undefined) {
      await ctx.deps.leases.release({ keys: acquiredKeys, holder: { user: user.id, run: runId } }).catch(() => undefined);
    }
    throw error;
  }
  });
}

/** The evaluation of a production run, made before its run record is stored (the result names the record's digest). */
async function evaluateProduction(ctx: EngineContext, run: RunRecord, runDigest: string, workflow: LoadedWorkflow, traceId: string, user: Principal): Promise<{ evaluation: Evaluation; startedAt: string }> {
  if(ctx.parsers.forRun)ctx={...ctx,parsers:await ctx.parsers.forRun(run.run)};
  const startedAt = ctx.now().toISOString();
  const evaluation = await evaluate(ctx, productionEvaluationInput(run, workflow, runDigest, traceId));
  const notes = (run.groups ?? []).map((group, i) => ({group, i})).filter(({group}) => group.nature === 'fact' && group.verdict === 'support');
  if (notes.length === 0) return {evaluation, startedAt};
  const noteSchema = z.strictObject({
    nature: NatureSchema.extract(['fact']), verdict: VerdictSchema.extract(['support']),
    message: z.string().refine(value => value.trim().length > 0), grounds: z.array(Ground).min(1), data: z.record(z.string(), z.unknown()).optional(),
  });
  const scope = await buildScope(ctx, run, workflow, user, 'function');
  const resolver = createResolver(ctx, scope, 'function');
  await resolver.prefetch(notes.flatMap(({group})=>{const note=noteSchema.safeParse(group);return note.success?note.data.grounds:[];}));
  // Ordinary warnings, guesses and grouping metadata are not promoted into facts.
  for (const {group, i} of notes) {
    const at = pointerOf('groups', i);
    const note = noteSchema.safeParse(group);
    if (!note.success) throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', `任务包的确定说明 ${at} 不合格：需要 message 和非空 grounds；仅允许 nature、verdict、message、grounds、data，其余字段必须放入 data`, {fix:'请任务包维护人补齐 message 和非空 grounds，将其他说明字段显式放入 data 后重开运行'})]);
    const grounds: string[] = [];
    const roles: Array<SourceRole | null> = [];
    for (const reference of note.data.grounds) {
      const resolved = await resolver.resolve(reference);
      if (!resolved.ok) throw new Refusal([protocolError(resolved.code ?? 'REFERENCE_UNRESOLVED', `任务包的确定说明 ${at} 的根据解析不出：${resolved.message}`, {
        fix:resolved.code === 'SOURCE_UNAVAILABLE'
          ? `请 ${user.name} 先重读该引用并核对权限、读取档位和解析器；恢复可读后重开运行，不能恢复时把追踪号交给管理员核查`
          : '按本次运行绑定的源文件和锁定根修正投影函数的引用，再重开运行',
      })]);
      grounds.push(resolved.value.reference);
      roles.push(resolved.value.role);
    }
    // Projection notes are advisory cross-item facts, never evidence satisfying a requirement.
    evaluation.result.cross_item.push({...factClaim({
      coverage:sourceCoverage(run.sources,grounds),
      outcome:{verdict:'support',statement:note.data.message,grounds,...(note.data.data === undefined ? {} : {data:note.data.data})},
      rule:`${workflow.pack.id}.projection@${workflow.pack.version}`,judges:strongestRole(roles) ?? 'subject',
      overClaims:false,discrimination:false,bound:[runDigest, workflow.pack.digest, ...(run.root === undefined ? [] : [run.root]), ...grounds.flatMap(ref => {const digest = rootDigest(ref); return digest === null ? [] : [digest];})],
    }),pointer:at});
  }
  return { evaluation, startedAt };
}

/** Stores a production result and its validate action; also the path of Hub-side sweeps. */
async function keepProduction(ctx: EngineContext, stored: StoredRecord<RunRecord>, production: { evaluation: Evaluation; startedAt: string }, call: CallContext): Promise<ProductionResult> {
  const endedAt = ctx.now().toISOString();
  let result: StoredRecord<ValidationResult>;
  try {
    result = await putResult(ctx.deps.records.store, production.evaluation.result, endedAt);
  } catch (error) {
    // Only without the kit's configuration (the size was checked before the run was stored otherwise).
    if (!(error instanceof LimitError) && !(error instanceof CanonicalizationError)) throw error;
    throw new Refusal(
      [protocolError('SUBMISSION_SCHEMA_VIOLATION', '这个被判对象的校验结果超过 Hub 一条记录的上限，存不下', { path: '/inputs', fix: SPLIT_FIX })],
      `production result of ${stored.body.run} not stored, the run record stays without a result: ${describe(error)}`,
    );
  }
  await putAction(ctx.deps.records.store, {
    action: 'validate',
    run: stored.body.run,
    inputs: [recReference(stored.digest)],
    startedAt: production.startedAt,
    endedAt,
    acceptance: null,
    codes: [],
    detail: { submission: stored.digest, session: sessionOf(call), model: null, repair: [], result: result.digest, production: true, retry_attempts: production.evaluation.retryAttempts,...(production.evaluation.parentObservedSuccess?{parent_observed_success:true}:{}) },
  });
  return { reference: recReference(result.digest), record: result.digest, result: result.body, counts: partitionCountsOf(result.body.partitions) };
}

/** Re-evaluate only deterministic production, with the existing frozen run and current authorized source availability. */
export async function recheckProduction(ctx:EngineContext,stored:StoredRecord<RunRecord>,user:Principal,traceId:string):Promise<ProductionResult|null>{
  const workflow=await ctx.deps.workflows.byDigest(stored.body.pack_digest);
  if(!workflow||!isProduction(workflow))return null;
  const produced=await evaluateProduction(ctx,stored.body,stored.digest,workflow,traceId,user);
  await recordResultRequests(ctx,stored.body,produced.evaluation.result);
  return keepProduction(ctx,stored,produced,{traceId,sessionId:stored.body.session??null});
}
