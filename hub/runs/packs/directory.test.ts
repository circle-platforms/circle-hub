import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { canonicalize, sha256Hex } from '../../records/api.ts';
import { readPackDirectory, readSeen, type DiskFile } from './directory.ts';
import { corruptByte, signPack, temporaryDirectory, workflowPack, writeManifest, writePack, type WrittenManifest } from './testing/builder.ts';
import type { PackProblem, PackRead } from './types.ts';

let temp: { path: string; remove: () => Promise<void> };
let n = 0;
before(async () => {
  temp = await temporaryDirectory();
});
after(() => temp?.remove());

const fresh = async () => writePack(join(temp.path, `p${++n}`), workflowPack());

function problems(read: PackRead): PackProblem[] {
  assert.equal(read.ok, false, 'the read should have been refused');
  return read.ok ? [] : read.problems;
}

function has(read: PackRead, rule: string, where: { file?: string; field?: string } = {}): PackProblem {
  const all = problems(read);
  const hit = all.find((p) => p.rule === rule && (where.file === undefined || p.file === where.file) && (where.field === undefined || p.field === where.field));
  assert.ok(hit, `expected ${rule} ${JSON.stringify(where)} in ${JSON.stringify(all, null, 1)}`);
  assert.match(hit.message, /\p{Script=Han}/u, 'messages are Chinese');
  assert.match(hit.fix, /\p{Script=Han}/u, 'fixes are Chinese');
  return hit;
}

test('a written pack reads back with every file, and its digest is the SHA-256 of the canonical manifest', async () => {
  const written = await fresh();
  const read = await readPackDirectory(written.dir);
  assert.ok(read.ok, JSON.stringify(!read.ok && read.problems));
  assert.equal(read.pack.digest, sha256Hex(canonicalize(written.manifest)));
  assert.equal(read.pack.digest, written.digest);
  assert.equal(sha256Hex(read.pack.manifestBytes), read.pack.digest);
  assert.deepEqual(read.pack.files.map((f) => f.path), written.manifest.files.map((f) => f.path));
  for (const file of read.pack.files) {
    const bytes = await readFile(join(written.dir, file.path));
    assert.equal(file.sha256, sha256Hex(bytes));
    assert.deepEqual(Buffer.from(file.bytes), bytes);
  }
});

test('the formatting of pack.json does not change the digest; its content does', async () => {
  const written = await fresh();
  await writeManifest(written.dir, JSON.stringify(written.manifest));
  const compact = await readPackDirectory(written.dir);
  assert.ok(compact.ok);
  assert.equal(compact.pack.digest, written.digest);
  await writeManifest(written.dir, { ...written.manifest, title: '另一个标题' });
  const retitled = await readPackDirectory(written.dir);
  assert.ok(retitled.ok);
  assert.notEqual(retitled.pack.digest, written.digest);
});

test('one changed byte without signing again is refused, naming the file and the field; signed again it reads with a new digest', async () => {
  const written = await fresh();
  await corruptByte(written.dir, 'tables/titles.json', { offset: 10 });
  const read = await readPackDirectory(written.dir);
  const index = written.manifest.files.findIndex((f) => f.path === 'tables/titles.json');
  const p = has(read, 'manifest.digest_mismatch', { file: 'pack.json', field: `/files/${index}/sha256` });
  assert.match(p.message, /tables\/titles\.json/);
  const resigned = await signPack(written.dir);
  const again = await readPackDirectory(written.dir);
  assert.ok(again.ok);
  assert.equal(again.pack.digest, resigned.digest);
  assert.notEqual(resigned.digest, written.digest);
});

test('manifest tampering: size, unlisted and missing files, duplicates, order, unknown keys, pack.json listing itself', async () => {
  const written = await fresh();
  const index = written.manifest.files.findIndex((f) => f.path === 'SKILL.md');
  await writeFile(join(written.dir, 'SKILL.md'), `${await readFile(join(written.dir, 'SKILL.md'), 'utf8')}多一行\n`);
  has(await readPackDirectory(written.dir), 'manifest.size_mismatch', { field: `/files/${index}/size` });

  const second = await fresh();
  await writeFile(join(second.dir, 'tables/extra.json'), '{}');
  has(await readPackDirectory(second.dir), 'manifest.unlisted_file', { file: 'tables/extra.json' });

  const third = await fresh();
  await unlink(join(third.dir, 'functions/util.ts'));
  const missingIndex = third.manifest.files.findIndex((f) => f.path === 'functions/util.ts');
  has(await readPackDirectory(third.dir), 'manifest.missing_file', { field: `/files/${missingIndex}/path` });

  const fourth = await fresh();
  const m: WrittenManifest = fourth.manifest;
  await writeManifest(fourth.dir, { ...m, files: [...m.files, m.files[m.files.length - 1]] });
  has(await readPackDirectory(fourth.dir), 'manifest.shape', { file: 'pack.json' });
  await writeManifest(fourth.dir, { ...m, files: [...m.files].reverse() });
  has(await readPackDirectory(fourth.dir), 'manifest.shape');
  await writeManifest(fourth.dir, { ...m, owner: 'someone' });
  has(await readPackDirectory(fourth.dir), 'manifest.shape', { field: '' });
  await writeManifest(fourth.dir, { ...m, files: [{ path: 'pack.json', sha256: 'a'.repeat(64), size: 1 }, ...m.files] });
  has(await readPackDirectory(fourth.dir), 'manifest.shape');
  await writeManifest(fourth.dir, { ...m, files: m.files.filter((f) => f.path !== 'SKILL.md') });
  has(await readPackDirectory(fourth.dir), 'manifest.shape', { field: '/files' });
});

test('pack.json missing, not JSON, not UTF-8 or too large is refused', async () => {
  const written = await fresh();
  await unlink(join(written.dir, 'pack.json'));
  has(await readPackDirectory(written.dir), 'manifest.missing', { file: 'pack.json' });
  await writeFile(join(written.dir, 'pack.json'), '{ "schema": ');
  has(await readPackDirectory(written.dir), 'manifest.json');
  await writeFile(join(written.dir, 'pack.json'), Uint8Array.of(0x7b, 0xff, 0xfe, 0x7d));
  assert.match(has(await readPackDirectory(written.dir), 'manifest.json').message, /UTF-8/);
  const big = await fresh();
  has(await readPackDirectory(big.dir, { limits: { maxManifestBytes: 100 } }), 'manifest.too_large');
});

test('path traversal: manifest paths outside the pack, files in places packs do not keep files, hidden files and folders', async () => {
  const written = await fresh();
  const m = written.manifest;
  for (const path of ['../outside.json', 'functions/../../x.ts', '/etc/hosts', 'functions//a.ts', 'functions/./a.ts']) {
    await writeManifest(written.dir, { ...m, files: [...m.files, { path, sha256: 'a'.repeat(64), size: 1 }].sort((a, b) => (a.path < b.path ? -1 : 1)) });
    has(await readPackDirectory(written.dir), 'manifest.shape', { file: 'pack.json' });
  }
  const second = await fresh();
  await writeFile(join(second.dir, 'notes.txt'), 'x');
  await writeFile(join(second.dir, 'functions', '.hidden.ts'), 'x');
  await mkdir(join(second.dir, '.git'));
  await writeFile(join(second.dir, '.git', 'config'), 'x');
  await mkdir(join(second.dir, 'node_modules', 'evil'), { recursive: true });
  await writeFile(join(second.dir, 'node_modules', 'evil', 'index.js'), 'x');
  const read = await readPackDirectory(second.dir);
  has(read, 'directory.illegal_path', { file: 'notes.txt' });
  has(read, 'directory.illegal_path', { file: 'functions/.hidden.ts' });
  has(read, 'directory.illegal_dir', { file: '.git' });
  has(read, 'directory.illegal_dir', { file: 'node_modules' });
});

test('symbolic links (to a file or a folder outside) and special files are refused even when listed', async () => {
  const outside = join(temp.path, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.json'), '{"secret":true}');
  const written = await fresh();
  await symlink(join(outside, 'secret.json'), join(written.dir, 'tables', 'linked.json'));
  await signPack(written.dir);
  has(await readPackDirectory(written.dir), 'directory.symlink', { file: 'tables/linked.json' });

  const second = await fresh();
  await mkdir(join(second.dir, 'policies'));
  await symlink(outside, join(second.dir, 'policies', 'shared'));
  has(await readPackDirectory(second.dir), 'directory.symlink', { file: 'policies/shared' });

  const third = await fresh();
  // Listing the target's bytes in the manifest does not make a link acceptable.
  await unlink(join(third.dir, 'tables', 'titles.json'));
  await symlink(join(outside, 'secret.json'), join(third.dir, 'tables', 'titles.json'));
  const read = await readPackDirectory(third.dir);
  has(read, 'directory.symlink', { file: 'tables/titles.json' });
  has(read, 'manifest.missing_file');

  const fourth = await fresh();
  execFileSync('mkfifo', [join(fourth.dir, 'tables', 'pipe.json')]);
  has(await readPackDirectory(fourth.dir), 'directory.special_file', { file: 'tables/pipe.json' });
});

test('size caps: a file, the whole pack, the number of files and the depth', async () => {
  const written = await fresh();
  has(await readPackDirectory(written.dir, { limits: { maxFileBytes: 64 } }), 'directory.file_too_large');
  has(await readPackDirectory(written.dir, { limits: { maxTotalBytes: 500 } }), 'directory.too_large');
  has(await readPackDirectory(written.dir, { limits: { maxFiles: 3 } }), 'directory.too_many_files');
  const deep = await fresh();
  await mkdir(join(deep.dir, 'tables', 'a', 'b', 'c'), { recursive: true });
  await writeFile(join(deep.dir, 'tables', 'a', 'b', 'c', 'x.json'), '{}');
  await signPack(deep.dir);
  assert.ok((await readPackDirectory(deep.dir)).ok);
  has(await readPackDirectory(deep.dir, { limits: { maxDepth: 2 } }), 'directory.too_deep', { file: 'tables/a/b' });
  await assert.rejects(readPackDirectory(deep.dir, { limits: { maxFiles: 0 } }), RangeError);
});

test('a directory that does not exist, or a file instead of a directory, is refused', async () => {
  has(await readPackDirectory(join(temp.path, 'nothing-here')), 'directory.missing', { file: '.' });
  const written = await fresh();
  has(await readPackDirectory(join(written.dir, 'SKILL.md')), 'directory.missing');
});

test('pack.json with a string canonical JSON cannot hold is refused as a problem naming the field, never thrown', async () => {
  const written = await fresh();
  const text = await readFile(join(written.dir, 'pack.json'), 'utf8');
  await writeFile(join(written.dir, 'pack.json'), text.replace(`"title": "${written.manifest.title}"`, '"title": "\\ud800"'));
  const p = has(await readPackDirectory(written.dir), 'manifest.json', { file: 'pack.json', field: '/title' });
  assert.match(p.message, /代理项/);
  await writeFile(join(written.dir, 'pack.json'), text.replace(`"title": "${written.manifest.title}"`, '"title": "x", "\\udc00": 1'));
  has(await readPackDirectory(written.dir), 'manifest.json', { field: '' });
});

test('a hard link is refused like a symbolic link, also one to a file outside the pack', async () => {
  const outside = join(temp.path, 'outside-hard');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.json'), '{"secret":true}');
  const written = await fresh();
  await link(join(outside, 'secret.json'), join(written.dir, 'tables', 'linked.json'));
  await signPack(written.dir);
  const p = has(await readPackDirectory(written.dir), 'directory.hardlink', { file: 'tables/linked.json' });
  assert.match(p.fix, /复制/);
  // Two names inside the pack for one file are refused too.
  const second = await fresh();
  await link(join(second.dir, 'tables', 'titles.json'), join(second.dir, 'tables', 'copy.json'));
  await signPack(second.dir);
  const read = await readPackDirectory(second.dir);
  has(read, 'directory.hardlink', { file: 'tables/copy.json' });
  has(read, 'directory.hardlink', { file: 'tables/titles.json' });
});

/** The file the walk would have seen at `path`, for reading it after something on the way changed. */
async function seen(root: string, path: string): Promise<DiskFile> {
  const absolute = join(root, ...path.split('/'));
  const info = await lstat(absolute, { bigint: true });
  return { path, absolute, size: Number(info.size), dev: info.dev, ino: info.ino };
}

test('a directory swapped for a link to outside after the walk is not followed: the read is refused', async () => {
  const written = await fresh();
  const root = await realpath(written.dir);
  const outside = join(temp.path, 'outside-swap');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'titles.json'), '{"secret":true}');
  // What the walk saw, if `tables` had been the link already when it looked (lstat follows links on the way).
  const target = await lstat(join(outside, 'titles.json'), { bigint: true });
  await rename(join(root, 'tables'), join(root, 'tables-moved'));
  await symlink(outside, join(root, 'tables'));
  const file: DiskFile = { path: 'tables/titles.json', absolute: join(root, 'tables', 'titles.json'), size: Number(target.size), dev: target.dev, ino: target.ino };
  assert.equal(await readSeen(file, 1 << 20), 'changed');
  // The same read of an untouched file succeeds.
  const intact = await fresh();
  const bytes = await readSeen(await seen(await realpath(intact.dir), 'tables/titles.json'), 1 << 20);
  assert.ok(bytes instanceof Uint8Array);
});

test('a pipe swapped in for a listed file after the walk never blocks the read', async () => {
  const written = await fresh();
  const root = await realpath(written.dir);
  const file = await seen(root, 'tables/titles.json');
  await unlink(file.absolute);
  execFileSync('mkfifo', [file.absolute]);
  const result = await Promise.race([readSeen(file, 1 << 20), new Promise((resolve) => setTimeout(() => resolve('blocked'), 2000))]);
  // Release a reader that waits for a writer, so a failing run cannot hang the test process.
  await open(file.absolute, constants.O_WRONLY | constants.O_NONBLOCK).then((h) => h.close(), () => {});
  assert.equal(result, 'changed');
});

test('over the total or the count cap nothing is read: the pack is refused whole at once', async () => {
  const written = await fresh();
  // Large sparse files nobody may read: reading one would surface as directory.changed.
  const big = ['tables/big-1.json', 'tables/big-2.json', 'tables/big-3.json'];
  for (const path of big) {
    await writeFile(join(written.dir, path), '');
    await truncate(join(written.dir, path), 32 * 1024 * 1024);
  }
  const m = written.manifest;
  const files = [...m.files, ...big.map((path) => ({ path, sha256: '0'.repeat(64), size: 32 * 1024 * 1024 }))].sort((a, b) => (a.path < b.path ? -1 : 1));
  await writeManifest(written.dir, { ...m, files });
  for (const path of big) await chmod(join(written.dir, path), 0o000);
  try {
    const total = await readPackDirectory(written.dir, { limits: { maxTotalBytes: 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 } });
    has(total, 'directory.too_large', { file: 'pack.json' });
    assert.deepEqual(problems(total).filter((p) => p.rule !== 'directory.too_large').map((p) => p.rule), [], 'no file was read');
    const count = await readPackDirectory(written.dir, { limits: { maxFiles: files.length - 1, maxFileBytes: 64 * 1024 * 1024 } });
    has(count, 'directory.too_many_files', { file: 'pack.json' });
    assert.ok(!problems(count).some((p) => p.rule === 'directory.changed' || p.rule === 'manifest.digest_mismatch'), 'no file was read');
  } finally {
    for (const path of big) await chmod(join(written.dir, path), 0o600);
  }
});

test('mismatch messages say what the manifest declares, never the digest or size found on disk', async () => {
  const written = await fresh();
  const secret = `{"only":"on disk","pad":"${'x'.repeat(4321)}"}`;
  const size = Buffer.byteLength(secret);
  const mentions = (text: string, n: number): boolean => new RegExp(`(?<![0-9])${n}(?![0-9])`).test(text);
  await writeFile(join(written.dir, 'tables', 'titles.json'), secret);
  const sized = has(await readPackDirectory(written.dir), 'manifest.size_mismatch');
  assert.ok(!mentions(sized.message, size), sized.message);
  await signPack(written.dir);
  const index = written.manifest.files.findIndex((f) => f.path === 'tables/titles.json');
  const resigned = JSON.parse(await readFile(join(written.dir, 'pack.json'), 'utf8')) as WrittenManifest;
  await writeManifest(written.dir, { ...resigned, files: resigned.files.map((f, i) => (i === index ? { ...f, sha256: 'a'.repeat(64) } : f)) });
  const digest = has(await readPackDirectory(written.dir), 'manifest.digest_mismatch', { field: `/files/${index}/sha256` });
  assert.ok(!digest.message.includes(sha256Hex(Buffer.from(secret))), digest.message);
  const capped = has(await readPackDirectory(written.dir, { limits: { maxFileBytes: 4096 } }), 'directory.file_too_large', { file: 'tables/titles.json' });
  assert.ok(!mentions(capped.message, size), capped.message);
});

test('paths that differ only in case at some level are refused: one name on a case-insensitive volume', async () => {
  const written = await fresh();
  const m = written.manifest;
  const extra = [
    { path: 'tables/Sub/a.json', sha256: 'a'.repeat(64), size: 1 },
    { path: 'tables/sub/b.json', sha256: 'b'.repeat(64), size: 1 },
  ];
  const files = [...m.files, ...extra].sort((a, b) => (a.path < b.path ? -1 : 1));
  await writeManifest(written.dir, { ...m, files });
  const p = has(await readPackDirectory(written.dir), 'manifest.case_collision', { file: 'pack.json', field: `/files/${files.findIndex((f) => f.path === 'tables/sub/b.json')}/path` });
  assert.match(p.message, /tables\/Sub/);
  // A file and a directory whose names differ only in case collide as well.
  const other = [...m.files, { path: 'tables/x.json', sha256: 'c'.repeat(64), size: 1 }, { path: 'tables/X.json/y.json', sha256: 'd'.repeat(64), size: 1 }].sort((a, b) => (a.path < b.path ? -1 : 1));
  await writeManifest(written.dir, { ...m, files: other });
  has(await readPackDirectory(written.dir), 'manifest.case_collision');
});
