// Tests of the case-location scenario (synthetic tool results):
// Verifies case-location checks against scripted turns:
// - Without buildCandidates: previous checks behave unchanged
// - With buildCandidates:
//   - Equal set of candidates, alias carries base, written classification matches -> passes
//   - Missing candidate -> fails
//   - Extra candidate -> fails
//   - Alias does not bring out its base build -> fails
//   - Written build classification mismatch -> fails
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoggedTurn, Scenario } from '../lib/accept.ts';
import caseLocation, { type LocationGold } from './case-location.ts';

const turnsOf = (text: string): LoggedTurn[] => [
  { index: 0, toolResults: [], tools: ['hub_start_run'] },
  { index: 1, toolResults: [{ id: 'r1', text, isError: false }], tools: [] },
];

const allOk = (scenario: Scenario, turns: LoggedTurn[]): boolean => scenario.check(turns).every((c) => c.ok);

describe('case-location scenario without buildCandidates', () => {
  const gold: LocationGold = {
    document: '90001',
    product: 'apv',
    line: '10.6.1',
    train: '10.6.1-R2',
  };
  const scenario = caseLocation(gold);

  test('holds on a Hub-shaped answer with matching line, train, and product', () => {
    const good = [
      '运行 run_1 完成：任务包 case-location@1.0.0',
      'location 用例定位：满足 1',
      '产品线 apv；版本 10.6.1（目录，置信度高）；发布火车 10.6.1-R2',
    ].join('\n');
    assert.ok(allOk(scenario, turnsOf(good)), JSON.stringify(scenario.check(turnsOf(good))));
  });

  test('fails when version line mismatches', () => {
    const mismatch = [
      '运行 run_1 完成：任务包 case-location@1.0.0',
      'location 用例定位：满足 1',
      '产品线 apv；版本 10.5.1（目录，置信度高）；发布火车 10.6.1-R2',
    ].join('\n');
    assert.ok(!allOk(scenario, turnsOf(mismatch)));
  });
});

describe('case-location scenario with buildCandidates', () => {
  const gold: LocationGold = {
    document: '90001',
    product: 'apv',
    line: '10.6.1',
    buildCandidates: {
      candidates: [
        { name: 'Rel_APV_10_6_1_57', family: 'APV', base: 'Rel_APV_10_6_1_57', released: '2026-05-14' },
        { name: 'Rel_NSAE_10_6_1_57', family: 'NSAE', base: 'Rel_APV_10_6_1_57', released: '2026-05-22' },
      ],
      written: [
        { name: 'Rel_APV_10_6_1_57', classification: 'known' },
        { name: 'Rel_APV_10_5_1_101', classification: 'other_line', line: '10.5.1' },
        { name: 'Rel_UNKNOWN', classification: 'unknown' },
      ],
    },
  };
  const scenario = caseLocation(gold);

  const baseGood = [
    '运行 run_1 完成：任务包 case-location@1.0.0',
    'location 用例定位：满足 1',
    '产品线 apv；版本 10.6.1（目录，置信度高）',
    '构建候选：Rel_APV_10_6_1_57、Rel_NSAE_10_6_1_57（依据 Rel_APV_10_6_1_57）',
    '写出的构建名 Rel_APV_10_6_1_57 是定位到的版本线的构建',
    '写出的构建名 Rel_APV_10_5_1_101 属于版本线 10.5.1，不是定位到的版本线 10.6.1 的构建',
    '知识库不认识写出的构建名 Rel_UNKNOWN（知识库只收录构建站列出的构建；不认识不等于写错）',
  ].join('\n');

  test('holds when candidate set equals gold, alias brings out base, and written builds classify matching gold', () => {
    assert.ok(allOk(scenario, turnsOf(baseGood)), JSON.stringify(scenario.check(turnsOf(baseGood))));
  });

  test('compares the built time and the based-on base of each candidate when gold carries them', () => {
    const withTimes = caseLocation({
      document: '90002',
      product: 'apv',
      line: '10.6.1',
      buildCandidates: {
        candidates: [
          { name: 'Rel_APV_10_6_1_60', family: 'APV', base: 'Rel_APV_10_6_1_60', built: '2026-09-18T00:00:00', released: '2026-09-20' },
          { name: 'Rel_NSAE_10_6_1_57', family: 'NSAE', base: 'Rel_APV_10_6_1_57', built: '2026-09-01T00:00:00', released: '2026-09-05' },
        ],
        written: [],
      },
    });
    const good = [
      '运行 run_1 完成：任务包 case-location@1.0.0',
      'location 用例定位：满足 1',
      '产品线 apv；版本 10.6.1（目录，置信度高）',
      '构建候选：Rel_APV_10_6_1_60（APV）制作于 2026-09-18 00:00，已发布 2026-09-20；Rel_NSAE_10_6_1_57（NSAE，基于 Rel_APV_10_6_1_57）制作于 2026-09-01 00:00，已发布 2026-09-05',
    ].join('\n');
    assert.ok(allOk(withTimes, turnsOf(good)), JSON.stringify(withTimes.check(turnsOf(good))));
    const wrongTime = good.replace('制作于 2026-09-18 00:00', '制作于 2026-09-19 00:00');
    assert.ok(!allOk(withTimes, turnsOf(wrongTime)), 'a wrong built time fails');
    const noTime = good.replace('）制作于 2026-09-18 00:00，已发布', '），已发布');
    assert.ok(!allOk(withTimes, turnsOf(noTime)), 'a missing built time fails');
    const wrongBase = good.replace('（NSAE，基于 Rel_APV_10_6_1_57）', '（NSAE，基于 Rel_APV_10_6_1_60）');
    assert.ok(!allOk(withTimes, turnsOf(wrongBase)), 'a wrong based-on build fails');
  });

  test('fails when candidate set is missing one candidate', () => {
    const missingOne = baseGood.replace(
      '构建候选：Rel_APV_10_6_1_57、Rel_NSAE_10_6_1_57（依据 Rel_APV_10_6_1_57）',
      '构建候选：Rel_APV_10_6_1_57',
    );
    const checks = scenario.check(turnsOf(missingOne));
    assert.ok(!checks.every((c) => c.ok), 'should fail when missing a candidate');
    const candCheck = checks.find((c) => c.name.includes('候选构建名集合'));
    assert.ok(candCheck && !candCheck.ok && candCheck.actual.includes('缺 1 个'));
  });

  test('fails when candidate set has an extra candidate', () => {
    const extraOne = baseGood.replace(
      '构建候选：Rel_APV_10_6_1_57、Rel_NSAE_10_6_1_57（依据 Rel_APV_10_6_1_57）',
      '构建候选：Rel_APV_10_6_1_57、Rel_NSAE_10_6_1_57（依据 Rel_APV_10_6_1_57）、Rel_APV_10_6_1_60',
    );
    const checks = scenario.check(turnsOf(extraOne));
    assert.ok(!checks.every((c) => c.ok), 'should fail when having an extra candidate');
    const candCheck = checks.find((c) => c.name.includes('候选构建名集合'));
    assert.ok(candCheck && !candCheck.ok && candCheck.actual.includes('多 1 个'));
  });

  test('fails when alias does not bring out its base build', () => {
    const noBase = baseGood.replace(
      '构建候选：Rel_APV_10_6_1_57、Rel_NSAE_10_6_1_57（依据 Rel_APV_10_6_1_57）',
      '构建候选：Rel_APV_10_6_1_57、Rel_NSAE_10_6_1_57',
    );
    const checks = scenario.check(turnsOf(noBase));
    assert.ok(!checks.every((c) => c.ok), 'should fail when alias has no base');
    const aliasCheck = checks.find((c) => c.name.includes('候选别名') && c.name.includes('Rel_NSAE_10_6_1_57'));
    assert.ok(aliasCheck && !aliasCheck.ok);
  });

  test('fails when written build classification does not match gold', () => {
    const wrongClass = baseGood.replace(
      '写出的构建名 Rel_APV_10_5_1_101 属于版本线 10.5.1，不是定位到的版本线 10.6.1 的构建',
      '知识库不认识写出的构建名 Rel_APV_10_5_1_101（知识库只收录构建站列出的构建；不认识不等于写错）',
    );
    const checks = scenario.check(turnsOf(wrongClass));
    assert.ok(!checks.every((c) => c.ok));
    const writtenCheck = checks.find((c) => c.name.includes('写出的构建名') && c.name.includes('Rel_APV_10_5_1_101'));
    assert.ok(writtenCheck && !writtenCheck.ok);
  });
});
