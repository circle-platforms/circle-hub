// Administrator CLI only. Remote content is retained as sources; terminal output carries no remote body or resource names.
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { ExecutorRegistry, registrationMissing, observationHashes, type DispatchService, type JobStatus } from '../dispatch/api.ts';
import type { BuildKnowledge } from '../dispatch/api.ts';
import {VariableInputError,referencesIn} from '../../contracts/src/variables.ts';
import { sha256Hex, VariableError, type Principal, type RecordsKit } from '../records/api.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { UsageError } from './errors.ts';
export const EXECUTOR_USAGE = 'add <定义文件> | update <执行器> <定义文件> | list | disable <执行器>（定义里的 credential 引用命名密钥；换值用 secret set --name）';
export const JOB_USAGE = 'list --executor <执行器> | conformance --executor <执行器> [--save <目录>] | precheck --executor <执行器> [--booking <运行>] [--save <目录>] | dispatch --run <核验运行> --executor <执行器> | explain-release --run <核验运行> --executor <执行器> | status|resume <作业摘要> | dispose <作业摘要> --reconcile <编号> | --keep-unknown | --mark-failed --reason <原因> [--accept-possible-duplicate-effects] [--numeric-id（对账编号显式为整数）]';
export interface JobCommandSession {
  ctx: { io: { cwd: string } };
  options: { readSecret?: (label: string) => Promise<string> };
  out(line: string): void;
  err(line: string): void;
  admin(): Promise<Principal>;
  records(): Promise<RecordsKit>;
  hub(requireVaultKey?: boolean): Promise<{ dispatch: DispatchService | null; records: RecordsKit; knowledge?: BuildKnowledge }>;
}
async function service(s: JobCommandSession, requireKey = true): Promise<DispatchService> {
  const hub = await s.hub(requireKey); if (hub.dispatch && hub.knowledge) hub.dispatch.options.knowledge = hub.knowledge; if (!hub.dispatch) throw new Error('作业服务没有可用的租约服务'); return hub.dispatch;
}
function output(s: JobCommandSession, state: JobStatus): void {
  s.out(`阶段 ${state.phase}；码 ${state.outcome}（${labelOf('effect_outcome', state.outcome)}）；作业摘要 ${state.job}；冻结 ${Number(state.frozen)}；动作 ${state.events}`);
  if(state.qualifier_marks?.length)s.out('判定限定：'+state.qualifier_marks.map(mark=>labelOf('qualifier_mark',mark)).join('、'));
  for (const round of state.rounds ?? []) s.out(`第 ${round.round} 轮 ${labelOf('dynamic_terminal', round.terminal)}${round.reason ? `；${labelOf('reason', round.reason)}` : ''}`);
  for(const request of state.requests ?? [])s.out(`待终结请求 ${request.id}；问题摘要 ${request.question_sha256 ?? '历史未记录'}；期限 ${request.deadline ?? '历史未记录'}`);
  if(state.marks?.length)s.out(`效果标记：${state.marks.map(mark=>labelOf('effect_mark',mark)).join('、')}`);
  if(state.disposition)s.out(`处置：${labelOf('disposition',state.disposition)}；决定人 ${state.decided_by ?? '未记录'}；时间 ${state.decided_at ?? '未记录'}`);
  if(state.unprobed_devices?.length)s.out(`未探测（非派发目标）：${state.unprobed_devices.map(device=>`清单第 ${device.index + 1} 台（类型 ${device.type ?? '清单未声明'}）`).join('、')}；只按清单身份参与拓扑与地址绑定，不派发命令`);
  for(const condition of state.failed_conditions ?? [])s.out(`未满足条件：${JSON.stringify(condition.pointer)}；运算 ${condition.operator}`);
  for(const check of state.failed_checks ?? [])s.out(`未满足核对：步骤 ${JSON.stringify(check.step)}${check.seat!==undefined?`；座位 ${JSON.stringify(check.seat)}`:''}${check.check!==undefined?`；检查 ${JSON.stringify(check.check)}`:''}；缺事实：${check.missing_fact}；下一步：${check.next_action}`);
  if(state.admin_release)for(const check of state.admin_release.filter(check=>check.satisfied!==true))s.out('管理员放行说明：'+JSON.stringify(check));
  if(state.admin_release_missing)s.out('管理员放行说明：诊断记录未能保存或读取，请查看管理员日志');
  if (state.reason) s.out(`说明：${state.reason}`);
  if (state.missing_fact) s.out(`缺事实：${state.missing_fact}`);
  if (state.result) s.out(`结果引用 ${state.result}`);
  if (state.next_action) s.out(`下一步：${state.next_action}`);
}
async function readDefinition(s: JobCommandSession, file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(resolve(s.ctx.io.cwd, file), 'utf8')); } catch { throw new UsageError('执行器定义不是可读取的 JSON 文件'); }
}
async function executorLine(s:JobCommandSession,registry:ExecutorRegistry,by:import('../records/api.ts').Principal,e:import('../dispatch/api.ts').RegisteredExecutor) {
 const uses=[];for(const use of e.variables) {const version=(await registry.records.variables.history(by,'var',use.name)).find(v=>v.decision.digest===use.decision);uses.push(use.name+' 第 '+(version?.version??0)+' 版');}
 s.out(`执行器编号 ${e.id}；定义摘要 ${e.digest}；启用 ${Number(e.definition.enabled)}；具备派发登记 ${Number(registrationMissing(e.definition).length===0)}；解析后摘要 ${e.resolved_digest}；变量 ${uses.join('、')||'无'}`);
}
export async function executorCommand(s: JobCommandSession, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  let parsed;
  try { parsed = parseArgs({ args: [...rest], options: { secret: { type: 'boolean' } }, allowPositionals: true, strict: true }); } catch { throw new UsageError('命令参数写法无效；密钥只从标准输入读取'); }
  if(parsed.values.secret)throw new UsageError('--secret 已退役：用 circle-hub secret set --name <名字> 换钥匙，引用它的执行器下次开会话用新版本');
  const by = await s.admin();
  const hub = await s.hub(sub === 'add' || sub === 'update'); const registry = new ExecutorRegistry(hub.records);
  if (sub === 'list' && !parsed.positionals.length) {
    const entries=await registry.sources(by);
    for(const source of entries){
      try{const e=await registry.get(source.id);if(e){await executorLine(s,registry,by,e);if(!e.definition.calls.submit.write)s.out(`执行器 ${e.id}：写声明未写；请 executor update 补齐`);}}
      catch(error){if(!(error instanceof VariableError)&&!(error instanceof VariableInputError))throw error;const names=[...new Set(referencesIn(source.source).filter(ref=>ref.kind==='var').map(ref=>ref.name))];s.out(`执行器编号 ${source.id}；定义摘要 ${source.digest}；启用 ${Number(source.source.enabled)}；具备派发登记 0；解析后摘要 未解析；普通变量 ${names.join('、')} 缺决定或取值不合定义：先 var show <名字> --value 核对并 var set，再重做 executor list`);}
    }
    s.out(`执行器 ${entries.length}`); return 0;
  }
  if (sub === 'disable' && parsed.positionals.length === 1) {
    const e = await registry.disable(by, parsed.positionals[0]); s.out(`执行器编号 ${e.id}；定义摘要 ${e.digest}；启用 0`); return 0;
  }
  if (sub === 'add' && parsed.positionals.length === 1) {
    const input = await readDefinition(s, parsed.positionals[0]);
    const e = await registry.add(by, input); await executorLine(s,registry,by,e); return 0;
  }
  if (sub === 'update' && parsed.positionals.length === 2) {
    const [id, file] = parsed.positionals; const definition = await readDefinition(s, file);
    const e = await registry.update(by, id, definition);
    await executorLine(s,registry,by,e); return 0;
  }
  throw new UsageError(`executor 的子命令：${EXECUTOR_USAGE}`);
}
async function exportPrecheck(s: JobCommandSession, dispatch: DispatchService, job: string, destination: string): Promise<number> {
  let parent = resolve(s.ctx.io.cwd, destination); const missing: string[] = [];
  while (!await lstat(parent).then(() => true, () => false)) { missing.unshift(basename(parent)); const next = dirname(parent); if (next === parent) throw new UsageError('暂存目录不可用'); parent = next; }
  const target = join(await realpath(parent), ...missing);
  for (let dir = target;; dir = dirname(dir)) {
    if (await lstat(join(dir, '.git')).then(() => true, () => false)) throw new UsageError('--save 必须在 Git 仓库外的暂存目录');
    if (dirname(dir) === dir) break;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const events = await dispatch.journal.events(job);
  const binding = await dispatch.journal.binding(job);
  const definitionBytes = await (await s.records()).objects.get(binding.executor_digest);
  if (!definitionBytes) throw new Error('冻结的执行器定义不可读取');
  const { ExecutorDefinition } = await import('../dispatch/api.ts');
  const definition = ExecutorDefinition.parse(JSON.parse(new TextDecoder().decode(definitionBytes)));
  const refs = [...new Set(events.filter(e => /^(?:precheck(?:\.[0-9]+)?|query|submit|probe\.[0-9]+\.[^.]+)\.response$/.test(String(e.body.detail.phase))).flatMap(e => e.body.inputs).filter(r => /^src:[a-f0-9]{64}$/.test(r)))];
  const by = await s.admin(); const records = await s.records(); let count = 0; const hashes: Array<Record<string, unknown>> = [];
  for (const reference of refs) {
    const source = await records.artifacts.source(by, reference.slice(4), { consumer: 'function' });
    if (!source?.bytes) throw new Error('预检原件的读取策略未放行，不能导出');
    const file = `observation-${++count}.json`;
    await writeFile(join(target, file), source.bytes, { mode: 0o600, flag: 'wx' });
    const phase = String(events.find(e => e.body.inputs.includes(reference) && /^(?:precheck(?:\.[0-9]+)?|query|submit|probe\.[0-9]+\.[^.]+)\.response$/.test(String(e.body.detail.phase)))?.body.detail.phase);
    const step = /^precheck\.([0-9]+)\.response$/.exec(phase);
    const config = step ? definition.precheck_reads[Number(step[1]) - 1] : definition;
    const probe = /^probe\.([0-9]+)\.([^.]+)\.response$/.exec(phase);
    const tags = {operation:phase.replace(/\.response$/,''),...(probe?{seat_index:Number(probe[1]),seat:definition.probes?.seats.find(s=>s.index===Number(probe[1]))?.seat ?? null,check:probe[2]}:{})};
    const protocolPointers = probe && definition.probes ? [definition.probes.output] : phase === 'query.response' ? Object.values(definition.reconciliation ?? {}) : phase === 'submit.response' ? Object.values(definition.receipt) : [];
    const pointers = [...new Set([...protocolPointers.filter((p): p is string => typeof p === 'string' && (p === '' || p.startsWith('/'))), ...(!protocolPointers.length ? [...(config?.capture_pointers ?? []), ...(config?.conditions ?? []).map(c => c.pointer)] : [])])];
    for (const pointer of pointers) {
      try { hashes.push({ file, reference, ...tags, ...observationHashes(source.bytes, pointer, phase === 'submit.response') }); }
      catch { hashes.push({ file, reference, ...tags, pointer, original_sha256:sha256Hex(source.bytes), missing_fact: '该指针缺少有效工具回答或字段，不能计算内容摘要' }); }
    }
  }
  await writeFile(join(target, 'checksums.json'), JSON.stringify({ definition_sha256: binding.executor_digest, observations: hashes }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return count;
}
export async function jobCommand(s: JobCommandSession, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  let parsed;
  try { parsed = parseArgs({ args: [...rest], allowPositionals: true, strict: true, options: {
    executor: { type: 'string' }, booking: { type: 'string' }, save: { type: 'string' }, run: { type: 'string' }, reconcile: { type: 'string' },
    'keep-unknown': { type: 'boolean' }, 'mark-failed': { type: 'boolean' }, reason: { type: 'string' }, 'accept-possible-duplicate-effects': { type: 'boolean' }, 'numeric-id': { type: 'boolean' },
  } }); } catch { throw new UsageError('命令参数写法无效；密钥只从标准输入读取'); }
  const { positionals, values } = parsed;
  const flags: Record<string, Record<string, boolean>> = { list: {executor:true}, conformance: { executor: true, save: true }, precheck: { executor: true, booking: true, save: true }, dispatch: { run: true, executor: true }, 'explain-release':{run:true,executor:true}, status: {}, resume: {}, dispose: { reconcile: true, 'keep-unknown': true, 'mark-failed': true, reason: true, 'accept-possible-duplicate-effects': true, 'numeric-id': true } };
  if (!sub || !Object.hasOwn(flags, sub) || Object.keys(values).some(key => !Object.hasOwn(flags[sub], key))) throw new UsageError('该子命令不能使用这些参数');
  const by = await s.admin(); const dispatch = await service(s, sub !== 'status' && sub !== 'list' && sub !== 'explain-release');
  try {
  if(sub==='list' && values.executor && positionals.length===0) {
    const jobs=await dispatch.list(by,values.executor);for(const state of jobs)output(s,state);s.out(`未结束作业 ${jobs.length}`);return 0;
  }
  if(sub==='explain-release'&&values.run&&values.executor&&positionals.length===0){
    const report=await dispatch.explainRelease(by,values.run,values.executor);
    s.out('只读诊断范围：第 3 款放行条件；派发时仍须完整重核九款');
    for(const check of report.checks)s.out(JSON.stringify(check));
    for(const row of report.rows){s.out(JSON.stringify({row_sha256:row.row_sha256,applicable:row.applicable}));for(const check of row.checks)s.out(JSON.stringify(check));}
    for(const gap of report.no_verdict)s.out(`无判定前提 ${gap.premise}；缺事实：${gap.missing_fact}；下一步：${gap.next_action}`);
    s.out(`放行条件满足 ${Number(report.satisfied)}`);return report.satisfied?0:1;
  }
  if (sub === 'conformance' && values.executor && positionals.length === 0) {
    const state = await dispatch.conformance(by,values.executor); output(s,state);
    if (values.save) s.out(`已导出观察 ${await exportPrecheck(s,dispatch,state.job,values.save)} 份`);
    return (await dispatch.journal.events(state.job)).some(e=>e.body.detail.conformance_verified === true) ? 0 : 1;
  }
  if (sub === 'precheck' && values.executor && positionals.length === 0) {
    const state = await dispatch.precheck(by, values.executor, values.booking); output(s, state);
    if (values.save) s.out(`已导出观察 ${await exportPrecheck(s, dispatch, state.job, values.save)} 份`);
    const events = await dispatch.journal.events(state.job); return events.some(e => e.body.detail.readonly_verified === true) ? 0 : 1;
  }
  if (sub === 'dispatch' && values.run && values.executor && positionals.length === 0) {
    const state = await dispatch.dispatch(by, values.run, values.executor, job => s.out(`阶段已预留；作业摘要 ${job}`)); output(s, state); return state.outcome === 'effective' && !state.frozen ? 0 : 1;
  }
  if ((sub === 'status' || sub === 'resume') && positionals.length === 1) {
    const state = sub === 'status' ? await dispatch.status(by, positionals[0]) : await dispatch.resume(by, positionals[0]); output(s, state); return state.outcome === 'unknown' ? 1 : 0;
  }
  if (sub === 'dispose' && positionals.length === 1) {
    if (Number(values.reconcile !== undefined) + Number(values['keep-unknown'] === true) + Number(values['mark-failed'] === true) !== 1) throw new UsageError('处置必须且只能选择一个选项');
    if (values['mark-failed'] && !values.reason?.trim()) throw new UsageError('标记失败必须写 --reason');
    if (values['accept-possible-duplicate-effects'] && !values['mark-failed']) throw new UsageError('风险确认只用于标记失败');
    if (values['numeric-id'] && (values.reconcile === undefined || !/^-?(?:0|[1-9][0-9]*)$/.test(values.reconcile) || !Number.isSafeInteger(Number(values.reconcile)))) throw new UsageError('--numeric-id 要求可精确表示的十进制整数对账编号');
    const state = await dispatch.dispose(by, positionals[0], { choice: values.reconcile !== undefined ? 'reconcile' : values['keep-unknown'] ? 'keep_unknown' : 'mark_failed', remote_id: values['numeric-id'] ? Number(values.reconcile) : values.reconcile, reason: values.reason, acceptPossibleDuplicateEffects: values['accept-possible-duplicate-effects'] === true });
    output(s, state); return state.frozen ? 1 : 0;
  }
  throw new UsageError(`job 的子命令：${JOB_USAGE}`);
  } finally { await dispatch.close(); }
}

export const BED_USAGE = 'baseline record <执行器> --probe <id> [--reason <说明>] | baseline list [<执行器>] | baseline show <执行器> --probe <id> | hold clear <执行器> --reason <理由>';

export async function bedCommand(s: JobCommandSession, args: readonly string[]): Promise<number> {
  const [group, sub, ...rest] = args;
  if (group !== 'baseline' && group !== 'hold') throw new UsageError(`bed 的子命令：${BED_USAGE}`);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        probe: { type: 'string' },
        reason: { type: 'string' },
      },
    });
  } catch {
    throw new UsageError('命令参数写法无效');
  }
  const { positionals, values } = parsed;
  const by = await s.admin();
  const dispatch = await service(s, group === 'baseline' && sub === 'record');
  try {
    if (group === 'hold') {
      if (sub !== 'clear' || positionals.length !== 1) throw new UsageError(`bed hold clear 用法：hold clear <执行器> --reason <理由>`);
      if (!values.reason || !values.reason.trim() || values.reason.includes('\n') || values.reason.includes('\r')) throw new UsageError('结清理由必须是一行非空说明');
      const result = await dispatch.clearBedHold(by, positionals[0], values.reason.trim());
      if (!result.cleared) { s.out('没有未结清的占用'); return 0; }
      s.out(`已结清占用：执行器 ${positionals[0]}；台架 ${result.bed}；作业 ${result.job.slice(0, 12)}；方式 admin`);
      return 0;
    }
    if (sub === 'record') {
      if (positionals.length !== 1 || !values.probe) throw new UsageError(`bed baseline record 用法：baseline record <执行器> --probe <id> [--reason <说明>]`);
      const executor = positionals[0];
      const result = await dispatch.recordBaseline(by, executor, values.probe, values.reason);
      s.out(`已登记基线：执行器 ${result.executor}；探针 ${result.probe}；原件摘要 ${result.sha256}；引用 ${result.reference}${result.reason ? `；理由 ${result.reason}` : ''}`);
      return 0;
    }
    if (sub === 'list') {
      if (positionals.length > 1) throw new UsageError(`bed baseline list 用法：baseline list [<执行器>]`);
      const executor = positionals[0];
      const records = await dispatch.listBaselines(by, executor);
      for (const item of records) {
        s.out(`执行器 ${item.executor}；探针 ${item.probe}；原件摘要 ${item.sha256}；引用 ${item.reference}；登记人 ${item.recorded_by}；登记时间 ${item.created_at}${item.reason ? `；理由 ${item.reason}` : ''}`);
      }
      s.out(`登记基线 ${records.length} 条`);
      return 0;
    }
    if (sub === 'show') {
      if (positionals.length !== 1 || !values.probe) throw new UsageError(`bed baseline show 用法：baseline show <执行器> --probe <id>`);
      const executor = positionals[0];
      const item = await dispatch.showBaseline(by, executor, values.probe);
      s.out(`执行器 ${item.executor}；探针 ${item.probe}；原件摘要 ${item.sha256}；引用 ${item.reference}；登记人 ${item.recorded_by}；登记时间 ${item.created_at}${item.reason ? `；理由 ${item.reason}` : ''}`);
      s.out(item.text);
      return 0;
    }
    throw new UsageError(`bed 的子命令：${BED_USAGE}`);
  } finally {
    await dispatch.close();
  }
}
