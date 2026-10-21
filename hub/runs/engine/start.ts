// start_run (W06): check the arguments, answer a repeated client key, authorize the pack, fix the target, bind the inputs,
// project the items, bind the expected sources, offer carry-overs, freeze everything in a run record and, for a pack whose
// requirements are all facts, compute the validation result at once (a production run; the same path serves runs the Hub
// executes for a standing obligation). A client key repeated inside its window returns the same run, even after the pack was
// unassigned (the run stays its runner's); other content under the same key is IDEMPOTENCY_MISMATCH. Arguments the records
// cannot hold are refused before anything is read, and nothing is stored that a record could not hold.
import { z } from 'zod';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { RequirementTemplate, RunContext } from '../../../contracts/src/pack.ts';
import { RunRecord, RunSummary, type RequirementSummary } from '../../../contracts/src/run.ts';
import { StartRunInput, type StartRunOutput } from '../../../contracts/src/tools.ts';
import { partitionCountsOf, type PartitionCounts, type ValidationResult } from '../../../contracts/src/validation.ts';
import { CanonicalizationError, LimitError, canonicalize, newId, type Principal, type StoredRecord } from '../../records/api.ts';
import type { CallContext, LoadedWorkflow, Untraced } from '../../ports.ts';
import { parseReference, recReference, resolveReference } from '../../refs/api.ts';
import type { EngineContext } from './deps.ts';
import { Refusal, describe, protocolError, unavailable } from './errors.ts';
import { evaluate, type Evaluation } from './evaluate.ts';
import { bindInputs } from './inputs.ts';
import { foreignArtifacts, packIdOf } from './lineage.ts';
import { bindExpected, projectItems } from './projection.ts';
import { canSeeRun, identityOf, recordReader, runOfRecord, sourceReader } from './readers.ts';
import { reuseOffers } from './reuse.ts';
import { issuesOf, packSchema, schemaProblems, slotSchemaOf } from './slots.ts';
import { keyOwner, latestAccepted, putAction, putResult, putRun, runByClientKey, runById, runRecordDigest } from './store.ts';
import { resolveTarget } from './target.ts';
import { repairRounds } from './terminals.ts';
import { clipPointer, pointerOf, receivedDigest, sessionOf } from './util.ts';

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
  answer: StartRunAnswer;
  /** Present for a run whose requirements are all facts: the result the Hub computed at once. */
  production: ProductionResult | null;
}

export interface StartMode {
  /** local_circle for a caller's session; hub for a standing obligation the Hub executes (W06 F[1], W09 R[3]). */
  host: 'local_circle' | 'hub';
}

/** A pack whose requirements are all facts needs no model input: start_run computes its result (production run). */
export function isProduction(workflow: LoadedWorkflow): boolean {
  return workflow.requirements.every((r) => r.accepted_producer === 'fact');
}

export function requirementSummary(t: RequirementTemplate): RequirementSummary {
  return { key: t.key, name: t.name, description: t.description, layers: t.layers, done_rule: t.done_rule, accepted_producer: t.accepted_producer, repair_rounds: repairRounds(t) };
}

/** The summary part of a run record, as start_run returns it. */
export function summaryOf(record: RunRecord): RunSummary {
  const { runner: _r, host: _h, trigger: _t, configurer: _c, parameters: _p, policy: _po, executors: _e, groups: _g, client_key: _k, request_digest: _d, client_key_expires_at: _x, ...summary } = record;
  return RunSummary.parse(summary);
}

const SPLIT_FIX = '把被判对象分块（每块分别开运行），按分块评审的做法逐块提交';

function refused(errors: ProtocolError[]): StartRunDetail {
  return { answer: { call_result: 'error', errors }, production: null };
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

async function productionOf(ctx: EngineContext, run: RunRecord): Promise<ProductionResult | null> {
  const workflow = await ctx.deps.workflows.byDigest(run.pack_digest);
  if (workflow === null || !isProduction(workflow)) return null;
  const latest = await latestAccepted(ctx.deps.records.store, run.run);
  return latest === null ? null : { reference: recReference(latest.digest), record: latest.digest, result: latest.body, counts: partitionCountsOf(latest.body.partitions) };
}

export async function startRun(ctx: EngineContext, user: Principal, raw: unknown, call: CallContext, mode: StartMode): Promise<StartRunDetail> {
  const at = ctx.now();
  // Nothing is read for arguments the records could not hold (a lone surrogate, nesting past the canonical limit).
  const plain = receivedDigest(raw);
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
    const owner = mode.host === 'hub' ? keyOwner({ configurer: user.id }) : user.id;
    const requestDigest = receivedDigest(input).digest;
    const fresh = (): Promise<StartRunDetail> => authorizedStart(ctx, user, input, call, mode, at, requestDigest);
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
        return { answer: { call_result: 'ok', errors: [], run: summaryOf(existing.body) }, production: await productionOf(ctx, existing.body) };
      }
      return fresh();
    });
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    if (error.adminNote !== null) ctx.log({ traceId: call.traceId, run: null, what: 'start_run', detail: error.adminNote });
    return refused(error.errors);
  }
}

async function authorizedStart(
  ctx: EngineContext,
  user: Principal,
  input: z.infer<typeof StartRunInput>,
  call: CallContext,
  mode: StartMode,
  at: Date,
  requestDigest: string,
): Promise<StartRunDetail> {
  const workflow = await ctx.deps.workflows.forUser(user, input.pack);
  if (workflow === null || workflow.pack.kind !== 'workflow') throw unavailable('/pack', `pack ${input.pack} is unknown, not assigned to ${user.id}, withdrawn or not a workflow pack`);
  if (mode.host === 'hub' && !isProduction(workflow)) {
    throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', '含模型槽位的任务包不能由 Hub 执行（W09 R[3]：常设义务只许确定性函数）', { path: '/pack', fix: '改用只含事实要求项的任务包' })]);
  }
  const unsafe = schemaProblems(workflow);
  if (unsafe.length > 0) {
    throw new Refusal(
      [
        protocolError('SUBMISSION_SCHEMA_VIOLATION', `任务包 ${workflow.pack.id}@${workflow.pack.version} 声明的 JSON Schema 不能在 Hub 里安全执行：${unsafe.join('；')}`, {
          path: '/pack',
          fix: '请联系任务包作者：去掉正则表达式关键字（pattern、patternProperties），只用 Hub 读得懂的模式',
        }),
      ],
      `pack ${workflow.pack.id}@${workflow.pack.version} declares schemas the engine cannot enforce: ${unsafe.join('; ')}`,
    );
  }
  return startFresh(ctx, user, input, call, mode, workflow, at, requestDigest);
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
): Promise<StartRunDetail> {
  const { store, artifacts } = ctx.deps.records;
  const startedAt = at.toISOString();
  let predecessor: StoredRecord<RunRecord> | null = null;
  if (input.predecessor !== undefined) {
    predecessor = await runById(store, input.predecessor);
    if (predecessor === null || !canSeeRun(user, predecessor.body)) throw unavailable('/predecessor', `predecessor ${input.predecessor} is unknown or not visible to ${user.id}`);
  }
  const parameters = checkParameters(workflow, input.parameters ?? {});
  if (predecessor !== null) await checkLineage(ctx, user, workflow, input, predecessor.body);
  const target = await resolveTarget(ctx, user, workflow, input, startedAt, call.traceId);
  const runId = newId('run', at.getTime());
  const bound = await bindInputs(ctx, user, workflow, input.inputs, runId, call.traceId);
  // The projection runs before any group exists; the expected sources and the checks see the frozen groups.
  const context: RunContext = {
    product: target.product?.product.id ?? null,
    names: target.product?.product.names ?? [],
    line: target.line,
    build: target.buildName,
    root: target.root?.root ?? null,
    parameters,
    groups: [],
  };
  const projection = await projectItems(ctx, user, workflow, bound, parameters, context, call.traceId);
  const expected = await bindExpected(ctx, user, workflow, bound, projection.projected, parameters, { ...context, groups: projection.groups }, runId, call.traceId);

  let items = projection.items;
  const packId = workflow.pack.id;
  const previous = predecessor;
  const handover = previous !== null && bound.some((b) => b.record !== null && b.record.run === previous.body.run);
  if (previous !== null && !handover && packIdOf(previous.body.pack) === packId) {
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
        boundShas,
        boundRecords,
        subjectShas: bound.filter((b) => b.slot === workflow.workflow.subject).map((b) => b.sha256),
        fragmentText: async (reference) => {
          const r = await resolveReference(reference, resolveCtx);
          return r.resolved ? r.text : null;
        },
      },
      items,
    );
    items = items.map((it) => {
      const reuse = offers.get(it.id);
      return reuse === undefined ? it : { ...it, reuse };
    });
  }

  const slots = slotSchemaOf(workflow);
  const hub = mode.host === 'hub';
  const session = sessionOf(call);
  const record: RunRecord = RunRecord.parse({
    run: runId,
    pack: `${workflow.pack.id}@${workflow.pack.version}`,
    pack_digest: workflow.pack.digest,
    ...(target.product !== null ? { product: target.product.product.id } : {}),
    ...(target.line !== null ? { version: target.line } : {}),
    ...(target.buildName !== null ? { build: target.buildName } : {}),
    target_basis: target.basis,
    ...(target.root !== null ? { root: target.root.root } : {}),
    sources: [...bound.map((b) => b.binding), ...expected.sources],
    requirements: workflow.requirements.map(requirementSummary),
    items,
    ...(slots !== undefined ? { slots } : {}),
    instructions: workflow.instructions,
    instructions_digest: workflow.instructionsDigest,
    ...(predecessor !== null ? { predecessor: predecessor.body.run } : {}),
    ...(session !== null ? { session } : {}),
    started_at: startedAt,
    ...(hub ? { host: 'hub' as const, trigger: 'standing_obligation' as const, configurer: user.id } : { runner: user.id, host: 'local_circle' as const, trigger: 'session' as const }),
    parameters,
    ...(projection.groups.length > 0 ? { groups: projection.groups } : {}),
    ...(input.client_key !== undefined
      ? { client_key: input.client_key, request_digest: requestDigest, client_key_expires_at: new Date(at.getTime() + ctx.clientKeyWindowMs).toISOString() }
      : {}),
  } satisfies RunRecord);
  const subjectPath = `/inputs/${workflow.workflow.subject}`;
  const runTooLarge = tooLarge(ctx, record, `这个被判对象投影出 ${items.length} 个条目，运行记录`, subjectPath);
  if (runTooLarge !== null) throw runTooLarge;
  // A production result names the run record digest; it is computed and sized before anything is stored.
  const runDigest = runRecordDigest(record, startedAt);
  const production = isProduction(workflow) ? await evaluateProduction(ctx, record, runDigest, workflow, call.traceId) : null;
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
      expected_warnings: expected.warnings.slice(0, 100),
      handover,
    },
  });
  const result = production === null ? null : await keepProduction(ctx, stored, production, call);
  return { answer: { call_result: 'ok', errors: [], run: summaryOf(record) }, production: result };
}

/** The evaluation of a production run, made before its run record is stored (the result names the record's digest). */
async function evaluateProduction(ctx: EngineContext, run: RunRecord, runDigest: string, workflow: LoadedWorkflow, traceId: string): Promise<{ evaluation: Evaluation; startedAt: string }> {
  const startedAt = ctx.now().toISOString();
  const evaluation = await evaluate(ctx, {
    run,
    workflow,
    submission: null,
    submissionDigest: runDigest,
    exact: null,
    carried: new Map(),
    roundsUsed: new Map(),
    origin: null,
    author: null,
    traceId,
  });
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
    detail: { submission: stored.digest, session: sessionOf(call), model: null, repair: [], result: result.digest, production: true },
  });
  return { reference: recReference(result.digest), record: result.digest, result: result.body, counts: partitionCountsOf(result.body.partitions) };
}
