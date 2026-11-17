import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkPlanFile, concurrencyLimit, parseArguments, planFanOut, planFileName, runPool, strayFiles, WRITER_DESCRIPTION, WRITER_NAME, WRITER_SYSTEM_PROMPT, WRITER_TOOLS, writerMessage,
  type RunCase,
} from './extension.ts';

const later = () => new Promise<void>((resolve) => setImmediate(resolve));
const item = (id: string | null, title = '合成用例') => ({ ...(id === null ? {} : { id }), fields: { title } });

test('the writer has exactly read, write and search tools: no question tool, no task tool, no shell', () => {
  assert.deepEqual([...WRITER_TOOLS], ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep']);
  for (const forbidden of ['question', 'task', 'execute', 'skill', 'webfetch', 'websearch', 'write_todos', 'delete', 'apply_patch']) assert.ok(!(WRITER_TOOLS as readonly string[]).includes(forbidden), forbidden);
  assert.equal(WRITER_NAME, 'case-plan-writer');
  assert.ok(WRITER_DESCRIPTION.includes('do not start it with task'));
  assert.ok(WRITER_SYSTEM_PROMPT.length > 100 && WRITER_SYSTEM_PROMPT.split('\n').length < 12, 'standing instructions stay short');
});

test('a plan file name depends on the item alone, is a plain file name and tells two ids apart', () => {
  const name = planFileName('doc-1:c-1');
  assert.match(name, /^doc-1_c-1-[0-9a-f]{8}\.json$/);
  assert.equal(planFileName('doc-1:c-1'), name, 'the same item in a later run writes the same file');
  assert.notEqual(planFileName('a:b'), planFileName('a_b'), 'ids that differ only in a replaced character stay two files');
  for (const hostile of ['../x', '.hidden', '', '/etc/passwd', 'a b\nc', '中文编号']) assert.match(planFileName(hostile), /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/, JSON.stringify(hostile));
  assert.ok(planFileName('x'.repeat(500)).length <= 80 + 1 + 8 + '.json'.length);
});

test('arguments: directories are resolved against the workspace, only and notes are checked as written', () => {
  const ok = parseArguments({ run_directory: 'run', plans_directory: '/abs/plans', skill_directory: 'skill', only: ['3', '3', '07'], notes: { '07': '上一轮设备拒绝了第二条命令' } }, '/work');
  assert.ok(ok.ok); if (!ok.ok) return;
  assert.deepEqual([ok.value.runDirectory, ok.value.plansDirectory, ok.value.skillDirectory], ['/work/run', '/abs/plans', '/work/skill']);
  assert.deepEqual(ok.value.only, ['3', '07'], 'a repeated index is one writer');
  assert.deepEqual([...ok.value.notes], [['07', '上一轮设备拒绝了第二条命令']]);
  const bare = parseArguments({ run_directory: 'run', plans_directory: 'plans', skill_directory: 'skill' }, '/work');
  assert.ok(bare.ok && bare.value.only === null && bare.value.notes.size === 0);
  const missing = parseArguments({ run_directory: 'run', skill_directory: '' }, '/work');
  assert.ok(!missing.ok && missing.problem.includes('自动化用例目录') && missing.problem.includes('脚本编写所用的技能目录') && !missing.problem.includes('原始用例目录'));
  for (const bad of [{ only: '03' }, { only: ['x'] }, { only: [3] }, { notes: ['a'] }, { notes: { x: 'a' } }, { notes: { '1': '' } }, { notes: { '1': 7 } }, { notes: { '1': 'a'.repeat(4001) } }]) {
    const result = parseArguments({ run_directory: 'r', plans_directory: 'p', skill_directory: 's', ...bad }, '/work');
    assert.ok(!result.ok, JSON.stringify(bad));
  }
});

const cases = (): RunCase[] => [
  { index: '00', item: item('doc:c-0', '第一条'), brief: '# 编写简报 00\n合成简报零\n' },
  { index: '01', item: item('doc:c-1', '带\n换行 的   标题'), brief: '# 编写简报 01\n合成简报一\n' },
  { index: '02', item: item('doc:c-2'), brief: null },
  { index: '03', item: item(null), brief: '合成简报三' },
  { index: '04', item: null, brief: '合成简报四', unreadable: 'items/04.json 不是完整的 JSON' },
  { index: '05', item: item('doc:c-5'), brief: '   \n' },
  { index: '06', item: item('doc:c-6'), brief: '合成简报六' },
];

test('one writer per case that has a brief; a case without one is listed with the reason and never started', () => {
  const plan = planFanOut({ cases: cases(), only: null, notes: new Map(), plansDirectory: '/work/plans', existing: new Set([planFileName('doc:c-1')]) });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.planned.map((value) => [value.index, value.item, value.title, value.exists]), [['00', 'doc:c-0', '第一条', false], ['01', 'doc:c-1', '带 换行 的 标题', true], ['06', 'doc:c-6', '合成用例', false]]);
  assert.deepEqual(plan.planned.map((value) => value.path), plan.planned.map((value) => `/work/plans/${planFileName(value.item)}`));
  assert.deepEqual(plan.planned.map((value) => value.brief), ['# 编写简报 00\n合成简报零\n', '# 编写简报 01\n合成简报一\n', '合成简报六'], 'each writer holds its own brief, byte for byte');
  assert.deepEqual(plan.skipped.map((value) => [value.index, value.item]), [['02', 'doc:c-2'], ['03', null], ['04', null], ['05', 'doc:c-5']]);
  assert.ok(plan.skipped[0]!.reason.includes('第 02 份原始用例缺少重组后的用例或手册'));
  assert.equal(plan.skipped[2]!.reason, 'items/04.json 不是完整的 JSON');
});

test('an item that already has a file in the plans directory keeps that file, whatever it is called', () => {
  const plan = planFanOut({ cases: cases(), only: ['1', '0'], notes: new Map(), plansDirectory: '/p', existing: new Set(['01.json']), fileOfItem: new Map([['doc:c-1', '01.json']]) });
  assert.deepEqual(plan.planned.map((value) => [value.index, value.file, value.path, value.exists]), [['00', planFileName('doc:c-0'), `/p/${planFileName('doc:c-0')}`, false], ['01', '01.json', '/p/01.json', true]]);
});

test('only picks cases by index number, notes go to the writer of their index, and a mistaken index or note stops the call before anything starts', () => {
  const base = { cases: cases(), plansDirectory: '/p', existing: new Set<string>() };
  const some = planFanOut({ ...base, only: ['1', '6'], notes: new Map([['06', '设备拒绝了第二条命令']]) });
  assert.deepEqual(some.problems, []);
  assert.deepEqual(some.planned.map((value) => [value.index, value.note]), [['01', null], ['06', '设备拒绝了第二条命令']]);
  assert.deepEqual(some.skipped, [], 'cases that were not asked for are not listed');
  assert.deepEqual(planFanOut({ ...base, only: ['9'], notes: new Map() }).problems, ['不存在：本次脚本编写没有第 9 份原始用例。请核对 items 目录中的文件编号后重填 only。']);
  assert.deepEqual(planFanOut({ ...base, only: ['0'], notes: new Map([['1', '这条没有要写']]) }).problems, ['参数无效：第 1 份原始用例不在本次脚本编写中。请删除它的补充说明后重试。']);
  const twice = planFanOut({ ...base, cases: [{ index: '00', item: item('same'), brief: 'a' }, { index: '01', item: item('same'), brief: 'b' }], only: null, notes: new Map() });
  assert.equal(twice.problems.length, 1);
  assert.ok(twice.problems[0]!.includes('每条原始用例只能有一份自动化用例'));
});

test('a writer is told the case, the three directories, the file to write and its own brief; a rework is told the file is last round\'s plan', () => {
  const plan = planFanOut({ cases: cases(), only: ['0', '1'], notes: new Map([['1', '设备拒绝了 widget on：先读设备返回']]), plansDirectory: '/work/plans', existing: new Set([planFileName('doc:c-1')]) });
  const where = { runDirectory: '/work/run', skillDirectory: '/skills/case-compile' };
  const [first, second] = plan.planned.map((value) => writerMessage(value, where)) as [string, string];
  assert.equal(first.split('\n')[0], '脚本编写 00：第一条', 'the first line names the case: Circle titles the subagent session from the start of the text');
  for (const text of [first, second]) {
    assert.ok(text.includes('/work/run') && text.includes('/skills/case-compile') && text.includes('/work/plans/'));
    assert.ok(text.includes('只写这一个文件'));
  }
  assert.ok(first.endsWith('## 编写简报\n\n# 编写简报 00\n合成简报零\n'));
  assert.ok(!second.includes('合成简报零'), 'a writer never holds another case\'s brief');
  assert.ok(first.includes('它还不存在') && !first.includes('主代理的补充'));
  assert.ok(second.includes('上一轮的自动化用例，先读它') && second.includes('tools/delivery.md'));
  assert.ok(second.includes('## 主代理的补充\n\n设备拒绝了 widget on：先读设备返回\n'));
  assert.ok(second.includes(plan.planned[1]!.path));
});

test('all writers are started at once, before any of them ends, and the outcomes keep the order of the cases', async () => {
  const gates = Array.from({ length: 6 }, () => Promise.withResolvers<string>());
  const started: number[] = [];
  const run = runPool([10, 11, 12, 13, 14, 15], Number.POSITIVE_INFINITY, (value, at) => { started.push(at); assert.equal(value, 10 + at); return gates[at]!.promise; });
  await later();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5], 'no waves: nobody waits for another writer to start');
  for (const at of [3, 0, 5, 1, 4, 2]) gates[at]!.resolve(`done ${at}`);
  assert.deepEqual(await run, [0, 1, 2, 3, 4, 5].map((at) => ({ state: 'done', value: `done ${at}` })));
});

test('a narrower limit starts the next writer the moment one ends, never in waves', async () => {
  const gates = Array.from({ length: 5 }, () => Promise.withResolvers<string>());
  const started: number[] = [];
  let inFlight = 0, most = 0;
  const run = runPool([0, 1, 2, 3, 4], 2, async (_value, at) => { started.push(at); most = Math.max(most, ++inFlight); try { return await gates[at]!.promise; } finally { inFlight--; } });
  await later();
  assert.deepEqual(started, [0, 1]);
  gates[1]!.resolve('b');
  await later();
  assert.deepEqual(started, [0, 1, 2], 'writer 2 started while writer 0, the first one, is still working');
  gates[0]!.resolve('a'); gates[2]!.resolve('c');
  await later();
  assert.deepEqual([...started].sort(), [0, 1, 2, 3, 4]);
  gates[3]!.resolve('d'); gates[4]!.resolve('e');
  assert.equal((await run).length, 5);
  assert.equal(most, 2);
});

test('a writer that fails is its own outcome and stops no other; an abort stops anything not yet started', async () => {
  const failing = await runPool(['a', 'b', 'c'], 2, async (value) => { if (value === 'b') throw new Error('boom'); return value.toUpperCase(); });
  assert.deepEqual(failing.map((outcome) => outcome.state), ['done', 'failed', 'done']);
  assert.equal((failing[1] as { error: Error }).error.message, 'boom');
  const controller = new AbortController();
  const aborted = await runPool(['a', 'b', 'c', 'd'], 1, async (value) => { if (value === 'b') controller.abort(); return value; }, controller.signal);
  assert.deepEqual(aborted.map((outcome) => outcome.state), ['done', 'done', 'skipped', 'skipped']);
  assert.deepEqual(await runPool([], 3, async () => 1), []);
  assert.deepEqual((await runPool(['a'], 3, async (value) => value, AbortSignal.abort())).map((outcome) => outcome.state), ['skipped']);
});

test('the file a writer left is accepted by the rule of the submission tool and must be the case\'s own item', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  assert.deepEqual(checkPlanFile(bytes({ item: 'doc:c-0', handling: 'handled', slots: { plan: [] } }), 'doc:c-0'), { state: 'ok' });
  assert.deepEqual(checkPlanFile(null, 'doc:c-0'), { state: 'missing' });
  const reason = (value: Uint8Array) => { const state = checkPlanFile(value, 'doc:c-0'); assert.equal(state.state, 'bad'); return state.state === 'bad' ? state.reason : ''; };
  assert.ok(reason(new Uint8Array([0xff, 0xfe, 0x00])).includes('UTF-8'));
  assert.ok(reason(bytes('{"item": "doc:c-0", ')).includes('JSON'));
  for (const wrong of [[], '"text"', null, { handling: 'handled' }, { item: '', handling: 'handled' }, { item: 'doc:c-0' }, { item: 7, handling: 'handled' }]) assert.ok(reason(bytes(wrong)).includes('不是完整的自动化用例'), JSON.stringify(wrong));
  assert.ok(reason(bytes({ item: 'doc:c-1', handling: 'handled' })).includes('不是这条原始用例的自动化用例'), 'another case\'s plan is named');
});

test('files that appeared or changed in the plans directory and are not a plan file are reported; untouched ones and the plan files are not', () => {
  const stamp = (size: number, mtimeMs = 1) => ({ size, mtimeMs });
  const before = new Map([['plan-a.json', stamp(10)], ['plan-b.json', stamp(10)], ['old.json', stamp(5)], ['old-note.txt', stamp(5)]]);
  const after = new Map([['plan-a.json', stamp(12, 2)], ['plan-b.json', stamp(10)], ['plan-c.json', stamp(7, 2)], ['old.json', stamp(5)], ['old-note.txt', stamp(6, 2)], ['notes.json', stamp(3, 2)], ['answer-1.txt', stamp(1, 2)]]);
  assert.deepEqual(strayFiles(before, after, new Set(['plan-a.json', 'plan-b.json', 'plan-c.json'])), ['answer-1.txt', 'notes.json', 'old-note.txt']);
  assert.deepEqual(strayFiles(before, before, new Set()), []);
});

test('writers run all at once unless the settings entry narrows them with a positive whole number', () => {
  assert.equal(concurrencyLimit({}), Number.POSITIVE_INFINITY);
  assert.equal(concurrencyLimit({ max_parallel: 4 }), 4);
  for (const bad of [0, -1, 2.5, '4', null, true, Number.NaN]) assert.equal(concurrencyLimit({ max_parallel: bad }), Number.POSITIVE_INFINITY, String(bad));
});
