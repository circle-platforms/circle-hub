import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { envelopeOf, main, plumbProblem, type CallTool, type PlumbStatus, type ToolAnswer } from './open-compile.ts';

const BOOKING = 'run_01bookingbookingbooking0', RECOMPOSE = 'run_01recomposerecompose00', PLAN = 'run_01planplanplanplanplan00';
const said = (envelope: Record<string, unknown>, failed = false): ToolAnswer => ({ failed, text: `合成答复\n供模型引用\n${JSON.stringify(envelope)}`, envelope });
async function skills(versions: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'open-compile-skills-'));
  for (const [pack, version] of Object.entries(versions)) { await mkdir(join(root, pack), { recursive: true }); await writeFile(join(root, pack, 'pack.json'), JSON.stringify({ id: pack, version })); }
  return root;
}
function hub(answers: Partial<Record<string, ToolAnswer | ((args: Record<string, unknown>) => ToolAnswer)>>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call: CallTool = async (name, args) => {
    calls.push({ name, args });
    const key = name === 'start_run' ? `start_run:${String(args.pack)}` : name;
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected call ${key}`);
    return typeof answer === 'function' ? answer(args) : answer;
  };
  return { calls, connect: () => call };
}
const packs = (cc = '3.22.0', rc = '1.3.0') => said({ call_result: 'ok', packs: [{ pack: `case-compile@${cc}`, id: 'case-compile', version: cc }, { pack: `recompose@${rc}`, id: 'recompose', version: rc }] });
const READY = { status: 'ready', phase: 'ready', models_status: { 'judge-a': { model: 'judge-a', step: 'ready', state: '可用', self_check_passed: true } } };
const argv = (out: string, extra: string[] = []) => ['--hub', 'http://127.0.0.1:9/mcp', '--plumb', 'https://127.0.0.1:9', '--subject', 'agile:mindmap:900001', '--product', 'widget', '--build', 'Fixture_Build_A', '--booking', BOOKING, '--out', out, ...extra];
async function run(args: string[], connect: (o: string, b: string) => CallTool, root: string, plumb: PlumbStatus = async () => READY, stdin: string[] = ['synthetic-token-1234', 'synthetic-plumb-key']) {
  const out: string[] = []; const write = process.stdout.write;
  process.stdout.write = ((text: string) => { out.push(text); return true; }) as typeof process.stdout.write;
  try { return { code: await main(args, async () => stdin, connect, root, plumb), out: out.join('') }; } finally { process.stdout.write = write; }
}

test('ready: both runs open in order, the plan run binds the recompose run after the start, and open-compile.json is written', async () => {
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const h = hub({ list_task_packs: packs(), 'start_run:recompose': said({ call_result: 'ok', record: 'rec:' + 'a'.repeat(64), run: { run: RECOMPOSE, items: [{}, {}] } }), 'start_run:case-compile': said({ call_result: 'ok', record: 'rec:' + 'b'.repeat(64), run: { run: PLAN, items: [{}, {}] } }) });
  const result = await run(argv(join(dir, 'open-compile.json')), h.connect, root);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, new RegExp(`^就绪：用例重组运行 ${RECOMPOSE}、脚本编写运行 ${PLAN}，共 2 条用例`));
  assert.deepEqual(h.calls.map((c) => c.name + ':' + String(c.args.pack ?? '')), ['list_task_packs:', 'start_run:recompose', 'start_run:case-compile']);
  const plan = h.calls[2]!.args as { predecessor: string; inputs: Record<string, unknown> };
  assert.equal(plan.predecessor, BOOKING);
  assert.deepEqual(plan.inputs.recomposition_run, { reference: 'rec:' + 'a'.repeat(64) });
  assert.deepEqual(plan.inputs.recomposition_result, { run: RECOMPOSE }, 'bound by run id: the Hub binds its result after the start');
  assert.deepEqual([plan.inputs.contract, plan.inputs.inventory, plan.inputs.profile], [{ external: 'doc:doc:runner-contract' }, { external: 'doc:doc:bed-topology' }, { external: 'doc:doc:runtime-profile' }]);
  const written = JSON.parse(await readFile(join(dir, 'open-compile.json'), 'utf8'));
  assert.equal(written.ready, true); assert.equal(written.plan_run, PLAN); assert.equal(written.recompose_run, RECOMPOSE);
});

test('not ready: an installed skill of another version than the Hub publishes stops it before any run is opened', async () => {
  const root = await skills({ 'case-compile': '3.21.7', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const h = hub({ list_task_packs: packs() });
  const result = await run(argv(join(dir, 'o.json')), h.connect, root);
  assert.equal(result.code, 1);
  assert.equal(result.out, '无法编译：本机 case-compile 技能是 3.21.7，Hub 发布的是 3.22.0；下一步：重装 3.22.0 再开编译\n');
  assert.equal(h.calls.length, 1);
});

test('not ready: the plan run refused at the start is said in the Hub\'s words with location and next step, nothing is retried', async () => {
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const refused = said({ call_result: 'error', errors: [{ code: 'case-compile.profile_invalid', message: '运行环境配置有 1 个问题，整份拒绝：/bed：运行环境配置属于自动化测试环境 bed-a，本谱系预订的是 bed-b', fix: '/bed：绑定属于 bed-b 的运行环境配置命名文档', path: '/inputs/profile' }] }, true);
  const h = hub({ list_task_packs: packs(), 'start_run:recompose': said({ call_result: 'ok', record: 'rec:' + 'a'.repeat(64), run: { run: RECOMPOSE, items: [] } }), 'start_run:case-compile': refused });
  const result = await run(argv(join(dir, 'o.json')), h.connect, root);
  assert.equal(result.code, 1);
  assert.equal(result.out, `无法编译：运行环境配置有 1 个问题，整份拒绝：/bed：运行环境配置属于自动化测试环境 bed-a，本谱系预订的是 bed-b（位置 /inputs/profile）；下一步：/bed：绑定属于 bed-b 的运行环境配置命名文档。已开的用例重组运行 ${RECOMPOSE} 没有用到，不影响下一次\n`);
  assert.equal(h.calls.filter((c) => c.name === 'start_run').length, 2, 'no rebinding and no retry');
});

test('not ready: a refused recompose start and a bad argument are one line each and open nothing else', async () => {
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const h = hub({ list_task_packs: packs(), 'start_run:recompose': said({ call_result: 'error', errors: [{ code: 'SOURCE_ABSENT', message: '敏捷平台上没有文档 900001', path: '/inputs/subject', fix: '核对文档号' }] }, true) });
  const refused = await run(argv(join(dir, 'o.json')), h.connect, root);
  assert.equal(refused.code, 1);
  assert.equal(refused.out, '无法编译：用例重组运行开不起来：敏捷平台上没有文档 900001（位置 /inputs/subject）；下一步：核对文档号\n');
  const existing = join(dir, 'exists.json'); await writeFile(existing, '{}');
  const again = hub({});
  const out = await run(argv(existing), again.connect, root);
  assert.equal(out.code, 1); assert.match(out.out, /^无法编译：--out .+ 已经存在，不覆盖/); assert.equal(again.calls.length, 0);
  const badDoc = await run(argv(join(dir, 'n.json'), ['--profile', 'runtime-profile']), again.connect, root);
  assert.match(badDoc.out, /^无法编译：--profile 不是命名文档；写 doc:doc:<名字>/);
});

test('the machine part of a tool answer is the JSON after the marker', () => {
  assert.deepEqual(envelopeOf('文字\n供模型引用\n{"call_result":"ok"}'), { call_result: 'ok' });
  assert.deepEqual(envelopeOf('{"call_result":"error"}'), { call_result: 'error' });
  assert.equal(envelopeOf('没有机器部分'), null);
});

test('not ready: a Plumb judge that is not ready, or no Plumb key on the second stdin line, stops it before any run is opened', async () => {
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const asleep = hub({ list_task_packs: packs() });
  const sleeping = await run(argv(join(dir, 'a.json')), asleep.connect, root, async () => ({ status: 'stopped', phase: 'idle_shutdown', models_status: {} }));
  assert.equal(sleeping.code, 1);
  assert.equal(sleeping.out, '无法编译：Plumb 判定服务没有就绪（status=stopped，phase=idle_shutdown，没有已加载的模型）；下一步：唤醒 Plumb，等状态为 ready 后重跑\n');
  assert.equal(asleep.calls.filter((c) => c.name === 'start_run').length, 0);
  const keyless = hub({ list_task_packs: packs() });
  const noKey = await run(argv(join(dir, 'b.json')), keyless.connect, root, async () => READY, ['synthetic-token-1234']);
  assert.match(noKey.out, /^无法编译：标准输入第二行没有 Plumb 密钥/);
  assert.equal(keyless.calls.length, 0);
});

test('a model still loading or failing its self check is named', () => {
  assert.equal(plumbProblem(READY), null);
  assert.match(plumbProblem({ status: 'ready', phase: 'ready', models_status: { 'judge-a': { model: 'judge-a', step: 'loading', self_check_passed: false } } })!, /未就绪模型 judge-a（loading）/);
});

test('a rework plan run reuses the accepted recompose run: no recompose start, the given run and record bound', async () => {
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const h = hub({ list_task_packs: packs(), 'start_run:case-compile': said({ call_result: 'ok', record: 'rec:' + 'b'.repeat(64), run: { run: PLAN, items: [{}] } }) });
  const result = await run(argv(join(dir, 'r.json'), ['--recompose-run', RECOMPOSE, '--recompose-record', 'rec:' + 'c'.repeat(64)]), h.connect, root);
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(h.calls.map((c) => c.name + ':' + String(c.args.pack ?? '')), ['list_task_packs:', 'start_run:case-compile']);
  const inputs = (h.calls[1]!.args as { inputs: Record<string, unknown> }).inputs;
  assert.deepEqual([inputs.recomposition_run, inputs.recomposition_result], [{ reference: 'rec:' + 'c'.repeat(64) }, { run: RECOMPOSE }]);
  const half = await run(argv(join(dir, 's.json'), ['--recompose-run', RECOMPOSE]), h.connect, root);
  assert.match(half.out, /^无法编译：--recompose-run 和 --recompose-record 要一起写/);
});
