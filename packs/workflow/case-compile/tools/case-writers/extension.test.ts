import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readPackDirectory, validatePack } from '../../../../../hub/runs/api.ts';
import { stage } from '../../pack-files.ts';
import {
  register, TOOL_NAME, TOOL_SCHEMA, WRITER_NAME, WRITER_TOOLS, planFileName,
  type ExtensionApi, type ModelMiddlewareLike, type TaskTool, type ToolContextLike,
} from './extension.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const later = () => new Promise<void>((resolve) => setImmediate(resolve));
type Json = { [key: string]: unknown };

class StubToolError extends Error {}
function stubApi(options: { workspace: string; settings?: Json }) {
  const controller = new AbortController();
  const registered = {
    tools: [] as Array<{ name: string; description: string; parameters: Json; execute: (args: Json, context: ToolContextLike) => unknown; options: Json | undefined }>,
    subagents: [] as Array<{ spec: { name: string; description: string; system_prompt: string }; tools: string[] | undefined }>,
    middleware: [] as Array<{ handler: ModelMiddlewareLike; slot: string | undefined }>,
  };
  const statuses: Array<string | null> = [];
  const api: ExtensionApi = {
    ToolError: StubToolError, signal: controller.signal, settings: options.settings ?? {}, workspace: options.workspace,
    setStatus: (text) => { statuses.push(text); },
    registerTool: (name, description, parameters, execute, toolOptions) => { registered.tools.push({ name, description, parameters, execute, options: toolOptions }); },
    registerSubagent: (spec, tools) => { registered.subagents.push({ spec, tools }); },
    registerMiddleware: (handler, slot) => { registered.middleware.push({ handler, slot }); },
  };
  return { api, registered, statuses, close: () => controller.abort() };
}

/** A run directory as tools/download-run.ts leaves it (items/ and briefs/), a skill directory and nothing in the plans directory. */
async function workspace(cases: Array<{ id: string | null; title?: string; brief: string | null }>) {
  const root = await mkdtemp(join(tmpdir(), 'case-writers-'));
  await mkdir(join(root, 'run', 'items'), { recursive: true }); await mkdir(join(root, 'run', 'briefs'), { recursive: true });
  await mkdir(join(root, 'skill'), { recursive: true }); await writeFile(join(root, 'skill', 'SKILL.md'), '# 合成技能\n');
  for (const [at, value] of cases.entries()) {
    const index = String(at).padStart(2, '0');
    await writeFile(join(root, 'run', 'items', `${index}.json`), JSON.stringify({ ...(value.id === null ? {} : { id: value.id }), fields: { title: value.title ?? `合成用例 ${index}` } }));
    if (value.brief !== null) await writeFile(join(root, 'run', 'briefs', `${index}.md`), value.brief);
  }
  return { root, run: join(root, 'run'), skill: join(root, 'skill'), plans: join(root, 'plans'), remove: () => rm(root, { recursive: true, force: true }) };
}

const planOf = (item: string, text = '合成自动化用例') => JSON.stringify({ item, handling: 'handled', slots: { plan: [{ text, quotes: [], data: {} }] } });
const pathOf = (message: string): string => /^要写的文件：(.+?)。/m.exec(message)?.[1] ?? '';
const indexOf = (message: string): string => /^脚本编写 (\d+)：/.exec(message)?.[1] ?? '';

/** The client's task tool as a test double: each call is one writer, `behave` decides what it does, `gate` holds all of them. */
function stubTask(behave: (index: string, message: string, context: ToolContextLike) => Promise<string>, gate?: Promise<void>) {
  const calls: Array<{ index: string; args: Json; context: ToolContextLike }> = [];
  let inFlight = 0, most = 0;
  const tool: TaskTool = {
    name: 'task',
    run: async (args, context) => {
      const message = String(args.description);
      calls.push({ index: indexOf(message), args, context });
      most = Math.max(most, ++inFlight);
      try { await gate; return await behave(indexOf(message), message, context); } finally { inFlight--; }
    },
  };
  return { tool, calls, most: () => most };
}

/** Lets the event loop turn until `count` writers have started: reading the run directory takes a few turns of it. */
async function untilStarted(task: { calls: unknown[] }, count: number): Promise<void> {
  for (let turn = 0; turn < 10_000 && task.calls.length < count; turn++) await later();
}

/** Hands the tool a model request that carries the task tool, as the harness does before every model call. */
async function seen(registered: ReturnType<typeof stubApi>['registered'], tool: TaskTool): Promise<void> {
  const [middleware] = registered.middleware;
  await middleware!.handler({ tools: [{ name: 'read_file' }, tool] }, async () => 'model answer');
}
const executeOf = (registered: ReturnType<typeof stubApi>['registered']) => registered.tools[0]!.execute;
const contextOf = (signal: AbortSignal = new AbortController().signal): ToolContextLike => ({ signal, sessionId: 'session-1', callId: 'call-1' });

test('the extension registers one writer subagent with the exact tool list, one tool and one model_call middleware, nothing else', () => {
  const { api, registered } = stubApi({ workspace: '/work' });
  register(api);
  assert.equal(registered.subagents.length, 1);
  const [{ spec, tools }] = registered.subagents as [(typeof registered.subagents)[number]];
  assert.equal(spec.name, WRITER_NAME);
  assert.ok(spec.description && spec.system_prompt);
  assert.deepEqual(tools, [...WRITER_TOOLS]);
  assert.deepEqual(tools, ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep']);
  assert.equal(registered.tools.length, 1);
  const [tool] = registered.tools as [(typeof registered.tools)[number]];
  assert.equal(tool.name, TOOL_NAME);
  assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(tool.parameters, TOOL_SCHEMA);
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['run_directory', 'plans_directory', 'skill_directory']);
  assert.equal(tool.options, undefined, 'the tool changes files, so it is not read-only and asks like any change');
  assert.deepEqual(registered.middleware.map((value) => value.slot), ['model_call']);
});

test('the middleware reads the task tool from the model request and passes the request on untouched', async () => {
  const { api, registered } = stubApi({ workspace: '/work' });
  register(api);
  const handler = registered.middleware[0]!.handler;
  const request = { system: 's', tools: [{ name: 'read_file' }, { name: 'task' }] };
  const answers: unknown[] = [];
  assert.equal(await handler(request, async (passed) => { answers.push(passed); return 'answer'; }), 'answer');
  assert.deepEqual(answers, [request]);
  assert.equal(answers[0], request, 'the same request object goes on');
  assert.equal(await handler({ system: 'child', tools: undefined }, async () => 'child answer'), 'child answer');
});

test('without a task tool the call starts nothing and says so', async () => {
  const w = await workspace([{ id: 'doc:c-0', brief: '简报' }]);
  try {
    const { api, registered } = stubApi({ workspace: w.root });
    register(api);
    await assert.rejects(async () => executeOf(registered)({ run_directory: w.run, plans_directory: w.plans, skill_directory: w.skill }, contextOf()), (error: Error) => error instanceof StubToolError && error.message.includes('task') && error.message.includes('什么都没有启动'));
    await assert.rejects(async () => { await seen(registered, { name: 'not-task' } as unknown as TaskTool); return executeOf(registered)({ run_directory: w.run, plans_directory: w.plans, skill_directory: w.skill }, contextOf()); }, StubToolError);
    assert.deepEqual(await readdir(w.root), ['run', 'skill'], 'nothing was created');
  } finally { await w.remove(); }
});

test('one writer per case starts at once; every file is read back by identity; nothing in a report is read for meaning', async () => {
  const long = '很长的报告。'.repeat(500);
  let gate: PromiseWithResolvers<void> | undefined, running: Promise<unknown> | undefined;
  const w = await workspace([
    { id: 'doc:c-0', title: '正常', brief: '# 简报 00\n简报甲' },
    { id: 'doc:c-1', brief: '# 简报 01\n简报乙' },
    { id: 'doc:c-2', brief: '# 简报 02\n简报丙' },
    { id: 'doc:c-3', brief: null },
    { id: 'doc:c-4', brief: '# 简报 04\n简报丁' },
    { id: 'doc:c-5', brief: '# 简报 05\n简报戊' },
    { id: 'doc:c-6', brief: '# 简报 06\n简报己' },
    { id: 'doc:c-7', brief: '# 简报 07\n简报庚' },
    { id: 'doc:c-8', brief: '# 简报 08\n简报辛' },
  ]);
  try {
    await mkdir(w.plans);
    const earlier = planOf('doc:c-5', '上一轮'), rewritten = planOf('doc:c-6', '上一轮');
    await writeFile(join(w.plans, planFileName('doc:c-5')), earlier); await writeFile(join(w.plans, planFileName('doc:c-6')), rewritten);
    await writeFile(join(w.plans, 'unrelated-plan.json'), planOf('doc:other'));
    gate = Promise.withResolvers<void>();
    const task = stubTask(async (index, message) => {
      const path = pathOf(message);
      switch (index) {
        case '00': await writeFile(path, planOf('doc:c-0')); return '已写出 00。\n没有缺口。';
        case '01': return '我没找到资料，没有写。';
        case '02': await writeFile(path, planOf('doc:c-1')); return '写好了。';
        case '04': throw new Error('model endpoint unavailable');
        case '05': return '上一轮的自动化用例已经合适，没改。';
        case '06': await writeFile(path, planOf('doc:c-6', '这一轮')); return '按补充改了。';
        case '07': await writeFile(path, planOf('doc:c-7')); await writeFile(join(w.plans, 'notes.json'), '{}'); return '写好了，另外留了笔记。';
        case '08': await writeFile(path, planOf('doc:c-8')); return long;
        default: throw new Error(`no behaviour for ${index}`);
      }
    }, gate.promise);
    const { api, registered, statuses } = stubApi({ workspace: w.root });
    register(api);
    await seen(registered, task.tool);
    running = executeOf(registered)({ run_directory: w.run, plans_directory: 'plans', skill_directory: w.skill, notes: { '6': '设备拒绝了第二条命令' } }, contextOf()) as Promise<Json>;
    await untilStarted(task, 8);
    assert.deepEqual(task.calls.map((call) => call.index).sort(), ['00', '01', '02', '04', '05', '06', '07', '08'], 'all eight writers started before any of them ended');
    assert.equal(task.most(), 8);
    gate.resolve();
    const result = await running as unknown as {
      summary: string; concurrency: string; counts: Record<string, number>; stray_files: string[]; next?: string; plans_directory: string;
      cases: Array<{ index: string; item: string | null; status: string; note?: string; plan_file?: string; sha256?: string; bytes?: number; report?: string; report_clipped?: boolean; title?: string }>;
    };
    for (const call of task.calls) {
      assert.equal(call.args.subagent_type, WRITER_NAME);
      assert.deepEqual(Object.keys(call.args).sort(), ['description', 'subagent_type'], 'a writer is not started in the background');
      assert.equal(call.context.sessionId, 'session-1');
      const message = String(call.args.description);
      const own = `简报${'甲乙丙丁戊己庚辛'['00,01,02,04,05,06,07,08'.split(',').indexOf(call.index)]}`;
      assert.ok(message.includes(own), `writer ${call.index} holds its own brief`);
      for (const other of ['简报甲', '简报乙', '简报丙', '简报丁', '简报戊', '简报己', '简报庚', '简报辛'].filter((value) => value !== own)) assert.ok(!message.includes(other), `writer ${call.index} does not hold ${other}`);
    }
    assert.ok(String(task.calls.find((call) => call.index === '06')!.args.description).includes('设备拒绝了第二条命令'));
    assert.ok(!String(task.calls.find((call) => call.index === '00')!.args.description).includes('主代理的补充'));
    assert.equal(result.plans_directory, join(w.root, 'plans'), 'a relative directory is the workspace\'s');
    assert.deepEqual(result.cases.map((value) => [value.index, value.status]), [['00', 'written'], ['01', 'no_file'], ['02', 'bad_file'], ['03', 'not_started'], ['04', 'error'], ['05', 'unchanged'], ['06', 'written'], ['07', 'written'], ['08', 'written']]);
    assert.deepEqual(result.counts, { written: 4, unchanged: 1, no_file: 1, bad_file: 1, error: 1, not_started: 1 });
    const byIndex = Object.fromEntries(result.cases.map((value) => [value.index, value]));
    assert.equal(byIndex['00']!.plan_file, join(w.root, 'plans', planFileName('doc:c-0')));
    assert.equal(byIndex['00']!.bytes, Buffer.byteLength(planOf('doc:c-0')));
    assert.match(byIndex['00']!.sha256!, /^[0-9a-f]{64}$/);
    assert.equal(byIndex['00']!.report, '已写出 00。\n没有缺口。');
    assert.equal(byIndex['00']!.title, '正常');
    assert.ok(byIndex['01']!.note!.includes('不存在') && byIndex['01']!.plan_file === undefined && byIndex['01']!.report!.includes('没有写'));
    assert.ok(byIndex['02']!.note!.includes('不是这条原始用例的自动化用例'), 'a plan of another item is named as that');
    assert.ok(byIndex['03']!.note!.includes('第 03 份原始用例缺少重组后的用例或手册') && byIndex['03']!.item === 'doc:c-3');
    assert.ok(byIndex['04']!.note!.includes('model endpoint unavailable'));
    assert.ok(byIndex['05']!.note!.includes('一字未变') && byIndex['05']!.sha256 !== undefined);
    assert.equal(await readFile(join(w.plans, planFileName('doc:c-5')), 'utf8'), earlier, 'the code never rewrites a plan file');
    assert.notEqual(byIndex['06']!.sha256, byIndex['05']!.sha256);
    assert.equal(byIndex['08']!.report_clipped, true);
    assert.equal(Array.from(byIndex['08']!.report!).length, 2000);
    assert.deepEqual(result.stray_files, ['notes.json'], 'a file that is no plan file and appeared during the call; the plan file of another run is left alone');
    assert.equal(result.concurrency, 'all');
    assert.ok(result.summary.startsWith('8 个编写者，同时开始：4 份自动化用例已写出，4 个要处理，1 条没有启动，自动化用例目录里多出 1 个'), result.summary);
    assert.ok(result.next!.includes('选择尚未写好的原始用例继续脚本编写') && result.next!.includes('脚本合并前移走'));
    assert.equal(statuses[0], '编写者 0/8');
    assert.ok(statuses.includes('编写者 8/8'));
    assert.equal(statuses.at(-1), null, 'the footer line is cleared');
    assert.deepEqual((await readdir(w.plans)).sort(), ['notes.json', 'unrelated-plan.json', ...['doc:c-0', 'doc:c-2', 'doc:c-5', 'doc:c-6', 'doc:c-7', 'doc:c-8'].map(planFileName)].sort());
  } finally { gate?.resolve(); await running?.catch(() => undefined); await w.remove(); }
});

test('only starts the cases asked for, and a rework is told the earlier plan is there', async () => {
  const w = await workspace([{ id: 'doc:c-0', brief: '简报甲' }, { id: 'doc:c-1', brief: '简报乙' }, { id: 'doc:c-2', brief: '简报丙' }]);
  try {
    await mkdir(w.plans);
    await writeFile(join(w.plans, planFileName('doc:c-1')), planOf('doc:c-1', '上一轮'));
    const task = stubTask(async (_index, message) => { await writeFile(pathOf(message), planOf('doc:c-1', '这一轮')); return '改好了'; });
    const { api, registered } = stubApi({ workspace: w.root });
    register(api);
    await seen(registered, task.tool);
    const result = await executeOf(registered)({ run_directory: w.run, plans_directory: w.plans, skill_directory: w.skill, only: ['1'] }, contextOf()) as { cases: Array<{ index: string; status: string }> };
    assert.deepEqual(task.calls.map((call) => call.index), ['01']);
    assert.ok(String(task.calls[0]!.args.description).includes('上一轮的自动化用例，先读它'));
    assert.deepEqual(result.cases.map((value) => [value.index, value.status]), [['01', 'written']]);
  } finally { await w.remove(); }
});

// tools/submit-plans.ts reads one directory over every run and refuses two files for one item; a plan a person or an earlier tool
// named differently is the item's file, and a second one would be refused at the submission.
test('an item whose plan file exists under another name keeps that file, and two files for one item stop the call', async () => {
  const w = await workspace([{ id: 'doc:c-0', brief: '简报甲' }, { id: 'doc:c-1', brief: '简报乙' }]);
  try {
    await mkdir(w.plans);
    await writeFile(join(w.plans, '01.json'), planOf('doc:c-1', '上一轮'));
    await writeFile(join(w.plans, 'broken.json'), '{"item": ');
    const task = stubTask(async (index, message) => { await writeFile(pathOf(message), planOf(`doc:c-${Number(index)}`, '这一轮')); return '写好'; });
    const { api, registered } = stubApi({ workspace: w.root });
    register(api);
    await seen(registered, task.tool);
    const result = await executeOf(registered)({ run_directory: w.run, plans_directory: w.plans, skill_directory: w.skill }, contextOf()) as { cases: Array<{ index: string; status: string; plan_file?: string }>; stray_files: string[] };
    assert.equal(task.calls.length, 2);
    assert.equal(pathOf(String(task.calls.find((call) => call.index === '01')!.args.description)), join(w.plans, '01.json'));
    assert.deepEqual(result.cases.map((value) => [value.index, value.status, value.plan_file]), [['00', 'written', join(w.plans, planFileName('doc:c-0'))], ['01', 'written', join(w.plans, '01.json')]]);
    assert.deepEqual(result.stray_files, [], 'no second file for the item');
    assert.equal(JSON.parse(await readFile(join(w.plans, '01.json'), 'utf8')).slots.plan[0].text, '这一轮');
    await writeFile(join(w.plans, 'copy-of-01.json'), planOf('doc:c-1'));
    task.calls.length = 0;
    await assert.rejects(async () => executeOf(registered)({ run_directory: w.run, plans_directory: w.plans, skill_directory: w.skill }, contextOf()), (error: Error) => error instanceof StubToolError && error.message.includes('01.json') && error.message.includes('copy-of-01.json') && error.message.includes('同一条原始用例'));
    assert.deepEqual(task.calls, [], 'nothing was started');
  } finally { await w.remove(); }
});

test('the settings entry max_parallel narrows the writers and the next one starts as soon as one ends', async () => {
  const w = await workspace(Array.from({ length: 5 }, (_unused, at) => ({ id: `doc:c-${at}`, brief: `简报 ${at}` })));
  try {
    const task = stubTask(async (index, message) => { await later(); await writeFile(pathOf(message), planOf(`doc:c-${Number(index)}`)); return `写好 ${index}`; });
    const { api, registered } = stubApi({ workspace: w.root, settings: { enabled: true, max_parallel: 2 } });
    register(api);
    await seen(registered, task.tool);
    const result = await executeOf(registered)({ run_directory: w.run, plans_directory: w.plans, skill_directory: w.skill }, contextOf()) as { concurrency: unknown; summary: string; counts: Record<string, number> };
    assert.equal(task.most(), 2);
    assert.equal(result.concurrency, 2);
    assert.ok(result.summary.startsWith('5 个编写者，最多同时 2 个：5 份自动化用例已写出。'), result.summary);
    assert.equal(result.counts.written, 5);
  } finally { await w.remove(); }
});

test('an abort stops anything not yet started and the cases left are listed as not started', async () => {
  const w = await workspace(Array.from({ length: 4 }, (_unused, at) => ({ id: `doc:c-${at}`, brief: `简报 ${at}` })));
  try {
    const controller = new AbortController();
    const task = stubTask(async (index, message) => { await writeFile(pathOf(message), planOf(`doc:c-${Number(index)}`)); controller.abort(); return '写好'; });
    const { api, registered } = stubApi({ workspace: w.root, settings: { max_parallel: 1 } });
    register(api);
    await seen(registered, task.tool);
    const result = await executeOf(registered)({ run_directory: w.run, plans_directory: w.plans, skill_directory: w.skill }, contextOf(controller.signal)) as { cases: Array<{ index: string; status: string; note?: string }> };
    assert.deepEqual(task.calls.map((call) => call.index), ['00']);
    assert.deepEqual(result.cases.map((value) => value.status), ['written', 'not_started', 'not_started', 'not_started']);
    assert.equal(result.cases[1]!.note, '脚本编写已停止，这条原始用例尚未开始编写');
    assert.equal(task.calls[0]!.context.signal.aborted, true, 'the writers get a signal that follows the call\'s');
  } finally { await w.remove(); }
});

test('the extension closing stops the writers too', async () => {
  const w = await workspace([{ id: 'doc:c-0', brief: '简报' }, { id: 'doc:c-1', brief: '简报' }]);
  try {
    const { api, registered, close } = stubApi({ workspace: w.root, settings: { max_parallel: 1 } });
    const task = stubTask(async (_index, _message, context) => { close(); assert.equal(context.signal.aborted, true, 'the writer is told to stop'); return '写好'; });
    register(api);
    await seen(registered, task.tool);
    const result = await executeOf(registered)({ run_directory: w.run, plans_directory: w.plans, skill_directory: w.skill }, contextOf()) as { cases: Array<{ status: string }> };
    assert.deepEqual(task.calls.map((call) => call.index), ['00']);
    assert.deepEqual(result.cases.map((value) => value.status), ['no_file', 'not_started']);
  } finally { await w.remove(); }
});

test('arguments and directories that are not what the tool needs are refused before any writer starts', async () => {
  const w = await workspace([{ id: 'doc:c-0', brief: '简报' }, { id: 'doc:c-1', brief: null }]);
  try {
    const task = stubTask(async () => { throw new Error('must not start'); });
    const { api, registered } = stubApi({ workspace: w.root });
    register(api);
    await seen(registered, task.tool);
    const base = { run_directory: w.run, plans_directory: w.plans, skill_directory: w.skill };
    const refuse = async (args: Json, text: string) => assert.rejects(async () => executeOf(registered)(args, contextOf()), (error: Error) => error instanceof StubToolError && error.message.includes(text), text);
    await refuse({ ...base, skill_directory: join(w.root, 'plans') }, '脚本编写说明');
    await refuse({ ...base, run_directory: join(w.root, 'skill') }, '原始用例目录');
    await refuse({ ...base, only: ['7'] }, '没有第 7 份原始用例');
    await refuse({ ...base, notes: { '1': '这条没有简报' } }, '第 1 份原始用例不在本次脚本编写中');
    await refuse({ ...base, only: 'all' }, '请选择要继续脚本编写的原始用例');
    await refuse({ plans_directory: w.plans, skill_directory: w.skill }, '原始用例目录');
    await refuse({ ...base, plans_directory: join(w.skill, 'SKILL.md') }, '无法写入');
    assert.deepEqual(task.calls, []);
  } finally { await w.remove(); }
});

test('a run in which no case has a brief starts nothing and lists every case', async () => {
  const w = await workspace([{ id: 'doc:c-0', brief: null }, { id: 'doc:c-1', brief: null }]);
  try {
    const task = stubTask(async () => { throw new Error('must not start'); });
    const { api, registered, statuses } = stubApi({ workspace: w.root });
    register(api);
    await seen(registered, task.tool);
    const result = await executeOf(registered)({ run_directory: w.run, plans_directory: w.plans, skill_directory: w.skill }, contextOf()) as { summary: string; counts: Record<string, number> };
    assert.deepEqual(task.calls, []);
    assert.equal(result.counts.not_started, 2);
    assert.equal(result.summary, '没有启动编写者：2 条没有启动。');
    assert.deepEqual(statuses, [null], 'no progress line for no writers, and the footer line is cleared');
  } finally { await w.remove(); }
});

// The folder is copied into a Circle home by itself (a symbolic link to a folder is skipped), so what it imports must be in it;
// and a file it imports is not read again by /reload, so it imports no file at all.
test('the extension folder is self-contained: it imports only Node built-in modules', async () => {
  const sources = (await readdir(HERE)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  assert.deepEqual(sources, ['extension.ts']);
  for (const name of sources) {
    const text = await readFile(join(HERE, name), 'utf8');
    const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n;]*?\bfrom\s+'([^']+)'/g)].map((match) => match[1]);
    assert.ok(specifiers.length > 0);
    for (const specifier of specifiers) assert.ok(specifier!.startsWith('node:'), `${name} imports ${specifier}`);
    assert.ok(!/\bimport\s*\(/.test(text), 'no dynamic import');
  }
});

test('extension.json carries a version and a description and no more than the client reads', async () => {
  const manifest = JSON.parse(await readFile(join(HERE, 'extension.json'), 'utf8')) as Json;
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/);
  assert.ok(typeof manifest.description === 'string' && manifest.description.length > 0);
  assert.deepEqual(Object.keys(manifest).sort(), ['description', 'version']);
});

test('the staged pack with the extension in it passes the Hub\'s pack validation (local tools: ES modules, Node built-ins, no credentials)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'case-writers-stage-'));
  try {
    const read = await readPackDirectory(await stage(join(dir, 'pack')));
    assert.ok(read.ok, JSON.stringify(read.ok ? '' : read.problems.slice(0, 3)));
    if (!read.ok) return;
    assert.ok(read.pack.manifest.files.some((file) => file.path === 'tools/case-writers/extension.ts'));
    assert.ok(read.pack.manifest.files.some((file) => file.path === 'tools/case-writers/extension.json'));
    assert.ok(!read.pack.manifest.files.some((file) => file.path.endsWith('.test.ts')), 'tests are not published');
    const validation = await validatePack(read.pack);
    assert.ok(validation.ok, JSON.stringify(validation.ok ? '' : validation.problems.slice(0, 5)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
