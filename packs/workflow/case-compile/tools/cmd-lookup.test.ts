// tools/cmd-lookup.ts: the command line around functions/cmd-lookup.ts, on a synthetic download (testing/lookup-fixture.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lookupFixture, writeLookupDownload } from '../testing/lookup-fixture.ts';
import { main } from './cmd-lookup.ts';

const TOOL = fileURLToPath(new URL('./cmd-lookup.ts', import.meta.url));
const fixture = lookupFixture();

async function run(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '', stderr = '';
  const code = await main(argv, { out: (text) => { stdout += text; }, err: (text) => { stderr += text; }, cwd });
  return { code, stdout, stderr };
}
async function download(options: { withText?: boolean } = {}): Promise<{ dir: string; run: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cmd-lookup-'));
  await writeLookupDownload(join(dir, 'plan-run'), fixture, options);
  return { dir, run: 'plan-run/run.json' };
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
  const { dir, run: runFile } = await download();
  try {
    const before = await snapshot(dir);
    const result = await run(['--run', runFile, '--param', 'orbit beacon add "b1" fast 3'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^# 命令 orbit beacon add/);
    assert.ok(result.stdout.includes(fixture.statements.get(fixture.reference('/commands/orbit/beacon/add', 'orbit beacon add <arg1'))!));
    assert.match(result.stdout, /^# 逆操作（产品规则：no orbit beacon add）/m);
    assert.match(result.stdout, /^# 手册原文窗/m);
    assert.ok(result.stdout.endsWith('\n') && !result.stdout.endsWith('\n\n'));
    assert.deepEqual(await snapshot(dir), before);
    assert.deepEqual(await run(['--run', runFile, '--param', 'orbit beacon add "b1" fast 3'], dir), result);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--heads lists the heads below a prefix', async () => {
  const { dir, run: runFile } = await download();
  try {
    const result = await run(['--run', runFile, '--heads', 'orbit beacon'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^orbit beacon add <arg1:string 1\.\.40>/m);
    assert.match(result.stdout, /共 2 条/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the pointers into the text files are lines of those files', async () => {
  const { dir, run: runFile } = await download();
  try {
    const result = await run(['--run', runFile, '--param', 'orbit report add'], dir);
    const manual = (await readFile(join(dir, 'plan-run', 'knowledge', 'manual.txt'), 'utf8')).split('\n');
    const pointer = /没有显示的 10 条从 knowledge\/manual\.txt 第 (\d+) 行起/.exec(result.stdout);
    assert.ok(pointer, result.stdout);
    assert.ok(manual[Number(pointer[1]) - 1]!.startsWith(`· 引用 ${fixture.reference('/manual/cli-orbit/报告管理', '第 41 条说明。')}`));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('without the text files the lookup still answers from nodes.jsonl', async () => {
  const { dir, run: runFile } = await download({ withText: false });
  try {
    const result = await run(['--run', runFile, '--param', 'orbit beacon add'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!/第 \d+ 行起/.test(result.stdout), 'no pointer to a line of a text file');
    assert.match(result.stdout, /^# 手册原文窗/m);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a miss is an answer, not a failure', async () => {
  const { dir, run: runFile } = await download();
  try {
    const result = await run(['--run', runFile, '--param', 'orbit becon add'], dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^# 命令树里没有命令 orbit becon add/);
    assert.equal(result.stderr, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('calls it cannot answer are refused with a closed category, one fact and one next step', async () => {
  const { dir, run: runFile } = await download();
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
    await refused(['--run', runFile], /--param 或 --heads/);
    await refused(['--run', runFile, '--param', 'a', '--heads', 'b'], /只能写一个/);
    await refused(['--run', runFile, '--param=orbit'], /不能用 = 连接/);
    await refused(['--run', runFile, '--guess', 'orbit'], /未知选项 --guess/);
    await refused(['--run', 'plan-run/nothing.json', '--param', 'orbit'], /^不存在：/);
    await refused(['--run', '../elsewhere/run.json', '--param', 'orbit'], /超出当前工作目录/);
    await refused(['--run', runFile, '--param', 'orbit beacon add "b1'], /引号/);
    await mkdir(join(dir, 'bare'));
    await writeFile(join(dir, 'bare', 'run.json'), JSON.stringify(fixture.runJson()));
    await refused(['--run', 'bare/run.json', '--param', 'orbit'], /^不存在：.*knowledge\/nodes\.jsonl/);
    await mkdir(join(dir, 'other', 'knowledge'), { recursive: true });
    await writeFile(join(dir, 'other', 'run.json'), JSON.stringify({ ...fixture.runJson(), run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb' }));
    await writeFile(join(dir, 'other', 'knowledge', 'nodes.jsonl'), fixture.files.get('nodes.jsonl')!);
    await refused(['--run', 'other/run.json', '--param', 'orbit'], /^参数无效：命令树下载与冻结运行或节点计数不一致/);
    await writeFile(join(dir, 'other', 'run.json'), '{');
    await refused(['--run', 'other/run.json', '--param', 'orbit'], /^参数无效：.*run\.json/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('run as a program it answers on stdout with exit 0 and reads only what is under the working directory', async () => {
  const { dir, run: runFile } = await download();
  try {
    const result = spawnSync(process.execPath, [TOOL, '--run', runFile, '--param', 'orbit link on'], { cwd: dir, encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' }, timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# 命令 orbit link on/);
    assert.equal(result.stderr, '');
    const bad = spawnSync(process.execPath, [TOOL, '--run', runFile], { cwd: dir, encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' }, timeout: 30_000 });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^参数无效：/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
