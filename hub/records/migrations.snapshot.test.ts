// Freeze the applied baseline; future migrations append and preserve every existing SQL digest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MIGRATIONS, migrationChecksum } from './migrations.ts';

const APPLIED = [
  { version: 1, name: 'baseline', sha256: '95e22210e2340c8898e0eda032870c00b449edbd082ac0c7ad141c7d54931e27' },
  { version: 2, name: 'external_member_identities', sha256: '5b7691464e3116b4876e874e06d5b2c3c6eb7ff94c2dca04dfc327b8748fe049' },
  { version: 3, name: 'token_scope', sha256: 'bdbcede0468911370e604fd95d44beeef2e29bc10462cbf09718ba587e892c89' },
];

test('the applied migration source file keeps its reviewed bytes', () => {
  // An append requires reviewing this file digest; the per-migration SQL snapshots below stay fixed.
  const bytes = readFileSync(new URL('./migrations.ts', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'c3e63bc4765828d4e64b7dd04dfbafd8a1f959b6aa3b3fa8e377b101f2f7d6b4');
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
