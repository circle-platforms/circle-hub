// start_run (W06): check the arguments, answer a repeated client key, authorize the pack, fix the target, bind the inputs,
// project the items, bind the expected sources, offer carry-overs, freeze everything in a run record and, for a pack whose
// requirements are all facts, compute the validation result at once (a production run; the same path serves runs the Hub
// executes for a standing obligation) and answer it as StartRunOutput.result. A client key repeated inside its window returns
// the same run and the same production result, even after the pack was unassigned (the run stays its runner's); other content
// under the same key is IDEMPOTENCY_MISMATCH. Arguments the records cannot hold are refused before anything is read, and
// nothing is stored that a record could not hold.
import { z } from 'zod';
import { isSourceRole, type SourceRole } from '../../../contracts/generated/vocabulary.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { ContextBuild, RequirementTemplate, RunContext } from '../../../contracts/src/pack.ts';
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
import { actionsOf, keyOwner, putAction, putResult, putRun, resultFor, runByClientKey, runById, runRecordDigest } from './store.ts';
import { resolveTarget } from './target.ts';
import { repairRounds } from './terminals.ts';
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
  host: 'local_circle' | 'hub';
}

/** A pack whose requirements are all facts needs no model input: start_run computes its result (production run). */
export function isProduction(workflow: LoadedWorkflow): boolean {
  return workflow.requirements.every((r) => r.accepted_producer === 'fact');
}

export function requirementSummary(t: RequirementTemplate): RequirementSummary {
  return { key: t.key, name: t.name, description: t.description, layers: t.layers, done_rule: t.done_rule, accepted_producer: t.accepted_producer, repair_rounds: repairRounds(t) };
}

/** The summary part of a run record, as start_run returns it (the frozen context extras — groups, builds — stay out). */
export function summaryOf(record: RunRecord): RunSummary {
  const { runner: _r, host: _h, trigger: _t, configurer: _c, parameters: _p, policy: _po, executors: _e, groups: _g, builds: _b, client_key: _k, request_digest: _d, client_key_expires_at: _x, leases: _l, lease_context: _lc, ...summary } = record;
  return RunSummary.parse(summary);
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The builds of the bound product for a workflow that asked (workflow.context): every build the knowledge base knows, both
 * name families, an alias carrying its base, sorted by (line, built_at, name); null when the workflow did not ask or the run
 * is bound to no product — absent then means "not asked", never an empty list.
 */
export async function contextBuilds(ctx: EngineContext, workflow: LoadedWorkflow, product: string | null): Promise<ContextBuild[] | null> {
  if (product === null || !(workflow.workflow.context ?? []).includes('builds')) return null;
  const known = await ctx.deps.knowledge.builds(product);
  return known
    .map((b) => ({ name: b.name, family: b.family, line: b.line, base: b.base, platform: b.platform, built_at: b.built_at, released_at: b.released_at, has_root: b.root !== null }))
    .sort((a, b) => compareText(a.line, b.line) || compareText(a.built_at ?? '', b.built_at ?? '') || compareText(a.name, b.name));
}

/** The frozen lease rows of the workflow's declared prefix (W06, D04 R[0]), for the run context; null when it did not ask. */
export async function contextLeases(ctx: EngineContext, workflow: LoadedWorkflow): Promise<Array<{ key: string; until: string }> | null> {
  if (!(workflow.workflow.context ?? []).includes('leases')) return null;
  if (ctx.deps.leases === undefined) throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', `任务包 ${workflow.pack.id} 声明了租约，但这个 Hub 没有配置租约服务`, { path: '/pack', fix: '请管理员配置租约服务' })]);
  const prefix = workflow.workflow.leases?.prefix ?? `${workflow.pack.id}/`;
  const view = await ctx.deps.leases.view(prefix);
  return view.entries;
}

/** Grants the projection's lease requests for the workflow's declared prefix and cap (C3); a refusal answers LEASE_*
 * with the earliest free moment. Returns the granted leases for the run record. */
export type LeaseRequest = { op?: 'acquire'; keys: string[]; ttl_seconds: number } | { op: 'extend'; keys: string[]; ttl_seconds: number } | { op: 'release'; keys: string[] };
export type LeaseDone = { op?: 'acquire'; lease: string; keys: string[]; until: string } | { op: 'extend'; lease: string; keys: string[]; until: string } | { op: 'release'; keys: string[]; until: string | null };

/** The run ids of this run's lineage: itself and up to 20 predecessors (D04 R[0]: a booking lease is held by the lineage). */
async function lineageOf(ctx: EngineContext, runId: string, predecessor: string | undefined): Promise<Set<string>> {
  const lineage = new Set<string>([runId]);
  let at: string | undefined = predecessor;
  for (let depth = 0; depth < 20 && at !== undefined; depth++) {
    lineage.add(at);
    const record = await runById(ctx.deps.records.store, at);
    at = record?.body.predecessor;
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
  const prefix = declared.prefix;
  const cap = declared.max_ttl_seconds;
  const now = ctx.now();
  const lineage = await lineageOf(ctx, runId, predecessor);
  // Phase 1 — every check, nothing touched: prefixes, TTL shapes, and for extend/release that this run's user is the
  // row's user and that the row's run sits in this run's lineage (D04 R[0]).
  const holderRows = await ctx.deps.leases.holders([...new Set(requests.flatMap((request) => request.keys))]);
  for (const request of requests) {
    const op = request.op ?? 'acquire';
    if (!request.keys.every((key) => key.startsWith(prefix))) {
      throw new Refusal([{ code: 'LEASE_PREFIX', message: `租约键（${request.keys.join('、')}）不在声明的前缀 ${prefix} 下`, fix: `键要以前缀 ${prefix} 开头` }]);
    }
    if (op === 'release') continue;
    if (!Number.isInteger((request as { ttl_seconds: number }).ttl_seconds) || (request as { ttl_seconds: number }).ttl_seconds <= 0 || (request as { ttl_seconds: number }).ttl_seconds > cap) {
      throw new Refusal([{ code: 'LEASE_TTL', message: `租约期限要在 1 到 ${cap} 秒之间`, fix: '缩短租约期限，或请任务包作者调高上限' }]);
    }
  }
  for (const request of requests) {
    const op = request.op ?? 'acquire';
    if (op === 'acquire') continue;
    for (const key of request.keys) {
      const row = holderRows.find((candidate) => candidate.key === key);
      if (row === undefined) {
        throw new Refusal([{ code: 'LEASE_UNAVAILABLE', message: `要${op === 'extend' ? '续期' : '释放'}的键 ${key} 上没有租约行`, fix: '先在预订运行里取得这个键' }]);
      }
      if (row.user !== user.id || !lineage.has(row.run)) {
        throw new Refusal([{ code: 'LEASE_UNAVAILABLE', message: `键 ${key} 的租约不在这次运行的血缘持有之下`, fix: '由预订那次运行（或它血缘里的运行，同一用户发起）来续期或释放' }]);
      }
      if (row.released || Date.parse(row.expires_at) <= now.getTime()) {
        throw new Refusal([{ code: 'LEASE_EXPIRED', message: `键 ${key} 的租约已${row.released ? '释放' : '过期'}`, fix: '重新取得租约并重新证明基线' }]);
      }
    }
  }
  // Phase 2 — execute: the extends and releases first (checked above; irreversible), then the acquires. A failing
  // acquire compensates the acquires already granted; a release or extend already done is never undone (README).
  const done: Array<LeaseDone> = [];
  const acquired: Array<{ keys: string[] }> = [];
  const releaseGranted = async (): Promise<void> => {
    const keys = acquired.flatMap((entry) => entry.keys);
    if (keys.length === 0) return;
    await ctx.deps!.leases!.release({ keys, holder: { user: user.id, run: runId } }).catch(() => undefined);
  };
  try {
    for (const request of requests) {
      if (request.op === 'extend') {
        const rows = holderRows.filter((row) => request.keys.includes(row.key));
        const holder = { user: rows[0]!.user, run: rows[0]!.run };
        const outcome = await ctx.deps.leases.extend({ keys: request.keys, holder, ttlSeconds: request.ttl_seconds, maxTtlSeconds: cap });
        if (!outcome.ok) {
          const message = outcome.code === 'LEASE_TTL' ? `续期（${request.keys.join('、')}）超过累计上限` : `续期（${request.keys.join('、')}）没有成功`;
          throw new Refusal([{ code: outcome.code, message, fix: outcome.code === 'LEASE_TTL' ? '缩短续期时长，或重新取得租约' : '稍后再试' }]);
        }
        done.push({ op: 'extend', lease: outcome.lease, keys: request.keys, until: outcome.until });
      }
    }
    for (const request of requests) {
      if (request.op === 'release') {
        const rows = holderRows.filter((row) => request.keys.includes(row.key));
        const holder = { user: rows[0]!.user, run: rows[0]!.run };
        const until = rows.reduce((max, row) => (row.expires_at > max ? row.expires_at : max), rows[0]!.expires_at);
        const outcome = await ctx.deps.leases.release({ keys: request.keys, holder });
        if (!outcome.ok) {
          throw new Refusal([{ code: outcome.code, message: `释放（${request.keys.join('、')}）没有成功`, fix: '键可能已被释放或过期，稍后再试' }]);
        }
        done.push({ op: 'release', keys: request.keys, until });
      }
    }
    for (const request of requests) {
      if (request.op !== 'release' && request.op !== 'extend') {
        let outcome: Awaited<ReturnType<typeof ctx.deps.leases.acquire>>;
        try {
          outcome = await ctx.deps.leases.acquire({ keys: request.keys, ttlSeconds: request.ttl_seconds, holder: { user: user.id, run: runId }, prefix, maxTtlSeconds: cap });
        } catch (error) {
          await releaseGranted();
          throw error;
        }
        if (!outcome.ok) {
          await releaseGranted();
          const when = 'earliestFree' in outcome && outcome.earliestFree !== undefined ? `，最早空闲时刻 ${outcome.earliestFree}` : '';
          const fix = outcome.code === 'LEASE_UNAVAILABLE' ? `等最早空闲时刻后再开始，或改用别的键${when}` : '缩短租约期限，或请任务包作者调高上限';
          throw new Refusal([{ code: outcome.code, message: `要取得的租约（${request.keys.join('、')}）没有拿到${outcome.code === 'LEASE_UNAVAILABLE' ? when : ''}`, fix }]);
        }
        acquired.push({ keys: outcome.keys });
        done.push({ lease: outcome.lease, keys: outcome.keys, until: outcome.until });
      }
    }
  } catch (error) {
    // Only the acquires are compensated: extends and releases are irreversible (the check phase ran them first).
    if (!(error instanceof Refusal)) await releaseGranted();
    else await releaseGranted();
    throw error;
  }
  return done;
}

const SPLIT_FIX = '把被判对象分块（每块分别开运行），按分块评审的做法逐块提交';

export function refused(errors: ProtocolError[]): StartRunDetail {
  return { answer: { call_result: 'error', errors }, production: null, runRecord: null, unavailable: [], gaps: [] };
}

/** At most this many expected-sources warnings are kept in the parse action and answered as gaps. */
const MAX_WARNINGS = 100;

/** The ok answer of a run: its summary and, for a production run, the result the Hub computed (StartRunOutput.result). */
function okAnswer(record: RunRecord, production: ProductionResult | null): StartRunAnswer {
  return { call_result: 'ok', errors: [], run: summaryOf(record), ...(production !== null ? { result: { reference: production.reference, counts: production.counts } } : {}) };
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
        const production = await productionOf(ctx, existing);
        return { answer: okAnswer(existing.body, production), production, runRecord: existing.digest, ...(await gapsOf(ctx, existing.body)) };
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
  const selectedBuild=target.buildName===null?undefined:(await ctx.deps.knowledge.builds(target.product!.product.id)).find(build=>build.name.normalize('NFC').toLowerCase()===target.buildName!.normalize('NFC').toLowerCase())?.name??target.buildName;

  const bound = await bindInputs(ctx, user, workflow, input.inputs, runId, call.traceId, target.root?.composition ?? null,selectedBuild);
  // The projection runs before any group exists; the expected sources and the checks see the frozen groups. The builds of
  // the bound product are known from the target and frozen with the run, so they are the same at projection and evaluation.
  const builds = await contextBuilds(ctx, workflow, target.product?.product.id ?? null);
  // The lease view is taken BEFORE the projection runs, so the projection sees real rows, none of them this run's own
  // acquisitions. Rows this run's lineage already holds (the holder run sits in the predecessor chain, same user; D04
  // R[0]) are marked `mine`, so an extend or release projection discovers the keys it may operate on (C6 item 5); a run
  // without a predecessor holds nothing yet and skips the lookup. The same view is frozen in the run record, so
  // replaying the projection from the record's context asks for the same keys again.
  const leaseRows = await contextLeases(ctx, workflow);
  let leaseLineageHolders = new Set<string>();
  if (leaseRows !== null && leaseRows.length > 0 && predecessor !== null && ctx.deps.leases !== undefined) {
    const lineage = await lineageOf(ctx, runId, predecessor.body.run);
    const holders = await ctx.deps.leases.holders(leaseRows.map((row) => row.key));
    leaseLineageHolders = new Set(holders.filter((row) => row.user === user.id && lineage.has(row.run)).map((row) => row.key));
  }
  const context: RunContext = {
    product: target.product?.product.id ?? null,
    names: target.product?.product.names ?? [],
    line: target.line,
    build: target.buildName,
    root: target.root?.root ?? null,
    parameters,
    groups: [],
    ...(builds !== null ? { builds } : {}),
    ...(leaseRows !== null ? { leases: { now: startedAt, entries: leaseRows.map((row) => ({ key: row.key, until: row.until, mine: leaseLineageHolders.has(row.key) })) } } : {}),
  };
  const projection = await projectItems(ctx, user, workflow, bound, parameters, context, call.traceId);
  const expected = await bindExpected(ctx, user, workflow, bound, projection.projected, parameters, { ...context, groups: projection.groups }, runId, call.traceId, target.root?.composition ?? null,selectedBuild);
  // The leases are granted after the projection asked for them and before anything is stored; every failure from here
  // on compensates by releasing what was granted (D04 R[0]: no lease outlives the run it was taken for).
  let grantedLeases: Array<LeaseDone> = [];
  try {
    grantedLeases = await grantLeases(ctx, user, workflow, projection.leaseRequests, runId, predecessor?.body.run);
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

  // The frozen rows carry `mine` for the rows held by this run's lineage (D04 R[0]): the projection of a successor
  // reads it to see which keys it may extend or release. (The view itself was taken before the projection.)
  const frozenLeaseRows: Array<{ key: string; until: string; mine: boolean }> | null =
    leaseRows === null
      ? null
      : leaseRows.map((row) => ({ ...row, mine: leaseLineageHolders.has(row.key) }));
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
    ...(builds !== null ? { builds } : {}),
    ...(input.client_key !== undefined
      ? { client_key: input.client_key, request_digest: requestDigest, client_key_expires_at: new Date(at.getTime() + ctx.clientKeyWindowMs).toISOString() }
      : {}),
    ...(grantedLeases.length > 0 ? { leases: grantedLeases } : {}),
    ...(frozenLeaseRows !== null ? { lease_context: frozenLeaseRows } : {}),
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
      expected_warnings: expected.warnings.slice(0, MAX_WARNINGS),
      handover,
    },
  });
  const result = production === null ? null : await keepProduction(ctx, stored, production, call);
  return {
    answer: okAnswer(record, result),
    production: result,
    runRecord: stored.digest,
    unavailable: expected.unavailable.map(({ external, role }) => ({ external, role })),
    // A run without items says so in the answer and carries the projection's notes; with items the projection warnings stay in the parse action.
    gaps: gapsFrom([...(items.length === 0 ? [EMPTY_ITEMS_NOTE, ...projection.warnings] : []), ...expected.warnings]),
  };
  } catch (error) {
    // The granted leases of a start that did not store its run are released at once (compensation): an acquire that
    // refused throws before anything was granted, so only a real failure reaches here with rows held.
    const acquiredKeys = grantedLeases.filter((entry) => entry.op !== 'extend' && entry.op !== 'release').flatMap((entry) => entry.keys);
    if (acquiredKeys.length > 0 && ctx.deps.leases !== undefined) {
      await ctx.deps.leases.release({ keys: acquiredKeys, holder: { user: user.id, run: runId } }).catch(() => undefined);
    }
    throw error;
  }
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
