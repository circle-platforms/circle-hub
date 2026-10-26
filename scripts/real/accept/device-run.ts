// Integrator-only administrator CLI orchestration. Circle owns booking, planning, generation and upload.
// Importing this module does no I/O. This entry point is deliberately absent from CI and npm scripts.
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { EffectOutcomeSchema, DynamicTerminalSchema, labelOf } from '../../../contracts/generated/vocabulary.ts';
import { canonicalBytes, sha256Hex, parseStrictJson } from '../../../hub/records/api.ts';
import { ExecutorDefinition, ExecutorSource, resolveExecutorValues, type JobStatus } from '../../../hub/dispatch/api.ts';
import {referencesIn} from '../../../contracts/src/variables.ts';
import { staging, FactError, requireFact } from '../convert/io.ts';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const runId = z.string().regex(/^run_[0-9a-hjkmnp-tv-z]{26}$/);
const executorId = z.string().regex(/^exe_[0-9a-hjkmnp-tv-z]{26}$/);
export const Configuration = z.strictObject({
  cli: z.strictObject({ command: z.string().min(1), arguments: z.array(z.string()).default([]) }),
  definition: z.string().min(1), selection: z.string().min(1),
  contract: z.string().min(1), inventory: z.string().min(1), profile: z.string().min(1),
});
export function argumentsOf(argv: string[]) {
  const parsed = z.strictObject({ '--config': z.string().min(1), '--out': z.string().min(1), '--executor': executorId });
  requireFact(argv.length === 6, '用法：--config <文件> --out <仓库外暂存目录> --executor <exe_…>');
  const entries: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) { requireFact(!Object.hasOwn(entries, argv[i]), '参数重复；每项只填一次'); entries[argv[i]] = argv[i + 1]; }
  const result = parsed.safeParse(entries); requireFact(result.success, '参数缺失、未知或执行器编号不合式；请核对用法'); return result.data;
}
export function parseJobReply(reply: string): JobStatus {
  const rows = [...reply.matchAll(/阶段 ([a-z_]+)；码 ([a-z_]+)[^\n]*?作业摘要 ([a-f0-9]{64})；冻结 ([01])；动作 (\d+)/g)];
  requireFact(rows.length === 1, '缺少唯一完整作业回执；保留检查点，请管理员按作业摘要查询和对账，不能重发');
  const [, phase, outcome, job, frozen, events] = rows[0];
  const parsed = EffectOutcomeSchema.safeParse(outcome); requireFact(parsed.success, '作业码不认识；请管理员查询原作业，不能重发');
  const result = /结果引用 (src:[a-f0-9]{64})/.exec(reply)?.[1];
  return { job, phase, outcome: parsed.data, frozen: frozen === '1', events: Number(events), ...(result ? { result } : {}) };
}
export function continuation(previous: string, current: string, answer: string): string {
  requireFact(hash.safeParse(previous).success && hash.safeParse(current).success && current !== previous, '执行器定义摘要未改变；请集成者用首例结果更新归属认证，再导出定义重跑');
  requireFact(answer === '已用首例证据更新认证', '缺集成者明确确认：请输入“已用首例证据更新认证”；这是人工确认，不是机械核对认证字段');
  return '人工确认，不是机械核对认证字段';
}
export function checkedDefinition(input: unknown, id: string, listed: string,values:ReadonlyMap<string,unknown>=new Map()): { definition: ExecutorDefinition; digest: string;resolved_digest:string } {
  requireFact(object(input), '本地执行器定义不是对象；请导出登记定义');
  const parsed = ExecutorSource.safeParse({ ...input, id }); requireFact(parsed.success, '本地执行器定义无效；请管理员核对当前派发格式和固定 CA');
  const source=parsed.data;
  const definition=resolveExecutorValues(source,values);
  requireFact(new URL(definition.endpoint).protocol === 'https:' && definition.ca.length > 0 && definition.enabled, '真机脚本只接受启用的 HTTPS 执行器和固定 CA；请管理员修正定义');
  const digest = sha256Hex(canonicalBytes(source)),resolved_digest=sha256Hex(canonicalBytes(definition));
  const matching = listed.split('\n').filter(line => line.startsWith(`执行器编号 ${id}；`));
  requireFact(matching.length === 1 && matching[0].includes(`定义摘要 ${digest}；启用 1；具备派发登记 1`), '本地定义与 executor list 的已登记摘要不等或登记未完成；请导出当前定义并核对后重跑');
  requireFact(matching[0].includes(`；解析后摘要 ${resolved_digest}；`),'解析后定义摘要与当前变量不等；重做第零步核对当前变量与执行器');
  return { definition, digest,resolved_digest };
}

const qualificationFields = ['missing_fact', 'missing_facts', 'reason', 'next_action', 'qualifier', 'nature', 'provenance', 'marks', 'accepted_as_fact', 'limits', 'limitation'] as const;
const copied = (value: Record<string, unknown>, fields: readonly string[]) => Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
export function reportLines(value: unknown): string[] {
  requireFact(object(value) && Array.isArray(value.rows), '结果源缺少逐用例结论；请管理员补取原作业结果');
  const lines = value.rows.map((r, index) => {
    requireFact(object(r), '逐用例结果形状不符；请管理员核对结果源');
    // Use the generated vocabulary; target words never become an asserted dynamic verdict here.
    const verdict = DynamicTerminalSchema.safeParse(r.dynamic_terminal); requireFact(verdict.success, '逐用例结论码不认识；请管理员核对派发版本');
    const reported = r.reported_terminal == null ? null : DynamicTerminalSchema.safeParse(r.reported_terminal);
    requireFact(reported === null || reported.success, '目标报告的结论码不认识；请管理员按结果源核对，不能据此继续');
    if (verdict.data === 'no_verdict') {
      const need = (ok: unknown, field: string) => requireFact(ok, `/rows/${index}/${field} 缺少无判定结果的缺口或限定说明；请管理员核对派发服务版本和原作业记录，修复结果导出后重读原作业，保留检查点并暂停本例，不重发`);
      need(text(r.missing_fact).trim() || Array.isArray(r.missing_facts) && r.missing_facts.length > 0 && r.missing_facts.every(v => typeof v === 'string' && v.trim()), 'missing_fact 或 missing_facts');
      need(Array.isArray(r.limits) && r.limits.every(v => typeof v === 'string' && v.trim()) && r.limits.includes(labelOf('qualifier_mark', 'local_ops_not_excluded')), 'limits');
    }
    return JSON.stringify({ case_index: index + 1, reported_terminal: reported === null ? null : reported.data, dynamic_terminal: verdict.data, ...copied(r, qualificationFields) });
  });
  // Preserve the entire observation block without inventing events from absent log markers.
  if (Object.hasOwn(value, 'side_effects')) lines.push(JSON.stringify({ side_effects: value.side_effects }));
  if (Object.hasOwn(value, 'executor_declarations')) lines.push(JSON.stringify({ executor_declarations: value.executor_declarations }));
  return lines;
}

export function batchQualifications(results: readonly unknown[]) {
  return results.map((result, index) => {
    const lines = reportLines(result);
    requireFact(object(result) && Array.isArray(result.rows), '批次缺少已核对结果；请管理员补取结果源后重跑');
    return { case_index: index + 1, rows: lines.slice(0, result.rows.length).map(line => {
      const row = JSON.parse(line) as Record<string, unknown>;
      return { case_index: row.case_index, ...copied(row, qualificationFields) };
    }), ...copied(result, [...qualificationFields, 'qualifier_marks']) };
  });
}

export interface PreparedCase { run: string; sha256: string; booking: string }
export interface CasePorts {
  prepare(id: string): Promise<PreparedCase>;
  confirm(id: string, sha256: string): Promise<string>;
  dispatch(prepared: PreparedCase): Promise<JobStatus>;
  result(state: JobStatus): Promise<void>;
  release(booking: string): Promise<void>;
  save(id: string, prepared: PreparedCase, state: JobStatus): Promise<void>;
}
export async function runCases(ids: string[], priorBookings: string[], p: CasePorts): Promise<void> {
  const bookings = new Set(priorBookings);
  for (const id of ids) {
    const prepared = await p.prepare(id);
    requireFact(!bookings.has(prepared.booking), '每个用例必须自己占台架，不能复用上一例谱系；请 Circle 释放后重新占用并完成计划与核验');
    requireFact(await p.confirm(id, prepared.sha256) === '确认派发', '没有输入“确认派发”，本例未派发；请核对后重跑');
    const state = await p.dispatch(prepared);
    requireFact(!state.frozen && state.outcome !== 'unknown', `派发未知或冻结；请管理员先对账 circle-hub job dispose ${state.job} --reconcile <远端作业编号>，不能重发、释放或继续下一例`);
    requireFact(state.outcome === 'effective' && !!state.result, '未取得完整终态结果；请管理员读取原作业状态和结果，不能继续下一例');
    await p.result(state); await p.release(prepared.booking); await p.save(id, prepared, state); bookings.add(prepared.booking);
  }
}
export function checkedRunId(value: string): string {
  requireFact(runId.safeParse(value).success, '核验运行号不合式；请 Circle 完成第 4 到 6 步后从回执原样复制'); return value;
}
/** The CLI exports full RunDetail. Never infer an automation identity from its display text. */
export function verification(value: unknown, autoid: string, manifest: string): { run: string; predecessor: string; sha256: string } {
  requireFact(object(value) && object(value.run) && object(value.latest) && object(value.latest.result), '缺完整核验运行及结果；请 Circle 读回原记录并完成核验');
  const run = value.run, result = value.latest.result;
  requireFact(text(run.pack).startsWith('case-compile@') && Array.isArray(run.items) && run.items.length === 1 && object(run.items[0]) && object(run.items[0].fields) && run.items[0].fields.autoid === autoid, '核验运行不是本例的唯一目标条目；请 Circle 按所选编号重开核验');
  requireFact(result.acceptance === 'accepted' && Array.isArray(result.errors) && result.errors.length === 0 && object(result.partitions), '核验结果未受理或仍有反驳；请 Circle 按回执修复');
  const parts = result.partitions; const rows = Object.values(parts).flatMap(v => Array.isArray(v) ? v : []);
  requireFact(Array.isArray(parts.delivered) && parts.delivered.length === 1 && rows.length === 1 && object(rows[0]) && Array.isArray(rows[0].requirements) && rows[0].requirements.length > 0 && rows[0].requirements.every(r => object(r) && r.status === 'satisfied'), '核验仍有未满足要求；请 Circle 补齐事实、重新生成上传并核验');
  const sources = Array.isArray(run.sources) ? run.sources.filter(object) : [];
  for (const [slot, name] of [['contract', 'runner-contract'], ['profile', 'runtime-profile'], ['inventory', 'bed-topology']]) requireFact(sources.some(s => s.slot === slot && text(s.external).startsWith(`doc:doc:${name}@`)), '核验未绑定固定部署文档名；请 Circle 用 runner-contract、runtime-profile、bed-topology 重开运行');
  requireFact(sources.some(s => s.slot === 'inventory' && s.reference === `src:${manifest}`), '核验绑定的清单与执行器期望不同；请用当前清单重跑计划和核验');
  const workbook = sources.filter(s => s.slot === 'workbook' && s.role === 'artifact_under_verification');
  requireFact(workbook.length === 1 && /^src:[a-f0-9]{64}$/.test(text(workbook[0].reference)), '核验缺唯一工作簿原件；请 Circle 生成、上传并重开核验');
  return { run: checkedRunId(text(run.run)), predecessor: checkedRunId(text(run.predecessor)), sha256: text(workbook[0].reference).slice(4) };
}

const checkpointSchema = z.strictObject({
  schema: z.literal('device-run-checkpoint@1'), binding: hash, first_definition: hash, certified_definition: hash.optional(),
  completed: z.array(z.strictObject({ autoid: z.string(), booking: runId, job: hash, sha256: hash, result: z.string().regex(/^src:[a-f0-9]{64}$/) })),
  pending: z.strictObject({ autoid: z.string(), run: runId, booking: runId, sha256: hash, job: hash.optional() }).optional(),
});
export async function main(argv: string[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const args = argumentsOf(argv); const configPath = resolve(args['--config']); const base = dirname(configPath);
    const parsed = Configuration.safeParse(parseStrictJson(readFileSync(configPath, 'utf8'))); requireFact(parsed.success, '管理脚本配置不完整；请按 README 指定 CLI、接入文件、选择文件和执行器定义'); const config = parsed.data;
    const path = (file: string) => resolve(base, file);
    const read = (file: string) => readFileSync(path(file));
    const directory = staging(args['--out']);
    const privateFile = (name: string, value: unknown) => writeFileSync(join(directory, name), canonicalBytes(value), { mode: 0o600, flag: 'wx' });
    const say = (stage: string, fields: Record<string, unknown> = {}) => { const line = JSON.stringify({ stage, ...fields }) + '\n'; process.stdout.write(line); appendFileSync(join(directory, 'stages.jsonl'), line, { mode: 0o600 }); };
    const cli = async (command: string[], observe?: (stdout: string) => void) => {
      say('管理命令', { command: command.slice(0, 2).join(' ') });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const code = await new Promise<number>((done, reject) => {
        const child = spawn(config.cli.command, [...config.cli.arguments, ...command], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); observe?.(Buffer.concat(stdout).toString()); });
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk)); child.once('error', reject); child.once('close', result => done(result ?? 1));
      });
      const result = { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
      privateFile(`admin-${process.hrtime.bigint()}.json`, { command, ...result }); return result;
    };
    const stageZero = async () => {
      const listed = await cli(['executor', 'list']); requireFact(listed.code === 0, 'executor list 失败；请集成者核对当前部署的管理员 CLI');
      const input=parseStrictJson(read(config.definition).toString('utf8'));
      const source=ExecutorSource.parse({...input as object,id:args['--executor']});
      const values=new Map<string,unknown>();
      for(const name of new Set(referencesIn(source).filter(ref=>ref.kind==='var').map(ref=>ref.name))) {
        const value=await cli(['var','show',name,'--value']);
        requireFact(value.code===0,'普通变量 '+name+' 不可读；先 var set 后重做第零步');
        try {values.set(name,parseStrictJson(value.stdout.trimEnd().split('\n').at(-1)!));}catch{throw new FactError('普通变量 '+name+' 没有可核对的当前 JSON 值；先 var set 后重做第零步');}
      }
      const checked = checkedDefinition(input, args['--executor'], listed.stdout,values);
      say('阶段零核对', { definition_sha256: checked.digest,resolved_definition_sha256:checked.resolved_digest, https: true, fixed_ca: true }); return checked;
    };
    const checked = await stageZero();
    requireFact(checked.definition.manifest_sha256 === sha256Hex(read(config.inventory)), '本地清单不是执行器期望的那份；请用当前清单重跑计划及核验');
    // Administrative script prints the fixed publication commands; the integrator publishes explicitly.
    for (const [name, file] of [['runner-contract', config.contract], ['bed-topology', config.inventory], ['runtime-profile', config.profile]]) {
      say('部署文档原件', { document: name, sha256: sha256Hex(read(file)) });
      process.stdout.write(`circle-hub doc put ${name} ${quote(path(file))}\n`);
    }
    const selection = parseStrictJson(read(config.selection).toString('utf8'));
    requireFact(object(selection) && Array.isArray(selection.autoids) && selection.autoids.length === 5 && selection.autoids.every(id => typeof id === 'string' && id.trim() === id && id.length > 0) && new Set(selection.autoids).size === 5 && (selection.case_rule === 'marked' || selection.case_rule === 'tagged'), '选择文件不是五个精确 YES 用例；请集成者用 auto-cases.ts 从原脑图重新转换');
    const ids = selection.autoids as string[];
    const binding = sha256Hex(canonicalBytes({ executor: args['--executor'], config, files: [config.contract, config.inventory, config.profile, config.selection].map(file => sha256Hex(read(file))) }));
    const statePath = join(directory, 'device-run-state.json');
    const state = existsSync(statePath) ? checkpointSchema.parse(parseStrictJson(readFileSync(statePath, 'utf8'))) : checkpointSchema.parse({ schema: 'device-run-checkpoint@1', binding, first_definition: checked.digest, completed: [] });
    requireFact(state.binding === binding && state.completed.every((c, i) => c.autoid === ids[i]) && new Set(state.completed.map(c => c.booking)).size === state.completed.length, '检查点与批次配置、输入或独立谱系不一致；请使用对应原件核对检查点，不能覆盖旧批次');
    const save = () => { writeFileSync(statePath + '.next', canonicalBytes(state), { mode: 0o600 }); renameSync(statePath + '.next', statePath); };
    save();
    const show = async (id: string): Promise<Record<string, unknown>> => { const result = await cli(['run', 'show', checkedRunId(id), '--json']); requireFact(result.code === 0, '运行导出失败；请 Circle 给出可读的本例运行号，或请管理员核对原记录'); const value = parseStrictJson(result.stdout); requireFact(object(value) && object(value.run), '运行导出形状不符；请管理员核对当前部署'); return value; };
    const readResult = async (reference: string) => {
      requireFact(!!reference, '缺结果源引用；请管理员只读补取原作业结果');
      const file = join(directory, `result-${process.hrtime.bigint()}.json`);
      const exported = await cli(['original', 'export', reference.slice(4), '--out', file]); requireFact(exported.code === 0, '结果原件导出失败；请管理员按结果引用补取，暂停下一例');
      const original = readFileSync(file); requireFact(sha256Hex(original) === reference.slice(4), '导出结果字节摘要不符；请管理员核对原作业，暂停下一例');
      return parseStrictJson(original.toString('utf8'));
    };
    const printResult = async (status: JobStatus) => {
      requireFact(status.result, '缺结果源引用；请管理员只读补取原作业结果');
      const report = await readResult(status.result);
      requireFact(object(report) && report.job === status.job && report.sha256 === state.pending?.sha256 && Array.isArray(report.rows) && report.rows.length === 1 && object(report.rows[0]) && report.rows[0].item === state.pending?.autoid, '结果原件身份、摘要或用例编号不等于本例派发；请管理员对账，暂停下一例');
      for (const line of reportLines(report)) process.stdout.write(line + '\n');
      say('本例结果', { job: status.job, reference: status.result });
    };
    const batchSummary = async (stage: string) => {
      const results: unknown[] = [];
      for (const completed of state.completed) {
        const report = await readResult(completed.result);
        requireFact(object(report) && report.job === completed.job && report.sha256 === completed.sha256 && Array.isArray(report.rows) && report.rows.length === 1 && object(report.rows[0]) && report.rows[0].item === completed.autoid, '批次结果源身份与检查点不一致；请管理员按原结果引用对账，不重发');
        results.push(report);
      }
      say(stage, { cases: state.completed.length, qualifications: batchQualifications(results) });
    };
    const release = async (booking: string) => {
      say('等待 Circle 释放本例台架', { note: '作业已有终态；请 Circle 经 test-bed 释放本例占用，再输入释放运行号' });
      const released = await show((await rl.question('输入 Circle 的释放运行号：')).trim()); const run = released.run as Record<string, unknown>;
      const groups = Array.isArray(run.groups) ? run.groups.filter(object) : [];
      requireFact(text(run.pack).startsWith('test-bed@') && groups.some(g => g.action === 'release' && g.booking === booking), '该运行不是释放本例占用；请 Circle 按本例谱系释放后给出正确运行号');
      const listed = await cli(['lease', 'list', '--prefix', `bed/${checked.definition.target}/`]); requireFact(listed.code === 0, '无法核对释放后的租约；请管理员读取原租约记录，暂停下一例');
      requireFact(!listed.stdout.split('\n').some(line => line.split('\t')[1] === booking), '本例仍持有设备；请 Circle 完成释放并补取记录，暂停下一例');
    };
    const finish = async (id: string, prepared: PreparedCase, status: JobStatus) => { state.completed.push({ autoid: id, booking: prepared.booking, job: status.job, sha256: prepared.sha256, result: status.result! }); delete state.pending; save(); };
    const pause = () => { say('首例后停止', { reference: state.completed[0].result, next_action: '集成者用首例证据认证结果归属并 executor update；导出新定义后以同一配置、暂存目录及 --executor 重跑', note: '人工确认，不是机械核对认证字段；首例无判定；未排除本地操作' }); };
    if (state.pending) {
      requireFact(state.pending.job, '派发检查点缺作业摘要；请管理员从私有命令回执或审计找原作业后对账，不能重发');
      const reply = await cli(['job', 'resume', state.pending.job]); const status = parseJobReply(reply.stdout);
      requireFact(!status.frozen && status.outcome === 'effective' && status.result, `原作业未取得可信终态；请管理员对账 circle-hub job dispose ${state.pending.job} --reconcile <远端作业编号>，不能重发或释放`);
      await printResult(status); await release(state.pending.booking); await finish(state.pending.autoid, state.pending, status);
      if (state.completed.length === 1) { pause(); return 0; }
    }
    if (state.completed.length === 5) { await batchSummary('批次已完成'); return 0; }
    if (state.completed.length && state.certified_definition !== checked.digest) {
      say('首例认证待人工确认', { reference: state.completed[0].result, note: '人工确认，不是机械核对认证字段' });
      const explanation = continuation(state.first_definition, checked.digest, await rl.question('请输入“已用首例证据更新认证”：'));
      state.certified_definition = checked.digest; save(); say('人工确认已记录', { note: explanation, definition_sha256: checked.digest });
    }
    say('管理员只读预检');
    requireFact((await cli(['job', 'precheck', '--executor', args['--executor'], '--save', join(directory, `precheck-${process.hrtime.bigint()}`)])).code === 0, '预检未通过；请管理员按私有回执补取缺失的构建、拓扑或设备事实并重跑');
    const remaining = state.completed.length ? ids.slice(state.completed.length) : ids.slice(0, 1);
    await runCases(remaining, state.completed.map(c => c.booking), {
      async prepare(id) {
        say('等待 Circle 完成本例', { case_index: state.completed.length + 1, note: 'Circle 经 test-bed 独立占台架，按 SKILL 完成填槽、生成、上传和核验；本脚本不调 MCP、不生成内容' });
        const run = checkedRunId((await rl.question('输入这个用例的核验运行号：')).trim());
        const verified = verification(await show(run), id, checked.definition.manifest_sha256!);
        const plan = (await show(verified.predecessor)).run as Record<string, unknown>;
        requireFact(text(plan.pack).startsWith('case-compile@') && runId.safeParse(plan.predecessor).success, '计划没有占台架前驱；请 Circle 独立占台架后重开计划及核验');
        const booked = (await show(text(plan.predecessor))).run as Record<string, unknown>;
        const groups = Array.isArray(booked.groups) ? booked.groups.filter(object) : [];
        requireFact(text(booked.pack).startsWith('test-bed@') && groups.some(g => g.action === 'acquire' && g.bed === checked.definition.target), '计划前驱不是本台架占用；请 Circle 重新占台架并在本例谱系完成计划及核验');
        return { run: verified.run, sha256: verified.sha256, booking: text(booked.run) };
      },
      async confirm(_id, digest) { const current = await stageZero(); requireFact(current.digest === checked.digest && current.resolved_digest===checked.resolved_digest, '执行器已更新；请重跑第零步并重新核对本例，当前不派发'); say('派发前确认', { case_index: state.completed.length + 1, sha256: digest }); return rl.question('请核对本例工作簿、执行器与台架，输入“确认派发”：'); },
      async dispatch(prepared) {
        state.pending = { autoid: ids[state.completed.length], ...prepared }; save();
        const reply = await cli(['job', 'dispatch', '--run', prepared.run, '--executor', args['--executor']], stdout => { const job = /作业摘要 ([a-f0-9]{64})/.exec(stdout)?.[1]; if (job && state.pending && state.pending.job !== job) { state.pending.job = job; save(); } });
        const dispatched = parseJobReply(reply.stdout); requireFact(dispatched.job === state.pending?.job, '派发回执作业号与先存的检查点不同；请管理员对账');
        const current = await cli(['job', 'status', dispatched.job]); requireFact(current.code === 0 || dispatched.frozen, '作业状态读取失败；请管理员查询原作业，不能重发');
        const status = parseJobReply(current.stdout); requireFact(status.job === dispatched.job, '状态回答不是原作业；请管理员核对审计，不能重发'); say('派发回执', { code: status.outcome, frozen: status.frozen, job: status.job, reference: status.result }); return status;
      }, result: printResult, release, save: finish,
    });
    if (state.completed.length === 1) pause(); else await batchSummary('批次结束');
    return 0;
  } catch (error) {
    process.stderr.write((error instanceof FactError ? error.message : '管理阶段未完成；请集成者检查仓库外私有回执和检查点，补齐具体缺口后继续；有派发检查点时只查状态和对账，不重发') + '\n'); return 1;
  } finally { rl.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
