// Tests of the traceability scenario (synthetic tool results):
// Verifies traceability checks and paging against scripted turns:
// - 个数对: count matches gold and all case IDs appear in full result -> passes
// - 个数差一: reported case count differs by one -> fails
// - 用例号缺一个: one case ID missing in full result -> fails
// - 未知行正确: defect with no cases has "无已索引用例（未知）" in entry line -> passes
// - 未知行被写成有用例: defect with no cases is reported as having cases -> fails
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoggedTurn, Scenario } from '../lib/accept.ts';
import type { Turn } from '../scripted-model.ts';
import traceability, { type TraceGold } from './traceability.ts';

const turnsOf = (texts: string[]): LoggedTurn[] => {
  return [
    { index: 0, toolResults: [], tools: ['hub_start_run'] },
    ...texts.map((text, i) => ({
      index: i + 1,
      toolResults: [{ id: `r${i + 1}`, text, isError: false }],
      tools: i < texts.length - 1 ? ['hub_get_nodes'] : [],
    })),
  ];
};

const allOk = (scenario: Scenario, turns: LoggedTurn[]): boolean => scenario.check(turns).every((c) => c.ok);

describe('traceability scenario checks', () => {
  const gold: TraceGold = {
    product: 'apv',
    build: 'Rel_APV_10_6_1_57',
    defects: [
      {
        bug: '7300',
        status: 'fixed',
        cases: [
          { id: '9001:c-1', title: '会话检查' },
          { id: '9001:c-2', title: '证书查看' },
        ],
      },
      {
        bug: '7402',
        status: 'known',
        cases: [],
      },
    ],
  };

  test('holds when count matches, case IDs appear in full result, and unknown defect is honest (个数对、未知行正确)', () => {
    const scenario = traceability(gold);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '完整结果 rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '条目（2 个；编号 | 名称 | 摘要）：',
      '- 7300 | 缺陷 7300 | 已修复；2 个用例',
      '- 7402 | 缺陷 7402 | 已知；无已索引用例（未知）',
    ].join('\n');
    const fullResultText = [
      '缺陷 7300 的用例列表：',
      '用例 9001:c-1（会话检查）',
      '用例 9001:c-2（证书查看）',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    assert.ok(allOk(scenario, turns), JSON.stringify(checks));
    const knownCheck = checks.find((c) => c.name.includes('7300'));
    assert.ok(knownCheck && knownCheck.ok);
    const unknownCheck = checks.find((c) => c.name.includes('7402'));
    assert.ok(unknownCheck && unknownCheck.ok && unknownCheck.actual === '无已索引用例（未知）');
  });

  test('fails when case count is off by one (个数差一)', () => {
    const scenario = traceability(gold);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '完整结果 rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '条目（2 个；编号 | 名称 | 摘要）：',
      '- 7300 | 缺陷 7300 | 已修复；1 个用例',
      '- 7402 | 缺陷 7402 | 已知；无已索引用例（未知）',
    ].join('\n');
    const fullResultText = [
      '用例 9001:c-1 9001:c-2',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const knownCheck = checks.find((c) => c.name.includes('7300'));
    assert.ok(knownCheck && !knownCheck.ok);
    assert.match(knownCheck.actual, /用例数不一致/);
  });

  test('fails when one case ID is missing from full result (用例号缺一个)', () => {
    const scenario = traceability(gold);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '完整结果 rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '条目（2 个；编号 | 名称 | 摘要）：',
      '- 7300 | 缺陷 7300 | 已修复；2 个用例',
      '- 7402 | 缺陷 7402 | 已知；无已索引用例（未知）',
    ].join('\n');
    const fullResultText = [
      '用例 9001:c-1（缺少第二条）',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const knownCheck = checks.find((c) => c.name.includes('7300'));
    assert.ok(knownCheck && !knownCheck.ok);
    assert.match(knownCheck.actual, /缺 9001:c-2/);
  });

  test('fails when unknown defect line is written as having cases (未知行被写成有用例)', () => {
    const scenario = traceability(gold);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '完整结果 rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '条目（2 个；编号 | 名称 | 摘要）：',
      '- 7300 | 缺陷 7300 | 已修复；2 个用例',
      '- 7402 | 缺陷 7402 | 已知；1 个用例',
    ].join('\n');
    const fullResultText = [
      '用例 9001:c-1 9001:c-2',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const unknownCheck = checks.find((c) => c.name.includes('7402'));
    assert.ok(unknownCheck && !unknownCheck.ok);
  });
});

describe('traceability scenario respond flow', () => {
  const gold: TraceGold = {
    product: 'apv',
    build: 'Rel_APV_10_6_1_57',
    defects: [{ bug: '7300', status: 'fixed', cases: [] }],
  };
  const scenario = traceability(gold);
  const makeTurn = (index: number, text = ''): Turn => ({
    index,
    system: null,
    messages: [],
    tools: [],
    toolResults: text ? [{ id: 'r', text, isError: false }] : [],
  });

  test('calls hub_get_nodes on turn 1 using rec reference from start_run answer', async () => {
    const reply0 = await scenario.respond(makeTurn(0));
    assert.ok(Array.isArray(reply0) && 'tool' in reply0[0] && reply0[0].tool === 'hub_start_run');

    const reply1 = await scenario.respond(
      makeTurn(1, '完整结果 rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    );
    assert.deepEqual(reply1, [{ tool: 'hub_get_nodes', input: { reference: 'rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } }]);
  });
});
