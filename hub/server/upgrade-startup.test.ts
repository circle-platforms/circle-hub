import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecordsSchemaCompatibility } from '../records/api.ts';
import { upgradeStartupDecision } from './upgrade-startup.ts';

const compatible: RecordsSchemaCompatibility = { status: 'compatible', compatible: true, expected: [], applied: [], problems: [] };
test('readable floor is never a substitute for completed environment preservation', () => {
  for (const environmentAssignmentCompleted of [false, null]) {
    const result = upgradeStartupDecision({ compatibility: compatible, environmentAssignmentCompleted });
    assert.equal(result.canServe, false); assert.equal(result.enforceEnvironmentAssignments, false);
    assert.ok(result.nextActions.some(line => line.includes('upgrade preview')));
    if (environmentAssignmentCompleted === false) assert.ok(result.nextActions.some(line => line.includes('--expected-snapshot')));
    else { assert.ok(result.nextActions.some(line => line.includes('原事务回执'))); assert.ok(result.nextActions.every(line => !line.includes('upgrade apply'))); }
    assert.doesNotMatch(JSON.stringify(result), /reset|重建库/);
  }
});
test('a completion receipt cannot bypass an incompatible or unavailable reader', () => {
  for (const compatibility of [{ ...compatible, status: 'incompatible' as const, compatible: false }, { ...compatible, status: 'unavailable' as const, compatible: null }]) {
    const result = upgradeStartupDecision({ compatibility, environmentAssignmentCompleted: true });
    assert.equal(result.canServe, false); assert.equal(result.enforceEnvironmentAssignments, false);
    assert.ok(result.nextActions.some(line => line.includes('兼容发布')));
  }
});
test('only both independent verified facts enable the same execution guard', () => {
  const result = upgradeStartupDecision({ compatibility: compatible, environmentAssignmentCompleted: true });
  assert.equal(result.canServe, true); assert.equal(result.enforceEnvironmentAssignments, true);
  assert.deepEqual(result.problems, []); assert.deepEqual(result.nextActions, []);
});
