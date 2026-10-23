import { canonicalBytes, canonicalize, sha256Hex, type Principal, type RecordsKit } from '../records/api.ts';
import type { LeaseService, HolderSnapshot } from '../leases/api.ts';
import type { WorkflowStore } from '../ports.ts';
import type { EffectOutcome } from '../../contracts/generated/vocabulary.ts';
import { at, bind, type CallRole, type ExecutorDefinition } from './definition.ts';
import { ExecutorRegistry } from './executors.ts';
import { Journal, digestOfValue, eventOf, isDone, isFrozen, newJob, type JobBinding, type Event } from './journal.ts';
import { RpcClient, object, type Exchange } from './transport.ts';
import { verifyInput, type VerificationPort } from './proof.ts';
export interface DispatchOptions {
  records: RecordsKit; leases: Pick<LeaseService, 'holderSnapshot'>; runs: VerificationPort;
  workflows: Pick<WorkflowStore, 'byDigest'>; now?: () => Date; sleep?: (ms: number) => Promise<void>;
}
export interface JobStatus { job: string; phase: string; outcome: EffectOutcome; frozen: boolean; result?: string; events: number; next_action?: string; }
interface RemoteLease { id: unknown; token: unknown; ttl: number; }
const same = (a: unknown, b: unknown) => canonicalize(a ?? null) === canonicalize(b ?? null);
export class DispatchService {
  readonly options: DispatchOptions;
  readonly registry: ExecutorRegistry;
  readonly journal: Journal;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  constructor(options: DispatchOptions) {
    this.options = options; this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.registry = new ExecutorRegistry(options.records); this.journal = new Journal(options.records, this.now);
  }
  async status(by: Principal, job: string): Promise<JobStatus> {
    await this.registry.admin(by); const events = await this.journal.events(job);
    if (!events.length) throw new Error('作业对你不可用');
    const unknown = isFrozen(events); const result = eventOf(events, 'result'); const end = eventOf(events, 'complete');
    const intent = eventOf(events, 'intent'); const receipt = eventOf(events, 'receipt');
    return { job, phase: String(events.at(-1)!.body.detail.phase),
      outcome: unknown || (intent && !receipt) ? 'unknown' : end?.body.detail.outcome === 'not_dispatched' ? 'not_dispatched' : end ? 'effective' : intent ? 'issued' : 'not_dispatched',
      frozen: unknown || (!!intent && !receipt), ...(typeof result?.body.detail.reference === 'string' ? { result: result.body.detail.reference } : {}), events: events.length,
      ...(unknown || (intent && !receipt) ? { next_action: `请管理员取证后运行 circle-hub job dispose ${job} --reconcile <远端作业编号>；不能重交` } : !end ? { next_action: `circle-hub job resume ${job}` } : {}) };
  }
  async dispatch(by: Principal, run: string, executor: string): Promise<JobStatus> {
    await this.registry.admin(by);
    const registered = await this.registry.get(executor);
    if (!registered?.definition.enabled) throw new Error('执行器不可用或已禁用');
    const d = registered.definition;
    const input = await verifyInput(by, run, d, this.options.records, this.options.runs, this.options.workflows, this.now());
    const previous = await this.options.records.store.getByKey('action', `dispatch.bytes:${input.sha256}`);
    if (previous) throw new Error('这份字节已有派发意图；只能查询或对账，不能重交');
    const source = await this.options.records.artifacts.source({ id: input.user, name: '', role: 'user' }, input.sha256, { consumer: 'function' });
    if (!source?.bytes) throw new Error('核验字节不可读取，未提交');
    const initial = await this.holders(input.ancestors, input.user, d.resources, d.max_run_ms);
    const secret = await this.secret(executor);
    const binding: JobBinding = { job: newJob(), executor, executor_digest: registered.digest, input, user: input.user, resources: d.resources, fences: initial, target_key: digestOfValue([...d.resources].sort()) };
    if (JSON.stringify(binding).includes(secret)) throw new Error('绑定元数据不能包含执行器密钥');
    await this.reserve(binding);
    const session = this.session(binding, d, secret);
    let remote: RemoteLease | undefined; let stop = async () => {};
    let intended = false;
    try {
      await session.connect();
      remote = await this.acquire(binding, d, session, this.context(binding));
      stop = this.heartbeat(binding, d, session, remote);
      const context: Record<string, unknown> = { ...this.context(binding), lease_id: remote.id, lease_token: remote.token, payload_base64: Buffer.from(source.bytes).toString('base64') };
      const precheck = await this.read(binding, session, 'precheck', context);
      if (!this.conditions(d, precheck.value, context)) throw new Error('只读核对未满足；未提交，请核对当前环境后重新核验');
      const latest = await this.registry.get(executor);
      if (!latest?.definition.enabled || latest.digest !== registered.digest) throw new Error('执行器配置已变；未提交，请按当前配置重新核验');
      const fresh = await this.holders(input.ancestors, input.user, d.resources, d.max_run_ms);
      if (!this.sameFences(initial, fresh)) throw new Error('派发前围栏已变；未提交，请重新证明基线');
      const notAfter = new Date(this.now().getTime() + d.submit_timeout_ms + d.max_run_ms).toISOString();
      const sequence = (await this.options.records.store.findMany({ kind: 'action', key: 'dispatch.lineage', values: [input.lineage] })).filter(e => (e.body as Record<string, unknown>)?.detail && ((e.body as { detail: Record<string, unknown> }).detail.phase === 'intent')).length + 1;
      const key = digestOfValue([input.lineage, input.item, d.proof.requirement, sequence]);
      context.request_id = `${key}:1`; context.not_after = notAfter;
      const actionDigest = digestOfValue({ content: input.sha256, tool: d.calls.submit.tool, arguments: bind(d.calls.submit.arguments, context) });
      await this.options.records.store.withTransaction(async tx => {
        const gate = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: true }, [], `dispatch.gate:${binding.job}`, tx);
        if (!gate.created) throw new Error('作业已经恢复或关闭，不能再提交');
        const ordinal = await this.journal.append(binding, 'sequence', 'validate', 'completed', { sequence }, [], `dispatch.sequence:${input.lineage}:${sequence}`, tx);
        if (!ordinal.created) throw new Error('血缘次序已由另一派发占用；未提交');
        const intent = await this.journal.append(binding, 'intent', 'dispatch', 'completed', { intent_key: key, request_id: context.request_id, not_after: notAfter, sequence, action_digest: actionDigest,
          dispatch_binding_digest: digestOfValue([input.run, input.item, input.sha256, fresh, remote]), target_key: binding.target_key, effect_class: 'job', retry_safety: 'unsafe', signing: 'service_on_behalf', on_behalf_of: input.user,
          before_state_bound: false, fences: fresh, remote_lease: remote, window: { from: this.now().toISOString(), to: notAfter } }, [`src:${input.sha256}`, `rec:${input.result}`], `dispatch.bytes:${input.sha256}`, tx);
        if (!intent.created) throw new Error('这份字节已经写过意图；未重复提交');
      });
      intended = true;
      if (!this.sameFences(fresh, await this.options.leases.holderSnapshot(d.resources))) { await this.unknown(binding, '意图后围栏漂移；未继续提交'); return await this.status(by, binding.job); }
      // Signals must not cancel an in-flight effect; SIGKILL is recovered from the already committed intent.
      const ignore = () => {}; process.on('SIGINT', ignore); process.on('SIGTERM', ignore);
      let answer: Exchange;
      try { answer = await session.call('submit', context); } finally { process.off('SIGINT', ignore); process.off('SIGTERM', ignore); }
      const accepted = d.receipt.map[String(at(answer.value, d.receipt.acceptance))] === 'accepted';
      const remoteId = at(answer.value, d.receipt.id);
      if (!accepted || (typeof remoteId !== 'string' && typeof remoteId !== 'number') || !String(remoteId) || at(answer.value, d.receipt.sha256) !== input.sha256 || !same(at(answer.value, d.receipt.items), input.items)) {
        await this.unknown(binding, '提交回执拒绝、缺身份或内容不符；缺拒绝阶段不能当作未执行', [answer.source]);
        return await this.status(by, binding.job);
      }
      await this.journal.append(binding, 'receipt', 'read', 'completed', { remote_id: remoteId, acceptance: 'accepted', outcome: 'issued' }, [answer.source]);
      return await this.observe(by, binding, d, session, remoteId, fresh);
    } catch (error) {
      if (intended) await this.unknown(binding, '提交未取得完整可信回执；缺远端作业身份或结果，必须管理员对账');
      else {
        await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', reason: session.redact(error instanceof Error ? error.message.toWellFormed().slice(0, 1000) : '前提核对出错'), next_action: '核对只读条件、租约和执行器定义后重新核验；没有提交' });
        if (remote) await this.release(binding, session, remote);
      }
      return await this.status(by, binding.job);
    } finally { await stop(); }
  }
  async resume(by: Principal, job: string): Promise<JobStatus> {
    await this.registry.admin(by);
    const binding = await this.journal.binding(job); const events = await this.journal.events(job);
    if (isDone(events) && !isFrozen(events)) return this.status(by, job);
    const intent = eventOf(events, 'intent'); const receipt = eventOf(events, 'receipt');
    if (!intent) {
      const gate = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: false }, [], `dispatch.gate:${job}`);
      if (!gate.created && gate.body.detail.allow_submit === true) { await this.unknown(binding, '派发可能正在进行；没有完整回执，不能重交'); return this.status(by, job); }
      await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', next_action: '从未写入派发意图，必要时重新核对后派发' });
      return this.status(by, job);
    }
    if (!receipt || isFrozen(events)) { await this.unknown(binding, '有意图但无完整可信回执或仍被冻结；下一步由管理员对账'); return this.status(by, job); }
    const d = await this.pinned(binding);
    const client = this.session(binding, d, await this.secret(binding.executor));
    await client.connect();
    const remote = intent.body.detail.remote_lease as unknown as RemoteLease;
    const stop = this.heartbeat(binding, d, client, remote);
    try { return await this.observe(by, binding, d, client, receipt.body.detail.remote_id, intent.body.detail.fences as unknown as HolderSnapshot[]); }
    catch { await this.unknown(binding, '状态或结果读取不完整；不能重交，请管理员对账'); return this.status(by, job); }
    finally { await stop(); }
  }
  private async reserve(binding: JobBinding): Promise<void> {
    const history = await this.journal.targets(binding.resources);
    const jobs = new Set(history.map(e => String(e.body.detail.job)));
    for (const job of jobs) {
      const own = history.filter(e => e.body.detail.job === job);
      if (isFrozen(own) || !isDone(own)) throw new Error('物理目标有未结束或未知的作业；先查询或由管理员对账');
    }
    const resources = binding.resources.map(r => sha256Hex(r)).sort();
    await this.options.records.store.withTransaction(async tx => {
      for (const resource of resources) {
        const previous = [...history].reverse().find(e => e.body.detail.phase === 'reservation' && e.body.detail.reserved_resource === resource);
        const claim = await this.journal.append(binding, 'reservation', 'validate', 'completed', { binding, reserved_resource: resource }, [], `dispatch.reserve:${resource}:${previous?.digest ?? 'first'}`, tx);
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
    return before.length === after.length && before.every(a => after.some(b => a.key === b.key && a.lease === b.lease && a.fencing === b.fencing && !b.released && Date.parse(b.expires_at) > this.now().getTime()));
  }
  private async secret(id: string): Promise<string> { const secret = await this.options.records.vault.getText(`executor.${id}.bearer`); if (!secret) throw new Error('执行器密钥不可用'); return secret; }
  private async pinned(binding: JobBinding): Promise<ExecutorDefinition> {
    const bytes = await this.options.records.objects.get(binding.executor_digest);
    if (!bytes) throw new Error('冻结的执行器定义缺失');
    const { ExecutorDefinition: schema } = await import('./definition.ts'); return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }
  private context(binding: JobBinding): Record<string, unknown> { return { job: binding.job, target: binding.input?.target, build: binding.input?.build, sha256: binding.input?.sha256, items: binding.input?.items, seats: binding.resources.length, manifest_sha256: binding.input?.manifest_sha256 }; }
  private session(binding: JobBinding, d: ExecutorDefinition, secret: string): RpcClient {
    return new RpcClient(d, secret, binding.job, async (bytes, status, operation, complete = true) => {
      const source = await this.journal.raw(binding, bytes, operation, complete);
      await this.journal.append(binding, `${operation}.response`, 'read', complete ? 'completed' : 'error', { http_status: status, complete, redacted_before_interpretation: true }, [source]);
      return source;
    });
  }
  private async read(binding: JobBinding, client: RpcClient, role: CallRole, context: Record<string, unknown>, readBack = false): Promise<Exchange> {
    const result = await client.call(role, context);
    await this.journal.append(binding, role, readBack ? 'read_back' : 'read', 'completed', {}, [result.source]);
    return result;
  }
  private async acquire(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>): Promise<RemoteLease> {
    const response = await client.call('acquire', context);
    const lease = { id: at(response.value, d.lease.id), token: at(response.value, d.lease.token), ttl: Number(at(response.value, d.lease.ttl_ms)) };
    if (d.lease.map[String(at(response.value, d.lease.acceptance))] !== 'accepted' || lease.id === undefined || lease.token === undefined || !Number.isFinite(lease.ttl) || lease.ttl < 3) throw new Error('目标租约未取得，未提交');
    await this.journal.append(binding, 'acquire', 'read', 'completed', { remote_lease: lease }, [response.source]); return lease;
  }
  private conditions(d: ExecutorDefinition, value: unknown, context: Record<string, unknown>): boolean {
    return d.conditions.every(c => { const actual = at(value, c.pointer);
      if (Object.hasOwn(c, 'equals')) return same(actual, bind(c.equals, context));
      if (c.at_least !== undefined) return typeof actual === 'number' && actual >= c.at_least;
      return actual !== undefined && digestOfValue(actual) === c.sha256;
    });
  }
  private heartbeat(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, lease: RemoteLease): () => Promise<void> {
    let flight: Promise<void> | null = null; let interrupted = false;
    const timer = setInterval(() => {
      if (flight || interrupted) return;
      flight = (async () => {
        try {
          const response = await client.call('heartbeat', { ...this.context(binding), lease_id: lease.id, lease_token: lease.token });
          if (d.lease.map[String(at(response.value, d.lease.acceptance))] !== 'accepted') throw new Error('目标租约中断');
          await this.journal.append(binding, 'heartbeat', 'read', 'completed', {}, [response.source]);
        } catch { interrupted = true; await this.journal.append(binding, 'heartbeat', 'read', 'error', { lease_interrupted: true, note: '目标租约中断，继续只读状态，不重新提交' }); }
      })().finally(() => { flight = null; });
    }, Math.max(1, Math.floor(lease.ttl / 3)));
    return async () => { clearInterval(timer); if (flight) await flight; };
  }
  private async release(binding: JobBinding, client: RpcClient, lease: RemoteLease): Promise<void> {
    try { await this.read(binding, client, 'release', { ...this.context(binding), lease_id: lease.id, lease_token: lease.token }); }
    catch { await this.journal.append(binding, 'release', 'read', 'error', { next_action: '目标租约释放未核实；请管理员只读核对，不能重交' }); }
  }
  private async unknown(binding: JobBinding, reason: string, sources: string[] = []): Promise<void> {
    await this.journal.append(binding, 'unknown', 'read_back', 'unknown', { uncertain: true, outcome: 'unknown', missing_fact: reason,
      request_kind: 'disposition', audience_role: 'admin', next_action: `管理员读取目标审计取得原作业身份后运行 circle-hub job dispose ${binding.job} --reconcile <远端作业编号>；不得重交` }, sources);
  }
  private async observe(by: Principal, binding: JobBinding, d: ExecutorDefinition, client: RpcClient, remoteId: unknown, fences: HolderSnapshot[]): Promise<JobStatus> {
    const input = binding.input!; const events = await this.journal.events(binding.job); const intent = eventOf(events, 'intent')!;
    const remoteLease = intent.body.detail.remote_lease as unknown as RemoteLease;
    const context = { ...this.context(binding), remote_id: remoteId, lease_id: remoteLease.id, lease_token: remoteLease.token };
    const deadline = Date.parse(String(intent.body.detail.not_after)); let drift = false;
    for (;;) {
      const response = await this.read(binding, client, 'status', context);
      if (!drift && !this.sameFences(fences, await this.options.leases.holderSnapshot(binding.resources))) {
        drift = true; await this.journal.append(binding, 'fencing', 'validate', 'unknown', { drift: true, note: '派发后围栏改变，不能声称保持同一租约；继续只读状态' });
      }
      const mapping = d.status.map[String(at(response.value, d.status.pointer))];
      if (!mapping || mapping.effect_outcome === 'unknown' || mapping.action_result === 'unknown') { await this.unknown(binding, '目标状态丢失或不认识；缺可信终态，下一步管理员对账', [response.source]); return this.status(by, binding.job); }
      if (mapping.action_result === 'completed' || mapping.action_result === 'error' || mapping.effect_outcome === 'effective' || mapping.effect_outcome === 'read_back_consistent') break;
      if (this.now().getTime() >= deadline) { await this.unknown(binding, '最长运行窗口已过且没有可信终态；下一步管理员对账'); return this.status(by, binding.job); }
      await this.sleep(d.poll_ms);
    }
    const response = await this.read(binding, client, 'result', context);
    if (!same(at(response.value, d.result.id), remoteId) || at(response.value, d.result.sha256) !== input.sha256) {
      await this.unknown(binding, '结果身份或摘要不符，整份不采信；请管理员对账', [response.source]); return this.status(by, binding.job);
    }
    const rows = at(response.value, d.result.items); const complete = at(response.value, d.result.complete) === true;
    const projected = input.items.map(id => {
      const found = Array.isArray(rows) ? rows.filter(r => at(r, d.result.item_id) === id) : [];
      const reported = complete && found.length === 1 ? d.result.map[String(at(found[0], d.result.item_outcome))] ?? null : null;
      return { item: id, reported_terminal: reported, dynamic_terminal: 'no_verdict', missing_fact: reported === null ? '结果通道不完整或条目没有可解释的报告；请管理员只读补取原作业结果' : '结果按派发身份归属尚未认证；该值只转述目标报告', limits: ['目标对本次派发的报告', '未排除本地操作'] };
    });
    const artifact = await this.options.records.artifacts.ingest({ bytes: canonicalBytes({ job: binding.job, sha256: input.sha256, rows: projected, lease_drift: drift, limits: ['目标对本次派发的报告', '未排除本地操作'] }), mediaType: 'application/json',
      origin: { generated: { generator: 'dispatch@1', inputs: [response.source, `src:${input.sha256}`] } }, author: { user: null }, provenanceType: 'projected', visibility: { readers: [binding.user], admins: true, packs: [], shareable: false } });
    await this.journal.append(binding, 'result', 'read_back', 'completed', { reference: `src:${artifact.body.sha256}`, items: projected.length, no_verdict: projected.length }, [response.source]);
    await this.release(binding, client, remoteLease);
    await this.journal.append(binding, 'complete', 'read_back', 'completed', { done: true, outcome: 'effective' });
    return this.status(by, binding.job);
  }
}
