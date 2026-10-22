import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GoldEntry } from './inject.ts';
import { render, score, type ItemLike, type ResultLike } from './score.ts';

const item = (node: string, opts: { literal?: string; findings?: string[] } = {}): ItemLike => ({
  item: `doc:${node}`,
  requirements: [
    { requirement: 'literal', layers: [opts.literal === undefined ? { terminal: 'pass' } : { terminal: 'violation', code: opts.literal }], claims: [] },
    { requirement: 'findings', layers: [{ terminal: 'judgment' }], claims: (opts.findings ?? []).map((code) => ({ statement: { code, rank: 'major' } })).concat([{ statement: {} as { code: string; rank: string } }]) },
  ],
});
const result = (delivered: ItemLike[], incomplete: ItemLike[] = []): ResultLike => ({ partitions: { delivered, rejected: [], quarantined: [], incomplete } });

const gold: GoldEntry[] = [
  { label: '期望结果缺失', seen_by: 'mechanical', node: 'c3', note: '' },
  { label: '重复的用例', seen_by: 'mechanical', node: 'c1', copy: 'cc', note: '' },
  { label: '期望结果含糊', seen_by: 'judgment', node: 'c4', note: '' },
  { label: '用例放错分组', seen_by: 'judgment', node: 'c5', note: '' },
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
