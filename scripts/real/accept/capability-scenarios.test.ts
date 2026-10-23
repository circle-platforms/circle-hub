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
import regressionScope, { type ScopeGold } from './regression-scope.ts';
import templateGap from './template-gap.ts';
import traceability, { type TraceGold } from './traceability.ts';

const turnsOf = (result: string): LoggedTurn[] => [
  { index: 0, toolResults: [], tools: ['hub_start_run'] },
  { index: 1, toolResults: [{ id: 'r1', text: result, isError: false }], tools: [] },
];

const allOk = (scenario: Scenario, turns: LoggedTurn[]): boolean => scenario.check(turns).every((c) => c.ok);

/** The bare turn shape the scripted model hands to respond(). */
const turn = (index: number) => ({ index, system: null, messages: [], tools: [], toolResults: [] });

describe('regression-scope scenario', () => {
  const gold: ScopeGold = {
    product: 'apv',
    earlier: 'Rel_APV_10_6_1_56',
    later: 'Rel_APV_10_6_1_57',
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
      { tool: 'hub_start_run', input: { pack: 'regression-scope', inputs: { impact: { external: 'knowledge:impact:apv:Rel_APV_10_6_1_56..Rel_APV_10_6_1_57?changed=definition&attached=case&attached_fields=document,node,title,priority,negative&catalog=commands@1' } } } },
    ]);
    assert.deepEqual(scenario.respond(turn(1)), [{ text: '对比完成。' }]);
  });
  test('holds on a Hub-shaped answer and fails on a wrong path set or a stray case', () => {
    const good = '运行 run_1 完成：变更路径 /commands/demo/pool/add（modified）、/commands/demo/show（modified）；未覆盖 /commands/demo/show。条目 9001:c-1 放在 /commands/demo/pool/add 上。';
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
    product: 'apv',
    earlier: 'Rel_APV_10_6_1_56',
    later: 'Rel_APV_10_6_1_57',
    cases: [
      { id: '9001:c-2', path: '/commands/demo/pool/delete', removed: true },
      { id: '9001:c-1', path: '/commands/demo/pool/add', removed: false },
    ],
  };
  const scenario = maintenanceSweep(gold);
  test('starts the run on turn 0', () => {
    assert.deepEqual(scenario.respond(turn(0)), [
      { tool: 'hub_start_run', input: { pack: 'maintenance-sweep', inputs: { impact: { external: 'knowledge:impact:apv:Rel_APV_10_6_1_56..Rel_APV_10_6_1_57?changed=definition&attached=case&attached_fields=document,node,title&catalog=commands@1' } } } },
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
    product: 'apv',
    build: 'Rel_APV_10_6_1_57',
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
            defects: { external: 'knowledge:index:apv:Rel_APV_10_6_1_57?kind=defect&key=bug' },
            cases: { external: 'knowledge:index:apv:Rel_APV_10_6_1_57?kind=case&key=defects&fields=document,node,title' },
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
    ].join('\n');
    assert.ok(allOk(scenario, turnsOf(good)), JSON.stringify(scenario.check(turnsOf(good))));
    const missing = good.replace('9001:c-1', '9001:wrong-case');
    assert.ok(!allOk(scenario, turnsOf(missing)), 'a defect missing one joined case fails');
    const traced = good.replace('无已索引用例（未知）', '1 个用例');
    assert.ok(!allOk(scenario, turnsOf(traced)), 'an untraced defect shown with cases fails');
  });
});

describe('quality-board scenario', () => {
  const gold: BoardGold = {
    product: 'apv',
    build: 'Rel_APV_10_6_1_57',
    totals: { cases: 20, missing: 1, vague: 1, negative: 1 },
    groups: [{ label: '10.6/SSL', cases: 20, missing: 1, vague: 1, negative: 1 }],
  };
  const scenario = qualityBoard(gold);

  test('starts the run with the facet view on turn 0', () => {
    assert.deepEqual(scenario.respond(turn(0)), [
      { tool: 'hub_start_run', input: { pack: 'quality-board', inputs: { facets: { external: 'knowledge:facets:apv:Rel_APV_10_6_1_57?kind=case&by=line,module,has_expected,vague_expected,negative' } } } },
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
      regressionScope({ product: 'apv', earlier: 'b1', later: 'b2', changed: [], removed: [], inScope: [], outOfScope: [] }),
      maintenanceSweep({ product: 'apv', earlier: 'b1', later: 'b2', cases: [] }),
      traceability({ product: 'apv', build: 'b1', defects: [] }),
      qualityBoard({ product: 'apv', build: 'b1', groups: [] }),
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
      caseLocation({ document: '90001', product: 'apv', line: '10.6.1' }),
      templateGap({ document: '90001', cases: 10 }),
      regressionScope({ product: 'apv', earlier: 'b1', later: 'b2', changed: [], removed: [], inScope: [], outOfScope: [] }),
      maintenanceSweep({ product: 'apv', earlier: 'b1', later: 'b2', cases: [] }),
      traceability({ product: 'apv', build: 'b1', defects: [] }),
      qualityBoard({ product: 'apv', build: 'b1', groups: [] }),
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

test('a quality-board item-2 gold binds only the 1.0.1 facets slot (placement waits for the gold that asks for it)', async () => {
  const { default: qualityBoard } = await import('./quality-board.ts');
  const scenario = qualityBoard({ product: 'apv', build: 'Synthetic_10_7_Z' });
  const reply = (await scenario.respond(turn(0))) as Array<{ tool?: string; input?: { inputs?: Record<string, unknown> } }>;
  const start = reply.find((r) => r.tool === 'hub_start_run');
  assert.ok(start !== undefined);
  assert.deepEqual(Object.keys(start.input!.inputs ?? {}).sort(), ['facets'], 'no placement before items 3 and 4 are published');
  const withTypes = qualityBoard({ product: 'apv', build: 'Synthetic_10_7_Z', types: true });
  const reply2 = (await withTypes.respond(turn(0))) as Array<{ tool?: string; input?: { inputs?: Record<string, unknown> } }>;
  const start2 = reply2.find((r) => r.tool === 'hub_start_run');
  assert.deepEqual(Object.keys(start2!.input!.inputs ?? {}).sort(), ['facets', 'placement']);
});
