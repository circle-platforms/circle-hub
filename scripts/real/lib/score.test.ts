import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GoldEntry } from './inject.ts';
import { render, score, type ItemLike, type ResultLike } from './score.ts';

const item = (node: string, opts: { literal?: string; catalog?: string; findings?: string[] } = {}): ItemLike => ({
  item: `doc:${node}`,
  requirements: [
    { requirement: 'literal', layers: [opts.literal === undefined ? { terminal: 'pass' } : { terminal: 'violation', code: opts.literal }], claims: [] },
    ...(opts.catalog === undefined ? [] : [{ requirement: 'catalog', layers: [{ terminal: 'violation', code: opts.catalog }], claims: [] }]),
    { requirement: 'findings', layers: [{ terminal: 'judgment' }], claims: (opts.findings ?? []).map((code) => ({ statement: { code, rank: 'major' } })).concat([{ statement: {} as { code: string; rank: string } }]) },
  ],
});
const result = (delivered: ItemLike[], incomplete: ItemLike[] = []): ResultLike => ({ partitions: { delivered, rejected: [], quarantined: [], incomplete } });

const gold: GoldEntry[] = [
  { label: '期望结果缺失', seen_by: 'mechanical', kind: 'delete_expected', node: 'c3', note: '' },
  { label: '重复的用例', seen_by: 'mechanical', kind: 'duplicate', node: 'c1', copy: 'cc', note: '' },
  { label: '期望结果含糊', seen_by: 'judgment', kind: 'replace_expected', node: 'c4', note: '' },
  { label: '用例放错分组', seen_by: 'judgment', kind: 'move', node: 'c5', note: '' },
];

test('a defect is found by the kind of check that is able to see it; the claims without a code are not findings', () => {
  const s = score(gold, result([item('c3', { literal: 'expected.required' }), item('c1'), item('cc', { literal: 'unique' }), item('c4', { findings: ['literal_issue'] }), item('c5')]));
  assert.deepEqual(s.recall, { mechanical: [2, 2], judgment: [1, 2] });
  assert.deepEqual(s.detections.map((d) => d.detected), [true, true, true, false]);
  assert.deepEqual(s.detections[1].seen.mechanical, ['unique'], 'a duplicate counts when either of the two is flagged');
});

test('a model finding on a case that was not injected is an extra; one the baseline also had is marked', () => {
  const baseline = result([item('c7', { findings: ['coverage_gap'] })]);
  const s = score(gold, result([item('c7', { findings: ['coverage_gap'] }), item('c8', { findings: ['edge_case_gap', 'negative_gap'] }), item('c9'), item('c4', { findings: ['x'] })]), baseline);
  assert.deepEqual(s.extras, [
    { node: 'c7', codes: ['coverage_gap'], inBaseline: true },
    { node: 'c8', codes: ['edge_case_gap', 'negative_gap'], inBaseline: false },
  ]);
});

test('an item that was not delivered is not reviewed, and its absence is told', () => {
  const s = score(gold, result([item('c3', { literal: 'e' })], [item('c4'), item('c5')]));
  assert.equal(s.detections[2].seen.reviewed, false);
  assert.equal(s.detections[3].detected, false);
  const text = render(s).join('\n');
  assert.match(text, /漏掉：期望结果含糊（c4）.*没有被评审到/);
  assert.match(text, /漏掉：用例放错分组（c5）/);
  assert.match(text, /Hub 自己的字面检查看得见的缺陷：查出 1\/2/);
});

test('a kind with no defects says so instead of dividing by zero', () => {
  const s = score(gold.filter((g) => g.seen_by === 'judgment'), result([]));
  assert.equal(s.recall.mechanical[1], 0);
  assert.match(render(s)[0], /查出 无/);
});

test('scoring nonexistent command injection against catalog check (positive and negative)', () => {
  const cmdGold: GoldEntry[] = [
    { label: '构建里不存在的命令', seen_by: 'mechanical', kind: 'replace_command_word', node: 'c1', from: 'add', to: 'insert_bogus', note: '' },
  ];
  const pos = score(cmdGold, result([item('c1', { catalog: 'core.catalog.membership_contradicted' })]));
  assert.equal(pos.recall.mechanical[0], 1);
  assert.equal(pos.recall.mechanical[1], 1);
  assert.equal(pos.detections[0].detected, true);
  assert.deepEqual(pos.detections[0].seen.mechanical, ['core.catalog.membership_contradicted']);
  assert.match(render(pos).join('\n'), /查出：构建里不存在的命令（c1）；字面检查 core\.catalog\.membership_contradicted/);

  const neg = score(cmdGold, result([item('c1')]));
  assert.equal(neg.recall.mechanical[0], 0);
  assert.equal(neg.recall.mechanical[1], 1);
  assert.equal(neg.detections[0].detected, false);
  assert.match(render(neg).join('\n'), /漏掉：构建里不存在的命令（c1）；字面检查 没有/);
});

test('scoring deleted negative group injection against model judgment (positive and negative)', () => {
  const negGroupGold: GoldEntry[] = [
    {
      label: '删掉一组反向用例',
      seen_by: 'judgment',
      kind: 'delete_negative_group',
      node: 'g_neg',
      deletedCases: ['c_neg1', 'c_neg2'],
      note: '删掉了只含反向用例的分组 g_neg',
    },
  ];

  const pos = score(negGroupGold, result([item('c1', { findings: ['negative_gap'] })]));
  assert.equal(pos.recall.judgment[0], 1);
  assert.equal(pos.recall.judgment[1], 1);
  assert.equal(pos.detections[0].detected, true);
  assert.ok(pos.detections[0].seen.findings.includes('negative_gap'));
  const posRender = render(pos).join('\n');
  assert.match(posRender, /查出：删掉一组反向用例（分组 g_neg，删掉用例 c_neg1、c_neg2）；模型发现 negative_gap/);

  const neg = score(negGroupGold, result([item('c1', { findings: ['literal_issue'] })]));
  assert.equal(neg.recall.judgment[0], 0);
  assert.equal(neg.recall.judgment[1], 1);
  assert.equal(neg.detections[0].detected, false);
  const negRender = render(neg).join('\n');
  assert.match(negRender, /漏掉：删掉一组反向用例（分组 g_neg，删掉用例 c_neg1、c_neg2）；模型发现 没有/);
});

