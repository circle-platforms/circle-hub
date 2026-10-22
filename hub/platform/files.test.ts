import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  copyFileHashed,
  copyFileIfPresent,
  isMissingOrEmpty,
  listFiles,
  readSymlink,
  removeTree,
  removeWithin,
  sha256File,
  switchSymlink,
  timestampName,
  uniqueChild,
  unlockTree,
  withLock,
  writeFileAtomic,
  writeFileExclusive,
} from './files.ts';
import { removeDir, tempDir } from './test-support.ts';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

async function scratch(): Promise<string> {
  const dir = await tempDir();
  roots.push(dir);
  return dir;
}

test('copyFileHashed returns the digest of the bytes and never overwrites', async () => {
  const dir = await scratch();
  const bytes = Buffer.from('synthetic object bytes\u0000with a NUL');
  await writeFile(join(dir, 'a'), bytes);
  const digest = await copyFileHashed(join(dir, 'a'), join(dir, 'nested', 'b'));
  assert.equal(digest.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(digest.size, bytes.length);
  assert.deepEqual(await sha256File(join(dir, 'nested', 'b')), digest);
  await assert.rejects(copyFileHashed(join(dir, 'a'), join(dir, 'nested', 'b')), /EEXIST/);
});

test('listFiles lists regular files sorted, skips named top-level entries and refuses symlinks', async () => {
  const dir = await scratch();
  await mkdir(join(dir, 'x', 'y'), { recursive: true });
  await writeFile(join(dir, 'x', 'y', 'z'), '1');
  await writeFile(join(dir, 'b'), '2');
  await mkdir(join(dir, 'node_modules'));
  await writeFile(join(dir, 'node_modules', 'ignored'), '3');
  assert.deepEqual(await listFiles(dir, ['node_modules']), ['b', 'x/y/z']);
  assert.deepEqual(await listFiles(join(dir, 'missing')), []);
  await symlink(join(dir, 'b'), join(dir, 'x', 'link'));
  await assert.rejects(listFiles(dir, ['node_modules']), /符号链接/);
});

test('listFiles leaves out excluded names at any depth, symlinks among them, without descending into them', async () => {
  const dir = await scratch();
  await mkdir(join(dir, 'a', '.hidden'), { recursive: true });
  await writeFile(join(dir, 'a', '.hidden', 'inside'), 'x');
  await writeFile(join(dir, 'a', 'keep'), 'x');
  await writeFile(join(dir, 'a', '.temp'), 'x');
  await symlink(join(dir, 'a', 'keep'), join(dir, 'a', '.link'));
  const seen: string[] = [];
  const listed = await listFiles(dir, [], { exclude: (name, path) => (seen.push(path), name.startsWith('.')) });
  assert.deepEqual(listed, ['a/keep']);
  assert.ok(!seen.includes('a/.hidden/inside'), 'an excluded directory is not walked');
});

test('copyFileIfPresent skips a source that vanished without leaving a target, copies with the mapped mode, refuses a symlink', async () => {
  const dir = await scratch();
  assert.equal(await copyFileIfPresent(join(dir, 'gone'), join(dir, 'out', 'gone')), undefined);
  assert.deepEqual(await readdir(dir), [], 'not even the target directory was created');
  const bytes = Buffer.from('synthetic \u0000 bytes');
  await writeFile(join(dir, 'source'), bytes, { mode: 0o400 });
  const digest = await copyFileIfPresent(join(dir, 'source'), join(dir, 'out', 'copy'), (mode) => (mode & 0o700) | 0o400);
  assert.deepEqual(digest, { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  assert.equal((await stat(join(dir, 'out', 'copy'))).mode & 0o777, 0o400);
  await assert.rejects(copyFileIfPresent(join(dir, 'source'), join(dir, 'out', 'copy')), /EEXIST/, 'never overwrites');
  await symlink(join(dir, 'source'), join(dir, 'link'));
  await assert.rejects(copyFileIfPresent(join(dir, 'link'), join(dir, 'out', 'link')), /ELOOP|符号链接|不是普通文件/);
});

test('exclusive and atomic writes', async () => {
  const dir = await scratch();
  await writeFileExclusive(join(dir, 'f'), 'one');
  await assert.rejects(writeFileExclusive(join(dir, 'f'), 'two'), /不覆盖/);
  await writeFileAtomic(join(dir, 'f'), 'three');
  assert.equal(await readFile(join(dir, 'f'), 'utf8'), 'three');
  assert.ok(await isMissingOrEmpty(join(dir, 'none')));
  await mkdir(join(dir, 'empty'));
  assert.ok(await isMissingOrEmpty(join(dir, 'empty')));
  assert.equal(await isMissingOrEmpty(dir), false);
});

test('switchSymlink replaces the link atomically and refuses a real directory', async () => {
  const dir = await scratch();
  await mkdir(join(dir, 'releases', 'a'), { recursive: true });
  await mkdir(join(dir, 'releases', 'b'), { recursive: true });
  const link = join(dir, 'current');
  assert.equal(await readSymlink(link), undefined);
  await switchSymlink(link, 'releases/a');
  assert.equal(await readlink(link), 'releases/a');
  await switchSymlink(link, 'releases/b');
  assert.equal(await readlink(link), 'releases/b');
  await switchSymlink(link, undefined);
  assert.equal(await readSymlink(link), undefined);
  await mkdir(link);
  await assert.rejects(switchSymlink(link, 'releases/a'), /应该是符号链接/);
});

test('removeWithin refuses anything outside its parent', async () => {
  const dir = await scratch();
  await mkdir(join(dir, 'inner'));
  await assert.rejects(removeWithin(join(dir, 'inner'), dir), /拒绝删除/);
  await assert.rejects(removeWithin(join(dir, 'inner'), join(dir, 'inner')), /拒绝删除/);
  await assert.rejects(removeWithin(join(dir, 'inner'), join(dir, 'inner', '..', 'x')), /拒绝删除/);
  await mkdir(join(dir, 'inner', 'gone'));
  await removeWithin(join(dir, 'inner'), join(dir, 'inner', 'gone'));
  assert.ok(await isMissingOrEmpty(join(dir, 'inner')));
});

test('removeTree removes read-only trees (extracted packs) without following links; files keep their modes until then', async () => {
  const dir = await scratch();
  // A directory outside the tree, read-only, reached through a link from inside: it must stay as it is.
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'kept'), 'kept', { mode: 0o400 });
  await chmod(outside, 0o500);
  const tree = join(dir, 'packs');
  await mkdir(join(tree, 'digest', 'functions'), { recursive: true });
  await writeFile(join(tree, 'digest', 'pack.json'), '{}', { mode: 0o400 });
  await writeFile(join(tree, 'digest', 'functions', 'f.ts'), 'export default 1;\n', { mode: 0o400 });
  await symlink(outside, join(tree, 'digest', 'link'));
  for (const path of [join(tree, 'digest', 'functions'), join(tree, 'digest')]) await chmod(path, 0o500);
  // A plain rm cannot remove it: the 0500 directories keep their entries.
  await assert.rejects(rm(tree, { recursive: true, force: true }), (error: unknown) => ['EACCES', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code)));
  await unlockTree(join(tree, 'digest', 'pack.json'));
  assert.equal((await stat(join(tree, 'digest', 'pack.json'))).mode & 0o777, 0o400, 'a file is left as it is');
  await removeTree(tree);
  await assert.rejects(stat(tree), /ENOENT/);
  assert.equal((await stat(outside)).mode & 0o777, 0o500, 'the linked directory was not unlocked');
  assert.equal(await readFile(join(outside, 'kept'), 'utf8'), 'kept');
  await removeTree(join(dir, 'missing'));
  await chmod(outside, 0o700);
});

test('withLock is exclusive while held and takes over a lock left by a dead process', async () => {
  const dir = await scratch();
  const path = join(dir, 'run', 'platform.lock');
  let inner: Promise<unknown> | undefined;
  await withLock(path, async () => {
    inner = withLock(path, async () => 'never');
    await assert.rejects(inner, /另一个 circle-hub 操作正在进行/);
  });
  await writeFile(path, '999999999\n');
  assert.equal(await withLock(path, async () => 'taken over'), 'taken over');
  assert.equal(await isMissingOrEmpty(join(dir, 'run')), true);
});

test('withLock never reads a lock while it is being written, and refuses one it cannot read instead of taking it over', async () => {
  const dir = await scratch();
  const path = join(dir, 'run', 'platform.lock');
  let inside = '';
  await withLock(path, async () => {
    inside = await readFile(path, 'utf8');
  });
  assert.match(inside, new RegExp(`^${process.pid} [0-9a-f]{32}\\n$`), 'the lock appears complete, with pid and token');
  await mkdir(join(dir, 'run'), { recursive: true });
  // An empty file is what a holder left between create and write in earlier versions: it may still be alive.
  await writeFile(path, '');
  let ran = false;
  await assert.rejects(
    withLock(path, async () => {
      ran = true;
    }),
    (error: unknown) => {
      assert.match((error as Error).message, /锁文件的内容看不懂/);
      assert.match(String((error as { hint?: string }).hint), /确认没有 circle-hub 操作在进行后删除这个文件/);
      return true;
    },
  );
  assert.equal(ran, false);
  assert.equal(await readFile(path, 'utf8'), '', 'left in place');
});

test('withLock removes only its own lock on release', async () => {
  const dir = await scratch();
  const path = join(dir, 'run', 'platform.lock');
  const foreign = '999999998 0123456789abcdef0123456789abcdef\n';
  await withLock(path, async () => {
    // Someone else's lock replaced ours (for example after a takeover); releasing must not delete it.
    await writeFile(path, foreign);
  });
  assert.equal(await readFile(path, 'utf8'), foreign);
});

test('of several processes taking over the same dead lock at the same moment, never two hold it', async () => {
  const dir = await scratch();
  const child = join(dir, 'take-lock.mts');
  // Waits for a common start time, takes the lock through this files.ts, holds it briefly, reports the interval.
  await writeFile(
    child,
    [
      `const { withLock } = await import(${JSON.stringify(new URL('./files.ts', import.meta.url).href)});`,
      'const [lock, at] = process.argv.slice(2);',
      'while (Date.now() < Number(at)) await new Promise((r) => setTimeout(r, 1));',
      'try {',
      '  await withLock(lock, async () => { const begin = Date.now(); await new Promise((r) => setTimeout(r, 120)); process.stdout.write(`held ${begin} ${Date.now()}`); });',
      '} catch { process.stdout.write("refused"); }',
      '',
    ].join('\n'),
  );
  for (let round = 0; round < 8; round++) {
    const lock = join(dir, `run-${round}`, 'platform.lock');
    await mkdir(join(dir, `run-${round}`));
    await writeFile(lock, '999999996\n');
    const at = Date.now() + 500;
    const outputs = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<string>((resolve) => {
            const proc = spawn(process.execPath, [child, lock, String(at)], { stdio: ['ignore', 'pipe', 'inherit'] });
            let out = '';
            proc.stdout.on('data', (data: Buffer) => (out += data.toString()));
            proc.on('close', () => resolve(out));
          }),
      ),
    );
    const held = outputs.filter((out) => out.startsWith('held')).map((out) => out.split(' ').slice(1).map(Number));
    const overlap = held.some(([a1, b1], i) => held.some(([a2, b2], j) => i !== j && a1! < b2! && a2! < b1!));
    assert.equal(overlap, false, `round ${round}: two processes held the lock at the same time`);
    assert.ok(held.length >= 1, `round ${round}: the dead lock was taken over`);
    assert.deepEqual(await readdir(join(dir, `run-${round}`)), [], `round ${round}: no lock, breaker or temporary left`);
  }
});

test('of several takers in one process on the same dead lock at once, never two hold it', async () => {
  for (let round = 0; round < 20; round++) {
    const dir = await scratch();
    const path = join(dir, 'run', 'platform.lock');
    await mkdir(join(dir, 'run'), { recursive: true });
    await writeFile(path, '999999997\n');
    let holders = 0;
    let most = 0;
    const attempt = () =>
      withLock(path, async () => {
        holders++;
        most = Math.max(most, holders);
        await new Promise((resolve) => setTimeout(resolve, 20));
        holders--;
        return true;
      }).catch(() => false);
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    assert.equal(most, 1, `round ${round}: two holders at the same time`);
    // A slow taker may get the lock after the first holder released it; that is a later holder, not a second one.
    assert.ok(results.filter(Boolean).length >= 1, `round ${round}: the dead lock was taken over`);
    assert.deepEqual(await readdir(join(dir, 'run')), [], `round ${round}: no lock, breaker or temporary left`);
  }
});

test('timestamps and unique names sort chronologically', async () => {
  assert.equal(timestampName(new Date('2026-10-21T23:05:01.123Z')), '20261021T230501Z');
  const dir = await scratch();
  const first = await uniqueChild(dir, 'n');
  await mkdir(first);
  const second = await uniqueChild(dir, 'n');
  assert.equal(first, join(dir, 'n'));
  assert.equal(second, join(dir, 'n-2'));
});
