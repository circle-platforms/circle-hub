// bin/circle-hub, run as a child process from a temporary tree that holds a copy of it and stub CLI modules.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { removeDir, tempDir } from './test-support.ts';

const WORKTREE = fileURLToPath(new URL('../../', import.meta.url));
let tree: string;

before(async () => {
  tree = await tempDir();
  await writeFile(join(tree, 'package.json'), '{"type":"module"}\n');
  await mkdir(join(tree, 'bin'));
  await copyFile(join(WORKTREE, 'bin', 'circle-hub'), join(tree, 'bin', 'circle-hub'));
  await mkdir(join(tree, 'hub', 'platform'), { recursive: true });
  for (const file of ['environment.ts', 'errors.ts']) await copyFile(join(WORKTREE, 'hub', 'platform', file), join(tree, 'hub', 'platform', file));
});

after(async () => {
  if (tree) await removeDir(tree);
});

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [join(tree, 'bin', 'circle-hub'), ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

async function serverCli(source: string | undefined): Promise<void> {
  const path = join(tree, 'hub', 'server', 'cli.ts');
  if (source === undefined) await rm(path, { force: true });
  else {
    await mkdir(join(tree, 'hub', 'server'), { recursive: true });
    await writeFile(path, source);
  }
}

test('a server CLI without main is an error naming it, never a silent success', async () => {
  await serverCli('export function run(): number {\n  return 0;\n}\n');
  const result = run(['backup']);
  assert.equal(result.code, 1);
  assert.match(result.err, /错误：hub\/server\/cli\.ts 没有导出 main\(argv\)，什么也没有执行/);
});

test("the exit code is main's; a main that returns no exit code is a failure", async () => {
  await serverCli('export async function main(argv: string[]): Promise<number> {\n  process.stdout.write(argv.join(","));\n  return 3;\n}\n');
  const result = run(['status', '--x']);
  assert.equal(result.code, 3);
  assert.equal(result.out, 'status,--x');
  await serverCli('export async function main(): Promise<void> {}\n');
  assert.equal(run(['status']).code, 1);
});

test('without a server CLI the platform CLI runs, and it too must export main', async () => {
  await serverCli(undefined);
  await writeFile(join(tree, 'hub', 'platform', 'cli.ts'), 'export const PLATFORM_COMMANDS: string[] = [];\n');
  const result = run(['status']);
  assert.equal(result.code, 1);
  assert.match(result.err, /hub\/platform\/cli\.ts 没有导出 main\(argv\)/);
});

test('a retired CIRCLE_SERVER_* variable stops the command before any CLI is loaded', async () => {
  await serverCli('throw new Error("must not be loaded");\n');
  const result = run(['status'], { CIRCLE_SERVER_PORT: '7420' });
  assert.equal(result.code, 1);
  assert.match(result.err, /不再读取 CIRCLE_SERVER_\*/);
  assert.doesNotMatch(result.err, /must not be loaded/);
});
