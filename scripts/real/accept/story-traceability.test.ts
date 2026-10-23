import assert from 'node:assert/strict';
import { test } from 'node:test';
import scenario from './story-traceability.ts';
import type { StoryGold } from '../gold/trace-stories.ts';
import type { LoggedTurn } from '../lib/accept.ts';
const gold: StoryGold = { product: 'synthetic', build: 'Synthetic_10_6', scope: 'declared', status_nonscalar: 0, stage_nonscalar: 0, documents: 1, documents_without_cases: 0, missing_documents: [], traced: 1, untraced: 1, plm_unread: 1, statuses: [{ status: 'synthetic-state', count: 1 }], stories: [
  { story: '21', status: 'synthetic-state', stage: 'synthetic-stage', plm_returned: true, cases: [{ id: '91:c1', title: '合成用例' }] },
  { story: '22', status: null, stage: null, plm_returned: false, cases: [] },
] };
const text = '运行 run_synthetic\n完整结果 rec:' + 'a'.repeat(64) + '\n- 21 | 需求 21 | 1 个用例\n- 22 | 需求 22 | 无已索引用例（完整视图内）\n陈述：需求 21（状态：synthetic-state；阶段：synthetic-stage）：1 个已索引用例追溯：91:c1 合成用例；需求范围依据：声明\n陈述：需求 22（状态：应答未包含该编号；阶段：应答未包含该编号）：0 个已索引用例；PLM 应答里没有编号 22；在知识根中完整需求号键列表覆盖的索引视图里，没有条目携带需求号 22；不推断未索引用例\n陈述：需求 2 个：已追溯 1 个，未追溯 1 个；PLM 没返回 1 个；PLM 详情未读到 0 个；需求范围依据：声明；PLM 返回的状态不是单个值的有 0 个，没有按状态计数；PLM 返回的阶段不是单个值的有 0 个；原样状态计数：synthetic-state 1 个';
const turns = (value: string): LoggedTurn[] => [{ index: 0, tools: ['hub_start_run'], toolResults: [] }, { index: 1, tools: [], toolResults: [{ id: '1', text: value, isError: false }] }];
test('scenario checks individual rows and counts without disclosing ids, titles, state or build in check output', () => {
  const checks = scenario(gold).check(turns(text));
  assert.ok(checks.every(c => c.ok), JSON.stringify(checks));
  assert.doesNotMatch(JSON.stringify(checks), /91:c1|synthetic-state|Synthetic_10_6|合成用例|需求 21|需求 22/);
  for (const bad of [text.replace('91:c1', '91:wrong'), text.replace('1 个已索引用例追溯', '2 个已索引用例追溯'), text.replace('无已索引用例（完整视图内）', '2 个用例'), text.replace('无已索引用例（完整视图内）', '无已索引用例（未知）'), text.replace('阶段：synthetic-stage', '阶段：wrong'), text.replace('PLM 没返回 1 个', 'PLM 没返回 0 个'), text.replace('PLM 详情未读到 0 个', 'PLM 详情未读到 1 个'), text.replace('synthetic-state 1 个', 'wrong 1 个')]) {
    assert.ok(scenario(gold).check(turns(bad)).some(c => !c.ok));
  }
});
test('scenario starts batches and follows result cursors', () => {
  const s = scenario(gold);
  const first = s.respond({ index: 0, toolResults: [] } as any) as any;
  assert.equal(first[0].input.inputs.stories[0].external, 'plm:stories:21+22');
  const second = s.respond({ index: 1, toolResults: [{ text }] } as any) as any;
  assert.equal(second[0].tool, 'hub_get_nodes');
  const page = s.respond({ index: 2, toolResults: [{ text: '下一页：get_nodes {"reference":"rec:' + 'a'.repeat(64) + '","cursor":"next"}' }] } as any) as any;
  assert.equal(page[0].input.cursor, 'next');
});

test('non-scalar states must be counted separately and may not silently enter the null group', () => {
  const observed: StoryGold = { ...gold, status_nonscalar: 1, stage_nonscalar: 1, statuses: [], stories: [
    { ...gold.stories[0], status: null, stage: null, fields_nonscalar: ['status', 'stage'] }, gold.stories[1],
  ] };
  const shown = text.replace('状态：synthetic-state；阶段：synthetic-stage', '状态：PLM 返回的值不是单个值；阶段：PLM 返回的值不是单个值')
    .replace('状态不是单个值的有 0 个', '状态不是单个值的有 1 个')
    .replace('阶段不是单个值的有 0 个', '阶段不是单个值的有 1 个')
    .replace('原样状态计数：synthetic-state 1 个', '原样状态计数：');
  assert.ok(scenario(observed).check(turns(shown)).every(check => check.ok));
  for (const bad of [shown.replace('状态不是单个值的有 1 个', '状态不是单个值的有 0 个'), shown.replace('原样状态计数：', '原样状态计数：null 1 个')]) {
    assert.ok(scenario(observed).check(turns(bad)).some(check => !check.ok));
  }
});
