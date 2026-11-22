import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandText } from '../functions/length-literals.ts';
import { collect, forLead, initState, main, next, recordStatus, reopen, resume, retry, rework, summary, type Gates, type PipelineState, type RunTool, type ToolRun } from './pipeline.ts';

const ok = (stdout = '{"ok":true}'): ToolRun => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string): ToolRun => ({ code: 1, stdout: '', stderr });
const accepted = (item: string, status = 'satisfied') => ok(`合成答复\n供模型引用\n${JSON.stringify({ call_result: 'ok', acceptance: 'accepted', result: { partitions: { delivered: [{ item, requirements: [{ requirement: 'record', status, claims: status === 'satisfied' ? [] : [{ statement: { text: '合成：缺前置', verdict: 'refute' } }] }] }] } } })}`);

async function world(cases: number) {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-'));
  process.chdir(dir);
  for (const run of ['recompose-run', 'plan-run']) await mkdir(join(run, 'items'), { recursive: true });
  await mkdir(join('plan-run', 'briefs'), { recursive: true }); await mkdir('records', { recursive: true });
  for (let n = 0; n < cases; n++) {
    const i = String(n).padStart(2, '0'), autoid = `99000000000000${String(1000 + n)}`;
    await writeFile(join('recompose-run', 'items', `${i}.json`), JSON.stringify({ id: `n/r${i}`, fields: { case_id: autoid, node: `n/${i}` } }));
    await writeFile(join('plan-run', 'items', `${i}.json`), JSON.stringify({ id: `doc:${i}`, fields: { autoid, title: `合成用例 ${i}` }, location: { selector: `n/${i}` } }));
  }
  return dir;
}
function tools(script: (tool: string, args: string[]) => ToolRun | undefined) {
  const calls: Array<{ tool: string; args: string[]; stdin?: string }> = [];
  const run: RunTool = async (skill, tool, args, stdin) => {
    calls.push({ tool: `${skill}/${tool}`, args, stdin });
    if (tool === 'task-brief.ts') return ok(`派发提示 ${args[args.indexOf('--role') + 1]} ${args[args.indexOf('--case') + 1]}`);
    if (tool === 'refresh-late.ts') { for (const name of ['00', '01', '02', '03', '04', '05', '06', '07']) await writeFile(join('plan-run', 'briefs', `${name}.md`), '合成简报'); return ok(); }
    return script(tool, args) ?? ok();
  };
  return { run, calls };
}
const gates = (run: RunTool): Gates => ({ run, hub: 'http://127.0.0.1:9/mcp', plumb: 'https://127.0.0.1:9', token: 'synthetic-token-1234', plumbKey: 'synthetic-plumb-key' });
const OPEN = { recompose_run: 'run_01recomposerecompose00', plan_run: 'run_01planplanplanplanplan00' };

test('init queues every case paired by node and starts six recomposers; the seventh waits', async () => {
  await world(8);
  const t = tools(() => undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  assert.equal(state.cases.length, 8);
  assert.deepEqual(state.cases.map((c) => c.recompose.item), ['n/r00', 'n/r01', 'n/r02', 'n/r03', 'n/r04', 'n/r05', 'n/r06', 'n/r07']);
  const { main } = await import('./pipeline.ts');
  const out: string[] = []; const w = process.stdout.write; process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
  await writeFile('open-compile.json', JSON.stringify(OPEN));
  try { assert.equal(await main(['init', '--recompose-run', 'recompose-run', '--plan-run', 'plan-run', '--open', 'open-compile.json', '--model', 'synthetic-model', '--state', 'pipeline.json'], async () => [], t.run), 0); } finally { process.stdout.write = w; }
  const step = JSON.parse(out.join(''));
  assert.equal(step.actions, undefined);
  assert.deepEqual(step.to_start, ['重组 00', '重组 01', '重组 02', '重组 03', '重组 04', '重组 05']);
  assert.match(step.message, /^待派 6 个子代理；在跑 6 个（含待派），排队 2 条，就绪 0 条，停下 0 条。待派的 6 个由编写循环派发：照第 0 节启动编写循环（workflows\/compile-loop\.js），不逐个派 task$/);
  assert.equal((JSON.parse(readFileSync('pipeline.json', 'utf8')) as PipelineState).open, 'open-compile.json', 'the state keeps the open file the merge takes');
  assert.equal(step.queued, 2);
  const asked = async (): Promise<{ actions: Array<{ label: string; subagent_type: string; description: string }>; queued: number }> => {
    const lines: string[] = []; process.stdout.write = ((s: string) => { lines.push(s); return true; }) as typeof process.stdout.write;
    try { assert.equal(await main(['resume', '--state', 'pipeline.json', '--hub', 'http://127.0.0.1:9/mcp', '--plumb', 'https://127.0.0.1:9'], async () => ['synthetic-token-1234', 'synthetic-plumb-key'], t.run), 0, lines.join('')); } finally { process.stdout.write = w; }
    return JSON.parse(lines.join(''));
  };
  const first = await asked();
  assert.deepEqual(first.actions.map((a) => [a.label, a.subagent_type, a.description]), [0, 1, 2, 3, 4, 5].map((n) => [`重组 0${n}`, 'case-compile:compile-recomposer', `派发提示 用例重组 99000000000000100${n}`]));
  const briefs = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').length;
  assert.deepEqual(await asked(), first);
  assert.equal(t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').length, briefs);
  assert.deepEqual((JSON.parse(readFileSync('pipeline.json', 'utf8')) as PipelineState).cases.map((c) => c.attempts.recompose), [1, 1, 1, 1, 1, 1, 0, 0]);
});

test('resume lists the task of every running case, the one a gate just dispatched among them, and refuses a state that kept no tasks', async () => {
  await world(7);
  const t = tools((tool) => tool === 'submit-records.ts' ? accepted('n/r00') : undefined);
  const state: PipelineState = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  const started = await resume(state, gates(t.run));
  assert.deepEqual(started.actions.map((a) => a.label), ['重组 00', '重组 01', '重组 02', '重组 03', '重组 04', '重组 05']);
  await writeFile(join('records', '00.json'), '{}');
  assert.deepEqual((await next(state, '重组 00', gates(t.run))).actions.map((a) => a.label), ['编写 00']);
  const again = await resume(state, gates(t.run));
  assert.deepEqual(again.actions.map((a) => [a.label, a.subagent_type]), [['编写 00', 'case-compile:compile-writer'], ...[1, 2, 3, 4, 5].map((n) => [`重组 0${n}`, 'case-compile:compile-recomposer'])]);
  assert.equal(again.actions[0]!.description, '派发提示 脚本编写 990000000000001000');
  assert.equal(again.all_done, false);
  state.cases[2]!.pending = '合成：Hub 暂时收不到';
  const withWaiting = await resume(state, gates(tools(() => bad('暂时不可用：合成')).run));
  assert.ok(!withWaiting.actions.some((a) => a.label === '重组 02'));
  assert.deepEqual(withWaiting.waiting?.map((w) => w.label), ['重组 02']);
  delete state.cases[2]!.pending;
  const lead = forLead(again);
  assert.deepEqual([(lead as { actions?: unknown }).actions, lead.to_start.length], [undefined, 6]);
  assert.deepEqual(forLead({ ...again, actions: [] }).message, again.message, 'nothing to start, nothing added');
  delete state.cases[1]!.action;
  await assert.rejects(resume(state, gates(t.run)), /这份状态没有记下 重组 01 派出的任务：不能接着派，从 init 重新开始/);
});

test('init pairs the cases of a compile run that binds its recomposition after the start, in the shape the Hub exports them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-late-'));
  process.chdir(dir);
  for (const run of ['recompose-run', 'plan-run']) await mkdir(join(run, 'items'), { recursive: true });
  const map = 'src:' + 'a'.repeat(64);
  for (let n = 0; n < 3; n++) {
    const i = String(n).padStart(2, '0'), node = `n/${'c'.repeat(10)}${i}`, autoid = `99000000000000${String(2000 + n)}`;
    await writeFile(join('recompose-run', 'items', `${i}.json`), JSON.stringify({ id: node, location: `${map}/kityminder@1/${node}`, fields: { case_id: autoid, node, title: `合成用例 ${i}` } }));
    await writeFile(join('plan-run', 'items', `${i}.json`), JSON.stringify({ id: `900001:${node.slice(2)}`, label: `合成用例 ${i}`, location: `${map}/kityminder@1/${node}`, fields: { autoid, title: `合成用例 ${i}`, recomposition_late: { node, run: OPEN.recompose_run, slot: 'recomposition_result', source: map } } }));
  }
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  assert.deepEqual(state.cases.map((c) => [c.plan.item, c.recompose.item]), [0, 1, 2].map((n) => [`900001:${'c'.repeat(10)}0${n}`, `n/${'c'.repeat(10)}0${n}`]));
  await writeFile(join('plan-run', 'items', '01.json'), JSON.stringify({ id: '900001:x', location: `${map}/kityminder@1/n/${'c'.repeat(10)}01`, fields: { autoid: '99000000000000' + '2001' } }));
  assert.equal((await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model')).cases[1]!.recompose.item, `n/${'c'.repeat(10)}01`);
});

test('a recomposed case is checked, submitted alone and, once the Hub accepts it, goes to a writer in the slot its recomposer left', async () => {
  await world(7);
  const t = tools((tool) => tool === 'submit-records.ts' ? accepted('n/r00') : undefined);
  const state: PipelineState = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  for (const c of state.cases.slice(0, 6)) { c.stage = 'recomposing'; c.attempts.recompose = 1; }
  await writeFile(join('records', '00.json'), '{}');
  const step = await next(state, '重组 00', gates(t.run));
  assert.deepEqual(step.actions.map((a) => [a.label, a.subagent_type]), [['编写 00', 'case-compile:compile-writer']]);
  assert.equal(step.running.length, 6, 'still six at once');
  const submit = t.calls.find((c) => c.tool === 'recompose/submit-records.ts')!;
  assert.deepEqual(submit.args.slice(-2), ['--partial', 'yes']);
  assert.equal(submit.stdin, 'synthetic-token-1234\n', 'the token goes on standard input only');
  assert.ok(t.calls.findIndex((c) => c.tool === 'recompose/check-record.ts') < t.calls.findIndex((c) => c.tool === 'recompose/submit-records.ts'), 'checked before it is submitted');
  assert.equal(state.cases[0]!.stage, 'writing');
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  const after = await next(state, '编写 00', gates(t.run));
  assert.deepEqual(after.actions.map((a) => a.label), ['重组 06']);
  assert.deepEqual(after.ready, ['00']);
});

const READ_BRIEF = ['产品声明的命令规则（run.json 的 command_policy）：只读前缀 /commands/show；互逆取值 on/off。', '', '### widget name', '# /commands/widget/name', 'widget name <name:string>', '只读前缀 /commands/show 下同样的词走到的命令：', '# /commands/show/widget/name', 'show widget name', '', '### widget size', '# /commands/widget/size', 'widget size <n:int>', '只读前缀 /commands/show 下同样的词走到的命令：', '# /commands/show/widget/size', 'show widget size [<unit:string>]'].join('\n');
async function readWorld(onStart: (line: string, out: string) => void) {
  await world(7);
  await mkdir(join('plan-run', 'sources'), { recursive: true });
  await writeFile(join('plan-run', 'sources', 'profile.json'), JSON.stringify({ bed: 'bed-a', seats: [{ object: 'DEV_0', device: 'dev0', ordinal: 0 }] }));
  const t = tools((tool) => (tool === 'submit-records.ts' ? accepted('n/r00') : undefined));
  const run: RunTool = async (skill, tool, args, stdin) => { const got = await t.run(skill, tool, args, stdin); if (tool === 'refresh-late.ts') await writeFile(join('plan-run', 'briefs', '00.md'), READ_BRIEF); return got; };
  const started: Array<{ tool: string; args: string[]; stdin?: string }> = [];
  const start = (skill: string, tool: string, args: string[], stdin?: string) => { started.push({ tool: `${skill}/${tool}`, args, stdin }); onStart(args[args.indexOf('--line') + 1]!, args[args.indexOf('--out') + 1]!); };
  const state: PipelineState = await initState('recompose-run', 'plan-run', { ...OPEN, booking: 'run_01bookingbookingbooking0' }, 'synthetic-model');
  for (const c of state.cases.slice(0, 6)) { c.stage = 'recomposing'; c.attempts.recompose = 1; }
  await writeFile(join('records', '00.json'), '{}');
  const noteOf = () => { const task = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').at(-1)!; return task.args.includes('--note') ? task.args[task.args.indexOf('--note') + 1]! : null; };
  const again = async (g: Parameters<typeof retry>[3]) => { state.cases[0]!.stage = 'stopped'; state.cases[0]!.stopped = '脚本编写 5 次仍未通过：合成'; delete state.cases[0]!.retried; await retry(state, '00', '模型决定：合成', g); return noteOf(); };
  return { state, run, calls: t.calls, started, start, noteOf, again };
}
test('before a case is written the booked device is asked, without waiting, for each read-only command of its brief that needs no parameter, and the task says where the outputs are', async () => {
  const w = await readWorld((line, out) => { if (line === 'show widget name') writeFileSync(out, '# 合成\n# 合成\nwidget-a 1\nwidget-b 2\n'); });
  assert.deepEqual({ ...w.state.device_reads }, { booking: 'run_01bookingbookingbooking0', device: 'dev0', bed: 'bed-a', lines: {}, asked: {} });
  const step = await next(w.state, '重组 00', { ...gates(w.run), start: w.start });
  assert.deepEqual(step.actions.map((a) => a.label), ['编写 00']);
  assert.equal(w.calls.some((c) => c.tool === 'case-compile/device-read.ts'), false, 'no read is waited for: the dispatch is not held');
  assert.deepEqual(w.started.map((s) => [s.tool, s.args, s.stdin]), ['show widget name', 'show widget size'].map((line) => ['case-compile/device-read.ts', ['--hub', 'http://127.0.0.1:9/mcp', '--booking', 'run_01bookingbookingbooking0', '--device', 'dev0', '--line', line, '--out', join('device-reads', line.replaceAll(' ', '-') + '.txt'), '--bed', 'bed-a'], 'synthetic-token-1234\n']), 'the command with only optional parameters is asked for as its words alone; the token goes on standard input');
  assert.match(w.noteOf()!, /供参考：设备 dev0 对本条简报里这些只读命令的输出，“show widget name”读到后在 device-reads\/show-widget-name\.txt，“show widget size”读到后在 device-reads\/show-widget-size\.txt；刚发出读取的，稍后没有这个文件就是没读成。/);
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  const later = await w.again({ ...gates(w.run), start: w.start });
  assert.equal(w.started.length, 2, 'each line is asked for once a compile');
  assert.match(later!, /“show widget name”在 device-reads\/show-widget-name\.txt（2 行），“show widget size”读到后在 device-reads\/show-widget-size\.txt；/);
  w.state.device_reads!.asked['show widget size'] = Date.now() - 200_000;
  const last = await w.again({ run: w.run });
  assert.match(last!, /“show widget name”在 device-reads\/show-widget-name\.txt（2 行）。读的时候/);
  assert.doesNotMatch(last!, /show widget size/);
});
test('a test bed that offers no read is not asked again once three lines had their time with no output, and a start that breaks never stops the dispatch', async () => {
  const w = await readWorld(() => { throw new Error('synthetic: the read could not be started'); });
  const step = await next(w.state, '重组 00', { ...gates(w.run), start: w.start });
  assert.deepEqual(step.actions.map((a) => a.label), ['编写 00'], 'the writer is dispatched all the same');
  assert.equal(w.noteOf(), null, 'nothing is said of reads that could not be started');
  const old = Date.now() - 200_000;
  w.state.device_reads = { ...w.state.device_reads!, lines: { 'show a': join('device-reads', 'show-a.txt'), 'show b': join('device-reads', 'show-b.txt'), 'show c': join('device-reads', 'show-c.txt') }, asked: { 'show a': old, 'show b': old, 'show c': old } };
  const quiet: string[] = [];
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  const note = await w.again({ ...gates(w.run), start: (_skill, _tool, args) => { quiet.push(args.join(' ')); } });
  assert.deepEqual(quiet, [], 'three lines had their time and none was read: the bed offers no read');
  assert.doesNotMatch(note ?? '', /供参考：设备/);
});

test('a record the Hub refuses goes back to a recomposer with the Hub words, and stops at the attempt limit (five unless said otherwise)', async () => {
  await world(1);
  const t = tools((tool) => tool === 'submit-records.ts' ? accepted('n/r00', 'refuted') : undefined);
  assert.equal((await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model')).max_attempts, 5);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model', 6, 3);
  state.cases[0]!.stage = 'recomposing'; state.cases[0]!.attempts.recompose = 1;
  await writeFile(join('records', '00.json'), '{}');
  const first = await next(state, '重组 00', gates(t.run));
  assert.equal(first.actions[0]!.label, '重组 00');
  const note = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.match(note[note.indexOf('--note') + 1]!, /Hub 核对这一条没有通过：这一条在分区 delivered，record 要求项为 refuted：合成：缺前置/);
  await next(state, '重组 00', gates(t.run));
  const last = await next(state, '重组 00', gates(t.run));
  assert.equal(last.actions.length, 0);
  assert.match(last.stopped[0]!.reason, /^用例重组 3 次仍未通过：Hub 核对这一条没有通过/);
  assert.equal(last.all_done, true);
});

test('a written case is ready only after the plan check, the command check, the fidelity audit and a last plan check all pass', async () => {
  await world(1);
  let checks = 0;
  const t = tools((tool) => tool === 'check-plan.ts' ? (++checks === 1 ? bad('计划自检：合成问题') : ok()) : undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  const c = state.cases[0]!; c.stage = 'writing'; c.attempts.write = 1;
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  const retry = await next(state, '编写 00', gates(t.run));
  assert.equal(retry.actions[0]!.label, '编写 00', 'a failed plan check goes back to the writer');
  const done = await next(state, '编写 00', gates(t.run));
  assert.deepEqual(t.calls.slice(-5).map((x) => x.tool), ['case-compile/check-plan.ts', 'case-compile/cmd-verify-plumb.ts', 'case-compile/fidelity-plumb.ts', 'case-compile/fidelity-apply.ts', 'case-compile/check-plan.ts']);
  assert.equal(t.calls.find((x) => x.tool === 'case-compile/cmd-verify-plumb.ts')!.stdin, 'synthetic-plumb-key\n');
  assert.deepEqual(done.ready, ['00']); assert.equal(done.all_done, true);
  await collect(state, 'plans');
});

test('a Hub answer longer than submit-records prints is read from the file it names (round 39: every answer was over 100 000 characters)', async () => {
  await world(2);
  const whole = accepted('n/r00').stdout;
  await writeFile(join('records', 'answer-1-1.txt'), whole);
  const t = tools((tool) => tool === 'submit-records.ts' ? ok(`2 条重组后的用例已交给 Hub 核对\n${whole.slice(0, 40)}\nHub 答复共 ${whole.length} 字符，全文在 records/answer-1-1.txt，请分段读完\n`) : undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  state.cases[0]!.stage = 'recomposing'; state.cases[0]!.attempts.recompose = 1;
  await writeFile(join('records', '00.json'), '{}');
  const step = await next(state, '重组 00', gates(t.run));
  assert.deepEqual(step.actions.map((a) => a.label), ['编写 00', '重组 01']);
  assert.equal(state.cases[0]!.attempts.recompose, 1, 'no second recomposer for a record the Hub accepted');
});

test('a local record check that only cannot read a reference still sends the record to the Hub; a refutation goes back to the recomposer', async () => {
  await world(1);
  const verdict = (v: string) => ({ code: 1, stdout: '参数无效：文件 records/00.json 未通过重组记录自检\n' + JSON.stringify({ ok: false, problems: [{ code: 'missing_input', verdict: v, message: '合成：本轮读不到的引用' }] }), stderr: '' });
  let local = verdict('unknown');
  const t = tools((tool) => tool === 'check-record.ts' ? local : tool === 'submit-records.ts' ? accepted('n/r00') : undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  state.cases[0]!.stage = 'recomposing'; state.cases[0]!.attempts.recompose = 1;
  await writeFile(join('records', '00.json'), '{}');
  assert.deepEqual((await next(state, '重组 00', gates(t.run))).actions.map((a) => a.label), ['编写 00'], 'the Hub settles what only it can read');
  await world(1);
  local = verdict('refute');
  const refused = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  refused.cases[0]!.stage = 'recomposing'; refused.cases[0]!.attempts.recompose = 1;
  await writeFile(join('records', '00.json'), '{}');
  const before = t.calls.filter((c) => c.tool === 'recompose/submit-records.ts').length;
  assert.deepEqual((await next(refused, '重组 00', gates(t.run))).actions.map((a) => a.label), ['重组 00']);
  assert.equal(t.calls.filter((c) => c.tool === 'recompose/submit-records.ts').length, before, 'a refuted record is not submitted');
});

test('a case stopped at the recompose gate goes to a writer once the latest Hub answer holds its record satisfied', async () => {
  await world(2);
  const t = tools((tool) => tool === 'submit-records.ts' ? accepted('n/r01') : undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  const [stopped, other] = [state.cases[0]!, state.cases[1]!];
  stopped.stage = 'stopped'; stopped.attempts.recompose = 3; stopped.stopped = '用例重组 3 次仍未通过：Hub 核对这一条没有通过：Hub 的答复里没有机器可读部分';
  other.stage = 'recomposing'; other.attempts.recompose = 1;
  await writeFile(join('records', '00.json'), '{}'); await writeFile(join('records', '01.json'), '{}');
  await writeFile(join('records', 'answer-5-1.txt'), accepted('n/r00').stdout);
  const step = await next(state, '重组 01', gates(t.run));
  assert.deepEqual(step.actions.map((a) => a.label).sort(), ['编写 00', '编写 01']);
  assert.equal(stopped.stage, 'writing'); assert.equal(stopped.stopped, undefined);
});

test('a malformed record of a case that has not passed its gate never goes along with another case\'s submission', async () => {
  await world(3);
  let seen: string[] = [];
  const t = tools((tool, args) => {
    if (tool !== 'submit-records.ts') return undefined;
    const dir = args[args.indexOf('--records') + 1]!;
    seen = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    return accepted('n/r02');
  });
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  state.cases[0]!.stage = 'writing'; state.cases[0]!.attempts = { recompose: 1, write: 1 };
  state.cases[1]!.stage = 'recomposing'; state.cases[1]!.attempts.recompose = 1;
  state.cases[2]!.stage = 'recomposing'; state.cases[2]!.attempts.recompose = 1;
  for (const i of ['00', '01', '02']) await writeFile(join('records', `${i}.json`), i === '01' ? '{"slots":{"wrapped":true}}' : '{}');
  await next(state, '重组 02', gates(t.run));
  assert.deepEqual(seen, ['00.json', '02.json'], 'the accepted record and the one at the gate, not the record still being written');
  assert.equal(state.cases[2]!.record_accepted, true);
});

test('when submit-records does not get the record to the Hub its own words go to the next recomposer', async () => {
  await world(1);
  const t = tools((tool) => tool === 'submit-records.ts' ? bad('参数无效：--records 目录下的 07.json 必须使用精简格式') : undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  state.cases[0]!.stage = 'recomposing'; state.cases[0]!.attempts.recompose = 1;
  await writeFile(join('records', '00.json'), '{}');
  await next(state, '重组 00', gates(t.run));
  const note = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.match(note[note.indexOf('--note') + 1]!, /submit-records 没有交上去：参数无效：--records 目录下的 07\.json/);
});

test('retry starts a stopped case again with the user\'s decision in every later task, and refuses a case that is not stopped', async () => {
  await world(2);
  const t = tools(() => undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  const [atRecompose, atWrite] = [state.cases[0]!, state.cases[1]!];
  atRecompose.stage = 'stopped'; atRecompose.attempts = { recompose: 3, write: 0 }; atRecompose.stopped = '用例重组 3 次仍未通过：合成冲突';
  atWrite.stage = 'stopped'; atWrite.attempts = { recompose: 1, write: 3 }; atWrite.record_accepted = true; atWrite.stopped = '脚本编写 3 次仍未通过：合成原因';
  const step = await retry(state, '00', '按手册改写：去掉冒号', { run: t.run });
  assert.deepEqual(step.actions.map((a) => a.label), ['重组 00']);
  assert.deepEqual(atRecompose.attempts, { recompose: 1, write: 0 });
  const note = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.equal(note[note.indexOf('--note') + 1], '重做这一条的依据：按手册改写：去掉冒号；停下前最后一次没有通过：用例重组 3 次仍未通过：合成冲突', 'the first subagent after a retry is told the decision and why the case stopped');
  assert.equal(atRecompose.carry, undefined, 'told once');
  await writeFile(join('plan-run', 'briefs', '01.md'), '合成简报');
  assert.deepEqual((await retry(state, atWrite.autoid, '模型决定：保留原句', { run: t.run })).actions.map((a) => a.label), ['编写 01'], 'a case stopped at writing goes back to a writer');
  const own = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.equal(own[own.indexOf('--note') + 1], '模型决定：保留原句；停下前最后一次没有通过：脚本编写 3 次仍未通过：合成原因', 'a decision the lead made by rule is not called the user\'s');
  await assert.rejects(retry(state, '00', '再来', { run: t.run }), /子代理还在做；只有停下的和已就绪的条目能 retry/);
  atWrite.stage = 'ready'; atWrite.ready_sha256 = 'a'.repeat(64); atWrite.attempts.write = 2;
  const back = await retry(state, '01', 'Hub 的原话：合成：命令不在锁定命令树里', { run: t.run });
  assert.deepEqual([back.actions.map((a) => a.label), atWrite.stage, atWrite.attempts.write, atWrite.ready_sha256], [['编写 01'], 'writing', 1, undefined]);
  const sentBack = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.equal(sentBack[sentBack.indexOf('--note') + 1], '重做这一条的依据：Hub 的原话：合成：命令不在锁定命令树里');
});

test('a case Plumb cannot judge goes to a blind fidelity review and is ready once its verdict is merged', async () => {
  await world(1);
  const t = tools((tool) => {
    if (tool === 'fidelity-plumb.ts') { return bad('参数无效：1 条自动化用例的保真核对题面超过 Plumb 的 2400 token 上限'); }
    return undefined;
  });
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  const c = state.cases[0]!; c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true;
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  await mkdir(join('cases', '00', 'audit'), { recursive: true }); await writeFile(join('cases', '00', 'audit', '00.abcd1234.brief.json'), '{}');
  const step = await next(state, '编写 00', gates(t.run));
  assert.deepEqual(step.actions.map((a) => [a.label, a.subagent_type]), [['审计 00', 'case-compile:compile-fidelity']]);
  assert.deepEqual(step.running, ['审计 00']);
  const made = t.calls.filter((x) => x.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.deepEqual([made[made.indexOf('--role') + 1], made[made.indexOf('--out') + 1]], ['保真核对', join('cases', '00', 'audit', '00.abcd1234.verdict.json')]);
  await writeFile(join('cases', '00', 'audit', '00.abcd1234.verdict.json'), '{}');
  const done = await next(state, '审计 00', gates(t.run));
  assert.deepEqual(done.ready, ['00']);
  assert.deepEqual(t.calls.slice(-2).map((x) => x.tool), ['case-compile/fidelity-apply.ts', 'case-compile/check-plan.ts']);
});

test('a plan no fidelity brief can be made of goes back to a writer with the tool\'s words; another failure of the audit tool stops the case', async () => {
  await world(2);
  const said = '参数无效：author_step_refs 要写本条作者步骤的编号（重组记录里作者步骤的 id），这些不是：00.json（doc:00）：/steps/1/author_step_refs/1 写的是 "a5"；本条作者步骤编号：a2、a3';
  const t = tools((tool, args) => (tool === 'fidelity-plumb.ts' ? bad(args.join(' ').includes(join('cases', '00')) ? said : '不存在：合成的运行目录读不到') : undefined));
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  for (const c of state.cases) { c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true; await mkdir(join('cases', c.k, 'plan'), { recursive: true }); await writeFile(join('cases', c.k, 'plan', `${c.k}.json`), '{}'); }
  const step = await next(state, '编写 00', gates(t.run));
  assert.deepEqual([step.actions.map((a) => a.label), state.cases[0]!.stage, state.cases[0]!.attempts.write, step.stopped.length], [['编写 00'], 'writing', 2, 0]);
  const again = t.calls.filter((x) => x.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.ok(again[again.indexOf('--note') + 1]!.startsWith(`上一次没有通过：场景保真审计做不了：${said}`), again[again.indexOf('--note') + 1]);
  await next(state, '编写 01', gates(t.run));
  assert.equal(state.cases[1]!.stage, 'stopped');
  assert.match(state.cases[1]!.stopped!, /^场景保真审计没有做完（Plumb）：不存在：合成的运行目录读不到/);
});

test('retry of a case stopped at the fidelity audit merges the verdict written since and does not write the plan again', async () => {
  await world(1);
  const t = tools(() => undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  const c = state.cases[0]!; c.stage = 'stopped'; c.attempts = { recompose: 3, write: 2 }; c.record_accepted = true; c.stopped = '场景保真审计没有做完（Plumb）：合成超限';
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  await mkdir(join('cases', '00', 'audit'), { recursive: true });
  await writeFile(join('cases', '00', 'audit', '00.abcd1234.brief.json'), '{}'); await writeFile(join('cases', '00', 'audit', '00.abcd1234.verdict.json'), '{}');
  const step = await retry(state, '00', '盲审已做完，并入', { run: t.run });
  assert.deepEqual([step.actions.length, step.ready], [0, ['00']]);
  assert.equal(t.calls.filter((x) => x.tool === 'case-compile/task-brief.ts').length, 0, 'no writer and no auditor');
});

test('a completed writer that wrote no plan is replaced with the missing path in its task', async () => {
  await world(1);
  const t = tools(() => undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  const c = state.cases[0]!; c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true;
  const ended = await next(state, '编写 00', gates(t.run));
  assert.deepEqual([ended.actions.map((a) => a.label), c.attempts.write], [['编写 00'], 2]);
  const note = t.calls.filter((x) => x.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.match(note[note.indexOf('--note') + 1]!, /没有写出 cases\/00\/plan\/00\.json/);
});

test('a gate Plumb cannot serve wakes the backend, runs once more, and then waits without an attempt until a later next finds Plumb back', async () => {
  await world(2);
  let down = true;
  const t = tools((tool) => tool === 'cmd-verify-plumb.ts' && down ? bad('暂时不可用：Plumb 网关拒绝（503 backend_down）') : undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  for (const [i, c] of state.cases.entries()) { c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true; await mkdir(join('cases', c.k, 'plan'), { recursive: true }); await writeFile(join('cases', c.k, 'plan', `0${i}.json`), '{}'); }
  const first = await next(state, '编写 00', gates(t.run));
  assert.deepEqual(t.calls.map((x) => x.tool.split('/')[1]), ['check-plan.ts', 'cmd-verify-plumb.ts', 'plumb.ts', 'cmd-verify-plumb.ts']);
  assert.deepEqual(t.calls[2]!.args.slice(0, 2), ['wake', '--wait']);
  assert.deepEqual([first.waiting?.map((w) => w.label), state.cases[0]!.attempts.write, state.cases[0]!.stage, first.all_done], [['编写 00'], 1, 'writing', false]);
  down = false;
  const second = await next(state, '编写 01', gates(t.run));
  assert.deepEqual(second.ready.sort(), ['00', '01'], 'the waiting gate of case 00 ran again with the gate of case 01');
  assert.equal(second.waiting, undefined);
});

test('a record the Hub accepted is submitted from then on as the bytes the Hub judged, whatever a late recomposer writes over it', async () => {
  await world(2);
  const sent: Record<string, string>[] = [];
  const t = tools((tool, args) => {
    if (tool !== 'submit-records.ts') return undefined;
    const dir = args[args.indexOf('--records') + 1]!;
    sent.push(Object.fromEntries(readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => [n, readFileSync(join(dir, n), 'utf8')])));
    return ok(JSON.stringify({ call_result: 'ok', acceptance: 'accepted', result: { partitions: { delivered: ['n/r00', 'n/r01'].map((item) => ({ item, requirements: [{ requirement: 'record', status: 'satisfied', claims: [] }] })) } } }).replace(/^/, '合成答复\n供模型引用\n'));
  });
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  for (const c of state.cases) { c.stage = 'recomposing'; c.attempts.recompose = 1; }
  await writeFile(join('records', '00.json'), '{"v":"judged"}'); await writeFile(join('records', '01.json'), '{"v":"one"}');
  await next(state, '重组 00', gates(t.run));
  assert.equal(readFileSync(join('records-accepted', '00.json'), 'utf8'), '{"v":"judged"}');
  await writeFile(join('records', '00.json'), '{"v":"written over by a late recomposer"}');
  await next(state, '重组 01', gates(t.run));
  assert.deepEqual(sent[1], { '00.json': '{"v":"judged"}', '01.json': '{"v":"one"}' });
});

test('a plan whose audit holds a step changed goes back to its writer here, and a ready plan is delivered as it was when it became ready', async () => {
  await world(1);
  let changed = true;
  const t = tools((tool) => tool === 'fidelity-apply.ts' ? ok(JSON.stringify(changed ? { ready: false, merged: [{ file: '00.json', preserved: 3, changed: 1, unrealized: 0 }], attention: [{ file: '00.json', state: '未确认', message: '审计判作者步骤 a2 的场景被改了：合成理由' }], skipped: [] } : { ready: true, merged: [{ file: '00.json', preserved: 4, changed: 0, unrealized: 0 }], attention: [], skipped: [] })) : undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  const c = state.cases[0]!; c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true;
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{"plan":"first"}');
  await mkdir(join('cases', '00', 'audit'), { recursive: true }); await writeFile(join('cases', '00', 'audit', '00.aaaa1111.brief.json'), '{}'); await writeFile(join('cases', '00', 'audit', '00.aaaa1111.verdict.json'), '{}');
  const back = await next(state, '编写 00', gates(t.run));
  assert.deepEqual([back.actions.map((a) => a.label), back.ready, c.attempts.write], [['编写 00'], [], 2]);
  const note = t.calls.filter((x) => x.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.match(note[note.indexOf('--note') + 1]!, /场景保真审计没有通过：审计判作者步骤 a2 的场景被改了：合成理由/);
  assert.equal(existsSync(join('cases', '00', 'audit')), false, 'the audit files of the plan before are put away with it');
  changed = false;
  await writeFile(join('cases', '00', 'plan', '00.json'), '{"plan":"second"}');
  const done = await next(state, '编写 00', gates(t.run));
  assert.deepEqual(done.ready, ['00']);
  await writeFile(join('cases', '00', 'plan', '00.json'), '{"plan":"written over after it was ready"}');
  await collect(state, 'plans-late');
  assert.equal(readFileSync(join('plans-late', '00.json'), 'utf8'), '{"plan":"second"}');
});

test('a judgment Plumb holds for review goes to the blind auditor once; one Plumb rejects, or the blind auditor holds changed, goes back to the writer', async () => {
  await world(1);
  const plumbVerdict = (action: string) => JSON.stringify({ steps: [{ n: 'a2', verdict: 'changed', step_indices: [1], rationale: '合成：Plumb 判改变', model_judgment: { choice: '改变', confidence: 0.91, gate: { action } } }, { n: 'a3', verdict: 'preserved', step_indices: [2], rationale: '合成' }] });
  let ready = false;
  const t = tools((tool) => tool === 'fidelity-apply.ts' ? ok(JSON.stringify(ready ? { ready: true, merged: [], attention: [], skipped: [] } : { ready: false, merged: [], attention: [{ file: '00.json', state: '未确认', message: '审计判作者步骤 a2 的场景被改了：合成理由' }], skipped: [] })) : undefined);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  const c = state.cases[0]!; c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true;
  const audit = join('cases', '00', 'audit');
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  await mkdir(audit, { recursive: true }); await writeFile(join(audit, '00.aaaa1111.brief.json'), '{}'); await writeFile(join(audit, '00.aaaa1111.verdict.json'), plumbVerdict('review'));
  const second = await next(state, '编写 00', gates(t.run));
  assert.deepEqual([second.actions.map((a) => [a.label, a.subagent_type]), c.attempts.write], [[['审计 00', 'case-compile:compile-fidelity']], 1], 'a second opinion, not another writer');
  assert.deepEqual(readdirSync(audit).sort(), ['00.aaaa1111.brief.json', '00.aaaa1111.plumb-review.json'], 'the Plumb judgment is kept beside the brief');
  assert.match(c.review![0]!, /^场景保真：第 1 版计划里有 Plumb 拿不准、标为“待人工复核”的步骤；本次无人值守，改由独立盲审给出结论（Plumb 的原判断保存在 cases\/00\/audit\/[^）]+\.plumb-review\.json）$/);
  await writeFile(join(audit, '00.aaaa1111.verdict.json'), JSON.stringify({ steps: [{ n: 'a2', verdict: 'changed', step_indices: [1], rationale: '合成：盲审也判改变' }] }));
  const back = await next(state, '审计 00', gates(t.run));
  assert.deepEqual([back.actions.map((a) => a.label), c.attempts.write], [['编写 00'], 2]);
  await mkdir(audit, { recursive: true }); await writeFile(join(audit, '00.bbbb2222.brief.json'), '{}'); await writeFile(join(audit, '00.bbbb2222.verdict.json'), plumbVerdict('reject'));
  const rejected = await next(state, '编写 00', gates(t.run));
  assert.deepEqual([rejected.actions.map((a) => a.label), c.attempts.write], [['编写 00'], 3]);
  await mkdir(audit, { recursive: true }); await writeFile(join(audit, '00.cccc3333.brief.json'), '{}'); await writeFile(join(audit, '00.cccc3333.verdict.json'), plumbVerdict('review'));
  assert.deepEqual((await next(state, '编写 00', gates(t.run))).actions.map((a) => a.label), ['审计 00']);
  await writeFile(join(audit, '00.cccc3333.verdict.json'), JSON.stringify({ steps: [{ n: 'a2', verdict: 'preserved', step_indices: [1], rationale: '合成：盲审判保住' }] }));
  ready = true;
  assert.deepEqual((await next(state, '审计 00', gates(t.run))).ready, ['00']);
  const collected = await collect(state, 'plans-reviewed');
  assert.deepEqual([collected.copied, collected.reviewed?.map((r) => [r.autoid, r.notes.length])], [1, [[c.autoid, 2]]], 'the final report can say which cases a second opinion decided');
});

test('a label that is not the one this tool gave, or a case not at that stage, is refused without touching anything', async () => {
  await world(1);
  const state = await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model');
  const t = tools(() => undefined);
  await assert.rejects(next(state, '03', gates(t.run)), /形如“重组 03”/);
  await assert.rejects(next(state, '编写 00', gates(t.run)), /这一条现在是 queued/);
  assert.equal(t.calls.length, 0);
});

test('the record status is read from the answer partitions, and a refused submission says so in the Hub words', () => {
  assert.deepEqual(recordStatus(null, 'x'), { satisfied: false, seen: 'Hub 的答复里没有机器可读部分' });
  assert.match(recordStatus({ acceptance: 'not_accepted', errors: [{ message: '形状不对', path: '/items/0', fix: '改形状' }] }, 'x').seen, /^整份提交没有被受理：形状不对（\/items\/0）；下一步：改形状$/);
});

const NEXT_PLAN = 'run_01planplanplanplanplan01';
const OPENED = { ...OPEN, subject: 'agile:mindmap:900001', product: 'widget', build: 'Fixture_Build_A', booking: 'run_01bookingbookingbooking0', recompose_record: 'rec:' + 'a'.repeat(64) };
async function afterDevice(rows: (autoids: string[]) => unknown[], options: { judge?: 'model'; more?: (tool: string, args: string[]) => ToolRun | undefined } = {}) {
  await world(3);
  const state = await initState('recompose-run', 'plan-run', options.judge === undefined ? OPEN : { ...OPEN, judge: options.judge }, 'synthetic-model');
  for (const c of state.cases) {
    c.stage = 'ready'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true;
    for (const dir of ['ready', 'plan']) { await mkdir(join('cases', c.k, dir), { recursive: true }); await writeFile(join('cases', c.k, dir, `${c.k}.json`), `{"plan":"${c.k} round 1"}`); }
  }
  await mkdir('returns-1'); await mkdir('notes'); await writeFile(join('notes', '01.json'), '{}');
  await writeFile(join('returns-1', 'index.json'), JSON.stringify({ schema: 'device-returns@1', jobs: [{ outcome: 'effective', rows: rows(state.cases.map((c) => c.autoid)) }] }));
  let opens = 0;
  const uncarried: string[] = [];
  const t = tools((tool, args) => {
    const at = (name: string) => args[args.indexOf(name) + 1]!;
    // The record the tool writes keeps what it was given besides the mind map: the scope it read, the cases left out, the version line and the named documents.
    if (tool === 'open-compile.ts') { opens++; writeFileSync(at('--out'), JSON.stringify({ ...OPENED, plan_run: opens === 1 ? NEXT_PLAN : `run_01planplanplanplanplan0${opens}`, ...Object.fromEntries(['version', 'contract', 'inventory', 'profile'].filter((name) => args.includes(`--${name}`)).map((name) => [name, at(`--${name}`)])), ...(args.includes('--scope') ? { scope: JSON.parse(readFileSync(at('--scope'), 'utf8')) } : {}), ...(args.includes('--exclude') ? { exclude: at('--exclude').split(',') } : {}) })); return ok('就绪'); }
    if (tool === 'download-run.ts') { mkdirSync(join(at('--out'), 'briefs'), { recursive: true }); writeFileSync(join(at('--out'), 'run.json'), JSON.stringify({ run: NEXT_PLAN })); for (const k of ['00', '01', '02']) writeFileSync(join(at('--out'), 'briefs', `${k}.md`), '合成简报'); return ok(); }
    if (tool === 'carry-plans.ts') {
      mkdirSync(at('--plans'), { recursive: true });
      const again = (args.includes('--rework') ? at('--rework') : args.includes('--exclude') ? at('--exclude') : '').split(',').filter(Boolean);
      const carried = state.cases.filter((c) => !again.includes(c.autoid) && existsSync(join(at('--source-plans'), `${c.k}.json`)) && !uncarried.includes(c.k)).map((c) => { const file = join(at('--plans'), `${c.k}.json`), text = `{"plan":"${c.k} carried"}`; writeFileSync(file, text); return { autoid: c.autoid, file, sha256: createHash('sha256').update(text).digest('hex') }; });
      return ok(JSON.stringify({ schema: 'carry-plans@1', carried, needs_recheck: [], skipped: { rework: again } }));
    }
    return options.more?.(tool, args);
  });
  return { state, t, uncarried };
}
async function returned(dir: string, rows: unknown[]) {
  await mkdir(dir); await writeFile(join(dir, 'index.json'), JSON.stringify({ schema: 'device-returns@1', jobs: [{ outcome: 'effective', rows }] }));
}

test('a device round is reworked by code: a new plan run, what passed carried, what did not pass written again with the plan that ran, the device returns and the analysis', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'no_verdict', report_check: { resolved: false } }, { item: c, verdict: 'not_run', not_executed: { aborted_by: { item: b, step: 3 } }, report_check: { resolved: false } }]);
  const step = await rework(state, OPENED, 'returns-1', 'notes', gates(t.run));
  assert.deepEqual([step.round, step.carried, step.reworked, step.actions.map((a) => a.label)], [2, ['00', '02'], ['01'], ['编写 01']], 'the case that ended the run is written again; the one never reached is carried, its plan was not shown wrong');
  assert.deepEqual([state.plan_run, state.plan_dir, state.plan_history], [NEXT_PLAN, join('rework-2', 'plan-run'), [{ run: OPEN.plan_run, dir: 'plan-run' }]]);
  assert.match(step.message, /^第 2 轮返工：新开脚本编写运行 run_01planplanplanplanplan01（rework-2\/open-compile\.json），2 条通过的已结转，1 条没通过的带着上一轮计划和设备回传重新派编写。待派 1 个子代理/);
  assert.equal(state.open, join('rework-2', 'open-compile.json'));
  const downloaded = t.calls.filter((c) => c.tool === 'case-compile/download-run.ts');
  assert.deepEqual(downloaded.map((c) => c.args.slice(c.args.indexOf('--run'))), [['--run', NEXT_PLAN, '--out', join('rework-2', 'plan-run'), '--history-reuse', 'history']]);
  const opened = t.calls.find((c) => c.tool === 'case-compile/open-compile.ts')!;
  assert.deepEqual([opened.args.slice(opened.args.indexOf('--subject')), opened.stdin], [['--subject', 'agile:mindmap:900001', '--product', 'widget', '--build', 'Fixture_Build_A', '--booking', 'run_01bookingbookingbooking0', '--recompose-run', OPEN.recompose_run, '--recompose-record', OPENED.recompose_record, '--out', join('rework-2', 'open-compile.json')], 'synthetic-token-1234\nsynthetic-plumb-key\n'], 'the same mind map, build, booking and recompose run');
  const task = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').at(-1)!.args, at = (name: string) => task[task.indexOf(name) + 1];
  assert.deepEqual([at('--round'), at('--prior-plans'), at('--prior-returns'), at('--prior-notes'), at('--run'), at('--brief'), at('--task-file')], ['2', join('rework-2', 'prior-plans'), 'returns-1', 'notes', join('rework-2', 'plan-run'), join('rework-2', 'plan-run', 'briefs', '01.md'), join('tasks', 'write', '01-r2-1.md')]);
  assert.match(at('--note')!, /^停下前最后一次没有通过：上机第 1 轮没有通过（判定 no_verdict）/);
  assert.deepEqual([readFileSync(join('cases', '00', 'ready', '00.json'), 'utf8'), state.cases.map((c) => c.device_rounds ?? 0)], ['{"plan":"00 carried"}', [1, 1, 0]], 'a case the runner never reached has not used a device round');
  assert.deepEqual(JSON.parse(readFileSync(join('rework-2', 'prior-plans', '01.json'), 'utf8')), { plan: '01 round 1', plan_run: OPEN.plan_run });
  await writeFile(join('cases', '01', 'plan', '01.json'), '{"plan":"01 round 2"}');
  const written = await next(state, '编写 01', gates(t.run));
  assert.deepEqual(written.ready, ['00', '01', '02']);
  assert.match(written.message, /下一步：pipeline\.ts collect 收拢到新目录，再后台跑合并工具 open-merge\.ts（--open 写 rework-2\/open-compile\.json，SKILL\.md 第 3 节）$/, 'the merge is told the open file of the new plan run');
  const check = t.calls.filter((c) => c.tool === 'case-compile/check-plan.ts').at(-1)!.args;
  assert.equal(check[check.indexOf('--run') + 1], join('rework-2', 'plan-run'), 'the gates run against the new plan run');
  await collect(state, 'plans-2');
  assert.deepEqual(['00', '01', '02'].map((k) => readFileSync(join('plans-2', `${k}.json`), 'utf8')), ['{"plan":"00 carried"}', '{"plan":"01 round 2"}', '{"plan":"02 carried"}']);
});

const plansWith = (names: string[], description = '一步') => JSON.stringify({ item: 'doc:01', handling: 'handled', slots: { plan: [{ text: '合成计划', data: { bucket: 'bed-a', blocks: [], replacements: [], expects: [], steps: names.map((name, n) => ({ object: 'dut0', method: 'exec', args: [`widget host ${name}`], keywords: {}, description: `${description} ${n + 1}` })) } }] } }, null, 2) + '\n';

test('the plan a reworked case ran is handed to its next writer with the long names back as length placeholders, and every other copy keeps its bytes', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  const right = expandText('{{domain:200|pfx|sfx}}').text, wrong = expandText('{{domain:204|pfx|sfx}}').text;
  const ran = plansWith([right, right, wrong, `x1.${right}`]);
  await writeFile(join('cases', '01', 'ready', '01.json'), ran);
  const step = await rework(state, OPENED, 'returns-1', 'notes', gates(t.run));
  assert.deepEqual(step.reworked, ['01']);
  const handed = readFileSync(join('rework-2', 'prior-plans', '01.json'), 'utf8'), holds = (part: string) => handed.split(part).length - 1;
  assert.ok(!handed.includes(right) && !handed.includes(wrong), 'no long name is left in what the writer reads');
  assert.deepEqual([holds('{{domain:200|pfx|sfx}}'), holds('{{domain:204|pfx|sfx}}'), holds('widget host x1.{{domain:200|pfx|sfx}}')], [3, 1, 1], 'the same name is the same placeholder and the one typed longer is another');
  assert.equal(JSON.parse(handed).plan_run, OPEN.plan_run);
  assert.equal(expandText(handed).text, JSON.stringify({ ...JSON.parse(ran), plan_run: OPEN.plan_run }, null, 1) + '\n', 'it expands back to the plan that ran, byte for byte');
  assert.equal(readFileSync(join('rework-2', 'source-plans', '01.json'), 'utf8'), ran, 'the source copy is the plan as it ran');
  assert.equal(readFileSync(join('cases', '01', 'ready', '01.json'), 'utf8'), ran, 'and so is the ready copy');
  for (const k of ['00', '02']) {
    assert.equal(readFileSync(join('rework-2', 'source-plans', `${k}.json`), 'utf8'), `{"plan":"${k} round 1"}`);
    assert.equal(readFileSync(join('cases', k, 'ready', `${k}.json`), 'utf8'), `{"plan":"${k} carried"}`, 'what was carried is what the carry wrote');
    assert.equal(existsSync(join('rework-2', 'prior-plans', `${k}.json`)), false, 'a case that passed has no prior plan');
  }
  const task = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.equal(task[task.indexOf('--prior-plans') + 1], join('rework-2', 'prior-plans'), 'the writer is pointed at the collapsed copy');
});

test('the shape of a real run: the name typed wrong, only inside a longer token, is handed over as the placeholder of the fixed parts found elsewhere', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  const right = expandText('{{domain:200|pfx|sfx}}').text, wrong = expandText('{{domain:204|pfx|sfx}}').text;
  const ran = plansWith([right, `x1.${right}`, `x1.${wrong}`, right]);
  await writeFile(join('cases', '01', 'ready', '01.json'), ran);
  await rework(state, OPENED, 'returns-1', 'notes', gates(t.run));
  const handed = readFileSync(join('rework-2', 'prior-plans', '01.json'), 'utf8'), holds = (part: string) => handed.split(part).length - 1;
  assert.deepEqual([holds('{{domain:200|pfx|sfx}}'), holds('"widget host x1.{{domain:200|pfx|sfx}}"'), holds('"widget host x1.{{domain:204|pfx|sfx}}"'), holds('{{domain:207')], [3, 1, 1, 0], 'the name that is longer by four characters is told apart, behind the same extra characters');
  assert.equal(expandText(handed).text, JSON.stringify({ ...JSON.parse(ran), plan_run: OPEN.plan_run }, null, 1) + '\n');
  assert.equal(readFileSync(join('rework-2', 'source-plans', '01.json'), 'utf8'), ran, 'the source copy keeps its bytes');
});

test('a plan that cannot be proved to expand back to its own bytes is handed to the writer as the bytes it has', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  const right = expandText('{{domain:200|pfx|sfx}}').text;
  const ran = plansWith([right, right], '一步，占位 {{name:10}} 写在说明里');
  await writeFile(join('cases', '01', 'ready', '01.json'), ran);
  await rework(state, OPENED, 'returns-1', 'notes', gates(t.run));
  assert.equal(readFileSync(join('rework-2', 'prior-plans', '01.json'), 'utf8'), JSON.stringify({ ...JSON.parse(ran), plan_run: OPEN.plan_run }, null, 1) + '\n', 'the placeholder the plan holds would expand to another text, so nothing is collapsed');
});

test('a reworked case whose task cannot be generated stops with the tool\'s words; the others are dispatched and the round is kept', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'fail' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  await writeFile(join('notes', '00.json'), '{}');
  const run: RunTool = async (skill, tool, args, stdin) => {
    if (tool === 'task-brief.ts' && args[args.indexOf('--case') + 1] === state.cases[0]!.autoid) return bad('参数无效：--prior-notes 文件 notes/00.json 缺少 cases 或归因字段（judged/remedy）。');
    return t.run(skill, tool, args, stdin);
  };
  const step = await rework(state, OPENED, 'returns-1', 'notes', gates(run));
  assert.deepEqual([step.reworked, step.actions.map((a) => a.label), step.carried], [['00', '01'], ['编写 01'], ['02']], 'the case whose task was generated is dispatched');
  assert.deepEqual(step.stopped.map((row) => row.label.slice(0, 2)), ['00']);
  assert.match(step.stopped[0]!.reason, /^第 2 轮的编写任务没有生成：生成编写任务失败（.*）：参数无效：--prior-notes 文件 notes\/00\.json 缺少 cases 或归因字段/);
  assert.deepEqual([state.plan_run, state.cases.map((c) => c.stage)], [NEXT_PLAN, ['stopped', 'writing', 'ready']], 'the new run and what was carried are kept');
  const again = await retry(state, '00', '模型决定：归因文件已补字段', gates(t.run));
  assert.deepEqual(again.actions.map((a) => a.label), ['编写 00']);
  const task = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.deepEqual([task[task.indexOf('--round') + 1], task[task.indexOf('--prior-notes') + 1]], ['2', 'notes']);
});

test('what the local check noticed about a plan that did not pass goes into its next task with the round\'s returns', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  const seen: string[] = [];
  const run: RunTool = async (skill, tool, args, stdin) => {
    if (tool === 'check-plan.ts' && !existsSync('rework-2/carried')) { seen.push(args.join(' ')); return ok(JSON.stringify({ mode: 'plan', ok: true, advice: ['主机命令访问 192.0.2.70；本条的设备命令里没有出现这个地址。设备在每条用例开始前会被清理'] })); }
    return t.run(skill, tool, args, stdin);
  };
  const step = await rework(state, OPENED, 'returns-1', 'notes', gates(run));
  assert.deepEqual(step.reworked, ['01']);
  assert.deepEqual(seen, [`--file ${join('cases', '01', 'plan', '01.json')} --run plan-run`], 'only the plan that did not pass is looked at, against the run it was written for');
  const task = t.calls.filter((c) => c.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  const note = task[task.indexOf('--note') + 1]!;
  assert.match(note, /上机第 1 轮没有通过（判定 fail）；这一轮跑的计划、设备回传和失败分析见任务文件。这份计划自检时看到的事实：主机命令访问 192\.0\.2\.70；本条的设备命令里没有出现这个地址/);
});

test('a rework round whose carry refuses leaves nothing behind, and the saved state opens it again', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  const saved = structuredClone(state);
  let carries = 0;
  const run: RunTool = async (skill, tool, args, stdin) => (tool === 'carry-plans.ts' && ++carries === 1 ? bad('参数无效：合成的结转拒绝。') : t.run(skill, tool, args, stdin));
  await assert.rejects(rework(state, OPENED, 'returns-1', 'notes', gates(run)), /结转没有做成：参数无效：合成的结转拒绝/);
  assert.equal(existsSync('rework-2'), false, 'the half-opened round is removed');
  const again = await rework(saved, OPENED, 'returns-1', 'notes', gates(run));
  assert.deepEqual([again.round, again.reworked, again.carried, saved.plan_run, saved.open], [2, ['01'], ['00', '02'], 'run_01planplanplanplanplan02', join('rework-2', 'open-compile.json')], 'the second open is a plan run of its own');
});

test('a job that was not dispatched is no device round; a round all cases passed needs no rework', async () => {
  const none = await afterDevice(() => []);
  await writeFile(join('returns-1', 'index.json'), JSON.stringify({ schema: 'device-returns@1', jobs: [{ outcome: 'not_dispatched', missing_facts: [{ fact: '该床尚未恢复，不能派发：合成原因' }], rows: [] }] }));
  await assert.rejects(rework(none.state, OPENED, 'returns-1', undefined, gates(none.t.run)), /returns-1 里没有一轮上机的结果：这次上机没有发到设备（该床尚未恢复，不能派发：合成原因），不算一轮上机，也不返工/);
  assert.equal(none.t.calls.length, 0, 'nothing is opened');
  const passed = await afterDevice((ids) => ids.map((item) => ({ item, verdict: 'pass' })));
  const all = await rework(passed.state, OPENED, 'returns-1', undefined, gates(passed.t.run));
  assert.deepEqual([all.actions.length, all.reworked, passed.t.calls.length, passed.state.plan_run], [0, [], 0, OPEN.plan_run]);
  assert.match(all.message, /^这一轮上机 3 条全部通过，没有要返工的：按 tools\/delivery\.md 第 5 节组交付目录（assemble-delivery\.ts），最后回复用它给的回复$/, 'the closing step is named');
});

test('a round with no failure but incomplete reports opens the delivery volume without them, and the cases that passed are verified again as one workbook', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'no_verdict', report_check: { resolved: false } }, { item: c, verdict: 'not_run', not_executed: { aborted_by: { item: a, step: 2 } }, report_check: { resolved: false } }]);
  const [a, b, c] = state.cases.map((row) => row.autoid);
  const step = await rework(state, OPENED, 'returns-1', undefined, gates(t.run));
  assert.deepEqual([step.reworked, step.carried, step.actions.length, state.volume, state.plan_run], [[], ['00'], 0, { n: 1 }, NEXT_PLAN]);
  assert.match(step.message, /^第 1 次交付卷：2 条报告不完整、没有结论的不进卷（01、02），1 条已原样结转到新开的脚本编写运行 run_01planplanplanplanplan01（deliver-1\/open-compile\.json）。全部 3 条走完流水线：1 条计划就绪，2 条不进交付卷（见 excluded）。下一步：pipeline\.ts collect /);
  assert.deepEqual(state.cases.map((row) => [row.stage, row.excluded]), [['ready', undefined], ['excluded', '上机第 1 轮的报告不完整、没有结论（判定 no_verdict）'], ['excluded', '上机第 1 轮的报告不完整、没有结论（判定 not_run）']]);
  const opened = t.calls.find((call) => call.tool === 'case-compile/open-compile.ts')!.args;
  assert.equal(opened[opened.indexOf('--exclude') + 1], [b, c].join(','), 'the cases without a verdict are left out of the new run');
  assert.deepEqual(state.cases.map((row) => row.device_rounds ?? 0), [1, 0, 0], 'a case without a verdict used no device round');
  await returned('returns-2', [{ item: a, verdict: 'pass' }]);
  const verified = await rework(state, { ...OPENED, plan_run: NEXT_PLAN }, 'returns-2', undefined, gates(t.run));
  assert.match(verified.message, /^交付卷整体通过：1 条在同一次上机里逐条正确。为没有交付的 2 条照实写说明（tools\/delivery\.md 第 3 节）/, 'what is not delivered is counted');
});

test('a case that stops again after its one retry leaves this compile: reopen opens a plan run without it, carries the others, and later tasks read their brief where the new run put it', async () => {
  const { state, t } = await afterDevice(() => []);
  state.open = 'open-compile.json';
  const [a, b, c] = state.cases.map((row) => row.autoid);
  const run: RunTool = async (skill, tool, args, stdin) => {
    const done = await t.run(skill, tool, args, stdin);
    if (tool === 'download-run.ts') { const out = args[args.indexOf('--out') + 1]!; mkdirSync(join(out, 'items'), { recursive: true }); [state.cases[0]!, state.cases[2]!].forEach((row, n) => writeFileSync(join(out, 'items', `0${n}.json`), JSON.stringify({ id: row.plan.item }))); }
    return done;
  };
  const s = state.cases[1]!;
  s.stage = 'stopped'; s.attempts = { recompose: 1, write: 5 }; s.stopped = '脚本编写 5 次仍未通过：合成原因';
  assert.match(summary(state, []).message, /下一步：stopped 里没标 retried 的每条先跑一次 pipeline\.ts retry/);
  await assert.rejects(reopen(state, OPENED, undefined, gates(run)), /01 停下后还没有 retry 过：先各跑一次 pipeline\.ts retry/);
  assert.deepEqual((await retry(state, '01', '模型决定：合成改法', gates(run))).actions.map((x) => x.label), ['编写 01']);
  s.stage = 'stopped'; s.stopped = '脚本编写 5 次仍未通过：合成第二次';
  const told = summary(state, []);
  assert.deepEqual(told.stopped, [{ label: `01 ${b}`, reason: '脚本编写 5 次仍未通过：合成第二次', retried: true }]);
  assert.match(told.message, /下一步：retry 后又停下的 1 条不进这次编译：跑 pipeline\.ts reopen（--open 写 open-compile\.json，SKILL\.md 第 0 节），照它的 message 办，停下的原因照实写进报告$/);
  await assert.rejects(retry(state, '01', '模型决定：再来', gates(run)), /01 在这次脚本编写运行里 retry 过一次又停下，不再 retry/);
  const step = await reopen(state, OPENED, undefined, gates(run));
  assert.match(step.message, /^新开脚本编写运行 run_01planplanplanplanplan01（reopen-1\/open-compile\.json）：2 条就绪的计划已原样结转；retry 后又停下的 1 条不进这次编译（01）。全部 3 条走完流水线：2 条计划就绪，1 条不进交付卷（见 excluded）。下一步：pipeline\.ts collect 收拢到新目录，再后台跑合并工具 open-merge\.ts（--open 写 reopen-1\/open-compile\.json，SKILL\.md 第 3 节）$/);
  assert.deepEqual([state.plan_run, state.open, s.stage, s.excluded], [NEXT_PLAN, join('reopen-1', 'open-compile.json'), 'excluded', 'retry 后仍停下：脚本编写 5 次仍未通过：合成第二次']);
  const opened = t.calls.find((call) => call.tool === 'case-compile/open-compile.ts')!.args;
  assert.equal(opened[opened.indexOf('--exclude') + 1], b);
  const carry = t.calls.find((call) => call.tool === 'case-compile/carry-plans.ts')!.args;
  assert.deepEqual(carry, ['--source', 'plan-run', '--target', join('reopen-1', 'plan-run'), '--plans', join('reopen-1', 'carried'), '--source-plans', join('reopen-1', 'source-plans'), '--exclude', b]);
  assert.deepEqual(state.cases.map((row) => row.run_index), [undefined, undefined, '01'], 'the run without 01 holds 02 at its second place');
  const collected = await collect(state, 'plans-reopened');
  assert.deepEqual([readdirSync('plans-reopened').sort(), collected.excluded], [['00.json', '02.json'], [{ autoid: b, reason: 'retry 后仍停下：脚本编写 5 次仍未通过：合成第二次' }]]);
  await returned('returns-2', [{ item: a, verdict: 'pass' }, { item: c, verdict: 'fail' }]);
  const again = await rework(state, { ...OPENED, plan_run: NEXT_PLAN }, 'returns-2', undefined, gates(run));
  assert.deepEqual(again.reworked, ['02']);
  const reopened = t.calls.filter((call) => call.tool === 'case-compile/open-compile.ts').at(-1)!.args;
  assert.equal(reopened[reopened.indexOf('--exclude') + 1], b, 'a later round keeps the case out');
  const task = t.calls.filter((call) => call.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.deepEqual([task[task.indexOf('--brief') + 1], task[task.indexOf('--out') + 1]], [join('rework-2', 'plan-run', 'briefs', '01.md'), join('cases', '02', 'plan', '02.json')]);
  await assert.rejects(retry(state, '01', '模型决定：再写一次', gates(run)), /01 不在交付卷里（retry 后仍停下：/);
});

test('a merge the Hub refuses in the merge run is reopened by code: a new plan run, the other plans carried, the refused ones written again with the Hub words', async () => {
  const { state, t } = await afterDevice(() => []);
  state.open = 'open-compile.json';
  const b = state.cases[1]!.autoid;
  await writeFile('refused.json', JSON.stringify({ schema: 'merge-refused@1', plan_run: OPEN.plan_run, merge_run: 'run_01mergemergemergemerge0', cases: [{ item: 'doc:01', requirement: 'workbook_verified', words: '合成：工作簿第 3 行和计划不一致' }] }));
  await writeFile('refused-other.json', JSON.stringify({ plan_run: 'run_01otherotherotherother0', cases: [{ item: 'doc:01', words: '合成' }] }));
  await assert.rejects(reopen(structuredClone(state), OPENED, 'refused-other.json', gates(t.run)), /不是这一轮合并写的（它的脚本编写运行应是 run_01planplanplanplanplan00）/);
  const busy = structuredClone(state); busy.cases[0]!.stage = 'writing';
  await assert.rejects(reopen(busy, OPENED, 'refused.json', gates(t.run)), /还有 1 条没走完流水线（00）/);
  assert.equal(t.calls.length, 0, 'nothing is opened before the state allows it');
  const step = await reopen(state, OPENED, 'refused.json', gates(t.run));
  assert.deepEqual([step.actions.map((x) => x.label), state.plan_run, state.open, state.cases.map((row) => row.stage)], [['编写 01'], NEXT_PLAN, join('reopen-1', 'open-compile.json'), ['ready', 'writing', 'ready']]);
  assert.match(step.message, /^新开脚本编写运行 run_01planplanplanplanplan01（reopen-1\/open-compile\.json）：2 条就绪的计划已原样结转，1 条带着 Hub 的原话重新派编写。待派 1 个子代理/);
  const opened = t.calls.find((call) => call.tool === 'case-compile/open-compile.ts')!.args;
  assert.equal(opened.includes('--exclude'), false);
  const carry = t.calls.find((call) => call.tool === 'case-compile/carry-plans.ts')!.args;
  assert.deepEqual(carry.slice(-2), ['--rework', b]);
  const task = t.calls.filter((call) => call.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.deepEqual([task[task.indexOf('--note') + 1], task[task.indexOf('--brief') + 1]], ['重做这一条的依据：Hub 在脚本合并运行里的原话：合成：工作簿第 3 行和计划不一致', join('reopen-1', 'plan-run', 'briefs', '01.md')]);
  await writeFile(join('cases', '01', 'plan', '01.json'), '{"plan":"01 again"}');
  const written = await next(state, '编写 01', gates(t.run));
  assert.match(written.message, /下一步：pipeline\.ts collect 收拢到新目录，再后台跑合并工具 open-merge\.ts（--open 写 reopen-1\/open-compile\.json，SKILL\.md 第 3 节）$/);
});

test('a case that used its last round leaves the delivery volume, which is opened by code: the others are carried as they are, collected alone and verified as one workbook', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  state.cases[1]!.device_rounds = 2;
  const [a, b, c] = state.cases.map((row) => row.autoid);
  const ended = await rework(state, OPENED, 'returns-1', undefined, gates(t.run));
  assert.deepEqual([ended.gave_up.map((g) => g.label.slice(0, 2)), ended.actions.length, ended.carried, ended.all_done], [['01'], 0, ['00', '02'], true]);
  assert.deepEqual(state.cases.map((row) => [row.stage, row.excluded]), [['ready', undefined], ['excluded', '上机 3 轮仍未通过（最后一轮判定 fail）'], ['ready', undefined]]);
  assert.deepEqual([state.volume, state.plan_run, state.plan_dir, state.cases.map((row) => row.device_rounds ?? 0)], [{ n: 1 }, NEXT_PLAN, join('deliver-1', 'plan-run'), [1, 3, 1]]);
  assert.equal(state.open, join('deliver-1', 'open-compile.json'));
  assert.match(ended.message, /^第 1 次交付卷：1 条没有通过的不进卷（01），2 条已原样结转到新开的脚本编写运行 run_01planplanplanplanplan01（deliver-1\/open-compile\.json）。全部 3 条走完流水线：2 条计划就绪，1 条不进交付卷（见 excluded）。下一步：pipeline\.ts collect 收拢到新目录，再后台跑合并工具 open-merge\.ts（--open 写 deliver-1\/open-compile\.json，SKILL\.md 第 3 节）$/);
  assert.deepEqual(ended.excluded, [{ label: `01 ${b}`, reason: '上机 3 轮仍未通过（最后一轮判定 fail）' }]);
  const opened = t.calls.find((call) => call.tool === 'case-compile/open-compile.ts')!.args;
  assert.deepEqual(opened.slice(opened.indexOf('--exclude'), opened.indexOf('--exclude') + 2), ['--exclude', b], 'the new plan run is opened without the case that did not pass');
  const carry = t.calls.find((call) => call.tool === 'case-compile/carry-plans.ts')!.args;
  assert.deepEqual(carry, ['--source', 'plan-run', '--target', join('deliver-1', 'plan-run'), '--plans', join('deliver-1', 'carried'), '--source-plans', join('deliver-1', 'source-plans'), '--exclude', b], 'no briefs options: each plan carries its own fidelity judgment');
  assert.deepEqual(readdirSync(join('deliver-1', 'source-plans')).sort(), ['00.json', '02.json']);
  const download = t.calls.find((call) => call.tool === 'case-compile/download-run.ts')!.args;
  assert.deepEqual(download.slice(-2), ['--history-reuse', 'history'], 'the history of the compile is reused, the Hub is not asked again');
  assert.equal(t.calls.some((call) => call.tool === 'case-compile/task-brief.ts'), false, 'nothing is written again');
  const collected = await collect(state, 'plans-v1');
  assert.deepEqual([collected.copied, collected.excluded, readdirSync('plans-v1').sort()], [2, [{ autoid: b, reason: '上机 3 轮仍未通过（最后一轮判定 fail）' }], ['00.json', '02.json']]);
  await assert.rejects(retry(state, '01', '模型决定：再写一次', gates(t.run)), /01 不在交付卷里（上机 3 轮仍未通过（最后一轮判定 fail）），不再重写；它照实进报告/);
  await returned('returns-2', [{ item: a, verdict: 'pass' }, { item: c, verdict: 'pass' }]);
  const calls = t.calls.length;
  const verified = await rework(state, { ...OPENED, plan_run: NEXT_PLAN }, 'returns-2', undefined, gates(t.run));
  assert.match(verified.message, /^交付卷整体通过：2 条在同一次上机里逐条正确。为没有交付的 1 条照实写说明（tools\/delivery\.md 第 3 节），再按 tools\/delivery\.md 第 5 节组交付目录（assemble-delivery\.ts），最后回复用它给的回复$/);
  assert.deepEqual([state.volume, t.calls.length, state.cases.map((row) => row.device_rounds ?? 0), verified.actions.length], [{ n: 1, result: 'passed' }, calls, [1, 3, 1], 0]);
  await assert.rejects(rework(state, { ...OPENED, plan_run: NEXT_PLAN }, 'returns-2', undefined, gates(t.run)), /交付卷已经整体通过，不再返工：为没有交付的 1 条照实写说明/);
});

test('a delivery volume in which a case fails is opened once more without it; a second one that fails ends the device runs', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  state.cases[1]!.device_rounds = 2;
  const [a, b, c] = state.cases.map((row) => row.autoid);
  await rework(state, OPENED, 'returns-1', undefined, gates(t.run));
  await returned('returns-2', [{ item: a, verdict: 'pass' }, { item: c, verdict: 'fail' }]);
  const second = await rework(state, { ...OPENED, plan_run: NEXT_PLAN }, 'returns-2', undefined, gates(t.run));
  assert.match(second.message, /^第 2 次交付卷：1 条没有通过的不进卷（02），1 条已原样结转到新开的脚本编写运行 run_01planplanplanplanplan02（deliver-2\/open-compile\.json）/);
  assert.deepEqual(state.cases.map((row) => [row.stage, row.excluded]), [['ready', undefined], ['excluded', '上机 3 轮仍未通过（最后一轮判定 fail）'], ['excluded', '交付卷第 1 次上机没有通过（判定 fail）']]);
  assert.deepEqual([state.volume, state.plan_run, state.cases.map((row) => row.device_rounds ?? 0)], [{ n: 2 }, 'run_01planplanplanplanplan02', [1, 3, 1]], 'a volume verification is no writing round');
  const opened = t.calls.filter((call) => call.tool === 'case-compile/open-compile.ts').at(-1)!.args;
  assert.equal(opened[opened.indexOf('--exclude') + 1], [b, c].join(','), 'both cases outside the volume are excluded from the new run');
  assert.deepEqual(readdirSync(join('deliver-2', 'source-plans')), ['00.json']);
  await returned('returns-3', [{ item: a, verdict: 'fail' }]);
  const calls = t.calls.length;
  const over = await rework(state, { ...OPENED, plan_run: 'run_01planplanplanplanplan02' }, 'returns-3', undefined, gates(t.run));
  assert.match(over.message, /^第 2 次交付卷仍有 1 条没有通过（00），上机到此为止：没有整体核验通过的交付卷。为没有交付的 3 条照实写说明（tools\/delivery\.md 第 3 节），再按 tools\/delivery\.md 第 5 节组交付目录（assemble-delivery\.ts），最后回复用它给的回复$/);
  assert.deepEqual([state.volume?.result, t.calls.length, existsSync('deliver-3')], ['failed', calls, false]);
  await assert.rejects(rework(state, { ...OPENED, plan_run: 'run_01planplanplanplanplan02' }, 'returns-3', undefined, gates(t.run)), /交付卷两次上机都没有整体通过，上机到此为止/);
});

test('no delivery volume when nothing passed; a carry that refuses leaves nothing behind; a plan the carry does not take passes the gates of the new run again', async () => {
  const none = await afterDevice((ids) => ids.map((item) => ({ item, verdict: 'fail' })));
  for (const row of none.state.cases) row.device_rounds = 2;
  const nothing = await rework(none.state, OPENED, 'returns-1', undefined, gates(none.t.run));
  assert.match(nothing.message, /^没有一条在设备上通过，上机到此为止：没有可交付的自动化用例 Excel。为没有交付的 3 条照实写说明（tools\/delivery\.md 第 3 节），再按 tools\/delivery\.md 第 5 节组交付目录（assemble-delivery\.ts），最后回复用它给的回复$/);
  assert.deepEqual([none.t.calls.length, none.state.volume, none.state.cases.map((row) => row.stage), existsSync('deliver-1')], [0, undefined, ['excluded', 'excluded', 'excluded'], false]);

  const refused = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  refused.state.cases[1]!.device_rounds = 2;
  const before = structuredClone(refused.state);
  let carries = 0;
  const run: RunTool = async (skill, tool, args, stdin) => (tool === 'carry-plans.ts' && ++carries === 1 ? bad('参数无效：--source 与 --target 绑定的输入不一致，拒绝结转。') : refused.t.run(skill, tool, args, stdin));
  await assert.rejects(rework(refused.state, OPENED, 'returns-1', undefined, gates(run)), /结转没有做成：参数无效：--source 与 --target 绑定的输入不一致/);
  assert.equal(existsSync('deliver-1'), false, 'the half-opened volume is removed');
  refused.uncarried.push('02');
  const again = await rework(before, OPENED, 'returns-1', undefined, gates(run));
  assert.deepEqual([again.carried, before.volume?.n, before.cases.map((row) => row.stage)], [['00'], 1, ['ready', 'excluded', 'ready']]);
  assert.match(again.message, /1 条已原样结转到新开的脚本编写运行 .*，1 条重新过关口/);
  const regated = refused.t.calls.filter((call) => call.tool === 'case-compile/check-plan.ts').at(-1)!.args;
  assert.deepEqual([regated[regated.indexOf('--file') + 1], regated[regated.indexOf('--run') + 1]], [join('cases', '02', 'plan', '02.json'), join('deliver-1', 'plan-run')], 'the plan the carry did not take is checked against the new run, not written again');
  assert.equal(refused.t.calls.some((call) => call.tool === 'case-compile/task-brief.ts' && call.args.includes('脚本编写')), false);
});

// A compile of part of a mind map: the words the user gave, kept as they were, and the cases they name; one case left out when it was opened.
const SCOPE = { words: '只编这三条：“登录后改密码”、"退出" 和 a\\b（第二行\n还有一行 ）', cases: ['990000000000001000', '990000000000001001', '990000000000001002'] };
const LEFT_OUT = '990000000000009001';
// The version line and the three named documents the first open may have been given instead of the defaults.
const NAMES = ['version', 'contract', 'inventory', 'profile'] as const;
const NAMED = { version: '3.2', contract: 'doc:doc:other-contract', inventory: `doc:doc:other-inventory@${'d'.repeat(64)}`, profile: 'doc:doc:other-profile' } as const;
const namedFlags = (args: string[]) => NAMES.map((name) => flagOf(args, `--${name}`));
const flagOf = (args: string[], name: string): string | undefined => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const openCalls = (calls: Array<{ tool: string; args: string[] }>) => calls.filter((call) => call.tool === 'case-compile/open-compile.ts').map((call) => call.args);

test('a compile of part of a mind map keeps its scope and its left-out cases in every plan run a rework opens, and the record of each open says so for the next', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  const first = { ...OPENED, scope: SCOPE, exclude: [LEFT_OUT] };
  await rework(state, first, 'returns-1', 'notes', gates(t.run));
  const [opened] = openCalls(t.calls);
  assert.equal(flagOf(opened!, '--scope'), join('rework-2', 'compile-scope.json'), 'the scope is a file of the round\'s own directory');
  assert.equal(flagOf(opened!, '--exclude'), LEFT_OUT);
  const text = readFileSync(join('rework-2', 'compile-scope.json'), 'utf8');
  assert.deepEqual(JSON.parse(text), SCOPE);
  assert.ok(text.includes(JSON.stringify(SCOPE.words)), 'the words are written as the user gave them');
  const recorded = JSON.parse(readFileSync(state.open!, 'utf8'));
  assert.deepEqual([recorded.scope, recorded.exclude], [SCOPE, [LEFT_OUT]], 'the next open wrote both down again');

  // The round after it starts from that record, and keeps both.
  await writeFile(join('cases', '01', 'plan', '01.json'), '{"plan":"01 round 2"}');
  await next(state, '编写 01', gates(t.run));
  await returned('returns-2', state.cases.map((c) => ({ item: c.autoid, verdict: c.k === '01' ? 'fail' : 'pass' })));
  await rework(state, recorded, 'returns-2', undefined, gates(t.run));
  const again = openCalls(t.calls)[1]!;
  assert.equal(flagOf(again, '--scope'), join('rework-3', 'compile-scope.json'));
  assert.deepEqual(JSON.parse(readFileSync(join('rework-3', 'compile-scope.json'), 'utf8')), SCOPE);
  assert.equal(flagOf(again, '--exclude'), LEFT_OUT);
  assert.deepEqual([JSON.parse(readFileSync(state.open!, 'utf8')).scope], [SCOPE]);
});

test('a reopen and a delivery volume keep the scope too, and merge the left-out cases of the record with the ones this pipeline dropped, each once and in the order met', async () => {
  // reopen: the case that stopped again is dropped; the record's own left-out case stays first
  const { state, t } = await afterDevice(() => []);
  state.open = 'open-compile.json';
  const [a, b, c] = state.cases.map((row) => row.autoid);
  const s = state.cases[1]!;
  s.stage = 'stopped'; s.attempts = { recompose: 1, write: 5 }; s.stopped = '脚本编写 5 次仍未通过：合成原因'; s.retried = OPEN.plan_run;
  await reopen(state, { ...OPENED, scope: SCOPE, exclude: [LEFT_OUT] }, undefined, gates(t.run));
  const [opened] = openCalls(t.calls);
  assert.equal(flagOf(opened!, '--scope'), join('reopen-1', 'compile-scope.json'));
  assert.deepEqual(JSON.parse(readFileSync(join('reopen-1', 'compile-scope.json'), 'utf8')), SCOPE);
  assert.equal(flagOf(opened!, '--exclude'), `${LEFT_OUT},${b}`);
  const carry = t.calls.find((call) => call.tool === 'case-compile/carry-plans.ts')!.args;
  assert.equal(flagOf(carry, '--exclude'), b, 'only the case this pipeline dropped is left out of the carry, the record\'s one was never in the plans');
  // a later round: the record now lists the dropped case too, and it is still one entry
  const recorded = JSON.parse(readFileSync(state.open, 'utf8'));
  assert.deepEqual([recorded.scope, recorded.exclude], [SCOPE, [LEFT_OUT, b]]);
  await returned('returns-2', [{ item: a, verdict: 'pass' }, { item: c, verdict: 'fail' }]);
  await rework(state, recorded, 'returns-2', undefined, gates(t.run));
  const later = openCalls(t.calls)[1]!;
  assert.deepEqual([flagOf(later, '--scope'), flagOf(later, '--exclude')], [join('rework-2', 'compile-scope.json'), `${LEFT_OUT},${b}`]);
  assert.deepEqual(JSON.parse(readFileSync(join('rework-2', 'compile-scope.json'), 'utf8')), SCOPE);

  // delivery volume: the case that used its last round is dropped
  const volume = await afterDevice(([x, y, z]) => [{ item: x, verdict: 'pass' }, { item: y, verdict: 'fail' }, { item: z, verdict: 'pass' }]);
  volume.state.cases[1]!.device_rounds = 2;
  const dropped = volume.state.cases[1]!.autoid;
  await rework(volume.state, { ...OPENED, scope: SCOPE, exclude: [LEFT_OUT, dropped] }, 'returns-1', undefined, gates(volume.t.run));
  const [deliver] = openCalls(volume.t.calls);
  assert.equal(flagOf(deliver!, '--scope'), join('deliver-1', 'compile-scope.json'));
  assert.deepEqual(JSON.parse(readFileSync(join('deliver-1', 'compile-scope.json'), 'utf8')), SCOPE);
  assert.equal(flagOf(deliver!, '--exclude'), `${LEFT_OUT},${dropped}`, 'a case in both lists is named once');
  assert.equal(volume.state.volume?.n, 1);
});

test('a record without what the first open was given opens the next plan run as it always did, and a record whose entries are malformed is refused before anything is opened', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
  for (const [broken, said] of [[{ scope: { words: 1, cases: [] } }, /--open 里的 scope 不是 \{"words":"…","cases":\[…\]\} 的形状/], [{ scope: { words: '范围', cases: [7] } }, /--open 里的 scope 不是/], [{ exclude: LEFT_OUT }, /--open 里的 exclude 不是 autoid 的列表/], [{ exclude: [LEFT_OUT, 5] }, /--open 里的 exclude 不是 autoid 的列表/], [{ version: 3.2 }, /--open 里的 version 不是版本线的名字/], [{ contract: '' }, /--open 里的 contract 不是命名文档的名字/], [{ inventory: ['doc:doc:x'] }, /--open 里的 inventory 不是命名文档的名字/], [{ profile: null }, /--open 里的 profile 不是命名文档的名字/]] as const) {
    await assert.rejects(rework(state, { ...OPENED, ...broken }, 'returns-1', undefined, gates(t.run)), said);
  }
  assert.deepEqual([openCalls(t.calls), existsSync('rework-2')], [[], false], 'nothing was opened and no directory was made');
  await rework(state, OPENED, 'returns-1', 'notes', gates(t.run));
  const [opened] = openCalls(t.calls);
  assert.deepEqual([opened!.includes('--scope'), opened!.includes('--exclude'), existsSync(join('rework-2', 'compile-scope.json'))], [false, false, false]);
  assert.deepEqual(namedFlags(opened!), [undefined, undefined, undefined, undefined], 'no version line and no named document is passed: the defaults are the open\'s own');
  const recorded = JSON.parse(readFileSync(state.open!, 'utf8'));
  assert.deepEqual(['scope', 'exclude', ...NAMES].filter((field) => field in recorded), []);
});

test('a rework opens the next plan run with the version line or the named document the compile was opened with, in every round, and with none of them when it was opened with none', async () => {
  for (const name of NAMES) {
    const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }]);
    const only = (other: string) => other === name ? NAMED[name] : undefined;
    await rework(state, { ...OPENED, [name]: NAMED[name] }, 'returns-1', 'notes', gates(t.run));
    assert.deepEqual(namedFlags(openCalls(t.calls)[0]!), NAMES.map(only), `${name}: only the one given is passed`);
    const recorded = JSON.parse(readFileSync(state.open!, 'utf8'));
    assert.deepEqual(NAMES.filter((other) => other in recorded), [name], `${name}: the next open wrote it down`);
    // The round after it starts from that record.
    await writeFile(join('cases', '01', 'plan', '01.json'), '{"plan":"01 round 2"}');
    await next(state, '编写 01', gates(t.run));
    await returned('returns-2', state.cases.map((c) => ({ item: c.autoid, verdict: c.k === '01' ? 'fail' : 'pass' })));
    await rework(state, recorded, 'returns-2', undefined, gates(t.run));
    assert.deepEqual(namedFlags(openCalls(t.calls)[1]!), NAMES.map(only), `${name}: the second round`);
  }
});

test('a reopen and a delivery volume open the next plan run with the version line and the named documents too', async () => {
  const given = NAMES.map((name) => NAMED[name]);
  const reopened = await afterDevice(() => []);
  reopened.state.open = 'open-compile.json';
  const stopped = reopened.state.cases[1]!;
  stopped.stage = 'stopped'; stopped.attempts = { recompose: 1, write: 5 }; stopped.stopped = '脚本编写 5 次仍未通过：合成原因'; stopped.retried = OPEN.plan_run;
  await reopen(reopened.state, { ...OPENED, ...NAMED }, undefined, gates(reopened.t.run));
  assert.deepEqual(namedFlags(openCalls(reopened.t.calls)[0]!), given);
  assert.deepEqual(NAMES.map((name) => JSON.parse(readFileSync(reopened.state.open!, 'utf8'))[name]), given, 'and the record of that open says so');
  const volume = await afterDevice(([x, y, z]) => [{ item: x, verdict: 'pass' }, { item: y, verdict: 'fail' }, { item: z, verdict: 'pass' }]);
  volume.state.cases[1]!.device_rounds = 2;
  await rework(volume.state, { ...OPENED, ...NAMED, scope: SCOPE, exclude: [LEFT_OUT] }, 'returns-1', undefined, gates(volume.t.run));
  const [deliver] = openCalls(volume.t.calls);
  assert.deepEqual(namedFlags(deliver!), given);
  assert.deepEqual([flagOf(deliver!, '--scope'), volume.state.volume?.n], [join('deliver-1', 'compile-scope.json'), 1], 'beside the scope and the left-out cases, which are passed as before');
  assert.deepEqual(NAMES.map((name) => JSON.parse(readFileSync(volume.state.open!, 'utf8'))[name]), given);
});

const withoutPlumb = (run: RunTool): Gates => ({ run, hub: 'http://127.0.0.1:9/mcp', plumb: '', token: 'synthetic-token-1234', plumbKey: '' });

test('judge model: a written case passes the tree-only command check and the blind fidelity audit, Plumb is never asked, and every case says who judged', async () => {
  await world(1);
  const t = tools((tool, args) => {
    if (tool === 'cmd-verify-plumb.ts') return ok(JSON.stringify({ judge: 'tree-only', review_required_count: 2 }));
    if (tool === 'fidelity-brief.ts') { writeFileSync(join(args[args.indexOf('--out') + 1]!, '00.abcd1234.brief.json'), '{}'); return ok(); }
    return undefined;
  });
  const state = await initState('recompose-run', 'plan-run', { ...OPEN, judge: 'model' }, 'synthetic-model');
  assert.equal(state.judge, 'model');
  assert.equal('judge' in (await initState('recompose-run', 'plan-run', OPEN, 'synthetic-model')), false, 'the default keeps the state as it was');
  const c = state.cases[0]!; c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true;
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  const step = await next(state, '编写 00', withoutPlumb(t.run));
  assert.deepEqual(step.actions.map((a) => [a.label, a.subagent_type]), [['审计 00', 'case-compile:compile-fidelity']]);
  const verify = t.calls.find((x) => x.tool === 'case-compile/cmd-verify-plumb.ts')!;
  assert.deepEqual(verify.args, ['--plans', join('cases', '00', 'plan'), '--run', 'plan-run', '--tree-only']);
  assert.equal(verify.stdin, undefined, 'no key is handed over');
  assert.deepEqual(t.calls.filter((x) => x.tool === 'case-compile/fidelity-plumb.ts' || x.tool.startsWith('plumb/')), []);
  await writeFile(join('cases', '00', 'audit', '00.abcd1234.verdict.json'), '{}');
  const done = await next(state, '审计 00', withoutPlumb(t.run));
  assert.deepEqual(done.ready, ['00']);
  const collected = await collect(state, 'plans');
  assert.equal(collected.reviewed!.length, 1);
  assert.match(collected.reviewed![0]!.notes[0]!, /^判断方式：这次按使用者选定的方式不经 Plumb。命令核验只做了命令树的程序核对；场景保真由独立盲审（通用模型）判断，状态未确认/);
  assert.match(collected.reviewed![0]!.notes[1]!, /有 2 步命令树核对没有结论.*状态未知/);
});

test('judge model: a command the tree refuses goes back to the writer, and the judge note is written once however often the case is written', async () => {
  await world(1);
  let verified = 0;
  const t = tools((tool, args) => {
    if (tool === 'cmd-verify-plumb.ts') return ++verified === 1 ? bad('参数无效：命令核验未通过（阻断 1 处）') : ok(JSON.stringify({ review_required_count: 0 }));
    if (tool === 'fidelity-brief.ts') { writeFileSync(join(args[args.indexOf('--out') + 1]!, '00.abcd1234.brief.json'), '{}'); writeFileSync(join(args[args.indexOf('--out') + 1]!, '00.abcd1234.verdict.json'), '{}'); return ok(); }
    return undefined;
  });
  const state = await initState('recompose-run', 'plan-run', { ...OPEN, judge: 'model' }, 'synthetic-model');
  const c = state.cases[0]!; c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true;
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  const again = await next(state, '编写 00', withoutPlumb(t.run));
  assert.equal(again.actions[0]!.label, '编写 00');
  const note = t.calls.filter((x) => x.tool === 'case-compile/task-brief.ts').at(-1)!.args;
  assert.match(note[note.indexOf('--note') + 1]!, /命令核验没有通过/);
  const done = await next(state, '编写 00', withoutPlumb(t.run));
  assert.deepEqual(done.ready, ['00'], 'a verdict already written for this brief is merged without another audit');
  assert.equal(c.review!.filter((line) => line.startsWith('判断方式：')).length, 1);
});

test('judge model: a plan the tree check looked at no command of says so in the case\'s notes, and the note is written once for a plan version however often the check runs again', async () => {
  await world(1);
  let said: Record<string, unknown> = { review_required_count: 0, steps_checked: 0, checked: 0 };
  const t = tools((tool, args) => {
    if (tool === 'cmd-verify-plumb.ts') return ok(JSON.stringify(said));
    if (tool === 'fidelity-brief.ts') { writeFileSync(join(args[args.indexOf('--out') + 1]!, '00.abcd1234.brief.json'), '{}'); return ok(); }
    return undefined;
  });
  const state = await initState('recompose-run', 'plan-run', { ...OPEN, judge: 'model' }, 'synthetic-model');
  const c = state.cases[0]!; c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true;
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  const notes = () => c.review!.filter((line) => line.startsWith('命令核验：'));
  await next(state, '编写 00', withoutPlumb(t.run));
  assert.deepEqual(notes(), ['命令核验：第 1 版计划没有核对任何命令（计划标为跳过），命令树核对一步也没有做，这次不经 Plumb，状态未知；下一步由使用者确认这条用例本来就不下发设备命令']);
  c.stage = 'writing';
  await next(state, '编写 00', withoutPlumb(t.run));
  assert.equal(notes().length, 1, 'the same plan version, checked again, adds nothing');

  // The next version has commands in no step: another reason, said as its own note.
  said = { review_required_count: 0, steps_checked: 0, checked: 1 };
  c.stage = 'writing'; c.attempts.write = 2;
  await next(state, '编写 00', withoutPlumb(t.run));
  assert.deepEqual(notes().slice(1), ['命令核验：第 2 版计划没有核对任何命令（计划里没有一步下发设备命令），命令树核对一步也没有做，这次不经 Plumb，状态未知；下一步由使用者确认这条用例本来就不下发设备命令']);

  // A plan the tree did look at says nothing of the kind.
  said = { review_required_count: 0, steps_checked: 2, checked: 1 };
  c.stage = 'writing'; c.attempts.write = 3;
  await next(state, '编写 00', withoutPlumb(t.run));
  assert.equal(notes().length, 2);
});

test('judge model: the note about steps the tree could not settle is written once for a plan version, and again for the next one', async () => {
  await world(1);
  let steps = 2;
  const t = tools((tool, args) => {
    if (tool === 'cmd-verify-plumb.ts') return ok(JSON.stringify({ review_required_count: steps, steps_checked: 3, checked: 1 }));
    if (tool === 'fidelity-brief.ts') { writeFileSync(join(args[args.indexOf('--out') + 1]!, '00.abcd1234.brief.json'), '{}'); return ok(); }
    return undefined;
  });
  const state = await initState('recompose-run', 'plan-run', { ...OPEN, judge: 'model' }, 'synthetic-model');
  const c = state.cases[0]!; c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true;
  await mkdir(join('cases', '00', 'plan'), { recursive: true }); await writeFile(join('cases', '00', 'plan', '00.json'), '{}');
  const notes = () => c.review!.filter((line) => /^命令核验：第 \d+ 版计划有 \d+ 步命令树核对没有结论/.test(line));
  for (let again = 0; again < 3; again++) { c.stage = 'writing'; await next(state, '编写 00', withoutPlumb(t.run)); }
  assert.equal(notes().length, 1, 'three passes of one plan version through the check: one note');
  assert.match(notes()[0]!, /^命令核验：第 1 版计划有 2 步命令树核对没有结论/);
  steps = 1; c.stage = 'writing'; c.attempts.write = 2;
  await next(state, '编写 00', withoutPlumb(t.run));
  assert.deepEqual(notes().map((line) => /^命令核验：第 (\d+) 版计划有 (\d+) 步/.exec(line)!.slice(1)), [['1', '2'], ['2', '1']]);
  assert.equal(c.review!.filter((line) => line.startsWith('判断方式：')).length, 1, 'and the judge note stays one');
});

// What the tree-only check and the blind audit say in a compile that Plumb does not judge, for a case written again after a device round.
const modelGates = (written: string[]) => (tool: string, args: string[]): ToolRun | undefined => {
  if (tool === 'cmd-verify-plumb.ts') return ok(JSON.stringify({ judge: 'tree-only', review_required_count: 0, steps_checked: 3, checked: 1 }));
  if (tool === 'fidelity-brief.ts') {
    const out = args[args.indexOf('--out') + 1]!;
    for (const k of written) { writeFileSync(join(out, `${k}.abcd1234.brief.json`), '{}'); writeFileSync(join(out, `${k}.abcd1234.verdict.json`), '{}'); }
    return ok();
  }
  return undefined;
};
// A call that asks Plumb: the plumb skill's own tools, the fidelity judgment, the command selection, and the command check without --tree-only.
const asksPlumb = (call: { tool: string; args: string[] }): boolean =>
  call.tool.startsWith('plumb/') || call.tool.endsWith('/fidelity-plumb.ts') || call.tool.endsWith('/cmd-select-plumb.ts') || (call.tool.endsWith('/cmd-verify-plumb.ts') && !call.args.includes('--tree-only'));

test('judge model: a device round is reworked without Plumb: the new plan run is opened without its address, what passed is carried untouched, and the case written again goes through the tree-only check and the blind audit alone', async () => {
  const { state, t } = await afterDevice(([a, b, c]) => [{ item: a, verdict: 'pass' }, { item: b, verdict: 'fail' }, { item: c, verdict: 'pass' }], { judge: 'model', more: modelGates(['01']) });
  const step = await rework(state, OPENED, 'returns-1', 'notes', withoutPlumb(t.run));
  assert.deepEqual([step.round, step.carried, step.reworked, step.actions.map((a) => a.label)], [2, ['00', '02'], ['01'], ['编写 01']]);
  const opened = t.calls.find((c) => c.tool === 'case-compile/open-compile.ts')!;
  assert.deepEqual(opened.args.slice(0, 4), ['--hub', 'http://127.0.0.1:9/mcp', '--judge', 'model']);
  assert.equal(opened.args.includes('--plumb'), false, 'no Plumb address is handed to the new run');
  assert.equal(opened.stdin, 'synthetic-token-1234\n\n', 'the Hub token, and an empty line where the key would be: nothing is handed over that this compile does not use');
  assert.equal(state.judge, 'model', 'the new plan run is judged as the first was');
  assert.deepEqual(['00', '02'].map((k) => readFileSync(join('cases', k, 'ready', `${k}.json`), 'utf8')), ['{"plan":"00 carried"}', '{"plan":"02 carried"}']);
  await writeFile(join('cases', '01', 'plan', '01.json'), '{"plan":"01 round 2"}');
  const written = await next(state, '编写 01', withoutPlumb(t.run));
  assert.deepEqual(written.ready, ['00', '01', '02'], 'the audit verdict of the brief is merged and the case is ready');
  const verify = t.calls.filter((c) => c.tool === 'case-compile/cmd-verify-plumb.ts');
  assert.deepEqual(verify.map((c) => [c.args, c.stdin]), [[['--plans', join('cases', '01', 'plan'), '--run', join('rework-2', 'plan-run'), '--tree-only'], undefined]], 'only the case written again is checked, against the new plan run, and no key is handed over');
  assert.deepEqual(t.calls.filter(asksPlumb), [], 'no tool that asks Plumb ran: no wake, no fidelity judgment, no command selection');
  const collected = await collect(state, 'plans-2');
  assert.deepEqual(['00', '01', '02'].map((k) => readFileSync(join('plans-2', `${k}.json`), 'utf8')), ['{"plan":"00 carried"}', '{"plan":"01 round 2"}', '{"plan":"02 carried"}']);
  assert.deepEqual(collected.reviewed!.map((row) => row.notes.some((note) => /^判断方式：这次按使用者选定的方式不经 Plumb/.test(note))), [true], 'the case judged in this round says who judged');
});

test('judge model: a case that stops again leaves this compile through reopen, which opens the new plan run without Plumb, carries the others and judges the case written again as before', async () => {
  const { state, t } = await afterDevice(() => [], { judge: 'model', more: modelGates(['02']) });
  state.open = 'open-compile.json';
  const b = state.cases[1]!;
  b.stage = 'stopped'; b.attempts = { recompose: 1, write: 5 }; b.stopped = '脚本编写 5 次仍未通过：合成原因'; b.retried = OPEN.plan_run;
  const step = await reopen(state, OPENED, undefined, withoutPlumb(t.run));
  assert.match(step.message, /^新开脚本编写运行 run_01planplanplanplanplan01（reopen-1\/open-compile\.json）：2 条就绪的计划已原样结转；retry 后又停下的 1 条不进这次编译（01）/);
  const opened = t.calls.find((c) => c.tool === 'case-compile/open-compile.ts')!;
  assert.deepEqual(opened.args.slice(0, 4), ['--hub', 'http://127.0.0.1:9/mcp', '--judge', 'model']);
  assert.equal(opened.args.includes('--plumb'), false);
  assert.equal(opened.args[opened.args.indexOf('--exclude') + 1], b.autoid, 'the case that stopped again stays out');
  assert.equal(opened.stdin, 'synthetic-token-1234\n\n');
  assert.deepEqual([state.judge, state.cases.map((c) => c.stage)], ['model', ['ready', 'excluded', 'ready']]);
  assert.deepEqual(t.calls.filter(asksPlumb), []);
  // A plan that the carry does not take is written again in the new run and goes through the same gates, still without Plumb.
  state.cases[2]!.stage = 'writing';
  await writeFile(join('cases', '02', 'plan', '02.json'), '{"plan":"02 again"}');
  const again = await next(state, '编写 02', withoutPlumb(t.run));
  assert.deepEqual(again.ready, ['00', '02']);
  assert.deepEqual(t.calls.filter((c) => c.tool === 'case-compile/cmd-verify-plumb.ts').map((c) => c.args.at(-1)), ['--tree-only']);
  assert.deepEqual(t.calls.filter(asksPlumb), []);
});

test('the command line asks for the Plumb address and key only when Plumb is the judge of this compile', async () => {
  await world(1);
  const t = tools(() => undefined);
  const said = async (argv: string[], stdin: string[]) => {
    const out: string[] = []; const write = process.stdout.write;
    process.stdout.write = ((text: string) => { out.push(text); return true; }) as typeof process.stdout.write;
    try { return { code: await main(argv, async () => stdin, t.run), out: out.join('') }; } finally { process.stdout.write = write; }
  };
  const save = async (file: string, open: Record<string, unknown>) => { const state = await initState('recompose-run', 'plan-run', open, 'synthetic-model'); state.cases[0]!.stage = 'recomposing'; state.cases[0]!.action = { label: '重组 00', subagent_type: 'x', description: 'y' }; writeFileSync(file, JSON.stringify(state)); };
  await save('plumb.json', OPEN); await save('model.json', { ...OPEN, judge: 'model' });
  const refused = await said(['resume', '--state', 'plumb.json', '--hub', 'http://127.0.0.1:9/mcp'], ['synthetic-token-1234']);
  assert.equal(refused.code, 1); assert.match(refused.out, /缺 --plumb <Plumb地址>（这次编译的判断方式是 Plumb）/);
  const noKey = await said(['resume', '--state', 'plumb.json', '--hub', 'http://127.0.0.1:9/mcp', '--plumb', 'https://127.0.0.1:9'], ['synthetic-token-1234']);
  assert.equal(noKey.code, 1); assert.match(noKey.out, /第二行 %PLUMB_API_KEY%/);
  const allowed = await said(['resume', '--state', 'model.json', '--hub', 'http://127.0.0.1:9/mcp'], ['synthetic-token-1234']);
  assert.equal(allowed.code, 0, allowed.out);
});

test('judge reads from the state file who judges this compile, and needs no service, no standard input and no tool', async () => {
  await world(1);
  const t = tools(() => undefined);
  const said = async (argv: string[]) => {
    const out: string[] = []; const write = process.stdout.write;
    process.stdout.write = ((text: string) => { out.push(text); return true; }) as typeof process.stdout.write;
    try { return { code: await main(argv, async () => { throw new Error('judge reads no standard input'); }, t.run), out: out.join('') }; } finally { process.stdout.write = write; }
  };
  const save = async (file: string, open: Record<string, unknown>) => writeFileSync(file, JSON.stringify(await initState('recompose-run', 'plan-run', open, 'synthetic-model')));
  await save('plumb.json', OPEN); await save('model.json', { ...OPEN, judge: 'model' });
  const written = JSON.parse(readFileSync('plumb.json', 'utf8')) as PipelineState;
  assert.equal(written.judge, undefined, 'a state that was opened without the choice has no judge field');
  writeFileSync('explicit-plumb.json', JSON.stringify({ ...written, judge: 'plumb' }));

  const plumb = await said(['judge', '--state', 'plumb.json']);
  assert.deepEqual([plumb.code, plumb.out], [0, '{"judge":"plumb"}\n']);
  const model = await said(['judge', '--state', 'model.json']);
  assert.deepEqual([model.code, model.out], [0, '{"judge":"model"}\n']);
  assert.equal((await said(['judge', '--state', 'explicit-plumb.json'])).out, '{"judge":"plumb"}\n');

  writeFileSync('not-a-state.json', '{"judge":"model"}');
  const wrong = await said(['judge', '--state', 'not-a-state.json']);
  assert.equal(wrong.code, 1); assert.match(wrong.out, /^流水线工具没有完成：--state not-a-state\.json 不是流水线的状态文件/);
  const missing = await said(['judge', '--state', 'absent.json']);
  assert.equal(missing.code, 1); assert.match(missing.out, /^流水线工具没有完成：/);
  const noState = await said(['judge']);
  assert.equal(noState.code, 1); assert.match(noState.out, /缺少必填参数 --state/);
  assert.deepEqual(t.calls, [], 'no tool ran');
});

test('judge model: a client that does not know %PLUMB_URL% and %PLUMB_API_KEY% leaves them in the loop\'s commands, and resume and next neither need nor hand them to any tool', async () => {
  await world(2);
  const t = tools((tool, args) => {
    if (tool === 'cmd-verify-plumb.ts') return ok(JSON.stringify({ judge: 'tree-only', review_required_count: 0 }));
    if (tool === 'fidelity-brief.ts') { writeFileSync(join(args[args.indexOf('--out') + 1]!, 'x.abcd1234.brief.json'), '{}'); return ok(); }
    return undefined;
  });
  const said = async (argv: string[], stdin: string[]) => {
    const out: string[] = []; const write = process.stdout.write;
    process.stdout.write = ((text: string) => { out.push(text); return true; }) as typeof process.stdout.write;
    try { return { code: await main(argv, async () => stdin, t.run), out: out.join('') }; } finally { process.stdout.write = write; }
  };
  // Case 00 has just been written; case 01 is waiting, so that resume goes through the same gates as next does.
  const state = await initState('recompose-run', 'plan-run', { ...OPEN, judge: 'model' }, 'synthetic-model');
  for (const c of state.cases) {
    c.stage = 'writing'; c.attempts = { recompose: 1, write: 1 }; c.record_accepted = true;
    await mkdir(join('cases', c.k, 'plan'), { recursive: true }); await writeFile(join('cases', c.k, 'plan', `${c.plan.index}.json`), '{}');
  }
  state.cases[0]!.action = { label: '编写 00', subagent_type: 'case-compile:compile-writer', description: '合成任务' };
  state.cases[1]!.pending = '合成：上一次没有做完，等着再看';
  writeFileSync('model.json', JSON.stringify(state));
  const loop = ['--hub', 'http://127.0.0.1:9/mcp', '--plumb', '%PLUMB_URL%'], stdin = ['synthetic-token-1234', '%PLUMB_API_KEY%'];
  const labels = (out: string) => (JSON.parse(out) as { actions: Array<{ label: string }> }).actions.map((a) => a.label);
  const resumed = await said(['resume', '--state', 'model.json', ...loop], stdin);
  assert.equal(resumed.code, 0, resumed.out);
  assert.deepEqual(labels(resumed.out), ['编写 00', '审计 01'], 'the waiting case went through the tree-only check and on to the blind audit');
  const nexted = await said(['next', '--state', 'model.json', '--finished', '编写 00', ...loop], stdin);
  assert.equal(nexted.code, 0, nexted.out);
  assert.deepEqual(labels(nexted.out), ['审计 00']);
  const verifies = t.calls.filter((call) => call.tool === 'case-compile/cmd-verify-plumb.ts');
  assert.equal(verifies.length, 2, 'both cases were checked');
  for (const verify of verifies) {
    assert.equal(verify.args.at(-1), '--tree-only');
    assert.equal(verify.args.includes('--base-url'), false);
    assert.equal(verify.stdin, undefined, 'no key is handed over');
  }
  assert.deepEqual(t.calls.filter((call) => call.tool.startsWith('plumb/') || call.tool === 'case-compile/fidelity-plumb.ts' || call.tool === 'case-compile/cmd-select-plumb.ts'), [], 'no Plumb tool is called');
  assert.deepEqual(t.calls.filter((call) => [...call.args, call.stdin ?? ''].some((text) => text.includes('%PLUMB_'))), [], 'neither unexpanded name reaches any tool');
});
