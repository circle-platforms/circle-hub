import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { rehearse } from './rehearse.ts';
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
    assert.equal(report.kept, false);
    assert.ok(report.root.startsWith(parent));
    await assert.rejects(access(report.root), 'the throwaway root is gone');
  } finally {
    await removeDir(parent);
  }
});

test('rehearsal can keep its root for inspection', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
  const parent = await tempDir();
  try {
    const report = await rehearse({ parent, records: 3, objects: 1, keep: true });
    assert.equal(report.ok, true);
    await access(report.backup);
  } finally {
    await removeDir(parent);
  }
});
