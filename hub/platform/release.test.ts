import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { exists, listFiles } from './files.ts';
import { ensureLayout, layoutAt, type Layout } from './layout.ts';
import { runCommand } from './process.ts';
import { prepareRelease, readCurrentRelease, readReleaseFile, RELEASE_FILE, switchCurrent } from './release.ts';
import { exit, ok, recordingRunner, removeDir, tempDir, type Call } from './test-support.ts';

const WORKTREE = fileURLToPath(new URL('../../', import.meta.url));
const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

async function scratch(): Promise<string> {
  const dir = await tempDir();
  roots.push(dir);
  return dir;
}

async function freshLayout(): Promise<Layout> {
  const layout = layoutAt(join(await scratch(), 'root'));
  await ensureLayout(layout);
  return layout;
}

/** A synthetic source tree (not a git work tree) with the files a release needs, plus entries a copy must leave out. */
async function syntheticSource(): Promise<string> {
  const source = await scratch();
  await mkdir(join(source, 'bin'));
  await writeFile(join(source, 'bin', 'circle-hub'), '#!/usr/bin/env node\n');
  await chmod(join(source, 'bin', 'circle-hub'), 0o755);
  await writeFile(join(source, 'package.json'), '{"name":"synthetic","type":"module"}\n');
  await writeFile(join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await mkdir(join(source, 'hub'));
  await writeFile(join(source, 'hub', 'synthetic.ts'), 'export const value = 1;\n');
  for (const skipped of ['node_modules', 'foundation', 'references']) {
    await mkdir(join(source, skipped));
    await writeFile(join(source, skipped, 'skipped.txt'), 'not deployed');
  }
  return source;
}

/** Synthetic stand-ins (no real values) for an owner's private files, at the top and deeper down. */
async function addPrivateFiles(source: string): Promise<void> {
  await writeFile(join(source, '.env'), 'SYNTHETIC_TOKEN=not-a-real-value\n', { mode: 0o600 });
  await writeFile(join(source, '.env.local'), 'SYNTHETIC=1\n');
  await writeFile(join(source, '.npmrc'), '//registry.example.invalid/:_authToken=synthetic\n');
  await writeFile(join(source, 'debug.log'), 'synthetic log line\n');
  await mkdir(join(source, '.circle'));
  await writeFile(join(source, '.circle', 'session.json'), '{"synthetic":true}\n');
  await writeFile(join(source, 'hub', '.env'), 'NESTED=1\n');
  await writeFile(join(source, 'hub', 'server.log'), 'nested log\n');
  await writeFile(join(source, '.DS_Store'), 'finder');
}

/** Fake npm: records the call and creates node_modules in the release being built. */
function fakeNpm(result = ok()) {
  return recordingRunner(async (call: Call) => {
    if (call.command !== 'npm') return undefined;
    if (result.code === 0) await mkdir(join(call.options.cwd!, 'node_modules', 'synthetic'), { recursive: true });
    return result;
  });
}

test('a copy release leaves out reference archives, keeps modes, runs npm ci inside it and is reused', async () => {
  const layout = await freshLayout();
  const source = await syntheticSource();
  const { runner, calls } = fakeNpm();
  const release = await prepareRelease({ path: source, copy: true }, { layout, runner });
  assert.match(release.id, /^[0-9a-f]{12}$/);
  assert.equal(release.dir, join(layout.releases, release.id));
  assert.equal(release.reused, false);
  assert.ok(release.file.tree_sha256 && !release.file.commit);
  assert.deepEqual((await readdir(release.dir)).sort(), ['bin', 'hub', 'node_modules', 'package-lock.json', 'package.json', RELEASE_FILE].sort());
  assert.equal((await stat(join(release.dir, 'bin', 'circle-hub'))).mode & 0o111, 0o111);
  const npm = calls.filter((call) => call.command === 'npm');
  assert.equal(npm.length, 1);
  assert.deepEqual(npm[0]?.args, ['ci', '--include=dev', '--no-audit', '--no-fund']);
  assert.match(npm[0]?.options.cwd ?? '', /\/releases\/\.partial-/);
  assert.ok(!Object.keys(npm[0]?.options.env ?? {}).some((key) => key.startsWith('PG') || key.startsWith('CIRCLE_SERVER_')));
  assert.deepEqual(await readReleaseFile(release.dir), release.file);

  const again = await prepareRelease({ path: source, copy: true }, { layout, runner });
  assert.equal(again.id, release.id);
  assert.equal(again.reused, true);
  assert.equal(calls.filter((call) => call.command === 'npm').length, 1, 'no second npm ci');

  await writeFile(join(source, 'hub', 'synthetic.ts'), 'export const value = 2;\n');
  const changed = await prepareRelease({ path: source, copy: true }, { layout, runner });
  assert.notEqual(changed.id, release.id, 'different content, different release');
});

test('a copy never reads or carries private files and keeps owner-only modes', async () => {
  const layout = await freshLayout();
  const source = await syntheticSource();
  const { runner } = fakeNpm();
  const plain = await prepareRelease({ path: source, copy: true }, { layout, runner });
  await addPrivateFiles(source);
  await writeFile(join(source, 'hub', 'owner-only.ts'), 'export const secretShaped = false;\n', { mode: 0o600 });
  await writeFile(join(source, 'bin', 'owner-tool'), '#!/bin/sh\n', { mode: 0o700 });
  const release = await prepareRelease({ path: source, copy: true }, { layout, runner });
  const copied = (await listFiles(release.dir, ['node_modules'])).sort();
  assert.deepEqual(copied, ['bin/circle-hub', 'bin/owner-tool', 'hub/owner-only.ts', 'hub/synthetic.ts', 'package-lock.json', 'package.json', RELEASE_FILE].sort());
  assert.equal((await stat(join(release.dir, 'hub', 'owner-only.ts'))).mode & 0o777, 0o600, 'owner-only stays owner-only');
  assert.equal((await stat(join(release.dir, 'bin', 'owner-tool'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(release.dir, 'hub', 'synthetic.ts'))).mode & 0o777, 0o644);
  assert.equal((await stat(join(release.dir, 'bin', 'circle-hub'))).mode & 0o777, 0o755);

  // Private files take no part in the release id: changing one changes nothing.
  await rm(join(source, 'hub', 'owner-only.ts'));
  await rm(join(source, 'bin', 'owner-tool'));
  await writeFile(join(source, '.env'), 'SYNTHETIC_TOKEN=changed\n');
  assert.equal((await prepareRelease({ path: source, copy: true }, { layout, runner })).id, plain.id);
});

test('a git work tree is never copied as a directory: it is deployed from a commit', async () => {
  const layout = await freshLayout();
  const source = await syntheticSource();
  await mkdir(join(source, '.git'));
  await addPrivateFiles(source);
  await assert.rejects(prepareRelease({ path: source, copy: true }, { layout, runner: fakeNpm().runner }), (error: unknown) => {
    assert.match((error as Error).message, /是 git 工作区，不按目录复制/);
    assert.match(String((error as { hint?: string }).hint), /--commit/);
    return true;
  });
  assert.deepEqual(await readdir(layout.releases), []);
});

test('a failed npm ci or a release without bin/circle-hub leaves no release directory behind', async () => {
  const layout = await freshLayout();
  const source = await syntheticSource();
  const failing = fakeNpm(exit(1, 'npm ERR! synthetic failure'));
  await assert.rejects(prepareRelease({ path: source, copy: true }, { layout, runner: failing.runner }), /npm ci失败（退出码 1）：npm ERR! synthetic failure/);
  assert.deepEqual(await readdir(layout.releases), []);
  const { rm } = await import('node:fs/promises');
  await rm(join(source, 'bin'), { recursive: true });
  await assert.rejects(prepareRelease({ path: source, copy: true }, { layout, runner: fakeNpm().runner }), /没有 bin\/circle-hub/);
  assert.deepEqual(await readdir(layout.releases), []);
});

test('a directory that is not a git work tree needs --copy; an incomplete release directory is refused', async () => {
  const layout = await freshLayout();
  const plain = await scratch();
  await assert.rejects(prepareRelease({ path: plain }, { layout, runner: fakeNpm().runner }), /不是 git 工作区/);
  const source = await syntheticSource();
  const first = await prepareRelease({ path: source, copy: true }, { layout, runner: fakeNpm().runner });
  const { rm } = await import('node:fs/promises');
  await rm(join(first.dir, RELEASE_FILE));
  await assert.rejects(prepareRelease({ path: source, copy: true }, { layout, runner: fakeNpm().runner }), /已存在但不是完整的发布/);
});

test('a commit release goes through git rev-parse, git archive without the reference archives, and tar', async () => {
  const layout = await freshLayout();
  const tree = await syntheticSource();
  await mkdir(join(tree, '.git'));
  const commit = 'c0ffee'.padEnd(40, '0');
  const { runner, calls } = recordingRunner(async (call: Call) => {
    if (call.command === 'git' && call.args[2] === 'rev-parse') return ok(`${commit}\n`);
    if (call.command === 'git' && call.args[2] === 'status') return ok(' M something\n');
    if (call.command === 'git' && call.args[2] === 'archive') {
      const output = call.args.find((arg) => arg.startsWith('--output='))!.slice('--output='.length);
      return runCommand('tar', ['-c', '-f', output, '-C', tree, 'bin', 'hub', 'package.json', 'package-lock.json']);
    }
    if (call.command === 'npm') {
      await mkdir(join(call.options.cwd!, 'node_modules'), { recursive: true });
      return ok();
    }
    return undefined;
  });
  const messages: string[] = [];
  const release = await prepareRelease({ path: tree }, { layout, runner, log: (line) => messages.push(line) });
  assert.equal(release.id, commit.slice(0, 12));
  assert.equal(release.file.commit, commit);
  const archive = calls.find((call) => call.args[2] === 'archive');
  assert.deepEqual(archive?.args.slice(0, 5), ['-C', tree, 'archive', '--format=tar', archive?.args[4]]);
  assert.deepEqual(archive?.args.slice(5), [commit, '--', '.', ':(exclude)foundation', ':(exclude)references']);
  assert.ok(await exists(join(release.dir, 'bin', 'circle-hub')));
  assert.deepEqual(await readdir(layout.releases), [release.id], 'no partial directory or tar file is left');
  assert.match(messages.join('\n'), /未提交的改动/);
});

test('git archive of a real commit of this repository (read-only)', async (t) => {
  const check = await runCommand('git', ['-C', WORKTREE, 'rev-parse', '--verify', 'ca66002^{commit}'], { env: process.env });
  if (check.code !== 0) {
    t.skip('skipped: commit ca66002 is not in this clone');
    return;
  }
  const layout = await freshLayout();
  const { runner } = fakeNpm();
  const release = await prepareRelease({ path: WORKTREE, commit: 'ca66002' }, { layout, runner, env: process.env });
  assert.equal(release.file.commit, check.stdout.trim());
  assert.ok(await exists(join(release.dir, 'package.json')));
  assert.ok(!(await exists(join(release.dir, 'foundation'))));
  assert.ok(!(await exists(join(release.dir, 'references'))));
});

test('current switches between complete releases only and is read back', async () => {
  const layout = await freshLayout();
  const source = await syntheticSource();
  const release = await prepareRelease({ path: source, copy: true }, { layout, runner: fakeNpm().runner });
  assert.equal(await readCurrentRelease(layout), undefined);
  await assert.rejects(switchCurrent(layout, 'ffffffffffff'), /没有这个发布/);
  await switchCurrent(layout, release.id);
  assert.deepEqual(await readCurrentRelease(layout), { id: release.id, dir: release.dir });
  const { readlink } = await import('node:fs/promises');
  assert.equal(await readlink(layout.current), join('releases', release.id), 'relative link');
  await switchCurrent(layout, undefined);
  assert.equal(await readCurrentRelease(layout), undefined);
  await symlink('releases/not-a-release', layout.current);
  await assert.rejects(readCurrentRelease(layout), /不是一个完整的发布/);
  assert.equal(await readFile(join(release.dir, 'package.json'), 'utf8'), '{"name":"synthetic","type":"module"}\n');
});
