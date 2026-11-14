import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvironmentUseReadError, projectEnvironmentUse, unobservedEnvironmentUse, type TestEnvironmentUseDecision } from './environment-use-decision.ts';

function checked(value: Partial<TestEnvironmentUseDecision>): TestEnvironmentUseDecision {
  return { ...unobservedEnvironmentUse(), ...value };
}

test('a known disabled denial projects false without inventing an unassigned observation', () => {
  const empty = unobservedEnvironmentUse();
  const value = checked({ allowed: false, actual_role: 'user', checks: { ...empty.checks, actor_exists: true, actor_disabled: true, actor_deleted: false }, failed_check: 'actor_disabled', message: '当前账户已停用，不能开始新的测试环境使用' });
  assert.equal(projectEnvironmentUse(value), false);
  assert.equal(value.checks.assignment_present, null);
  assert.equal(value.checks.environment_enabled, null);
  assert.equal(Object.hasOwn(value, 'call_error_reason'), false);
});

test('known target mismatch and unreadable source retain distinct false and null checks on the identical unavailable error boundary', () => {
  const empty = unobservedEnvironmentUse();
  const mismatch = checked({ checks: { ...empty.checks, executor_registered: true, target_matches: false }, failed_check: 'target_matches', message: '执行器当前目标与测试环境登记不一致', references: ['rec:' + 'a'.repeat(64)] });
  const unreadable = checked({ checks: { ...empty.checks, executor_registered: true }, failed_check: 'target_matches', message: '执行器登记原件当前不可读取' });
  for (const value of [mismatch, unreadable]) {
    assert.throws(() => projectEnvironmentUse(value), error => error instanceof EnvironmentUseReadError && error.environment_check === value && error.message === value.message);
  }
  assert.equal(mismatch.checks.target_matches, false);
  assert.equal(unreadable.checks.target_matches, null);
  assert.equal(mismatch.checks.assignment_present, null);
  assert.equal(unreadable.checks.assignment_present, null);
});

test('a confirmed missing assignment remains a specific checked fact rather than a property guessed from any false', () => {
  const empty = unobservedEnvironmentUse();
  const value = checked({ allowed: false, actual_role: 'admin', checks: { ...empty.checks, actor_exists: true, actor_disabled: false, actor_deleted: false, is_test_environment: true, environment_registered: true, environment_enabled: true, registration_unique: true, assignment_present: false }, failed_check: 'assignment_present', message: '当前账户及其有效团队、全体分配中没有本次测试环境的使用分配' });
  assert.equal(projectEnvironmentUse(value), false);
  assert.equal(value.checks.registration_unique, true);
  assert.equal(value.checks.assignment_present, false);
  assert.equal(value.actual_role, 'admin');
});

test('confirmed permission projects true without adding a next step or interpreting source text', () => {
  const value = checked({ allowed: true, message: '本次检查已确认使用分配' });
  assert.equal(projectEnvironmentUse(value), true);
  assert.equal(Object.hasOwn(value, 'nextAction'), false);
  assert.equal(Object.hasOwn(value, 'reason'), false);
});
