import { isAdmin, type ActionBody, type Principal } from '../records/api.ts';
import type { RemoteLease, Heartbeat } from './session-types.ts';
import { at, type ExecutorDefinition } from './definition.ts';
import { type RegisteredExecutor } from './executors.ts';
import { digestOfValue, newJob, type JobBinding } from './journal.ts';
import { RpcClient, ToolReplyError, type Exchange } from './transport.ts';
import { probeValues, type SeatEcho } from './probes.ts';
import { BOOKING_PROBE_KEY, bookingProbeKey, leaseGeneration } from './probe-replay.ts';
import { DeviceObservation, type DeviceHelpPosition, type DeviceHelpResult, type DeviceHelpTarget, type DeviceReadAnswer, type DeviceReadResult, type DeviceReadTarget } from '../../contracts/src/pack.ts';
import { capText, checkLine, readAnswer, type AskedLine } from './help.ts';
import { checkReadLine, readOutput } from './read-line.ts';
import { canRetryRead } from './read-policy.ts';
import type { DispatchService } from './service.ts';
import { environmentOf } from './precheck-context.ts';

const OBSERVATION_KEY = 'dispatch.device_observation';
type AdminLogEntry = Parameters<NonNullable<DispatchService['options']['adminLog']>>[0];
type Probes = NonNullable<ExecutorDefinition['probes']>;
type Seat = Probes['seats'][number];

export interface LeaseSessionContext {
  assertNoSecrets(value: unknown): Promise<void>;
  secret(binding: JobBinding, d: ExecutorDefinition): Promise<string | null>;
  session(binding: JobBinding, d: ExecutorDefinition, secret: string): RpcClient;
  acquire(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>): Promise<RemoteLease>;
  context(binding: JobBinding): Record<string, unknown>;
  heartbeat(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, lease: RemoteLease): Heartbeat;
  release(binding: JobBinding, client: RpcClient, lease: RemoteLease): Promise<void>;
}

interface DeviceContext extends Pick<DispatchService, 'now' | 'options' | 'registry' | 'recordObservation' | 'activeLeaseJobs' | 'journal' | 'sleep'>, LeaseSessionContext {
  observeSeats(by: Principal, run: string, registered: RegisteredExecutor, seats: Probes['seats'], targets: ReadonlyMap<string, { label: string }>): Promise<DeviceObservation[]>;
  askDevice(by: Principal, run: string, target: DeviceHelpTarget): Promise<DeviceHelpResult>;
  queued<T>(executor: string, work: () => Promise<T>): Promise<T>;
  askSeat(by: Principal, run: string, registered: RegisteredExecutor, seat: Seat, target: DeviceHelpTarget, asked: AskedLine): Promise<DeviceHelpResult>;
  readDevice(by: Principal, run: string, target: DeviceReadTarget): Promise<DeviceReadResult>;
  readSeat(by: Principal, run: string, registered: RegisteredExecutor, seat: Seat, target: DeviceReadTarget, line: string): Promise<DeviceReadResult>;
  certified(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, premise: keyof ExecutorDefinition['premises'],delivery?:{version:unknown}): Promise<boolean>;
  saveText(binding: JobBinding, source: string, text: string, name: string): ReturnType<DispatchService['options']['records']['artifacts']['ingest']>;
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

export function probeBinding(by: Principal, registered: RegisteredExecutor): JobBinding {
  const d = registered.definition;
  return {
    job: newJob(), initiated_by: by.id, executor: registered.id, executor_digest: registered.resolved_digest, executor_source_digest: registered.digest, variables: registered.variables,
    scope: { target: d.target, origin: new URL(d.endpoint).origin }, target_key: digestOfValue([...d.resources].sort()), input: null, user: by.id, resources: [],
    context: { ...environmentOf(d.precheck_context), target: d.target, ...(d.resources.length ? { seats: d.resources.length } : {}), ...(d.manifest_sha256 ? { manifest_sha256: d.manifest_sha256 } : {}) },
  };
}

/** `leased` takes the gateway lease, so a check can run on the connected session before it. */
export async function withLease<T>(ctx: LeaseSessionContext, binding: JobBinding, d: ExecutorDefinition, work: (client: RpcClient, leased: () => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  await ctx.assertNoSecrets(binding);
  const material = await ctx.secret(binding, d);
  if (material === null) throw new Error('执行器凭据不可用');
  const client = ctx.session(binding, d, material);
  let lease: RemoteLease | undefined;
  let stop = async () => {};
  try {
    await client.connect();
    return await work(client, async () => {
      lease = await ctx.acquire(binding, d, client, ctx.context(binding));
      stop = ctx.heartbeat(binding, d, client, lease).stop;
      return { ...ctx.context(binding), lease_id: lease.id, lease_token: lease.token };
    });
  } finally {
    await stop();
    if (lease) await ctx.release(binding, client, lease);
  }
}

interface Asking { verb: '问' | '读'; sending: string; what: 'device_help' | 'device_read' }
const HELP: Asking = { verb: '问', sending: '往它的终端里打字', what: 'device_help' };
const READ: Asking = { verb: '读', sending: '往它发命令', what: 'device_read' };

async function seatFor(ctx: DeviceContext, target: { inventory: string; device: string }, declares: (probes: Probes) => boolean, undeclared: (executor: string) => string): Promise<{ registered: RegisteredExecutor; seat: Seat } | { covered: string }> {
  let covered = '没有绑定同一份清单、指向这台设备的执行器版本探针';
  for (const registered of await ctx.registry.probed()) {
    const d = registered.definition;
    const seat = d.manifest_sha256 === target.inventory ? d.probes!.seats.find((s) => s.manifest.device === target.device) : undefined;
    if (seat === undefined) continue;
    if (!declares(d.probes!)) { covered = undeclared(registered.id); continue; }
    return { registered, seat };
  }
  return { covered };
}

async function whenIdle<R>(ctx: DeviceContext, run: string, registered: RegisteredExecutor, keys: readonly string[], asking: Asking, nothing: (fact: string, next_action: string) => R, work: () => Promise<R>): Promise<R> {
  const outside = keys.filter((key) => !registered.definition.resources.includes(key));
  if (outside.length) return nothing(`任务包给的租约键 ${outside.join('、')} 不在执行器 ${registered.id} 管的资源里`, `管理员核对任务包的租约键和执行器的资源键是不是同一批；做完以前这台设备${asking.verb}不了`);
  let busy: Array<{ key: string; job: string }>;
  try { busy = await ctx.activeLeaseJobs(keys); }
  catch { return nothing(`读不到这台设备上作业的状态，所以不${asking.sending}`, `管理员核对作业登记后再${asking.verb}`); }
  if (busy.length) return nothing(`设备上还有作业没有结束（${[...new Set(busy.map((b) => b.job))].join('、')}），现在不${asking.sending}`, `等这些作业结束，或让管理员用 job status 核对、用 job dispose 处置后再${asking.verb}`);
  try { return await ctx.queued(registered.id, work); }
  catch (error) {
    ctx.options.adminLog?.({ traceId: null, run, what: asking.what, detail: `executor ${registered.id}: ${describe(error)}`.slice(0, 1000) } as AdminLogEntry);
    return nothing('这次没能连上设备（原因在管理员记录里）', `稍后再${asking.verb}一次；连续出现时请管理员检查执行器的连接、凭据和租约`);
  }
}

interface Retry { phase: string; detail: Record<string, unknown>; again: string; stop: string; what: Asking['what'] }
async function readWithRetries(ctx: DeviceContext, binding: JobBinding, run: string, registered: RegisteredExecutor, seat: Seat, context: Record<string, unknown>, read: () => Promise<Exchange>, retry: Retry): Promise<{ response?: Exchange; failure?: 'refused' | 'unusable' }> {
  const d = registered.definition;
  let failedSource: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return { response: await read() }; }
    catch (error) {
      const again = canRetryRead(error, d, context);
      if (error instanceof ToolReplyError) failedSource = error.source;
      await ctx.journal.append(binding, retry.phase, 'read', 'error', { ...retry.detail, attempt, next_action: again && attempt < 3 ? retry.again : retry.stop }, failedSource ? [failedSource] : []);
      if (!again) {
        ctx.options.adminLog?.({ traceId: null, run, what: retry.what, detail: `executor ${registered.id} seat ${seat.seat}: ${describe(error)}`.slice(0, 1000) } as AdminLogEntry);
        return { failure: error instanceof ToolReplyError ? 'refused' : 'unusable' };
      }
      if (attempt < 3) await ctx.sleep(d.poll_ms);
    }
  }
  return {};
}

interface Kept { text: string | null; truncated: boolean; withheld: boolean; reference: string | null; unstored: string | null }
async function keepText(ctx: DeviceContext, binding: JobBinding, run: string, source: string, text: string | null, name: string, max: number | undefined, unstored: string, what: Asking['what']): Promise<Kept> {
  const kept: Kept = { text: null, truncated: false, withheld: false, reference: null, unstored: null };
  if (text === null) return kept;
  try {
    const { body } = await ctx.saveText(binding, source, text, name);
    kept.reference = `src:${body.sha256}`;
    if (body.read_tier === 'retain_only') kept.withheld = true;
    else ({ text: kept.text, truncated: kept.truncated } = capText(text, max));
  } catch (error) {
    kept.unstored = unstored;
    ctx.options.adminLog?.({ traceId: null, run, what, detail: `${name} could not be stored: ${describe(error)}`.slice(0, 1000) } as AdminLogEntry);
  }
  return kept;
}

export interface ObservationInput extends SeatEcho {
  inventory: string; run: string | null; job: string | null; executor: string; product: unknown;
  booking?: { executorDigest: string; version: string; leases: string };
}

export async function recordObservation(this: DeviceContext, input: ObservationInput): Promise<DeviceObservation> {
    const now = this.now().toISOString();
    const build = input.values.length === 1 ? input.values[0]! : null;
    const known = build !== null && typeof input.product === 'string' && this.options.knowledge ? await this.options.knowledge.resolveBuild(input.product, build).catch(() => null) : null;
    const observation = DeviceObservation.parse({
      inventory: input.inventory, device: input.device, label: input.label, build, base: known?.base ?? null, values: input.values.slice(0, 20), observed_at: now, run: input.run, job: input.job, reference: input.reference,
      ...(build === null ? { note: input.values.length > 1 ? `版本探针抽到 ${input.values.length} 个值，不是唯一的一个` : '版本探针的回显里没有抽到构建' } : {}),
    });
    await this.options.records.store.put<ActionBody>({
      kind: 'action', schema: 'action@1', provenance: 'observed', created_at: now,
      body: { action: 'validate', run: input.run, item: null, inputs: [input.reference], component: 'dispatch@1', lease: null, started_at: now, ended_at: now, result: 'completed', error_code: null, acceptance: null, codes: [], detail: { phase: 'device_observation', executor: input.executor, observation,
        ...(input.booking ? { executor_digest: input.booking.executorDigest, probe_references: { version: input.booking.version }, lease_generation: input.booking.leases } : {}) } },
      index: [{ key: OBSERVATION_KEY, value: `${input.inventory}#${input.device}` }, { key: 'dispatch.phase', value: 'device_observation' },
        ...(input.run !== null && input.booking ? [{ key: BOOKING_PROBE_KEY, value: bookingProbeKey(input.run, input.executor, input.inventory, input.device) }] : [])],
    });
    return observation;
  }

export async function latestDeviceObservations(this: DeviceContext): Promise<DeviceObservation[]> {
    const out: DeviceObservation[] = [];
    for (const registered of await this.registry.probed()) {
      const d = registered.definition;
      for (const seat of d.probes!.seats) {
        const found = (await this.options.records.store.find<ActionBody>({ kind: 'action', key: OBSERVATION_KEY, value: `${d.manifest_sha256}#${seat.manifest.device}`, limit: 1, newestFirst: true })).items[0];
        const parsed = DeviceObservation.safeParse((found?.body.detail as { observation?: unknown } | undefined)?.observation);
        if (parsed.success) out.push(parsed.data);
      }
    }
    return out;
  }

export async function observeDevices(this: DeviceContext, by: Principal, run: string, targets: ReadonlyArray<{ inventory: string; device: string; label: string }>): Promise<{ observed: DeviceObservation[]; missing: string | null }> {
    const pending = new Map(targets.map((t) => [`${t.inventory}#${t.device}`, t]));
    const observed: DeviceObservation[] = [];
    const problems: string[] = [];
    for (const registered of await this.registry.probed()) {
      const d = registered.definition;
      const seats = d.probes!.seats.filter((seat) => pending.has(`${d.manifest_sha256}#${seat.manifest.device}`));
      if (!seats.length) continue;
      try {
        for (const o of await this.observeSeats(by, run, registered, seats, pending)) observed.push(o);
      } catch (error) {
        this.options.adminLog?.({ traceId: null, run, what: 'device_observation', detail: `executor ${registered.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000) } as AdminLogEntry);
        problems.push(`执行器 ${registered.id} 这次没能连上设备（原因在管理员记录里）`);
      }
      for (const seat of seats) pending.delete(`${d.manifest_sha256}#${seat.manifest.device}`);
    }
    const uncovered = [...pending.values()].map((t) => t.label);
    if (uncovered.length) {
      problems.push(`${uncovered.join('、')} 共 ${uncovered.length} 台不接收命令，未读取构建版本`);
    }
    return { observed, missing: problems.length ? problems.join('；') : null };
  }

export async function observeSeats(this: DeviceContext, by: Principal, run: string, registered: RegisteredExecutor, seats: Probes['seats'], targets: ReadonlyMap<string, { label: string }>): Promise<DeviceObservation[]> {
    const d = registered.definition;
    return withLease(this, probeBinding(by, registered), d, async (client, leased) => {
      const context = await leased();
      const out: DeviceObservation[] = [];
      const leases = await this.options.leases.holderSnapshot(d.resources).then(leaseGeneration, () => null);
      for (const seat of seats) {
        const response = await client.declaredRead(d.probes!.call, { ...context, command: seat.version.command, seat_index: seat.index }, `observe.${seat.index}.version`);
        const label = targets.get(`${d.manifest_sha256}#${seat.manifest.device}`)?.label ?? seat.seat;
        out.push(await this.recordObservation({ inventory: d.manifest_sha256!, device: seat.manifest.device, label, values: probeValues(at(response.value, d.probes!.output), seat.version.pattern), reference: response.source, run, job: null, executor: registered.id, product: d.precheck_context?.product, ...(leases === null ? {} : { booking: { executorDigest: registered.resolved_digest, version: response.source, leases } }) }));
      }
      return out;
    });
  }

export async function askDevices(this: DeviceContext, by: Principal, run: string, targets: ReadonlyArray<DeviceHelpTarget>): Promise<DeviceHelpResult[]> {
    const out: DeviceHelpResult[] = [];
    for (const target of targets) out.push(await this.askDevice(by, run, target));
    return out;
  }

export async function askDevice(this: DeviceContext, by: Principal, run: string, target: DeviceHelpTarget): Promise<DeviceHelpResult> {
    const nothing = (fact: string, next_action: string): DeviceHelpResult => ({ inventory: target.inventory, device: target.device, label: target.label, line: target.line, mode: target.mode ?? null, words: 0, positions: [], missing: { fact: `${target.label}：${fact}`, next_action } });
    const found = await seatFor(this, target, (probes) => probes.help !== undefined, (executor) => `执行器 ${executor} 管着这台设备，但没有声明问位置的调用`);
    if ('covered' in found) return nothing(found.covered, '管理员要给绑定这份清单的执行器登记问位置的调用（probes.help），并认证它只读（premises.read_only）；做完以前这台设备问不了');
    const checked = checkLine(target.line, target.mode, found.registered.definition.probes!.help!);
    if (!checked.ok) return nothing(checked.fact, checked.next_action);
    return whenIdle(this, run, found.registered, target.keys, HELP, nothing, () => this.askSeat(by, run, found.registered, found.seat, target, checked.asked));
  }

export async function askSeat(this: DeviceContext, by: Principal, run: string, registered: RegisteredExecutor, seat: Seat, target: DeviceHelpTarget, asked: AskedLine): Promise<DeviceHelpResult> {
    const d = registered.definition; const spec = d.probes!.help!;
    const binding = probeBinding(by, registered);
    const result = (positions: DeviceHelpPosition[], missing: DeviceHelpResult['missing']): DeviceHelpResult => ({ inventory: target.inventory, device: target.device, label: target.label, line: asked.line, mode: target.mode ?? null, words: asked.words, positions, missing });
    return withLease(this, binding, d, async (client, leased) => {
      const admin = (await this.options.records.principals.list()).find((p) => isAdmin(p) && !p.disabled);
      if (admin === undefined || !(await this.certified({ ...binding, acting_by: admin.id }, d, client, 'read_only'))) {
        return result([], { fact: `执行器 ${registered.id} 的目标这个版本（${client.serverVersion ?? '没有报版本'}）没有认证“问位置不按回车、输入行总是清掉”（premises.read_only），所以没有往设备发任何字`, next_action: '管理员核对目标这一版的问位置工具，把版本和证据登记到执行器的 premises.read_only 后再问' });
      }
      const context = await leased();
      const positions: DeviceHelpPosition[] = [];
      let missing: DeviceHelpResult['missing'] = null;
      for (const prefix of asked.prefixes) {
        const { response, failure } = await readWithRetries(this, binding, run, registered, seat, context,
          () => client.declaredRead(spec.call, { ...context, line: prefix.text, seat_index: seat.index, ...(target.mode === undefined ? {} : { mode: target.mode }) }, `help.${seat.index}.${prefix.words}`),
          { phase: 'help.retry', detail: { seat: seat.seat, words: prefix.words }, again: '自动重读这个位置，不按回车', stop: '目标明确拒绝，或原件无法保存、调用声明不合目标公开的参数；不再往下问', what: 'device_help' });
        if (response === undefined) {
          missing = failure === 'refused'
            ? { fact: `目标拒绝了对“${prefix.text}”的这一问（原件已保存，管理员能读），不再往下问`, next_action: '管理员读受限原件，核对问位置的声明和目标的权限；写手可以改写这一行再问' }
            : failure === 'unusable'
              ? { fact: `对“${prefix.text}”的这一问没有完成（应答不完整、不能保存，或调用声明不合目标公开的参数；原因在管理员记录里），不再往下问`, next_action: '管理员核对受限原件、问位置的调用声明和本地存储后再问' }
              : { fact: `对“${prefix.text}”的这一问连续三次没有取得完整应答，不再往下问`, next_action: '稍后再问一次；连续出现时请管理员检查执行器的连接' };
          break;
        }
        const reading = readAnswer(spec, response.value);
        const observed_at = response.received_at;
        if (!reading.ok) {
          await this.journal.append(binding, 'device_help', 'read', 'error', { seat: seat.seat, words: prefix.words, asked: prefix.text, anomaly: reading.why }, [response.source]);
          this.options.adminLog?.({ traceId: null, run, what: 'device_help', detail: `executor ${registered.id} seat ${seat.seat}: ${reading.why}` } as AdminLogEntry);
          positions.push({ prefix: prefix.text, words: prefix.words, next_word: prefix.next_word, described: false, caret_only: null, text: null, truncated: false, withheld: false, anomaly: reading.why, observed_at, reference: response.source, text_reference: null });
          missing = { fact: `对“${prefix.text}”的应答没有确认“没有按回车、输入行已清掉”，所以不呈现它的内容，也不再往下问`, next_action: '管理员核对这个座位终端上的输入行和网关记录，确认干净、并核对目标这一版的认证后再问' };
          break;
        }
        const kept = await keepText(this, binding, run, response.source, reading.text, 'device-help.txt', undefined, '设备说明的文本原件没有存下来', 'device_help');
        positions.push({ prefix: prefix.text, words: prefix.words, next_word: prefix.next_word, described: reading.text !== null, caret_only: reading.caret_only, text: kept.text, truncated: kept.truncated, withheld: kept.withheld, anomaly: kept.unstored, observed_at, reference: response.source, text_reference: kept.reference });
        await this.journal.append(binding, 'device_help', 'read', kept.unstored === null ? 'completed' : 'error', { seat: seat.seat, words: prefix.words, asked: prefix.text, described: reading.text !== null, caret_only: reading.caret_only, withheld: kept.withheld, truncated: kept.truncated, ...(kept.unstored === null ? {} : { anomaly: kept.unstored }) }, [response.source, ...(kept.reference === null ? [] : [kept.reference])]);
        if (kept.unstored !== null) {
          missing = { fact: `对“${prefix.text}”的说明没能存成原件，所以不呈现，也不再往下问`, next_action: '管理员检查本地存储后再问' };
          break;
        }
        if (reading.text !== null) break;
      }
      if (missing === null && positions.length > 0 && !positions.some((p) => p.described) && positions.length < asked.words) {
        missing = { fact: `只问了最长的 ${positions.length} 个前缀（执行器声明的上限），都没有得到说明；更短的前缀没有问，不能说设备什么都不接受`, next_action: '把这一行截短后再问' };
      }
      return result(positions, missing);
    });
  }

export async function readDevices(this: DeviceContext, by: Principal, run: string, targets: ReadonlyArray<DeviceReadTarget>): Promise<DeviceReadResult[]> {
    const out: DeviceReadResult[] = [];
    for (const target of targets) out.push(await this.readDevice(by, run, target));
    return out;
  }

export async function readDevice(this: DeviceContext, by: Principal, run: string, target: DeviceReadTarget): Promise<DeviceReadResult> {
    const nothing = (fact: string, next_action: string): DeviceReadResult => ({ inventory: target.inventory, device: target.device, label: target.label, line: target.line, sent: false, answer: null, missing: { fact: `${target.label}：${fact}`, next_action } });
    const found = await seatFor(this, target, (probes) => probes.read !== undefined, (executor) => `执行器 ${executor} 管着这台设备，但这台执行器没有声明可以按请求读设备`);
    if ('covered' in found) return nothing(found.covered, '管理员用 executor update 给绑定这份清单的执行器加上按请求读设备的声明（probes.read）；做完以前这台设备读不了');
    const checked = checkReadLine(target.line, found.registered.definition.probes!.command_pattern);
    if (!checked.ok) return nothing(checked.fact, checked.next_action);
    return whenIdle(this, run, found.registered, target.keys, READ, nothing, () => this.readSeat(by, run, found.registered, found.seat, target, checked.line));
  }

export async function readSeat(this: DeviceContext, by: Principal, run: string, registered: RegisteredExecutor, seat: Seat, target: DeviceReadTarget, line: string): Promise<DeviceReadResult> {
    const d = registered.definition; const probes = d.probes!; const spec = probes.read!;
    const binding = probeBinding(by, registered);
    const result = (answer: DeviceReadAnswer | null, missing: DeviceReadResult['missing']): DeviceReadResult => ({ inventory: target.inventory, device: target.device, label: target.label, line, sent: true, answer, missing });
    return withLease(this, binding, d, async (client, leased) => {
      const context = await leased();
      const { response, failure } = await readWithRetries(this, binding, run, registered, seat, context,
        () => client.declaredRead(probes.call, { ...context, command: line, seat_index: seat.index }, `device_read.${seat.index}`),
        { phase: 'device_read.retry', detail: { seat: seat.seat, line }, again: '自动重读这一行', stop: '目标明确拒绝，或原件无法保存、调用声明不合目标公开的参数；不再读', what: 'device_read' });
      if (response === undefined) {
        return result(null, failure === 'refused'
          ? { fact: `目标拒绝了“${line}”这一读（原件已保存，管理员能读）`, next_action: '管理员读受限原件，核对命令形状的声明和目标的权限；写手可以改写这一行再读' }
          : failure === 'unusable'
            ? { fact: `“${line}”这一读没有完成（应答不完整、不能保存，或调用声明不合目标公开的参数；原因在管理员记录里）`, next_action: '管理员核对受限原件、逐台探测的调用声明和本地存储后再读' }
            : { fact: `“${line}”这一读连续三次没有取得完整应答`, next_action: '稍后再读一次；连续出现时请管理员检查执行器的连接' });
      }
      const reading = readOutput(response.value, probes.output);
      const observed_at = response.received_at;
      if (!reading.ok) {
        await this.journal.append(binding, 'device_read', 'read', 'error', { seat: seat.seat, line, anomaly: reading.why }, [response.source]);
        this.options.adminLog?.({ traceId: null, run, what: 'device_read', detail: `executor ${registered.id} seat ${seat.seat}: ${reading.why}` } as AdminLogEntry);
        return result({ has_output: false, output: null, truncated: false, withheld: false, anomaly: reading.why, observed_at, reference: response.source, text_reference: null },
          { fact: `“${line}”的应答在声明的位置上不是文字，所以不呈现它的内容`, next_action: '管理员读受限原件，核对执行器声明的输出位置（probes.output）后再读' });
      }
      const kept = await keepText(this, binding, run, response.source, reading.text, 'device-read.txt', spec.max_chars, '设备输出的文本原件没有存下来', 'device_read');
      await this.journal.append(binding, 'device_read', 'read', kept.unstored === null ? 'completed' : 'error', { seat: seat.seat, line, has_output: reading.text !== null, withheld: kept.withheld, truncated: kept.truncated, ...(kept.unstored === null ? {} : { anomaly: kept.unstored }) }, [response.source, ...(kept.reference === null ? [] : [kept.reference])]);
      return result({ has_output: reading.text !== null, output: kept.text, truncated: kept.truncated, withheld: kept.withheld, anomaly: kept.unstored, observed_at, reference: response.source, text_reference: kept.reference },
        kept.unstored === null ? null : { fact: `“${line}”的输出没能存成原件，所以不呈现`, next_action: '管理员检查本地存储后再读' });
    });
  }
