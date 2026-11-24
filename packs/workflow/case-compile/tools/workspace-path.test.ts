import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CallFailure, formatCallError } from '../functions/text.ts';
import { RUN_DIRECTORY_FORM, resolveCwdRoots, resolveRun, resolveRunDirectory, resolveRunFile } from './workspace-path.ts';

async function workspace(): Promise<{ root: string; cwd: ReturnType<typeof resolveCwdRoots> }> {
  const root = await mkdtemp(join(tmpdir(), 'run-directory-'));
  await mkdir(join(root, 'plan-run', 'knowledge'), { recursive: true });
  await writeFile(join(root, 'plan-run', 'run.json'), '{}');
  return { root, cwd: resolveCwdRoots(root) };
}
const failureOf = (action: () => unknown): CallFailure => {
  try { action(); } catch (error) { assert.ok(error instanceof CallFailure, String(error)); return error; }
  throw new Error('the value was accepted');
};
const ONE_LINE = `合法写法：${RUN_DIRECTORY_FORM}。`;

test('a run directory resolves under the working directory, relative or absolute, and its run.json is the regular file in it', async () => {
  const { root, cwd } = await workspace();
  try {
    const directory = resolveRunDirectory('plan-run', cwd);
    assert.equal(directory.relative, 'plan-run');
    assert.equal(directory.canonical, join(await realpath(root), 'plan-run'));
    assert.equal(resolveRunDirectory(join(root, 'plan-run'), cwd).canonical, directory.canonical);
    const found = resolveRun('plan-run', cwd);
    assert.equal(found.file.relative, 'plan-run/run.json');
    assert.equal(resolveRunFile(found.directory, cwd).canonical, join(directory.canonical, 'run.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('without a working directory the value is taken as given: a directory anywhere resolves by its own path', async () => {
  const { root } = await workspace();
  try {
    const found = resolveRun(join(root, 'plan-run'));
    assert.equal(found.directory.lexical, join(root, 'plan-run'));
    assert.equal(found.file.lexical, join(root, 'plan-run', 'run.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the run.json file as --run is refused in the words of every other directory, bounded or not, with the one-line correct form', async () => {
  const { root, cwd } = await workspace();
  try {
    const bounded = failureOf(() => resolveRunDirectory('plan-run/run.json', cwd));
    assert.equal(bounded.category, 'invalid_parameters');
    assert.equal(bounded.fact, '--run plan-run/run.json 不是普通目录。请改用工作目录内的普通目录后重试');
    assert.equal(bounded.legal_form, RUN_DIRECTORY_FORM);
    assert.ok(formatCallError(bounded).endsWith(ONE_LINE), formatCallError(bounded));
    assert.ok(formatCallError(bounded).startsWith('参数无效：--run plan-run/run.json 不是普通目录。'), 'the category word is printed once');
    assert.equal(formatCallError(bounded).split('\n').length, 1);
    const file = join(root, 'plan-run', 'run.json');
    const free = failureOf(() => resolveRunDirectory(file));
    assert.equal(free.fact, `--run ${file} 不是普通目录。请改用工作目录内的普通目录后重试`);
    assert.equal(free.legal_form, RUN_DIRECTORY_FORM);
    assert.equal(free.next_action, bounded.next_action);
    assert.ok(formatCallError(free).endsWith(ONE_LINE), formatCallError(free));
    assert.equal(failureOf(() => resolveRun(file)).legal_form, RUN_DIRECTORY_FORM);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a --run that is missing, a link or outside the working directory names the correct form too', async () => {
  const { root, cwd } = await workspace();
  try {
    await symlink(join(root, 'plan-run'), join(root, 'link-run'));
    const missing = failureOf(() => resolveRunDirectory('nothing', cwd));
    assert.equal(missing.category, 'not_found');
    assert.match(missing.fact, /^找不到 --run 目录 nothing。/);
    const linked = failureOf(() => resolveRunDirectory('link-run', cwd));
    assert.match(linked.fact, /^--run 目录 link-run 不能是符号链接/);
    const outside = failureOf(() => resolveRunDirectory('../elsewhere', cwd));
    assert.match(outside.fact, /超出当前工作目录/);
    for (const failure of [missing, linked, outside]) assert.equal(failure.legal_form, RUN_DIRECTORY_FORM);
    assert.equal(failureOf(() => resolveRunDirectory(join(root, 'nothing'))).legal_form, RUN_DIRECTORY_FORM);
    assert.equal(failureOf(() => resolveRunDirectory(join(root, 'link-run'))).legal_form, RUN_DIRECTORY_FORM);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a run directory whose run.json is missing, a link or not a file is refused with the hint of the tool, bounded or not', async () => {
  const { root, cwd } = await workspace();
  try {
    await mkdir(join(root, 'empty'));
    const hint = '用 download-run.ts 重新下载本次运行';
    const missing = failureOf(() => resolveRun('empty', cwd, hint));
    assert.equal(missing.category, 'not_found');
    assert.equal(missing.fact, `找不到 --run 目录里的 run.json 文件 empty/run.json。${hint}`);
    assert.equal(missing.legal_form, RUN_DIRECTORY_FORM);
    assert.equal(failureOf(() => resolveRun(join(root, 'empty'), undefined, hint)).fact, `找不到 --run 目录里的 run.json 文件 ${join(root, 'empty', 'run.json')}。${hint}`);
    assert.match(failureOf(() => resolveRun('empty', cwd)).fact, /run\.json 留在运行目录里$/, 'without a hint the shared one is given');
    await symlink(join(root, 'plan-run', 'run.json'), join(root, 'empty', 'run.json'));
    assert.match(failureOf(() => resolveRun('empty', cwd)).fact, /^--run 目录里的 run\.json 文件 empty\/run\.json 不能是符号链接/);
    await rm(join(root, 'empty', 'run.json'));
    await mkdir(join(root, 'empty', 'run.json'));
    assert.match(failureOf(() => resolveRun('empty', cwd)).fact, /^--run 目录里的 run\.json empty\/run\.json 不是普通文件/);
    assert.match(failureOf(() => resolveRun(join(root, 'empty'))).fact, /不是普通文件/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
