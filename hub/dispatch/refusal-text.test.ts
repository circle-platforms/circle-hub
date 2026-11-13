import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseField, type ReleaseCheck } from './release-diagnostics.ts';
import { formatReleaseRefusal, releaseRefusalDiagnosed } from './refusal-text.ts';

const RUN = 'run_01syntheticrefusal00000000001';
const EXEC = 'exe_01syntheticrefusal0000000001';

function identityError(actualTarget = 'bed-a', expectedTarget = 'bed-b'): ReleaseCheck {
  return {
    condition: 'proof.executor_identity',
    label: '核验目标与清单等于执行器声明',
    satisfied: false,
    fields: [
      releaseField('target', expectedTarget, actualTarget, false, { expected: expectedTarget, actual: actualTarget }),
      releaseField('manifest_sha256', 'd'.repeat(64), 'e'.repeat(64), false, {
        expected: 'd'.repeat(12),
        actual: 'e'.repeat(12),
      }),
    ],
  };
}

function resultErrors(): ReleaseCheck {
  return {
    condition: 'result.errors',
    label: '核验结果没有未消除错误',
    satisfied: false,
    fields: [releaseField('result.errors', [], [{ code: 'SOURCE_UNAVAILABLE' }], false)],
  };
}

function uncheckedParameters(blockedBy: string): ReleaseCheck[] {
  return [
    {
      condition: 'release.parameters.keys',
      label: '派发参数字段集合与核验事实一致',
      satisfied: null,
      fields: [],
      blocked_by: blockedBy,
      missing_fact: '尚缺完成“派发参数字段集合与核验事实一致”所需的前置事实或可读记录',
    },
    {
      condition: 'release.parameters.target',
      label: '派发参数与重新读取的核验事实一致',
      satisfied: null,
      fields: [],
      blocked_by: blockedBy,
    },
  ];
}

test('identity mismatch: admin sees declaration values and explain-release; member does not', () => {
  const checks = [identityError()];
  const admin = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: true });
  const member = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: false });
  assert.match(admin, /「核验目标与清单等于执行器声明」判定为错误/);
  assert.match(admin, /期望测试环境 bed-b/);
  assert.match(admin, /实际测试环境 bed-a/);
  assert.match(admin, new RegExp(`circle-hub job explain-release --run ${RUN} --executor ${EXEC}`));
  assert.doesNotMatch(admin, /已记下|原因还没查清|满足/);
  assert.match(member, /实际为 bed-a/);
  assert.match(member, /与执行器声明的不一样/);
  assert.doesNotMatch(member, /期望测试环境|circle-hub|已记下/);
  assert.equal(releaseRefusalDiagnosed(`上机验证没有发出：${admin}`), true);
});

test('result errors alone: names the condition and next step, no unchecked line', () => {
  const checks = [resultErrors()];
  const admin = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: true });
  const member = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: false });
  assert.match(admin, /「核验结果没有未消除错误」判定为错误/);
  assert.match(admin, /消除核验结果里的错误后原样重交/);
  assert.match(admin, /explain-release/);
  assert.doesNotMatch(admin, /另有|已记下|原因还没查清/);
  assert.match(member, /「核验结果没有未消除错误」判定为错误/);
  assert.doesNotMatch(member, /circle-hub/);
});

test('identity error plus unchecked parameter checks: only identity is listed as错误', () => {
  const checks = [identityError(), ...uncheckedParameters('proof.executor_identity')];
  const admin = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: true });
  const member = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: false });
  assert.match(admin, /「核验目标与清单等于执行器声明」判定为错误/);
  assert.match(admin, /另有 2 条因为上面的错误还没有核对/);
  assert.doesNotMatch(admin, /「派发参数字段集合与核验事实一致」判定为错误/);
  assert.doesNotMatch(admin, /「派发参数与重新读取的核验事实一致」判定为错误/);
  assert.match(admin, /explain-release/);
  assert.match(member, /另有 2 条因为上面的错误还没有核对/);
  assert.doesNotMatch(member, /circle-hub|已记下|原因还没查清/);
});
