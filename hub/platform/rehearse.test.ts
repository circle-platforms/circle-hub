import assert from 'node:assert/strict';
import { access, lstat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { layoutAt } from './layout.ts';
import { runCommand, type CommandRunner } from './process.ts';
import { rehearse, treeEntries } from './rehearse.ts';
import { libpqAvailable, LIBPQ_MISSING, removeDir, tempDir } from './test-support.ts';

const libpq = await libpqAvailable();

test('rehearsal: init, write, back up, destroy, restore, compare in a throwaway root that is removed', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  try {
    const report = await rehearse({ parent, records: 60, objects: 8 });
    assert.equal(report.ok, true, report.differences.join('\n'));
    assert.deepEqual(report.differences, []);
    assert.equal(report.tables, 2);
    assert.equal(report.rows, 60 + 20, '60 records and an index row for every third');
    assert.equal(report.objects, 8);
    assert.equal(report.vaultFiles, 3);
    // A verified tree, one in quarantine and one still being built: two, two and one file.
    assert.equal(report.packFiles, 5);
    assert.equal(report.role, 'circle_hub');
    // CONNECT, USAGE on public, EXECUTE of the trigger function, SELECT and INSERT on both tables.
    assert.equal(report.privileges, 7);
    // Per table: DELETE, TRUNCATE, DROP, ADD COLUMN, DISABLE TRIGGER; and one CREATE TABLE.
    assert.equal(report.refused, 11);
    assert.equal(report.kept, false);
    assert.ok(report.root.startsWith(parent));
    await assert.rejects(access(report.root), 'the throwaway root is gone, read-only pack trees and all');
  } finally {
    await removeDir(parent);
  }
});

test('rehearsal reports extracted pack trees that changed between the backup and the restore', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  try {
    // While pg_restore runs, something drops a file into packs/ of the throwaway root (named by the socket directory).
    const runner: CommandRunner = async (command, args, options) => {
      const result = await runCommand(command, args, options);
      const host = args.find((arg) => arg.startsWith('--host='));
      if (basename(command) === 'pg_restore' && args.includes('--single-transaction') && host) {
        await writeFile(join(dirname(host.slice('--host='.length)), 'packs', 'planted'), 'not from the registry', { mode: 0o600 });
      }
      return result;
    };
    const report = await rehearse({ parent, records: 3, objects: 1, runner });
    assert.equal(report.ok, false);
    assert.deepEqual(report.differences, ['解包目录多了 planted']);
    await assert.rejects(access(report.root), 'removed all the same');
  } finally {
    await removeDir(parent);
  }
});

test('rehearsal can keep its root for inspection, extracted pack trees still read-only and outside the backup', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  try {
    const report = await rehearse({ parent, records: 3, objects: 1, keep: true });
    assert.equal(report.ok, true, report.differences.join('\n'));
    await access(report.backup);
    const layout = layoutAt(report.root);
    const entries = await treeEntries(layout.packs);
    const trees = [...entries].filter(([path, entry]) => !path.startsWith('.') && !path.includes('/') && entry.startsWith('目录'));
    assert.equal(trees.length, 1);
    assert.equal(trees[0]![1], '目录 0500');
    assert.ok([...entries.keys()].some((path) => path.startsWith('.quarantine/')));
    assert.ok([...entries.keys()].some((path) => path.startsWith('.tmp-')));
    await assert.rejects(lstat(join(report.backup, 'packs')), /ENOENT/);
  } finally {
    await removeDir(parent);
  }
});
