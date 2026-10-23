// Administrator CLI only. Remote content is retained as sources; terminal output carries no remote body or resource names.
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { ExecutorRegistry, registrationMissing, observationHashes, type DispatchService, type JobStatus } from '../dispatch/api.ts';
import type { BuildKnowledge } from '../dispatch/api.ts';
import { sha256Hex, type Principal, type RecordsKit } from '../records/api.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { readSecret } from './assemble/secret-input.ts';
import { UsageError } from './errors.ts';
export const EXECUTOR_USAGE = 'add <定义文件> | update <执行器> <定义文件> [--secret] | list | disable <执行器>（密钥只从标准输入读）';
export const JOB_USAGE = 'list --executor <执行器> | conformance --executor <执行器> [--save <目录>] | precheck --executor <执行器> [--booking <运行>] [--save <目录>] | dispatch --run <核验运行> --executor <执行器> | status|resume <作业摘要> | dispose <作业摘要> --reconcile <编号> | --keep-unknown | --mark-failed --reason <原因> [--accept-possible-duplicate-effects] [--numeric-id（对账编号显式为整数）]';
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
  if (state.reason) s.out(`说明：${state.reason}`);
  if (state.missing_fact) s.out(`缺事实：${state.missing_fact}`);
  if (state.result) s.out(`结果引用 ${state.result}`);
  if (state.next_action) s.out(`下一步：${state.next_action}`);
}
async function readDefinition(s: JobCommandSession, file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(resolve(s.ctx.io.cwd, file), 'utf8')); } catch { throw new UsageError('执行器定义不是可读取的 JSON 文件'); }
}
export async function executorCommand(s: JobCommandSession, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  let parsed;
  try { parsed = parseArgs({ args: [...rest], options: { secret: { type: 'boolean' } }, allowPositionals: true, strict: true }); } catch { throw new UsageError('命令参数写法无效；密钥只从标准输入读取'); }
  if (parsed.values.secret && sub !== 'update') throw new UsageError('--secret 只用于 update');
  const by = await s.admin();
  const hub = await s.hub(sub === 'add' || sub === 'update'); const registry = new ExecutorRegistry(hub.records);
  if (sub === 'list' && !parsed.positionals.length) {
    const entries = await registry.list(by);
    for (const e of entries) s.out(`执行器编号 ${e.id}；定义摘要 ${e.digest}；启用 ${Number(e.definition.enabled)}；具备派发登记 ${Number(registrationMissing(e.definition).length === 0)}`);
    s.out(`执行器 ${entries.length}`); return 0;
  }
  if (sub === 'disable' && parsed.positionals.length === 1) {
    const e = await registry.disable(by, parsed.positionals[0]); s.out(`执行器编号 ${e.id}；定义摘要 ${e.digest}；启用 0`); return 0;
  }
  if (sub === 'add' && parsed.positionals.length === 1) {
    const input = await readDefinition(s, parsed.positionals[0]);
    const secret = await (s.options.readSecret ?? readSecret)('执行器调用密钥');
    const e = await registry.add(by, input, secret); s.out(`执行器编号 ${e.id}；定义摘要 ${e.digest}；启用 ${Number(e.definition.enabled)}；具备派发登记 ${Number(registrationMissing(e.definition).length === 0)}`); return 0;
  }
  if (sub === 'update' && parsed.positionals.length === 2) {
    const [id, file] = parsed.positionals; const definition = await readDefinition(s, file);
    const secret = parsed.values.secret ? await (s.options.readSecret ?? readSecret)('执行器调用密钥') : undefined;
    const e = await registry.update(by, id, definition, secret);
    s.out(`执行器编号 ${e.id}；定义摘要 ${e.digest}；启用 ${Number(e.definition.enabled)}；具备派发登记 ${Number(registrationMissing(e.definition).length === 0)}`); return 0;
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
  const flags: Record<string, Record<string, boolean>> = { list: {executor:true}, conformance: { executor: true, save: true }, precheck: { executor: true, booking: true, save: true }, dispatch: { run: true, executor: true }, status: {}, resume: {}, dispose: { reconcile: true, 'keep-unknown': true, 'mark-failed': true, reason: true, 'accept-possible-duplicate-effects': true, 'numeric-id': true } };
  if (!sub || !Object.hasOwn(flags, sub) || Object.keys(values).some(key => !Object.hasOwn(flags[sub], key))) throw new UsageError('该子命令不能使用这些参数');
  const by = await s.admin(); const dispatch = await service(s, sub !== 'status' && sub !== 'list');
  try {
  if(sub==='list' && values.executor && positionals.length===0) {
    const jobs=await dispatch.list(by,values.executor);for(const state of jobs)output(s,state);s.out(`未结束作业 ${jobs.length}`);return 0;
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
