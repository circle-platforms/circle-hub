import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CallTool, ToolAnswer } from './open-compile.ts';
import { main, unsatisfied } from './open-merge.ts';
import type { RunTool, ToolRun } from './pipeline.ts';

const PLAN = 'run_01planplanplanplanplan00', RECOMPOSE = 'run_01recomposerecompose00', MERGE = 'run_01mergemergemergemerge0';
const WORKBOOK = Buffer.from('synthetic workbook bytes'), DIGEST = createHash('sha256').update(WORKBOOK).digest('hex');
const said = (envelope: Record<string, unknown>, failed = false): ToolAnswer => ({ failed, text: `合成答复\n供模型引用\n${JSON.stringify(envelope)}`, envelope });
const requirement = (name: string, status = 'satisfied', text = '') => ({ requirement: name, status, claims: text ? [{ statement: { text, verdict: 'refute' } }] : [] });
const answerOf = (rows: Array<{ item: string; requirements: unknown[] }>) => `合成答复\n供模型引用\n${JSON.stringify({ call_result: 'ok', acceptance: 'accepted', result: { partitions: { delivered: rows } } })}`;
const ROWS = (workbook: string, other = 'satisfied', words = '') => ['doc:1', 'doc:2'].map((item) => ({ item, requirements: [requirement('commands_known', item === 'doc:2' ? other : 'satisfied', item === 'doc:2' ? words : ''), requirement('workbook_verified', workbook, workbook === 'satisfied' ? '' : '缺少自动化用例 Excel')] }));

async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'open-merge-'));
  await mkdir(join(dir, 'plans'));
  await writeFile(join(dir, 'open-compile.json'), JSON.stringify({ schema: 'open-compile@1', ready: true, subject: 'agile:mindmap:900001', product: 'widget', build: 'Fixture_Build_A', booking: 'run_01bookingbookingbooking0', recompose_run: RECOMPOSE, recompose_record: 'rec:' + 'a'.repeat(64), plan_run: PLAN }));
  return dir;
}
function tools(dir: string, answers: { plan: string; merge: string }, overrides: Partial<Record<string, ToolRun>> = {}) {
  const calls: Array<{ tool: string; args: string[]; stdin?: string }> = [];
  let n = 0;
  const run: RunTool = async (_skill, tool, args, stdin) => {
    calls.push({ tool, args, stdin });
    if (overrides[tool]) return overrides[tool]!;
    if (tool === 'submit-plans.ts') {
      const path = join(args[args.indexOf('--plans') + 1]!, `answer-${++n}.txt`);
      await writeFile(path, args[args.indexOf('--run') + 1] === PLAN ? answers.plan : answers.merge);
      return { code: 0, stdout: `2 份自动化用例已交给 Hub 做脚本合并\n合成答复（截断）\nHub 答复共 99999 字符，全文在 ${path}，请分段读完\n`, stderr: '' };
    }
    if (tool === 'fetch-run.ts') {
      const out = args[args.indexOf('--out') + 1]!;
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'run.json'), JSON.stringify({ run: PLAN, parameters: { exclude: ['990000000000000009'] }, sources: [
        { slot: 'subject', reference: 'src:' + '1'.repeat(64), external: 'agile:mindmap:900001@' + '5'.repeat(64) },
        { slot: 'contract', reference: 'src:' + '2'.repeat(64), external: 'doc:doc:runner-contract@' + '2'.repeat(64) },
        { slot: 'inventory', reference: 'src:' + '3'.repeat(64), external: 'doc:doc:bed-topology@' + '3'.repeat(64) },
        { slot: 'profile', reference: 'src:' + '4'.repeat(64), external: 'doc:doc:runtime-profile@' + '4'.repeat(64) },
        { slot: 'recomposition_run', reference: 'rec:' + 'a'.repeat(64) },
      ] }));
      await writeFile(join(out, 'result.json'), '{}'); await writeFile(join(out, 'submission.json'), '{}');
      return { code: 0, stdout: '{}', stderr: '' };
    }
    if (tool === 'generate-workbook.ts') { await writeFile(args[args.indexOf('--out') + 1]!, WORKBOOK); return { code: 0, stdout: '{}', stderr: '' }; }
    throw new Error(`unexpected tool ${tool}`);
  };
  return { run, calls };
}
function hub(answers: Partial<Record<string, ToolAnswer>>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call: CallTool = async (name, args) => { calls.push({ name, args }); const answer = answers[name]; if (!answer) throw new Error(`unexpected call ${name}`); return answer; };
  return { calls, connect: () => call };
}
async function run(dir: string, connect: () => CallTool, runTool: RunTool) {
  const out: string[] = []; const write = process.stdout.write; const cwd = process.cwd();
  process.chdir(dir);
  process.stdout.write = ((text: string) => { out.push(text); return true; }) as typeof process.stdout.write;
  try { return { code: await main(['--hub', 'http://127.0.0.1:9/mcp', '--open', 'open-compile.json', '--plans', 'plans', '--model', 'synthetic-model', '--out', 'merge'], async () => ['synthetic-token-1234'], connect, runTool), out: out.join('') }; }
  finally { process.stdout.write = write; process.chdir(cwd); }
}
const UPLOADED = said({ call_result: 'ok', acceptance: 'accepted', reference: 'src:' + DIGEST, media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
const STARTED = said({ call_result: 'ok', record: 'rec:' + 'c'.repeat(64), run: { run: MERGE, items: [{}, {}] } });

test('the merge goes through in one command: plans, workbook, upload as a workbook, the merge run with the plan run\'s own inputs, plans again', async () => {
  const dir = await world();
  const t = tools(dir, { plan: answerOf(ROWS('pending')), merge: answerOf(ROWS('satisfied')) });
  const h = hub({ upload_file: UPLOADED, start_run: STARTED });
  const result = await run(dir, h.connect, t.run);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, new RegExp(`^合并通过：脚本合并运行 ${MERGE}，2 条全部正确`));
  assert.deepEqual(t.calls.map((c) => c.tool), ['submit-plans.ts', 'fetch-run.ts', 'generate-workbook.ts', 'submit-plans.ts']);
  assert.deepEqual([t.calls[0]!.args[t.calls[0]!.args.indexOf('--run') + 1], t.calls[3]!.args[t.calls[3]!.args.indexOf('--run') + 1]], [PLAN, MERGE]);
  assert.ok(t.calls.every((c) => c.tool !== 'submit-plans.ts' || c.args.join(' ').includes('--timeout-sec 1200')), 'a merge of many cases is checked for minutes');
  assert.equal(t.calls[0]!.stdin, 'synthetic-token-1234\n', 'the token goes on standard input only');
  const upload = h.calls[0]!.args;
  assert.deepEqual([upload.name, upload.media_type, upload.provenance_type, Buffer.from(String(upload.file_path), 'base64').toString()], ['case.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'declared', WORKBOOK.toString()]);
  const start = h.calls[1]!.args as { inputs: Record<string, unknown> } & Record<string, unknown>;
  assert.deepEqual([start.pack, start.product, start.build, start.predecessor, start.version], ['case-compile', 'widget', 'Fixture_Build_A', PLAN, undefined], 'product and build beside the pack, no version line of its own');
  assert.deepEqual(start.parameters, { exclude: ['990000000000000009'], plan_run: PLAN }, 'the plan run\'s own parameters and the plan run');
  assert.deepEqual(start.inputs, {
    subject: { external: 'agile:mindmap:900001' }, contract: { external: 'doc:doc:runner-contract' }, inventory: { external: 'doc:doc:bed-topology' }, profile: { external: 'doc:doc:runtime-profile' },
    recomposition_run: { reference: 'rec:' + 'a'.repeat(64) }, recomposition_result: { run: RECOMPOSE }, plan_result: { run: PLAN }, workbook: { reference: 'src:' + DIGEST },
  });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'merge', 'open-merge.json'), 'utf8')), { schema: 'open-merge@1', plan_run: PLAN, merge_run: MERGE, workbook: 'src:' + DIGEST, xlsx: join('merge', 'case.xlsx'), items: 2 });
});

test('plans that do not cover every case of the compile are not submitted at all: a short submission spends a repair round of the plan run', async () => {
  const dir = await world();
  await writeFile(join(dir, 'open-compile.json'), JSON.stringify({ ...JSON.parse(await readFile(join(dir, 'open-compile.json'), 'utf8')), items: 3 }));
  await writeFile(join(dir, 'plans', '00.json'), '{}'); await writeFile(join(dir, 'plans', '02.json'), '{}'); await writeFile(join(dir, 'plans', 'answer-1.txt'), '合成');
  const t = tools(dir, { plan: '', merge: '' });
  const h = hub({});
  const result = await run(dir, h.connect, t.run);
  assert.equal(result.code, 1);
  assert.match(result.out, /^合并不了：plans 里有 2 份计划，这次编译有 3 条，没有提交。缺的条目先用 pipeline\.ts status 看它停在哪、用 pipeline\.ts retry 重做（不删收拢好的计划，不写跳过声明）/);
  assert.deepEqual([t.calls.length, h.calls.length, existsSync(join(dir, 'merge'))], [0, 0, false]);
});

test('a plan the Hub does not hold right stops the merge before any workbook is made, with the case and the Hub\'s words', async () => {
  const dir = await world();
  const t = tools(dir, { plan: answerOf(ROWS('pending', 'unsatisfied', '命令不在锁定命令树里：合成原话')), merge: '' });
  const h = hub({});
  const result = await run(dir, h.connect, t.run);
  assert.equal(result.code, 1);
  assert.match(result.out, /^合并不了：Hub 没有判正确的计划有 1 条，不能合并；按下面每条的原话改（pipeline\.ts retry --case <序号> --note '<Hub 的原话>'）/);
  assert.deepEqual(JSON.parse(result.out.split('\n')[1]!), { cases: [{ item: 'doc:2', requirement: 'commands_known', words: '命令不在锁定命令树里：合成原话' }] });
  assert.deepEqual([t.calls.map((c) => c.tool), h.calls.length, existsSync(join(dir, 'merge'))], [['submit-plans.ts'], 0, false]);
});

test('a workbook the Hub stored as other bytes, a merge run that does not open and a merge the Hub does not hold right are each refused in their own words', async () => {
  let dir = await world();
  let result = await run(dir, hub({ upload_file: said({ call_result: 'ok', reference: 'src:' + '9'.repeat(64) }) }).connect, tools(dir, { plan: answerOf(ROWS('pending')), merge: '' }).run);
  assert.match(result.out, new RegExp(`^合并不了：自动化用例 Excel 没有传上去：Hub 记下的是 src:9{64}，本地生成的是 src:${DIGEST}`));
  dir = await world();
  result = await run(dir, hub({ upload_file: UPLOADED, start_run: said({ call_result: 'error', errors: [{ code: 'SUBMISSION_SCHEMA_VIOLATION', message: '合成：输入槽不对', path: '/inputs/workbook', fix: '按槽位改' }] }, true) }).connect, tools(dir, { plan: answerOf(ROWS('pending')), merge: '' }).run);
  assert.match(result.out, /^合并不了：脚本合并运行开不起来：合成：输入槽不对（位置 \/inputs\/workbook）；下一步：按槽位改/);
  dir = await world();
  result = await run(dir, hub({ upload_file: UPLOADED, start_run: STARTED }).connect, tools(dir, { plan: answerOf(ROWS('pending')), merge: answerOf(ROWS('unsatisfied')) }).run);
  assert.match(result.out, new RegExp(`^合并不了：脚本合并运行 ${MERGE} 里 Hub 没有判正确的有 2 条`));
  assert.equal(result.code, 1);
});

test('what is not satisfied is read from every partition of the answer; the workbook requirement can be left out', () => {
  const envelope = { acceptance: 'accepted', result: { partitions: { delivered: ROWS('pending'), incomplete: [{ item: 'doc:3', requirements: [requirement('scenario_kept', 'unsatisfied', '审计判场景被改')] }] } } };
  assert.deepEqual(unsatisfied(envelope, ['workbook_verified']), { items: 3, rows: [{ item: 'doc:3', requirement: 'scenario_kept', words: '审计判场景被改' }] });
  assert.equal(unsatisfied(envelope).rows.length, 3);
});
