import { canonicalBytes, canonicalize, sha256Hex, type Principal, type RecordsKit } from '../records/api.ts';
import type { LeaseService, HolderSnapshot } from '../leases/api.ts';
import type { WorkflowStore, KnowledgePort } from '../ports.ts';
import type { EffectOutcome, Disposition } from '../../contracts/generated/vocabulary.ts';
import { at, bind, mapped, registrationMissing, type CallRole, type ExecutorDefinition } from './definition.ts';
import { ExecutorRegistry } from './executors.ts';
import { Journal, digestOfValue, eventOf, isDone, isFrozen, newJob, type JobBinding, type Event } from './journal.ts';
import { RpcClient, object, type Exchange } from './transport.ts';
import { verifyInput, type VerificationPort } from './proof.ts';
export interface DispatchOptions {
  knowledge?: Pick<KnowledgePort,'builds'|'resolveBuild'>;
  records: RecordsKit; leases: Pick<LeaseService, 'holderSnapshot'>; runs: VerificationPort;
  workflows: Pick<WorkflowStore, 'byDigest'>; close?: () => Promise<void>; now?: () => Date; sleep?: (ms: number) => Promise<void>;
}
export interface JobStatus { job: string; phase: string; outcome: EffectOutcome; frozen: boolean; result?: string; events: number; next_action?: string; missing_fact?: string; }
interface RemoteLease { id: unknown; token: unknown; ttl: number; }
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && canonicalize(a) === canonicalize(b);
export class DispatchService {
  readonly options: DispatchOptions;
  readonly registry: ExecutorRegistry;
  readonly journal: Journal;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
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
    const missingReceipt = !events.some(e => e.body.detail.done === true && ['target_rejected','proven_not_executed'].includes(String(e.body.detail.outcome))) && !!eventOf(events, 'intent') && !eventOf(events, 'receipt') && !events.some(e => e.body.detail.unfreeze === true);
    const unknown = isFrozen(events); const result = eventOf(events, 'result'); const end = eventOf(events, 'complete');
    const intent = eventOf(events, 'intent'); const receipt = eventOf(events, 'receipt');
    const uncertainty = [...events].reverse().find(e => e.body.detail.uncertain === true && typeof e.body.detail.missing_fact === 'string');
    const missingFact = unknown || missingReceipt ? String(uncertainty?.body.detail.missing_fact ?? '已写意图但缺少可信提交回执；不能证明未执行') : end?.body.detail.registration_ready === false ? `登记缺事实：${(end.body.detail.registration_missing as string[] ?? []).join('、')}` : undefined;
    return { job, phase: String(events.at(-1)!.body.detail.phase),
      outcome: end && ['target_rejected','proven_not_executed'].includes(String(end.body.detail.outcome)) ? end.body.detail.outcome as EffectOutcome : unknown || missingReceipt || (intent && !receipt) ? 'unknown' : end?.body.detail.outcome === 'not_dispatched' ? 'not_dispatched' : end ? 'effective' : intent ? 'issued' : 'not_dispatched',
      frozen: unknown || missingReceipt, ...(typeof result?.body.detail.reference === 'string' ? { result: result.body.detail.reference } : {}), events: events.length, ...(missingFact ? { missing_fact: missingFact } : {}),
      ...(unknown || missingReceipt ? { next_action: `请管理员取证后运行 circle-hub job dispose ${job} --reconcile <远端作业编号>；不能重交` } : typeof end?.body.detail.next_action === 'string' ? { next_action: end.body.detail.next_action } : !isDone(events) ? { next_action: `circle-hub job resume ${job}` } : {}) };
  }
  async precheck(by: Principal, executor: string, booking?: string): Promise<JobStatus> {
    await this.registry.admin(by);
    const registered = await this.registry.get(executor);
    if (!registered?.definition.enabled) throw new Error('执行器不可用或已禁用');
    const d = registered.definition;
    const booked = booking ? await this.options.runs.getRun(by, booking) : null;
    if (booking && !booked) throw new Error('预订运行对你不可用');
    const binding: JobBinding = { job: newJob(), initiated_by: by.id, executor, executor_digest: registered.digest, target_key: digestOfValue([...d.resources].sort()), input: null,
      user: booked?.run.runner ?? by.id, resources: [], context: { ...d.precheck_context, ...(booked?.run.build ? { build: booked.run.build } : {}), ...(booked?.run.product ? {product:booked.run.product} : {}), ...(booked?.run.root ? {root:booked.run.root} : {}), target: d.target, ...(d.resources.length ? { seats: d.resources.length } : {}), ...(d.manifest_sha256 ? { manifest_sha256: d.manifest_sha256 } : {}) } };
    await this.journal.append(binding, 'reservation', 'validate', 'completed', { binding, read_only: true });
    const client = this.session(binding, d, await this.secret(executor));
    let lease: RemoteLease | undefined; let stop = async () => {}; let verified = false;
    try {
      await client.connect(); lease = await this.acquire(binding, d, client, this.context(binding));
      stop = this.heartbeat(binding, d, client, lease);
      const context = { ...this.context(binding), lease_id: lease.id, lease_token: lease.token };
      try { const response = await this.read(binding, client, 'precheck', context); verified = this.conditions(d.conditions, response.value, context); } catch { verified = false; }
      const extra = await this.extraPrechecks(binding, d, client, context, true);
      const probed = await this.probeSeats(binding,d,client,context);
      verified = verified && extra && probed;
    } catch { verified = false; }
    finally { await stop(); if (lease) await this.release(binding, client, lease); }
    await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', readonly_verified: verified, registration_ready: registrationMissing(d).length === 0, registration_missing: registrationMissing(d),
      ...(registrationMissing(d).length ? { next_action: '请将预检原件交转换脚本生成清单，经管理员发布后 update 补齐清单摘要和全部资源键；当前不能派发' } : verified ? {} : { next_action: '只读核对未满足；核对执行器条件、当前环境或预订构建后重跑 precheck' }) });
    return this.status(by, binding.job);
  }

  async conformance(by: Principal, executor: string): Promise<JobStatus> {
    await this.registry.admin(by); const registered = await this.registry.get(executor);
    if (!registered?.definition.enabled) throw new Error('执行器不可用或已禁用');
    const d = registered.definition;
    if (!d.conformance || !d.reconciliation || !d.calls.query || !d.receipt.stage || !d.receipt.reached_device) throw new Error('缺少只读查账、拒绝阶段或一致性探测字节声明；请补齐定义');
    const binding: JobBinding = {job:newJob(),initiated_by:by.id,executor,executor_digest:registered.digest,target_key:digestOfValue([...d.resources].sort()),input:null,user:by.id,resources:[],context:d.precheck_context};
    await this.journal.append(binding,'reservation','validate','completed',{binding,read_only:true});
    const client = this.session(binding,d,await this.secret(executor));
    let lease: RemoteLease | undefined; const observations: Exchange[] = []; const checks: boolean[] = [];
    try {
      await client.connect(); lease = await this.acquire(binding,d,client,this.context(binding));
      const context = {...this.context(binding),lease_id:lease.id,lease_token:lease.token,request_id:`${binding.job}:absent`,not_after:new Date(this.now().getTime()-1000).toISOString(),items:[]};
      const missing = await this.read(binding,client,'query',context); observations.push(missing);
      const r = d.reconciliation;
      const wireTime = (v:unknown) => typeof v === 'number' && r.time_scale_ms !== undefined ? v*r.time_scale_ms : typeof v === 'string' ? Date.parse(v) : NaN;
      checks.push(at(missing.value,r.found) === false && Number.isFinite(wireTime(at(missing.value,r.gateway_time))) && Number.isFinite(wireTime(at(missing.value,r.gc_before))));
      context.request_id = `${binding.job}:1`;
      const first = Buffer.from(d.conformance.payloads[0],'base64'); const second = Buffer.from(d.conformance.payloads[1],'base64');
      const refused = (v:unknown) => mapped(d.receipt.map,at(v,d.receipt.acceptance)) === 'not_accepted' && mapped(d.receipt.stages,at(v,d.receipt.stage!)) === 'target_rejected' && at(v,d.receipt.reached_device!) === false;
      for (const payload of [first,second]) {
        const reply = await client.call('submit',{...context,payload_base64:payload.toString('base64'),sha256:sha256Hex(payload)}); observations.push(reply); checks.push(refused(reply.value));
      }
      const recorded = await this.read(binding,client,'query',context); observations.push(recorded);
      checks.push(at(recorded.value,r.found) === true && at(recorded.value,r.request_id) === context.request_id && at(recorded.value,r.sha256) === sha256Hex(first) && mapped(r.map,at(recorded.value,r.state)) === 'target_rejected' && at(recorded.value,r.reached_device) === false && mapped(d.receipt.stages,at(recorded.value,r.stage)) === 'target_rejected');
    } catch { checks.push(false); }
    finally { if (lease) await this.release(binding,client,lease); }
    const init = eventOf(await this.journal.events(binding.job),'initialize.response');
    const artifact = await this.options.records.artifacts.ingest({bytes:canonicalBytes({target:d.target,version:client.serverVersion,checks,sources:observations.map(o=>o.source)}),mediaType:'application/json',origin:{generated:{generator:'dispatch@1',inputs:[...observations.map(o=>o.source),...(init?.body.inputs.filter(r=>r.startsWith('src:')) ?? [])]}},author:{user:null},provenanceType:'projected',visibility:{readers:[by.id],admins:true,packs:[],shareable:false}});
    await this.journal.append(binding,'result','read_back','completed',{reference:`src:${artifact.body.sha256}`,observations:observations.length},observations.map(o=>o.source));
    await this.journal.append(binding,'complete','read_back','completed',{done:true,outcome:'not_dispatched',conformance_verified:checks.length === 4 && checks.every(Boolean),next_action:checks.length === 4 && checks.every(Boolean) ? '管理员复核这些源记录后，将目标版本和证据引用登记到执行器前提；不会自动认证' : '一致性探测未取得四项相符事实；管理员核对定义和原始回答后重跑 conformance'});
    return this.status(by,binding.job);
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
      if (!end || isFrozen(priorEvents) || !['target_rejected','proven_not_executed'].includes(String(end.body.detail.outcome)) || pinned.input?.run !== input.run || digestOfValue({...await this.pinned(pinned),premises:{}}) !== digestOfValue({...d,premises:{}})) throw new Error(`这份字节已有派发意图；作业摘要 ${priorJob}；只能查询或对账，不能重交`);
    }
    const attempt = attempts.length + 1;
    const source = await this.options.records.artifacts.source({ id: input.user, name: '', role: 'user' }, input.sha256, { consumer: 'function' });
    if (!source?.bytes) throw new Error('核验字节不可读取，未提交');
    const initial = await this.holders(input.ancestors, input.user, d.resources, d.max_run_ms);
    const secret = await this.secret(executor);
    const binding: JobBinding = { job: newJob(), initiated_by: by.id, executor, executor_digest: registered.digest, input, user: input.user, resources: d.resources, fences: initial, target_key: digestOfValue([...d.resources].sort()) };
    if (JSON.stringify(binding).includes(secret)) throw new Error('绑定元数据不能包含执行器密钥');
    await this.reserve(binding);
    try { onReserved?.(binding.job); } catch { /* A terminal sink never controls an effect already authorized by the command. */ }
    const session = this.session(binding, d, secret);
    let remote: RemoteLease | undefined; let stop = async () => {};
    let intended = false;
    try {
      await session.connect();
      remote = await this.acquire(binding, d, session, this.context(binding));
      stop = this.heartbeat(binding, d, session, remote);
      const context: Record<string, unknown> = { ...this.context(binding), lease_id: remote.id, lease_token: remote.token, payload_base64: Buffer.from(source.bytes).toString('base64') };
      const precheck = await this.read(binding, session, 'precheck', context);
      if (!this.conditions(d.conditions, precheck.value, context)) throw new Error('只读核对未满足；未提交，请核对当前环境后重新核验');
      if (!await this.extraPrechecks(binding, d, session, context, false)) throw new Error('附加只读核对未满足；未提交，请重新核对缓存来源');
      const deviceIdentity = await this.probeSeats(binding,d,session,context);
      if (!deviceIdentity) throw new Error('逐座位只读探测不符；见受限探测原件中的座位及 version/interfaces 核对');
      const latest = await this.registry.get(executor);
      if (!latest?.definition.enabled || latest.digest !== registered.digest) throw new Error('执行器配置已变；未提交，请按当前配置重新核验');
      await this.registry.admin(by);
      const ownerNow = await this.options.records.principals.get(input.user);
      if (!ownerNow || ownerNow.disabled) throw new Error('发起用户已经不可用；未提交');
      const fresh = await this.holders(input.ancestors, input.user, d.resources, d.max_run_ms);
      if (!this.sameFences(initial, fresh)) throw new Error('派发前围栏已变；未提交，请重新证明基线');
      const notAfter = new Date(this.now().getTime() + d.submit_timeout_ms).toISOString();
      const sequence = attempts.length ? Number(attempts[0].body.detail.sequence) : (await this.options.records.store.findMany({ kind: 'action', key: 'dispatch.lineage', values: [input.lineage] })).filter(e => (e.body as Record<string, unknown>)?.detail && ((e.body as { detail: Record<string, unknown> }).detail.phase === 'intent')).length + 1;
      const key = attempts.length ? String(attempts[0].body.detail.intent_key) : digestOfValue([input.lineage, input.item, d.proof.slot, sequence]);
      context.request_id = `${key}:${attempt}`; context.not_after = notAfter;
      const actionDigest = digestOfValue({ content: input.sha256, tool: d.calls.submit.tool, arguments: bind(d.calls.submit.arguments, context) });
      await this.options.records.store.withTransaction(async tx => {
        const gate = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: true }, [], `dispatch.gate:${binding.job}`, tx);
        if (!gate.created) throw new Error('作业已经恢复或关闭，不能再提交');
        const ordinal = attempt === 1 ? await this.journal.append(binding, 'sequence', 'validate', 'completed', { sequence }, [], `dispatch.sequence:${input.lineage}:${sequence}`, tx) : { created: true };
        if (!ordinal.created) throw new Error('血缘次序已由另一派发占用；未提交');
        const intent = await this.journal.append(binding, 'intent', 'dispatch', 'completed', { intent_key: key, request_id: context.request_id, device_identity_proven: !!d.probes && deviceIdentity, device_lease_digest: digestOfValue([context.lease_id,context.lease_token]), attempt, not_after: notAfter, sequence, action_digest: actionDigest,
          dispatch_binding_digest: digestOfValue([input.run, input.item, input.sha256, fresh, remote]), target_key: binding.target_key, effect_class: 'job', retry_safety: 'unsafe', signing: 'service_on_behalf', on_behalf_of: input.user,
          before_state_bound: false, fences: fresh, remote_lease: remote, window: { from: this.now().toISOString(), to: notAfter } }, [`src:${input.sha256}`, `rec:${input.result}`], `dispatch.bytes:${input.sha256}:${attempt}`, tx);
        if (!intent.created) throw new Error('这份字节已经写过意图；未重复提交');
      });
      intended = true;
      if (this.now().getTime() >= Date.parse(notAfter)) { await this.unknown(binding, '意图写入后派发窗口已过；未继续发送，需管理员处置'); return await this.status(by, binding.job); }
      if (!this.sameFences(fresh, await this.options.leases.holderSnapshot(d.resources))) { await this.unknown(binding, '意图后围栏漂移；未继续提交'); return await this.status(by, binding.job); }
      // Signals must not cancel an in-flight effect; SIGKILL is recovered from the already committed intent.
      const ignore = () => {}; process.on('SIGINT', ignore); process.on('SIGTERM', ignore);
      let answer: Exchange;
      try { answer = await session.call('submit', context); } finally { process.off('SIGINT', ignore); process.off('SIGTERM', ignore); }
      const accepted = mapped(d.receipt.map, at(answer.value, d.receipt.acceptance)) === 'accepted';
      const remoteId = at(answer.value, d.receipt.id);
      if (d.receipt.request_id && at(answer.value, d.receipt.request_id) !== context.request_id) {
        await this.unknown(binding, '回执请求身份与意图不符；须按原请求记录核对，不能重交', [answer.source], { observed_outcome: 'read_back_mismatch' }); return this.status(by, binding.job);
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
        if (eventOf(await this.journal.events(binding.job), 'receipt')) await this.pendingRead(binding);
        else if (d.reconciliation && d.calls.query) return await this.reconcileRequest(by,binding,d,session,stop);
        else await this.unknown(binding, '提交未取得完整可信回执；缺远端作业身份或结果，必须管理员对账');
      }
      else {
        await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', reason: session.redact(error instanceof Error ? error.message.toWellFormed().slice(0, 1000) : '前提核对出错'), next_action: '核对只读条件、租约和执行器定义后重新核验；没有提交' });
        if (remote) await this.release(binding, session, remote);
      }
      return await this.status(by, binding.job);
    } finally { await stop(); }
  }
  async resume(by: Principal, job: string): Promise<JobStatus> {
    await this.registry.admin(by);
    const binding = { ...await this.journal.binding(job), acting_by: by.id }; const events = await this.journal.events(job);
    if (isDone(events) && !isFrozen(events)) return this.status(by, job);
    const intent = eventOf(events, 'intent'); const receipt = eventOf(events, 'receipt');
    if (!intent) {
      const gate = await this.journal.append(binding, 'gate', 'validate', 'completed', { allow_submit: false }, [], `dispatch.gate:${job}`);
      if (!gate.created && gate.body.detail.allow_submit === true) { await this.unknown(binding, '派发可能正在进行；没有完整回执，不能重交'); return this.status(by, job); }
      await this.journal.append(binding, 'complete', 'validate', 'completed', { done: true, outcome: 'not_dispatched', next_action: '从未写入派发意图，必要时重新核对后派发' });
      return this.status(by, job);
    }
    const d = await this.pinned(binding);
    if ((!receipt || isFrozen(events)) && (!d.reconciliation || !d.calls.query)) { await this.unknown(binding, '有意图但无完整可信回执或仍被冻结；下一步由管理员对账'); return this.status(by, job); }
    const client = this.session(binding, d, await this.secret(binding.executor));
    await client.connect();
    const remote = intent.body.detail.remote_lease as unknown as RemoteLease;
    const stop = this.heartbeat(binding, d, client, remote);
    if (!receipt || isFrozen(events)) { try { return await this.reconcileRequest(by,binding,d,client,stop); } finally { await stop(); } }
    try { return await this.observe(by, binding, d, client, receipt!.body.detail.remote_id, intent.body.detail.fences as unknown as HolderSnapshot[], stop); }
    catch { await this.pendingRead(binding); return this.status(by, job); }
    finally { await stop(); }
  }
  async dispose(by: Principal, job: string, options: { choice: Disposition; remote_id?: string | number; reason?: string; acceptPossibleDuplicateEffects?: boolean }): Promise<JobStatus> {
    await this.registry.admin(by);
    const binding = { ...await this.journal.binding(job), acting_by: by.id }; const events = await this.journal.events(job);
    if (isDone(events) && !isFrozen(events)) return this.status(by, job);
    const intent = eventOf(events, 'intent');
    if (!intent) throw new Error('没有派发意图；请用 resume 核对未发出的作业');
    if (options.choice === 'keep_unknown') {
      await this.journal.append(binding, 'dispose', 'read_back', 'completed', { disposition: options.choice, decided_by: by.id, decided_at: this.now().toISOString(), uncertain: true, unfreeze: false, next_action: '继续取得原作业审计与结果；不能重交' });
      return this.status(by, job);
    }
    if (options.choice === 'mark_failed') {
      if (!options.reason?.trim() || options.reason.length > 1000) throw new Error('标记失败必须给出非空原因，最多 1000 字符');
      const confirmed = options.acceptPossibleDuplicateEffects === true;
      const secret = await this.options.records.vault.getText(`executor.${binding.executor}.bearer`);
      const reason = secret ? options.reason.split(secret).join('[已隐藏]') : options.reason;
      await this.journal.append(binding, 'dispose', 'read_back', 'completed', { disposition: options.choice, reason, decided_by: by.id, decided_at: this.now().toISOString(),
        risk_confirmed: confirmed, confirmed_by: confirmed ? by.id : null, confirmed_at: confirmed ? this.now().toISOString() : null,
        confirmation: confirmed ? '接受可能重复执行的副作用' : null, unfreeze: confirmed, done: confirmed,
        original_outcome: eventOf(events, 'receipt') && !isFrozen(events) ? 'issued' : 'unknown', effect_mark: 'disposed', ...(confirmed ? { possible_duplicate: true } : { next_action: '仍冻结；需要管理员对账或显式确认接受可能重复执行的副作用' }) });
      return this.status(by, job);
    }
    if (options.choice !== 'reconcile' || options.remote_id === undefined) throw new Error('本轮只允许核对、保持未知或标记失败；核对必须给远端编号');
    const d = await this.pinned(binding); const client = this.session(binding, d, await this.secret(binding.executor));
    try {
      await client.connect();
      const originalLease = intent.body.detail.remote_lease as unknown as RemoteLease;
      const context = { ...this.context(binding), remote_id: options.remote_id, lease_id: originalLease.id, lease_token: originalLease.token };
      const state = await this.read(binding, client, 'status', context, true);
      const result = await this.read(binding, client, 'result', context, true);
      const rawTime = at(result.value, d.result.submitted_at);
      const time = d.result.submitted_at_scale_ms !== undefined && typeof rawTime === 'number' ? rawTime * d.result.submitted_at_scale_ms : Date.parse(String(rawTime));
      const window = intent.body.detail.window as { from: string; to: string };
      if (!mapped(d.status.map, at(state.value, d.status.pointer)) || !same(at(result.value, d.result.id), options.remote_id) || at(result.value, d.result.sha256) !== binding.input!.sha256 || !Number.isFinite(time) || time < Date.parse(window.from) || time > Date.parse(window.to)) throw new Error('对账身份、摘要或投递窗口不符；查无记录不能证明未执行');
      await this.journal.append(binding, 'dispose', 'read_back', 'completed', { disposition: 'reconcile', decided_by: by.id, decided_at: this.now().toISOString(), unfreeze: true, remote_id: options.remote_id, effect_mark: 'disposed', identity_matched: true, digest_matched: true, window_matched: true }, [state.source, result.source]);
      await this.journal.append(binding, 'receipt', 'read_back', 'completed', { remote_id: options.remote_id, reconciled: true, acceptance: 'accepted' }, [result.source]);
      const lease = intent.body.detail.remote_lease as unknown as RemoteLease;
      const stop = this.heartbeat(binding, d, client, lease);
      try { return await this.observe(by, binding, d, client, options.remote_id, intent.body.detail.fences as unknown as HolderSnapshot[], stop); }
      finally { await stop(); }
    } catch {
      await this.journal.append(binding, 'dispose', 'read_back', 'error', { disposition: 'reconcile', decided_by: by.id, decided_at: this.now().toISOString(), unfreeze: false, uncertain: true, missing_fact: '未取得与原派发身份、摘要和时间窗一致的记录', next_action: '管理员继续只读审计；保持未知，或显式确认风险后标记失败' });
      throw new Error('对账未通过；查无记录不能证明未执行，仍冻结');
    }
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
    try { response = await this.retryRead(binding,client,'query',context,Infinity); }
    catch { await this.unknown(binding,'原请求记录连续三次读取失败；管理员恢复只读通道后运行 job resume，不得重交'); return this.status(by,binding.job); }
    const value = response.value; const found = at(value,r.found);
    const reported = mapped(r.map,at(value,r.state));
    const identity = at(value,r.request_id) === context.request_id && at(value,r.sha256) === binding.input!.sha256;
    if (found === true && identity && reported === 'issued' && this.opaque(at(value,r.id))) {
      await this.journal.append(binding,'receipt','read_back','completed',{remote_id:at(value,r.id),acceptance:'accepted',outcome:'issued',unfreeze:true,reconciled:true},[response.source]);
      try { return await this.observe(by,binding,d,client,at(value,r.id),intent.body.detail.fences as unknown as HolderSnapshot[],stop); }
      catch { await this.pendingRead(binding); return this.status(by,binding.job); }
    }
    const certified = await this.certified(binding,d,client,'request_journal');
    if (found === true && identity && reported === 'target_rejected') {
      const remapped = {...d,receipt:{...d.receipt,stage:r.stage,reached_device:r.reached_device}};
      if (await this.refused(binding,remapped,client,response,lease)) return this.status(by,binding.job);
    }
    const time = (v: unknown) => typeof v === 'number' && r.time_scale_ms !== undefined ? v * r.time_scale_ms : typeof v === 'string' ? Date.parse(v) : NaN;
    const clock = time(at(value,r.gateway_time)), floor = time(at(value,r.gc_before));
    const absent = found === false && Number.isFinite(clock) && Number.isFinite(floor) && clock > deadline && deadline > floor;
    if (certified && (absent || (found === true && identity && reported === 'proven_not_executed' && at(value,r.reached_device) === false))) {
      await this.journal.append(binding,'reconciled','read_back','completed',{outcome:'proven_not_executed',unfreeze:true,reached_device:false},[response.source]);
      await stop(); await this.release(binding,client,lease);
      await this.journal.append(binding,'complete','read_back','completed',{done:true,outcome:'proven_not_executed',unfreeze:true,next_action:'原请求记录证明未执行；修正前提后可开启新的请求尝试'});
      return this.status(by,binding.job);
    }
    await this.unknown(binding,!certified ? '当前目标版本的请求记录前提未认证；管理员先运行 job conformance 采证并登记该版本，再 resume' : '原请求记录的身份、摘要、状态或保留时间边界不足；管理员核对原件后 resume，不得重交',[response.source]);
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
    return true;
  }
  private async refused(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, answer: Exchange, lease: RemoteLease): Promise<boolean> {
    if (!d.receipt.stage || !d.receipt.reached_device || mapped(d.receipt.stages,at(answer.value,d.receipt.stage)) !== 'target_rejected' || at(answer.value,d.receipt.reached_device) !== false || !await this.certified(binding,d,client,'request_journal')) return false;
    await this.journal.append(binding,'rejection','read_back','completed',{outcome:'target_rejected',acceptance:'not_accepted',stage:at(answer.value,d.receipt.stage),reached_device:false,unfreeze:true},[answer.source]);
    await this.release(binding,client,lease);
    await this.journal.append(binding,'complete','read_back','completed',{done:true,outcome:'target_rejected',unfreeze:true,next_action:'按拒绝阶段补齐事实后，可用新的请求尝试派发；不要重发原请求'});
    return true;
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
    return before.length === after.length && before.every(a => after.some(b => a.key === b.key && a.lease === b.lease && a.fencing === b.fencing && !b.released && Date.parse(b.expires_at) > this.now().getTime()));
  }
  private async secret(id: string): Promise<string> { const secret = await this.options.records.vault.getText(`executor.${id}.bearer`); if (!secret) throw new Error('执行器密钥不可用'); return secret; }
  private async pinned(binding: JobBinding): Promise<ExecutorDefinition> {
    const bytes = await this.options.records.objects.get(binding.executor_digest);
    if (!bytes) throw new Error('冻结的执行器定义缺失');
    const { ExecutorDefinition: schema } = await import('./definition.ts'); return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }
  private context(binding: JobBinding): Record<string, unknown> { return { ...binding.context, job: binding.job, user: binding.user, actor: binding.acting_by ?? binding.initiated_by, product:binding.input?.product ?? binding.context?.product, root:binding.input?.root ?? binding.context?.root, target: binding.input?.target ?? binding.context?.target, build: binding.input?.build ?? binding.context?.build, sha256: binding.input?.sha256, items: binding.input?.items, seats: binding.context?.seats ?? (binding.resources.length ? binding.resources.length : undefined), manifest_sha256: binding.input?.manifest_sha256 ?? binding.context?.manifest_sha256 }; }
  private session(binding: JobBinding, d: ExecutorDefinition, secret: string): RpcClient {
    return new RpcClient(d, secret, `${binding.user}/${binding.job}`, async (bytes, status, operation, complete = true, metadata) => {
      const captured = await this.journal.raw(binding, bytes, operation, complete);
      const source = captured.reference;
      await this.journal.append(binding, `${operation}.response`, operation === 'submit' ? 'dispatch' : 'read', complete ? 'completed' : 'error', { http_status: status, complete, source_record: captured.record, ...metadata }, [source, captured.record]);
      return source;
    }, this.now);
  }
  private async read(binding: JobBinding, client: RpcClient, role: CallRole, context: Record<string, unknown>, readBack = false): Promise<Exchange> {
    const result = await client.call(role, context);
    await this.journal.append(binding, role, readBack ? 'read_back' : 'read', 'completed', { started_at: result.started_at, ended_at: result.received_at }, [result.source]);
    return result;
  }
  private async retryRead(binding: JobBinding, client: RpcClient, role: CallRole, context: Record<string, unknown>, deadline: number): Promise<Exchange> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await this.read(binding, client, role, context); }
      catch {
        await this.journal.append(binding, `${role}.retry`, 'read', 'error', { attempt, missing_fact: '本次只读应答不可用，不等于未执行', next_action: attempt < 3 ? '自动重读原作业，绝不重交' : `circle-hub job resume ${binding.job}` });
        if (attempt === 3 || this.now().getTime() >= deadline) throw new Error('原作业只读查询待恢复');
        await this.sleep(client.definition.poll_ms);
      }
    }
    throw new Error('原作业只读查询待恢复');
  }
  private async pendingRead(binding: JobBinding): Promise<void> {
    await this.journal.append(binding, 'read_pending', 'read', 'error', { missing_fact: '已有受理回执，尚未读到原作业状态或结果；不是未执行', request_kind: 'repair', next_action: `自动重读未成功；恢复连接后运行 circle-hub job resume ${binding.job}；不得重交` });
    await this.journal.append(binding, 'heartbeat', 'read', 'error', { lease_interrupted: true, note: '命令暂停，目标租约连续性未证实；恢复时只读原作业' });
  }
  private async acquire(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>): Promise<RemoteLease> {
    const response = await client.call('acquire', context);
    const lease = { id: at(response.value, d.lease.id), token: at(response.value, d.lease.token), ttl: Number(at(response.value, d.lease.ttl_ms)) * d.lease.ttl_scale_ms };
    if (mapped(d.lease.map, at(response.value, d.lease.acceptance)) !== 'accepted' || !this.opaque(lease.id) || !this.opaque(lease.token) || !Number.isFinite(lease.ttl) || lease.ttl < 3) throw new Error('目标租约未取得，未提交');
    await this.journal.append(binding, 'acquire', 'read', 'completed', { remote_lease: lease }, [response.source]); return lease;
  }
  private opaque(value: unknown): boolean { return (typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('[已隐藏]')) || (typeof value === 'number' && Number.isSafeInteger(value)); }
  private conditions(conditions: ExecutorDefinition['conditions'], value: unknown, context: Record<string, unknown>): boolean {
    return conditions.length > 0 && conditions.every(c => { const actual = at(value, c.pointer);
      if (Object.hasOwn(c, 'equals')) return same(actual, bind(c.equals, context));
      if (c.at_least !== undefined) return typeof actual === 'number' && typeof bind(c.at_least, context) === 'number' && actual >= (bind(c.at_least, context) as number);
      return actual !== undefined && digestOfValue(actual) === bind(c.sha256, context);
    });
  }
  private async probeSeats(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string,unknown>): Promise<boolean> {
    if (!d.probes) return true;
    const { assessProbes } = await import('./probes.ts');
    return assessProbes(this.options.records,this.options.knowledge,binding,d,client,context,this.journal,this.sleep);
  }
  private async extraPrechecks(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, context: Record<string, unknown>, collectAll: boolean): Promise<boolean> {
    let verified = true;
    for (const [index, check] of d.precheck_reads.entries()) {
      let ok = false;
      try {
        const reply = await client.precheckRead(index, context);
        ok = this.conditions(check.conditions, reply.value, context);
        await this.journal.append(binding, `precheck.${index + 1}`, 'validate', 'completed', { matched: check.conditions.length ? ok : null, ...(check.conditions.length ? {} : { missing_fact: '只读原件已取得，但尚未登记期望条件；请转换核对后 update' }), started_at: reply.started_at, ended_at: reply.received_at }, [reply.source]);
      } catch { await this.journal.append(binding, `precheck.${index + 1}`, 'read', 'error', { missing_fact: '该登记只读核对没有完整应答或期望输入；不能判为通过', next_action: '核对原件和登记条件后重跑预检' }); }
      verified = verified && ok;
      if (!ok && !collectAll) break;
    }
    return verified;
  }
  private heartbeat(binding: JobBinding, d: ExecutorDefinition, client: RpcClient, lease: RemoteLease): () => Promise<void> {
    let flight: Promise<void> | null = null; let notice: Promise<unknown> | null = null; let interrupted = false;
    const timer = setInterval(() => {
      if (interrupted) return;
      if (flight) {
        interrupted = true; notice = this.journal.append(binding, 'heartbeat', 'read', 'error', { lease_interrupted: true, note: '心跳未能按期限三分之一完成，租约连续性未证实；继续只读状态' }).catch(() => undefined);
        return;
      }
      flight = (async () => {
        try {
          const response = await client.call('heartbeat', { ...this.context(binding), lease_id: lease.id, lease_token: lease.token });
          if (mapped(d.lease.map, at(response.value, d.lease.acceptance)) !== 'accepted') throw new Error('目标租约中断');
          await this.journal.append(binding, 'heartbeat', 'read', 'completed', {}, [response.source]);
        } catch { interrupted = true; await this.journal.append(binding, 'heartbeat', 'read', 'error', { lease_interrupted: true, note: '目标租约中断，继续只读状态，不重新提交' }); }
      })().catch(() => { interrupted = true; }).finally(() => { flight = null; });
    }, Math.max(1, Math.floor(lease.ttl / 3)));
    return async () => { clearInterval(timer); if (flight) await flight; if (notice) await notice; };
  }
  private async release(binding: JobBinding, client: RpcClient, lease: RemoteLease): Promise<void> {
    try { await this.read(binding, client, 'release', { ...this.context(binding), lease_id: lease.id, lease_token: lease.token }); }
    catch { await this.journal.append(binding, 'release', 'read', 'error', { next_action: '目标租约释放未核实；请管理员只读核对，不能重交' }); }
  }
  private async unknown(binding: JobBinding, reason: string, sources: string[] = [], observation: Record<string, unknown> = {}): Promise<void> {
    await this.journal.append(binding, 'unknown', 'read_back', 'unknown', { ...observation, uncertain: true, outcome: 'unknown', missing_fact: reason,
      request_kind: 'disposition', audience_role: 'admin', next_action: `管理员读取目标审计取得原作业身份后运行 circle-hub job dispose ${binding.job} --reconcile <远端作业编号>；不得重交` }, sources);
  }
  private async observe(by: Principal, binding: JobBinding, d: ExecutorDefinition, client: RpcClient, remoteId: unknown, fences: HolderSnapshot[], stopHeartbeat: () => Promise<void> = async () => {}): Promise<JobStatus> {
    const input = binding.input!; const events = await this.journal.events(binding.job); const intent = eventOf(events, 'intent')!;
    const remoteLease = intent.body.detail.remote_lease as unknown as RemoteLease;
    const context = { ...this.context(binding), remote_id: remoteId, lease_id: remoteLease.id, lease_token: remoteLease.token };
    const deadline = Date.parse(String(intent.body.detail.not_after)) + d.max_run_ms; let drift = false;
    for (;;) {
      const response = await this.retryRead(binding, client, 'status', context, deadline);
      if (!drift && !this.sameFences(fences, await this.options.leases.holderSnapshot(binding.resources))) {
        drift = true; await this.journal.append(binding, 'fencing', 'validate', 'unknown', { drift: true, note: '派发后围栏改变，不能声称保持同一租约；继续只读状态' });
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
    if (!drift && !this.sameFences(fences, await this.options.leases.holderSnapshot(binding.resources))) {
      drift = true; await this.journal.append(binding, 'fencing', 'validate', 'unknown', { drift: true, note: '结果读取期间围栏改变，不能声称保持同一租约' });
    }
    await stopHeartbeat();
    const leaseInterrupted = (await this.journal.events(binding.job)).some(e => e.body.detail.lease_interrupted === true);
    const projected = input.items.map(id => {
      const found = Array.isArray(rows) ? rows.filter(r => at(r, d.result.item_id) === id) : [];
      const reported = complete && found.length === 1 ? mapped(d.result.map, at(found[0], d.result.item_outcome)) ?? null : null;
      return { item: id, reported_terminal: reported, dynamic_terminal: 'no_verdict', missing_fact: reported === null ? '结果通道不完整或条目没有可解释的报告；请管理员只读补取原作业结果' : '结果按派发身份归属尚未认证；该值只转述目标报告', limits: ['目标对本次派发的报告', '未排除本地操作'] };
    });
    const savedLogs = Array.isArray(rows) ? rows.flatMap(row=>[
      ...(d.result.log && typeof at(row,d.result.log)==='string' ? [String(at(row,d.result.log))] : []),
      ...(d.result.sessions && object(at(row,d.result.sessions)) ? Object.values(at(row,d.result.sessions) as Record<string,unknown>).filter((v):v is string=>typeof v==='string') : []),
    ]) : [];
    const sideEffects = d.side_effects.map(declaration=>declaration.marker ? {message:declaration.message,marker_present:savedLogs.some(log=>log.includes(declaration.marker!)),text:savedLogs.some(log=>log.includes(declaration.marker!))?'本次日志里有这一项的标记':'本次日志里没有这一项的标记',reference:response.source,complete,scope:'只核对本次已保存字节中的标记，不推断动作是否发生'} : {message:declaration.message,text:'运行器会这样做（执行器定义声明，Hub 看不见）',provenance:'declared',definition_sha256:binding.executor_digest});
    const artifact = await this.options.records.artifacts.ingest({ bytes: canonicalBytes({ job: binding.job, sha256: input.sha256, rows: projected, side_effects:sideEffects, executor_declarations: { provenance: 'declared', definition_sha256: binding.executor_digest, limitations: d.limitations }, lease_drift: drift, lease_interrupted: leaseInterrupted, limits: ['目标对本次派发的报告', '未排除本地操作'] }), mediaType: 'application/json',
      origin: { generated: { generator: 'dispatch@1', inputs: [response.source, `src:${input.sha256}`] } }, author: { user: null }, provenanceType: 'projected', visibility: { readers: [binding.user], admins: true, packs: [], shareable: false } });
    await this.journal.append(binding, 'result', 'read_back', 'completed', { reference: `src:${artifact.body.sha256}`, items: projected.length, no_verdict: projected.length }, [response.source]);
    await this.release(binding, client, remoteLease);
    await this.journal.append(binding, 'complete', 'read_back', 'completed', { done: true, outcome: 'effective' });
    return this.status(by, binding.job);
  }
}
