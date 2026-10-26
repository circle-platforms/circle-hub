// The four capability scenarios against scripted turn logs (synthetic tool results; no real client, no real review):
// each scenario starts its run with the right pack and inputs on turn 0, ends on turn 1, and its checks hold on a
// Hub-shaped answer and fail on a wrong one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { LoggedTurn, Scenario } from '../lib/accept.ts';
import caseLocation from './case-location.ts';
import maintenanceSweep, { type SweepGold } from './maintenance-sweep.ts';
import qualityBoard, { type BoardGold } from './quality-board.ts';
import regressionScope, { facetCountCheck, facetReader, withoutFacetPages, type ScopeGold } from './regression-scope.ts';
import templateGap from './template-gap.ts';
import traceability, { type TraceGold } from './traceability.ts';

const FACET_SOURCE = `src:${'a'.repeat(64)}`;
const facetValue = (count = 0) => ({ schema: 'facet-view@1', product: 'synthetic', build: { build: 'Later', root: 'b'.repeat(64) }, kind: 'case', by: ['commands'], rows: count ? [{ values: { commands: null }, count }] : [], total: count, truncated: false, skipped: 0, notes: [] });
const sourceResult = (value: unknown) => `内容 ${FACET_SOURCE}：模型可读\n原文（${JSON.stringify(value).length} 个字符）：\n${JSON.stringify(value)}\n追踪 synthetic`;
const turnsOf = (result: string, count = 0): LoggedTurn[] => [
  { index: 0, toolResults: [], tools: ['hub_start_run'] },
  { index: 1, toolResults: [{ id: 'r1', text: `${result}\n- 线索 ${FACET_SOURCE}（输入 facets）`, isError: false }], tools: ['hub_get_nodes'] },
  { index: 2, toolResults: [{ id: 'r2', text: sourceResult(facetValue(count)), isError: false }], tools: [] },
];

const allOk = (scenario: Scenario, turns: LoggedTurn[]): boolean => scenario.check(turns).every((c) => c.ok);

/** The bare turn shape the scripted model hands to respond(). */
const turn = (index: number) => ({ index, system: null, messages: [], tools: [], toolResults: [] });

describe('regression-scope scenario', () => {
  const gold: ScopeGold = {
    caseCommandsUnplaced: 0,
    product: 'famx',
    earlier: 'Rel_FAMX_10_6_1_56',
    later: 'Rel_FAMX_10_6_1_57',
    changed: ['/commands/demo/pool/add', '/commands/demo/show'],
    removed: ['/commands/demo/pool/delete'],
    kinds: [
      { path: '/commands/demo/pool/add', kind: 'modified' },
      { path: '/commands/demo/show', kind: 'modified' },
      { path: '/commands/demo/pool/delete', kind: 'removed' },
    ],
    inScope: [{ id: '9001:c-1', path: '/commands/demo/pool/add' }],
    outOfScope: ['9001:c-9'],
  };
  const scenario = regressionScope(gold);
  test('starts the run with the impact view of the build pair on turn 0', () => {
    assert.deepEqual(scenario.respond(turn(0)), [
      { tool: 'hub_start_run', input: { pack: 'regression-scope', inputs: { impact: { external: 'knowledge:impact:famx:Rel_FAMX_10_6_1_56..Rel_FAMX_10_6_1_57?changed=definition&attached=case&attached_fields=document,node,title,priority,negative&catalog=commands@1' }, facets: { external: 'knowledge:facets:famx:Rel_FAMX_10_6_1_57?kind=case&by=commands' } } } },
    ]);
    assert.deepEqual(scenario.respond({ ...turn(1), toolResults: turnsOf('运行 run_synthetic')[1].toolResults }), [{ tool: 'hub_get_nodes', input: { reference: FACET_SOURCE } }]);
    assert.deepEqual(scenario.respond({ ...turn(2), toolResults: turnsOf('运行 run_synthetic')[2].toolResults }), [{ text: '对比完成。' }]);
  });
  test('holds on a Hub-shaped answer and fails on a wrong path set or a stray case', () => {
    const good = '运行 run_1 完成：变更路径 /commands/demo/pool/add（修改）、/commands/demo/show（修改）；命令差 /commands/demo/pool/delete（删除，不进范围）；未覆盖 /commands/demo/show。条目 9001:c-1 放在 /commands/demo/pool/add 上。';
    assert.ok(allOk(scenario, turnsOf(good)), JSON.stringify(scenario.check(turnsOf(good))));
    const stray = good.replace('/commands/demo/show。', '/commands/demo/other。');
    assert.ok(!allOk(scenario, turnsOf(stray)));
    const wrongCase = good.replace('9001:c-1 放在 /commands/demo/pool/add', '9001:c-1 放在 /commands/demo/other');
    assert.ok(!allOk(scenario, turnsOf(wrongCase)));
    const outIncluded = `${good}条目 9001:c-9`;
    assert.ok(!allOk(scenario, turnsOf(outIncluded)), 'an out-of-scope case must not appear');
    assert.ok(!allOk(scenario, turnsOf('出错：读不到视图')), 'an error answer fails');
  });
});

describe('maintenance-sweep scenario', () => {
  const gold: SweepGold = {
    caseCommandsUnplaced: 0,
    product: 'famx',
    earlier: 'Rel_FAMX_10_6_1_56',
    later: 'Rel_FAMX_10_6_1_57',
    cases: [
      { id: '9001:c-2', path: '/commands/demo/pool/delete', removed: true },
      { id: '9001:c-1', path: '/commands/demo/pool/add', removed: false },
    ],
  };
  const scenario = maintenanceSweep(gold);
  test('starts the run on turn 0', () => {
    assert.deepEqual(scenario.respond(turn(0)), [
      { tool: 'hub_start_run', input: { pack: 'maintenance-sweep', inputs: { impact: { external: 'knowledge:impact:famx:Rel_FAMX_10_6_1_56..Rel_FAMX_10_6_1_57?changed=definition&attached=case&attached_fields=document,node,title&catalog=commands@1' }, facets: { external: 'knowledge:facets:famx:Rel_FAMX_10_6_1_56?kind=case&by=commands' } } } },
    ]);
  });
  test('holds when removed and changed cases sit on their paths with their marks', () => {
    const good = [
      '运行 run_2 完成。',
      '条目 9001:c-2：命令已删除（/commands/demo/pool/delete 已删除）。',
      '条目 9001:c-1：命令已改（/commands/demo/pool/add 有字段差异：/help 旧→新）。',
    ].join('\n');
    assert.ok(allOk(scenario, turnsOf(good)), JSON.stringify(scenario.check(turnsOf(good))));
    const swapped = good.replace('9001:c-2：命令已删除（/commands/demo/pool/delete 已删除）', '9001:c-2：命令已删除（/commands/demo/show 已删除）');
    assert.ok(!allOk(scenario, turnsOf(swapped)), 'a removed case on the wrong path fails');
    const noDiff = good.replace('有字段差异：/help 旧→新', '说明改了');
    assert.ok(!allOk(scenario, turnsOf(noDiff)), 'a changed case without a field difference fails');
  });
});

describe('traceability scenario', () => {
  const gold: TraceGold = {
    product: 'famx',
    build: 'Rel_FAMX_10_6_1_57',
    defects: [
      { bug: '7300', closed: true, status: 'fixed', cases: [{ id: '9001:c-1', title: '会话检查' }, { id: '9001:c-2', title: '证书查看' }] },
      { bug: '7402', status: 'known', cases: [] },
    ],
  };
  const scenario = traceability(gold);
  test('starts the run with both index views on turn 0', () => {
    assert.deepEqual(scenario.respond(turn(0)), [
      {
        tool: 'hub_start_run',
        input: {
          pack: 'traceability',
          inputs: {
            defects: { external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=defect&key=bug&only=7300,7402' },
            cases: { external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=defects&fields=document,node,title,system' },
          },
        },
      },
    ]);
  });
  test('holds when every defect lists the joined cases and the untraced one is unknown', () => {
    const good = [
      '运行 run_3 完成。',
      '- 7300 | 缺陷 7300 | 已修复；2 个用例',
      '- 7402 | 缺陷 7402 | 已知；无已索引用例（未知）',
      '陈述：缺陷 7300（已修复）：2 个已索引用例追溯：9001:c-1 会话检查；9001:c-2 证书查看',
      '已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个。',
    ].join('\n');
    assert.ok(!allOk(scenario, turnsOf(good)), 'an honest unknown is unfinished rather than accepted');
    assert.ok(scenario.check(turnsOf(good)).some(c=>c.ok&&c.name.includes('列出的用例')));
    const missing = good.replace('9001:c-1', '9001:wrong-case');
    assert.ok(!allOk(scenario, turnsOf(missing)), 'a defect missing one joined case fails');
    const traced = good.replace('无已索引用例（未知）', '1 个用例');
    assert.ok(!allOk(scenario, turnsOf(traced)), 'an untraced defect shown with cases fails');
  });
});

describe('quality-board scenario', () => {
  const gold: BoardGold = {
    product: 'famx',
    build: 'Rel_FAMX_10_6_1_57',
    totals: { cases: 20, missing: 1, vague: 1, negative: 1 },
    groups: [{ label: '10.6/SSL', cases: 20, missing: 1, vague: 1, negative: 1 }],
  };
  const scenario = qualityBoard(gold);

  test('starts the run with the facet view on turn 0', () => {
    assert.deepEqual(scenario.respond(turn(0)), [
      { tool: 'hub_start_run', input: { pack: 'quality-board', inputs: { facets: { external: 'knowledge:facets:famx:Rel_FAMX_10_6_1_57?kind=case&by=line,module,has_expected,vague_expected,negative' } } } },
    ]);
  });

  const baseGood = [
    '运行 run_4 完成。',
    '- 10.6/SSL | 用例 20 个；无期望结果 5.0%；含糊期望 5.0%；负面用例 5.0%',
    '合计：用例 20 个；无期望结果 1 个（5.0%）；含糊期望 1 个（5.0%）；负面用例 1 个（5.0%）。看板描述的是已索引的用例，不是整套测试。',
  ].join('\n');

  test('holds on a matching total line, percentages and group sum', () => {
    assert.ok(allOk(scenario, turnsOf(baseGood)), JSON.stringify(scenario.check(turnsOf(baseGood))));
  });

  test('fails when one total count is off by one', () => {
    const wrongMissing = baseGood.replace('无期望结果 1 个', '无期望结果 2 个');
    assert.ok(!allOk(scenario, turnsOf(wrongMissing)), 'one count off by one must fail');
  });

  test('fails when a percentage is incorrect', () => {
    const wrongPercent = baseGood.replace('含糊期望 1 个（5.0%）', '含糊期望 1 个（6.0%）');
    assert.ok(!allOk(scenario, turnsOf(wrongPercent)), 'wrong percentage must fail');
  });

  test('fails when the sum of group cases does not equal total cases', () => {
    const wrongGroupSum = baseGood.replace('用例 20 个；无期望结果 5.0%', '用例 19 个；无期望结果 5.0%');
    assert.ok(!allOk(scenario, turnsOf(wrongGroupSum)), 'group sum mismatch must fail');
  });

  test('fails when the limitation is missing', () => {
    const noLimit = baseGood.replace('看板描述的是已索引的用例，不是整套测试。', '');
    assert.ok(!allOk(scenario, turnsOf(noLimit)), 'the limitation must be shown');
  });
});

describe('product line unbinding in start_run inputs', () => {
  test('start_run 输入里没有 product', async () => {
    const scenarios = [
      regressionScope({ caseCommandsUnplaced: 0, product: 'famx', earlier: 'b1', later: 'b2', changed: [], removed: [], inScope: [], outOfScope: [] }),
      maintenanceSweep({ caseCommandsUnplaced: 0, product: 'famx', earlier: 'b1', later: 'b2', cases: [] }),
      traceability({ product: 'famx', build: 'b1', defects: [] }),
      qualityBoard({ product: 'famx', build: 'b1', groups: [] }),
    ];
    for (const s of scenarios) {
      const calls = (await s.respond(turn(0))) as Array<{ tool?: string; input?: Record<string, unknown> }>;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].tool, 'hub_start_run');
      assert.ok(calls[0].input !== null && typeof calls[0].input === 'object');
      assert.equal(
        Object.hasOwn(calls[0].input, 'product'),
        false,
        `${s.name} 的 hub_start_run 输入不应包含 product`,
      );
    }
  });
});

describe('unversioned pack names in start_run inputs', () => {
  test('所有 scripts/real/accept 下场景里 hub_start_run 的 pack 都不带 @ 版本', async () => {
    // 1. Static scan: scan all scenario source files in scripts/real/accept
    const dir = import.meta.dirname;
    const scenarioFiles = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'checks.ts');
    assert.ok(scenarioFiles.length >= 6, `expected at least 6 scenario files, found ${scenarioFiles.length}`);

    for (const file of scenarioFiles) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      const versionedPackMatch = /pack(?:[:=]|\s*:)\s*['"`]([^'"`]+@[0-9][^'"`]*)['"`]/.exec(content);
      assert.equal(
        versionedPackMatch,
        null,
        `${file} 中的 pack 不能带 @ 版本，实际写了: ${versionedPackMatch?.[1]}`,
      );
    }

    // 2. Runtime invocation: verify turn 0 start_run input of all scenarios
    const allScenarios = [
      caseLocation({ document: '90001', product: 'famx', line: '10.6.1' }),
      templateGap({ document: '90001', cases: 10 }),
      regressionScope({ caseCommandsUnplaced: 0, product: 'famx', earlier: 'b1', later: 'b2', changed: [], removed: [], inScope: [], outOfScope: [] }),
      maintenanceSweep({ caseCommandsUnplaced: 0, product: 'famx', earlier: 'b1', later: 'b2', cases: [] }),
      traceability({ product: 'famx', build: 'b1', defects: [] }),
      qualityBoard({ product: 'famx', build: 'b1', groups: [] }),
    ];

    for (const s of allScenarios) {
      const calls = (await s.respond(turn(0))) as Array<{ tool?: string; input?: Record<string, unknown> }>;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].tool, 'hub_start_run');
      assert.ok(calls[0].input !== null && typeof calls[0].input === 'object');
      const pack = calls[0].input.pack;
      if (typeof pack !== 'string') {
        assert.fail(`${s.name} 的 pack 应该是字符串，实际为 ${typeof pack}`);
      }
      assert.ok(!pack.includes('@'), `${s.name} 的 pack 不应包含 @ 版本号，实际为 ${pack}`);
    }
  });
});

for (const name of ['regression-scope', 'maintenance-sweep']) test(`${name} validates independent count before client work and refuses prior-run disclosure exports`, () => {
  const base = { product: 'synthetic', earlier: 'Earlier', later: 'Later', changed: [], removed: [], inScope: [], outOfScope: [], cases: [], caseCommandsUnplaced: 0 };
  const make = (value: unknown) => name === 'regression-scope' ? regressionScope(value as ScopeGold) : maintenanceSweep(value as SweepGold);
  assert.throws(() => make({ ...base, caseCommandsUnplaced: undefined }), /caseCommandsUnplaced.*totals.unplaced/);
  assert.throws(() => make({ ...base, caseCommandsUnplaced: -1 }), /caseCommandsUnplaced/);
  assert.throws(() => make({ ...base, unplaced: 4 }), /unplacedRun/);
  for(const actual of [4,7])assert.throws(()=>make({...base,unplaced:4,unplacedRun:{run:{groups:[{kind:name,message:`有 ${actual} 个用例没有解析出命令`}]}}}),(error:any)=>error.reason==='live_replay');
});

for (const [name, make] of [
  ['regression-scope', () => regressionScope({ product: 'synthetic', earlier: 'Earlier', later: 'Later', changed: [], removed: [], inScope: [], outOfScope: [], caseCommandsUnplaced: 4 })],
  ['maintenance-sweep', () => maintenanceSweep({ product: 'synthetic', earlier: 'Earlier', later: 'Later', cases: [], caseCommandsUnplaced: 4 })],
] as const) test(`${name} must read bound facets and compare with independent count`, () => {
  const scenario = make();
  assert.deepEqual(scenario.respond({ ...turn(1), toolResults: turnsOf('运行 run_synthetic')[1].toolResults }), [{ tool: 'hub_get_nodes', input: { reference: FACET_SOURCE } }]);
  const check = (count: number) => scenario.check(turnsOf('运行 run_synthetic', count)).find((c) => c.name === '分面未归位数与独立抽取相符')!;
  assert.equal(check(4).ok, true); assert.equal(check(7).ok, false); assert.deepEqual([check(4).expected, check(4).actual], ['4', '4']);
  assert.equal(scenario.check(turnsOf('运行 run_synthetic').slice(0, 2)).find((c) => c.name === '分面未归位数与独立抽取相符')?.ok, false);
});
test('facet source pages allow only recognized preludes and verify full character counts', () => {
  for (const prefix of ['', 'Hook allowed this call.\n\n']) {
    const logs = turnsOf('运行 run_synthetic', 4);
    logs[2].toolResults[0].text = prefix + logs[2].toolResults[0].text;
    assert.equal(facetCountCheck('synthetic', 4, logs).ok, true);
    assert.equal(withoutFacetPages(logs)[2].toolResults.length, 0);
    logs[2].toolResults[0].text = logs[2].toolResults[0].text.replace(/原文（\d+ 个字符）/, '原文（1 个字符）');
    assert.equal(facetCountCheck('synthetic', 4, logs).ok, false);
  }
  const logs = turnsOf('运行 run_synthetic', 4);
  logs[2].toolResults[0].text = 'Unrecognized prelude\n' + logs[2].toolResults[0].text;
  assert.equal(facetCountCheck('synthetic', 4, logs).ok, false);
});

test('facet source pagination is followed and reassembled before comparing', () => {
  const value = JSON.stringify(facetValue(4)); const split = 90;
  const page1 = `内容 ${FACET_SOURCE}：模型可读\n原文（${value.length} 个字符）：\n${value.slice(0, split)}\n部分：下一页：get_nodes {"reference":"${FACET_SOURCE}","cursor":"next-synthetic"}\n追踪 synthetic`;
  const page2 = `内容 ${FACET_SOURCE}：模型可读\n原文（共 ${value.length} 个字符、1 行），从第 1 行的第 ${split + 1} 个字符起：\n（接上页：第 1 行的前 ${split} 个字符在上一页）\n${value.slice(split)}\n追踪 synthetic`;
  const read = facetReader();
  read({ ...turn(1), toolResults: turnsOf('运行 run_synthetic')[1].toolResults }, '完成');
  assert.deepEqual(read({ ...turn(2), toolResults: [{ id: 'page1', text: page1, isError: false }] }, '完成'), [{ tool: 'hub_get_nodes', input: { reference: FACET_SOURCE, cursor: 'next-synthetic' } }]);
  const logs = [...turnsOf('运行 run_synthetic').slice(0, 2), { index: 2, toolResults: [{ id: 'page1', text: page1, isError: false }], tools: ['hub_get_nodes'] }];
  assert.equal(facetCountCheck('synthetic', 4, logs).ok, false);
  logs.push({ index: 3, toolResults: [{ id: 'page2', text: page2, isError: false }], tools: [] });
  assert.equal(facetCountCheck('synthetic', 4, logs).ok, true);
  for (const page of logs.slice(2)) page.toolResults[0].text = 'Hook allowed this call.\n\n' + page.toolResults[0].text;
  assert.equal(facetCountCheck('synthetic', 4, logs).ok, true);
  assert.ok(withoutFacetPages(logs).slice(2).every(page => page.toolResults.length === 0));
});
test('truncated, skipped, duplicate null groups and wrong source pages cannot prove a count', () => {
  const raw = facetValue(4);
  for (const value of [{ ...raw, truncated: true }, { ...raw, skipped: 1 }, { ...raw, rows: [...raw.rows, ...raw.rows] }]) {
    const logs = turnsOf('运行 run_synthetic'); logs[2].toolResults[0].text = sourceResult(value);
    assert.equal(facetCountCheck('synthetic', 4, logs).ok, false);
  }
  const logs = turnsOf('运行 run_synthetic', 4); logs[2].toolResults[0].text = logs[2].toolResults[0].text.replace(FACET_SOURCE, `src:${'c'.repeat(64)}`);
  assert.equal(facetCountCheck('synthetic', 4, logs).ok, false);
});
test('scope and sweep answers are never supplied or contaminated by placed facet rows', () => {
  const path = '/commands/widget/add'; const id = 'synthetic-doc:case';
  const scope = regressionScope({ product: 'synthetic', earlier: 'Earlier', later: 'Later', changed: [path], removed: [], inScope: [{ id, path }], outOfScope: [], caseCommandsUnplaced: 0 });
  const sweep = maintenanceSweep({ product: 'synthetic', earlier: 'Earlier', later: 'Later', cases: [{ id, path, removed: false }], caseCommandsUnplaced: 0 });
  const logs = turnsOf(`运行 run_synthetic。条目 ${id} ${path} 有字段差异。`);
  const facet = { ...facetValue(), rows: [{ values: { commands: '/commands/widget/other' }, count: 1 }], total: 1, notes: [`${id} ${path} 有字段差异`] };
  logs[2].toolResults[0].text = sourceResult(facet);
  assert.ok(allOk(scope, logs)); assert.ok(allOk(sweep, logs));
  logs[1].toolResults[0].text = `运行 run_synthetic。条目 ${id} 没有原因。\n- 线索 ${FACET_SOURCE}（输入 facets）`;
  assert.ok(scope.check(logs).some((v) => !v.ok && v.name.includes('范围里的用例')));
  assert.ok(sweep.check(logs).some((v) => !v.ok && v.name.includes('命令已改')));
});

test('a quality-board item-2 gold binds only the 1.0.1 facets slot (placement waits for the gold that asks for it)', async () => {
  const { default: qualityBoard } = await import('./quality-board.ts');
  const scenario = qualityBoard({ product: 'famx', build: 'Synthetic_10_7_Z' });
  const reply = (await scenario.respond(turn(0))) as Array<{ tool?: string; input?: { inputs?: Record<string, unknown> } }>;
  const start = reply.find((r) => r.tool === 'hub_start_run');
  assert.ok(start !== undefined);
  assert.deepEqual(Object.keys(start.input!.inputs ?? {}).sort(), ['facets'], 'no placement before items 3 and 4 are published');
  const withTypes = qualityBoard({ product: 'famx', build: 'Synthetic_10_7_Z', types: true });
  const reply2 = (await withTypes.respond(turn(0))) as Array<{ tool?: string; input?: { inputs?: Record<string, unknown> } }>;
  const start2 = reply2.find((r) => r.tool === 'hub_start_run');
  assert.deepEqual(Object.keys(start2!.input!.inputs ?? {}).sort(), ['facets', 'placement']);
});

test('a one-group board with the appended location column parses the types coverage correctly', async () => {
  const { default: qualityBoard, parseGroups } = await import('./quality-board.ts');
  const scenario = qualityBoard({ product: 'famx', build: 'Rel_FAMX_10_6_1_57', types: true, unplaced: 3 });
  const text = [
    '运行 run_5 完成。',
    '- 10.6/SSL | 用例 20 个；无期望结果 5.0%；含糊期望 5.0%；负面用例 5.0%；未打标签 3 个；没有用例带这些类型的标签：压力测试、兼容性测试 | 位置 src:aaaa/json@1/p/rows',
    '合计：用例 20 个；无期望结果 1 个（5.0%）；含糊期望 1 个（5.0%）；负面用例 1 个（5.0%）。3 个用例没有解析出命令。看板描述的是已索引的用例，不是整套测试。',
  ].join('\n');
  const parsed = parseGroups(text);
  const summary = parsed.get('10.6/SSL') ?? '';
  const missing = /没有用例带这些类型的标签：([^；|\n]+)/.exec(summary)?.[1]?.trim();
  assert.equal(missing, '压力测试、兼容性测试', 'the location column must not be captured into the summary');
  void scenario;
});

test('when placement is bound the unplaced-count sentence is always checked, gold number or not', async () => {
  const { default: qualityBoard } = await import('./quality-board.ts');
  const scenario = qualityBoard({ product: 'famx', build: 'Rel_FAMX_10_6_1_57', types: true });
  const withSentence = scenario.check(turnsOf([
    '运行 run_5 完成。',
    '- 10.6/SSL | 用例 20 个；无期望结果 5.0%；含糊期望 5.0%；负面用例 5.0%',
    '合计：用例 20 个；无期望结果 1 个（5.0%）；含糊期望 1 个（5.0%）；负面用例 1 个（5.0%）。2 个用例没有解析出命令。',
  ].join('\n')));
  const unplacedWith = withSentence.find((c) => c.name.includes('未归位'));
  assert.ok(unplacedWith !== undefined && unplacedWith.ok, JSON.stringify(unplacedWith));
  const withoutSentence = scenario.check(turnsOf([
    '运行 run_5 完成。',
    '- 10.6/SSL | 用例 20 个；无期望结果 5.0%；含糊期望 5.0%；负面用例 5.0%',
    '合计：用例 20 个；无期望结果 1 个（5.0%）；含糊期望 1 个（5.0%）；负面用例 1 个（5.0%）。',
  ].join('\n')));
  const unplaced = withoutSentence.find((c) => c.name.includes('未归位'));
  assert.ok(unplaced !== undefined, 'the check exists whenever placement is bound');
  assert.ok(!unplaced.ok, 'a missing sentence is a mismatch, not a skip');
});

test('a gold with placement but no types still binds both facets and placement (board.ts --placement, the 1.1.0 slot)', async () => {
  const { default: qualityBoard } = await import('./quality-board.ts');
  const scenario = qualityBoard({ product: 'famx', build: 'Synthetic_10_7_Z', placement: true, unplaced: 0 });
  const reply = (await scenario.respond(turn(0))) as Array<{ tool?: string; input?: { inputs?: Record<string, unknown> } }>;
  const start = reply.find((r) => r.tool === 'hub_start_run');
  assert.ok(start !== undefined);
  assert.deepEqual(Object.keys(start.input!.inputs ?? {}).sort(), ['facets', 'placement'], 'quality-board 1.1.0 requires the placement slot');
});

test('a correct one-group board with the location column passes the scenario group check end to end (closure item 9)', async () => {
  const { default: qualityBoard } = await import('./quality-board.ts');
  const scenario = qualityBoard({
    product: 'famx',
    build: 'Rel_FAMX_10_6_1_57',
    types: true,
    unplaced: 1,
    totals: { cases: 20, missing: 1, vague: 1, negative: 1 },
    groups: [{ label: '10.6/SSL', cases: 20, missing: 1, vague: 1, negative: 1, coverage: { present: [], missing: ['兼容性测试', '压力测试'], untagged: 3 } }],
  });
  const checks = scenario.check(turnsOf([
    '运行 run_5 完成。',
    '- 10.6/SSL | 用例 20 个；无期望结果 1 个（5.0%）；含糊期望 1 个（5.0%）；负面用例 1 个（5.0%）；未打标签 3 个；没有用例带这些类型的标签：压力测试、兼容性测试 | 位置 src:aaaa/json@1/p/rows',
    '合计：用例 20 个；无期望结果 1 个（5.0%）；含糊期望 1 个（5.0%）；负面用例 1 个（5.0%）。1 个用例没有解析出命令。看板描述的是已索引的用例，不是整套测试。',
  ].join('\n')));
  const group = checks.find((c) => c.name === '#1 分组指标一致');
  assert.ok(group !== undefined, JSON.stringify(checks.map((c) => c.name)));
  assert.ok(group.ok, JSON.stringify(group));
});

test('board count checks recognize the generated command-ownership label and still reject a different count', async () => {
  const { labelOf } = await import('../../../contracts/generated/vocabulary.ts');
  const scenario = qualityBoard({ product: 'synthetic', build: 'Rel_DEMO_10_6_1_1', types: true, unplaced: 4 });
  for (const count of [3, 4]) {
    const checks = scenario.check(turnsOf(`运行 run_5 完成。\n合计：用例 5 个；${labelOf('knowledge_count', 'commandless_cases')} ${count} 个，计入合计。`));
    const check = checks.find(c => c.name.includes('未归位用例数'));
    assert.ok(check);
    assert.equal(check.ok, count === 4, JSON.stringify(check));
  }
});
