// Release bundles (decision 76): an unpacked bundle deploys its app/ as the release without npm ci, keeping the symlinks
// npm made, once its tree digest and platform check out; a tampered tree, another platform, a link out of the release or
// an absolute link is refused and leaves no release behind.
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ensureLayout, layoutAt, type Layout } from './layout.ts';
import { BUNDLE_FILE, BUNDLE_SCHEMA, bundleTreeDigest, hostBundlePlatform, prepareRelease, readReleaseFile } from './release.ts';
import { recordingRunner, removeDir, tempDir } from './test-support.ts';

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

const COMMIT = 'a'.repeat(40);

/** An unpacked synthetic bundle; `extra` changes app/ before the digest is taken. */
async function bundle(platform = 'linux-x64', extra?: (app: string) => Promise<void>): Promise<string> {
  const dir = await scratch();
  const app = join(dir, 'app');
  await mkdir(join(app, 'bin'), { recursive: true });
  await writeFile(join(app, 'bin', 'circle-hub'), '#!/usr/bin/env node\n');
  await chmod(join(app, 'bin', 'circle-hub'), 0o755);
  await writeFile(join(app, 'package.json'), '{"name":"synthetic","type":"module"}\n');
  await mkdir(join(app, 'node_modules', 'synthetic', 'lib'), { recursive: true });
  await writeFile(join(app, 'node_modules', 'synthetic', 'lib', 'libsynthetic.1.dylib'), 'binary');
  await symlink('libsynthetic.1.dylib', join(app, 'node_modules', 'synthetic', 'lib', 'libsynthetic.dylib'));
  await mkdir(join(app, 'node_modules', '.bin'));
  await symlink('../synthetic/lib/libsynthetic.1.dylib', join(app, 'node_modules', '.bin', 'synthetic'));
  await extra?.(app);
  await writeFile(join(dir, BUNDLE_FILE), JSON.stringify({ schema: BUNDLE_SCHEMA, version: '0.3.0', commit: COMMIT, platform, node: 'v24.21.0', tree_sha256: await bundleTreeDigest(app), created_at: '2026-10-31T00:00:00.000Z' }));
  return dir;
}

/** Any external command fails the test: a bundle never runs npm, git or tar. */
const noCommands = () => recordingRunner(async (call) => { throw new Error(`unexpected command ${call.command}`); });

test('a bundle becomes a release as it is: no npm ci, its symlinks kept, the commit recorded, reused next time', async () => {
  const layout = await freshLayout();
  const source = await bundle();
  const { runner, calls } = noCommands();
  const release = await prepareRelease({ path: source, bundle: true }, { layout, runner, bundlePlatform: 'linux-x64' });
  assert.equal(release.id, COMMIT.slice(0, 12));
  assert.equal(release.reused, false);
  assert.equal(calls.length, 0);
  assert.equal((await readReleaseFile(release.dir))?.commit, COMMIT);
  assert.equal(await readlink(join(release.dir, 'node_modules', '.bin', 'synthetic')), '../synthetic/lib/libsynthetic.1.dylib');
  assert.ok((await lstat(join(release.dir, 'node_modules', 'synthetic', 'lib', 'libsynthetic.dylib'))).isSymbolicLink());
  assert.equal((await lstat(join(release.dir, 'bin', 'circle-hub'))).mode & 0o111, 0o111);
  const again = await prepareRelease({ path: source, bundle: true }, { layout, runner, bundlePlatform: 'linux-x64' });
  assert.equal(again.reused, true);
});

test('a bundle for another platform, with a changed tree, without bundle.json, or with a link out of the release is refused', async () => {
  const layout = await freshLayout();
  await assert.rejects(prepareRelease({ path: await bundle('darwin-arm64'), bundle: true }, { layout, bundlePlatform: 'linux-x64' }), /是给 darwin-arm64 的/);

  const tampered = await bundle();
  await writeFile(join(tampered, 'app', 'package.json'), '{"name":"changed"}\n');
  await assert.rejects(prepareRelease({ path: tampered, bundle: true }, { layout, bundlePlatform: 'linux-x64' }), /摘要不符/);

  await assert.rejects(prepareRelease({ path: await scratch(), bundle: true }, { layout, bundlePlatform: 'linux-x64' }), /不是解开的发布包/);

  const escaping = await bundle('linux-x64', (app) => symlink('../../outside', join(app, 'node_modules', 'escape')));
  await assert.rejects(prepareRelease({ path: escaping, bundle: true }, { layout, bundlePlatform: 'linux-x64' }), /指向发布之外/);
  const absolute = await bundle('linux-x64', (app) => symlink('/etc/hosts', join(app, 'node_modules', 'absolute')));
  await assert.rejects(prepareRelease({ path: absolute, bundle: true }, { layout, bundlePlatform: 'linux-x64' }), /指向发布之外/);

  assert.deepEqual((await readdir(layout.releases)).filter((name) => !name.startsWith('.')), [], 'no release was left behind');
  assert.deepEqual((await readdir(layout.releases)).filter((name) => name.startsWith('.partial-')), [], 'no partial directory either');
});

test('the tree digest changes with a file, a link target or a new entry, and never follows a link', async () => {
  const dir = await scratch();
  await mkdir(join(dir, 'a'));
  await writeFile(join(dir, 'a', 'file'), 'x');
  await symlink('file', join(dir, 'a', 'link'));
  const first = await bundleTreeDigest(dir);
  await writeFile(join(dir, 'a', 'file'), 'y');
  const second = await bundleTreeDigest(dir);
  assert.notEqual(first, second);
  await writeFile(join(dir, 'a', 'other'), 'y');
  const third = await bundleTreeDigest(dir);
  assert.notEqual(second, third);
  assert.match(third, /^[0-9a-f]{64}$/);
});

test('bundles exist for macOS and Linux on arm64 and x64 only', () => {
  assert.equal(hostBundlePlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(hostBundlePlatform('linux', 'x64'), 'linux-x64');
  assert.equal(hostBundlePlatform('win32', 'x64'), null);
  assert.equal(hostBundlePlatform('linux', 'ia32'), null);
});
