import {CheckReadBudget} from './read-budget.ts';
import {replacedCriteria,frozenCriteria} from './criterion-changes.ts';
import {authorAccountsOf} from './lineage.ts';
import {accountIndependenceOf,authorAccount} from './independence.ts';
import {attachParentRecovery} from './parent-recovery.ts';
// The Hub recomputes everything itself (T03 R[1], W08): every check of every requirement re-runs through hub/rules with the
// pack's table, the locked catalog and the subject; outcomes become the terminals of each (item, requirement, layer), the
// requirement status, the claims and the partitions. A run-level check gets one subject built from all items, an item check
// one subject per item; outcomes are assigned to items by their item id and an outcome without an item is a run-level fact.
import { CORE_VIOLATION_CODES } from '../../../contracts/generated/protocol.ts';
import type { FragmentRead, PermissionRole, ProvenanceType, Reason, SourceRole } from '../../../contracts/generated/vocabulary.ts';
import type { Claim } from '../../../contracts/src/claim.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import { SubjectBlocked, MAX_CHECK_READ_BYTES, type CheckEntry, type RequirementTemplate, type RunContext, type SlotClaim, type SubjectItem } from '../../../contracts/src/pack.ts';
import type { ItemProjection, RunRecord } from '../../../contracts/src/run.ts';
import type { Submission } from '../../../contracts/src/submission.ts';
import type { RequirementResult, ValidationResult } from '../../../contracts/src/validation.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import { publishCheckMarks } from '../packs/marks.ts';
import type { Principal } from '../../records/api.ts';
import { MAX_REFERENCE_LENGTH, parseReference, resolveReference, type ResolveContext } from '../../refs/api.ts';
import { SandboxError, callPackFunction, callPackFunctionBatch, runCheck, sourcesFrom, type CatalogView, type CheckOutcome, type SourceView, type FragmentReadFailure, type UnreadSource, type SandboxOptions, type SandboxBatchItem, type PackFunctionTarget } from '../../rules/api.ts';
import { mapLimited, receivedDigest } from './util.ts';
import { getInterpreter } from '../../rules/api.ts';
import { factClaim, judgmentClaim, sourceCoverage, rootDigest, statementOf, strongestRole } from './claims.ts';
import { ENGINE_COMPONENT, type EngineContext } from './deps.ts';
import { attemptEvidence } from './retry-evidence.ts';
import { HubReadFailure, retryRead, type ReadFailureReason } from './retry-read.ts';
import { narrowSubjectRead, type NarrowReadResult } from './narrow-reads.ts';
import { putAction } from './store.ts';
import { createFunctionBatches } from './function-batches.ts';
import { SubjectCopyError, createSubjectBuilder, subjectKey } from './subjects.ts';
import { describe, fixOf } from './errors.ts';
import { declarationGroundRefusal } from '../../knowledge/declaration-grade.ts';
import { buildScope, scopeProblem, emptyEvidence, type ExactResult, type ItemEvidence } from './exact.ts';
import { independenceOf, warrantIndependence, type AuthorOrigin, type ProducerOrigin } from './independence.ts';
import { partitionItems, type PartitionInput } from './partitions.ts';
import { identityOf, principalOf, recordReader, sourceReader } from './readers.ts';
import { runRequirementOf } from './slots.ts';
import {
  applyRouting,
  bindRecovery,
  waitForRepairs,
  dynamicLayer,
  expectationFor,
  repairRounds,
  requirementStatus,
  staticLayer,
  staticTerminal,
  type Handling,
  type JudgedOutcome,
} from './terminals.ts';
import { isObject, pointerOf, tooDeep, unique, valueAt } from './util.ts';

/** An item the submission handled by carrying the predecessor's fragment over (C08 R[4]). */
export interface CarriedItem {
  /** The rec: reference given back, equal to the one start_run offered. */
  reuse: string;
  /** The slot record as the predecessor's submission gave it; the checks re-run on it (canonical form in evidence.slots). */
  slots: Record<string, unknown>;
  /** The predecessor's judgments of the item by requirement, judge and model configuration from that record. */
  claims: Map<string, Claim[]>;
  evidence: ItemEvidence;
  origin: ProducerOrigin;
}

export interface EvaluationInput {
  run: RunRecord;
  workflow: LoadedWorkflow;
  /** The parsed submission; null for a production result. */
  submission: Submission | null;
  /** Digest of the submission as received, or of the run record for a production result. */
  submissionDigest: string;
  submissionRecord?: string;
  exact: ExactResult | null;
  carried: ReadonlyMap<string, CarriedItem>;
  /** Repair rounds each requirement used in earlier submissions of the run. */
  roundsUsed: ReadonlyMap<string, number>;
  /** Who produced this submission's judgments; null for a production result. */
  origin: ProducerOrigin | null;
  /** Who produced the work the run judges (lineage.ts); null when the Hub does not know (no predecessor). */
  author: (AuthorOrigin & {missingSessions?:string[]}) | null;
  traceId: string;
  /** Items whose own exact values did not resolve: no checks or conclusions for them (a not-accepted submission). */
  exclude?: ReadonlySet<string>;
  /** Hub admission policy facts, kept on the declared item requirement rather than whole-submission errors. */
  admission?: {requirement:string;outcomes:ReadonlyMap<string,CheckOutcome[]>};
}

/** The same production evaluation inputs are used at startup and before an effect replay. */
export function productionEvaluationInput(run: RunRecord, workflow: LoadedWorkflow, runDigest: string, traceId: string): EvaluationInput {
  return {run,workflow,submission:null,submissionDigest:runDigest,exact:null,carried:new Map(),roundsUsed:new Map(),origin:null,author:null,traceId};
}

export interface RuntimeAdmission {
  admitted: boolean;
  provenance: ProvenanceType;
  missing?: string;
  next_action?: string;
  requirement: string;
  interpreter: string;
  table_sha256: string;
  samples: Array<{
    item: string;
    expect: NonNullable<Submission['checks']>[number]['samples'][number]['expect'];
    source_provenance: {reference:string;record:string;provenance:string;origin:unknown;author:unknown;outside_author:boolean} | null;
    outcome: CheckOutcome[];
    passed: boolean;
    missing?: string;
    next_action?: string;
  }>;
}

export interface Evaluation {
  runtimeAdmission: RuntimeAdmission[];
  result: ValidationResult;
  /** Item-level refutations routed by the error table and the items the submission did not cover (also in result.errors). */
  errors: ProtocolError[];
  /** Requirements with a refutation routed to repair in this submission (a repair round). */
  problems: Set<string>;
  /** Requirements of the items the submission did not cover (W07 R[3]: also a repair round). */
  uncovered: Set<string>;
  retryAttempts: Array<Record<string, unknown>>;
  parentObservedSuccess:boolean;
}

type Slots = Record<string, unknown> | null;

const isJudgment = (t: RequirementTemplate): boolean => t.accepted_producer !== 'fact';

/** Deepest `data` the engine takes from a check outcome: a claim nests it about ten levels deep in the stored result. */
export const MAX_OUTCOME_DATA_DEPTH = 32;

/** A context digest the claims can be bound to (HandledItem.context; other spellings stay in the stored submission only). */
const SHA256 = /^[0-9a-f]{64}$/;

/** sandboxReason of hub/rules, for subject builders the engine calls itself. */
function sandboxReason(error: SandboxError): Reason {
  if (error.code === 'SANDBOX_TIMEOUT') return 'timeout';
  if (error.code === 'SANDBOX_UNAVAILABLE' && error.detail.reason === 'queue_full') return 'budget_exhausted';
  return 'check_error';
}

/** The unknown outcome a failed subject builder gives, marked as a sandbox failure like runCheck's. */
function builderFailure(check: CheckEntry, error: unknown): CheckOutcome {
  if (error instanceof SubjectCopyError) return {
    verdict: 'unknown', reason: 'check_error', missing: `检查 ${check.id} 的可复制被判对象；下一步：修复复制能力后重核`, tier: check.tier ?? 'advisory', grounds: [],
    statement: `Hub 复制检查 ${check.id} 的被判对象数据失败；请 Hub 维护人恢复复制能力后重试`,
    data: { phase: 'subject_copy', module: check.subject?.module ?? null },
  };
  const sandbox = error instanceof SandboxError;
  const reason: Reason = sandbox ? sandboxReason(error) : 'check_error';
  return {
    verdict: 'unknown',
    reason,
    missing: `检查 ${check.id} 的被判对象；下一步：修复或重试构建后重核`,
    statement: `未知（检查 ${check.id} 的被判对象没有构建出来）：${sandbox ? error.message : '包内函数无法运行'}`,
    grounds: [],
    tier: check.tier ?? (check.basis ? 'blocking' : 'advisory'),
    data: { sandbox: sandbox ? error.code : 'FUNCTION_THREW', phase: 'subject', module: check.subject?.module ?? null },
  };
}

/** An outcome whose data nests too deep to store is a check error of that check (the engine never stores what it cannot). */
function bounded(check: CheckEntry, outcome: CheckOutcome): CheckOutcome {
  if (outcome.data === undefined || tooDeep(outcome.data, MAX_OUTCOME_DATA_DEPTH) === null) return outcome;
  return {
    verdict: 'unknown',
    reason: 'check_error',
    missing: `检查 ${check.id} 在存储深度上限内的判定结果；下一步：包主人修复输出后重跑`,
    statement: `未知（检查出错）：检查 ${check.id} 给出的 data 嵌套超过 ${MAX_OUTCOME_DATA_DEPTH} 层`,
    grounds: [],
    tier: outcome.tier,
    ...(outcome.item !== undefined ? { item: outcome.item } : {}),
  };
}

function tableFailure(check: CheckEntry): CheckOutcome {
  return {
    verdict: 'unknown',
    reason: 'check_error',
    missing: `检查 ${check.id} 的可读规则表 ${check.table ?? ''}；下一步：包主人补齐规则表后重跑`,
    statement: `未知（检查出错）：检查 ${check.id} 的表 ${check.table ?? ''} 读不到`,
    grounds: [],
    tier: check.tier ?? (check.basis ? 'blocking' : 'advisory'),
  };
}

/** The closed sets of the slots file by name, for membership@1 and coverage@1 `{ name }` sets: `<key>.codes`, `<key>.ranks`. */
function closedSets(workflow: LoadedWorkflow): Record<string, string[]> {
  const sets: Record<string, string[]> = {};
  for (const declarations of [workflow.slots.item, workflow.slots.run]) {
    for (const [key, d] of Object.entries(declarations)) {
      if (d.codes) sets[`${key}.codes`] = d.codes.map((c) => c.code);
      if (d.ranks) sets[`${key}.ranks`] = d.ranks.map((r) => r.code);
    }
  }
  return sets;
}

/** The names of the bound product line, as frozen in the run's target basis (the product claim). */
export function productNamesOf(run: Pick<RunRecord, 'target_basis'>): string[] {
  for (const claim of run.target_basis) {
    const data = claim.statement.data;
    if (data?.field === 'product' && Array.isArray(data.names)) return data.names.filter((n): n is string => typeof n === 'string');
  }
  return [];
}

/** The facts about a run that checks and pack functions may use, from the frozen run record. */
export function runContextOf(run: RunRecord): RunContext {
  return {
    run: run.run,
    predecessor: run.predecessor ?? null,
    ...(run.product_pack_digest ? {product_pack_digest:run.product_pack_digest}:{}),
    ...(run.skills!==undefined?{skills:run.skills}:{}),
    ...(run.command_policy?{command_policy:run.command_policy}:{}),
    ...(run.feeding_offset?{feeding_offset:run.feeding_offset}:{}),
    product: run.product ?? null,
    names: productNamesOf(run),
    line: run.version ?? null,
    build: run.build ?? null,
    root: run.root ?? null,
    parameters: run.parameters,
    groups: run.groups ?? [],
    ...(run.builds !== undefined ? { builds: run.builds } : {}),
    ...(run.lease_context !== undefined ? { leases: contextLeasesOf(run) } : {}),
  };
}

/** The lease view the checks see: the frozen pre-projection view, every row the run's own operations named marked
 * `mine` (its acquisitions and extensions — releases too: the projection decided about them), plus rows held by the
 * run's lineage (D04 R[0]: a booking lease is held by the lineage, so a successor sees the keys it may operate on). */
function contextLeasesOf(run: RunRecord): NonNullable<RunContext['leases']> {
  const mine = new Set((run.leases ?? []).flatMap((entry) => (entry.op === undefined || entry.op === 'acquire' || entry.op === 'extend' || entry.op === 'release') && 'keys' in entry ? entry.keys : []));
  const entries = new Map<string, NonNullable<RunRecord['lease_context']>[number]>();
  for (const row of run.lease_context ?? []) entries.set(row.key, { ...row, mine: row.mine || mine.has(row.key) });
  // Old pinned packs receive their old snapshot unchanged; new start_run always freezes complete rows.
  return { now: run.started_at, registrations: run.lease_registrations ?? [], entries: [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) } as NonNullable<RunContext['leases']>;
}

/** rule@version of a check: the core interpreter, or the pack function check of this pack version. */
const ADMISSION_CHECK='@hub.contribution';
function ruleOf(workflow: LoadedWorkflow, check: CheckEntry): string {
  if(check.id===ADMISSION_CHECK)return 'knowledge.contribution@1';
  return check.interpreter ?? `${workflow.pack.id}.${check.id}@${workflow.pack.version}`;
}

export interface ReplayedChecks {outcomes:Record<string,CheckOutcome[]>;retryAttempts:Array<Record<string,unknown>>}
export function evaluate(ctx:EngineContext,input:EvaluationInput & {replayChecks:ReadonlySet<string>}):Promise<ReplayedChecks>;
export function evaluate(ctx:EngineContext,input:EvaluationInput):Promise<Evaluation>;
export async function evaluate(ctx: EngineContext, input: EvaluationInput & {replayChecks?:ReadonlySet<string>}): Promise<Evaluation|ReplayedChecks> {
  const { run, workflow, submission } = input;
  const accountAuthors=workflow.requirements.some(t=>t.independence_by_account)?await authorAccountsOf(ctx,run.predecessor):null;
  const administrators = (await ctx.deps.records.principals?.list?.() ?? [])
    .filter(user => user.role === 'admin' && !user.disabled).sort((a, b) => a.id.localeCompare(b.id));
  const retryAttempts: Array<Record<string, unknown>> = [];
  let parentObservedSuccess=false;
  const sandboxFor = (_operation: string, module?: string, item?: string, extra: Record<string, unknown> = {}): SandboxOptions => ({
    ...ctx.deps.sandbox,
    retryWallTimeout: true,
    onAttempt: attempt => {
      if(attempt.code===undefined)parentObservedSuccess=true;
      if (attempt.retry || attempt.attempt > 1) retryAttempts.push(attemptEvidence('validate', run.pack, attempt, { ...extra,
        ...(attempt.code==='SANDBOX_UNAVAILABLE'&&!attempt.retry&&attempt.attempt>1?{parent_unavailable:true}:{}),
        ...(module !== undefined ? { module } : {}), ...(item !== undefined ? { item } : {}) }));
      try { ctx.deps.sandbox?.onAttempt?.(attempt); } catch { /* Diagnostics cannot change a check. */ }
    },
  });

  // The sample marks of the locked version's checks (T02 R[1]), computed once: fact claims of a check with only author
  // samples carry author_samples_only. A model judgment never takes them — they speak about a rule's samples.
  const sampleMarks = publishCheckMarks(workflow);
  const exclude = input.exclude ?? new Set<string>();
  const runtimeChecks = new Map<string, NonNullable<Submission['checks']>[number]>();
  const runtimeCatalogGaps = new Map<string,{missing:string;next_action:string}>();
  for (const [index,declared] of (submission?.checks ?? []).entries()) {
    const allowed=workflow.requirements.some(t=>t.key===declared.requirement && t.run_table)
      && workflow.ledger?.shapes.some(row=>row.requirement===declared.requirement && row.interpreter===declared.interpreter);
    const interpreter=getInterpreter(declared.interpreter);
    if(allowed && interpreter && !interpreter.validateTable(declared.table).length) runtimeChecks.set(`@runtime.${index}`,declared);
  }
  const unruledChecks=(submission?.checks ?? []).map((check,index)=>({check,index})).filter(({check})=>workflow.requirements.some(t=>t.key===check.requirement && t.run_table) && !workflow.ledger?.shapes.some(row=>row.requirement===check.requirement && row.interpreter===check.interpreter));
  const templates = workflow.requirements.map(t=>({...t,checks:[...t.checks,...[...runtimeChecks].filter(([,check])=>check.requirement===t.key).map(([id])=>id)]}));
  const itemTemplates = templates.filter((t) => t.target === 'item');
  const runTemplates = templates.filter((t) => t.target === 'run');
  const checks = new Map(workflow.checks.map((c) => [c.id, c]));
  for(const [id,declared] of runtimeChecks){
    const check:CheckEntry={id,interpreter:declared.interpreter,applies:'item',judges:'subject'};
    if(declared.interpreter==='catalog@1'){
      const requirement=workflow.requirements.find(t=>t.key===declared.requirement)!;
      const catalogs=[...new Set(workflow.checks.filter(base=>requirement.checks.includes(base.id)).flatMap(base=>base.catalog?[base.catalog]:[]))];
      if(catalogs.length===1)check.catalog=catalogs[0];
      else runtimeCatalogGaps.set(id,{missing:`要求项 ${requirement.key} 的唯一目录绑定（当前 ${catalogs.length} 个）`,next_action:'请运行者联系包作者，在新版本中为该要求项明确唯一目录绑定，发布后重开运行'});
    }
    checks.set(id,check);
  }
  if(input.admission!==undefined)checks.set(ADMISSION_CHECK,{id:ADMISSION_CHECK,title:'Hub 回注来源核验',applies:'item',judges:'artifact_under_verification',tier:'blocking',basis:'K03 R[4]-R[6]：回注根据与入层约束'});
  // Whole-refusal diagnostics must never check unresolved items, including fact checks and run-level subjects.
  // An accepted submission supplies no exclusions, so skipped and uncovered items keep their normal semantics.
  const items = run.items.filter(it => !exclude.has(it.id));
  const itemIds = new Set(items.map((it) => it.id));
  const criterionBound=(run.accepted_criteria??[]).flatMap(change=>[rootDigest(change.declaration),rootDigest(change.review)]).filter((digest):digest is string=>digest!==null);
  const skills=ctx.parsers.skills??run.skills;
  const baseBound = [run.pack_digest,...(ctx.parsers.bindingRecords??(ctx.parsers.bindingRecord?[ctx.parsers.bindingRecord]:[])), ...(skills??[]).map(skill=>skill.digest),...(run.root !== undefined ? [run.root] : []),...criterionBound];
  const itemDigests = items.map((it) => it.digest).filter((d): d is string => d !== undefined);
  const entries = new Map<string, { index: number; entry: Submission['items'][number] }>();
  submission?.items.forEach((entry, index) => entries.set(entry.item, { index, entry }));
  const itemSlotKeys = new Set(Object.keys(workflow.slots.item));
  const hasItemJudgments = itemTemplates.some((t) => isJudgment(t) && itemSlotKeys.has(t.key));
  const artifactRequirements = new Set(itemTemplates.filter(t => t.checks.some(id => checks.get(id)?.judges === 'artifact_under_verification')).map(t => t.key));
  const sets = closedSets(workflow);
  const criteria=await frozenCriteria(ctx,run.accepted_criteria??[]);
  const context = {...runContextOf(run),...(skills?{skills:[...skills]}:{}),...(criteria.length?{accepted_criteria:criteria}:{})};

  const handlingOf = (id: string): Handling => {
    if (input.carried.has(id)) return 'handled';
    const found = entries.get(id);
    if (found === undefined) return 'not_covered';
    return found.entry.handling === 'handled' ? 'handled' : 'skipped';
  };
  /** The slot record as submitted (for the claims) and with its resolved references in canonical form (for the checks). */
  const slotsOf = (id: string): Slots => {
    const carried = input.carried.get(id);
    if (carried) return carried.slots;
    const found = entries.get(id)?.entry;
    return found?.handling === 'handled' && found.slots !== undefined ? found.slots : null;
  };
  const checkedSlotsOf = (id: string): Slots => {
    const carried = input.carried.get(id);
    if (carried) return carried.evidence.slots ?? carried.slots;
    return input.exact?.items.get(id)?.slots ?? slotsOf(id);
  };
  const evidenceOf = (id: string): ItemEvidence => input.carried.get(id)?.evidence ?? input.exact?.items.get(id) ?? emptyEvidence();
  const subjectItem = (it: ItemProjection): SubjectItem => ({ id: it.id, label: it.label, location: it.location, fields: it.fields });

  // ---- the catalogs the checks consult, by catalog id
  const views = new Map<string, CatalogView | null>();
  for (const check of workflow.checks) {
    if (check.catalog === undefined || check.catalog_select || views.has(check.catalog)) continue;
    views.set(check.catalog, run.root !== undefined ? await ctx.deps.knowledge.catalog(run.root, check.catalog) : null);
  }
  const selectedViews=new Map<string,Promise<CatalogView|null>>();
  const selectionMissing=new Map<string,string>();
  const selectionKey=(check:CheckEntry,item:string)=>JSON.stringify([item,check.catalog,check.catalog_select]);
  const requirementsOf = new Map<string, RequirementTemplate[]>();
  for (const t of templates) for (const id of t.checks) requirementsOf.set(id, [...(requirementsOf.get(id) ?? []), t]);

  const onError = (error: unknown, check: string): void => ctx.log({ traceId: input.traceId, run: run.run, what: `check ${check}`, detail: describe(error) });

  let resolveCtx: ResolveContext;
  if (run.runner !== undefined) {
    const user = ctx.deps.records.principals !== undefined ? await ctx.deps.records.principals.get(run.runner) : null;
    const role: PermissionRole = user?.role ?? 'user';
    const runnerPrincipal: Principal = { id: run.runner, name: user?.name ?? run.runner, role };
    resolveCtx = {
      reader: identityOf(runnerPrincipal, run.run),
      parsers: ctx.parsers,
      sources: sourceReader(ctx.deps.records.artifacts, 'function',run.sources),
      trees: ctx.deps.knowledge.treeReader({ compositions: run.target_basis.flatMap(c => {const d=c.statement.data;return d && [run.root,run.unversioned_root].includes(d.root as string) && typeof d.composition === 'string' ? [d.composition] : [];}) }),
      records: recordReader(ctx.deps.records.store, ctx.deps.knowledge.layers?.contributions),
      consumer: 'function',
      documents: ctx.documents,
      onDiagnostic: diagnostic => ctx.log({traceId:input.traceId,run:run.run,what:'check source',detail:`${diagnostic.reference}: ${diagnostic.message}`}),
    };
  } else {
    // Standing obligations read as their configuring admin through the same effective-tier gate as ordinary runs.
    const configurer = run.configurer ?? 'hub';
    const user = ctx.deps.records.principals !== undefined ? await ctx.deps.records.principals.get(configurer) : null;
    resolveCtx = {
      reader: { user: configurer, role: user?.role ?? 'user', run: run.run },
      parsers: ctx.parsers,
      sources: sourceReader(ctx.deps.records.artifacts, 'function',run.sources),
      trees: ctx.deps.knowledge.treeReader({ compositions: run.target_basis.flatMap(c => {const d=c.statement.data;return d && [run.root,run.unversioned_root].includes(d.root as string) && typeof d.composition === 'string' ? [d.composition] : [];}) }),
      records: recordReader(ctx.deps.records.store, ctx.deps.knowledge.layers?.contributions),
      consumer: 'function',
      documents: ctx.documents,
      onDiagnostic: diagnostic => ctx.log({traceId:input.traceId,run:run.run,what:'check source',detail:`${diagnostic.reference}: ${diagnostic.message}`}),
    };
  }

  if(ctx.deps.knowledge.feeding&&resolveCtx.sources){const original=resolveCtx.sources;const observed=new Map<string,Promise<unknown>>();resolveCtx.sources={async read(sha,reader){const value=await original.read(sha,reader);if(value?.bytes&&value.readTier==='model_readable'){const captures=run.sources.filter(binding=>{const ref=parseReference(binding.reference);return ref.scheme==='src'&&ref.sha256===sha&&binding.artifact;});for(const capture of captures.length?captures:[undefined]){const meta=capture?.meta_artifact?await ctx.deps.records.store.get<any>(capture.meta_artifact):null;const key=sha+'\0'+(capture?.artifact??'');let observation=observed.get(key);if(!observation){observation=ctx.deps.knowledge.feeding!.observeSourceBounded(principalOf(reader),sha,{sourceRecord:capture?.artifact,readManifest:capture?.read_manifest,metaRecord:capture?.meta_artifact,metaSource:meta?.kind==='source_artifact'?meta.body.sha256:undefined,composition:run.target_basis.find(claim=>claim.statement.data?.root===run.root&&typeof claim.statement.data?.composition==='string')?.statement.data?.composition as string|undefined,product:run.product,root:run.root,run:run.run,line:run.version});observed.set(key,observation);}await observation;}}return value;}};}
  const readBudget=new CheckReadBudget();
  const readReference=(reference:string,ref:Parameters<typeof resolveReference>[0])=>readBudget.read(reference,()=>resolveReference(ref,resolveCtx));
  const boundSourceCache = new Map<string, Promise<{ resolved: boolean; text: string | null; byteLength?: number; reason?: ReadFailureReason }>>();

  const resolveBoundSource = (reference: string) => {
    let pending = boundSourceCache.get(reference);
    if (!pending) {
      pending = (async () => {
        try {
          const parsed = parseReference(reference);
          const result = await retryRead(() => readReference(reference,parsed), result => result.resolved ? null
            : { reason: result.reason ?? (result.code === 'REFERENCE_UNRESOLVED' ? 'REFERENCE_UNRESOLVED' : 'SOURCE_UNAVAILABLE'), retry: result.reason !== undefined || result.code === 'SOURCE_UNAVAILABLE' }, attempt => {
              if (attempt.retry || attempt.attempt > 1) retryAttempts.push(attemptEvidence('read', ENGINE_COMPONENT, attempt, {reference}));
            });
          if (!result.resolved) {
            return { resolved: false, text: null, reason: result.reason ?? (result.code === 'REFERENCE_UNRESOLVED' ? 'REFERENCE_UNRESOLVED' : 'SOURCE_UNAVAILABLE') };
          }
          if (result.text === null) {
            return { resolved: true, text: null, reason: result.readTier === 'retain_only' ? 'credential_unreadable' as const : 'missing_input' as const };
          }
          const byteLength = Buffer.byteLength(result.text, 'utf8');
          return { resolved: true, text: result.text, byteLength };
        } catch (error) {
          if(error instanceof HubReadFailure)throw error;
          onError(error, 'bound source');
          return { resolved: false, text: null, reason: 'check_error' as const };
        }
      })();
      boundSourceCache.set(reference, pending);
    }
    return pending;
  };

  const externalTypeOf = (external: string): string | null => {
    const match = /^([a-z][a-z0-9-]*:[a-z][a-z0-9_-]*):/.exec(external);
    return match ? match[1] : null;
  };

  const sourcesForReads=(check:CheckEntry)=>{
    if(check.reads===undefined)return [];
    const roles = new Set(check.reads.roles);
    const types = check.reads.types !== undefined ? new Set(check.reads.types) : undefined;
    return (run.sources ?? []).filter((s) => {
      if (!roles.has(s.role)) return false;
      if (types !== undefined) {
        if (s.external === undefined) return false;
        const extType = externalTypeOf(s.external);
        if (extType === null || !types.has(extType)) return false;
      }
      return true;
    });
  };

  const readBoundSources = async (check: CheckEntry): Promise<{ boundSources: Record<string, string>; unreadSources: UnreadSource[] }> => {
    if (check.reads === undefined || check.reads.narrow !== undefined) {
      return { boundSources: {}, unreadSources: [] };
    }
    const maxBytes = check.reads.max_bytes ?? MAX_CHECK_READ_BYTES;
    const matchingSources=sourcesForReads(check);
    const boundSources: Record<string, string> = {};
    const unreadSources: UnreadSource[] = [];
    for (const s of matchingSources) {
      const result = await resolveBoundSource(s.reference);
      const extra = {
        ...(s.external !== undefined ? { external: s.external } : {}),
        ...(s.slot !== undefined ? { slot: s.slot } : {}),
        ...(result.reason === 'credential_unreadable' ? { missing_fact: '管理员尚未接受此来源', next_action: '请求管理员接受来源，接受后重新核验' } : {}),
      };
      if (!result.resolved) {
        unreadSources.push({ reference: s.reference, reason: result.reason ?? 'SOURCE_UNAVAILABLE', ...extra });
      } else if (result.text === null) {
        unreadSources.push({ reference: s.reference, reason: result.reason ?? 'missing_input', ...extra });
      } else if (result.byteLength !== undefined && result.byteLength > maxBytes) {
        unreadSources.push({
          reference: s.reference,
          reason: 'budget_exhausted',
          ...extra,
        });
      } else {
        boundSources[s.reference] = result.text;
      }
    }
    return { boundSources, unreadSources };
  };

  // The graded source view of one evaluation: the texts the boundary already resolved, then — for a reference that
  // appears only inside slot data — the boundary's own parser over any source bound to this run. One parse per
  // reference per evaluation (quotedReferences warms them before the checks run, once); the declared reads' size cap
  // applies to a whole-source fallback, like readBoundSources.
  let fragmentScope: ReturnType<typeof buildScope> | undefined;
  type GradedFragment = {text?: string; why: FragmentRead; unread?: FragmentReadFailure; rule?: string};
  const fragmentCache = new Map<string, Promise<GradedFragment>>();
  const gradeFragment = (reference: string, capBytes: number = MAX_CHECK_READ_BYTES): Promise<GradedFragment> => {
    let pending = fragmentCache.get(reference);
    if (pending === undefined) {
      pending = (async (): Promise<GradedFragment> => {
        let ref: ReturnType<typeof parseReference>;
        try {
          ref = parseReference(reference);
        } catch {
          return { why: 'malformed' };
        }
        const finish = async (r: Awaited<ReturnType<typeof resolveReference>>): Promise<GradedFragment> => {
          if (!r.resolved) {
            // By the resolver's own code: REFERENCE_UNRESOLVED means the reference resolves to nothing inside the
            // bound thing (no such fragment — the model can fix the selector or the quote); SOURCE_UNAVAILABLE means
            // the read genuinely failed. Scope and groundability have their own grades and remedies.
            if (r.reason === 'integrity_unproven') return { why: 'integrity_unproven' };
            return { why: r.code === 'REFERENCE_UNRESOLVED' ? 'no_fragment' : 'unavailable' };
          }
          if (!r.groundable) return { why: 'not_groundable' };
          const named = await declarationGroundRefusal(ref, digest => ctx.deps.records.store.get(digest));
          if (named) return { why: 'not_groundable', rule: named };
          if (r.readTier === 'retain_only') return { why: 'retain_only', unread: {reason:'credential_unreadable', missing_fact:'管理员尚未接受此来源', next_action:'请求管理员接受来源，接受后重新核验'} };
          if (r.text === null) return { why: 'no_fragment' };
          if (Buffer.byteLength(r.text, 'utf8') > capBytes) return { why: 'too_large' };
          return { text: r.text, why: 'bound' };
        };
        // Share the boundary's scope, including predecessor results and the ban on standalone entries.
        const scope = await (fragmentScope ??= buildScope(ctx, run, workflow, principalOf(resolveCtx.reader), 'function', retryAttempts));
        if (ref.scheme === 'entry') return { why: 'entry_unaddressed' };
        if (scopeProblem(ref, scope) !== null) return { why: 'not_bound' };
        let result: Awaited<ReturnType<typeof resolveReference>>;
        try {
          result = await retryRead(() => readReference(reference,ref), value => !value.resolved
            && value.reason !== undefined ? {reason:value.reason,retry:true} : null,
            attempt => { if(attempt.retry || attempt.attempt > 1) retryAttempts.push(attemptEvidence('read',ENGINE_COMPONENT,attempt,{reference})); });
        } catch(error) {
          if(error instanceof HubReadFailure)throw error;
          onError(error,'graded fragment');
          throw new HubReadFailure(reference,'check_error',retryAttempts);
        }
        if(!result.resolved && result.reason !== undefined)
          throw new HubReadFailure(reference,result.reason,retryAttempts);
        return finish(result);
      })();
      fragmentCache.set(reference, pending);
    }
    return pending;
  };
  const quotedReferences = new Set<string>();
  /** Every reference-like string in the slot records (an interpreter's table may point at any of them). */
  const collectQuotedReferences = (value: unknown): void => {
    if (typeof value === 'string' && value.length <= MAX_REFERENCE_LENGTH && /^(?:src|tree|entry|rec):/.test(value)) {
      readBudget.reserve(value);
      quotedReferences.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collectQuotedReferences(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) collectQuotedReferences(item);
    }
  };
  const warmed = new Map<string, string>();
  const warmedWhy = new Map<string, FragmentRead>();
  const warmedUnread = new Map<string, FragmentReadFailure>();
  const warmedRule = new Map<string, string>();
  const gradedSourceView = (texts: ReadonlyMap<string, string>): SourceView => ({
    text: (reference) => texts.get(reference) ?? warmed.get(reference),
    unread: reference => warmedUnread.get(reference),
    rule: reference => warmedRule.get(reference),
    // A reference never warmed (not collected, or the warm pass failed) reads as unavailable: an honest
    // unknown, never a refutation.
    why: (reference) => (texts.has(reference) || warmed.has(reference) ? 'bound' : warmedWhy.get(reference) ?? 'unavailable'),
  });
  /** Warm every quoted reference of an item's slot record before its checks run (once per reference per evaluation). */
  const warmQuoted = async (value: unknown, capBytes: number, texts: ReadonlyMap<string, string>): Promise<void> => {
    collectQuotedReferences(value);
    await mapLimited([...quotedReferences],4,async (reference) => {
      if (texts.has(reference) || warmed.has(reference) || warmedWhy.has(reference)) return;
      const graded = await gradeFragment(reference, capBytes);
      if (graded.text !== undefined) warmed.set(reference, graded.text);
      else {
        warmedWhy.set(reference, graded.why);
        if(graded.unread) warmedUnread.set(reference,graded.unread);
        if(graded.rule) warmedRule.set(reference, graded.rule);
      }
    });
  };

  const callCheck = async (check: CheckEntry, subject: unknown, texts: ReadonlyMap<string, string>, item?: string): Promise<CheckOutcome[]> => {
    const gap=runtimeCatalogGaps.get(check.id);
    if(gap)return [{verdict:'unknown',reason:'missing_input',statement:gap.missing,missing:gap.missing,grounds:[],tier:'advisory',data:{fix:gap.next_action}}];
    let table: unknown = runtimeChecks.get(check.id)?.table;
    if (check.table !== undefined) {
      try {
        table = workflow.readJson(check.table);
      } catch (error) {
        onError(error, check.id);
        return [tableFailure(check)];
      }
    }
    const view = check.catalog_select&&item ? (await selectedViews.get(selectionKey(check,item))??undefined) : check.catalog !== undefined ? (views.get(check.catalog) ?? undefined) : undefined;
    const { boundSources, unreadSources } = await readBoundSources(check);
    let readReceipt: string | undefined;
    if (check.reads?.narrow !== undefined) {
      const declaration = check.reads.narrow;
      const sources = run.sources.filter(source => source.slot === declaration.slot && check.reads!.roles.includes(source.role) && source.external?.startsWith('knowledge:index:') && (check.reads!.types === undefined || check.reads!.types.includes('knowledge:index')));
      const startedAt = ctx.now().toISOString();
      let narrowed: NarrowReadResult;
      if (sources.length !== 1) {
        narrowed = { subject: null, keys: [], unread: [{ reference: sources[0]?.reference ?? `rec:${input.submissionDigest}`, slot: declaration.slot, reason: 'missing_input', missing_fact: `输入 ${declaration.slot} 缺少唯一已绑定索引`, next_action: '绑定该槽位的唯一索引视图后重新核验' }] };
      } else {
        const source = sources[0];
        const bound = await resolveBoundSource(source.reference);
        narrowed = await narrowSubjectRead(declaration, subject, check.reads.max_bytes ?? MAX_CHECK_READ_BYTES, {
          binding: source, boundText: bound.text,
          read: async external => {
            const principal = principalOf(resolveCtx.reader);
            const read = await ctx.deps.external.read(external, { principal, run: run.run, purpose: `检查 ${check.id} 条目 ${item ?? ''} 收窄读取`,feeding_offset:run.feeding_offset, ...(run.build ? { build: run.build } : {}) });
            if (!read.ok) { onError(new Error(read.reason), check.id); throw new Error('narrow read unavailable'); }
            const chosen = read.artifacts.find(a => a.name === 'content') ?? read.artifacts.find(a => a.name === 'original');
            if (!chosen) throw new Error('narrow read has no content');
            await ctx.deps.knowledge.feeding?.observeSourceBounded(principal,chosen.artifact.body.sha256,{composition:run.target_basis.find(claim=>claim.statement.data?.root===run.root&&typeof claim.statement.data?.composition==='string')?.statement.data?.composition as string|undefined,product:run.product,root:run.root,run:run.run,line:run.version,sourceRecord:chosen.artifact.digest,metaSource:read.artifacts.find(a=>a.name==='meta')?.artifact.body.sha256,metaRecord:read.artifacts.find(a=>a.name==='meta')?.artifact.digest,readManifest:read.manifest});
            const content = await ctx.deps.records.artifacts.source(principal, chosen.artifact.body.sha256, { consumer: 'function',record:chosen.artifact.digest });
            if (!content) throw new Error('narrow read unavailable');
            return { text: content.bytes === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(content.bytes), reference: `src:${chosen.artifact.body.sha256}`, revision: read.revision, manifest: read.manifest };
          },
        });
      }
      subject = narrowed.subject;
      unreadSources.push(...narrowed.unread);
      if (narrowed.text && narrowed.reference) boundSources[narrowed.reference] = narrowed.text;
      const receipt = await putAction(ctx.deps.records.store, {
        action: 'read', run: run.run, inputs: [...sources.map(source => source.reference), ...(narrowed.reference ? [narrowed.reference] : []), ...(narrowed.manifest && /^[a-f0-9]{64}$/.test(narrowed.manifest) ? [`rec:${narrowed.manifest}`] : [])], startedAt, endedAt: ctx.now().toISOString(),
        result: narrowed.unread.length ? 'unknown' : 'completed', acceptance: null, codes: [],
        detail: { check: check.id, item: item ?? null, slot: declaration.slot, key_path: declaration.key_path, keys: narrowed.keys,
          max_keys: declaration.max_keys, max_entries: declaration.max_entries, max_bytes: check.reads.max_bytes ?? MAX_CHECK_READ_BYTES,
          external: narrowed.external ?? null, source: narrowed.reference ?? null, provider_manifest: narrowed.manifest ?? null, unread_sources: narrowed.unread },
      });
      readReceipt = `rec:${receipt.digest}`;
      // Without any readable narrowed bytes the function cannot establish a refutation either.
      if (narrowed.text === undefined) return [bounded(check, {
        verdict: 'unknown', reason: 'missing_input', missing: narrowed.unread.map(row => `${row.missing_fact}；下一步：${row.next_action}`).join('；'), grounds: [], tier: check.tier ?? 'blocking',
        statement: narrowed.unread.map(row => `${row.missing_fact}；下一步：${row.next_action}`).join('；'),
        data: { unread_sources: unreadSources, read_manifest: readReceipt },
      })];
    }
    await warmQuoted(runtimeChecks.has(check.id)?[subject,table]:subject, check.reads?.max_bytes ?? MAX_CHECK_READ_BYTES, texts);
    const record = { ...Object.fromEntries(texts), ...boundSources, ...Object.fromEntries(warmed) };
    const outcomes = await runCheck(
      {
        id: check.id,
        ...(check.interpreter !== undefined ? { interpreter: check.interpreter } : {}),
        ...(check.function !== undefined ? { function: check.function } : {}),
        ...(check.tier !== undefined ? { tier: check.tier } : {}),
        ...(check.basis !== undefined ? { basis: check.basis } : {}),
        catalogEntries: check.function !== undefined && check.catalog !== undefined,
        ...(check.reads !== undefined ? { reads: check.reads } : {}),
        ...(ctx.deps.sandboxLimits !== undefined ? { limits: ctx.deps.sandboxLimits } : {}),
      },
      {
        table,
        subject,
        ...(view !== undefined ? { catalog: view } : {}),
        context: { run: run.run, requirement: requirementsOf.get(check.id)?.[0]?.key, pack: workflow.pack.id, sets },
        packDir: workflow.pack.directory,
        sourceTexts: record,
        sources: gradedSourceView(texts),
        unreadSources,
        sandbox: sandboxFor('check', check.function?.module, item),
        ...(item !== undefined && check.function !== undefined ? { functionRunner: functionBatches.runner(check.id, item) } : {}),
        onError,
      },
    );
    return outcomes.map((o) => {
      if(o.judgment_sources?.length){
        const declaration=item?entries.get(item)?.entry:undefined;
        const slots=declaration?.handling==='handled'?declaration.slots:null;
        if(!submission||!item||o.judgment_sources.some(pointer=>{const value=valueAt(slots,pointer);return !isObject(value)||typeof value.text!=='string'||!value.text;}))return bounded(check,{verdict:'unknown',reason:'missing_input',missing:'缺少本条目原始提交中的模型主张节点及声明模型；下一步：包作者修正 judgment_sources 的槽位指针，运行者完整重交',statement:'无法把判断依据绑定到本条目的原始模型提交；先补原始节点再核验',grounds:[],tier:check.tier??'blocking'});
      }
      const outcome = check.reads?.narrow && unreadSources.length && o.verdict === 'support'
        ? { ...o, verdict: 'unknown' as const, reason: 'missing_input' as const, missing: unreadSources.map(row => `${row.missing_fact}；下一步：${row.next_action}`).join('；'), statement: `读取不完整：${unreadSources.map(row => `${row.missing_fact}；下一步：${row.next_action}`).join('；')}` }
        : o;
      return bounded(check, { ...outcome, ...((unreadSources.length || readReceipt) ? { data: { ...outcome.data, ...(unreadSources.length ? { unread_sources: unreadSources } : {}), ...(readReceipt ? { read_manifest: readReceipt } : {}) } } : {}) });
    });
  };
  const prepared = new Map<string, SandboxBatchItem>();
  let subjectCancelled = false; let subjectCancellation: unknown;
  const functionBatches = createFunctionBatches((check, target, count) => sandboxFor('check_batch', target.module, undefined, { check, items: count, export: target.export ?? 'default' }), error => { subjectCancelled = true; subjectCancellation = error; });
  const subjectBuilder = () => createSubjectBuilder(async (target, subjectInput) => {
    if (subjectCancelled) throw subjectCancellation;
    const key = subjectKey(target, JSON.stringify(subjectInput));
    const cached = prepared.get(key);
    if (cached) {
      if (cached.ok || !(cached.error.code === 'SANDBOX_UNAVAILABLE' && cached.error.detail.reason === 'stopping')) prepared.delete(key);
      if (cached.ok) return cached.result.output;
      throw cached.error;
    }
    return (await callPackFunction(target, subjectInput, ctx.deps.sandboxLimits, sandboxFor('subject', target.module,
      isObject(subjectInput) && isObject(subjectInput.item) && typeof subjectInput.item.id === 'string' ? subjectInput.item.id : undefined))).output;
  });
  const buildSubject = async (subjectFor: ReturnType<typeof createSubjectBuilder>, check: CheckEntry, builderInput: unknown, fallback: () => unknown): Promise<{ subject: unknown } | { failure: CheckOutcome }> => {
    if (check.subject === undefined) return { subject: fallback() };
    try {
      const subject = await subjectFor({ packDir: workflow.pack.directory, module: check.subject.module, export: check.subject.export }, builderInput);
      const blocked = SubjectBlocked.safeParse(subject);
      if (blocked.success) {
        const rows = blocked.data.blocked;
        return { failure: { verdict: 'unknown', reason: 'awaiting_step', missing: `前置 ${rows.map(row => `${row.check}${row.pointer}（${row.code}）`).join('；')} 修正后的事实；下一步：修正这些驳回后自动重核`, code: rows[0].code, pointer: rows[0].pointer, statement: `前置驳回：${rows.map(row => `${row.check}${row.pointer}（${row.code}）`).join('；')}。下一步：修正这些驳回后自动重核`, grounds: [], tier: check.tier ?? 'blocking', data: { blocked: rows } } };
      }
      return { subject };
    } catch (error) {
      onError(error, `${check.id} subject`);
      return { failure: builderFailure(check, error) };
    }
  };

  // ---- run every check
  const used = [...checks.values()].filter((c) => requirementsOf.has(c.id) && (input.replayChecks===undefined||input.replayChecks.has(c.id)));
  const runOutcomes = new Map<string, { own: Map<string, CheckOutcome[]>; loose: CheckOutcome[] }>();
  const itemOutcomes = new Map<string, Map<string, CheckOutcome[]>>();
  const judgmentOnly = (check: CheckEntry): boolean => (requirementsOf.get(check.id) ?? []).every(isJudgment);
  const missingItemArtifact = (id: string): boolean => submission !== null && handlingOf(id) !== 'handled';
  const artifactCheck = (check: CheckEntry): boolean => check.judges === 'artifact_under_verification';
  const deniedArtifact=(check:CheckEntry,id:string):boolean=>input.admission?.outcomes.has(id)===true&&artifactCheck(check)&&(requirementsOf.get(check.id)??[]).every(t=>t.key===input.admission!.requirement);
  const allTexts = new Map<string, string>();
  for (const it of items) for (const [k, v] of evidenceOf(it.id).texts) allTexts.set(k, v);

  const runSubjects = subjectBuilder();
  for (const check of used.filter((c) => c.applies === 'run' && (items.length > 0 || exclude.size === 0))) {
    // A run check of item artifacts sees only submitted artifacts. A check of a run-level artifact (for example
    // a final claim) still needs every target's metadata to test coverage, but receives no absent slot property.
    const itemArtifactsOnly = artifactCheck(check) && (requirementsOf.get(check.id) ?? []).every(t => t.target === 'item');
    const checkItems = itemArtifactsOnly ? items.filter(it => !missingItemArtifact(it.id)&&!deniedArtifact(check,it.id)) : items;
    if (itemArtifactsOnly && checkItems.length === 0) continue;
    const checkedIds = new Set(checkItems.map(it => it.id));
    const built = await buildSubject(runSubjects, check, { applies: 'run', items: checkItems.map(subjectItem), context }, () => ({
      items: checkItems.map(it => ({ ...subjectItem(it), ...(artifactCheck(check) && missingItemArtifact(it.id) ? {} : { slots: checkedSlotsOf(it.id) }) })),
      cross_item: input.exact?.crossEntries ?? submission?.cross_item ?? [],
    }));
    const texts = itemArtifactsOnly ? new Map(checkItems.flatMap(it => [...evidenceOf(it.id).texts])) : allTexts;
    const outcomes = 'failure' in built ? [built.failure] : await callCheck(check, built.subject, texts);
    const own = new Map<string, CheckOutcome[]>();
    const loose: CheckOutcome[] = [];
    for (const o of outcomes) {
      if (o.item !== undefined && (exclude.has(o.item) || (itemArtifactsOnly && itemIds.has(o.item) && !checkedIds.has(o.item)))) continue;
      if (o.item !== undefined && itemIds.has(o.item)) own.set(o.item, [...(own.get(o.item) ?? []), o]);
      else loose.push(o);
    }
    // A check that could not judge an item (an unknown without item) leaves that item unknown, never silently passed.
    const failing = loose.filter((o) => o.verdict === 'unknown');
    if (failing.length > 0) for (const it of checkItems) if (!own.has(it.id)) own.set(it.id, failing);
    runOutcomes.set(check.id, { own, loose });
  }
  const perItem = used.filter((c) => c.applies === 'item');
  const eligible = (check: CheckEntry, id: string): boolean => !deniedArtifact(check,id) && !(artifactCheck(check) && missingItemArtifact(id))
    && !(judgmentOnly(check) && (handlingOf(id) !== 'handled' || exclude.has(id) || submission === null));
  const builderInput = async (it: ItemProjection, check: CheckEntry) => {
    const slots = exclude.has(it.id) ? null : checkedSlotsOf(it.id); const ev = evidenceOf(it.id);
    const raw={applies:'item',item:subjectItem(it),slots,evidence:slots===null?[]:ev.evidence,context};
    let view=check.catalog?views.get(check.catalog):null;
    if(check.catalog_select&&check.catalog){
      const key=selectionKey(check,it.id);
      let pending=selectedViews.get(key);
      if(!pending){pending=(async()=>{
        const selection=(await callPackFunction({packDir:workflow.pack.directory,...check.catalog_select!},raw,ctx.deps.sandboxLimits,sandboxFor('catalog_select',check.catalog_select!.module,it.id))).output;
        if(!isObject(selection)||typeof selection.base!=='string'||!Array.isArray(selection.lines)||selection.lines.length>128||selection.lines.some(line=>typeof line!=='string'||Buffer.byteLength(line)>8192))throw new RangeError('目录选择必须声明路径和至多 128 条完整命令，每条至多 8192 字节；拆分计划后重核');
        return run.root?ctx.deps.knowledge.catalog(run.root,check.catalog!,selection as {base:string;lines:string[]}):null;
      })().catch(error=>{onError(error,'catalog selection');selectionMissing.set(key,error instanceof RangeError?error.message:'缺锁定目录的所选路径；管理员修复目录读取后原样重交，不用整棵目录代替');return null;});selectedViews.set(key,pending);}
      view=await pending;
    }
    return {...raw,...(check.catalog?{catalog:view?.entries()??[],catalog_complete:view?.complete??false,...(selectionMissing.has(selectionKey(check,it.id))?{catalog_missing:selectionMissing.get(selectionKey(check,it.id))}:{})}:{})};
  };
  const runtimeAdmission: RuntimeAdmission[] = [];
  const admittedChecks = new Map<string,RuntimeAdmission>();
  for (const [index,declared] of (submission?.checks ?? []).entries()) {
    const requirement = templates.find(t=>t.key===declared.requirement);
    const interpreter = getInterpreter(declared.interpreter);
    if (!requirement?.run_table || !workflow.ledger?.shapes.some(row=>row.requirement===declared.requirement && row.interpreter===declared.interpreter) || !interpreter || interpreter.validateTable(declared.table).length) continue;
    const record: RuntimeAdmission = {admitted:false,provenance:'declared',requirement:declared.requirement,interpreter:declared.interpreter,table_sha256:receivedDigest(declared.table).digest,samples:[]};
    for (const sample of declared.samples) {
      const item = items.find(it=>it.id===sample.item);
      if (!item) continue; // The submission boundary refuses nonexistent sample items.
      const itemInput=await builderInput(item, checks.get(`@runtime.${index}`)!);
      const subject={item:item.id,label:item.label,location:item.location,fields:item.fields,slots:itemInput.slots,evidence:itemInput.evidence};
      const texts=evidenceOf(item.id).texts;
      await warmQuoted([subject,declared.table],MAX_CHECK_READ_BYTES,texts);
      const outcome=await callCheck(checks.get(`@runtime.${index}`)!,subject,texts,item.id);
      const ref=parseReference(item.location);
      const artifact=ref.scheme==='src' ? await ctx.deps.records.artifacts.readable(principalOf(resolveCtx.reader),ref.sha256) : null;
      const proof=artifact===null ? null : {reference:item.location,record:artifact.digest,provenance:artifact.provenance,origin:artifact.body.origin,author:artifact.body.author,outside_author:'read' in artifact.body.origin || 'upload' in artifact.body.origin && artifact.body.author.user!==null && artifact.body.author.user!==(run.runner??run.configurer)};
      const passed=sample.expect.length===outcome.length && sample.expect.every((expected,i)=>Object.entries(expected).every(([key,value])=>outcome[i][key as keyof CheckOutcome]===value));
      record.samples.push({item:item.id,expect:sample.expect,source_provenance:proof,outcome,passed,...(proof===null?{missing:`条目 ${item.id} 所在源文件的读取或上传来源记录`,next_action:'由运行者重新读取或上传该源文件，绑定新来源后重验'}:{})});
    }
    record.admitted=record.samples.length===declared.samples.length && record.samples.length>0 && record.samples.every(sample=>sample.passed && sample.outcome.every(o=>o.verdict==='support'||o.verdict==='refute'))
      && record.samples.some(sample=>sample.expect.every(e=>e.verdict==='support'))
      && record.samples.some(sample=>sample.expect.some(e=>e.verdict==='refute'))
      && record.samples.some(sample=>sample.source_provenance?.outside_author);
    if(!record.admitted){record.missing=`要求项 ${record.requirement} 的通过正反对照和至少一份作者之外样例的准入证据`;record.next_action='重读外部来源或由其他账号提供样例，补齐正反对照后重交；本次结论以判断为前提';}
    const bindingGap=runtimeCatalogGaps.get(`@runtime.${index}`);
    if(bindingGap){record.missing=bindingGap.missing;record.next_action=bindingGap.next_action;}
    runtimeAdmission.push(record);
    admittedChecks.set(`@runtime.${index}`,record);
  }
  const runtimeFactOf = (check: CheckEntry) => {
    const admission=admittedChecks.get(check.id);
    if(!admission)return {};
    const index=Number(check.id.slice('@runtime.'.length));
    return {runtime:{admitted:admission.admitted,admission:`rec:${input.submissionRecord??input.submissionDigest}#/checks/${index}/samples`,run:receivedDigest(run).digest,table:admission.table_sha256,submission:input.submissionDigest}};
  };
  const claimRuleOf = (check:CheckEntry):string => {
    const admission=admittedChecks.get(check.id);
    return admission ? `运行内检查@${admission.table_sha256}` : ruleOf(workflow,check);
  };
  const builders = new Map<string, { target: PackFunctionTarget; entries: Map<string, unknown> }>();
  for (const check of perItem) {
    const ids = items.filter(it => eligible(check, it.id)).map(it => it.id);
    if (check.function) functionBatches.define(check.id, ids);
    if (!check.subject) continue;
    const target = { packDir: workflow.pack.directory, module: check.subject.module, export: check.subject.export };
    const identity = JSON.stringify([target.module, target.export ?? 'default']);
    const group = builders.get(identity) ?? { target, entries: new Map<string, unknown>() }; builders.set(identity, group);
    for (const it of items) if (eligible(check, it.id)) {
      const value = await builderInput(it, check); group.entries.set(subjectKey(target, JSON.stringify(value)), value);
    }
  }
  for (const group of builders.values()) {
    if (group.entries.size < 2) continue;
    try {
      const values = [...group.entries.values()];
      const result = await callPackFunctionBatch(group.target, values, ctx.deps.sandboxLimits,
        sandboxFor('subject_batch', group.target.module, undefined, { items: values.length, export: group.target.export ?? 'default' }));
      const keys = [...group.entries.keys()]; for (const [index, value] of result.entries()) prepared.set(keys[index], value);
    } catch (error) {
      if (error instanceof SandboxError && error.code === 'SANDBOX_UNAVAILABLE' && error.detail.reason === 'stopping') {
        functionBatches.cancel(error); break;
      } else onError(error, `${group.target.module} subject batch; using individual calls`);
    }
  }
  try {
    await Promise.all(items.map(async it => {
      const itemSubjects = subjectBuilder(); const ev = evidenceOf(it.id);
      for (const check of perItem) {
        if (!eligible(check, it.id)) continue;
        try {
          const itemInput = await builderInput(it, check);
          const built = await buildSubject(itemSubjects, check, itemInput, () => ({
            item: it.id, label: it.label, location: it.location, fields: it.fields,
            slots: itemInput.slots, evidence: itemInput.evidence,
          }));
          const outcomes = 'failure' in built ? [built.failure] : await callCheck(check, built.subject, ev.texts, it.id);
          let byItem = itemOutcomes.get(check.id);
          if (!byItem) itemOutcomes.set(check.id, (byItem = new Map()));
          byItem.set(it.id, outcomes);
        } finally { functionBatches.finish(check.id, it.id); }
      }
    }));
  } catch (error) { functionBatches.cancel(error); throw error; }

  if(input.replayChecks!==undefined) {
    const outcomes:Record<string,CheckOutcome[]>={};
    for(const check of used) {
      const whole=runOutcomes.get(check.id);
      outcomes[check.id]=whole?[...whole.loose,...[...whole.own.values()].flat()]:[...(itemOutcomes.get(check.id)?.entries()??[])].flatMap(([item,rows])=>rows.map(row=>({...row,item:row.item??item})));
    }
    return {outcomes,retryAttempts};
  }

  const outcomesFor = (template: RequirementTemplate, id: string): JudgedOutcome[] => [
    ...template.checks.flatMap((cid) => {
      const check = checks.get(cid);
      if (check === undefined || (artifactCheck(check) && missingItemArtifact(id))) return [];
      const list = check.applies === 'run' ? (runOutcomes.get(cid)?.own.get(id) ?? []) : (itemOutcomes.get(cid)?.get(id) ?? []);
      return list.map((outcome) => ({ outcome, check: cid, judges: check.judges }));
    }),
    ...(input.admission?.requirement===template.key ? (input.admission.outcomes.get(id)??[]).map(outcome=>({outcome,check:ADMISSION_CHECK,judges:'artifact_under_verification' as const})) : []),
  ];

  // Pointers of check outcomes into the submission, for the errors (default subjects only).
  const submissionPointer = (id: string, check: CheckEntry, pointer: string | undefined): string | undefined => {
    const found = entries.get(id);
    if (found === undefined) return undefined;
    const at = pointerOf('items', found.index);
    if (pointer === undefined || check.subject !== undefined) return at;
    if (check.applies === 'item') return pointer.startsWith('/slots/') ? `${at}${pointer}` : at;
    const m = /^\/items\/([0-9]+)(\/slots\/.*)?$/.exec(pointer);
    return m && m[2] !== undefined ? `${at}${m[2]}` : at;
  };

  // The judgments a fact over the artifact under verification rests on (V03 R[6], A02 R[3]): the statement its outcome points
  // at, else the item's slot lists (pointers into the submission), the carried record of a carried item, the cross-item entries
  // for a check over the whole run, and the bound artifacts for a production result.
  const crossPointers = (submission?.cross_item ?? []).map((_, j) => pointerOf('cross_item', j));
  const artifactSources = run.sources.filter((s) => s.role === 'artifact_under_verification').map((s) => s.reference);
  const premisesOf = (outcome: CheckOutcome, check: CheckEntry, id: string | null): string[] => {
    if (check.judges !== 'artifact_under_verification') return [];
    if (submission === null) return artifactSources;
    const own: string[] = [];
    if (id !== null) {
      const carried = input.carried.get(id);
      const found = entries.get(id);
      if (carried) own.push(carried.reuse);
      else if (found !== undefined && found.entry.handling === 'handled' && found.entry.slots !== undefined) {
        const statement = /^\/items\/[0-9]+\/slots\/[^/]+\/[0-9]+/.exec(submissionPointer(id, check, outcome.pointer) ?? '')?.[0];
        if (statement !== undefined) own.push(statement);
        else for (const key of Object.keys(workflow.slots.item)) if (Object.hasOwn(found.entry.slots, key)) own.push(pointerOf('items', found.index, 'slots', key));
      }
    }
    return check.applies === 'run' ? [...own, ...crossPointers] : own;
  };

  // ---- (item, requirement) results
  const errors: ProtocolError[] = [];
  const problems = new Set<string>();
  const uncovered = new Set<string>();
  const partitionInputs: PartitionInput[] = [];
  const required = new Set(itemTemplates.filter((t) => t.required).map((t) => t.key));
  const roundsLeftOf = (t: RequirementTemplate): number => Math.max(0, repairRounds(t) - (input.roundsUsed.get(t.key) ?? 0));
  const marksFor = (t: RequirementTemplate): ('independence_declared')[] => (t.independent_of !== undefined && !t.independence_by_account && t.accepts_declared_independence === true ? ['independence_declared'] : []);

  for (const it of items) {
    const handling = handlingOf(it.id);
    const slots = slotsOf(it.id);
    const ev = evidenceOf(it.id);
    const carried = input.carried.get(it.id);
    const entry = entries.get(it.id);
    const origin = carried?.origin ?? input.origin;
    const modelIndependence = origin === null ? 'unknown' : independenceOf(origin, input.author);
    // W07 F[1]: a slot record comes with the digest of the context it was written in; one written in one go is marked no_reuse
    // (decision row 18 (b)). A context that is a SHA-256 binds the claims; any other spelling stays in the stored submission.
    const context = entry !== undefined && entry.entry.handling === 'handled' ? (entry.entry.context ?? null) : null;
    const writtenAlone: ('no_reuse')[] = context === null ? ['no_reuse'] : [];
    const contextBound = context !== null && SHA256.test(context) ? [context] : [];
    const sourceSha = rootDigest(it.location);
    let rejection: string | null = null;
    const results: RequirementResult[] = [];
    let handlingErrorRecorded=false;
    const waitingRepairs:Array<{requirement:string;pointer:string;exit:import('../../../contracts/src/validation.ts').UnknownExit}>=[];
    for (const t of itemTemplates) {
      const independence=t.independence_by_account?accountIndependenceOf(authorAccount(run)??'',accountAuthors):modelIndependence;
      const hasProducer = !isJudgment(t) || itemSlotKeys.has(t.key);
      const expectation = expectationFor(t, it.fields);
      const outcomes = outcomesFor(t, it.id);
      let raw = staticTerminal({
        producer: t.accepted_producer,
        hasProducer,
        checks: t.checks.filter((id) => checks.has(id)).length+(outcomes.some(o=>o.check===ADMISSION_CHECK)?1:0),
        outcomes,
        // A missing item artifact is a coverage gap even when its requirement accepts only facts. Pure target
        // checks keep their existing handling rules; production evaluation has no submitted artifact to omit.
        handling: isJudgment(t) ? (exclude.has(it.id) ? 'handled' : handling) : submission !== null && artifactRequirements.has(t.key) ? handling : null,
        expectation,
      });
      if ((raw.terminal==='pass'||raw.terminal==='judgment') && unruledChecks.some(({check})=>check.requirement===t.key)) raw={...raw,terminal:'judgment'};
      if ((raw.reason === 'declared_skip' || raw.reason === 'not_covered') && roundsLeftOf(t) === 0) raw = {...raw, reason:'repair_exhausted'};
      const routed = applyRouting(raw, t, input.roundsUsed.get(t.key) ?? 0, outcomes);
      const unresolved = t.layers.map((layer) => (layer === 'static' ? staticLayer(routed, expectation) : dynamicLayer(routed)));
      const layers = [] as typeof unresolved;
      for (const layer of unresolved) {
        if (layer.terminal === 'unchecked' || layer.terminal === 'incomplete' || layer.terminal === 'not_run' || layer.terminal === 'no_verdict' || outcomes.some(o=>o.outcome.verdict==='unknown')) {
          const owner = await ctx.deps.workflows.ownerOf?.(run.pack_digest) ?? workflow.owner;
          const administrator = administrators[0]?.id;
          const runner = run.runner ?? run.configurer;
          if (!owner || !administrator || !runner) throw new Error('无法绑定未知出口：缺少包 ownerOf、具名管理员或运行者；请管理员补齐身份读取接线后重验');
          const bound=bindRecovery(layer, {owner, administrator, runner, due: new Date(ctx.now().getTime()+24*60*60*1000).toISOString(), location: `${it.id} / ${t.key}`}, outcomes.map(o => o.outcome));
          // Only Hub-observed retain-only reads can select administrator acceptance; pack data cannot grant read rights.
          const retained=[...warmedUnread].filter(([,failure])=>failure.reason==='credential_unreadable').map(([reference])=>reference);
          for(const [reference,pending] of boundSourceCache)if((await pending).reason==='credential_unreadable'&&!retained.includes(reference))retained.push(reference);
          if(retained.length&&outcomes.some(o=>o.outcome.verdict==='unknown'&&(o.outcome.reason==='awaiting_step'||o.outcome.reason==='missing_input'))){
            bound.exit={action:'request',request_kind:'disposition',audience:{user:administrator},due:bound.exit?.due??new Date(ctx.now().getTime()+86400000).toISOString()};
            bound.missing=`管理员尚未接受只保留的来源：${retained.join('、')}；${bound.missing??''}`;
          }
          layers.push(bound);
        } else layers.push(layer);
      }
      const missingSessions=[...(input.author?.missingSessions??[]),...(run.session===undefined?[`运行 ${run.run} 的开始会话（原运行者 ${run.runner??run.configurer??'记录未给出'}）`]:[])];
      if(!t.independence_by_account&&t.independent_of!==undefined&&independence==='unknown'&&missingSessions.length){
        const runner=run.runner??run.configurer;
        if(!runner)throw new Error('历史独立性缺少具名受众');
        const missing=`缺少被判工作来源会话：${missingSessions.join('；')}`;
        const gap={reason:'missing_input' as const,missing,exit:{action:'request' as const,request_kind:'repair' as const,audience:{user:runner},due:new Date(ctx.now().getTime()+86400000).toISOString()}};
        for(const layer of layers)layer.gaps=[...(layer.gaps??[]),gap];
        errors.push({code:'missing_input',message:missing,item:it.id,requirement:t.key,fix:'请所列原运行者带 Circle-Session-Id，以原工作为 predecessor 开新修订并重新提交，再对新修订开复核运行'});
      }
      if(t.independence_by_account&&independence==='unknown'){
        const administrator=administrators[0]?.id;if(!administrator)throw new Error('作者账号恢复请求缺少具名管理员');
        const next='管理员 '+administrator+' 从可信备份恢复缺失的运行记录与 runner/configurer 身份，再核验账号并重开复核；不能补造历史身份';
        const missing='缺少完整的作者账号血缘，无法证明复核者不是任一作者；下一步：'+next;
        const gap={reason:'integrity_unproven' as const,missing,exit:{action:'request' as const,request_kind:'repair' as const,audience:{user:administrator},due:run.submission_due??new Date(ctx.now().getTime()+86400000).toISOString()}};
        for(const layer of layers)layer.gaps=[...(layer.gaps??[]),gap];
        errors.push({code:'integrity_unproven',message:missing,item:it.id,requirement:t.key,fix:next});
      }
      const status = requirementStatus({
        producer:t.accepted_producer,
        layers,
        hasProducer,
        expectation,
        expectedRefutation: routed.expectedRefutation,
        independence: t.independent_of !== undefined ? independence : null,
        acceptsDeclared: t.independence_by_account!==true&&t.accepts_declared_independence === true,
        accountVerified:t.independence_by_account===true,
      });
      if(status.status==='satisfied' && t.requires_discrimination && (!t.checks.some(id=>admittedChecks.get(id)?.admitted) || t.checks.some(id=>admittedChecks.has(id) && !admittedChecks.get(id)!.admitted))) {
        status.status='unsatisfied';status.unsatisfied_reason='outcome_mismatch';
      }
      const claims: Claim[] = [];
      if (isJudgment(t) && hasProducer && handling === 'handled' && !exclude.has(it.id)) {
        if (carried) claims.push(...(carried.claims.get(t.key) ?? []));
        else if (slots !== null && entry !== undefined && submission !== null) {
          const list = Array.isArray(slots[t.key]) ? (slots[t.key] as SlotClaim[]) : [];
          list.forEach((claim, j) => {
            const pointer = pointerOf('items', entry.index, 'slots', t.key, j);
            const ce = ev.claims.get(pointer) ?? { resolutions: [], roles: [], bound: [], grounds: [...(claim.grounds ?? []), ...(claim.quotes ?? []).map((q) => q.reference)], canonical: claim };
            claims.push(
              judgmentClaim({
                item: it.id,
                requirement: t.key,
                pointer,
                ...statementOf(claim),
                model: input.origin?.model??submission.model,
                ...(t.independent_of !== undefined ? { independence: warrantIndependence(independence,t.independence_by_account===true) } : {}),
                marks: [...marksFor(t), ...writtenAlone],
                sourceRole: strongestRole(ce.roles),
                coverage:sourceCoverage(run.sources,[it.location,...ce.grounds,...ce.bound]),
                grounds: ce.grounds,
                resolutions: ce.resolutions,
                bound: [...baseBound, ...ce.bound, ...contextBound, input.submissionDigest],
              }),
            );
          });
        }
      }
      for (const o of outcomes) {
        const check = checks.get(o.check)!;
        if(o.outcome.verdict==='support'&&submission&&entry)for(const source of new Set(o.outcome.judgment_sources??[])){
          const value=valueAt(entry.entry.handling==='handled'?entry.entry.slots:null,source);
          if(isObject(value)&&typeof value.text==='string'){
            const pointer=pointerOf('items',entry.index,'slots')+source;
            claims.push(judgmentClaim({item:it.id,requirement:t.key,pointer,text:value.text,data:{...value,judgment_source:{submission:input.submissionDigest,pointer,...(input.submissionRecord?{record:'rec:'+input.submissionRecord}:{})},model:submission.model},model:input.origin?.model??submission.model,marks:['conditional_on_judgment'],sourceRole:check.judges,grounds:o.outcome.grounds,resolutions:[],bound:[...baseBound,input.submissionDigest],premises:[pointer]}));
          }
        }
        const overClaims = o.judges === 'artifact_under_verification'||(o.outcome.judgment_sources?.length??0)>0;
        claims.push(
          factClaim({
            item: it.id,
            requirement: t.key,
            coverage:sourceCoverage(run.sources,[it.location,...o.outcome.grounds,...sourcesForReads(check).map(s=>s.reference)]),
            outcome: o.outcome,
            rule: claimRuleOf(check),
            ...runtimeFactOf(check),
            judges: o.judges,
            sampleMarks: sampleMarks[o.check] ?? [],
            overClaims,
            discrimination: t.requires_discrimination === true,
            bound: [...baseBound,...sourcesForReads(check).flatMap(source=>{const digest=rootDigest(source.reference);return digest?[digest]:[];}), ...(it.digest !== undefined ? [it.digest] : []), ...(sourceSha !== null ? [sourceSha] : []), ...(overClaims && submission !== null ? [input.submissionDigest] : [])],
            premises: [...premisesOf(o.outcome,check,it.id),...(entry?(o.outcome.judgment_sources??[]).map(source=>pointerOf('items',entry.index,'slots')+source):[])],
          }),
        );
      }
      results.push({ requirement: t.key, layers, ...status, claims });
      for (const r of routed.routed) {
        const check = checks.get(r.outcome.check)!;
        const path = submissionPointer(it.id, check, r.outcome.outcome.pointer);
        errors.push({
          code: r.outcome.outcome.code ?? r.outcome.outcome.reason ?? 'check_error',
          message: r.outcome.outcome.missing ?? r.outcome.outcome.statement,
          fix: runtimeCatalogGaps.get(r.outcome.check)?.next_action ?? (r.outcome.check===ADMISSION_CHECK&&typeof r.outcome.outcome.data?.fix==='string' ? r.outcome.outcome.data.fix : fixOf(r.outcome.outcome.code ?? '') ?? '按陈述改正后重交'),
          ...(path !== undefined ? { path } : {}),
          item: it.id,
          requirement: t.key,
          ...(r.action === 'repair' || r.outcome.outcome.verdict === 'unknown' ? { rounds_left: r.roundsLeft ?? roundsLeftOf(t) } : {}),
        });
        if (r.action === 'repair') {
          problems.add(t.key);
          const runner=run.runner??run.configurer;
          if(path&&runner){
            const wait=bindRecovery({layer:'static',terminal:'incomplete',reason:'awaiting_step'},{runner,owner:runner,administrator:runner,due:new Date(ctx.now().getTime()+86400000).toISOString(),location:`${it.id} / ${t.key}`});
            waitingRepairs.push({requirement:t.key,pointer:path,exit:wait.exit!});
          }
        }
      }
      for (const outcome of outcomes.filter(o => o.outcome.verdict === 'unknown')) {
        problems.add(t.key);
        if (routed.routed.some(r => r.outcome === outcome)) continue;
        const check=checks.get(outcome.check);
        errors.push({code:outcome.outcome.reason??'check_error',message:outcome.outcome.missing??outcome.outcome.statement,item:it.id,requirement:t.key,path:check?submissionPointer(it.id,check,outcome.outcome.pointer)??'/items':'/items',rounds_left:roundsLeftOf(t),fix:runtimeCatalogGaps.get(outcome.check)?.next_action??'补齐点名的事实后重交；不能补齐的按具名请求处理'});
      }
      if (submission!==null&&(handling === 'skipped' || handling === 'not_covered') && (isJudgment(t) || artifactRequirements.has(t.key))) {
        handlingErrorRecorded=true;
        problems.add(t.key);
        const reason=entry?.entry.handling==='skipped'?entry.entry.reason:'没有提交这个条目的处理声明';
        errors.push({code:roundsLeftOf(t)===0?'repair_exhausted':handling==='skipped'?'declared_skip':'not_covered',message:`条目 ${it.id}：${reason}`,item:it.id,requirement:t.key,path:entry?pointerOf('items',entry.index):'/items',rounds_left:roundsLeftOf(t),fix:'用 submit_result 对同一运行重交完整提交；完整的新提交仍可取代本次结果'});
      }
      // A reject row applies only to a blocking check on the artifact under verification (terminals.ts rowApplies).
      if (routed.action === 'reject' && rejection === null) rejection = routed.lead?.outcome.code ?? null;
    }
    if(entry?.entry.handling==='skipped'&&!handlingErrorRecorded){
      for(const template of itemTemplates)problems.add(template.key);
      errors.push({code:'declared_skip',message:`条目 ${it.id} 声明跳过：${entry.entry.reason}；Hub 已照常核对目标事实`,item:it.id,path:pointerOf('items',entry.index),rounds_left:Math.max(0,...itemTemplates.map(roundsLeftOf)),fix:'处理声明不改变 Hub 的目标事实；完整的新提交仍可替代'});
    }
    waitForRepairs(results,waitingRepairs);
    const notCovered = submission !== null && handling === 'not_covered' && itemTemplates.some(t => t.required && (isJudgment(t) || artifactRequirements.has(t.key)));
    if (notCovered) {
      const judged = itemTemplates.filter((t) => isJudgment(t) && itemSlotKeys.has(t.key));
      for (const t of judged) uncovered.add(t.key);
      const left = judged.length > 0 ? Math.min(...judged.map(roundsLeftOf)) : 0;
      errors.push({
        code: 'core.coverage.shortfall',
        message: `提交没有覆盖条目 ${it.id}（${it.label}）：它的各要求项记未完成`,
        fix: CORE_VIOLATION_CODES['core.coverage.shortfall'].fix,
        path: '/items',
        item: it.id,
        rounds_left: left,
      });
    }
    partitionInputs.push({
      item: it.id,
      label: it.label,
      location: it.location,
      requirements: results,
      required,
      notCovered,
      rejection,
      ...(carried ? { carriedOver: carried.reuse } : {}),
      ...(entry?.entry.handling==='skipped'?{skipReason:entry.entry.reason}:{}),
    });
  }

  // ---- cross-item claims: Hub facts of run-level checks and of run-level requirements, then the submitted entries
  const crossBound = [...baseBound, ...itemDigests];
  const cross: Claim[] = [];
  for(const {check,index} of unruledChecks)cross.push(judgmentClaim({
    requirement:check.requirement,pointer:pointerOf('checks',index),text:`要求项 ${check.requirement} 的 ${check.interpreter} 判定形状未裁定；由包作者在下一版台账裁定`,
    data:{requirement:check.requirement,interpreter:check.interpreter},model:submission!.model,
    marks:['decision_shape_unruled'],grounds:[],resolutions:[],bound:[...crossBound,input.submissionDigest,receivedDigest(run).digest],
  }));
  const factOf = (o: CheckOutcome, check: CheckEntry, requirement: string): Claim =>
    factClaim({
      ...(o.item !== undefined && itemIds.has(o.item) ? { item: o.item } : {}),
      requirement,
      coverage:sourceCoverage(run.sources,[...items.map(it=>it.location),...o.grounds,...sourcesForReads(check).map(s=>s.reference)]),
      outcome: o,
      rule: claimRuleOf(check),
            ...runtimeFactOf(check),
      judges: check.judges,
      sampleMarks: sampleMarks[check.id] ?? [],
      overClaims: check.judges === 'artifact_under_verification',
      discrimination: (requirementsOf.get(check.id) ?? []).some((t) => t.requires_discrimination === true),
      bound: [...crossBound,...sourcesForReads(check).flatMap(source=>{const digest=rootDigest(source.reference);return digest?[digest]:[];}), ...(check.judges === 'artifact_under_verification' && submission !== null ? [input.submissionDigest] : [])],
      premises: premisesOf(o, check, o.item !== undefined && itemIds.has(o.item) ? o.item : null),
    });
  for (const t of runTemplates) {
    for (const cid of t.checks) {
      const check = checks.get(cid);
      if (check === undefined) continue;
      const list =
        check.applies === 'run'
          ? [...[...(runOutcomes.get(cid)?.own.values() ?? [])].flat().filter((o) => o.item !== undefined), ...(runOutcomes.get(cid)?.loose ?? [])]
          : [...(itemOutcomes.get(cid)?.values() ?? [])].flat();
      for (const o of unique(list)) cross.push(factOf(o, check, t.key));
    }
  }
  for (const t of itemTemplates) {
    for (const cid of t.checks) {
      const check = checks.get(cid);
      if (check === undefined || check.applies !== 'run') continue;
      for (const o of runOutcomes.get(cid)?.loose ?? []) cross.push(factOf(o, check, t.key));
    }
  }
  if (submission !== null && input.origin !== null) {
    const origin = input.origin;
    for (const [j, entry] of (submission.cross_item ?? []).entries()) {
      const pointer = pointerOf('cross_item', j);
      const key = runRequirementOf(workflow.slots, entry.code);
      const template = key === null ? undefined : templates.find((t) => t.key === key);
      const ce = input.exact?.cross.get(pointer) ?? { resolutions: [], roles: [] as SourceRole[], bound: [], grounds: [...entry.grounds] };
      const independence = template?.independent_of !== undefined ? template.independence_by_account?accountIndependenceOf(authorAccount(run)??'',accountAuthors):independenceOf(origin, input.author) : null;
      cross.push(
        judgmentClaim({
          ...(key !== null ? { requirement: key } : {}),
          pointer,
          text: entry.statement,
          ...(entry.code !== undefined ? { code: entry.code } : {}),
          ...(entry.rank !== undefined ? { rank: entry.rank } : {}),
          ...(entry.nature === 'fact' ? { data: { declared_nature: 'fact' } } : {}),
          model: input.origin?.model??submission.model,
          ...(independence !== null ? { independence: warrantIndependence(independence,template?.independence_by_account===true) } : {}),
          marks: [...(entry.nature === 'fact' ? (['unverified_submission'] as const) : []), ...(template ? marksFor(template) : [])],
          sourceRole: strongestRole(ce.roles),
          coverage:sourceCoverage(run.sources,[...ce.grounds,...ce.bound]),
          grounds: ce.grounds,
          resolutions: ce.resolutions,
          bound: [...crossBound, ...ce.bound, input.submissionDigest],
          premises: entry.nature === 'judgment' ? (entry.premises ?? []) : [],
        }),
      );
    }
  }

  const partitions = partitionItems(partitionInputs, items.map((it) => it.id));
  const replacements=await replacedCriteria(ctx,criteria);
  for(const row of Object.values(partitions).flat()){const changes=replacements.filter(change=>change.item===row.item).map(({item,...change})=>change);if(changes.length)row.replaced_criteria=changes;}
  const max = templates.reduce((m, t) => Math.max(m, repairRounds(t)), 0);
  const usedRounds = Math.min(max, templates.reduce((m, t) => Math.max(m, Math.min(input.roundsUsed.get(t.key) ?? 0, repairRounds(t))), 0));
  const handled = items.filter((it) => handlingOf(it.id) === 'handled').length;
  const examined = submission === null || !hasItemJudgments ? items.length : handled;
  const result: ValidationResult = {
    schema: 'validation@1',
    run: run.run,
    submission: input.submissionDigest,
    acceptance: 'accepted',
    errors,
    rounds: { used: usedRounds, max },
    partitions,
    cross_item: cross,
    coverage: {
      complete: examined === items.length,
      examined,
      total: items.length,
      ...((submission !== null && hasItemJudgments)||ctx.parsers.bindingDisclosure ? {note:[...(submission!==null&&hasItemJudgments?[`提交处理了 ${handled} 个条目，共 ${items.length} 个`]:[]),...(ctx.parsers.bindingDisclosure?[ctx.parsers.bindingDisclosure]:[])].join('；')} : {}),
    },
    locks: { ...(skills?{skills:[...skills]}:{}),...(run.feeding_offset?{feeding_offset:run.feeding_offset}:{}),...(run.unversioned_root ? { unversioned_root: run.unversioned_root } : {}), pack: run.pack, pack_digest: run.pack_digest, ...(run.root !== undefined ? { root: run.root } : {}) },
    trace: input.traceId,
  };
  attachParentRecovery(result,retryAttempts,ctx.now());
  return { result, errors, problems, uncovered, retryAttempts,parentObservedSuccess, runtimeAdmission };
}
