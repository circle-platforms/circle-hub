import assert from 'node:assert/strict';
import { test } from 'node:test';
import { caseNodes, firstCases, inject, type MindNode, type MindTree, type Planned } from './inject.ts';

const leaf = (id: string, text: string): MindNode => ({ data: { id, text }, children: [] });
const kase = (id: string, text: string, expected: string, tag = 'configuration'): MindNode => ({ data: { id, text, resource: [tag], priority: 2 }, children: [leaf(`${id}e`, expected)] });
const group = (id: string, text: string, ...children: MindNode[]): MindNode => ({ data: { id, text }, children });

// a synthetic document: two groups, five cases, one empty note node before the second group's cases
const document = (): MindTree => ({
  root: group('r', '文档', group('g1', '压力', kase('c1', '压力一', '设备正常', 'stress'), kase('c2', '压力二', '设备正常', 'stress')), group('g2', '配置', leaf('n1', '拓扑说明'), kase('c3', '生成甲', '生成甲成功'), kase('c4', '生成乙', '生成乙成功'), kase('c5', '不合法输入', '按默认处理', 'negative'))),
  template: 'default',
});

const textsOf = (node: MindNode): string[] => [node.data.text ?? '', ...(node.children ?? []).flatMap(textsOf)];

test('the case nodes are the tagged nodes in document order', () => {
  assert.deepEqual(caseNodes(document()).map((n) => n.data.id), ['c1', 'c2', 'c3', 'c4', 'c5']);
});

test('firstCases cuts the document after the n-th case and keeps the groups and notes before it', () => {
  const cut = firstCases(document(), 3);
  assert.deepEqual(caseNodes(cut).map((n) => n.data.id), ['c1', 'c2', 'c3']);
  assert.ok(textsOf(cut.root).includes('拓扑说明'), 'the note before the cut stays');
  assert.ok(!textsOf(cut.root).includes('生成乙'), 'the cases after the cut are gone');
  assert.deepEqual(caseNodes(document()).length, 5, 'the source is not changed');
  assert.equal(caseNodes(firstCases(document(), 99)).length, 5, 'a larger n keeps everything');
});

test('each operation does what it says, on a copy, and the gold names it', () => {
  const source = document();
  const plan: Planned[] = [
    { label: '期望结果缺失', seen_by: 'mechanical', op: { kind: 'delete_expected', node: 'c3' } },
    { label: '期望结果含糊', seen_by: 'judgment', op: { kind: 'replace_expected', node: 'c4', text: '成功' } },
    { label: '重复的用例', seen_by: 'mechanical', op: { kind: 'duplicate', node: 'c1' } },
    { label: '用例放错分组', seen_by: 'judgment', op: { kind: 'move', node: 'c5', to: 'g1' } },
  ];
  const { tree, gold } = inject(source, plan);
  assert.deepEqual(caseNodes(source).map((n) => n.data.id), ['c1', 'c2', 'c3', 'c4', 'c5'], 'the source is untouched');
  const byId = new Map(caseNodes(tree).map((n) => [n.data.id, n]));
  assert.deepEqual(byId.get('c3')?.children, [], 'c3 lost its expected result');
  assert.equal(byId.get('c4')?.children?.[0].data.text, '成功');
  const copy = gold.find((g) => g.label === '重复的用例')?.copy;
  assert.ok(copy !== undefined && copy !== 'c1' && /^[0-9a-f]{12}$/.test(copy), 'the copy has an id of its own');
  assert.equal(byId.get(copy)?.data.text, '压力一');
  assert.deepEqual(byId.get(copy)?.children?.map((c) => c.data.text), ['设备正常'], 'the copy is identical in content');
  assert.notEqual(byId.get(copy)?.children?.[0].data.id, 'c1e', 'a copied child has an id of its own too');
  const g1 = tree.root.children?.find((c) => c.data.id === 'g1');
  assert.ok(g1?.children?.some((c) => c.data.id === 'c5'), 'c5 moved under the first group');
  assert.ok(!tree.root.children?.find((c) => c.data.id === 'g2')?.children?.some((c) => c.data.id === 'c5'), 'and left the second');
  assert.deepEqual(gold.map((g) => [g.label, g.node, g.seen_by]), [
    ['期望结果缺失', 'c3', 'mechanical'],
    ['期望结果含糊', 'c4', 'judgment'],
    ['重复的用例', 'c1', 'mechanical'],
    ['用例放错分组', 'c5', 'judgment'],
  ]);
});

test('the same plan on the same document gives the same copy', () => {
  const plan: Planned[] = [{ label: 'x', seen_by: 'mechanical', op: { kind: 'duplicate', node: 'c2' } }];
  assert.deepEqual(inject(document(), plan), inject(document(), plan));
});

test('a plan that names a missing node, a group as a case, the root or a case as a target is refused', () => {
  const bad = (op: Planned['op']): void => assert.throws(() => inject(document(), [{ label: 'x', seen_by: 'judgment', op }]));
  bad({ kind: 'delete_expected', node: 'nope' });
  bad({ kind: 'delete_expected', node: 'g1' });
  bad({ kind: 'duplicate', node: 'r' });
  bad({ kind: 'move', node: 'c1', to: 'c2' });
});
