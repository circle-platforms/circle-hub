import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { canonicalBytes, IntegrityError, sha256Hex } from '../../records/api.ts';
import { callPackFunction } from '../../rules/api.ts';
import { readPackDirectory } from './directory.ts';
import { Extractor, moveReadOnlyDirectory, type ExtractionSource, type TamperEvent } from './extract.ts';
import { corruptByte, temporaryDirectory, withFiles, workflowPack, writePack } from './testing/builder.ts';
import type { PackDirectory } from './types.ts';

let temp: { path: string; remove: () => Promise<void> };
let n = 0;
before(async () => {
  temp = await temporaryDirectory();
});
after(() => temp?.remove());

interface Fixture {
  pack: PackDirectory;
  source: () => Promise<ExtractionSource>;
  reads: { count: number };
  loads: { count: number };
}

async function fixture(): Promise<Fixture> {
  const written = await writePack(join(temp.path, `src${++n}`), workflowPack({ title: `合成评审 ${n}` }));
  const read = await readPackDirectory(written.dir);
  assert.ok(read.ok);
  const bytes = new Map(read.pack.files.map((f) => [f.sha256, f.bytes]));
  const reads = { count: 0 };
  const loads = { count: 0 };
  return {
    pack: read.pack,
    reads,
    loads,
    source: async () => {
      loads.count += 1;
      return {
        manifest: read.pack.manifest,
        read: async (sha) => {
          reads.count += 1;
          return bytes.get(sha) ?? null;
        },
      };
    },
  };
}

function extractor(events: TamperEvent[] = [], root = join(temp.path, `x${++n}`)): Extractor {
  return new Extractor({ root, onTamper: (e) => events.push(e) });
}

const mode = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777;

test('extraction writes a read-only tree at <root>/<digest> whose pack.json is the canonical manifest', async () => {
  const f = await fixture();
  const x = extractor();
  const { directory, bytes } = await x.extract(f.pack.digest, f.source);
  assert.equal(directory, join(x.root, f.pack.digest));
  assert.equal(await mode(directory), 0o500);
  for (const file of f.pack.manifest.files) {
    assert.equal(await mode(join(directory, file.path)), 0o400, file.path);
    assert.equal(sha256Hex(await readFile(join(directory, file.path))), file.sha256);
    assert.equal(sha256Hex(bytes.get(file.path) as Uint8Array), file.sha256);
  }
  for (const folder of ['functions', 'tables', 'samples', 'samples/positive']) assert.equal(await mode(join(directory, folder)), 0o500, folder);
  const manifestBytes = await readFile(join(directory, 'pack.json'));
  assert.equal(sha256Hex(manifestBytes), f.pack.digest);
  assert.deepEqual(manifestBytes, Buffer.from(canonicalBytes(f.pack.manifest)));
  await assert.rejects(writeFile(join(directory, 'SKILL.md'), 'changed'), { code: 'EACCES' });
  await assert.rejects(writeFile(join(directory, 'new.json'), '{}'), { code: 'EACCES' });
  await assert.rejects(unlink(join(directory, 'tables', 'titles.json')), { code: 'EACCES' });
  assert.deepEqual((await readdir(x.root)).filter((name) => name.startsWith('.tmp-')), [], 'no temporary directory is left');
});

test('a reused tree is verified every time; one changed byte is detected, set aside and rebuilt from the objects', async () => {
  const f = await fixture();
  const events: TamperEvent[] = [];
  const x = extractor(events);
  const { directory } = await x.extract(f.pack.digest, f.source);
  const builtReads = f.reads.count;
  await x.extract(f.pack.digest, f.source);
  assert.equal(f.reads.count, builtReads, 'an intact tree is not rebuilt');
  assert.equal(f.loads.count, 2, 'but its manifest is consulted to verify it');

  await corruptByte(directory, 'tables/titles.json', { offset: 3 });
  const again = await x.extract(f.pack.digest, f.source);
  assert.equal(again.directory, directory);
  assert.equal(events.length, 1);
  assert.ok(events[0].problems.some((p) => p.includes('tables/titles.json')), JSON.stringify(events[0].problems));
  assert.ok(events[0].quarantine !== null && events[0].quarantine.startsWith(join(x.root, '.quarantine')));
  assert.ok(f.reads.count > builtReads, 'rebuilt from the objects');
  const titles = f.pack.manifest.files.find((file) => file.path === 'tables/titles.json');
  assert.equal(sha256Hex(await readFile(join(directory, 'tables/titles.json'))), titles?.sha256);
  // The tampered copy is kept for inspection.
  const kept = await readFile(join(events[0].quarantine as string, 'tables/titles.json'));
  assert.notEqual(sha256Hex(kept), titles?.sha256);
});

test('an extra file, a changed mode, a link in place of a file and a missing file are each detected', async () => {
  const tamperings: [string, (dir: string) => Promise<void>, RegExp][] = [
    ['extra file', async (dir) => {
      await chmod(join(dir, 'tables'), 0o700);
      await writeFile(join(dir, 'tables', 'extra.json'), '{}');
      await chmod(join(dir, 'tables'), 0o500);
    }, /多出了文件 tables\/extra\.json/],
    ['writable file', (dir) => chmod(join(dir, 'SKILL.md'), 0o600), /SKILL\.md 的权限是 0600/],
    ['writable root', (dir) => chmod(dir, 0o700), /（包根） 的权限是 0700/],
    ['link', async (dir) => {
      await chmod(join(dir, 'functions'), 0o700);
      await unlink(join(dir, 'functions', 'util.ts'));
      await symlink('/etc/hosts', join(dir, 'functions', 'util.ts'));
      await chmod(join(dir, 'functions'), 0o500);
    }, /functions\/util\.ts 是符号链接/],
    ['missing file', async (dir) => {
      await chmod(join(dir, 'functions'), 0o700);
      await unlink(join(dir, 'functions', 'util.ts'));
      await chmod(join(dir, 'functions'), 0o500);
    }, /缺少文件 functions\/util\.ts/],
  ];
  for (const [what, tamper, expected] of tamperings) {
    const f = await fixture();
    const events: TamperEvent[] = [];
    const x = extractor(events);
    const { directory } = await x.extract(f.pack.digest, f.source);
    await tamper(directory);
    await x.extract(f.pack.digest, f.source);
    assert.equal(events.length, 1, what);
    assert.ok(events[0].problems.some((p) => expected.test(p)), `${what}: ${JSON.stringify(events[0].problems)}`);
    assert.equal(await mode(directory), 0o500, `${what}: rebuilt read-only`);
  }
});

test('concurrent extractions of one digest share one build, and two extractors racing on one root agree', async () => {
  const f = await fixture();
  const x = extractor();
  const results = await Promise.all(Array.from({ length: 20 }, () => x.extract(f.pack.digest, f.source)));
  assert.equal(new Set(results.map((r) => r.directory)).size, 1);
  assert.equal(f.loads.count, 1, 'one build for all of them');
  assert.equal(f.reads.count, f.pack.manifest.files.length);

  const g = await fixture();
  const root = join(temp.path, `shared${++n}`);
  const a = extractor([], root);
  const b = extractor([], root);
  const raced = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? a : b).extract(g.pack.digest, g.source)));
  assert.equal(new Set(raced.map((r) => r.directory)).size, 1);
  for (const r of raced) assert.equal(r.bytes.size, g.pack.manifest.files.length + 1);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.tmp-')), [], 'the losers removed their temporary trees');
  assert.deepEqual((await readdir(root)).filter((name) => !name.startsWith('.')), [g.pack.digest]);
});

test('a manifest that does not hash to the digest and objects that are missing or altered are integrity failures', async () => {
  const f = await fixture();
  const x = extractor();
  const other = await fixture();
  await assert.rejects(x.extract(f.pack.digest, other.source), IntegrityError);
  const missing = async (): Promise<ExtractionSource> => ({ manifest: f.pack.manifest, read: async () => null });
  await assert.rejects(x.extract(f.pack.digest, missing), IntegrityError);
  const altered = async (): Promise<ExtractionSource> => ({ manifest: f.pack.manifest, read: async () => new TextEncoder().encode('not the file') });
  await assert.rejects(x.extract(f.pack.digest, altered), IntegrityError);
  assert.throws(() => x.directoryOf('../../etc'), TypeError);
  assert.throws(() => new Extractor({ root: 'relative/dir' }), TypeError);
});

test('a staged tree is promoted into place or discarded; an existing tree wins over a staged one', async () => {
  const f = await fixture();
  const x = extractor();
  const files = f.pack.files.map((file) => ({ path: file.path, bytes: file.bytes }));
  const discarded = await x.stage(f.pack.digest, f.pack.manifestBytes, files);
  assert.equal(await mode(discarded.directory), 0o500);
  await discarded.discard();
  await assert.rejects(lstat(discarded.directory), { code: 'ENOENT' });
  const promoted = await x.stage(f.pack.digest, f.pack.manifestBytes, files);
  assert.equal(await promoted.promote(), join(x.root, f.pack.digest));
  await assert.rejects(lstat(promoted.directory), { code: 'ENOENT' });
  const late = await x.stage(f.pack.digest, f.pack.manifestBytes, files);
  assert.equal(await late.promote(), join(x.root, f.pack.digest));
  await assert.rejects(lstat(late.directory), { code: 'ENOENT' }, 'the staged copy is removed when the place is taken');
  assert.equal((await x.extract(f.pack.digest, f.source)).directory, join(x.root, f.pack.digest));
  await assert.rejects(x.stage(f.pack.digest, new TextEncoder().encode('{}'), files), TypeError);
});

test('a pack function runs from the extracted directory, and nothing it does can write there', async () => {
  const written = await writePack(
    join(temp.path, `fn${++n}`),
    withFiles(workflowPack(), {
      'functions/probe.ts': [
        "import table from '../tables/titles.json' with { type: 'json' };",
        'export default function probe(_input: unknown): unknown {',
        '  let wrote = false;',
        '  try {',
        "    const fs = process.getBuiltinModule('node:fs') as { writeFileSync(p: string, d: string): void };",
        "    fs.writeFileSync('functions/probe.ts', 'x');",
        '    wrote = true;',
        '  } catch {',
        '    wrote = false;',
        '  }',
        '  return { schema: table.schema, wrote };',
        '}',
        '',
      ].join('\n'),
    }),
  );
  const read = await readPackDirectory(written.dir);
  assert.ok(read.ok);
  const x = extractor();
  const bytes = new Map(read.pack.files.map((file) => [file.sha256, file.bytes]));
  const { directory } = await x.extract(read.pack.digest, async () => ({ manifest: read.pack.manifest, read: async (sha) => bytes.get(sha) ?? null }));
  // The sandbox refuses node:fs outright: the attempt fails the call instead of writing.
  await assert.rejects(callPackFunction({ packDir: directory, module: 'functions/probe.ts' }, null, {}, { requireOsIsolation: false }), { code: 'IMPORT_NOT_DECLARED' });
  assert.equal(sha256Hex(await readFile(join(directory, 'functions/probe.ts'))), read.pack.files.find((file) => file.path === 'functions/probe.ts')?.sha256);
  const ok = await callPackFunction({ packDir: directory, module: 'functions/project.ts' }, { inputs: [] }, {}, { requireOsIsolation: false });
  assert.deepEqual(ok.output, { items: [], warnings: [] });
  await rm(join(temp.path, `fn${n}`), { recursive: true, force: true });
});

// macOS 15 refuses to rename a directory without write permission; Linux and macOS 26 allow it.
const macos15Rename = async (from: string, to: string): Promise<void> => {
  if (((await lstat(from)).mode & 0o200) === 0) throw Object.assign(new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`), { code: 'EACCES' });
  await rename(from, to);
};

test('a read-only tree reaches its place where the system refuses to rename a read-only directory, and stays read-only', async () => {
  const root = join(temp.path, `mv${++n}`);
  await mkdir(join(root, 'from', 'sub'), { recursive: true });
  await writeFile(join(root, 'from', 'sub', 'f'), 'x');
  await chmod(join(root, 'from', 'sub'), 0o500);
  await chmod(join(root, 'from'), 0o500);
  await moveReadOnlyDirectory(join(root, 'from'), join(root, 'to'), macos15Rename);
  assert.equal(await mode(join(root, 'to')), 0o500);
  assert.equal(await mode(join(root, 'to', 'sub')), 0o500);
  assert.equal(await readFile(join(root, 'to', 'sub', 'f'), 'utf8'), 'x');
  await assert.rejects(lstat(join(root, 'from')), { code: 'ENOENT' });
});

test('a refused rename onto a tree already in place is the lost race: rethrown, the existing tree untouched', async () => {
  const root = join(temp.path, `mv${++n}`);
  await mkdir(join(root, 'from'), { recursive: true });
  await mkdir(join(root, 'to'), { recursive: true });
  await chmod(join(root, 'from'), 0o500);
  await chmod(join(root, 'to'), 0o500);
  await assert.rejects(moveReadOnlyDirectory(join(root, 'from'), join(root, 'to'), macos15Rename), { code: 'EACCES' });
  assert.equal(await mode(join(root, 'from')), 0o500);
  assert.equal(await mode(join(root, 'to')), 0o500);
});
