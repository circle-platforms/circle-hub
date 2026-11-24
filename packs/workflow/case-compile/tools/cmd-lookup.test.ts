import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CallFailure } from '../functions/text.ts';
import BLOCKS from '../tables/blocks-format.json' with { type: 'json' };
import { contractFixture, hostLiterals, writeContractDownload, type DownloadOptions } from '../testing/contract-lookup-fixture.ts';
import { lookupFixture, writeLookupDownload } from '../testing/lookup-fixture.ts';
import { foreignCommands, shownCommands } from '../testing/shown-commands.ts';
import { main } from './cmd-lookup.ts';
import { resolveCwdRoots, resolveExistingDirInsideCwd } from './workspace-path.ts';

const TOOL = fileURLToPath(new URL('./cmd-lookup.ts', import.meta.url));
const fixture = lookupFixture();

async function run(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '', stderr = '';
  const code = await main(argv, { out: (text) => { stdout += text; }, err: (text) => { stderr += text; }, cwd });
  return { code, stdout, stderr };
}
async function download(options: { withText?: boolean } = {}): Promise<{ dir: string; run: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cmd-lookup-'));
  await writeLookupDownload(join(dir, 'plan-run'), fixture, options);
  return { dir, run: 'plan-run', file: 'plan-run/run.json' };
}
async function contractDownload(options: DownloadOptions = {}): Promise<{ dir: string; run: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cmd-lookup-contract-'));
  await writeContractDownload(join(dir, 'plan-run'), contractFixture(), options);
  return { dir, run: 'plan-run', file: 'plan-run/run.json' };
}
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(`${full} ${(await stat(full)).size} ${(await stat(full)).mtimeMs}`);
    }
  };
  await walk(dir);
  return out.sort();
}

test('--param answers one command with its definition, manual window and inverse, and writes nothing', async () => {
  const { dir, run: runDir } = await download();
  try {
    const before = await snapshot(dir);
    const result = await run(['--run', runDir, '--param', 'orbit beacon add "b1" fast 3'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^# 命令 orbit beacon add/);
    assert.ok(result.stdout.includes(fixture.statements.get(fixture.reference('/commands/orbit/beacon/add', 'orbit beacon add <arg1'))!));
    assert.match(result.stdout, /^# 逆操作（产品规则：no orbit beacon add）/m);
    assert.match(result.stdout, /^# 手册原文窗/m);
    assert.ok(result.stdout.endsWith('\n') && !result.stdout.endsWith('\n\n'));
    assert.deepEqual(await snapshot(dir), before);
    assert.deepEqual(await run(['--run', runDir, '--param', 'orbit beacon add "b1" fast 3'], dir), result);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--heads lists the heads below a prefix', async () => {
  const { dir, run: runDir } = await download();
  try {
    const result = await run(['--run', runDir, '--heads', 'orbit beacon'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^orbit beacon add <arg1:string 1\.\.40>/m);
    assert.match(result.stdout, /共 2 条/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the pointers into the text files are lines of those files', async () => {
  const { dir, run: runDir } = await download();
  try {
    const result = await run(['--run', runDir, '--param', 'orbit report add'], dir);
    const manual = (await readFile(join(dir, 'plan-run', 'knowledge', 'manual.txt'), 'utf8')).split('\n');
    const pointer = /没有显示的 10 条从 knowledge\/manual\.txt 第 (\d+) 行起/.exec(result.stdout);
    assert.ok(pointer, result.stdout);
    assert.ok(manual[Number(pointer[1]) - 1]!.startsWith(`· 引用 ${fixture.reference('/manual/cli-orbit/报告管理', '第 41 条说明。')}`));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('without the text files the lookup still answers from nodes.jsonl', async () => {
  const { dir, run: runDir } = await download({ withText: false });
  try {
    const result = await run(['--run', runDir, '--param', 'orbit beacon add'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!/第 \d+ 行起/.test(result.stdout), 'no pointer to a line of a text file');
    assert.match(result.stdout, /^# 手册原文窗/m);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a miss is an answer, not a failure', async () => {
  const { dir, run: runDir } = await download();
  try {
    const result = await run(['--run', runDir, '--param', 'orbit becon add'], dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^# 命令树里没有命令 orbit becon add/);
    assert.equal(result.stderr, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('calls it cannot answer are refused with a closed category, one fact and one next step', async () => {
  const { dir, run: runDir } = await download();
  try {
    const refused = async (argv: string[], pattern: RegExp, cwd = dir) => {
      const result = await run(argv, cwd);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, pattern, result.stderr);
      assert.ok(/^(参数无效|无权限|不存在|已被占用|暂时不可用)：/.test(result.stderr), result.stderr);
      assert.equal(result.stderr.trim().split('\n').length, 1);
    };
    await refused([], /缺少必填参数 --run/);
    await refused(['--run', runDir], /--param、--heads、--method、--methods 或 --block/);
    await refused(['--run', runDir, '--param', 'a', '--heads', 'b'], /只能写一个/);
    await refused(['--run', runDir, '--method', 'a.b', '--block', 'CONFIG'], /只能写一个/);
    await refused(['--run', runDir, '--methods', 'a', '--param', 'b'], /只能写一个/);
    await refused(['--run', runDir, '--param=orbit'], /不能用 = 连接/);
    await refused(['--run', runDir, '--guess', 'orbit'], /未知选项 --guess/);
    await refused(['--run', 'plan-run/nothing', '--param', 'orbit'], /^不存在：找不到 --run 目录 plan-run\/nothing。/);
    await refused(['--run', '../elsewhere', '--param', 'orbit'], /超出当前工作目录/);
    await refused(['--run', runDir, '--param', 'orbit beacon add "b1'], /引号/);
    await mkdir(join(dir, 'bare'));
    await writeFile(join(dir, 'bare', 'run.json'), JSON.stringify(fixture.runJson()));
    await refused(['--run', 'bare', '--param', 'orbit'], /^不存在：.*knowledge\/nodes\.jsonl/);
    await mkdir(join(dir, 'other', 'knowledge'), { recursive: true });
    await writeFile(join(dir, 'other', 'run.json'), JSON.stringify({ ...fixture.runJson(), run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb' }));
    await writeFile(join(dir, 'other', 'knowledge', 'nodes.jsonl'), fixture.files.get('nodes.jsonl')!);
    await refused(['--run', 'other', '--param', 'orbit'], /^参数无效：命令树下载与冻结运行或节点计数不一致/);
    await writeFile(join(dir, 'other', 'run.json'), '{');
    await refused(['--run', 'other', '--param', 'orbit'], /^参数无效：.*run\.json/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const CORRECT_FORM = "合法写法：--run '<运行目录>'（放 run.json 的目录，不是 run.json 文件）。";

test('--run is the run directory like task-brief.ts: the run.json file is refused in the same words with the correct form, and only the directory is accepted', async () => {
  const { dir, run: runDir, file } = await download();
  try {
    let helper: unknown;
    try { resolveExistingDirInsideCwd(resolveCwdRoots(dir), file, '--run'); } catch (error) { helper = error; }
    assert.ok(helper instanceof CallFailure && /不是普通目录/.test(helper.fact), String(helper));
    const sentence = helper.fact.replace(/^参数无效：/, '').replace(/[。.]+$/, '');
    for (const argv of [['--param', 'orbit beacon add'], ['--heads', 'orbit'], ['--method', 'widget-host.shell'], ['--methods', 'widget-seat'], ['--block', 'CONFIG']]) {
      const result = await run(['--run', file, ...argv], dir);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(result.stdout, '', 'the file form answers nothing');
      assert.match(result.stderr, /^参数无效：--run plan-run\/run\.json 不是普通目录。/, result.stderr);
      assert.ok(result.stderr.startsWith(`参数无效：${sentence}。`), result.stderr);
      assert.ok(result.stderr.trimEnd().endsWith(CORRECT_FORM), result.stderr);
      assert.equal(result.stderr.trim().split('\n').length, 1);
    }
    const answer = await run(['--run', runDir, '--param', 'orbit beacon add'], dir);
    assert.equal(answer.code, 0, answer.stderr);
    assert.deepEqual(await run(['--run', realpathSync(join(dir, runDir)), '--param', 'orbit beacon add'], dir), answer);
    const bare = await run([], dir);
    assert.equal(bare.code, 1);
    assert.ok(bare.stderr.includes("--run '<运行目录>'") && !bare.stderr.includes('run.json'), bare.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a run directory that is a link, or whose run.json is missing, a link or not a file, is refused with one fact and one next step', async () => {
  const { dir, run: runDir } = await download();
  try {
    const refused = async (value: string, pattern: RegExp) => {
      const result = await run(['--run', value, '--param', 'orbit beacon add'], dir);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, pattern, result.stderr);
      assert.ok(/^(参数无效|无权限|不存在|已被占用|暂时不可用)：/.test(result.stderr), result.stderr);
      assert.equal(result.stderr.trim().split('\n').length, 1);
    };
    await symlink(join(dir, runDir), join(dir, 'link-run'));
    await refused('link-run', /^参数无效：--run 目录 link-run 不能是符号链接/);
    await mkdir(join(dir, 'empty'));
    await refused('empty', /^不存在：找不到 .*run\.json 文件 empty\/run\.json。/);
    await symlink(join(dir, runDir, 'run.json'), join(dir, 'empty', 'run.json'));
    await refused('empty', /^参数无效：.*run\.json 文件 empty\/run\.json 不能是符号链接/);
    await rm(join(dir, 'empty', 'run.json'));
    await mkdir(join(dir, 'empty', 'run.json'));
    await refused('empty', /^参数无效：--run 目录里的 run\.json empty\/run\.json 不是普通文件/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('run as a program it answers on stdout with exit 0 and reads only what is under the working directory', async () => {
  const { dir, run: runDir } = await download();
  try {
    const result = spawnSync(process.execPath, [TOOL, '--run', runDir, '--param', 'orbit link on'], { cwd: dir, encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' }, timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# 命令 orbit link on/);
    assert.equal(result.stderr, '');
    const bad = spawnSync(process.execPath, [TOOL, '--run', runDir], { cwd: dir, encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' }, timeout: 30_000 });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^参数无效：/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--method and --methods answer from the sources of the download, write nothing, and need no knowledge folder', async () => {
  const { dir, run: runDir } = await contractDownload();
  try {
    const before = await snapshot(dir);
    const method = await run(['--run', runDir, '--method', 'widget-host.shell'], dir);
    assert.equal(method.code, 0, method.stderr);
    assert.equal(method.stderr, '');
    assert.equal(method.stdout.split('\n')[0], '# 方法 widget-host.shell：合约启用，本次配置已开放，可以写进计划。');
    const sources = JSON.parse(await readFile(join(dir, 'plan-run', 'sources.json'), 'utf8')) as Array<{ slot: string; sha256: string; file: string }>;
    const contract = sources.find((row) => row.slot === 'contract')!;
    assert.equal(contract.file, 'sources/contract.json');
    assert.ok(method.stdout.includes(`（src:${contract.sha256}/json@1/p/entries/`), 'the reference of the file as the download manifest gives it');
    for (const literal of hostLiterals().slice(0, 40)) assert.ok(method.stdout.split('\n').includes(literal));
    const methods = await run(['--run', runDir, '--methods', 'widget-seat'], dir);
    assert.equal(methods.code, 0, methods.stderr);
    assert.match(methods.stdout, /^# 对象 widget-seat：类型 WidgetSeat，合约状态 enabled。\n/);
    assert.ok(methods.stdout.endsWith('\n') && !methods.stdout.endsWith('\n\n'));
    assert.deepEqual(await snapshot(dir), before);
    assert.deepEqual(await run(['--run', runDir, '--method', 'widget-host.shell'], dir), method);
    assert.deepEqual(await run(['--run', runDir, '--methods', 'widget-seat'], dir), methods);
    const miss = await run(['--run', runDir, '--method', 'widget-seat.conf'], dir);
    assert.equal(miss.code, 0);
    assert.match(miss.stdout, /^# 对象 widget-seat 没有方法 conf。/m);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--method of an old download without the source manifest reads the root-level files and cites them without a reference', async () => {
  const { dir, run: runDir } = await contractDownload({ withoutManifest: true });
  try {
    const result = await run(['--run', runDir, '--method', 'widget-seat.configure'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^# 引用：合约条目 contract\.json 的 \/entries\/\d+；开放项 profile\.json 的 \/allowed\/\d+；座位 profile\.json 的 \/seats\/0；设备 inventory\.json 的 \/beds\/0\/devices\/\d+。$/m);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('every device command the writer\'s lookups print for a block kind or for the methods of an object is a command of the synthetic command trees of these tests', async () => {
  const { dir, run: runDir } = await contractDownload();
  try {
    const answers: Array<[string, string]> = [];
    for (const kind of BLOCKS.kinds) answers.push([`--block ${kind.kind}`, (await run(['--run', runDir, '--block', kind.kind], dir)).stdout]);
    answers.push(['--block block_context', (await run(['--run', runDir, '--block', 'block_context'], dir)).stdout]);
    answers.push(['--methods widget-seat', (await run(['--run', runDir, '--methods', 'widget-seat'], dir)).stdout]);
    answers.push(['--method widget-seat.configure', (await run(['--run', runDir, '--method', 'widget-seat.configure'], dir)).stdout]);
    assert.ok(answers.every(([, text]) => text.length > 0));
    assert.ok(answers.reduce((count, [, text]) => count + shownCommands(text).length, 0) > 0, 'the answers show device commands');
    for (const [label, text] of answers) assert.deepEqual(foreignCommands(text), [], label);
    const cell = answers.find(([label]) => label === '--block SELECT_CELL')![1];
    assert.ok(cell.split('\n').some((line) => line.startsWith('{"kind":"SELECT_CELL"') && line.includes('"separator":"|"') && line.includes('"value":"node-a"')), 'the sample is a name|state|count table');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--block answers from the frozen slot schema of run.json, the table of the pack and the pack\'s own sample of the kind', async () => {
  const { dir, run: runDir } = await contractDownload();
  try {
    const before = await snapshot(dir);
    const config = await run(['--run', runDir, '--block', 'CONFIG'], dir);
    assert.equal(config.code, 0, config.stderr);
    assert.match(config.stdout, /^# 块种类 CONFIG：本次运行冻结的计划结构（run\.json 的 slots\.schema，摘要 [0-9a-f]{12}）里有它；分块表（tables\/blocks-format\.json）标为启用。\n/);
    assert.match(config.stdout, /^# 示例（包里的合成样例 samples\/positive\/typed-block-CONFIG\.json 的第 1 块，共 \d+ 块；/m);
    const sample = JSON.parse(await readFile(new URL('../samples/positive/typed-block-CONFIG.json', import.meta.url), 'utf8')) as { subject: { data: { blocks: Array<{ kind: string }> } } };
    const block = sample.subject.data.blocks.find((row) => row.kind === 'CONFIG')!;
    assert.ok(config.stdout.split('\n').includes(JSON.stringify(block)), 'the one line of the sample block');
    const dist = await run(['--run', runDir, '--block', 'OBSERVE_DIST'], dir);
    assert.match(dist.stdout, /标为未启用。/);
    assert.match(dist.stdout, /^# 包里没有这个块种类的示例。$/m);
    assert.deepEqual(await snapshot(dir), before);
    assert.deepEqual(await run(['--run', runDir, '--block', 'CONFIG'], dir), config);
    const miss = await run(['--run', runDir, '--block', 'CAPT'], dir);
    assert.equal(miss.code, 0);
    assert.match(miss.stdout, /^# 以 CAPT 开头的块种类：CAPTURE、CAPTURE_COMPARE。$/m);
    const member = await run(['--run', runDir, '--block', 'block_context'], dir);
    assert.equal(member.code, 0, member.stderr);
    assert.match(member.stdout, /^# 计划成员 block_context：本次运行冻结的计划结构（run\.json 的 slots\.schema，摘要 [0-9a-f]{12}）里有它；是计划 data 的可选成员。\n/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the sources and the slot schema it cannot read are refused with a closed category, one fact and one next step', async () => {
  const refusedIn = async (options: DownloadOptions, argv: string[], pattern: RegExp, after?: (dir: string) => Promise<void>) => {
    const { dir, run: runDir } = await contractDownload(options);
    try {
      if (after) await after(dir);
      const result = await run(['--run', runDir, ...argv], dir);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, pattern, result.stderr);
      assert.ok(/^(参数无效|无权限|不存在|已被占用|暂时不可用)：/.test(result.stderr), result.stderr);
      assert.equal(result.stderr.trim().split('\n').length, 1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
  await refusedIn({ tamper: 'contract' }, ['--method', 'widget-seat.configure'], /^参数无效：来源文件与清单摘要不一致/);
  await refusedIn({ tamper: 'profile' }, ['--methods', 'widget-seat'], /^参数无效：来源文件与清单摘要不一致/);
  await refusedIn({}, ['--method', 'widget-seat.configure'], /^不存在：.*sources\/contract\.json/, (dir) => rm(join(dir, 'plan-run', 'sources', 'contract.json')));
  await refusedIn({ withoutSlots: true }, ['--block', 'CONFIG'], /^参数无效：run\.json 里没有冻结的 slots\.schema/);
  await refusedIn({}, ['--method', 'nothing'], /^参数无效：--method 的值要写成 <对象>\.<方法>/);
  await refusedIn({}, ['--methods', 'widget-seat.configure'], /^参数无效：--methods 的值是一个对象名/);
  await refusedIn({}, ['--block', 'CAP TURE'], /^参数无效：--block 的值是一个块种类名/);
  await refusedIn({}, ['--method', 'widget-seat.configure'], /^参数无效：.*冻结合约/, async (dir) => {
    const bytes = Buffer.from(JSON.stringify({ not: 'a contract' }));
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(dir, 'plan-run', 'sources', 'contract.json'), bytes);
    const manifest = JSON.parse(await readFile(join(dir, 'plan-run', 'sources.json'), 'utf8')) as Array<{ slot: string; sha256: string; reference: string }>;
    for (const row of manifest) if (row.slot === 'contract') { row.sha256 = digest; row.reference = `src:${digest}`; }
    await writeFile(join(dir, 'plan-run', 'sources.json'), JSON.stringify(manifest));
  });
});

test('run as a program the new forms answer on stdout with exit 0', async () => {
  const { dir, run: runDir } = await contractDownload();
  try {
    for (const argv of [['--method', 'widget-clock.pause'], ['--methods', 'widget-clock'], ['--block', 'SLEEP']]) {
      const result = spawnSync(process.execPath, [TOOL, '--run', runDir, ...argv], { cwd: dir, encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' }, timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /^# (方法|对象|块种类) /);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
