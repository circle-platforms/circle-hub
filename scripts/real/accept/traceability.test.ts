// Tests of the traceability scenario (synthetic tool results):
// Verifies traceability checks and paging against scripted turns:
// - 个数对、未知行正确: count matches gold and top cases in statement belong to gold -> passes
// - 未知缺陷两行（只有一行含标记）仍相符: two lines for unknown defect, only one has marker -> passes
// - 个数对但用例号不属于 gold 的不符: count matches but statement case id not in gold -> fails
// - 个数差一: reported case count differs by one -> fails
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

  test('holds when count matches, statement lists top cases belonging to gold, and unknown defect is honest (个数对、未知行正确)', () => {
    const scenario = traceability(gold);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '完整结果 rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '条目（2 个；编号 | 名称 | 摘要）：',
      '- 7300 | 缺陷 7300 | 已修复；2 个用例',
      '- 7402 | 缺陷 7402 | 已知；无已索引用例（未知）',
    ].join('\n');
    const fullResultText = [
      '陈述：缺陷 7300（已修复）：2 个已索引用例追溯：9001:c-1 会话检查；9001:c-2 证书查看，支持，traceability.traced',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    assert.ok(allOk(scenario, turns), JSON.stringify(checks));
    const knownCheck = checks.find((c) => c.name.includes('7300'));
    assert.ok(knownCheck && knownCheck.ok);
    const unknownCheck = checks.find((c) => c.name.includes('7402'));
    assert.ok(unknownCheck && unknownCheck.ok && unknownCheck.actual === '无已索引用例（未知）');
  });

  test('holds when unknown defect has two lines and only one contains honest marker (未知缺陷两行（只有一行含标记）仍相符)', () => {
    const scenario = traceability(gold);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '问题与未知：',
      '- 7402 | 缺陷 7402 | 待判定',
      '条目（2 个；编号 | 名称 | 摘要）：',
      '- 7300 | 缺陷 7300 | 已修复；2 个用例',
      '- 7402 | 缺陷 7402 | 已知；无已索引用例（未知）',
    ].join('\n');
    const fullResultText = [
      '陈述：缺陷 7300（已修复）：2 个已索引用例追溯：9001:c-1 会话检查；9001:c-2 证书查看，支持，traceability.traced',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    assert.ok(allOk(scenario, turns), JSON.stringify(checks));
    const unknownCheck = checks.find((c) => c.name.includes('7402'));
    assert.ok(unknownCheck && unknownCheck.ok && unknownCheck.actual === '无已索引用例（未知）');
  });

  test('fails when count matches but statement case ID does not belong to gold (个数对但用例号不属于 gold 的不符)', () => {
    const scenario = traceability(gold);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '完整结果 rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '条目（2 个；编号 | 名称 | 摘要）：',
      '- 7300 | 缺陷 7300 | 已修复；2 个用例',
      '- 7402 | 缺陷 7402 | 已知；无已索引用例（未知）',
    ].join('\n');
    const fullResultText = [
      '陈述：缺陷 7300（已修复）：2 个已索引用例追溯：9001:wrong-case 会话检查；9001:c-2 证书查看，支持，traceability.traced',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const knownCheck = checks.find((c) => c.name.includes('7300'));
    assert.ok(knownCheck && !knownCheck.ok);
    assert.match(knownCheck.actual, /用例号不属于独立依据/);
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
      '陈述：缺陷 7300（已修复）：2 个已索引用例追溯：9001:c-1 会话检查；9001:c-2 证书查看，支持，traceability.traced',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const knownCheck = checks.find((c) => c.name.includes('7300'));
    assert.ok(knownCheck && !knownCheck.ok);
    assert.match(knownCheck.actual, /用例数不一致/);
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
      '陈述：缺陷 7300（已修复）：2 个已索引用例追溯：9001:c-1 会话检查；9001:c-2 证书查看，支持，traceability.traced',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const unknownCheck = checks.find((c) => c.name.includes('7402'));
    assert.ok(unknownCheck && !unknownCheck.ok);
  });

  test('verifies defect system status and closed counts when gold specifies them', () => {
    const goldWithStatus: TraceGold = {
      product: 'apv',
      build: 'Rel_APV_10_6_1_57',
      defects: [
        {
          bug: '7300',
          status: 'fixed',
          defect_system_status: 'closed',
          closed: true,
          cases: [
            { id: '9001:c-1', title: '会话检查' },
          ],
        },
        {
          bug: '7402',
          status: 'known',
          defect_system_status: null,
          defect_system_unknown_reason: '系统是 bugzilla，不从 PLM 查询',
          closed: false,
          cases: [],
        },
      ],
      closed_defects: 1,
      closed_traced: 1,
      closed_untraced: 0,
    };

    const scenario = traceability(goldWithStatus);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '条目（2 个；编号 | 名称 | 摘要）：',
      '- 7300 | 缺陷 7300 | 发布说明：已修复；缺陷系统：closed；1 个用例',
      '- 7402 | 缺陷 7402 | 发布说明：已知；缺陷系统：未知；无已索引用例（未知）',
    ].join('\n');
    const fullResultText = [
      '陈述：缺陷 7300（发布说明：已修复；缺陷系统：closed）：1 个已索引用例追溯：9001:c-1 会话检查，支持，traceability.traced',
      '陈述：缺陷 7402（发布说明：已知；缺陷系统：未知）：没有已索引的用例标出缺陷 7402，未知，traceability.traced',
      '跨条目：缺陷 2 个：已追溯 1 个，未追溯 1 个；其中已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个，支持，traceability.counts',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    assert.ok(allOk(scenario, turns), JSON.stringify(checks));

    const statusCheck7300 = checks.find((c) => c.name.includes('7300') && c.name.includes('缺陷系统状态'));
    assert.ok(statusCheck7300 && statusCheck7300.ok);

    const statusCheck7402 = checks.find((c) => c.name.includes('7402') && c.name.includes('缺陷系统状态'));
    assert.ok(statusCheck7402 && statusCheck7402.ok);

    const countsCheck = checks.find((c) => c.name.includes('已关闭缺陷统计'));
    assert.ok(countsCheck && countsCheck.ok);
  });

  test('fails when defect system status or closed counts do not match gold', () => {
    const goldWithStatus: TraceGold = {
      product: 'apv',
      build: 'Rel_APV_10_6_1_57',
      defects: [
        {
          bug: '7300',
          status: 'fixed',
          defect_system_status: 'closed',
          closed: true,
          cases: [{ id: '9001:c-1', title: '会话检查' }],
        },
      ],
      closed_defects: 1,
      closed_traced: 1,
      closed_untraced: 0,
    };

    const scenario = traceability(goldWithStatus);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '- 7300 | 缺陷 7300 | 发布说明：已修复；缺陷系统：resolved；1 个用例',
    ].join('\n');
    const fullResultText = [
      '陈述：缺陷 7300（发布说明：已修复；缺陷系统：resolved）：1 个已索引用例追溯：9001:c-1 会话检查，支持，traceability.traced',
      '跨条目：缺陷 1 个：已追溯 1 个，未追溯 0 个；其中已关闭缺陷 0 个：已追溯 0 个，未追溯 0 个，支持，traceability.counts',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const statusCheck = checks.find((c) => c.name.includes('7300') && c.name.includes('缺陷系统状态'));
    assert.ok(statusCheck && !statusCheck.ok);
    const countsCheck = checks.find((c) => c.name.includes('已关闭缺陷统计'));
    assert.ok(countsCheck && !countsCheck.ok);
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
