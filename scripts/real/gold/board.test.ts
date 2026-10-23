import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardGold } from './board.ts';
import scenario from '../accept/quality-board.ts';
import type { LoggedTurn } from '../lib/accept.ts';

const map = { root: { data: { text: '合成文档标题' }, children: [{ data: { id: 'c', text: '合成用例', resource: ['Negative'] } }] } };
const branch = (line: string, module: string, doc: string) => ({ id: line, label: `100：${line}`, children: [{ id: 'train', label: `101：${line}-R1`, children: [{ id: module, label: module, children: [{ id: doc, label: '合成标题' }] }] }] });
test('board independently groups two lines, invalid directories and absent tree documents', () => {
  const gold = boardGold({ product: 'synthetic', build: 'Synthetic_10_7', tree: [branch('10.7.0', '甲', 'a'), branch('10.8', '乙', 'b'), { id: 'x', label: '异常目录', children: [{ id: 'c', label: '文档' }] }], maps: ['a', 'b', 'c', 'd'].map((document) => ({ document, map })) });
  assert.deepEqual(gold.groups?.map((g) => [g.label, g.cases]), [['10.7/甲', 1], ['10.8/乙', 1], ['unplaced/unplaced', 2]]);
  assert.equal(gold.documents.not_in_tree, 1);
});
const gold = { product: 'synthetic', build: 'Synthetic_10_7', groups: [{ label: '10.7/甲', cases: 2, missing: 1, vague: 0, negative: 0 }, { label: '10.8/乙', cases: 1, missing: 0, vague: 0, negative: 1 }] };
const text = ['运行 run_1 完成', '- 10.7/甲 | 10.7/甲 | 用例 2 个；无期望结果 50.0%；含糊期望 0.0%；负面用例 0.0%', '- 10.8/乙 | 10.8/乙 | 用例 1 个；无期望结果 0.0%；含糊期望 0.0%；负面用例 100.0%', '合计：用例 3 个；无期望结果 1 个（33.3%）；含糊期望 0 个（0.0%）；负面用例 1 个（33.3%）。已索引的用例'].join('\n');
const turns = (text: string): LoggedTurn[] => [{ index: 1, tools: [], toolResults: [{ id: 'r', text, isError: false }] }];
test('scenario detects redistributed counts despite unchanged total, missing and extra groups, and hides labels', () => {
  const check = (s: string) => scenario(gold).check(turns(s));
  assert.ok(check(text).every((c) => c.ok), JSON.stringify(check(text)));
  assert.ok(check(text.replace('用例 2 个', '用例 1 个').replace('用例 1 个；无期望结果 0.0%', '用例 2 个；无期望结果 0.0%')).some((c) => !c.ok));
  assert.ok(check(text.replace(/^- 10.8[^\n]+\n/m, '')).some((c) => !c.ok));
  assert.ok(check(text + '\n- 10.9/额外 | 用例 1 个；无期望结果 0.0%；含糊期望 0.0%；负面用例 0.0%').some((c) => !c.ok));
  assert.doesNotMatch(JSON.stringify(check(text)), /甲|乙|合成文档/);
});

test('group count summaries compare counts as well as ratios', () => {
  const counted = text.replace('无期望结果 50.0%', '无期望结果 1 个（50.0%）').replace('含糊期望 0.0%', '含糊期望 0 个（0.0%）').replace('负面用例 0.0%', '负面用例 0 个（0.0%）');
  assert.ok(scenario(gold).check(turns(counted)).every((c) => c.ok));
  assert.ok(scenario(gold).check(turns(counted.replace('无期望结果 1 个（50.0%）', '无期望结果 2 个（50.0%）'))).some((c) => !c.ok));
});
