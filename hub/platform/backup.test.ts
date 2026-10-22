import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import {
  BACKUP_SCHEMA,
  backupPath,
  checkToolMajor,
  DUMP_FILE,
  FILE_AREAS,
  isTransientName,
  libpqDirectory,
  libpqTools,
  listBackups,
  MANIFEST_FILE,
  pruneBackups,
  verifyBackup,
  type BackupManifest,
} from './backup.ts';
import { ensureLayout, layoutAt, type Layout } from './layout.ts';
import { ok, recordingRunner, removeDir, tempDir } from './test-support.ts';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

async function scratchLayout(): Promise<Layout> {
  const root = await tempDir();
  roots.push(root);
  const layout = layoutAt(root);
  await ensureLayout(layout);
  return layout;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** A synthetic backup directory: files written as given, manifest listing `listed` (defaults to the files). */
async function syntheticBackup(dir: string, files: Record<string, string>, edit: (manifest: BackupManifest) => void = () => {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  const manifest: BackupManifest = {
    schema: BACKUP_SCHEMA,
    created_at: '2026-10-21T12:00:00.000Z',
    database: {
      name: 'circle_hub',
      server_version: '18.4',
      dump_tool: 'pg_dump (PostgreSQL) 18.6',
      tables: [],
      application_role: { name: 'circle_hub', privileges: ['database CONNECT', 'schema public USAGE'] },
    },
    files: Object.entries(files)
      .map(([path, text]) => ({ path, size: Buffer.byteLength(text), sha256: sha(text) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  edit(manifest);
  await writeFile(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
}

const goodFiles = { [DUMP_FILE]: 'PGDMP synthetic', 'objects/ab/abcdef': 'object bytes', 'vault/entry-0.bin': 'sealed', 'config/platform.json': '{}' };

test('a complete backup verifies', async () => {
  const layout = await scratchLayout();
  const dir = join(layout.backups, '20261021T120000Z');
  await syntheticBackup(dir, goodFiles);
  const manifest = await verifyBackup(dir);
  assert.equal(manifest.files.length, 4);
});

test('a changed, missing or extra file fails verification', async () => {
  const layout = await scratchLayout();
  const changed = join(layout.backups, 'changed');
  await syntheticBackup(changed, goodFiles);
  await writeFile(join(changed, 'objects/ab/abcdef'), 'object bytez');
  await assert.rejects(verifyBackup(changed), /objects\/ab\/abcdef 的 SHA-256 或大小与清单不符/);

  const missing = join(layout.backups, 'missing');
  await syntheticBackup(missing, goodFiles, (manifest) => {
    manifest.files.push({ path: 'vault/entry-1.bin', size: 1, sha256: sha('x') });
  });
  await assert.rejects(verifyBackup(missing), /缺少文件 vault\/entry-1\.bin/);

  const extra = join(layout.backups, 'extra');
  await syntheticBackup(extra, goodFiles);
  await writeFile(join(extra, 'objects', 'planted'), 'not listed');
  await assert.rejects(verifyBackup(extra), /多出文件 objects\/planted/);
});

test('Finder and AppleDouble metadata do not make a good backup unusable; other extra files still do', async () => {
  const layout = await scratchLayout();
  const dir = join(layout.backups, 'opened-in-finder');
  await syntheticBackup(dir, goodFiles);
  await writeFile(join(dir, '.DS_Store'), 'finder');
  await writeFile(join(dir, 'objects', '.DS_Store'), 'finder');
  await writeFile(join(dir, 'objects', 'ab', '._abcdef'), 'appledouble');
  await writeFile(join(dir, `._${DUMP_FILE}`), 'appledouble');
  assert.equal((await verifyBackup(dir)).files.length, 4);
  await writeFile(join(dir, 'objects', '.planted'), 'not metadata');
  await assert.rejects(verifyBackup(dir), /多出文件 objects\/\.planted/);
});

test('a manifest of an earlier format is refused with a hint, not as damaged', async () => {
  const layout = await scratchLayout();
  for (const [schema, reason] of [
    ['circle-hub-backup@1', /表摘要的算法不同/],
    ['circle-hub-backup@2', /那时 Hub 数据库和表属于应用角色，清单里也没有应用角色的权限/],
  ] as const) {
    const dir = join(layout.backups, `old-format-${schema.at(-1)}`);
    await syntheticBackup(dir, goodFiles, (manifest) => {
      (manifest as { schema: string }).schema = schema;
      delete (manifest.database as { application_role?: unknown }).application_role;
    });
    await assert.rejects(verifyBackup(dir), (error: unknown) => {
      assert.match((error as Error).message, new RegExp(`旧格式 ${schema}`));
      assert.match((error as Error).message, reason);
      assert.match(String((error as { hint?: string }).hint), /用生成它的那一版 circle-hub 恢复/);
      return true;
    });
  }
});

test('a manifest without the application role privileges is not a current backup', async () => {
  const layout = await scratchLayout();
  const dir = join(layout.backups, 'no-role');
  await syntheticBackup(dir, goodFiles, (manifest) => delete (manifest.database as { application_role?: unknown }).application_role);
  await assert.rejects(verifyBackup(dir), /不符合 circle-hub-backup@3/);
});

test('extracted pack trees are derived data: no backup area holds them, and a manifest that lists them is refused', async () => {
  assert.ok(!(FILE_AREAS as readonly string[]).includes('packs'));
  const layout = await scratchLayout();
  assert.equal(layout.packs, join(layout.root, 'packs'));
  const dir = join(layout.backups, 'with-packs');
  await syntheticBackup(dir, { ...goodFiles, 'packs/0123/pack.json': '{}' });
  await assert.rejects(verifyBackup(dir), /备份清单里有不允许的路径：packs\/0123\/pack\.json/);
});

test('names of in-flight temporaries and metadata are never part of a backup', () => {
  for (const name of ['.0123abcd.89ab.tmp', 'entry.sealed.0123456789abcdef.tmp', '.DS_Store', '._abcdef']) assert.equal(isTransientName(name), true, name);
  for (const name of ['0'.repeat(64), 'entry.sealed', 'key-check', 'platform.json']) assert.equal(isTransientName(name), false, name);
});

test('backups are recorded by name and resolved in the data root they are used in', async () => {
  const layout = await scratchLayout();
  assert.equal(backupPath(layout, '20261021T120000Z-pre-deploy'), join(layout.backups, '20261021T120000Z-pre-deploy'));
  assert.equal(backupPath(layout, '/old/root/backups/20261021T120000Z-pre-deploy'), join(layout.backups, '20261021T120000Z-pre-deploy'), 'older records held an absolute path');
  assert.throws(() => backupPath(layout, '.partial-x'), /备份名不合法/);
  assert.throws(() => backupPath(layout, ''), /备份名不合法/);
});

test('manifests with unsafe paths, duplicates, no dump or a foreign schema are refused', async () => {
  const layout = await scratchLayout();
  const cases: [string, (manifest: BackupManifest) => void, RegExp][] = [
    ['escape', (m) => m.files.push({ path: 'objects/../../etc/passwd', size: 1, sha256: sha('x') }), /不允许的路径/],
    ['absolute', (m) => m.files.push({ path: '/etc/passwd', size: 1, sha256: sha('x') }), /不允许的路径/],
    ['other-area', (m) => m.files.push({ path: 'releases/x', size: 1, sha256: sha('x') }), /不允许的路径/],
    ['duplicate', (m) => m.files.push({ ...m.files[0]! }), /路径重复/],
    ['no-dump', (m) => (m.files = m.files.filter((file) => file.path !== DUMP_FILE)), /没有 database\.dump/],
    ['schema', (m) => ((m as { schema: string }).schema = 'other@1'), /不符合/],
  ];
  for (const [name, edit, expected] of cases) {
    const dir = join(layout.backups, name);
    await syntheticBackup(dir, goodFiles, edit);
    await assert.rejects(verifyBackup(dir), expected, name);
  }
  await mkdir(join(layout.backups, 'no-manifest'));
  await assert.rejects(verifyBackup(join(layout.backups, 'no-manifest')), /读不了备份清单/);
});

test('listBackups ignores partial directories; prune keeps the newest and the protected ones', async () => {
  const layout = await scratchLayout();
  const names = ['20261001T000000Z', '20261002T000000Z-pre-deploy', '20261003T000000Z', '20261004T000000Z'];
  for (const name of names) await syntheticBackup(join(layout.backups, name), goodFiles);
  await mkdir(join(layout.backups, '.partial-20261005T000000Z-ab12'));
  assert.deepEqual(
    (await listBackups(layout)).map((dir) => dir.slice(layout.backups.length + 1)),
    names,
  );
  // Protected by name, as deployments.jsonl records it, and by an absolute path of another location of the root.
  const removed = await pruneBackups(layout, 1, [names[1]!, join('/moved/root/backups', names[2]!)]);
  assert.deepEqual(
    removed.map((dir) => dir.slice(layout.backups.length + 1)),
    [names[0]],
  );
  assert.deepEqual(
    (await listBackups(layout)).map((dir) => dir.slice(layout.backups.length + 1)),
    names.slice(1),
  );
  await assert.rejects(pruneBackups(layout, 0), /正整数/);
});

test('backups are ordered by when they were taken, not by name: within one second a labelled one may be older', async () => {
  const layout = await scratchLayout();
  const taken = (iso: string) => (manifest: BackupManifest) => {
    manifest.created_at = iso;
  };
  await syntheticBackup(join(layout.backups, '20261021T203602Z-integration'), goodFiles, taken('2026-10-21T20:36:02.100Z'));
  await syntheticBackup(join(layout.backups, '20261021T203602Z'), goodFiles, taken('2026-10-21T20:36:02.200Z'));
  await syntheticBackup(join(layout.backups, '20261021T203602Z-again'), goodFiles, taken('2026-10-21T20:36:02.300Z'));
  // A manifest that cannot be read is placed by the time its name starts with.
  await mkdir(join(layout.backups, '20261021T203601Z-damaged'));
  await writeFile(join(layout.backups, '20261021T203601Z-damaged', MANIFEST_FILE), '{not json');
  const names = async () => (await listBackups(layout)).map((dir) => basename(dir));
  assert.deepEqual(await names(), ['20261021T203601Z-damaged', '20261021T203602Z-integration', '20261021T203602Z', '20261021T203602Z-again']);
  assert.deepEqual(
    (await pruneBackups(layout, 2)).map((dir) => basename(dir)),
    ['20261021T203601Z-damaged', '20261021T203602Z-integration'],
    'the newest two are kept',
  );
  assert.deepEqual(await names(), ['20261021T203602Z', '20261021T203602Z-again']);
});

test('libpq tools are found by absolute path or refused with the install hint; majors must match', async () => {
  assert.equal(libpqDirectory(undefined, {}), '/opt/homebrew/opt/libpq/bin');
  assert.equal(libpqDirectory(undefined, { CIRCLE_HUB_LIBPQ_BIN: '/usr/lib/postgresql/18/bin' }), '/usr/lib/postgresql/18/bin');
  assert.throws(() => libpqDirectory(undefined, { CIRCLE_HUB_LIBPQ_BIN: 'relative/bin' }), /绝对路径/);
  const empty = await tempDir();
  roots.push(empty);
  await assert.rejects(libpqTools(empty), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /找不到 .*pg_dump/);
    assert.match(String((error as { hint?: string }).hint), /brew install libpq/);
    return true;
  });
  const { runner } = recordingRunner(() => ok('pg_dump (PostgreSQL) 17.2\n'), { real: false });
  await assert.rejects(checkToolMajor('/fake/pg_dump', 18, runner), /PostgreSQL 17，数据库是 PostgreSQL 18/);
  assert.equal(await checkToolMajor('/fake/pg_dump', 17, runner), 'pg_dump (PostgreSQL) 17.2');
});
