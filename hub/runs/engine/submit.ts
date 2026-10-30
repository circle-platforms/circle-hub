import {firstDeclarationGrowth,unknownOnlyRequirement} from './incremental.ts';
import {submissionOrigin} from './independence.ts';
import {publishCriterionRequests,answerCriterionReview,criterionReviewVisible} from './criterion-changes.ts';
import { abandonDecision } from './management.ts';
import { isReason } from '../../../contracts/generated/vocabulary.ts';
import { applyDispatchResults } from './dispatch-results.ts';
import { recordResultRequests, answerRepairedRequests } from './requests.ts';
import { ContributionRefusal, KnowledgeError, type PreparedContribution, type ContributionScope } from '../../knowledge/api.ts';
import { operationDeviceStatus } from '../../knowledge/feeding-leases.ts';
import { assertOperationFields, CAPTURED_GROUND } from '../../knowledge/declaration-grade.ts';
import { KnowledgeStore } from '../../knowledge/store.ts';
import { getInterpreter, type CheckOutcome } from '../../rules/api.ts';
// submit_result (W07, W08, T03, A04): credential-shaped operation device/bed fields are refused before raw persistence;
// every other argument is stored exactly as received before anything else. A repeat of the same
// (run, submission digest) observed at the same session and declared model returns the stored result without re-running
// anything. A different session or model is a different judge of that body and is validated again, so a drafter cannot
// receive the verifier's receipt by resubmitting it. A run superseded by a newer revision of
// its own runner answers RUN_SUPERSEDED. Arguments the records cannot hold as checked JSON (a lone surrogate, nesting past the
// bound, a body over the record limit) are kept verbatim as an object and answered not accepted before anything reads them.
// Otherwise the structure, the item projection and the exact values are checked: any violation keeps the whole submission
// from being accepted (T03 R[3]) and the checks still run on the entries that parse and the items whose values resolved, so
// their item-level refutations come back as fix notes (W08 R[1]); otherwise the Hub recomputes everything and partitions the
// items. Every call that reaches a run gets a stored receipt: a result too large for one record is answered not accepted.
import type { z } from 'zod';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { CrossItemSubmission, ItemSubmission, Submission } from '../../../contracts/src/submission.ts';
import type { SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { PARTITION, type Acceptance } from '../../../contracts/generated/vocabulary.ts';
import { partitionCountsOf, type Partitions, type ValidationResult } from '../../../contracts/src/validation.ts';
import { CanonicalizationError, LimitError, sha256Hex, type Principal, type StoredRecord } from '../../records/api.ts';
import type { CallContext, LoadedWorkflow, Untraced } from '../../ports.ts';
import { parseReference, recReference } from '../../refs/api.ts';
import type { EngineContext } from './deps.ts';
import { describe, protocolError, unavailableError } from './errors.ts';
import { evaluate, type RuntimeAdmission } from './evaluate.ts';
import { buildScope, createResolver, recordBytes, resolveSubmission } from './exact.ts';
import type { AuthorOrigin, ProducerOrigin } from './independence.ts';
import { authorOriginOf, packIdOf } from './lineage.ts';
import { canSeeRun } from './readers.ts';
import { HubReadFailure } from './retry-read.ts';
import { carriedItems } from './reuse.ts';
import { issuesOf, requirementAt, slotProblems, slotSchemaOf } from './slots.ts';
import {
  INDEX,
  actionsOf,
  isVerbatimObject,
  keyOwner,
  putAction,
  putResult,
  putSubmission,
  resultFor,
  runById,
  submissionByDigest,
  successorsOf,
  type VerbatimObjectBody,
} from './store.ts';
import { repairRounds, isUnsettled } from './terminals.ts';
import { clipPointer, clipText, isObject, pointerOf, receivedDigest, sessionOf, tooDeep, unique, wellFormed } from './util.ts';

export type SubmitAnswer = Untraced<z.infer<typeof SubmitResultOutput>>;

/** Deepest nesting a submission may have (the root is level 0); slot data sits six levels down (`/items/<n>/slots/<key>/<j>/data`). */
export const MAX_SUBMISSION_DEPTH = 64;

/** Stands in for an undeclared model while the entries of a submission that does not parse are checked; never stored. */
const UNDECLARED_MODEL = '(未声明的模型)';

export function answerOf(result: ValidationResult): SubmitAnswer {
  if (result.acceptance === 'accepted') return { call_result: 'ok', acceptance: 'accepted', errors: result.errors, result, counts: partitionCountsOf(result.partitions) };
  return { call_result: 'error', acceptance: 'not_accepted', errors: result.errors, result };
}

function emptyPartitions(): Partitions {
  return Object.fromEntries(PARTITION.map((p) => [p, []])) as unknown as Partitions;
}

function transitional(result:ValidationResult):boolean{
  return Object.values(result.partitions).flat().some(item=>item.requirements.some(r=>r.layers.some(l=>isUnsettled(l)||(l.gaps?.length??0)>0)))||result.cross_item.some(c=>c.qualifier.nature==='unknown');
}

/**
 * The result already stored for this submission digest when this call's session and declared model are the ones that
 * produced it (A04: the judge is the session the Hub observed and the model the client declared). A result produced by
 * someone else is not this call's receipt.
 */
async function resultForObserver(ctx: EngineContext, run: string, submission: string, session: string | null, model: string | null): Promise<ValidationResult | null> {
  const store = ctx.deps.records.store;
  for (const action of (await actionsOf(store, run)).reverse()) {
    if (action.body.action !== 'validate' || !isObject(action.body.detail) || action.body.detail.production === true) continue;
    const detail = action.body.detail;
    if (detail.submission !== submission || typeof detail.result !== 'string') continue;
    const priorSession = detail.session === null || typeof detail.session === 'string' ? detail.session : undefined;
    const priorModel = detail.model === null || typeof detail.model === 'string' ? detail.model : undefined;
    if (priorSession === undefined || priorModel === undefined || priorSession !== session || priorModel !== model) continue;
    const record = await store.get<ValidationResult>(detail.result);
    if (record === null || record.kind !== 'validation_result') continue;
    if(transitional(record.body))continue;
    return record.body;
  }
  return null;
}

/** Repair rounds each requirement used in the run's earlier submissions (one per distinct submission with a problem for it). */
export async function roundsUsedOf(ctx: EngineContext, run: string): Promise<Map<string, number>> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const action of await actionsOf(ctx.deps.records.store, run)) {
    if (action.body.action !== 'validate' || !isObject(action.body.detail)) continue;
    if (action.body.detail.hub_error === true || action.body.detail.refusal === 'session_missing' || action.body.detail.refusal === 'RUN_ABANDONED') continue;
    const { submission, repair } = action.body.detail;
    if (typeof submission !== 'string' || seen.has(submission) || !Array.isArray(repair)) continue;
    seen.add(submission);
    for (const key of repair) if (typeof key === 'string') counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** How the arguments were kept: verbatim as a record, or as an object the record names (`why` says what kept them out). */
interface Kept {
  record: StoredRecord<unknown>;
  why: 'canonical' | 'too_large' | null;
}

/**
 * Stores the arguments as received. Arguments canonical JSON cannot carry (a lone surrogate, nesting past 1000 levels), or
 * whose body a record cannot hold, are kept as their JSON text in the object store and the record names the object, its
 * SHA-256 and size and the refused path (records decision 3); when even the object store refuses them only digest and size
 * are kept, like an upload refused for a credential (B05 R[3]).
 */
async function storeReceived(
  ctx: EngineContext,
  traceId: string,
  run: string,
  args: Record<string, unknown>,
  received: ReturnType<typeof receivedDigest>,
  parses: boolean,
  at: string,
): Promise<Kept> {
  const { store, objects } = ctx.deps.records;
  if (received.canonical) {
    try {
      return { record: await putSubmission(store, { run, digest: received.digest, body: args, parses, createdAt: at }), why: null };
    } catch (error) {
      if (!(error instanceof LimitError)) throw error;
      ctx.log({ traceId, run, what: 'submit_result', detail: `arguments kept as an object: ${describe(error)}` });
    }
  }
  let jsonText: string;
  try {
    jsonText = JSON.stringify(args);
  } catch {
    jsonText = '{"non_canonical":true}';
  }
  const bytes = new TextEncoder().encode(jsonText);
  let object: string | null = null;
  try {
    object = (await objects.put(bytes, 'application/json')).sha256;
  } catch (error) {
    if (!(error instanceof LimitError)) throw error;
    ctx.log({ traceId, run, what: 'submit_result', detail: `arguments kept by digest only: ${describe(error)}` });
  }
  const body: VerbatimObjectBody = {
    received: { ...(object !== null ? { object } : {}), sha256: sha256Hex(bytes), size: bytes.length, non_canonical_path: clipPointer(received.nonCanonicalPath ?? ''), run },
  };
  return { record: await putSubmission(store, { run, digest: received.digest, body, parses: false, createdAt: at }), why: received.canonical ? 'too_large' : 'canonical' };
}

export async function submitResult(ctx: EngineContext, user: Principal, args: Record<string, unknown>, call: CallContext, refresh = false): Promise<SubmitAnswer> {
  const store = ctx.deps.records.store;
  const runId = isObject(args) && typeof args.run === 'string' ? args.run : null;
  const stored = runId === null ? null : await runById(store, runId);
  if (stored === null || !canSeeRun(user, stored.body)) {
    const named = runId === null ? null : clipText(runId, 64);
    ctx.log({ traceId: call.traceId, run: named, what: 'submit_result', detail: named === null ? 'no run id in the arguments' : `run ${named} is unknown or not visible to ${user.id}` });
    return { call_result: 'error', acceptance: 'not_accepted', errors: [unavailableError('/run')] };
  }
  return ctx.lock(`submit:${stored.body.run}`, async () => {
    try{return await submitLocked(ctx,user,args,call,stored,refresh);}
    catch(error){
      const at=ctx.now().toISOString();
      ctx.log({traceId:call.traceId,run:stored.body.run,what:'submit_result interrupted',detail:describe(error)});
      const received=receivedDigest(args);
      const record=await submissionByDigest(ctx.deps.records.store,stored.body.run,received.digest);
      if(record!==null)await putAction(ctx.deps.records.store,{action:'validate',run:stored.body.run,inputs:[recReference(record.digest)],submissionRecord:record.digest,startedAt:at,endedAt:ctx.now().toISOString(),acceptance:null,codes:['check_error'],result:'error',errorCode:'check_error',detail:{hub_error:true,submission:received.digest,session:sessionOf(call),model:typeof args.model==='string'?args.model:null,repair:[],result:null,fix:'Hub 将在启动和每分钟自动重验，最多三次；也可带同一会话原样重交，不需要修改提交'}});
      return {call_result:'error',acceptance:'not_accepted',errors:[{code:'check_error',message:'未校验（中断）',fix:'Hub 将自动重验；也可带同一会话原样重交，不需要修改提交'}]};
    }
  });
}

async function submitLocked(ctx: EngineContext, user: Principal, args: Record<string, unknown>, call: CallContext, stored: StoredRecord<RunRecord>, refresh = false): Promise<SubmitAnswer> {
  if(ctx.parsers.forRun)ctx={...ctx,parsers:await ctx.parsers.forRun(stored.body.run)};
  const store = ctx.deps.records.store;
  const run = stored.body;
  try {
    assertOperationFields(args);
  } catch (error) {
    if (error instanceof KnowledgeError && (error.code === 'CREDENTIAL_IN_UPLOAD' || error.code === 'SUBMISSION_SCHEMA_VIOLATION')) {
      return { call_result: 'error', acceptance: 'not_accepted', errors: [{ code: error.code, message: error.message, fix: error.fix ?? PROTOCOL_CODES[error.code].fix, ...(typeof error.detail.path === 'string' ? { path: error.detail.path } : {}) }] };
    }
    throw error;
  }
  const received = receivedDigest(args);
  const sessionNow = sessionOf(call);
  const modelNow = typeof args.model === 'string' ? wellFormed(args.model) : null;

  const startedAt = ctx.now().toISOString();
  // Arguments canonical JSON cannot carry are never parsed: nothing built from them could be stored.
  const parsed = received.canonical ? Submission.safeParse(args) : null;
  const existing = await submissionByDigest(store, run.run, received.digest);
  const kept: Kept =
    existing !== null
      ? { record: existing, why: isVerbatimObject(existing) ? (received.canonical ? 'too_large' : 'canonical') : null }
      : await storeReceived(ctx, call.traceId, run.run, args, received, parsed?.success === true, startedAt);
  const record = kept.record;
  const management=await abandonDecision(ctx,run.run);
  const owner = keyOwner(run);
  const successors = (await successorsOf(store, run.run)).filter((s) => packIdOf(s.body.pack) === packIdOf(run.pack) && keyOwner(s.body) === owner);
  const eligible=!refresh&&management===null&&successors.length===0;
  const frozenWorkflow=eligible&&sessionNow===null?await ctx.deps.workflows.byDigest(run.pack_digest):undefined;
  const useCached=eligible&&(sessionNow!==null||frozenWorkflow!==undefined&&frozenWorkflow!==null&&frozenWorkflow.requirements.every(t=>t.independent_of===undefined));
  const repeat = !useCached ? null : await resultForObserver(ctx, run.run, received.digest, sessionNow, modelNow);
  if (repeat !== null) return answerOf(repeat);
  const previous=useCached?await resultFor(store,run.run,received.digest):null;
  if (useCached && previous !== null && previous.body.acceptance==='accepted' && !transitional(previous.body) && (previous.body.contributions !== undefined || (frozenWorkflow??await ctx.deps.workflows.byDigest(run.pack_digest))?.workflow.contribution !== undefined)) return answerOf(previous.body);

  const model = parsed?.success ? parsed.data.model : typeof args.model === 'string' ? wellFormed(args.model) : null;
  const session = sessionOf(call);
  const action = (input: { acceptance: Acceptance | null; codes: string[]; repair: string[]; result: string | null; actionResult?: 'error'; errorCode?: string; extra?: Record<string, unknown> }) =>
    putAction(store, {
      action: 'validate',
      run: run.run,
      inputs: [recReference(record.digest)],
      startedAt,
      endedAt: ctx.now().toISOString(),
      acceptance: input.acceptance,
      result: input.actionResult, errorCode: input.errorCode,
      codes: input.codes,
      detail: { submission: received.digest, session, model, ...(input.extra?.refusal === 'session_missing' ? {} : {repair: input.repair}), result: input.result, ...(input.extra ?? {}) },
      submissionRecord: record.digest,
    });

  if (packIdOf(run.pack) !== 'knowledge-contribution') {
    for (const binding of run.sources) {
      const ref = parseReference(binding.reference);
      if (ref.scheme !== 'src') continue;
      const original = binding.artifact !== undefined
        ? await store.get<import('../../records/api.ts').SourceArtifactBody>(binding.artifact)
        : (await ctx.deps.records.artifacts.source(user, ref.sha256, { consumer: 'function' })
          ?? await ctx.deps.records.artifacts.sourceForRun(user, ref.sha256, run.run, { consumer: 'function' }))?.artifact;
      if (original?.kind !== 'source_artifact' || original.body.provenance_type !== 'client_captured') continue;
      const refusal = protocolError('SUBMISSION_SCHEMA_VIOLATION', CAPTURED_GROUND, { path: '/run' });
      await action({ acceptance: 'not_accepted', codes: [refusal.code], repair: [], result: null, extra: { refusal: 'captured_ground' } });
      return { call_result: 'error', acceptance: 'not_accepted', errors: [refusal] };
    }
  }

  // W06 R[1]: superseded by a newer revision of the same work, the runner's own (another runner's run of this pack that
  // names this run is a branch of theirs; a run of another pack, such as the verification, continues it).
  if (successors.length > 0) {
    await action({ acceptance: 'not_accepted', codes: ['RUN_SUPERSEDED'], repair: [], result: null, extra: { superseded_by: successors.map((s) => s.body.run) } });
    return { call_result: 'error', acceptance: 'not_accepted', errors: [protocolError('RUN_SUPERSEDED', `运行 ${run.run} 已被新修订 ${successors[successors.length - 1].body.run} 取代`, { path: '/run' })] };
  }
  if(management!==null){
    const refusal=protocolError('RUN_ABANDONED',PROTOCOL_CODES.RUN_ABANDONED.when,{path:'/run'});
    const result:ValidationResult={schema:'validation@1',run:run.run,submission:received.digest,acceptance:'not_accepted',errors:[refusal],rounds:{used:0,max:0},partitions:emptyPartitions(),cross_item:[],coverage:{complete:false,examined:0,total:run.items.length,note:'已放弃运行的新输入仍原样保存，不重新核验'},locks:{...(run.skills?{skills:run.skills}:{}),...(run.feeding_offset?{feeding_offset:run.feeding_offset}:{}),pack:run.pack,pack_digest:run.pack_digest,...(run.root?{root:run.root}:{})},trace:call.traceId};
    const saved=await putResult(store,result,ctx.now().toISOString());
    await action({acceptance:'not_accepted',codes:['RUN_ABANDONED'],repair:[],result:saved.digest,extra:{refusal:'RUN_ABANDONED'}});
    return answerOf(saved.body);
  }
  const workflow = frozenWorkflow===undefined?await ctx.deps.workflows.byDigest(run.pack_digest):frozenWorkflow;
  if (workflow === null) {
    ctx.log({ traceId: call.traceId, run: run.run, what: 'submit_result', detail: `pack version ${run.pack} (${run.pack_digest}) is no longer loadable` });
    await action({ acceptance: 'not_accepted', codes: ['SOURCE_UNAVAILABLE'], repair: [], result: null });
    return { call_result: 'error', acceptance: 'not_accepted', errors: [unavailableError('/run')] };
  }
  if(!await criterionReviewVisible(ctx,user,run))return {call_result:'error',acceptance:'not_accepted',errors:[unavailableError('/inputs')]};
  const priorMaterial=workflow.workflow.incremental_submissions===true&&existing===null?(await store.find({key:INDEX.submissionRun,value:run.run,kind:'submission',newestFirst:true,limit:2})).items.find(r=>r.digest!==record.digest)?.body??null:null;
  const incrementalGrowth=workflow.workflow.incremental_submissions===true&&existing===null&&parsed?.success===true&&firstDeclarationGrowth(priorMaterial,args);
  const roundsUsed = await roundsUsedOf(ctx, run.run);
  const base: Basis = { ctx, user, call, run, workflow, digest: received.digest, submissionRecord:record.digest, roundsUsed };
  const early = earlyProblem(kept, received, args);
  let outcome: Validated;
  try {
    if (early !== null) {
      const errors = withRounds(workflow, args, [early], roundsUsed);
      outcome = { result: notAccepted(base, errors), problems: requirementsOf(errors) };
    } else if (parsed?.success === true) outcome = await validate(base, parsed.data, [], null);
    else outcome = await validatePartial(base, args, parsed?.error ?? null);
  } catch (error) {
    if (!(error instanceof HubReadFailure)) throw error;
    await action({ acceptance: null, codes: [error.reason], repair: [], result: null,
      actionResult: 'error', errorCode: error.reason,
      extra: { hub_error: true, source: error.reference, reason: error.reason, retry_attempts: error.attempts,
        message: error.message, fix: error.fix } });
    return { call_result: 'error', acceptance: 'not_accepted', errors: [protocolError('SOURCE_UNAVAILABLE', error.message, { fix: error.fix })] };
  }
  const sessionMissing = session === null && workflow.requirements.some(t => t.independent_of !== undefined&&!t.independence_by_account);
  if (sessionMissing) {
    outcome = { ...outcome, result: notAccepted(base, [protocolError('SUBMISSION_SCHEMA_VIOLATION', '独立复核缺少本会话的 id，整份提交未受理', {path:'', fix:'在请求头 Circle-Session-Id 里带上本会话的 id（1 到 200 个可打印 ASCII 字符），把同一份提交原样再交'}), ...outcome.result.errors]), problems: new Set() };
  }
  if(outcome.result.acceptance==='accepted')await applyDispatchResults(ctx,run,outcome.result);
  await recordResultRequests(ctx,run,outcome.result,roundsUsed,args);
  for(const error of outcome.result.errors)if(error.requirement&&isReason(error.code))outcome.problems.add(error.requirement);
  if(incrementalGrowth&&outcome.result.acceptance==='accepted')for(const key of [...outcome.problems])if(unknownOnlyRequirement(outcome.result,key))outcome.problems.delete(key);
  const saved = await keepResult(base, outcome);
  await answerRepairedRequests(ctx,run,saved.result.body,saved.result.digest);
  await action({
    acceptance: saved.result.body.acceptance,
    codes: saved.result.body.acceptance === 'not_accepted' ? unique(saved.result.body.errors.map((e) => e.code)) : [],
    repair: [...saved.problems].sort(),
    result: saved.result.digest,
    extra: { ...(saved.result.body.acceptance==='accepted' && outcome.runtimeAdmission?.length ? {admission:outcome.runtimeAdmission} : {}), reevaluation:refresh,...(incrementalGrowth?{first_material_growth:true}:{}),retry_attempts: saved.retryAttempts,...(outcome.parentObservedSuccess?{parent_observed_success:true}:{}), ...(sessionMissing ? {refusal:'session_missing'} : {}) },
  });
  return answerOf(saved.result.body);
}

/** What a validation of one submission is made from. */
interface Basis {
  submissionRecord: string;
  ctx: EngineContext;
  user: Principal;
  call: CallContext;
  run: RunRecord;
  workflow: LoadedWorkflow;
  /** Digest of the submission as received. */
  digest: string;
  roundsUsed: Map<string, number>;
}

interface Validated {
  criterionChanges?:Array<{index:number;change:import('../../../contracts/src/criterion.ts').CriterionChange}>;
  runtimeAdmission?:RuntimeAdmission[];
  result: ValidationResult;
  /** Requirements whose problems in this submission count as a repair round. */
  problems: Set<string>;
  retryAttempts?: Array<Record<string, unknown>>;
  parentObservedSuccess?:boolean;
  prepared?: Map<string, PreparedContribution>;
  refusals?:Map<string,string>;
  model?: string;
}

const requirementsOf = (errors: readonly ProtocolError[]): Set<string> => new Set(errors.flatMap((e) => (e.requirement !== undefined ? [e.requirement] : [])));

/** Arguments the Hub keeps but does not read: not canonical JSON, too large for a record, nested past MAX_SUBMISSION_DEPTH. */
function earlyProblem(kept: Kept, received: ReturnType<typeof receivedDigest>, args: unknown): ProtocolError | null {
  if (kept.why === 'canonical') {
    return protocolError('SUBMISSION_SCHEMA_VIOLATION', '提交里有规范 JSON 表示不了的值（孤立的代理字符，或嵌套超过 1000 层）：已原样保存，没有核对', {
      path: clipPointer(received.nonCanonicalPath ?? ''),
      fix: '把这个值改成完整的 Unicode 文本（不要截断在代理对中间）、减少嵌套后重交',
    });
  }
  if (kept.why === 'too_large') {
    return protocolError('SUBMISSION_SCHEMA_VIOLATION', '提交超过 Hub 一条记录的大小上限：已原样保存为对象，没有核对', {
      path: '',
      fix: '把被判对象分块（每块分别开运行），或缩短陈述和引文后重交',
    });
  }
  const deep = tooDeep(args, MAX_SUBMISSION_DEPTH);
  if (deep !== null) {
    return protocolError('SUBMISSION_SCHEMA_VIOLATION', `提交嵌套超过 ${MAX_SUBMISSION_DEPTH} 层：已原样保存，没有核对`, {
      path: clipPointer(deep),
      fix: `嵌套超过 ${MAX_SUBMISSION_DEPTH} 层`,
    });
  }
  return null;
}

/** Rounds left on whole-rejection errors inside a requirement's statements (scenario 2: the receipt carries the rounds left). */
function withRounds(workflow: LoadedWorkflow, submission: unknown, errors: ProtocolError[], roundsUsed: ReadonlyMap<string, number>): ProtocolError[] {
  return errors.map((e) => {
    const key = e.requirement ?? requirementAt(workflow, submission, e.path);
    const template = key === null ? undefined : workflow.requirements.find((t) => t.key === key);
    if (template === undefined) return e;
    const rounds = repairRounds(template);
    return { ...e, requirement: template.key, ...(rounds > 0 ? { rounds_left: Math.max(0, rounds - (roundsUsed.get(template.key) ?? 0)) } : {}) };
  });
}

function notAccepted(base: Basis, errors: ProtocolError[]): ValidationResult {
  const { run, workflow, roundsUsed } = base;
  const max = workflow.requirements.reduce((m, t) => Math.max(m, repairRounds(t)), 0);
  const used = Math.min(max, workflow.requirements.reduce((m, t) => Math.max(m, Math.min(roundsUsed.get(t.key) ?? 0, repairRounds(t))), 0));
  return {
    schema: 'validation@1',
    run: run.run,
    submission: base.digest,
    acceptance: 'not_accepted',
    errors,
    rounds: { used, max },
    partitions: emptyPartitions(),
    cross_item: [],
    coverage: { complete: false, examined: 0, total: run.items.length, note: '提交未受理，没有分区' },
    locks: { ...(run.skills?{skills:run.skills}:{}),...(run.feeding_offset?{feeding_offset:run.feeding_offset}:{}),...(run.unversioned_root ? { unversioned_root: run.unversioned_root } : {}), pack: run.pack, pack_digest: run.pack_digest, ...(run.root !== undefined ? { root: run.root } : {}) },
    trace: base.call.traceId,
  };
}

/**
 * Stores the result. A result a record cannot hold (over the record limit, or nesting canonical JSON refuses) is answered not
 * accepted with SUBMISSION_SCHEMA_VIOLATION and the fix to split the target, so that every call still gets a receipt.
 */
async function keepResult(base: Basis, outcome: Validated): Promise<{ result: StoredRecord<ValidationResult>; problems: Set<string>; retryAttempts: Array<Record<string, unknown>> }> {
  const { ctx } = base;
  const store = ctx.deps.records.store;
  try {
    const save = async () => {
      const criteria=outcome.criterionChanges??[];
      if(outcome.result.acceptance!=='accepted')return putResult(store,outcome.result,ctx.now().toISOString());
      if(outcome.prepared===undefined&&!criteria.length&&!base.run.criterion_review)return putResult(store,outcome.result,ctx.now().toISOString());
      return store.withTransaction(async tx => {
        await publishCriterionRequests(ctx,base.run,base.submissionRecord,criteria,outcome.result,tx);
        if(outcome.prepared===undefined){const stored=await putResult(store,outcome.result,ctx.now().toISOString(),tx);await answerCriterionReview(ctx,base.run,stored,tx);return stored;}

        const receipt: NonNullable<ValidationResult['contributions']> = { submitted: outcome.prepared!.size+(outcome.refusals?.size??0), stored: [], not_stored: [...(outcome.refusals??new Map())].map(([item,reason])=>({item,reason})) };
        const eligible = new Set(outcome.result.partitions.delivered.filter(item => item.requirements.length > 0 && item.requirements.every(r => r.status === 'satisfied')).map(item => item.item));
        const layer = ctx.deps.knowledge.layers!.contributions;
        await layer.lockIdentities([...outcome.prepared!].filter(([item]) => eligible.has(item)).map(([, prepared]) => prepared), tx);
        for (const [item, prepared] of outcome.prepared!) {
          if (!eligible.has(item)) {
            const state = Object.values(outcome.result.partitions).flat().find(row => row.item === item);
            const missing = state?.requirements.filter(r => r.status !== 'satisfied').map(r => r.requirement).join('、') ?? '';
            receipt.not_stored.push({ item, reason: `要求项尚未全部满足，未入回注层：${missing}；按本回执的要求项和修正说明修复后，用 submit_result 重交本次运行` });
            continue;
          }
          const record = await layer.append(prepared, {run:base.run.run,submission:base.digest,session:sessionOf(base.call),model:outcome.model!}, tx);
          const saved = await store.get(record, tx);
          const body = saved && KnowledgeStore.contributionOf(saved);
          if (!body) throw new KnowledgeError('回注入层记录缺失或结构不符，不能确定设备租约状态', {code:'SOURCE_UNAVAILABLE'});
          receipt.stored.push({ item, record, ...(operationDeviceStatus(body.feeding) ?? {}) });
        }
        return putResult(store, { ...outcome.result, contributions: receipt }, ctx.now().toISOString(), tx);
      });
    };
    return { result: await save(), problems: outcome.problems, retryAttempts: outcome.retryAttempts ?? [] };
  } catch (error) {
    if (!(error instanceof LimitError) && !(error instanceof CanonicalizationError)) throw error;
    ctx.log({ traceId: base.call.traceId, run: base.run.run, what: 'submit_result', detail: `validation result not stored: ${describe(error)}` });
    const size = error instanceof LimitError && typeof error.detail.size === 'number' ? error.detail.size : null;
    const limit = error instanceof LimitError && typeof error.detail.limit === 'number' ? error.detail.limit : null;
    const message =
      size !== null && limit !== null
        ? `这次提交的校验结果有 ${size} 字节，超过 Hub 一条记录的上限 ${limit} 字节，存不下，没有受理`
        : '这次提交的校验结果超出 Hub 一条记录能存的范围，存不下，没有受理';
    const tooLarge = protocolError('SUBMISSION_SCHEMA_VIOLATION', message, {
      path: '',
      fix: size !== null && limit !== null ? `把被判对象分成至少 ${Math.ceil(size / limit)} 块（每块分别开运行），或缩短陈述和引文后重交` : '把被判对象分块（每块分别开运行），或缩短陈述和引文后重交',
    });
    return { result: await putResult(store, notAccepted(base, [tooLarge]), ctx.now().toISOString()), problems: new Set(), retryAttempts: outcome.retryAttempts ?? [] };
  }
}

/** Where each entry of a checked submission stands in the arguments (W08 R[1] checks the entries that parse on their own). */
interface Positions {
  items: number[];
  cross: number[];
}

function remap(path: string | undefined, positions: Positions | null): string | undefined {
  if (path === undefined || positions === null) return path;
  const m = /^\/(items|cross_item)\/([0-9]+)(.*)$/.exec(path);
  if (m === null) return path;
  const original = (m[1] === 'items' ? positions.items : positions.cross)[Number(m[2])];
  return original === undefined ? path : `/${m[1]}/${original}${m[3]}`;
}

/**
 * W08 R[1] for arguments that do not parse as submission@1: their issues are the whole-rejection codes, and the entries that
 * parse on their own (items[] and cross_item[], each kept once, none an issue points into) are checked like a submission, so
 * the not-accepted receipt also names their causes and item-level refutations.
 */
async function validatePartial(base: Basis, args: Record<string, unknown>, error: z.ZodError | null): Promise<Validated> {
  const slotSchema = slotSchemaOf(base.workflow)?.schema as Record<string, unknown> | undefined;
  const issues = error === null ? [] : withRounds(base.workflow, args, issuesOf(error, '', slotSchema), base.roundsUsed);
  const pointed = (field: string): Set<number> =>
    new Set((error?.issues ?? []).flatMap((i) => (i.path[0] === field && typeof i.path[1] === 'number' ? [i.path[1]] : [])));
  const badItems = pointed('items');
  const badCross = pointed('cross_item');
  const positions: Positions = { items: [], cross: [] };
  const items: Submission['items'] = [];
  const seen = new Set<string>();
  if (Array.isArray(args.items)) {
    args.items.forEach((raw, i) => {
      const entry = badItems.has(i) ? null : ItemSubmission.safeParse(raw);
      if (entry === null || !entry.success || seen.has(entry.data.item)) return;
      seen.add(entry.data.item);
      items.push(entry.data);
      positions.items.push(i);
    });
  }
  const cross: NonNullable<Submission['cross_item']> = [];
  if (Array.isArray(args.cross_item)) {
    args.cross_item.forEach((raw, j) => {
      const entry = badCross.has(j) ? null : CrossItemSubmission.safeParse(raw);
      if (entry === null || !entry.success) return;
      // A premise is a position in the arguments; in the checked entries it would point elsewhere.
      cross.push(entry.data.nature === 'judgment' ? { ...entry.data, premises: [] } : entry.data);
      positions.cross.push(j);
    });
  }
  const model = typeof args.model === 'string' && args.model.length > 0 ? args.model : UNDECLARED_MODEL;
  const partial: Submission = { run: base.run.run, model, items, ...(cross.length > 0 ? { cross_item: cross } : {}) };
  const checked = await validate(base, partial, issues.length > 0 ? issues : [protocolError('SUBMISSION_SCHEMA_VIOLATION', '提交的结构不对', { path: '' })], positions);
  return checked;
}

/** Whole-submission boundary; an unruled interpreter is preserved but never executed. */
export function runtimeCheckProblems(workflow: LoadedWorkflow, items: readonly {id:string}[], submission: Submission): ProtocolError[] {
  const errors: ProtocolError[] = [];
  const add = (path:string,message:string) => errors.push(protocolError('SUBMISSION_SCHEMA_VIOLATION',message,{path,fix:'按要求项的 run_table 和已发布台账修正；样例必须引用本运行的条目后重交'}));
  for (const [i,check] of (submission.checks ?? []).entries()) {
    const at = pointerOf('checks',i);
    const requirement = workflow.requirements.find(r=>r.key===check.requirement);
    if (!requirement?.run_table) add(at+'/requirement','要求项没有声明允许运行内的表');
    if (workflow.ledger?.shapes.some(row=>row.requirement===check.requirement && row.interpreter===check.interpreter)) {
      const interpreter = getInterpreter(check.interpreter);
      if (!interpreter || interpreter.validateTable(check.table).length) add(at+'/table','表不符合台账允许的解释器格式');
    }
    check.samples.forEach((sample,j)=>{
      if (!items.some(item=>item.id===sample.item)) add(at+`/samples/${j}/item`,'样例不在本运行的条目中');
    });
  }
  return errors;
}

async function validate(base: Basis, submission: Submission, before: ProtocolError[], positions: Positions | null): Promise<Validated> {
  const { ctx, user, call, run, workflow, roundsUsed } = base;
  const capability=workflow.workflow.contribution;
  const attribute=(errors:ProtocolError[])=>errors.map(error=>{
    const tokens=error.path?.split('/');
    return capability!==undefined&&tokens?.[1]==='items'&&tokens[3]==='slots'&&tokens[4]===capability.slot?{...error,requirement:capability.requirement}:error;
  });
  const structure = attribute([...slotProblems(workflow, run.items, submission), ...runtimeCheckProblems(workflow,run.items,submission)]);
  if(submission.criterion_changes?.length&&!run.submission_due)structure.push(protocolError('SUBMISSION_SCHEMA_VIOLATION','历史运行缺少提交期限，不能建立判据复核请求',{path:'/criterion_changes',fix:'以本运行为 predecessor 开新修订，取得明确提交期限后重交声明'}));
  const exactAttempts: Array<Record<string, unknown>> = [];
  const scope = await buildScope(ctx, run, workflow, user, 'function', exactAttempts);
  const resolver = createResolver(ctx, scope, 'function', exactAttempts);
  const carried = await carriedItems(ctx, scope, resolver, workflow, run, submission);
  for (const p of carried.problems) structure.push(protocolError('SUBMISSION_SCHEMA_VIOLATION', p.message, { path: p.path, item: p.item }));
  const prepared = workflow.workflow.contribution === undefined ? undefined : new Map<string, PreparedContribution>();
  const refusals=new Map<string,string>();
  const admission=capability===undefined?undefined:{requirement:capability.requirement,outcomes:new Map<string,CheckOutcome[]>()};
  const contributionScope: ContributionScope = {run:run.run,classifications:workflow.workflow.feeding?.classifications,
          additionalRoots: run.unversioned_root ? [{ root: run.unversioned_root, composition: (()=>{const value=run.target_basis.find(c=>c.statement.data?.field==='unversioned_root')?.statement.data?.composition;return typeof value==='string'?value:null;})() }] : [],
          model:submission.model,session:sessionOf(call),
          composition:(()=>{const value=run.target_basis.find(c=>c.statement.data?.field==='build'&&c.statement.data?.root===run.root)?.statement.data?.composition;return typeof value==='string'?value:null;})(),
          root:run.root ?? null, product:run.product ?? null, resolve:async reference => {
            const resolved = await resolver.resolve(reference);
            if (!resolved.ok) return resolved;
            const ref = parseReference(reference);
            if (ref.scheme !== 'rec') return resolved;
            const record = await ctx.deps.records.store.get(ref.record);
            const bytes = record === null ? null : recordBytes(record, ref.pointer);
            return record === null || bytes === null ? resolved : {ok:true as const,value:{...resolved.value,recordSource:{sha256:sha256Hex(bytes),record:record.digest,provenance:record.provenance,kind:record.kind,schema:record.schema}}};
          },
  };
  if (prepared !== undefined) {
    const slot = workflow.workflow.contribution!.slot;
    const layer = ctx.deps.knowledge.layers?.contributions;
    for (const [i, item] of submission.items.entries()) {
      if (item.handling !== 'handled') continue;
      const claims = item.slots?.[slot];
      const at = pointerOf('items', i, 'slots', slot);
      if (layer === undefined || !Array.isArray(claims) || claims.length !== 1) {
        structure.push(protocolError('SUBMISSION_SCHEMA_VIOLATION', layer === undefined ? '回注层尚未接通' : '每个回注条目必须有且只有一条回注产物', {path:at,item:item.item}));
        continue;
      }
      const claim = claims[0];
      try {
        const value = await layer.prepare(user, { ...(isObject(claim.data) ? claim.data : {}), kind:claim.code, statement:claim.text }, contributionScope);
        prepared.set(item.item, value);
      } catch(error) {
        if(error instanceof ContributionRefusal){
          const statement=`${error.message}；${error.fix}`;
          refusals.set(item.item,statement);
          admission!.outcomes.set(item.item,[{verdict:'refute',code:error.admissionCode,statement,grounds:[],tier:'blocking',pointer:`/slots/${slot}/0`,data:{fix:error.fix}}]);
          ctx.log({traceId:call.traceId,run:run.run,what:'contribution.admission',detail:JSON.stringify({code:error.admissionCode,...error.detail})});
          continue;
        }
        if (!(error instanceof KnowledgeError)) throw error;
        structure.push(protocolError(error.code ?? 'SUBMISSION_SCHEMA_VIOLATION', error.message, {path:at,item:item.item,fix:error.message,requirement:capability!.requirement}));
      }
    }
  }
  const declarations = new Set((run.outputs?.tasks ?? []).map(output => output.id));
  for (const [i, output] of (submission.task_outputs ?? []).entries()) if (!declarations.has(output.output)) structure.push(protocolError('SUBMISSION_SCHEMA_VIOLATION', '按任务的产出未在任务包里声明', {path:pointerOf('task_outputs',i,'output'),fix:'请任务包维护人在 workflow.outputs.tasks 声明该产出，或从 task_outputs 移除后重交'}));
  const exact = await resolveSubmission(scope, resolver, workflow, run.items, submission);
  const origin: ProducerOrigin = submissionOrigin(submission,[run.session ?? null, sessionOf(call)]);
  const author: AuthorOrigin | null = await authorOriginOf(ctx, run);
  const moved = (errors: ProtocolError[]): ProtocolError[] => errors.map((e) => (positions === null || e.path === undefined ? e : { ...e, path: remap(e.path, positions) }));
  // Partial-schema errors already carry original argument positions and rounds.
  const prior = before.map(error => { const attributed = attribute([error])[0]; return attributed.requirement === error.requirement ? error : withRounds(workflow, submission, [attributed], roundsUsed)[0]; });
  const rejection = [...prior, ...moved(withRounds(workflow, submission, attribute([...structure, ...exact.errors]), roundsUsed))];
  const input = {
    run,
    workflow,
    submission,
    submissionDigest: base.digest,
    submissionRecord:base.submissionRecord,
    exact,
    // The evaluation grades the texts this exact phase read against the records they came from (round-eight review, item 3).
    ...(scope.pinned === undefined ? {} : { pinned: scope.pinned }),
    carried: carried.carried,
    roundsUsed,
    origin,
    author,
    traceId: call.traceId,
    ...(admission===undefined?{}:{admission}),
  };
  if (rejection.length === 0) {
    const evaluation = await evaluate(ctx, input);
    evaluation.result.errors.push(...(exact.criterionRefusals??[]));
    return { criterionChanges:exact.criterionChanges, runtimeAdmission:evaluation.runtimeAdmission, result: evaluation.result, problems: new Set([...evaluation.problems, ...evaluation.uncovered]), retryAttempts: [...exactAttempts, ...evaluation.retryAttempts],parentObservedSuccess:evaluation.parentObservedSuccess, ...(prepared === undefined ? {} : {prepared,refusals,model:submission.model}) };
  }
  // W08 R[1]: the checks still run on the items whose own values resolved; their refutations are the fix notes.
  const failed = new Set<string>([...exact.failedItems, ...structure.flatMap((e) => (e.item !== undefined ? [e.item] : []))]);
  const evaluation = await evaluate(ctx, { ...input, exclude: failed });
  const notes = moved(evaluation.errors.filter((e) => e.code !== 'core.coverage.shortfall'));
  const result = notAccepted(base, [...rejection, ...notes]);
  if (prepared !== undefined) {
    const items = submission.items.filter(item => item.handling === 'handled');
    result.contributions = {
      submitted: items.length, stored: [], not_stored: items.map(item => ({item:item.item,
        reason: refusals.get(item.item) ?? (rejection.filter(error => error.item === item.item).map(error => error.fix ?? error.message).join('；')
          || '整份提交未受理，未入回注层；按边界修正说明修复后，用 submit_result 重交本次运行')})),
    };
  }
  return {
    result,
    problems: new Set([...requirementsOf(rejection), ...evaluation.problems]),
    retryAttempts: [...exactAttempts, ...evaluation.retryAttempts],
  };
}
