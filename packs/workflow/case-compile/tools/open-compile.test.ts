import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { envelopeOf, main, NotReady, plumbProblem, plumbStatusVia, type CallTool, type PlumbStatus, type ToolAnswer } from './open-compile.ts';

const BOOKING = 'run_01bookingbookingbooking0', RECOMPOSE = 'run_01recomposerecompose00', PLAN = 'run_01planplanplanplanplan00';
const said = (envelope: Record<string, unknown>, failed = false): ToolAnswer => ({ failed, text: `合成答复\n供模型引用\n${JSON.stringify(envelope)}`, envelope });
async function skills(versions: Record<string, string>, plumb = true) {
  const root = await mkdtemp(join(tmpdir(), 'open-compile-skills-'));
  for (const [pack, version] of Object.entries(versions)) { await mkdir(join(root, pack), { recursive: true }); await writeFile(join(root, pack, 'pack.json'), JSON.stringify({ id: pack, version })); }
  // The Plumb status is injected in these tests, so the script of the Plumb skill is never run; only its presence is looked at.
  if (plumb) { await mkdir(join(root, 'plumb', 'tools'), { recursive: true }); await writeFile(join(root, 'plumb', 'tools', 'plumb.ts'), '// synthetic Plumb skill\n'); }
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
  assert.equal(noKey.out, "无法编译：标准输入第二行没有 Plumb 密钥；命令末尾写 <<'EOF'，依次 %HUB_TOKEN%、%PLUMB_API_KEY%、%JEV_API_KEY%，最后一行 EOF；还没有 Plumb 密钥时向管理员申请，保存为客户端密钥 PLUMB_API_KEY 后重跑\n");
  assert.deepEqual(keyless.calls.map((c) => c.name), ['list_task_packs'], 'the key is said together with the workflow checks, which need the Hub\'s list; no run is started');
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

test('the record keeps what the compile was opened with: the scope as it was read and the left-out cases, each only when given, so that a later plan run can be opened with them again', async () => {
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const answers = { list_task_packs: packs(), 'start_run:recompose': said({ call_result: 'ok', record: 'rec:' + 'a'.repeat(64), run: { run: RECOMPOSE, items: [{}] } }), 'start_run:case-compile': said({ call_result: 'ok', record: 'rec:' + 'b'.repeat(64), run: { run: PLAN, items: [{}] } }) };
  const scope = { words: '只编这两条：“改密码”和 "退出"，a\\b（第二行\n还有一行 ）', cases: ['990000000000000001', '990000000000000002'] };
  await writeFile(join(dir, 'scope.json'), JSON.stringify({ ...scope, note: 'a field the tool does not read' }));
  const h = hub(answers);
  const given = await run(argv(join(dir, 'open-compile.json'), ['--scope', join(dir, 'scope.json'), '--exclude', ' 990000000000000009 , 990000000000000008,']), h.connect, root);
  assert.equal(given.code, 0, given.out);
  const written = JSON.parse(await readFile(join(dir, 'open-compile.json'), 'utf8'));
  assert.deepEqual([written.scope, written.exclude], [scope, ['990000000000000009', '990000000000000008']], 'the words and cases as read, the list as split');
  assert.deepEqual(JSON.parse(given.out.trimEnd().split('\n').at(-1)!), written, 'the line printed is the record');
  const parameters = h.calls.filter((c) => c.name === 'start_run').map((c) => c.args.parameters);
  assert.deepEqual(parameters, [{ scope }, { scope, exclude: ['990000000000000009', '990000000000000008'] }], 'what the Hub was given: the scope for both runs, the left-out cases for the plan run');

  // Nothing given, nothing written: an exclude that names no case is none.
  for (const [name, extra] of [['plain.json', []], ['blank.json', ['--exclude', ' , ']]] as const) {
    const plain = await run(argv(join(dir, name), [...extra]), hub(answers).connect, root);
    assert.equal(plain.code, 0, plain.out);
    const record = JSON.parse(await readFile(join(dir, name), 'utf8'));
    assert.deepEqual(['scope' in record, 'exclude' in record], [false, false], name);
  }

  // A plan run opened again on the recomposition run of the first (rework): the record keeps both there too.
  const again = hub(answers);
  const reopened = await run(argv(join(dir, 'again.json'), ['--scope', join(dir, 'scope.json'), '--exclude', '990000000000000009', '--recompose-run', RECOMPOSE, '--recompose-record', 'rec:' + 'c'.repeat(64)]), again.connect, root);
  assert.equal(reopened.code, 0, reopened.out);
  assert.deepEqual(again.calls.map((c) => c.name + ':' + String(c.args.pack ?? '')), ['list_task_packs:', 'start_run:case-compile']);
  assert.deepEqual(again.calls[1]!.args.parameters, { scope, exclude: ['990000000000000009'] });
  const second = JSON.parse(await readFile(join(dir, 'again.json'), 'utf8'));
  assert.deepEqual([second.scope, second.exclude], [scope, ['990000000000000009']]);

  // A scope file that cannot be read is refused as before and nothing is written.
  const bad = await run(argv(join(dir, 'bad.json'), ['--scope', join(dir, 'missing.json')]), hub(answers).connect, root);
  assert.match(bad.out, /^无法编译：--scope 文件 .*missing\.json 读不出 JSON/);
  assert.equal(existsSync(join(dir, 'bad.json')), false);
});

test('the record keeps the version line and each named document when the compile was opened with them, and nothing of them when it was not', async () => {
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const answers = { list_task_packs: packs(), 'start_run:recompose': said({ call_result: 'ok', record: 'rec:' + 'a'.repeat(64), run: { run: RECOMPOSE, items: [{}] } }), 'start_run:case-compile': said({ call_result: 'ok', record: 'rec:' + 'b'.repeat(64), run: { run: PLAN, items: [{}] } }) };
  const named = ['version', 'contract', 'inventory', 'profile'] as const;
  const DEFAULT_DOCS = { contract: 'doc:doc:runner-contract', inventory: 'doc:doc:bed-topology', profile: 'doc:doc:runtime-profile' };
  const given = { version: '3.2', contract: 'doc:doc:other-contract', inventory: `doc:doc:other-inventory@${'d'.repeat(64)}`, profile: 'doc:doc:other-profile' };
  const fromHub = (h: ReturnType<typeof hub>) => { const [recompose, plan] = h.calls.filter((c) => c.name === 'start_run').map((c) => c.args as { version?: string; inputs: Record<string, unknown> }); return { recompose: recompose!, plan: plan! }; };
  for (const name of named) {
    const h = hub(answers), out = join(dir, `${name}.json`);
    const result = await run(argv(out, [`--${name}`, given[name]]), h.connect, root);
    assert.equal(result.code, 0, result.out);
    const record = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(named.filter((field) => field in record), [name], `only ${name} is recorded, as it was given`);
    assert.equal(record[name], given[name]);
    assert.deepEqual(JSON.parse(result.out.trimEnd().split('\n').at(-1)!), record, 'the line printed is the record');
    const { recompose, plan } = fromHub(h);
    // what the Hub was given: the version line for both runs, a named document for the plan run in place of its default
    assert.deepEqual([recompose.version, plan.version], name === 'version' ? [given.version, given.version] : [undefined, undefined], name);
    for (const doc of ['contract', 'inventory', 'profile'] as const) assert.deepEqual(plan.inputs[doc], { external: name === doc ? given[doc] : DEFAULT_DOCS[doc] }, `${name}: ${doc}`);
  }
  // None given: none recorded, and the Hub is given the defaults and no version line.
  const h = hub(answers);
  assert.equal((await run(argv(join(dir, 'plain.json')), h.connect, root)).code, 0);
  const plain = JSON.parse(await readFile(join(dir, 'plain.json'), 'utf8'));
  assert.deepEqual(named.filter((field) => field in plain), []);
  assert.deepEqual([fromHub(h).plan.version, fromHub(h).plan.inputs.contract], [undefined, { external: DEFAULT_DOCS.contract }]);
  // All four on a plan run that reuses the recomposition (a rework): the plan run is given them and the record keeps them.
  const again = hub(answers);
  const reopened = await run(argv(join(dir, 'all.json'), ['--version', given.version, '--contract', given.contract, '--inventory', given.inventory, '--profile', given.profile, '--recompose-run', RECOMPOSE, '--recompose-record', 'rec:' + 'c'.repeat(64)]), again.connect, root);
  assert.equal(reopened.code, 0, reopened.out);
  const all = JSON.parse(await readFile(join(dir, 'all.json'), 'utf8'));
  assert.deepEqual(named.map((field) => all[field]), named.map((field) => given[field]));
  const starts = again.calls.filter((c) => c.name === 'start_run').map((c) => c.args as { pack: string; version?: string; inputs: Record<string, unknown> });
  assert.deepEqual(starts.map((s) => s.pack), ['case-compile'], 'no recomposition is started');
  assert.deepEqual([starts[0]!.version, starts[0]!.inputs.contract, starts[0]!.inputs.inventory, starts[0]!.inputs.profile], [given.version, { external: given.contract }, { external: given.inventory }, { external: given.profile }]);
});

test('judge model: the user chose to compile without Plumb, so no Plumb address, key or status is needed and the choice is written into open-compile.json', async () => {
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const answers = { list_task_packs: packs(), 'start_run:recompose': said({ call_result: 'ok', record: 'rec:' + 'a'.repeat(64), run: { run: RECOMPOSE, items: [{}] } }), 'start_run:case-compile': said({ call_result: 'ok', record: 'rec:' + 'b'.repeat(64), run: { run: PLAN, items: [{}] } }) };
  const asked: string[] = [];
  const never: PlumbStatus = async (url) => { asked.push(url); throw new Error('Plumb must not be asked'); };
  const withoutPlumb = (out: string) => argv(out, ['--judge', 'model']).filter((value, n, all) => value !== '--plumb' && all[n - 1] !== '--plumb');
  const h = hub(answers);
  const result = await run(withoutPlumb(join(dir, 'open-compile.json')), h.connect, root, never, ['synthetic-token-1234']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /判断方式 model：这次不经 Plumb/);
  assert.deepEqual(asked, []);
  assert.equal(JSON.parse(await readFile(join(dir, 'open-compile.json'), 'utf8')).judge, 'model');
  const placeholder = await run(withoutPlumb(join(dir, 'second.json')), hub(answers).connect, root, never, ['synthetic-token-1234', '%PLUMB_API_KEY%']);
  assert.equal(placeholder.code, 0, 'a second stdin line that is an unset placeholder is not read in this mode');
});

test('judge defaults to plumb: the written file carries no judge, a missing Plumb address is refused, and another value is refused before any call', async () => {
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const answers = { list_task_packs: packs(), 'start_run:recompose': said({ call_result: 'ok', record: 'rec:' + 'a'.repeat(64), run: { run: RECOMPOSE, items: [{}] } }), 'start_run:case-compile': said({ call_result: 'ok', record: 'rec:' + 'b'.repeat(64), run: { run: PLAN, items: [{}] } }) };
  const usual = await run(argv(join(dir, 'open-compile.json')), hub(answers).connect, root);
  assert.equal(usual.code, 0, usual.out);
  assert.equal('judge' in JSON.parse(await readFile(join(dir, 'open-compile.json'), 'utf8')), false);
  const noAddress = hub(answers);
  const missing = await run(argv(join(dir, 'a.json')).filter((value, n, all) => value !== '--plumb' && all[n - 1] !== '--plumb'), noAddress.connect, root);
  assert.equal(missing.code, 1);
  assert.equal(missing.out, '无法编译：缺 --plumb <Plumb地址>；只有使用者明确说这次不经 Plumb 时才写 --judge model 或 --judge jev\n');
  assert.equal(noAddress.calls.length, 0);
  const wrong = hub(answers);
  const other = await run(argv(join(dir, 'b.json'), ['--judge', 'gpt']), wrong.connect, root);
  assert.equal(other.code, 1);
  assert.equal(other.out, '无法编译：--judge 只能写 plumb、jev 或 model；不写就是 plumb\n');
  assert.equal(wrong.calls.length, 0);
});

// What a new account in a fresh environment lacks is said at once, so that nobody fixes one thing, starts again and meets the next.
const MISSING_KEY = "标准输入第二行没有 Plumb 密钥；命令末尾写 <<'EOF'，依次 %HUB_TOKEN%、%PLUMB_API_KEY%、%JEV_API_KEY%，最后一行 EOF；还没有 Plumb 密钥时向管理员申请，保存为客户端密钥 PLUMB_API_KEY 后重跑";
const plumbSkillMissing = (root: string) => `本机没有装 plumb 技能（${join(root, 'plumb', 'tools', 'plumb.ts')}），它是 Hub 发布的通用技能；下一步：使用者用客户端的技能安装从 Hub 装上 plumb 技能再开编译；Hub 上没有它时，请管理员先在 Hub 上执行 circle-hub pack install plumb@<版本>`;
const modelArgv = (out: string) => argv(out, ['--judge', 'model']).filter((value, n, all) => value !== '--plumb' && all[n - 1] !== '--plumb');

test('not ready: every unmet local precondition is said in one line in the order recompose, case-compile, Plumb skill, Plumb key, and no run is started', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  // The Hub publishes case-compile only, an older case-compile is installed, the Plumb skill is not installed and stdin has one line.
  const root = await skills({ 'case-compile': '3.21.7' }, false), asked: string[] = [];
  const h = hub({ list_task_packs: said({ call_result: 'ok', packs: [{ pack: 'case-compile@3.22.0', id: 'case-compile', version: '3.22.0' }] }) });
  const result = await run(argv(join(dir, 'o.json')), h.connect, root, async (url) => { asked.push(url); return READY; }, ['synthetic-token-1234']);
  assert.equal(result.code, 1);
  assert.equal(result.out, [
    '无法编译：当前账户没有分配 recompose 工作流；下一步：请管理员为该账户或所在团队分配 recompose（Hub 上还没有发布时先发布）',
    '本机 case-compile 技能是 3.21.7，Hub 发布的是 3.22.0；下一步：重装 3.22.0 再开编译',
    plumbSkillMissing(root),
    MISSING_KEY,
  ].join('；另：') + '\n');
  assert.deepEqual(h.calls.map((c) => c.name), ['list_task_packs'], 'the Hub is asked once and no run is started');
  assert.deepEqual(asked, [], 'the Plumb service is not asked without the skill that asks it and the key');
  assert.equal(existsSync(join(dir, 'o.json')), false);

  // Recompose in another version, case-compile not installed, and a Plumb service that is not ready: the service comes last.
  const second = await skills({ recompose: '1.2.0' }), seen: string[] = [];
  const again = hub({ list_task_packs: packs() });
  const later = await run(argv(join(dir, 'p.json')), again.connect, second, async (url, key) => { seen.push(`${url} ${key}`); return { status: 'stopped', phase: 'idle_shutdown', models_status: {} }; });
  assert.equal(later.out, [
    '无法编译：本机 recompose 技能是 1.2.0，Hub 发布的是 1.3.0；下一步：重装 1.3.0 再开编译',
    `本机没有装 case-compile 技能（${join(second, 'case-compile')}）；下一步：使用者用客户端的技能安装从 Hub 装上 case-compile 技能 3.22.0（Hub 发布的版本），再开编译`,
    'Plumb 判定服务没有就绪（status=stopped，phase=idle_shutdown，没有已加载的模型）；下一步：唤醒 Plumb，等状态为 ready 后重跑',
  ].join('；另：') + '\n');
  assert.deepEqual(seen, ['https://127.0.0.1:9 synthetic-plumb-key'], 'the service is asked once, with the address and the key it was given');
  assert.deepEqual(again.calls.map((c) => c.name), ['list_task_packs']);
});

test('not ready: a single problem is the one line of its own, and a check that cannot run for want of an earlier one is not a problem of its own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const attempt = async (options: { versions?: Record<string, string>; plumbSkill?: boolean; stdin?: string[]; published?: ToolAnswer; realStatus?: boolean }) => {
    const root = await skills(options.versions ?? { 'case-compile': '3.22.0', recompose: '1.3.0' }, options.plumbSkill ?? true), asked: string[] = [];
    const h = hub({ list_task_packs: options.published ?? packs() });
    const result = await run(argv(join(dir, 'o.json')), h.connect, root, options.realStatus ? plumbStatusVia(root) : async (url, key) => { asked.push(`${url} ${key}`); return READY; }, options.stdin);
    return { root, out: result.out, asked, calls: h.calls.map((c) => c.name) };
  };
  const READY_ASKED = ['https://127.0.0.1:9 synthetic-plumb-key'];

  const notInstalled = await attempt({ versions: { 'case-compile': '3.22.0' } });
  assert.equal(notInstalled.out, `无法编译：本机没有装 recompose 技能（${join(notInstalled.root, 'recompose')}）；下一步：使用者用客户端的技能安装从 Hub 装上 recompose 技能 1.3.0（Hub 发布的版本），再开编译\n`);
  assert.deepEqual(notInstalled.asked, READY_ASKED, 'a problem of the workflows does not stop the Plumb checks, which do not depend on them');

  const noSkill = await attempt({ plumbSkill: false, realStatus: true });
  assert.equal(noSkill.out, `无法编译：${plumbSkillMissing(noSkill.root)}\n`);
  assert.deepEqual(noSkill.calls, ['list_task_packs']);

  const noSkillAndService = await attempt({ plumbSkill: false });
  assert.equal(noSkillAndService.out, `无法编译：${plumbSkillMissing(noSkillAndService.root)}\n`);
  assert.deepEqual(noSkillAndService.asked, [], 'without its skill the service cannot be asked, so it is not a problem of its own');

  for (const stdin of [['synthetic-token-1234'], ['synthetic-token-1234', '%PLUMB_API_KEY%']]) {
    const noKey = await attempt({ stdin });
    assert.equal(noKey.out, `无法编译：${MISSING_KEY}\n`, 'a second line that is the unexpanded name is no key either');
    assert.deepEqual(noKey.asked, [], 'without the key the service cannot be asked, so it is not a problem of its own');
    assert.deepEqual(noKey.calls, ['list_task_packs']);
  }

  const notAssigned = await attempt({ versions: {}, published: said({ call_result: 'ok', packs: [] }) });
  assert.equal(notAssigned.out, '无法编译：当前账户没有分配 recompose 工作流；下一步：请管理员为该账户或所在团队分配 recompose（Hub 上还没有发布时先发布）；另：当前账户没有分配 case-compile 工作流；下一步：请管理员为该账户或所在团队分配 case-compile（Hub 上还没有发布时先发布）\n', 'a workflow the Hub does not publish has no version to compare and nothing installed to look for');
  assert.deepEqual(notAssigned.calls, ['list_task_packs']);
});

test('not ready: a Plumb service that cannot be asked is said after the workflow problems, in the words of the failed ask', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-compile-')), root = await skills({ 'case-compile': '3.22.0' });
  const h = hub({ list_task_packs: packs() });
  const cannot = '问不到 Plumb 状态：connection refused；下一步：核对 Plumb 地址和密钥，或请管理员唤醒 Plumb 后重跑';
  const result = await run(argv(join(dir, 'o.json')), h.connect, root, async () => { throw new NotReady(cannot); });
  assert.equal(result.out, `无法编译：本机没有装 recompose 技能（${join(root, 'recompose')}）；下一步：使用者用客户端的技能安装从 Hub 装上 recompose 技能 1.3.0（Hub 发布的版本），再开编译；另：${cannot}\n`);
  assert.deepEqual(h.calls.map((c) => c.name), ['list_task_packs']);
});

test('judge model: only the problems of the workflows are said, never the Plumb skill, key or service, and the service is not asked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-compile-')), root = await skills({ 'case-compile': '3.21.7' }, false), asked: string[] = [];
  const h = hub({ list_task_packs: packs() });
  const result = await run(modelArgv(join(dir, 'm.json')), h.connect, root, async (url) => { asked.push(url); return READY; }, ['synthetic-token-1234']);
  assert.equal(result.code, 1);
  assert.equal(result.out, `无法编译：本机没有装 recompose 技能（${join(root, 'recompose')}）；下一步：使用者用客户端的技能安装从 Hub 装上 recompose 技能 1.3.0（Hub 发布的版本），再开编译；另：本机 case-compile 技能是 3.21.7，Hub 发布的是 3.22.0；下一步：重装 3.22.0 再开编译\n`);
  assert.deepEqual(asked, []);
  assert.deepEqual(h.calls.map((c) => c.name), ['list_task_packs']);
  assert.equal(existsSync(join(dir, 'm.json')), false);
});

test('ready: the Hub is asked in the order it always was, and a Plumb judge is asked once between the list and the first run', async () => {
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const events: string[] = [];
  const h = hub({ list_task_packs: packs(), 'start_run:recompose': said({ call_result: 'ok', record: 'rec:' + 'a'.repeat(64), run: { run: RECOMPOSE, items: [{}] } }), 'start_run:case-compile': said({ call_result: 'ok', record: 'rec:' + 'b'.repeat(64), run: { run: PLAN, items: [{}] } }) });
  const connect = (): CallTool => { const call = h.connect(); return async (name, args) => { events.push(`hub ${name}${name === 'start_run' ? ` ${String(args.pack)}` : ''}`); return call(name, args); }; };
  const result = await run(argv(join(dir, 'open-compile.json')), connect, root, async (url, key) => { events.push(`plumb ${url} ${key}`); return READY; });
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(events, ['hub list_task_packs', 'plumb https://127.0.0.1:9 synthetic-plumb-key', 'hub start_run recompose', 'hub start_run case-compile']);
});

// ---- Jev as the judge the user chose ----
const jevArgv = (out: string) => argv(out, ['--judge', 'jev']).filter((value, n, all) => value !== '--plumb' && all[n - 1] !== '--plumb');
const JEV_KEY = 'synthetic-jev-key-1234';
const MISSING_JEV_KEY = "标准输入第三行没有 Jev 密钥；命令末尾写 <<'EOF'，依次 %HUB_TOKEN%、%PLUMB_API_KEY%、%JEV_API_KEY%，最后一行 EOF；还没有 Jev 密钥时向管理员申请，保存为客户端密钥 JEV_API_KEY 后重跑";

test('judge jev: the user chose Jev, so no Plumb address, key, skill or status is looked at, the jev-judge skill need not be installed, no service is probed, and the choice is written into open-compile.json', async () => {
  // Only the two workflows are installed: the compile asks Jev with the client inside case-compile, never with the jev-judge skill.
  const root = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0' }, false), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const asked: string[] = [];
  const never: PlumbStatus = async (url) => { asked.push(url); throw new Error('Plumb must not be asked'); };
  const h = hub({ list_task_packs: packs(), 'start_run:recompose': said({ call_result: 'ok', record: 'rec:' + 'a'.repeat(64), run: { run: RECOMPOSE, items: [{}] } }), 'start_run:case-compile': said({ call_result: 'ok', record: 'rec:' + 'b'.repeat(64), run: { run: PLAN, items: [{}] } }) });
  // The Plumb line is a literal placeholder, as a client without a Plumb key leaves it: it is not read in this mode.
  const result = await run(jevArgv(join(dir, 'open-compile.json')), h.connect, root, never, ['synthetic-token-1234', '%PLUMB_API_KEY%', JEV_KEY]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /^就绪：用例重组运行 .*、脚本编写运行 .*，共 1 条用例；判断方式 jev：命令核验和场景保真由 Jev（TypeSafe 的线上判断服务）判断，原始用例的步骤、写出的命令和手册片段会发到 TypeSafe；Jev 的回答是模型的判断，未经确认，一律只作参考、逐条进复核/);
  assert.deepEqual(asked, []);
  assert.deepEqual(h.calls.map((c) => c.name), ['list_task_packs', 'start_run', 'start_run'], 'the Hub is asked as it always was, and Jev is not asked at all');
  const record = JSON.parse(await readFile(join(dir, 'open-compile.json'), 'utf8'));
  assert.equal(record.judge, 'jev');
  assert.equal(record.schema, 'open-compile@1');
  assert.ok(!JSON.stringify(record).includes(JEV_KEY), 'the key is not written anywhere');
});

test('not ready for Jev: a third line that is no key is said in the one answer with the workflow problems, and the jev-judge skill is never mentioned, and nothing is opened', async () => {
  const root = await skills({ 'case-compile': '3.21.7' }, false), dir = await mkdtemp(join(tmpdir(), 'open-compile-'));
  const h = hub({ list_task_packs: packs() });
  const workflow = `本机没有装 recompose 技能（${join(root, 'recompose')}）；下一步：使用者用客户端的技能安装从 Hub 装上 recompose 技能 1.3.0（Hub 发布的版本），再开编译；另：本机 case-compile 技能是 3.21.7，Hub 发布的是 3.22.0；下一步：重装 3.22.0 再开编译`;
  for (const [n, third] of [[1, undefined], [2, ''], [3, '%JEV_API_KEY%']] as const) {
    const result = await run(jevArgv(join(dir, `j${n}.json`)), h.connect, root, async () => { throw new Error('no service is probed'); }, third === undefined ? ['synthetic-token-1234', 'plumb-key'] : ['synthetic-token-1234', 'plumb-key', third]);
    assert.equal(result.code, 1);
    assert.equal(result.out, `无法编译：${workflow}；另：${MISSING_JEV_KEY}\n`);
    assert.ok(!result.out.includes('jev-judge'), 'the skill is no precondition');
  }
  assert.deepEqual(h.calls.map((c) => c.name), ['list_task_packs', 'list_task_packs', 'list_task_packs']);
  assert.equal(existsSync(join(dir, 'j1.json')), false);
  // Only the key is missing: it is the one sentence, with the skill installed or not.
  const installed = await skills({ 'case-compile': '3.22.0', recompose: '1.3.0', 'jev-judge': '1.0.0' }, false);
  const keyless = await run(jevArgv(join(dir, 'k.json')), hub({ list_task_packs: packs() }).connect, installed, async () => READY, ['synthetic-token-1234', 'plumb-key', '']);
  assert.equal(keyless.out, `无法编译：${MISSING_JEV_KEY}\n`);
});

test('the three stdin lines are read by position: a blank line stays a line, so a key that expands to nothing is no key and moves no other up', async () => {
  const module = new URL('./open-compile.ts', import.meta.url).href;
  const read = (input: string) => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', `import { readStdinByPosition } from ${JSON.stringify(module)}; console.log(JSON.stringify(await readStdinByPosition()));`], { input, encoding: 'utf8' }).stdout) as string[];
  assert.deepEqual(read('tok\nplumb\njev\n'), ['tok', 'plumb', 'jev']);
  assert.deepEqual(read('tok\n\njev\n'), ['tok', '', 'jev']);
  assert.deepEqual(read('tok\n  plumb \r\n\r\n'), ['tok', 'plumb', '']);
  assert.deepEqual(read(''), []);
});
