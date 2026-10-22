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
import { renderReport } from '../lib/report.ts';
import type { Turn } from '../scripted-model.ts';
import caseLocation, {
  parseNextCall,
  parseReportedCandidates,
  type LocationGold,
  type LocationListGold,
} from './case-location.ts';

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
      '产品线 apv；版本 10.7.4（目录，置信度高）；发布火车 10.6.1-R2',
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
        { name: 'Rel_APV_10_7_4_101', classification: 'other_line', line: '10.7.4' },
        { name: 'Rel_UNKNOWN', classification: 'unknown' },
      ],
    },
  };
  const scenario = caseLocation(gold);

  const baseGood = [
    '运行 run_1 完成：任务包 case-location@1.0.0',
    'location 用例定位：满足 1',
    '产品线 apv；版本 10.6.1（目录，置信度高）',
    '构建候选：版本线 10.6.1 的构建候选 2 个，按制作时间从新到旧：Rel_APV_10_6_1_57、Rel_NSAE_10_6_1_57（依据 Rel_APV_10_6_1_57）',
    '写出的构建名 Rel_APV_10_6_1_57 是定位到的版本线的构建',
    '写出的构建名 Rel_APV_10_7_4_101 属于版本线 10.7.4，不是定位到的版本线 10.6.1 的构建',
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
      '构建候选：版本线 10.6.1 的构建候选 2 个，按制作时间从新到旧：Rel_APV_10_6_1_60（APV）制作于 2026-09-18 00:00，已发布 2026-09-20；Rel_NSAE_10_6_1_57（NSAE，基于 Rel_APV_10_6_1_57）制作于 2026-09-01 00:00，已发布 2026-09-05',
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
    const missingOne = baseGood.replace('Rel_APV_10_6_1_57、', '');
    const checks = scenario.check(turnsOf(missingOne));
    assert.ok(!checks.every((c) => c.ok), 'should fail when missing a candidate');
    const candCheck = checks.find((c) => c.name.includes('候选构建名集合'));
    assert.ok(candCheck && !candCheck.ok && candCheck.actual.includes('缺 1 个'));
  });

  test('fails when candidate set has an extra candidate', () => {
    const extraOne = baseGood.replace(
      'Rel_NSAE_10_6_1_57（依据 Rel_APV_10_6_1_57）',
      'Rel_NSAE_10_6_1_57（依据 Rel_APV_10_6_1_57）、Rel_APV_10_6_1_60',
    );
    const checks = scenario.check(turnsOf(extraOne));
    assert.ok(!checks.every((c) => c.ok), 'should fail when having an extra candidate');
    const candCheck = checks.find((c) => c.name.includes('候选构建名集合'));
    assert.ok(candCheck && !candCheck.ok && candCheck.actual.includes('多 1 个'));
  });

  test('fails when alias does not bring out its base build', () => {
    const noBase = baseGood.replace('（依据 Rel_APV_10_6_1_57）', '');
    const checks = scenario.check(turnsOf(noBase));
    assert.ok(!checks.every((c) => c.ok), 'should fail when alias has no base');
    const aliasCheck = checks.find((c) => c.name.includes('候选别名') && c.name.includes('Rel_NSAE_10_6_1_57'));
    assert.ok(aliasCheck && !aliasCheck.ok);
  });

  test('fails when written build classification does not match gold', () => {
    const wrongClass = baseGood.replace(
      '写出的构建名 Rel_APV_10_7_4_101 属于版本线 10.7.4，不是定位到的版本线 10.6.1 的构建',
      '知识库不认识写出的构建名 Rel_APV_10_7_4_101（知识库只收录构建站列出的构建；不认识不等于写错）',
    );
    const checks = scenario.check(turnsOf(wrongClass));
    assert.ok(!checks.every((c) => c.ok));
    const writtenCheck = checks.find((c) => c.name.includes('写出的构建名') && c.name.includes('Rel_APV_10_7_4_101'));
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

describe('parseReportedCandidates and guideline section avoidance', () => {
  const twelveList = [
    'Beta_NSAE_10_6_5_232（NSAE，基于 Beta_APV_10_6_5_232）制作于 2026-10-20 04:02，未发布',
    'Beta_NSAE_10_6_5_231（NSAE）制作于 2026-10-17 04:14，未发布',
    'Beta_APV_10_6_5_230（APV）制作于 2026-10-16 10:00，未发布',
    'Beta_APV_10_6_5_229（APV）制作于 2026-10-15 10:00，未发布',
    'Beta_APV_10_6_5_228（APV）制作于 2026-10-14 10:00，未发布',
    'Beta_APV_10_6_5_227（APV）制作于 2026-10-13 10:00，未发布',
    'Beta_APV_10_6_5_226（APV）制作于 2026-10-12 10:00，未发布',
    'Beta_APV_10_6_5_225（APV）制作于 2026-10-11 10:00，未发布',
    'Beta_APV_10_6_5_224（APV）制作于 2026-10-10 10:00，未发布',
    'Beta_APV_10_6_5_223（APV）制作于 2026-10-09 10:00，未发布',
    'Beta_APV_10_6_5_222（APV）制作于 2026-10-08 10:00，未发布',
    'Beta_APV_10_6_5_221（APV）制作于 2026-10-07 10:00，未发布',
  ];

  const guidelineText = [
    '4. 构建候选（要求项 build_candidates）：按定位到的版本线在两个名称族的候选构建列表，别名解析到它所依据的构建；如 Rel_OLD_RULE_NOT_A_CANDIDATE。',
    '',
    `版本线 10.6.5 的构建候选 81 个，按制作时间从新到旧：${twelveList.join('；')}；另有 69 个，支持；性质……`,
  ].join('\n');

  test('accurately matches conclusion prefix and parses top 12 candidates without being disturbed by section 4 guideline', () => {
    const candidates = parseReportedCandidates(guidelineText);
    assert.equal(candidates.length, 12);
    assert.equal(candidates[0].name, 'Beta_NSAE_10_6_5_232');
    assert.equal(candidates[0].base, 'Beta_APV_10_6_5_232');
    assert.equal(candidates[0].built, '2026-10-20T04:02:00');

    assert.equal(candidates[1].name, 'Beta_NSAE_10_6_5_231');
    assert.equal(candidates[1].base, 'Beta_NSAE_10_6_5_231');
    assert.equal(candidates[1].built, '2026-10-17T04:14:00');

    for (let i = 2; i < 12; i++) {
      const num = 232 - i;
      assert.equal(candidates[i].name, `Beta_APV_10_6_5_${num}`);
      assert.equal(candidates[i].base, `Beta_APV_10_6_5_${num}`);
      const built = candidates[i].built;
      assert.ok(built !== null && built.startsWith('2026-10-'));
    }
  });

  test('returns empty array when conclusion prefix is missing', () => {
    const textWithoutConclusion = '4. 构建候选（要求项 build_candidates）：例如 Rel_APV_10_6_1_57 仅为规程示例，没有结论前缀。';
    assert.deepEqual(parseReportedCandidates(textWithoutConclusion), []);
  });
});

describe('parseNextCall', () => {
  test('extracts reference and cursor from balanced JSON after 下一页：get_nodes ', () => {
    const text = '第一页内容\n下一页：get_nodes {"reference":"rec:abcdef","cursor":"1.0-token123"}；也可看控制台';
    assert.deepEqual(parseNextCall(text), {
      reference: 'rec:abcdef',
      cursor: '1.0-token123',
    });
  });

  test('handles nested braces and extracts first complete JSON object', () => {
    const text = '下一页：get_nodes {"reference":"rec:123","cursor":"c-1","meta":{"p":2}}；也可……';
    assert.deepEqual(parseNextCall(text), {
      reference: 'rec:123',
      cursor: 'c-1',
    });
  });

  test('returns null when there is no next page line or invalid format', () => {
    assert.equal(parseNextCall('没有下一页的内容'), null);
    assert.equal(parseNextCall('下一页：get_nodes 没有花括号'), null);
    assert.equal(parseNextCall('下一页：get_nodes other text {"reference": "rec:1", "cursor": "c-1"}'), null);
    assert.equal(parseNextCall('下一页：get_nodes {"reference": 123}'), null);
  });
});

describe('case-location scenario respond flow (two-step start_run -> get_nodes and paging)', () => {
  const gold: LocationGold = {
    document: '90001',
    product: 'apv',
    line: '10.6.1',
  };
  const makeTurn = (index: number, text = ''): Turn => ({
    index,
    system: null,
    messages: [],
    tools: [],
    toolResults: text ? [{ id: 'r', text, isError: false }] : [],
  });

  test('calls hub_get_nodes with reference in turn 1 when start_run returns rec reference', async () => {
    const s = caseLocation(gold);
    const startReply = await s.respond(makeTurn(0));
    assert.deepEqual(startReply, [
      { tool: 'hub_start_run', input: { pack: 'case-location', product: 'apv', inputs: { documents: { external: 'agile:mindmap:90001' } } } },
    ]);

    const rec = 'rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const startRunText = `运行 run_1 完成：任务包 case-location\n完整结果 ${rec}：用 get_nodes 读第一页，再按每页末尾给出的 cursor 接着读`;
    const turn1Reply = await s.respond(makeTurn(1, startRunText));
    assert.deepEqual(turn1Reply, [
      { tool: 'hub_get_nodes', input: { reference: rec } },
    ]);
  });

  test('two-page answer flow: reads page 1, gets cursor, reads page 2, finishes and passes all candidate checks', async () => {
    const s = caseLocation({
      document: '90001',
      product: 'apv',
      line: '10.6.1',
      buildCandidates: {
        candidates: [
          { name: 'Rel_APV_10_6_1_60', family: 'APV', base: 'Rel_APV_10_6_1_60', built: '2026-10-22T06:26:00' },
          { name: 'Rel_APV_10_6_1_50', family: 'APV', base: 'Rel_APV_10_6_1_50', built: '2026-10-21T06:26:00' },
        ],
        written: [],
      },
    });

    const startReply = await s.respond(makeTurn(0));
    assert.ok('tool' in startReply[0] && startReply[0].tool === 'hub_start_run');

    const rec = 'rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const startRunText = [
      '运行 run_1 完成：任务包 case-location',
      'location 用例定位：满足 1',
      '产品线 apv；版本 10.6.1（目录，置信度高）',
      `完整结果 ${rec}：用 get_nodes 读第一页，再按每页末尾给出的 cursor 接着读`,
    ].join('\n');

    const turn1Reply = await s.respond(makeTurn(1, startRunText));
    assert.deepEqual(turn1Reply, [{ tool: 'hub_get_nodes', input: { reference: rec } }]);

    // Page 1 contains first candidate and ends with next page marker
    const page1Text = [
      `内容 ${rec}：`,
      '版本线 10.6.1 的构建候选 2 个，按制作时间从新到旧：Rel_APV_10_6_1_60（APV）制作于 2026-10-22 06:26，已发布 2026-10-22；',
      `下一页：get_nodes {"reference":"${rec}","cursor":"cursor-token-page2"}；也可看控制台`,
    ].join('\n');

    const turn2Reply = await s.respond(makeTurn(2, page1Text));
    assert.deepEqual(turn2Reply, [{ tool: 'hub_get_nodes', input: { reference: rec, cursor: 'cursor-token-page2' } }]);

    // Page 2 contains second candidate and has NO next page marker
    const page2Text = [
      `内容 ${rec}：`,
      'Rel_APV_10_6_1_50（APV）制作于 2026-10-21 06:26，已发布 2026-10-21',
    ].join('\n');

    const turn3Reply = await s.respond(makeTurn(3, page2Text));
    assert.deepEqual(turn3Reply, [{ text: '定位完成。' }]);

    // Verify checks across all logged turns
    const loggedTurns: LoggedTurn[] = [
      { index: 0, tools: ['hub_start_run'], toolResults: [] },
      { index: 1, tools: ['hub_get_nodes'], toolResults: [{ id: 't0', text: startRunText, isError: false }] },
      { index: 2, tools: ['hub_get_nodes'], toolResults: [{ id: 't1', text: page1Text, isError: false }] },
      { index: 3, tools: [], toolResults: [{ id: 't2', text: page2Text, isError: false }] },
    ];
    const checks = s.check(loggedTurns);
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
  });

  test('caps get_nodes paging at maximum 6 pages', async () => {
    const s = caseLocation(gold);
    await s.respond(makeTurn(0));
    const rec = 'rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    await s.respond(makeTurn(1, `完整结果 ${rec}`));

    // Pages 1 to 5 each return a next cursor
    for (let page = 1; page <= 5; page++) {
      const pageText = `第 ${page} 页\n下一页：get_nodes {"reference":"${rec}","cursor":"${page}.0-abcdef123456"}`;
      const reply = await s.respond(makeTurn(page + 1, pageText));
      assert.deepEqual(reply, [
        { tool: 'hub_get_nodes', input: { reference: rec, cursor: `${page}.0-abcdef123456` } },
      ]);
    }

    // Page 6 returns next cursor, but scenario should cap at 6 pages and finish
    const page6Text = `第 6 页\n下一页：get_nodes {"reference":"${rec}","cursor":"6.0-abcdef123456"}`;
    const reply7 = await s.respond(makeTurn(7, page6Text));
    assert.deepEqual(reply7, [{ text: '定位完成。' }]);
  });
});

describe('case-location scenario with document list (at least 5 documents)', () => {
  const listGold: LocationListGold = {
    product: 'apv',
    documents: [
      {
        document: '900101',
        line: '7.1',
        train: '7.1-R2-2026/5',
        module: '信标',
        stories: ['17206'],
        plmFound: { '17206': true },
      },
      {
        document: '900102',
        line: '7.1',
        train: '7.1-R2-2026/5',
        module: '信标',
        bugs: ['70412'],
        plmFound: { '70412': true },
      },
      {
        document: '900103',
        line: '7.1',
        train: '7.1-R2-2026/5',
        module: '健康检查',
        associatedIds: ['31057'],
        plmFound: { '31057': true },
      },
      {
        document: '900104',
        line: '7.2',
        train: '7.2-R1-2026/7',
        module: '健康检查',
        stories: ['19003'],
        plmFound: { '19003': true },
      },
      {
        document: '900105',
        line: '7.2',
        train: '7.2-R1-2026/7',
        module: 'SSL',
        bugs: ['70499'],
        plmFound: { '70499': false },
      },
    ],
  };

  test('holds on a Hub-shaped multi-document answer with 5 items across 2 lines and 3 modules', () => {
    const s = caseLocation(listGold);
    const text = [
      '运行 run_1 完成：任务包 case-location@1.0.0',
      'location 用例定位：满足 5',
      '条目（5 个；编号 | 名称 | 摘要）：',
      '- 900101 | 文档 900101 | 产品线 apv（COMET）；版本 7.1（目录，置信度高）；发布火车 7.1-R2-2026/5；模块 信标；需求 17206',
      '- 900102 | 文档 900102 | 产品线 apv（COMET）；版本 7.1（目录，置信度高）；发布火车 7.1-R2-2026/5；模块 信标；缺陷 70412',
      '- 900103 | 文档 900103 | 产品线 apv（COMET）；版本 7.1（目录，置信度高）；发布火车 7.1-R2-2026/5；模块 健康检查；未分类编号 31057',
      '- 900104 | 文档 900104 | 产品线 apv（COMET）；版本 7.2（目录，置信度高）；发布火车 7.2-R1-2026/7；模块 健康检查；需求 19003',
      '- 900105 | 文档 900105 | 产品线 apv（COMET）；版本 7.2（目录，置信度高）；发布火车 7.2-R1-2026/7；模块 SSL；缺陷 70499',
    ].join('\n');

    const turns = turnsOf(text);
    const checks = s.check(turns);
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));

    // plmFound is not an empty check in checks
    assert.equal(checks.some((c) => c.name.includes('缺陷系统')), false);

    // plmFound is rendered as manual spot check section, not counted in pass/fail
    assert.deepEqual(s.sections, [
      {
        title: '人工抽查（不是场景核对）',
        lines: [
          '- 文档 900101：关联编号 17206 在缺陷系统里找到',
          '- 文档 900102：关联编号 70412 在缺陷系统里找到',
          '- 文档 900103：关联编号 31057 在缺陷系统里找到',
          '- 文档 900104：关联编号 19003 在缺陷系统里找到',
          '- 文档 900105：关联编号 70499 在缺陷系统里未找到',
        ],
      },
    ]);

    const report = renderReport({
      title: '真实 Circle 客户端验收：case-location',
      generatedAt: '2026-10-23T00:00:00Z',
      checks,
      limits: ['模型的回答是脚本化的'],
      sections: s.sections,
    });
    assert.match(report, /## 人工抽查（不是场景核对）\n\n- 文档 900101：关联编号 17206 在缺陷系统里找到/);
    assert.match(report, /- 文档 900105：关联编号 70499 在缺陷系统里未找到/);
    // Not counted in tally
    assert.match(report, new RegExp(`共 ${checks.length} 项核对，${checks.length} 项相符，0 项不符`));
  });

  test('single document gold without plmFound has no sections; with plmFound outputs manual spot check section', () => {
    const withoutPlm = caseLocation({
      document: '90001',
      line: '10.6.1',
    });
    assert.equal(withoutPlm.sections, undefined);

    const withPlm = caseLocation({
      document: '90001',
      line: '10.6.1',
      plmFound: { '17206': true, '70499': false },
    });
    assert.deepEqual(withPlm.sections, [
      {
        title: '人工抽查（不是场景核对）',
        lines: [
          '- 关联编号 17206 在缺陷系统里找到',
          '- 关联编号 70499 在缺陷系统里未找到',
        ],
      },
    ]);
  });

  test('fails when list has fewer than 5 documents or lacks line/module diversity', () => {
    const shortListGold: LocationListGold = {
      product: 'apv',
      documents: listGold.documents.slice(0, 4),
    };
    const sShort = caseLocation(shortListGold);
    const text = '运行 run_1 完成：任务包 case-location\nlocation 用例定位：满足 4';
    const checks = sShort.check(turnsOf(text));
    const listCheck = checks.find((c) => c.name.includes('文档清单至少 5 份'));
    assert.ok(listCheck && !listCheck.ok);
  });

  test('fails when a document in the list has line mismatch', () => {
    const s = caseLocation(listGold);
    const text = [
      '运行 run_1 完成：任务包 case-location@1.0.0',
      'location 用例定位：满足 5',
      '条目（5 个；编号 | 名称 | 摘要）：',
      '- 900101 | 文档 900101 | 产品线 apv（COMET）；版本 7.9（目录，置信度高）；发布火车 7.1-R2-2026/5；模块 信标',
      '- 900102 | 文档 900102 | 产品线 apv（COMET）；版本 7.1（目录，置信度高）；发布火车 7.1-R2-2026/5；模块 信标',
      '- 900103 | 文档 900103 | 产品线 apv（COMET）；版本 7.1（目录，置信度高）；发布火车 7.1-R2-2026/5；模块 健康检查',
      '- 900104 | 文档 900104 | 产品线 apv（COMET）；版本 7.2（目录，置信度高）；发布火车 7.2-R1-2026/7；模块 健康检查',
      '- 900105 | 文档 900105 | 产品线 apv（COMET）；版本 7.2（目录，置信度高）；发布火车 7.2-R1-2026/7；模块 SSL',
    ].join('\n');

    const checks = s.check(turnsOf(text));
    const doc1Check = checks.find((c) => c.name.includes('文档 900101') && c.name.includes('版本线'));
    assert.ok(doc1Check && !doc1Check.ok);
  });
});

describe('case-location associated ID classification and complete result reading', () => {
  test('checks associated ID set and respective categories: bug to case (unclassified), bug to case 需求 (story), 缺陷 (bug)', () => {
    const gold: LocationListGold = {
      product: 'apv',
      documents: [
        {
          document: '900201',
          line: '7.1',
          train: '7.1-R2',
          module: '信标',
          unclassified: ['900001', '900002'],
        },
        {
          document: '900202',
          line: '7.1',
          train: '7.1-R2',
          module: '信标',
          stories: ['900003'],
        },
        {
          document: '900203',
          line: '7.1',
          train: '7.1-R2',
          module: '健康检查',
          bugs: ['900004'],
        },
        {
          document: '900204',
          line: '7.2',
          train: '7.2-R1',
          module: '健康检查',
          stories: ['900005'],
        },
        {
          document: '900205',
          line: '7.2',
          train: '7.2-R1',
          module: 'SSL',
          bugs: ['900006'],
        },
      ],
    };

    const s = caseLocation(gold);
    const text = [
      '运行 run_1 完成：任务包 case-location@1.0.0',
      'location 用例定位：满足 5',
      '条目（5 个；编号 | 名称 | 摘要）：',
      '- 900201 | 文档 900201 | 产品线 apv；版本 7.1（目录，置信度高）；发布火车 7.1-R2；模块 信标；未分类编号 900001、900002',
      '- 900202 | 文档 900202 | 产品线 apv；版本 7.1（目录，置信度高）；发布火车 7.1-R2；模块 信标；需求 900003',
      '- 900203 | 文档 900203 | 产品线 apv；版本 7.1（目录，置信度高）；发布火车 7.1-R2；模块 健康检查；缺陷 900004',
      '- 900204 | 文档 900204 | 产品线 apv；版本 7.2（目录，置信度高）；发布火车 7.2-R1；模块 健康检查；需求 900005',
      '- 900205 | 文档 900205 | 产品线 apv；版本 7.2（目录，置信度高）；发布火车 7.2-R1；模块 SSL；缺陷 900006',
    ].join('\n');

    const checks = s.check(turnsOf(text));
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));

    // Verify exact check names exist and pass
    const setCheck1 = checks.find((c) => c.name.includes('文档 900201：关联编号集合与独立依据一致'));
    assert.ok(setCheck1 && setCheck1.ok);
    const unclass1 = checks.find((c) => c.name.includes('文档 900201：未分类编号 900001 与独立依据一致'));
    assert.ok(unclass1 && unclass1.ok);
    const unclass2 = checks.find((c) => c.name.includes('文档 900201：未分类编号 900002 与独立依据一致'));
    assert.ok(unclass2 && unclass2.ok);

    const storyCheck = checks.find((c) => c.name.includes('文档 900202：关联需求 900003 与独立依据一致'));
    assert.ok(storyCheck && storyCheck.ok);

    const bugCheck = checks.find((c) => c.name.includes('文档 900203：关联缺陷 900004 与独立依据一致'));
    assert.ok(bugCheck && bugCheck.ok);
  });

  test('reads complete result from hub_get_nodes claim.statement.data when start_run summary is truncated with 等 N 个', () => {
    const gold: LocationGold = {
      document: '900301',
      product: 'apv',
      line: '10.6.1',
      unclassified: ['900001', '900002', '900003', '900004', '900005', '900006'],
    };

    const s = caseLocation(gold);
    const rec = 'rec:1122334455667788990011223344556677889900112233445566778899001122';

    // start_run text has truncated summary: only 3 IDs listed, then "等 6 个"
    const startRunText = [
      '运行 run_1 完成：任务包 case-location@1.0.0',
      'location 用例定位：满足 1',
      '产品线 apv；版本 10.6.1（目录，置信度高）',
      '- 900301 | 文档 900301 | 产品线 apv；版本 10.6.1（目录，置信度高）；未分类编号 900001、900002、900003 等 6 个',
      `完整结果 ${rec}：用 get_nodes 读第一页`,
    ].join('\n');

    // get_nodes page returns the validation result JSON carrying complete claim.statement.data
    const getNodesJson = JSON.stringify({
      partitions: {
        delivered: [
          {
            item: '900301',
            requirements: [
              {
                requirement: 'location',
                claims: [
                  {
                    statement: {
                      verdict: 'support',
                      text: '按目录树定位',
                      data: {
                        case_id: '900301',
                        requirements: [],
                        defects: [],
                        unclassified: ['900001', '900002', '900003', '900004', '900005', '900006'],
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const turns: LoggedTurn[] = [
      { index: 0, tools: ['hub_start_run'], toolResults: [] },
      { index: 1, tools: ['hub_get_nodes'], toolResults: [{ id: 't0', text: startRunText, isError: false }] },
      { index: 2, tools: [], toolResults: [{ id: 't1', text: getNodesJson, isError: false }] },
    ];

    const checks = s.check(turns);
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));

    const setCheck = checks.find((c) => c.name === '关联编号集合与独立依据一致');
    assert.ok(setCheck && setCheck.ok);
    assert.equal(setCheck.actual, '共 6 个，集合一致');

    for (const id of ['900001', '900002', '900003', '900004', '900005', '900006']) {
      const idCheck = checks.find((c) => c.name === `未分类编号 ${id} 与独立依据一致`);
      assert.ok(idCheck && idCheck.ok, `Check for unclassified id ${id} must pass`);
    }
  });

  test('fails when an associated ID is misclassified (gold expects defect but reported as unclassified)', () => {
    const gold: LocationGold = {
      document: '90001',
      line: '10.6.1',
      bugs: ['900001'],
    };
    const s = caseLocation(gold);
    const text = [
      '运行 run_1 完成：任务包 case-location@1.0.0',
      'location 用例定位：满足 1',
      '产品线 apv；版本 10.6.1（目录，置信度高）',
      '- 90001 | 文档 90001 | 版本 10.6.1（目录，置信度高）；未分类编号 900001',
    ].join('\n');

    const checks = s.check(turnsOf(text));
    const bugCheck = checks.find((c) => c.name.includes('关联缺陷 900001 与独立依据一致'));
    assert.ok(bugCheck && !bugCheck.ok, 'must fail because 900001 was reported as unclassified, not defect');
  });

  test('fails when associated ID set has missing or extra items', () => {
    const gold: LocationGold = {
      document: '90001',
      line: '10.6.1',
      unclassified: ['900001', '900002'],
    };
    const s = caseLocation(gold);
    const text = [
      '运行 run_1 完成：任务包 case-location@1.0.0',
      'location 用例定位：满足 1',
      '产品线 apv；版本 10.6.1（目录，置信度高）',
      '- 90001 | 文档 90001 | 版本 10.6.1（目录，置信度高）；未分类编号 900001、900099',
    ].join('\n');

    const checks = s.check(turnsOf(text));
    const setCheck = checks.find((c) => c.name.includes('关联编号集合与独立依据一致'));
    assert.ok(setCheck && !setCheck.ok, 'must fail because 900002 is missing and 900099 is extra');
    assert.match(setCheck.actual, /缺 1 个.*多 1 个/);
  });
});
