import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateMigrationCompatibility, previewMigrationCompatibility, type MigrationCompatibilityDeclaration, type MigrationCompatibilityObservation } from './migration-compatibility.ts';

const baseline = { version: 1, name: 'baseline', sha256: 'a'.repeat(64) };
const next = { version: 2, name: 'synthetic_addition', sha256: 'b'.repeat(64) };
const declaration: MigrationCompatibilityDeclaration = { migration_version: 2, format_version: 1, migration_name: next.name, migration_sha256: next.sha256, minimum_reader_level: 2 };
const observed = (overrides: Partial<MigrationCompatibilityObservation> = {}): MigrationCompatibilityObservation => ({ available: true, applied: [baseline, next], declarations: [declaration], declarationsReadOnly: true, ...overrides });

test('matching known receipts stay strict without a declaration carrier', () => {
  const result = evaluateMigrationCompatibility([baseline], observed({ applied: [baseline], declarations: null, declarationsReadOnly: null }), 1);
  assert.equal(result.status, 'compatible'); assert.equal(result.effectiveFloor, null);
  assert.deepEqual(result.acceptedUnknown, []);
  for (const field of ['name', 'sha256'] as const) {
    const changed = { ...baseline, [field]: 'changed' };
    assert.equal(evaluateMigrationCompatibility([baseline], observed({ applied: [changed], declarations: null }), 2).status, 'incompatible');
  }
  for (const applied of [null, [], [next]]) assert.equal(evaluateMigrationCompatibility([baseline], observed({ applied }), 2).status, 'incompatible');
});

test('unknown migration requires an exact declaration and sufficient safety capability', () => {
  const accepted = evaluateMigrationCompatibility([baseline], observed(), 2);
  assert.equal(accepted.status, 'compatible'); assert.equal(accepted.effectiveFloor, 2);
  assert.deepEqual(accepted.acceptedUnknown, [next]);
  assert.equal(evaluateMigrationCompatibility([baseline], observed(), 1).status, 'incompatible');
  assert.equal(evaluateMigrationCompatibility([baseline, next], observed(), 1).status, 'incompatible');
  for (const declarations of [null, [], [declaration, declaration]]) assert.equal(evaluateMigrationCompatibility([baseline], observed({ declarations }), 2).status, 'incompatible');
  for (const wrong of [
    { ...declaration, migration_version: 3 }, { ...declaration, migration_name: 'other' },
    { ...declaration, migration_sha256: 'c'.repeat(64) }, { ...declaration, format_version: 2 },
    { ...declaration, minimum_reader_level: 0 }, { ...declaration, minimum_reader_level: 2.5 },
  ]) assert.equal(evaluateMigrationCompatibility([baseline], observed({ declarations: [wrong] }), 10).status, 'incompatible');
});

test('declarations never excuse known corruption, gaps or untrusted metadata', () => {
  assert.equal(evaluateMigrationCompatibility([baseline], observed({ applied: [{ ...baseline, sha256: 'c'.repeat(64) }, next] }), 2).status, 'incompatible');
  for (const applied of [[baseline, baseline, next], [next, baseline], [baseline, { ...next, version: 3 }]]) {
    assert.equal(evaluateMigrationCompatibility([baseline], observed({ applied }), 2).status, 'incompatible');
  }
  assert.equal(evaluateMigrationCompatibility([baseline], observed({ declarationsReadOnly: false }), 2).status, 'incompatible');
  const unknown = evaluateMigrationCompatibility([baseline], observed({ available: false }), 2);
  assert.equal(unknown.status, 'unavailable'); assert.equal(unknown.compatible, null); assert.equal(unknown.applied, null);
  assert.deepEqual(unknown.acceptedUnknown, []);
});

test('every unknown receipt must be covered and the maximum floor applies', () => {
  const third = { version: 3, name: 'synthetic_restriction', sha256: 'd'.repeat(64) };
  const state = observed({ applied: [baseline, next, third], declarations: [declaration, { ...declaration, migration_version: 3, migration_name: third.name, migration_sha256: third.sha256, minimum_reader_level: 3 }] });
  assert.equal(evaluateMigrationCompatibility([baseline], state, 2).status, 'incompatible');
  const result = evaluateMigrationCompatibility([baseline], state, 3);
  assert.equal(result.effectiveFloor, 3); assert.deepEqual(result.acceptedUnknown, [next, third]);
  assert.equal(evaluateMigrationCompatibility([baseline], { ...state, declarations: [declaration] }, 3).status, 'incompatible');
});

test('preview is a pure projection, not preservation completion or a downgrade promise', () => {
  const input = observed(); const before = JSON.stringify(input);
  assert.deepEqual(previewMigrationCompatibility([baseline], input, 2), evaluateMigrationCompatibility([baseline], input, 2));
  assert.equal(previewMigrationCompatibility([baseline], input, 1).compatible, false);
  assert.equal(JSON.stringify(input), before);
  const result = previewMigrationCompatibility([baseline], input, 2);
  assert.equal('preservationCompleted' in result, false); assert.equal('canDowngrade' in result, false);
  for (const level of [0, -1, 1.1, NaN, Infinity]) assert.throws(() => previewMigrationCompatibility([baseline], input, level), TypeError);
});
