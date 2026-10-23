// The Hub recomputes everything itself (T03 R[1], W08): every check of every requirement re-runs through hub/rules with the
// pack's table, the locked catalog and the subject; outcomes become the terminals of each (item, requirement, layer), the
// requirement status, the claims and the partitions. A run-level check gets one subject built from all items, an item check
// one subject per item; outcomes are assigned to items by their item id and an outcome without an item is a run-level fact.
import { CORE_VIOLATION_CODES } from '../../../contracts/generated/protocol.ts';
import type { PermissionRole, Reason, SourceRole } from '../../../contracts/generated/vocabulary.ts';
import type { Claim } from '../../../contracts/src/claim.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import { MAX_CHECK_READ_BYTES, type CheckEntry, type RequirementTemplate, type RunContext, type SlotClaim, type SubjectItem } from '../../../contracts/src/pack.ts';
import type { ItemProjection, RunRecord } from '../../../contracts/src/run.ts';
import type { Submission } from '../../../contracts/src/submission.ts';
import type { RequirementResult, ValidationResult } from '../../../contracts/src/validation.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import { publishCheckMarks } from '../packs/marks.ts';
import type { Principal } from '../../records/api.ts';
import { MAX_REFERENCE_LENGTH, parseReference, resolveReference, type RecordReader, type ResolveContext, type SourceReader } from '../../refs/api.ts';
import { SandboxError, callPackFunction, runCheck, sourcesFrom, type CatalogView, type CheckOutcome, type SourceView, type UnreadSource, type SandboxOptions } from '../../rules/api.ts';
import { factClaim, judgmentClaim, rootDigest, statementOf, strongestRole } from './claims.ts';
import { CHECK_PARALLELISM, type EngineContext } from './deps.ts';
import { retryRead, type ReadFailureReason } from './retry-read.ts';
import { createSubjectBuilder } from './subjects.ts';
import { describe, fixOf } from './errors.ts';
import { emptyEvidence, type ExactResult, type ItemEvidence } from './exact.ts';
import { independenceOf, warrantIndependence, type AuthorOrigin, type ProducerOrigin } from './independence.ts';
import { partitionItems, type PartitionInput } from './partitions.ts';
import { identityOf, recordReader, sourceReader } from './readers.ts';
import { runRequirementOf } from './slots.ts';
import {
  applyRouting,
  dynamicLayer,
  expectationFor,
  repairRounds,
  requirementStatus,
  staticLayer,
  staticTerminal,
  type Handling,
  type JudgedOutcome,
} from './terminals.ts';
import { isObject, mapLimited, pointerOf, tooDeep, unique } from './util.ts';

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
  exact: ExactResult | null;
  carried: ReadonlyMap<string, CarriedItem>;
  /** Repair rounds each requirement used in earlier submissions of the run. */
  roundsUsed: ReadonlyMap<string, number>;
  /** Who produced this submission's judgments; null for a production result. */
  origin: ProducerOrigin | null;
  /** Who produced the work the run judges (lineage.ts); null when the Hub does not know (no predecessor). */
  author: AuthorOrigin | null;
  traceId: string;
  /** Items whose own exact values did not resolve: no checks or conclusions for them (a not-accepted submission). */
  exclude?: ReadonlySet<string>;
}

export interface Evaluation {
  result: ValidationResult;
  /** Item-level refutations routed by the error table and the items the submission did not cover (also in result.errors). */
  errors: ProtocolError[];
  /** Requirements with a refutation routed to repair in this submission (a repair round). */
  problems: Set<string>;
  /** Requirements of the items the submission did not cover (W07 R[3]: also a repair round). */
  uncovered: Set<string>;
  retryAttempts: Array<Record<string, unknown>>;
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
  const sandbox = error instanceof SandboxError;
  const reason: Reason = sandbox ? sandboxReason(error) : 'check_error';
  return {
    verdict: 'unknown',
    reason,
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
  const mine = new Set((run.leases ?? []).flatMap((entry) => entry.keys));
  const entries = new Map<string, { key: string; until: string; mine: boolean }>();
  for (const row of run.lease_context ?? []) entries.set(row.key, { key: row.key, until: row.until, mine: row.mine || mine.has(row.key) });
  return { now: run.started_at, entries: [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) };
}

/** rule@version of a check: the core interpreter, or the pack function check of this pack version. */
function ruleOf(workflow: LoadedWorkflow, check: CheckEntry): string {
  return check.interpreter ?? `${workflow.pack.id}.${check.id}@${workflow.pack.version}`;
}

export async function evaluate(ctx: EngineContext, input: EvaluationInput): Promise<Evaluation> {
  const { run, workflow, submission } = input;
  const retryAttempts: Array<Record<string, unknown>> = [];
  const sandboxFor = (operation: string, module?: string, item?: string): SandboxOptions => ({
    ...ctx.deps.sandbox,
    onAttempt: attempt => {
      if (attempt.retry || attempt.attempt > 1) retryAttempts.push({ operation,
        ...(module !== undefined ? { module } : {}), ...(item !== undefined ? { item } : {}), ...attempt });
      try { ctx.deps.sandbox?.onAttempt?.(attempt); } catch { /* Diagnostics cannot change a check. */ }
    },
  });

  // The sample marks of the locked version's checks (T02 R[1]), computed once: fact claims of a check with only author
  // samples carry author_samples_only. A model judgment never takes them — they speak about a rule's samples.
  const sampleMarks = publishCheckMarks(workflow);
  const exclude = input.exclude ?? new Set<string>();
  const templates = workflow.requirements;
  const itemTemplates = templates.filter((t) => t.target === 'item');
  const runTemplates = templates.filter((t) => t.target === 'run');
  const checks = new Map(workflow.checks.map((c) => [c.id, c]));
  // Whole-refusal diagnostics must never check unresolved items, including fact checks and run-level subjects.
  // An accepted submission supplies no exclusions, so skipped and uncovered items keep their normal semantics.
  const items = run.items.filter(it => !exclude.has(it.id));
  const itemIds = new Set(items.map((it) => it.id));
  const baseBound = [run.pack_digest, ...(run.root !== undefined ? [run.root] : [])];
  const itemDigests = items.map((it) => it.digest).filter((d): d is string => d !== undefined);
  const entries = new Map<string, { index: number; entry: Submission['items'][number] }>();
  submission?.items.forEach((entry, index) => entries.set(entry.item, { index, entry }));
  const itemSlotKeys = new Set(Object.keys(workflow.slots.item));
  const hasItemJudgments = itemTemplates.some((t) => isJudgment(t) && itemSlotKeys.has(t.key));
  const artifactRequirements = new Set(itemTemplates.filter(t => t.checks.some(id => checks.get(id)?.judges === 'artifact_under_verification')).map(t => t.key));
  const sets = closedSets(workflow);
  const context = runContextOf(run);

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
    if (check.catalog === undefined || views.has(check.catalog)) continue;
    views.set(check.catalog, run.root !== undefined ? await ctx.deps.knowledge.catalog(run.root, check.catalog) : null);
  }
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
      sources: sourceReader(ctx.deps.records.artifacts, 'function'),
      trees: ctx.deps.knowledge.treeReader(),
      records: recordReader(ctx.deps.records.store),
      consumer: 'function',
      documents: ctx.documents,
    };
  } else {
    // Hub standing obligation: Hub's own system read path
    const systemSources: SourceReader = {
      async read(sha256) {
        const records = await ctx.deps.records.artifacts.records(sha256);
        const first = records[0];
        if (first !== undefined && first.body.read_tier === 'retain_only') {
          return { bytes: null, mediaType: first.body.media_type, size: first.body.size, readTier: first.body.read_tier };
        }
        const bytes = await ctx.deps.records.artifacts.trustedBytes(sha256);
        if (bytes === null) return null;
        return {
          bytes,
          mediaType: first?.body.media_type ?? 'application/octet-stream',
          size: bytes.byteLength,
          readTier: first?.body.read_tier ?? 'function_bytes_only',
        };
      },
    };
    const systemRecords: RecordReader = {
      async read(digest) {
        const record = await ctx.deps.records.store.get(digest);
        if (record === null) return null;
        return { kind: record.kind, schema: record.schema, provenance: record.provenance, created_at: record.created_at, body: record.body };
      },
    };
    resolveCtx = {
      reader: { user: 'hub', role: 'admin', run: run.run },
      parsers: ctx.parsers,
      sources: systemSources,
      trees: ctx.deps.knowledge.treeReader(),
      records: systemRecords,
      consumer: 'function',
      documents: ctx.documents,
    };
  }

  const boundSourceCache = new Map<string, Promise<{ resolved: boolean; text: string | null; byteLength?: number; reason?: ReadFailureReason }>>();

  const resolveBoundSource = (reference: string) => {
    let pending = boundSourceCache.get(reference);
    if (!pending) {
      pending = (async () => {
        try {
          const parsed = parseReference(reference);
          const result = await retryRead(() => resolveReference(parsed, resolveCtx), result => result.resolved ? null
            : { reason: result.reason ?? result.code, retry: result.code === 'SOURCE_UNAVAILABLE' }, attempt => {
              if (attempt.retry || attempt.attempt > 1) retryAttempts.push({ operation: 'bound_source', reference, ...attempt });
            });
          if (!result.resolved) {
            return { resolved: false, text: null, reason: result.reason ?? result.code };
          }
          if (result.text === null) {
            return { resolved: true, text: null, reason: 'missing_input' as const };
          }
          const byteLength = Buffer.byteLength(result.text, 'utf8');
          return { resolved: true, text: result.text, byteLength };
        } catch (error) {
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

  const readBoundSources = async (check: CheckEntry): Promise<{ boundSources: Record<string, string>; unreadSources: UnreadSource[] }> => {
    if (check.reads === undefined) {
      return { boundSources: {}, unreadSources: [] };
    }
    const maxBytes = check.reads.max_bytes ?? MAX_CHECK_READ_BYTES;
    const roles = new Set(check.reads.roles);
    const types = check.reads.types !== undefined ? new Set(check.reads.types) : undefined;
    const matchingSources = (run.sources ?? []).filter((s) => {
      if (!roles.has(s.role)) return false;
      if (types !== undefined) {
        if (s.external === undefined) return false;
        const extType = externalTypeOf(s.external);
        if (extType === null || !types.has(extType)) return false;
      }
      return true;
    });
    const boundSources: Record<string, string> = {};
    const unreadSources: UnreadSource[] = [];
    for (const s of matchingSources) {
      const result = await resolveBoundSource(s.reference);
      const extra = {
        ...(s.external !== undefined ? { external: s.external } : {}),
        ...(s.slot !== undefined ? { slot: s.slot } : {}),
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
  const fragmentCache = new Map<string, Promise<{ text?: string; why: string }>>();
  const gradeFragment = (reference: string, capBytes: number = MAX_CHECK_READ_BYTES): Promise<{ text?: string; why: string }> => {
    let pending = fragmentCache.get(reference);
    if (pending === undefined) {
      pending = (async () => {
        let ref: ReturnType<typeof parseReference>;
        try {
          ref = parseReference(reference);
        } catch {
          return { why: 'unavailable' };
        }
        const finish = async (r: Awaited<ReturnType<typeof resolveReference>>): Promise<{ text?: string; why: string }> => {
          if (!r.resolved) {
            // By the resolver's own code: REFERENCE_UNRESOLVED means the reference resolves to nothing inside the
            // bound thing (no such fragment — the model can fix the selector or the quote); SOURCE_UNAVAILABLE means
            // the read genuinely failed. For a reference that is not src or a locked tree, unresolved also lands here
            // as unavailable: an honest unknown, never a refutation.
            return { why: r.code === 'REFERENCE_UNRESOLVED' && (ref.scheme === 'src' || ref.scheme === 'tree') ? 'no_fragment' : 'unavailable' };
          }
          if (r.readTier === 'retain_only') return { why: 'retain_only' };
          if (r.text === null) return { why: 'unavailable' };
          if (Buffer.byteLength(r.text, 'utf8') > capBytes) return { why: 'too_large' };
          return { text: r.text, why: 'bound' };
        };
        if (ref.scheme === 'src') {
          // The source must be an input of this run: the run's own scope decides, never the artifact store alone.
          const bound = (run.sources ?? []).some((s) => s.reference.startsWith(`src:${ref.sha256}`));
          if (!bound) return { why: 'not_bound' };
        } else if (ref.scheme === 'tree') {
          // A tree reference is bound exactly when its root is the root this run locked.
          if (run.root === undefined || ref.root !== run.root) return { why: 'not_bound' };
        }
        // rec: and every other scheme follow the boundary's own rule — resolvable reads, unresolved stays unknown.
        return finish(await resolveReference(ref, resolveCtx));
      })();
      fragmentCache.set(reference, pending);
    }
    return pending;
  };
  const quotedReferences = new Set<string>();
  /** Every reference-like string in the slot records (an interpreter's table may point at any of them). */
  const collectQuotedReferences = (value: unknown): void => {
    if (typeof value === 'string' && value.length <= MAX_REFERENCE_LENGTH && /^(?:src|tree|entry|rec):/.test(value)) {
      quotedReferences.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collectQuotedReferences(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) collectQuotedReferences(item);
    }
  };
  const warmed = new Map<string, string>();
  const warmedWhy = new Map<string, string>();
  const gradedSourceView = (texts: ReadonlyMap<string, string>): SourceView => ({
    text: (reference) => texts.get(reference) ?? warmed.get(reference),
    // A reference never warmed (not collected, or the warm pass failed) reads as unavailable: an honest
    // unknown, never a refutation.
    why: (reference) => (texts.has(reference) || warmed.has(reference) ? 'bound' : warmedWhy.get(reference) ?? 'unavailable'),
  });
  /** Warm every quoted reference of an item's slot record before its checks run (once per reference per evaluation). */
  const warmQuoted = async (value: unknown, capBytes: number, texts: ReadonlyMap<string, string>): Promise<void> => {
    collectQuotedReferences(value);
    await Promise.all([...quotedReferences].map(async (reference) => {
      if (texts.has(reference) || warmed.has(reference) || warmedWhy.has(reference)) return;
      const graded = await gradeFragment(reference, capBytes);
      if (graded.text !== undefined) warmed.set(reference, graded.text);
      else warmedWhy.set(reference, graded.why);
    }));
  };

  const callCheck = async (check: CheckEntry, subject: unknown, texts: ReadonlyMap<string, string>, item?: string): Promise<CheckOutcome[]> => {
    let table: unknown;
    if (check.table !== undefined) {
      try {
        table = workflow.readJson(check.table);
      } catch (error) {
        onError(error, check.id);
        return [tableFailure(check)];
      }
    }
    const view = check.catalog !== undefined ? (views.get(check.catalog) ?? undefined) : undefined;
    const { boundSources, unreadSources } = await readBoundSources(check);
    await warmQuoted(subject, check.reads?.max_bytes ?? MAX_CHECK_READ_BYTES, texts);
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
        onError,
      },
    );
    return outcomes.map((o) => bounded(check, unreadSources.length ? { ...o, data: { ...o.data, unread_sources: unreadSources } } : o));
  };
  const subjectBuilder = () => createSubjectBuilder(async (target, subjectInput) =>
    (await callPackFunction(target, subjectInput, ctx.deps.sandboxLimits, sandboxFor('subject', target.module,
      isObject(subjectInput) && isObject(subjectInput.item) && typeof subjectInput.item.id === 'string' ? subjectInput.item.id : undefined))).output);
  const buildSubject = async (subjectFor: ReturnType<typeof createSubjectBuilder>, check: CheckEntry, builderInput: unknown, fallback: () => unknown): Promise<{ subject: unknown } | { failure: CheckOutcome }> => {
    if (check.subject === undefined) return { subject: fallback() };
    try {
      const subject = await subjectFor({ packDir: workflow.pack.directory, module: check.subject.module, export: check.subject.export }, builderInput);
      return { subject };
    } catch (error) {
      onError(error, `${check.id} subject`);
      return { failure: builderFailure(check, error) };
    }
  };

  // ---- run every check
  const used = workflow.checks.filter((c) => requirementsOf.has(c.id));
  const runOutcomes = new Map<string, { own: Map<string, CheckOutcome[]>; loose: CheckOutcome[] }>();
  const itemOutcomes = new Map<string, Map<string, CheckOutcome[]>>();
  const judgmentOnly = (check: CheckEntry): boolean => (requirementsOf.get(check.id) ?? []).every(isJudgment);
  const missingItemArtifact = (id: string): boolean => submission !== null && handlingOf(id) !== 'handled';
  const artifactCheck = (check: CheckEntry): boolean => check.judges === 'artifact_under_verification';
  const allTexts = new Map<string, string>();
  for (const it of items) for (const [k, v] of evidenceOf(it.id).texts) allTexts.set(k, v);

  const runSubjects = subjectBuilder();
  for (const check of used.filter((c) => c.applies === 'run' && (items.length > 0 || exclude.size === 0))) {
    // A run check of item artifacts sees only submitted artifacts. A check of a run-level artifact (for example
    // a final claim) still needs every target's metadata to test coverage, but receives no absent slot property.
    const itemArtifactsOnly = artifactCheck(check) && (requirementsOf.get(check.id) ?? []).every(t => t.target === 'item');
    const checkItems = itemArtifactsOnly ? items.filter(it => !missingItemArtifact(it.id)) : items;
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
  await mapLimited(items, CHECK_PARALLELISM, async (it) => {
    const itemSubjects = subjectBuilder();
    const slots = exclude.has(it.id) ? null : checkedSlotsOf(it.id);
    const ev = evidenceOf(it.id);
    for (const check of perItem) {
      if (artifactCheck(check) && missingItemArtifact(it.id)) continue;
      if (judgmentOnly(check) && (handlingOf(it.id) !== 'handled' || exclude.has(it.id) || submission === null)) continue;
      const evidence = slots === null ? [] : ev.evidence;
      const built = await buildSubject(itemSubjects, check, { applies: 'item', item: subjectItem(it), slots, evidence, context }, () => ({
        item: it.id,
        label: it.label,
        location: it.location,
        fields: it.fields,
        slots,
        evidence,
      }));
      const outcomes = 'failure' in built ? [built.failure] : await callCheck(check, built.subject, ev.texts, it.id);
      let byItem = itemOutcomes.get(check.id);
      if (!byItem) itemOutcomes.set(check.id, (byItem = new Map()));
      byItem.set(it.id, outcomes);
    }
  });

  const outcomesFor = (template: RequirementTemplate, id: string): JudgedOutcome[] =>
    template.checks.flatMap((cid) => {
      const check = checks.get(cid);
      if (check === undefined || (artifactCheck(check) && missingItemArtifact(id))) return [];
      const list = check.applies === 'run' ? (runOutcomes.get(cid)?.own.get(id) ?? []) : (itemOutcomes.get(cid)?.get(id) ?? []);
      return list.map((outcome) => ({ outcome, check: cid, judges: check.judges }));
    });

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
  const marksFor = (t: RequirementTemplate): ('independence_declared')[] => (t.independent_of !== undefined && t.accepts_declared_independence === true ? ['independence_declared'] : []);

  for (const it of items) {
    const handling = handlingOf(it.id);
    const slots = slotsOf(it.id);
    const ev = evidenceOf(it.id);
    const carried = input.carried.get(it.id);
    const entry = entries.get(it.id);
    const origin = carried?.origin ?? input.origin;
    const independence = origin === null ? 'unknown' : independenceOf(origin, input.author);
    // W07 F[1]: a slot record comes with the digest of the context it was written in; one written in one go is marked no_reuse
    // (decision row 18 (b)). A context that is a SHA-256 binds the claims; any other spelling stays in the stored submission.
    const context = entry !== undefined && entry.entry.handling === 'handled' ? (entry.entry.context ?? null) : null;
    const writtenAlone: ('no_reuse')[] = context === null ? ['no_reuse'] : [];
    const contextBound = context !== null && SHA256.test(context) ? [context] : [];
    const sourceSha = rootDigest(it.location);
    let rejection: string | null = null;
    const results: RequirementResult[] = [];
    for (const t of itemTemplates) {
      const hasProducer = !isJudgment(t) || itemSlotKeys.has(t.key);
      const expectation = expectationFor(t, it.fields);
      const outcomes = outcomesFor(t, it.id);
      const raw = staticTerminal({
        producer: t.accepted_producer,
        hasProducer,
        checks: t.checks.filter((id) => checks.has(id)).length,
        outcomes,
        // A missing item artifact is a coverage gap even when its requirement accepts only facts. Pure target
        // checks keep their existing handling rules; production evaluation has no submitted artifact to omit.
        handling: isJudgment(t) ? (exclude.has(it.id) ? 'handled' : handling) : handling === 'skipped' || ((hasItemJudgments || (submission !== null && artifactRequirements.has(t.key))) && handling === 'not_covered') ? handling : null,
        expectation,
      });
      const routed = applyRouting(raw, t, input.roundsUsed.get(t.key) ?? 0);
      const layers = t.layers.map((layer) => (layer === 'static' ? staticLayer(routed, expectation) : dynamicLayer(routed)));
      const status = requirementStatus({
        layers,
        hasProducer,
        expectation,
        expectedRefutation: routed.expectedRefutation,
        independence: t.independent_of !== undefined ? independence : null,
        acceptsDeclared: t.accepts_declared_independence === true,
      });
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
                model: submission.model,
                ...(t.independent_of !== undefined ? { independence: warrantIndependence(independence) } : {}),
                marks: [...marksFor(t), ...writtenAlone],
                sourceRole: strongestRole(ce.roles),
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
        const overClaims = o.judges === 'artifact_under_verification';
        claims.push(
          factClaim({
            item: it.id,
            requirement: t.key,
            outcome: o.outcome,
            rule: ruleOf(workflow, check),
            judges: o.judges,
            sampleMarks: sampleMarks[o.check] ?? [],
            overClaims,
            discrimination: t.requires_discrimination === true,
            bound: [...baseBound, ...(it.digest !== undefined ? [it.digest] : []), ...(sourceSha !== null ? [sourceSha] : []), ...(overClaims && submission !== null ? [input.submissionDigest] : [])],
            premises: premisesOf(o.outcome, check, it.id),
          }),
        );
      }
      results.push({ requirement: t.key, layers, ...status, claims });
      for (const r of routed.routed) {
        if (r.action === 'unknown') continue;
        const check = checks.get(r.outcome.check)!;
        const path = submissionPointer(it.id, check, r.outcome.outcome.pointer);
        errors.push({
          code: r.outcome.outcome.code ?? 'check_error',
          message: r.outcome.outcome.statement,
          fix: fixOf(r.outcome.outcome.code ?? '') ?? '按陈述改正后重交',
          ...(path !== undefined ? { path } : {}),
          item: it.id,
          requirement: t.key,
          ...(r.action === 'repair' ? { rounds_left: r.roundsLeft ?? 0 } : {}),
        });
        if (r.action === 'repair') problems.add(t.key);
      }
      // A reject row applies only to a blocking check on the artifact under verification (terminals.ts rowApplies).
      if (routed.action === 'reject' && rejection === null) rejection = routed.lead?.outcome.code ?? null;
    }
    const notCovered = submission !== null && (hasItemJudgments || artifactRequirements.size > 0) && handling === 'not_covered';
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
    });
  }

  // ---- cross-item claims: Hub facts of run-level checks and of run-level requirements, then the submitted entries
  const crossBound = [...baseBound, ...itemDigests];
  const cross: Claim[] = [];
  const factOf = (o: CheckOutcome, check: CheckEntry, requirement: string): Claim =>
    factClaim({
      ...(o.item !== undefined && itemIds.has(o.item) ? { item: o.item } : {}),
      requirement,
      outcome: o,
      rule: ruleOf(workflow, check),
      judges: check.judges,
      sampleMarks: sampleMarks[check.id] ?? [],
      overClaims: check.judges === 'artifact_under_verification',
      discrimination: (requirementsOf.get(check.id) ?? []).some((t) => t.requires_discrimination === true),
      bound: [...crossBound, ...(check.judges === 'artifact_under_verification' && submission !== null ? [input.submissionDigest] : [])],
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
      const independence = template?.independent_of !== undefined ? independenceOf(origin, input.author) : null;
      cross.push(
        judgmentClaim({
          ...(key !== null ? { requirement: key } : {}),
          pointer,
          text: entry.statement,
          ...(entry.code !== undefined ? { code: entry.code } : {}),
          ...(entry.rank !== undefined ? { rank: entry.rank } : {}),
          ...(entry.nature === 'fact' ? { data: { declared_nature: 'fact' } } : {}),
          model: submission.model,
          ...(independence !== null ? { independence: warrantIndependence(independence) } : {}),
          marks: [...(entry.nature === 'fact' ? (['unverified_submission'] as const) : []), ...(template ? marksFor(template) : [])],
          sourceRole: strongestRole(ce.roles),
          grounds: ce.grounds,
          resolutions: ce.resolutions,
          bound: [...crossBound, ...ce.bound, input.submissionDigest],
          premises: entry.nature === 'judgment' ? (entry.premises ?? []) : [],
        }),
      );
    }
  }

  const partitions = partitionItems(partitionInputs, items.map((it) => it.id));
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
      ...(submission !== null && hasItemJudgments ? { note: `提交处理了 ${handled} 个条目，共 ${items.length} 个` } : {}),
    },
    locks: { pack: run.pack, pack_digest: run.pack_digest, ...(run.root !== undefined ? { root: run.root } : {}) },
    trace: input.traceId,
  };
  return { result, errors, problems, uncovered, retryAttempts };
}
