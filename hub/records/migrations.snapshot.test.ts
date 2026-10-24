// Freeze the applied baseline; future migrations append and preserve every existing SQL digest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MIGRATIONS, migrationChecksum } from './migrations.ts';

const APPLIED = [
  {
    "version": 1,
    "name": "records",
    "sha256": "a4eaed1871bad919990538adb5bf4b3abb2af20ed2b347c745df84981f95ebb0"
  },
  {
    "version": 2,
    "name": "leases",
    "sha256": "fe77184d95212c1d0ba2291028aeeec2de36ce54c362bafee2859d173046aa3d"
  },
  {
    "version": 3,
    "name": "record_keys",
    "sha256": "309e57b14819d63582f79e6389b927d0963321295349ff24c502065aab375f95"
  },
  {
    "version": 4,
    "name": "unbounded_leases",
    "sha256": "a4f5df47218a6ee345b197427397960f2c6f56a8b4cc14d52be53fdefa724d03"
  },
  {
    "version": 5,
    "name": "lease_registrations",
    "sha256": "c767dbfba4950fd0285202406e24f878ba78fc92d5c4d8b0f65ec01922fd5d54"
  }
];

test('the applied migration source file keeps its reviewed bytes', () => {
  // An append requires reviewing this file digest; the per-migration SQL snapshots below stay fixed.
  const bytes = readFileSync(new URL('./migrations.ts', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '65d31fa110adf62754f9820d51501754f72683af0cb4fa3245872d7603a432ce');
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
