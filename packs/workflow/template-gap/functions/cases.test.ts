import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from '../testing/support.ts';
import { CASE_LIMITS, casePath, casesOf, idSelector, rawIdOf } from './cases.ts';
import { warningSink } from './common.ts';

type Node = { data: Record<string, unknown>; children?: Node[] };
const node = (id: string | null, text: string, extra: Record<string, unknown> = {}, ...children: Node[]): Node => ({ data: { ...(id === null ? {} : { id }), text, ...extra }, children });
const kase = (id: string | null, text: string, tags: unknown[] = ['Function'], ...children: Node[]): Node => node(id, text, { priority: 2, resource: tags }, ...children);
const leaf = (id: string | null, text: string, extra: Record<string, unknown> = {}): Node => node(id, text, extra);

/** Parses a document with the real kityminder@1 parser and takes its cases. */
function casesIn(root: Node, document = 'd1', options: { caseRule?: 'tagged' | 'marked' } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify({ root, template: 'right', theme: 'classic', version: '1.4.43' }));
  const parsed = parse(bytes);
  const warnings = warningSink();
  const out = casesOf(document, parsed.model.nodes, warnings, options);
  /** The cases with the texts of their ancestors in place of their node index. */
  const records = out.cases.map(({ visit, ...rest }) => ({ ...rest, path: casePath(out.nodes, { visit }) }));
  return { ...out, records, warnings: warnings.list(), parsed };
}

describe('the case rule (unified default marked, tagged switch)', () => {
  it('a tagged node is a case; groups, outlines and untagged leaves are not', () => {
    const { cases, untagged } = casesIn(
      node('r', '根', {}, node('g', '分组', { priority: 1 }, kase('c1', '用例一', ['Function'], leaf('e1', '期望一')), leaf('x', '说明', { priority: 2 })), node('o', '提纲'), kase('c2', '没有优先级的用例', ['Stress'])),
    );
    assert.deepEqual(
      cases.map((c) => [c.id, c.title, c.tags]),
      [
        ['d1:c1', '用例一', ['Function']],
        ['d1:c2', '没有优先级的用例', ['Stress']],
      ],
    );
    assert.equal(untagged, 0, 'an untagged priority-2 leaf is not written like a case');
  });

  it('default marked rule: untagged nodes written like cases are projected as cases with empty tags', () => {
    const { cases, untagged, warnings } = casesIn(
      node('r', '根', {}, node('g', '分组', { priority: 1 }, node('u1', '没有标签的用例', { priority: 2 }, leaf('u1e', '期望')), node('u2', '另一个', { priority: 2 }, leaf(null, '期望')), kase('c1', '有标签的用例', ['Function'], leaf('c1e', '期望')))),
    );
    assert.deepEqual(cases.map((c) => c.id), ['d1:u1', 'd1:u2', 'd1:c1']);
    assert.deepEqual(cases.find((c) => c.id === 'd1:u1')?.tags, []);
    assert.equal(untagged, 0);
  });

  it('tagged rule: counts untagged nodes written like cases without making them cases, and names them by their selectors', () => {
    const { cases, untagged, warnings, parsed } = casesIn(
      node('r', '根', {}, node('g', '分组', { priority: 1 }, node('u1', '没有标签的用例', { priority: 2 }, leaf('u1e', '期望')), node('u2', '另一个', { priority: 2 }, leaf(null, '期望')), kase('c1', '有标签的用例', ['Function'], leaf('c1e', '期望')))),
      'd1',
      { caseRule: 'tagged' },
    );
    assert.deepEqual(cases.map((c) => c.id), ['d1:c1']);
    assert.equal(untagged, 2);
    const warning = warnings.find((w) => w.code === 'template-gap.untagged_cases');
    assert.deepEqual(warning?.data, { count: 2, nodes: ['n/u1', 'n/u2'] });
    for (const selector of warning?.data?.nodes as string[]) assert.ok(parsed.locate(selector) !== null, selector);
    // An untagged priority-2 node that holds a tagged node is a group, not a candidate.
    assert.equal(casesIn(node('r', '根', {}, node('u', '外层', { priority: 2 }, kase('c', '内层'))), 'd1', { caseRule: 'tagged' }).untagged, 0);
  });

  it('a tagged node with the group priority that holds cases is a group; without cases below it is a case (both directions of README deviation 5)', () => {
    const tagged = (...children: Node[]): Node => node('tg', '带标签的分组', { priority: 1, resource: ['Function'] }, ...children);
    const grouped = casesIn(node('r', '根', {}, tagged(kase('c1', '里面的用例', ['Stress'], leaf('e', '期望')))));
    assert.deepEqual(grouped.records.map((c) => [c.id, c.path]), [['d1:c1', ['根', '带标签的分组']]]);
    const warning = grouped.warnings.find((w) => w.code === 'template-gap.tagged_group');
    assert.deepEqual(warning?.data, { count: 1, nodes: ['n/tg'] });
    assert.equal(grouped.parsed.locate('n/tg')?.text, '带标签的分组');
    // Removal: with the case below it gone the node becomes a case, so its tag shows a category again.
    const emptied = casesIn(node('r', '根', {}, tagged(leaf('e', '期望'))));
    assert.deepEqual(emptied.records.map((c) => [c.id, c.tags, c.expected]), [['d1:tg', ['Function'], ['期望']]]);
    assert.equal(emptied.warnings.find((w) => w.code === 'template-gap.tagged_group'), undefined);
    // Addition: a case added below a node that was a case turns it into a group, and its tag stops counting.
    const stressNode = (...children: Node[]): Node => node('ts', '压力', { priority: 1, resource: ['Stress'] }, ...children);
    const before = casesIn(node('r', '根', {}, stressNode(leaf('l', '叶子'))));
    const after = casesIn(node('r', '根', {}, stressNode(leaf('l', '叶子'), kase('f2', '功能二', ['Function']))));
    assert.deepEqual([before.records.map((c) => c.id), after.records.map((c) => c.id)], [['d1:ts'], ['d1:f2']]);
    // Inside a case a tagged node is a case of its own, whatever its priority.
    const nested = casesIn(node('r', '根', {}, kase('c', '外层', ['Function'], node('n1', '内层', { priority: 1, resource: ['Stress'] }, leaf('e', '期望')))));
    assert.deepEqual(nested.records.map((c) => [c.id, c.path]), [['d1:c', ['根']], ['d1:n1', ['根', '外层']]]);
    assert.equal(nested.warnings.find((w) => w.code === 'template-gap.tagged_group'), undefined);
  });

  it('inside a case: preconditions, steps and expected results; a tagged node below a case is a case of its own', () => {
    const { records } = casesIn(
      node(
        'r',
        '根',
        {},
        kase(
          'c1',
          '外层用例',
          ['Function'],
          leaf('p', '前置条件', { priority: 3 }),
          node('s1', '步骤一', {}, leaf('s1e', '步骤一的期望'), node('s1x', '中间节点', {}, leaf('s1xe', '更深的期望'))),
          leaf('e1', '直接的期望'),
          kase('n1', '内层用例', ['Negative'], leaf('n1e', '内层期望'), leaf('n1p', '内层前置', { priority: 3 })),
        ),
      ),
    );
    assert.deepEqual(records, [
      { id: 'd1:c1', nodeId: 'c1', path: ['根'], title: '外层用例', tags: ['Function'], resource: ['Function'], steps: ['步骤一'], expected: ['步骤一的期望', '更深的期望', '直接的期望'], preconditions: ['前置条件'] },
      { id: 'd1:n1', nodeId: 'n1', path: ['根', '外层用例'], title: '内层用例', tags: ['Negative'], resource: ['Negative'], steps: [], expected: ['内层期望'], preconditions: ['内层前置'] },
    ]);
  });

  it('keeps tags as written (text only) and reports tags that are not text', () => {
    const { cases, warnings } = casesIn(node('r', '根', {}, kase('c1', '用例', ['[Function', 7, null, { x: 1 }, true])));
    // 标签只留原文里的字符串。数字、布尔、空值和对象都算不是文字，不再转成 "7" 或 "true"。
    assert.deepEqual(cases[0].tags, ['[Function']);
    assert.deepEqual(warnings.find((w) => w.code === 'template-gap.tag_not_text')?.data, { count: 4 });
  });
});

describe('case identities (case-review numbering, W01 R[2])', () => {
  it('numbers copies of a shared id in document order and positions cases without a usable id', () => {
    const long = 'x'.repeat(CASE_LIMITS.maxItemId);
    const { cases, warnings } = casesIn(node('r', '根', {}, kase('dup', '副本一'), kase('dup', '副本二'), kase(null, '没有编号'), kase(long, '编号太长'), kase('ok', '正常')));
    assert.deepEqual(cases.map((c) => c.id), ['d1:dup#1', 'd1:dup#2', 'd1:@3', 'd1:@4', 'd1:ok']);
    assert.deepEqual(warnings.map((w) => w.code), ['template-gap.node_id_duplicate', 'template-gap.node_id_missing', 'template-gap.node_id_unusable']);
  });

  it('a pack identity never takes the id another node really has', () => {
    // Node 2 has no id; another node's id is "@2", so the positional identity of node 2 moves on.
    const { cases } = casesIn(node('r', '根', {}, leaf('@2', '编号像位置的节点'), kase(null, '没有编号的用例'), kase('dup#1', '编号像副本的用例'), kase('dup', '副本一'), kase('dup', '副本二')));
    assert.deepEqual(cases.map((c) => c.id), ['d1:@2#2', 'd1:dup#1', 'd1:dup#2', 'd1:dup#3']);
  });

  it('addresses a node by its id only when the parser would', () => {
    const { ids, rootId, parsed } = casesIn(node('root id', '根', {}, kase('a/b:c', '用例'), kase('twice', '一'), kase('twice', '二'), kase('@x', '三')));
    assert.equal(rootId, 'root id');
    for (const n of parsed.model.nodes) {
      const selector = idSelector(n.id, ids);
      if (selector !== null) assert.equal(selector, n.selector, String(n.id));
      else assert.match(n.selector, /^i(\/|$)/, String(n.id));
    }
    assert.equal(idSelector('twice', ids), null);
    assert.equal(idSelector('@x', ids), null);
    assert.equal(idSelector(null, ids), null);
    assert.equal(rawIdOf({ id: 42 }), '42');
    assert.equal(rawIdOf({ id: '' }), null);
  });
});
