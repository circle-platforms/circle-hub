import { testEnvironmentCommand, TEST_ENVIRONMENT_USAGE } from './cli-test-environment.ts';
import { ExecutorStableName } from '../../contracts/api.ts';
import { secretUseLabels } from './secret-use-labels.ts';
// Administrator CLI only. Remote content is retained as sources; terminal output carries no remote body or resource names.
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { ExecutorNames, ExecutorRegistry, ExecutorSource, registrationMissing, observationHashes, type DispatchService, type JobStatus } from '../dispatch/api.ts';
import type { BuildKnowledge } from '../dispatch/api.ts';
import {VariableInputError,referencesIn} from '../../contracts/src/variables.ts';
import { isSha256, sha256Hex, VariableError, type Principal, type RecordsKit } from '../records/api.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { ResourceAssignmentSubject, UserId } from '../../contracts/src/common.ts';
import { CliError, UsageError } from './errors.ts';
import { decided } from './cli-arguments.ts';
import type { DispatchView } from './api.ts';
import { dispatchScopeLabel } from './dispatch-scope-label.ts';
export const EXECUTOR_USAGE = 'add --name=<名字> (<定义文件> | --reference=src:<摘要>) | name <现有执行器编号> <明确名字> | update <执行器> (<定义文件> | --reference=src:<摘要>) | assign|unassign <执行器> (--team=<团队> | --user=<账户>) | list | disable <执行器>（定义里的 credential 引用命名密钥；换值用 secret set --name）';
export const JOB_USAGE = 'list --executor <执行器> | conformance --executor <执行器> [--save <目录>] | precheck --executor <执行器> [--booking <运行>] [--save <目录>] | dispatch --run <核验运行> --executor <执行器> | explain-release --run <核验运行> --executor <执行器> | status|resume <作业摘要> | dispose <作业摘要> --reconcile <编号> | --keep-unknown | --mark-failed --reason <原因> [--accept-possible-duplicate-effects] [--numeric-id（对账编号显式为整数）]';
export interface JobCommandSession {
  ctx: { io: { cwd: string } };
  options: { readSecret?: (label: string) => Promise<string> };
  out(line: string): void;
  err(line: string): void;
  admin(): Promise<Principal>;
  records(): Promise<RecordsKit>;
  hub(requireVaultKey?: boolean): Promise<{ dispatch: DispatchService | null; records: RecordsKit; knowledge?: BuildKnowledge; deps?: { dispatch?: Pick<DispatchView, 'readiness'> } }>;
}
async function service(s: JobCommandSession, requireKey = true): Promise<DispatchService> {
  const hub = await s.hub(requireKey); if (hub.dispatch && hub.knowledge) hub.dispatch.options.knowledge = hub.knowledge; if (!hub.dispatch) throw new Error('作业服务没有可用的租约服务'); return hub.dispatch;
}
function output(s: JobCommandSession, state: JobStatus): void {
  const facts = state.job_facts;
  const attempt = state.dispatch_attempt;
  s.out(`作业摘要 ${state.job}；作业阶段 ${facts.phase ?? '未记录'}；冻结 ${facts.frozen === undefined ? '未核对' : Number(facts.frozen)}；动作 ${state.events}`);
  if (attempt) {
    const scope = dispatchScopeLabel(attempt.scope);
    s.out(`${scope}：${attempt.outcome === undefined ? '尚无可核对的结局' : labelOf('effect_outcome', attempt.outcome)}`);
    if (attempt.phase) s.out(`${scope}阶段：${attempt.phase}`);
    if (attempt.rejection_stage) s.out(`${scope}的目标拒绝阶段：${attempt.rejection_stage}`);
    for (const missing of attempt.missing_facts ?? []) s.out(`${scope}缺事实：${missing.fact}；下一步：${missing.next_action}`);
    if (attempt.result) s.out(`${scope}结果引用 ${attempt.result}`);
    if (attempt.device_return) s.out(`${scope}设备输出引用 ${attempt.device_return}`);
    if (attempt.next_action) s.out(`${scope}下一步：${attempt.next_action}`);
    for (const condition of attempt.failed_conditions ?? []) s.out(`${scope}未满足条件：${JSON.stringify(condition.pointer)}；运算 ${condition.operator}`);
    for (const check of attempt.failed_checks ?? []) s.out(`${scope}未满足核对：步骤 ${JSON.stringify(check.step)}；缺事实：${check.missing_fact}；下一步：${check.next_action}`);
    if (attempt.admin_release) for (const check of attempt.admin_release.filter(check => check.satisfied !== true)) s.out(`${scope}管理员放行说明：${JSON.stringify(check)}`);
    if (attempt.admin_release_missing) s.out(`${scope}管理员放行说明：诊断记录未能保存或读取，请查看管理员日志`);
    if (attempt.reason) s.out(`${scope}说明：${attempt.reason}`);
    if (attempt.missing_fact) s.out(`${scope}缺事实：${attempt.missing_fact}`);
  } else if (facts.operation === 'precheck') {
    s.out(`只读预检：${facts.readonly_verified === true ? '已取得全部条件通过的核对' : facts.readonly_verified === false ? '尚未取得全部条件通过的核对' : '核对结论尚未取得'}`);
  } else {
    s.out('尚无可核对的按范围派发结局；不据此认定作业未执行。');
  }
  if (facts.admission_error) s.out(`作业准入说明：${facts.admission_error.message}${facts.admission_error.fix ? '；下一步：' + facts.admission_error.fix : ''}`);
  if(facts.qualifier_marks?.length)s.out('判定限定：'+facts.qualifier_marks.map(mark=>labelOf('qualifier_mark',mark)).join('、'));
  for (const round of facts.rounds ?? []) s.out(`第 ${round.round} 轮 ${labelOf('dynamic_terminal', round.terminal)}${round.reason ? `；${labelOf('reason', round.reason)}` : ''}`);
  for(const request of facts.requests ?? [])s.out(`待终结请求 ${request.id}；问题摘要 ${request.question_sha256 ?? '历史未记录'}；期限 ${request.deadline ?? '历史未记录'}`);
  if(facts.marks?.length)s.out(`效果标记：${facts.marks.map(mark=>labelOf('effect_mark',mark)).join('、')}`);
  if(facts.disposition)s.out(`处置：${labelOf('disposition',facts.disposition)}；决定人 ${facts.decided_by ?? '未记录'}；时间 ${facts.decided_at ?? '未记录'}`);
  if(facts.unprobed_devices?.length)s.out(`未探测（非派发目标）：${facts.unprobed_devices.map(device=>`清单第 ${device.index + 1} 台（类型 ${device.type ?? '清单未声明'}）`).join('、')}；只按清单身份参与拓扑与地址绑定，不派发命令`);
  if(facts.unjudged?.length)s.out(`未对照：${facts.unjudged.map(item=>item.pointer!==undefined?`条件 ${JSON.stringify(item.pointer)}`:`座位 ${JSON.stringify(item.seat ?? '')} 的 ${item.check ?? 'version'}`).join('、')}；没有运行锁定的构建，只把设备自述记为观察，不按任何版本判断；派发时按运行锁定的构建核对`);
  for(const condition of facts.failed_conditions ?? [])s.out(`未满足条件：${JSON.stringify(condition.pointer)}；运算 ${condition.operator}`);
  for(const check of facts.failed_checks ?? [])s.out(`未满足核对：步骤 ${JSON.stringify(check.step)}${check.seat!==undefined?`；座位 ${JSON.stringify(check.seat)}`:''}${check.check!==undefined?`；检查 ${JSON.stringify(check.check)}`:''}；缺事实：${check.missing_fact}；下一步：${check.next_action}`);
  if(facts.admin_release)for(const check of facts.admin_release.filter(check=>check.satisfied!==true))s.out('管理员放行说明：'+JSON.stringify(check));
  if(facts.admin_release_missing)s.out('管理员放行说明：诊断记录未能保存或读取，请查看管理员日志');
  if (facts.reason) s.out(`作业说明：${facts.reason}`);
  if (facts.missing_fact) s.out(`作业缺事实：${facts.missing_fact}`);
  if (facts.result) s.out(`作业报告引用 ${facts.result}`);
  if (facts.next_action) s.out(`作业下一步：${facts.next_action}`);
}
export async function readUploadedCommandBytes(records: Pick<RecordsKit, 'artifacts'>, by: Principal, reference: string): Promise<Uint8Array> {
  if (!reference.startsWith('src:') || !isSha256(reference.slice(4))) throw new UsageError('上传引用须为 src:<完整摘要>，不接受片段或记录引用');
  const source = await records.artifacts.source(by, reference.slice(4), { consumer: 'function' });
  if (!source?.bytes) throw new CliError('上传原件不可读取；请核对当前账户的读取权限和原件读取策略');
  return source.bytes;
}
async function readDefinition(s: JobCommandSession, records: RecordsKit, by: Principal, file?: string, reference?: string): Promise<unknown> {
  let bytes: Uint8Array;
  if (reference !== undefined) bytes = await readUploadedCommandBytes(records, by, reference);
  else {
    try { bytes = await readFile(resolve(s.ctx.io.cwd, file!)); } catch { throw new UsageError('执行器定义不是可读取的 JSON 文件'); }
  }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new UsageError('执行器定义不是有效的 UTF-8 JSON'); }
  const parsed = ExecutorSource.safeParse(input);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map(issue => '/' + issue.path.map(segment => String(segment).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')))];
    throw new UsageError('执行器源定义字段无效：' + paths.join('、') + '；请按字段修正定义，凭据只使用命名密钥引用');
  }
  return input;
}
async function executorLine(s:JobCommandSession,registry:ExecutorRegistry,by:import('../records/api.ts').Principal,e:import('../dispatch/api.ts').RegisteredExecutor) {
 const uses = await secretUseLabels(registry.records, by, e.variables);
 s.out(`执行器编号 ${e.id}；定义摘要 ${e.digest}；启用 ${Number(e.definition.enabled)}；具备派发登记 ${Number(registrationMissing(e.definition).length===0)}；解析后摘要 ${e.resolved_digest}；引用 ${uses.join('、')||'无'}`);
}
export async function executorCommand(s: JobCommandSession, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  let parsed;
  try { parsed = parseArgs({ args: [...rest], options: { secret: { type: 'boolean' }, reference: { type: 'string' }, name: { type: 'string' }, team: { type: 'string' }, user: { type: 'string' } }, allowPositionals: true, strict: true }); } catch { throw new UsageError('命令参数写法无效；密钥只从标准输入读取'); }
  if(parsed.values.secret)throw new UsageError('--secret 已退役：用 circle-hub secret set --name <名字> 换钥匙，引用它的执行器下次开会话用新版本');
  const assignment = sub === 'assign' || sub === 'unassign';
  if (assignment) {
    if (parsed.positionals.length !== 1 || parsed.values.reference !== undefined || (parsed.values.team !== undefined) === (parsed.values.user !== undefined)) throw new UsageError('执行器分配须且只能指定 --team=<团队> 或 --user=<账户>');
  } else if (parsed.values.team !== undefined || parsed.values.user !== undefined) throw new UsageError('团队和账户参数只用于 assign/unassign');
  if (sub==='add' && !ExecutorStableName.safeParse(parsed.values.name).success) throw new UsageError('新执行器须用 --name 明确指定名字；名字不能使用内部编号');
  if (sub!=='add' && parsed.values.name!==undefined) throw new UsageError('--name 只用于登记新执行器；给现有执行器命名用 executor name <编号> <名字>');
  if (sub==='name' && (parsed.positionals.length!==2 || !ExecutorStableName.safeParse(parsed.positionals[1]).success)) throw new UsageError('给现有执行器命名：executor name <现有编号> <明确名字>');
  const reference = parsed.values.reference;
  const fileCount = sub === 'add' ? 1 : sub === 'update' ? 2 : null;
  if (reference !== undefined && (fileCount === null || parsed.positionals.length !== fileCount - 1) || fileCount !== null && reference === undefined && parsed.positionals.length !== fileCount) throw new UsageError('定义文件和 --reference 必须且只能提供一种；引用只用于 add/update');
  if (reference !== undefined && (!reference.startsWith('src:') || !isSha256(reference.slice(4)))) throw new UsageError('上传引用须为 src:<完整摘要>');
  const by = await s.admin();
  const hub = await s.hub(sub === 'add' || sub === 'update'); const registry = new ExecutorRegistry(hub.records);
  if(sub==='name'){
    const result=await new ExecutorNames(hub.records).assign(by,parsed.positionals[0],parsed.positionals[1]);
    s.out(`执行器名字 ${result.binding.name} ${result.created?'已登记':'已存在'}；源定义和历史未改变`);return 0;
  }
  if (assignment) {
    const current = await registry.readSource(parsed.positionals[0]);
    if (!current) throw new CliError('执行器不可用');
    const recipient = parsed.values.team !== undefined
      ? await hub.records.teams.get(by, parsed.values.team)
      : UserId.safeParse(parsed.values.user).success ? await hub.records.principals.get(parsed.values.user!) : await hub.records.principals.findByName(parsed.values.user!);
    if (!recipient) throw new CliError(parsed.values.team !== undefined ? '团队不可用' : '账户不可用');
    const subject = ResourceAssignmentSubject.parse(recipient.id);
    if (sub === 'assign') await decided(() => hub.records.authorizations.assignResource(by, current.id, subject));
    else await decided(() => hub.records.authorizations.unassignResource(by, current.id, subject));
    s.out(sub === 'assign' ? `测试环境 ${current.source.target} 已分配给 ${recipient.name}` : `已撤回测试环境 ${current.source.target} 给 ${recipient.name} 的分配`);
    return 0;
  }
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
  if (sub === 'add') {
    const input = await readDefinition(s, hub.records, by, parsed.positionals[0], reference);
    const e = await registry.add(by, input, parsed.values.name); s.out(`执行器名字 ${parsed.values.name} 已登记`); await executorLine(s,registry,by,e); return 0;
  }
  if (sub === 'update') {
    const [id, file] = parsed.positionals; const definition = await readDefinition(s, hub.records, by, file, reference);
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
    s.out('只读诊断范围：第 3 款放行条件和租约覆盖；派发时仍须完整重核九款');
    for(const check of report.checks)s.out(JSON.stringify(check));
    for(const row of report.rows){s.out(JSON.stringify({row_sha256:row.row_sha256,applicable:row.applicable}));for(const check of row.checks)s.out(JSON.stringify(check));}
    for(const gap of report.no_verdict)s.out(`无判定前提 ${gap.premise}；缺事实：${gap.missing_fact}；下一步：${gap.next_action}`);
    if(report.lease_coverage)s.out(JSON.stringify(report.lease_coverage));
    s.out(`放行条件满足 ${Number(report.satisfied)}`);
    const covered=report.lease_coverage?.satisfied;
    if(report.lease_coverage)s.out(`租约覆盖 ${covered===null?'未知':Number(covered)}${covered===false?'：派发会被边界拒绝':''}`);
    // Unknown is not success: the exit code is 0 only when the release conditions hold and the lineage is known to hold every key.
    return report.satisfied&&covered===true?0:1;
  }
  if (sub === 'conformance' && values.executor && positionals.length === 0) {
    const state = await dispatch.conformance(by,values.executor); output(s,state);
    if (values.save) s.out(`已导出观察 ${await exportPrecheck(s,dispatch,state.job,values.save)} 份`);
    return (await dispatch.journal.events(state.job)).some(e=>e.body.detail.conformance_verified === true) ? 0 : 1;
  }
  if (sub === 'precheck' && values.executor && positionals.length === 0) {
    const state = await dispatch.precheck(by, values.executor, values.booking); output(s, state);
    try {
      const view = (await s.hub(false)).deps?.dispatch;
      if (!view?.readiness) s.out('本地只读就绪报告未知：报告尚未接线；原预检结论不变');
      else {
        const entry = await dispatch.registry.get(values.executor);
        if (!entry) s.out('本地只读就绪报告未知：目标配置不可读取；原预检结论不变');
        else s.out('本地只读就绪报告（不作许可或拒绝）：' + JSON.stringify(await view.readiness(by, entry.definition.target)));
      }
    } catch { s.out('本地只读就绪报告未知：读取未完成；原预检结论不变'); }
    if (values.save) s.out(`已导出观察 ${await exportPrecheck(s, dispatch, state.job, values.save)} 份`);
    const events = await dispatch.journal.events(state.job); return events.some(e => e.body.detail.readonly_verified === true) ? 0 : 1;
  }
  if (sub === 'dispatch' && values.run && values.executor && positionals.length === 0) {
    const state = await dispatch.dispatch(by, values.run, values.executor, job => s.out(`阶段已预留；作业摘要 ${job}`)); output(s, state); return state.dispatch_attempt?.outcome === 'effective' && state.job_facts.frozen !== true ? 0 : 1;
  }
  if ((sub === 'status' || sub === 'resume') && positionals.length === 1) {
    const state = sub === 'status' ? await dispatch.status(by, positionals[0]) : await dispatch.resume(by, positionals[0]); output(s, state); return state.dispatch_attempt?.outcome === 'unknown' || state.job_facts.frozen === true || (state.dispatch_attempt === undefined && state.job_facts.operation === 'dispatch' && state.job_facts.admission_error === undefined) ? 1 : 0;
  }
  if (sub === 'dispose' && positionals.length === 1) {
    if (Number(values.reconcile !== undefined) + Number(values['keep-unknown'] === true) + Number(values['mark-failed'] === true) !== 1) throw new UsageError('处置必须且只能选择一个选项');
    if (values['mark-failed'] && !values.reason?.trim()) throw new UsageError('标记失败必须写 --reason');
    if (values['accept-possible-duplicate-effects'] && !values['mark-failed']) throw new UsageError('风险确认只用于标记失败');
    if (values['numeric-id'] && (values.reconcile === undefined || !/^-?(?:0|[1-9][0-9]*)$/.test(values.reconcile) || !Number.isSafeInteger(Number(values.reconcile)))) throw new UsageError('--numeric-id 要求可精确表示的十进制整数对账编号');
    const state = await dispatch.dispose(by, positionals[0], { choice: values.reconcile !== undefined ? 'reconcile' : values['keep-unknown'] ? 'keep_unknown' : 'mark_failed', remote_id: values['numeric-id'] ? Number(values.reconcile) : values.reconcile, reason: values.reason, acceptPossibleDuplicateEffects: values['accept-possible-duplicate-effects'] === true });
    output(s, state); return state.job_facts.frozen === true ? 1 : 0;
  }
  throw new UsageError(`job 的子命令：${JOB_USAGE}`);
  } finally { await dispatch.close(); }
}

export const BED_USAGE = TEST_ENVIRONMENT_USAGE + ' | baseline record <执行器> --probe <id> [--reason <说明>] | baseline list [<执行器>] | baseline show <执行器> --probe <id> | hold clear <执行器> --reason <理由>';

export async function bedCommand(s: JobCommandSession, args: readonly string[]): Promise<number> {
  const [group, sub, ...rest] = args;
  if (group !== 'baseline' && group !== 'hold') return testEnvironmentCommand(s, args);
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
      s.out(`已结清占用：执行器 ${positionals[0]}；自动化测试环境 ${result.bed}；作业 ${result.job.slice(0, 12)}；方式 admin`);
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
