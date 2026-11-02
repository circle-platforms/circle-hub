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
  },
  {
    "version": 6,
    "name": "call_reasons",
    "sha256": "c97e6d42f43ad8b9cb977122d37b744ab83dd344aa720f7c05f9a6079f55f895"
  },
  {
    "version": 7,
    "name": "standard_authorization",
    "sha256": "54268ed191e63bcd5bc9faab8ef0b1dd853d2460d50b341f805d46a75d4a9c92"
  }
, {"version":8,"name":"console_passwords","sha256":"62d4b17a5d48e35c8a65349293f6b7c7bc842b9e456b715f0489ea04de1b6f8f"}
];

test('the applied migration source file keeps its reviewed bytes', () => {
  // An append requires reviewing this file digest; the per-migration SQL snapshots below stay fixed.
  const bytes = readFileSync(new URL('./migrations.ts', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'ee4b209cb49b7d9f52f17fc42893b3b15c901a6939c3dfae961ff1b659a1410f');
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
