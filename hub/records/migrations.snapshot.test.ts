// Freeze the applied baseline; future migrations append and preserve every existing SQL digest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MIGRATIONS, migrationChecksum } from './migrations.ts';

const APPLIED = [
  { version: 1, name: 'baseline', sha256: '95e22210e2340c8898e0eda032870c00b449edbd082ac0c7ad141c7d54931e27' },
  { version: 2, name: 'environment_assignment_cutover', sha256: '4ee84ee09eb8e363264be2bf358eb9a6994c185a4f37ab18371e949974fd49b9' },
];

test('the applied migration source file keeps its reviewed bytes', () => {
  // An append requires reviewing this file digest; the per-migration SQL snapshots below stay fixed.
  const bytes = readFileSync(new URL('./migrations.ts', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '82ef11650440f751a4d603101cddd407bf6b25f6e765f5714fdad9eb3ba6dc45');
});

test('every applied SQL migration retains its identity and exact bytes', () => {
  for (const frozen of APPLIED) {
    const migration = MIGRATIONS.find(m => m.version === frozen.version);
    assert.ok(migration, 'an applied migration cannot disappear');
    assert.equal(migration.name, frozen.name);
    assert.equal(migrationChecksum(migration), frozen.sha256);
    assert.notEqual(migrationChecksum({ ...migration, sql: migration.sql + '\n-- changed' }), frozen.sha256);
  }
});
