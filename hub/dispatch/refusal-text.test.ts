import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseField, type ReleaseCheck } from './release-diagnostics.ts';
import { formatReleaseRefusal, releaseNextStep, releaseRefusalDiagnosed } from './refusal-text.ts';

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
  assert.match(admin, /放行条件里有 1 条错误/);
  assert.match(admin, /「核验目标与清单等于执行器声明」判定为错误/);
  assert.match(admin, /执行器声明的是：测试环境 bed-b，清单 dddddddddddd/);
  assert.match(admin, /这次核验的是：测试环境 bed-a，清单 eeeeeeeeeeee/);
  assert.match(admin, /按执行器声明的测试环境和清单重新开始运行并重新核验，再发起上机验证/);
  assert.match(admin, new RegExp(`circle-hub job explain-release --run ${RUN} --executor ${EXEC}`));
  assert.doesNotMatch(admin, /已记下|原因还没查清|期望|实际|原样重交|放行未通过/);
  assert.match(member, /这次核验的是：测试环境 bed-a，清单 eeeeeeeeeeee，和执行器声明的不一样/);
  assert.match(member, /先确认预订的是哪个测试环境/);
  assert.doesNotMatch(member, /执行器声明的是：|circle-hub|已记下|原样重交|提交/);
  assert.doesNotMatch(admin + member, /脚本合并|脚本编写|自动化用例/);
  assert.equal(releaseRefusalDiagnosed(`上机验证没有发出：${admin}`), true);
});

test('result errors alone: names the condition and next step, no unchecked line', () => {
  const checks = [resultErrors()];
  const admin = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: true });
  const member = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: false });
  assert.match(admin, /「核验结果没有未消除错误」判定为错误/);
  assert.match(admin, /这次核验返回的错误还没有改正/);
  assert.match(admin, /按核验返回的错误逐条改正，核验正确后再发起上机验证/);
  assert.match(admin, /explain-release/);
  assert.doesNotMatch(admin, /另有|已记下|原因还没查清|原样重交|核验结果里/);
  assert.match(member, /这次核验返回的错误还没有改正/);
  assert.match(member, /按核验返回的错误逐条改正/);
  assert.doesNotMatch(member, /circle-hub|请管理员/);
});

test('the refusal sentence and a single failed check give the same next step for each role', () => {
  for (const check of [identityError(), resultErrors(), uncheckedParameters('proof.executor_identity')[0]]) {
    for (const callerIsAdmin of [true, false]) {
      const next = releaseNextStep(check, { run: RUN, executor: EXEC, callerIsAdmin });
      assert.ok(formatReleaseRefusal({ checks: [check], run: RUN, executor: EXEC, callerIsAdmin }).includes(`现在可以做：${next}`), `${check.condition} ${callerIsAdmin}`);
    }
  }
  assert.match(releaseNextStep(identityError(), { callerIsAdmin: false }), /^先确认预订的是哪个测试环境/);
  assert.doesNotMatch(releaseNextStep(identityError(), { callerIsAdmin: true }), /explain-release/, 'without the run and executor no command is half written');
});

test('identity error plus unchecked parameter checks: only identity is listed as错误', () => {
  const checks = [identityError(), ...uncheckedParameters('proof.executor_identity')];
  const admin = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: true });
  const member = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: false });
  assert.match(admin, /放行条件里有 1 条错误/);
  assert.match(admin, /「核验目标与清单等于执行器声明」判定为错误/);
  assert.match(admin, /另有 2 条因为上面的错误还没有核对/);
  assert.doesNotMatch(admin, /「派发参数字段集合与核验事实一致」判定为错误/);
  assert.doesNotMatch(admin, /「派发参数与重新读取的核验事实一致」判定为错误/);
  assert.match(admin, /explain-release/);
  assert.match(member, /另有 2 条因为上面的错误还没有核对/);
  assert.doesNotMatch(member, /circle-hub|已记下|原因还没查清|原样重交/);
});

function warrantError(expected: string, actual: string, plain = true): ReleaseCheck {
  return {
    condition: 'proof.claims.warrant_id',
    label: '核验函数身份等于执行器指定身份',
    satisfied: false,
    fields: [releaseField('proof.claims.0.warrant.id', expected, actual, false, plain ? { expected, actual } : undefined)],
  };
}

test('a workflow version the executor was not updated to: the administrator gets both versions and the command, the member is sent to the administrator', () => {
  const checks = [warrantError('synthetic-flow.sheet_verified@3.20.4', 'synthetic-flow.sheet_verified@3.26.8'), ...uncheckedParameters('proof.claims.warrant_id')];
  const admin = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: true });
  const member = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: false });
  assert.match(admin, /放行条件里有 1 条错误/);
  assert.match(admin, /「核验函数身份等于执行器指定身份」判定为错误/);
  assert.match(admin, /执行器指定的核验函数是 synthetic-flow\.sheet_verified@3\.20\.4，这次核验用的是 synthetic-flow\.sheet_verified@3\.26\.8/);
  assert.match(admin, new RegExp(`circle-hub executor update ${EXEC} <定义文件> 把 /proof/warrant_id 改成 synthetic-flow\\.sheet_verified@3\\.26\\.8`));
  assert.match(admin, new RegExp(`circle-hub job explain-release --run ${RUN} --executor ${EXEC}`));
  assert.match(admin, /另有 2 条因为上面的错误还没有核对/);
  assert.match(member, /这次核验用的核验函数是 synthetic-flow\.sheet_verified@3\.26\.8，执行器指定的是更早的版本/);
  assert.match(member, /请管理员把这个测试环境的执行器更新到这次核验所用的版本；更新后再发起上机验证，自动化用例不用改/);
  assert.doesNotMatch(member, /circle-hub|3\.20\.4|exe_/);
  assert.doesNotMatch(admin + member, /程序已判定为错误|摘要|已记下|原因还没查清|原样重交/);
  assert.equal(releaseRefusalDiagnosed(`上机验证没有发出：${member}`), true);
});

test('a run verified by an earlier version than the executor names: start again, and if that changes nothing the executor is ahead', () => {
  const checks = [warrantError('synthetic-flow.sheet_verified@3.26.8', 'synthetic-flow.sheet_verified@3.20.4')];
  const admin = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: true });
  const member = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: false });
  // Which of the two versions is in use is not known where the text is written: both ways out are named.
  assert.match(admin, /这次核验用的版本比执行器指定的早。工作流现行的版本已经是执行器指定的那个时，重新开始运行并重新核验/);
  assert.match(admin, /现行的还是这次核验所用的那个时，是执行器改早了，发布新版本或用 circle-hub executor update 把执行器改回（现行版本用 circle-hub pack list 看）/);
  assert.match(member, /执行器指定的是更新的版本/);
  assert.match(member, /现在可以做：重新开始运行并重新核验，再发起上机验证；重新开始后仍然这样被拒，请管理员核对这个测试环境的执行器指定的版本/);
  assert.doesNotMatch(member, /circle-hub|3\.26\.8/);
});

test('another function than the one the executor names stays digests and names no version', () => {
  const checks = [warrantError('synthetic-flow.sheet_verified@3.26.8', 'private-source-marker@1', false)];
  const admin = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: true });
  const member = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: false });
  assert.match(admin, /proof\.claims\.0\.warrant\.id 执行器或放行所需摘要 [0-9a-f]{12}，这次核对摘要 [0-9a-f]{12}/);
  assert.match(admin, /核对执行器指定的核验函数和这次核验所用的是不是同一个/);
  assert.match(member, /这次核验里没有执行器指定的核验函数给出的结论/);
  assert.match(member, /请管理员核对这个测试环境的执行器指定的核验函数/);
  assert.doesNotMatch(admin + member, /private-source-marker|3\.26\.8/);
});

test('the next step of a single check reads the versions from that check', () => {
  const check = warrantError('synthetic-flow.sheet_verified@3.20.4', 'synthetic-flow.sheet_verified@3.26.8');
  assert.match(releaseNextStep(check, { callerIsAdmin: false }), /^请管理员把这个测试环境的执行器更新到这次核验所用的版本/);
  const admin = releaseNextStep(check, { callerIsAdmin: true });
  assert.match(admin, /circle-hub executor update <执行器> <定义文件> 把 \/proof\/warrant_id 改成 synthetic-flow\.sheet_verified@3\.26\.8/);
  assert.doesNotMatch(admin, /explain-release|undefined/, 'without the run and executor no command is half written');
  for (const callerIsAdmin of [true, false]) {
    const next = releaseNextStep(check, { run: RUN, executor: EXEC, callerIsAdmin });
    assert.ok(formatReleaseRefusal({ checks: [check], run: RUN, executor: EXEC, callerIsAdmin }).includes(`现在可以做：${next}`), String(callerIsAdmin));
  }
});

test('two spellings of one version number put neither side ahead: no direction is told', () => {
  const checks = [warrantError('synthetic-flow.sheet_verified@01.2.0', 'synthetic-flow.sheet_verified@1.2.0')];
  const admin = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: true });
  const member = formatReleaseRefusal({ checks, run: RUN, executor: EXEC, callerIsAdmin: false });
  assert.match(admin, /核对执行器指定的核验函数和这次核验所用的是不是同一个/);
  assert.match(member, /请管理员核对这个测试环境的执行器指定的核验函数/);
  assert.doesNotMatch(admin + member, /更早|更新的版本|旧版本|比执行器指定的早/);
});
