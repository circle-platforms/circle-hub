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

describe('case-location scenario with 15 buildCandidates (top 12 truncation and more count)', () => {
  const goldCandidates = [
    // Rel_APV_10_6_1_01 has built: null and sits at the front of the raw list,
    // testing that ordering places built: null at the end (into the unlisted slice).
    { name: 'Rel_APV_10_6_1_01', family: 'APV', base: 'Rel_APV_10_6_1_01', built: null, released: '2026-10-10' },
    { name: 'Rel_APV_10_6_1_90', family: 'APV', base: 'Rel_APV_10_6_1_90', built: '2026-10-22T06:26:12', released: '2026-10-22' },
    { name: 'Rel_APV_10_6_1_80', family: 'APV', base: 'Rel_APV_10_6_1_80', built: '2026-10-21T15:30:45', released: '2026-10-21' },
    // Two with identical built time: APV_72 listed before APV_71 in raw array to test tie-break by name
    { name: 'Rel_APV_10_6_1_72', family: 'APV', base: 'Rel_APV_10_6_1_72', built: '2026-10-20T10:00:00', released: '2026-10-20' },
    { name: 'Rel_APV_10_6_1_71', family: 'APV', base: 'Rel_APV_10_6_1_71', built: '2026-10-20T10:00:00', released: '2026-10-20' },
    // NSAE alias 1 and its base
    { name: 'Rel_NSAE_10_6_1_60', family: 'NSAE', base: 'Rel_APV_10_6_1_60', built: '2026-10-19T09:15:30', released: '2026-10-19' },
    { name: 'Rel_APV_10_6_1_60', family: 'APV', base: 'Rel_APV_10_6_1_60', built: '2026-10-19T09:15:00', released: '2026-10-19' },
    // NSAE alias 2 and its base
    { name: 'Rel_NSAE_10_6_1_50', family: 'NSAE', base: 'Rel_APV_10_6_1_50', built: '2026-10-18T14:20:10', released: '2026-10-18' },
    { name: 'Rel_APV_10_6_1_50', family: 'APV', base: 'Rel_APV_10_6_1_50', built: '2026-10-18T14:20:00', released: '2026-10-18' },
    { name: 'Rel_APV_10_6_1_40', family: 'APV', base: 'Rel_APV_10_6_1_40', built: '2026-10-17T11:00:00', released: '2026-10-17' },
    { name: 'Rel_APV_10_6_1_30', family: 'APV', base: 'Rel_APV_10_6_1_30', built: '2026-10-16T11:00:00', released: '2026-10-16' },
    { name: 'Rel_APV_10_6_1_20', family: 'APV', base: 'Rel_APV_10_6_1_20', built: '2026-10-15T11:00:00', released: '2026-10-15' },
    { name: 'Rel_APV_10_6_1_10', family: 'APV', base: 'Rel_APV_10_6_1_10', built: '2026-10-14T11:00:00', released: '2026-10-14' },
    { name: 'Rel_APV_10_6_1_05', family: 'APV', base: 'Rel_APV_10_6_1_05', built: '2026-10-13T11:00:00', released: '2026-10-13' },
    { name: 'Rel_APV_10_6_1_02', family: 'APV', base: 'Rel_APV_10_6_1_02', built: '2026-10-12T11:00:00', released: '2026-10-12' },
  ];

  const gold: LocationGold = {
    document: '90003',
    product: 'apv',
    line: '10.6.1',
    buildCandidates: {
      candidates: goldCandidates,
      written: [],
    },
  };
  const scenario = caseLocation(gold);

  const good15 = [
    '运行 run_1 完成：任务包 case-location@1.0.0',
    'location 用例定位：满足 1',
    '产品线 apv；版本 10.6.1（目录，置信度高）',
    '构建候选：版本线 10.6.1 的构建候选 15 个，其中别名 2 个（别名基于它所基于的构建），按制作时间从新到旧：' +
      'Rel_APV_10_6_1_90（APV）制作于 2026-10-22 06:26，已发布 2026-10-22；' +
      'Rel_APV_10_6_1_80（APV）制作于 2026-10-21 15:30，已发布 2026-10-21；' +
      'Rel_APV_10_6_1_71（APV）制作于 2026-10-20 10:00，已发布 2026-10-20；' +
      'Rel_APV_10_6_1_72（APV）制作于 2026-10-20 10:00，已发布 2026-10-20；' +
      'Rel_NSAE_10_6_1_60（NSAE，基于 Rel_APV_10_6_1_60）制作于 2026-10-19 09:15，已发布 2026-10-19；' +
      'Rel_APV_10_6_1_60（APV）制作于 2026-10-19 09:15，已发布 2026-10-19；' +
      'Rel_NSAE_10_6_1_50（NSAE，基于 Rel_APV_10_6_1_50）制作于 2026-10-18 14:20，已发布 2026-10-18；' +
      'Rel_APV_10_6_1_50（APV）制作于 2026-10-18 14:20，已发布 2026-10-18；' +
      'Rel_APV_10_6_1_40（APV）制作于 2026-10-17 11:00，已发布 2026-10-17；' +
      'Rel_APV_10_6_1_30（APV）制作于 2026-10-16 11:00，已发布 2026-10-16；' +
      'Rel_APV_10_6_1_20（APV）制作于 2026-10-15 11:00，已发布 2026-10-15；' +
      'Rel_APV_10_6_1_10（APV）制作于 2026-10-14 11:00，已发布 2026-10-14；另有 3 个',
  ].join('\n');

  test('holds when candidate set equals top 12, more count matches 3, aliases and built times match', () => {
    assert.ok(allOk(scenario, turnsOf(good15)), JSON.stringify(scenario.check(turnsOf(good15))));
  });

  test('fails when candidate set is missing one candidate', () => {
    const missingOne = good15.replace(
      'Rel_APV_10_6_1_90（APV）制作于 2026-10-22 06:26，已发布 2026-10-22；',
      '',
    );
    const checks = scenario.check(turnsOf(missingOne));
    assert.ok(!checks.every((c) => c.ok), 'should fail when missing a candidate');
    const candCheck = checks.find((c) => c.name.includes('候选构建名集合'));
    assert.ok(candCheck && !candCheck.ok && candCheck.actual.includes('缺 1 个'));
  });

  test('fails when candidate set has an extra candidate', () => {
    const extraOne = good15.replace(
      'Rel_APV_10_6_1_90',
      'Rel_EXTRA_10_6_1_99（APV）制作于 2026-10-23 00:00，已发布 2026-10-23；Rel_APV_10_6_1_90',
    );
    const checks = scenario.check(turnsOf(extraOne));
    assert.ok(!checks.every((c) => c.ok), 'should fail when having an extra candidate');
    const candCheck = checks.find((c) => c.name.includes('候选构建名集合'));
    assert.ok(candCheck && !candCheck.ok && candCheck.actual.includes('多 1 个'));
  });

  test('fails when more count mismatches', () => {
    const wrongMore = good15.replace('另有 3 个', '另有 2 个');
    const checks = scenario.check(turnsOf(wrongMore));
    assert.ok(!checks.every((c) => c.ok), 'should fail when more count mismatches');
    const moreCheck = checks.find((c) => c.name.includes('剩余构建') || c.name.includes('另有') || c.name.includes('超出上限'));
    assert.ok(moreCheck && !moreCheck.ok, 'more count check must fail');
  });
});
