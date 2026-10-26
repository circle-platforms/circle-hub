// Tests of the traceability scenario (synthetic tool results):
// Verifies traceability checks and paging against scripted turns:
// - 个数对、未知行正确: count matches gold and top cases in statement belong to gold -> passes
// - 未知缺陷两行（只有一行含标记）仍相符: two lines for unknown defect, only one has marker -> passes
// - 个数对但用例号不属于 gold 的不符: count matches but statement case id not in gold -> fails
// - 个数差一: reported case count differs by one -> fails
// - 未知行被写成有用例: defect with no cases is reported as having cases -> fails
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoggedTurn, Scenario } from '../lib/accept.ts';
import type { Turn } from '../scripted-model.ts';
import traceability, { extractStatementCaseIds, type TraceGold } from './traceability.ts';

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

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const allOk = (scenario: Scenario, turns: LoggedTurn[]): boolean => scenario.check(turns).every((c) => c.ok);

describe('traceability scenario checks', () => {
  const gold: TraceGold = {
    product: 'famx',
    build: 'Rel_FAMX_10_6_1_57',
    defects: [
      {
        bug: '7300',
        closed: true,
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
      '已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个。',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    assert.ok(!allOk(scenario, turns), JSON.stringify(checks));
    const knownCheck = checks.find((c) => c.name.includes(hash('7300')));
    assert.ok(knownCheck && knownCheck.ok);
    const unknownCheck = checks.find((c) => c.name.includes(hash('7402')));
    assert.ok(unknownCheck && !unknownCheck.ok && unknownCheck.actual.includes('未知'));
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
      '已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个。',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    assert.ok(!allOk(scenario, turns), JSON.stringify(checks));
    const unknownCheck = checks.find((c) => c.name.includes(hash('7402')));
    assert.ok(unknownCheck && !unknownCheck.ok && unknownCheck.actual.includes('未知'));
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
      '已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个。',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const knownCheck = checks.find((c) => c.name.includes(hash('7300')));
    assert.ok(knownCheck && !knownCheck.ok);
    assert.match(knownCheck.actual, /不属于独立依据的用例/);
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
      '已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个。',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const knownCheck = checks.find((c) => c.name.includes(hash('7300')));
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
      '已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个。',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const unknownCheck = checks.find((c) => c.name.includes(hash('7402')));
    assert.ok(unknownCheck && !unknownCheck.ok);
  });

  test('verifies defect system status and closed counts when gold specifies them', () => {
    const goldWithStatus: TraceGold = {
      product: 'famx',
      build: 'Rel_FAMX_10_6_1_57',
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
          defect_system_unknown_reason: '系统为 bugzilla，不从 PLM 查询',
          closed: false,
          cases: [],
        },
      ],
      closed_defects: 1,
      closed_traced: 1,
      closed_untraced: 0,
      status_unknown: 1,
    };

    const scenario = traceability(goldWithStatus);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '条目（2 个；编号 | 名称 | 摘要）：',
      '- 7300 | 缺陷 7300 | 发布说明：已修复；缺陷系统：closed；1 个用例',
      '- 7402 | 缺陷 7402 | 发布说明：已知；缺陷系统：未知（系统为 bugzilla，不从 PLM 查询）；无已索引用例（未知）',
    ].join('\n');
    const fullResultText = [
      '陈述：缺陷 7300（发布说明：已修复；缺陷系统：closed）：1 个已索引用例追溯：9001:c-1 会话检查，支持，traceability.traced',
      '陈述：缺陷 7402（发布说明：已知；缺陷系统：未知（系统为 bugzilla，不从 PLM 查询））：没有已索引的用例标出缺陷 7402，未知，traceability.traced',
      '跨条目：缺陷 2 个：已追溯 1 个，未追溯 1 个；其中已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个；缺陷系统状态未知 1 个（不算已关闭也不算未关闭），支持，traceability.counts',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    assert.ok(!allOk(scenario, turns), JSON.stringify(checks));

    const statusCheck7300 = checks.find((c) => c.name.includes(hash('7300')) && c.name.includes('缺陷系统状态'));
    assert.ok(statusCheck7300 && statusCheck7300.ok);

    const statusCheck7402 = checks.find((c) => c.name.includes(hash('7402')) && c.name.includes('缺陷系统状态'));
    assert.ok(statusCheck7402 && !statusCheck7402.ok);

    const countsCheck = checks.find((c) => c.name.includes('已关闭缺陷统计'));
    assert.ok(countsCheck && countsCheck.ok);

    const unknownCountsCheck = checks.find((c) => c.name.includes('缺陷系统状态未知统计'));
    assert.ok(unknownCountsCheck && !unknownCountsCheck.ok);
  });

  test('fails when defect system status, closed counts, or status unknown counts do not match gold', () => {
    const goldWithStatus: TraceGold = {
      product: 'famx',
      build: 'Rel_FAMX_10_6_1_57',
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
      status_unknown: 0,
    };

    const scenario = traceability(goldWithStatus);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '- 7300 | 缺陷 7300 | 发布说明：已修复；缺陷系统：resolved；1 个用例',
    ].join('\n');
    const fullResultText = [
      '陈述：缺陷 7300（发布说明：已修复；缺陷系统：resolved）：1 个已索引用例追溯：9001:c-1 会话检查，支持，traceability.traced',
      '跨条目：缺陷 1 个：已追溯 1 个，未追溯 0 个；其中已关闭缺陷 0 个：已追溯 0 个，未追溯 0 个；缺陷系统状态未知 1 个（不算已关闭也不算未关闭），支持，traceability.counts',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    const statusCheck = checks.find((c) => c.name.includes(hash('7300')) && c.name.includes('缺陷系统状态'));
    assert.ok(statusCheck && !statusCheck.ok);
    const countsCheck = checks.find((c) => c.name.includes('已关闭缺陷统计'));
    assert.ok(countsCheck && !countsCheck.ok);
    const unknownCountsCheck = checks.find((c) => c.name.includes('缺陷系统状态未知统计'));
    assert.ok(unknownCountsCheck && !unknownCountsCheck.ok);
  });

  test('verifies all distinct unknown reasons for defect system status', () => {
    const goldDistinct: TraceGold = {
      product: 'famx',
      build: 'Rel_FAMX_10_6_1_57',
      defects: [
        { bug: '8001', status: 'fixed', defect_system_status: null, defect_system_unknown_reason: '缺陷系统不明，不按编号查 PLM', closed: false, cases: [] },
        { bug: '8002', status: 'fixed', defect_system_status: null, defect_system_unknown_reason: '系统为 bugzilla，不从 PLM 查询', closed: false, cases: [] },
        { bug: '8003', status: 'fixed', defect_system_status: null, defect_system_unknown_reason: '缺陷系统没有返回这个编号', closed: false, cases: [] },
        { bug: '8004', status: 'fixed', defect_system_status: null, defect_system_unknown_reason: '缺陷系统的记录里没有状态', closed: false, cases: [] },
        { bug: '8005', status: 'fixed', defect_system_status: null, defect_system_unknown_reason: '缺陷系统没有读到（来源不可用）', closed: false, cases: [] },
      ],
      closed_defects: 0,
      closed_traced: 0,
      closed_untraced: 0,
      status_unknown: 5,
    };

    const scenario = traceability(goldDistinct);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '- 8001 | 缺陷 8001 | 发布说明：已修复；缺陷系统：未知（缺陷系统不明，不按编号查 PLM）；无已索引用例（未知）',
      '- 8002 | 缺陷 8002 | 发布说明：已修复；缺陷系统：未知（系统为 bugzilla，不从 PLM 查询）；无已索引用例（未知）',
      '- 8003 | 缺陷 8003 | 发布说明：已修复；缺陷系统：未知（缺陷系统没有返回这个编号）；无已索引用例（未知）',
      '- 8004 | 缺陷 8004 | 发布说明：已修复；缺陷系统：未知（缺陷系统的记录里没有状态）；无已索引用例（未知）',
      '- 8005 | 缺陷 8005 | 发布说明：已修复；缺陷系统：未知（缺陷系统没有读到（来源不可用））；无已索引用例（未知）',
    ].join('\n');
    const fullResultText = [
      '陈述：缺陷 8001（发布说明：已修复；缺陷系统：未知（缺陷系统不明，不按编号查 PLM））：没有已索引的用例标出缺陷 8001，未知，traceability.traced',
      '陈述：缺陷 8002（发布说明：已修复；缺陷系统：未知（系统为 bugzilla，不从 PLM 查询））：没有已索引的用例标出缺陷 8002，未知，traceability.traced',
      '陈述：缺陷 8003（发布说明：已修复；缺陷系统：未知（缺陷系统没有返回这个编号））：没有已索引的用例标出缺陷 8003，未知，traceability.traced',
      '陈述：缺陷 8004（发布说明：已修复；缺陷系统：未知（缺陷系统的记录里没有状态））：没有已索引的用例标出缺陷 8004，未知，traceability.traced',
      '陈述：缺陷 8005（发布说明：已修复；缺陷系统：未知（缺陷系统没有读到（来源不可用）））：没有已索引的用例标出缺陷 8005，未知，traceability.traced',
      '跨条目：缺陷 5 个：已追溯 0 个，未追溯 5 个；其中已关闭缺陷 0 个：已追溯 0 个，未追溯 0 个；缺陷系统状态未知 5 个（不算已关闭也不算未关闭），支持，traceability.counts',
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    assert.ok(checks.some((c) => !c.ok && c.actual.includes('未知')), JSON.stringify(checks));
    assert.equal(checks.find((c) => c.name === '已关闭且已追溯的缺陷至少 1 个')?.ok, false);
    assert.doesNotMatch(JSON.stringify(checks), /800[1-5]|9001|会话检查/);

    for (const b of ['8001', '8002', '8003', '8004', '8005']) {
      const c = checks.find((chk) => chk.name.includes(hash(b)) && chk.name.includes('缺陷系统状态'));
      assert.ok(c && !c.ok && c.actual.includes('未知'));
    }
  });

  test('handles real client format with "另有" and "根据：tree:" in full result without mistaking tree reference as case ID', () => {
    const goldReal: TraceGold = {
      product: 'famx',
      build: 'Rel_FAMX_10_6_1_57',
      defects: [
        {
          bug: '160001',
          status: 'fixed',
          defect_system_status: 'closed',
          closed: true,
          cases: [
            { id: '24110:n00000000001', title: '标题1' },
            { id: '24110:n00000000002', title: '标题2' },
            { id: '24110:n00000000003', title: '标题3' },
            { id: '24110:n00000000004', title: '标题4' },
            { id: '24110:n00000000005', title: '标题5' },
            { id: '24110:n00000000006', title: '标题6' },
            { id: '24110:n00000000007', title: '标题7' },
            { id: '24110:n00000000008', title: '标题8' },
            { id: '24110:n00000000009', title: '标题9' },
            { id: '24110:n00000000010', title: '标题10' },
            { id: '24110:n00000000011', title: '标题11' },
            { id: '24110:n00000000012', title: '标题12' },
          ],
        },
      ],
      closed_defects: 1,
      closed_traced: 1,
      closed_untraced: 0,
    };

    const scenario = traceability(goldReal);
    const startRunText = [
      '运行 run_1 完成：任务包 traceability',
      '- 160001 | 缺陷 160001 | 发布说明：已修复；缺陷系统：closed；12 个用例',
    ].join('\n');
    const fullResultText = [
      '陈述：缺陷 160001（发布说明：已修复；缺陷系统：closed）：12 个已索引用例追溯：24110:n00000000001 标题1；24110:n00000000002 标题2；24110:n00000000003 标题3；24110:n00000000004 标题4；24110:n00000000005 标题5；另有 7 个，支持；性质与依据等级：事实结论，事实等级 1；根据：tree:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/@条目',
      '跨条目：缺陷 1 个：已追溯 1 个，未追溯 0 个；其中已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个，支持，traceability.counts',
      JSON.stringify({ statement: { verdict: 'support', text: '合成追溯主张' } }),
    ].join('\n');

    const turns = turnsOf([startRunText, fullResultText]);
    const checks = scenario.check(turns);
    assert.ok(allOk(scenario, turns), JSON.stringify(checks));

    const extracted = extractStatementCaseIds(fullResultText, '160001');
    assert.deepEqual(extracted, [
      '24110:n00000000001',
      '24110:n00000000002',
      '24110:n00000000003',
      '24110:n00000000004',
      '24110:n00000000005',
    ]);
  });
});

describe('traceability scenario respond flow', () => {
  const gold: TraceGold = {
    product: 'famx',
    build: 'Rel_FAMX_10_6_1_57',
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

  test('a gold with no closed status names rerunning trace.ts with --plm, not another build', () => {
    const scenario = traceability({
      product: 'famx',
      build: 'Rel_FAMX_10_6_1_57',
      defects: [{ bug: '7300', status: 'fixed', cases: [{ id: '9001:c-1', title: '会话检查' }] }],
    });
    const checks = scenario.check(turnsOf(['运行 run_9 完成。缺陷 1 个：已追溯 1 个，未追溯 0 个。未知 0 个。已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个。']));
    const positive = checks.find((c) => c.name === '已关闭且已追溯的缺陷至少 1 个');
    assert.ok(positive !== undefined && !positive.ok);
    assert.match(String(positive.actual), /重跑 trace\.ts，加 --plm --closed-statuses/);
    assert.ok(!String(positive.actual).includes('导出其他构建'));
  });

  test('a trace.ts gold made without --plm has no closed status anywhere and the scenario fails loudly on it', async () => {
    const { traceGold } = await import('../gold/trace.ts');
    const html = '<a href="?m=bug&f=view&id=910001">910001</a>';
    const gold = traceGold({ html, maps: [] }) as TraceGold;
    assert.equal(gold.closed_defects, undefined, 'joinGold never wrote an invented 0');
    assert.ok(gold.defects.every((d) => d.closed === undefined), 'no per-defect closed status either');
    const scenario = traceability({ product: 'famx', build: 'Rel_FAMX_10_6_1_57', defects: gold.defects });
    const checks = scenario.check(turnsOf(['运行 run_9 完成。缺陷 1 个：已追溯 0 个，未追溯 1 个。未知 0 个。']));
    const counts = checks.find((c) => c.name === '已关闭缺陷统计与独立依据一致');
    assert.ok(counts !== undefined && !counts.ok, 'the count comparison must not run against an invented 0');
    assert.match(String(counts.actual), /标准答案没有已关闭状态：重跑 trace\.ts，加 --plm --closed-statuses/);
  });

 test('pack findings unknown traceability cannot be a passing independent check',()=>{
 const scenario=traceability({product:'famx',build:'Rel_FAMX_10_6_1_7',closed_defects:0,defects:[{bug:'980001',status:'fixed',cases:[]}]});
 const rows=scenario.check(turnsOf(['运行 rn_synthetic\n条目（1 个；编号 | 名称 | 摘要）：\n- 980001 | 缺陷 980001 | 无已索引用例（未知）']));
 assert.ok(rows.some(row=>row.name.includes('没有用例')&&!row.ok&&row.actual.includes('未知')));
 assert.ok(scenario.countLines?.some(line=>line.includes('原因')&&line.includes('下一步')));assert.ok(!scenario.countLines?.join('').includes('980001'));
});
