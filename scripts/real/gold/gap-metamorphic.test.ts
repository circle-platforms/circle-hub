// Tests of the metamorphic copies and expectations (task gold-template-gap step 4), synthetic mind maps only, no
// Hub and no pack imports beyond the table file read with JSON.parse.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MindNode, MindTree } from './gap-metamorphic.ts';
import { TYPE_NAMES, expectedMissing, outerCases, outerCaseIdsOf, planCopies as planByKey, premiseOf, readCategories, reversed, singleCase as singleByKey, typeNamePresent, withJoined as joinByKey, withRestored as restoreByKey, withoutCategory as withoutByKey } from './gap-metamorphic.ts';
import { caseNodesOf, parseMindMap } from './cases.ts';

const leaf = (id: string, text: string): MindNode => ({ data: { id, text }, children: [] });
const kase = (id: string, text: string, expected: string, tag = 'configuration'): MindNode => ({ data: { id, text, resource: [tag], priority: 2 }, children: [leaf(`${id}e`, expected)] });
const group = (id: string, text: string, ...children: MindNode[]): MindNode => ({ data: { id, text }, children });
const doc = (root: MindNode): MindTree => ({ root, template: 'default' });

// Readable unique-id fixture aliases; the implementation and scenario use parsed indices exclusively.
const keyOf = (tree: MindTree, id: string): string => String(parseMindMap(tree).nodes.find(node => node.id === id)!.index);
const keyed = (tree: MindTree, values: ReadonlyMap<string, ReadonlySet<string>>) => new Map([...values].map(([id, set]) => [keyOf(tree, id), set]));
const singleCase = (tree: MindTree, id: string, seed: string) => singleByKey(tree, keyOf(tree, id), seed);
const withoutCategory = (tree: MindTree, values: ReadonlyMap<string, ReadonlySet<string>>, category: string, seed: string) => withoutByKey(tree, keyed(tree, values), category, seed);
const withRestored = (tree: MindTree, removed: readonly string[], id: string, original: MindTree, seed: string) => restoreByKey(tree, removed.map(id => keyOf(original, id)), keyOf(original, id), original, seed);
const withJoined = (a: MindTree, b: MindTree, category: string, values: ReadonlyMap<string, ReadonlySet<string>>, seed: string) => joinByKey(a, b, category, keyed(b, values), seed);
const planCopies = (tree: MindTree, seed: string, options: import('./gap-metamorphic.ts').PlanOptions) => planByKey(tree, seed, { ...options, singleMisses: keyed(tree, options.singleMisses), ...(options.other ? { other: { tree: options.other.tree, singleMisses: keyed(options.other.tree, options.other.singleMisses) } } : {}) });

/** A synthetic table: two type-label categories and two keyword categories. */
const CATEGORIES = [
  { id: 'functional', label: 'Functional', group: 'test_type' },
  { id: 'negative', label: 'Negative', group: 'test_type' },
  { id: 'stress', label: 'Stress', group: 'test_type' },
  { id: 'k-perf', label: '性能', group: 'keyword' },
  { id: 'k-reli', label: '可靠性', group: 'keyword' },
];

test('readCategories takes id, label and group from the pack table and nothing else', () => {
  const table = JSON.parse(readFileSync(join(import.meta.dirname, '../../../packs/workflow/template-gap/tables/template-v3.json'), 'utf8'));
  const categories = readCategories(table);
  assert.equal(categories.length, 24);
  assert.equal(categories.filter((c) => c.group === 'test_type').length, 6, 'the six type-label categories');
  const source = readFileSync(join(import.meta.dirname, 'gap-metamorphic.ts'), 'utf8');
  for (const forbidden of ['tags', 'contains', 'prefixes', 'equals', 'fields']) {
    assert.ok(!source.includes(`.${forbidden}`), `the source reads the pack's ${forbidden}`);
  }
});

test('reversed renews the root id and reverses children at every level', () => {
  const tree = doc(group('r', '根', group('g1', '一', kase('c1', '甲', '成功')), group('g2', '二', kase('c2', '乙', '成功'))));
  const b = reversed(tree, 's');
  assert.match(b.root.data.id ?? '', /^gap-s/);
  assert.deepEqual(b.root.children?.map((c) => c.data.id), ['g2', 'g1']);
  assert.deepEqual(b.root.children?.[0]?.children?.map((c) => c.data.id), ['c2']);
  assert.deepEqual(tree.root.children?.map((c) => c.data.id), ['g1', 'g2'], 'the original is untouched');
  assert.equal(b.template, 'default', 'the rest of the document rides along');
});

test('singleCase keeps the root, the ancestor chain (each ancestor only the path child) and the whole subtree', () => {
  const inner = kase('c2i', '内层', '成功');
  const tree = doc(group('r', '根', group('g1', '一', kase('c1', '甲', '成功'), kase('c2', '乙', '成功', 'stress')), group('g2', '二', kase('c3', '丙', '成功'))));
  (tree.root.children?.[0]?.children?.[1] as MindNode).children = [...(tree.root.children?.[0]?.children?.[1]?.children ?? []), inner];
  const c = singleCase(tree, 'c2', 's2');
  assert.match(c.root.data.id ?? '', /^gap-s2/);
  assert.deepEqual(c.root.children?.map((x) => x.data.id), ['g1'], 'only the path group stays');
  assert.deepEqual(c.root.children?.[0]?.children?.map((x) => x.data.id), ['c2'], 'only the case stays in it');
  const caseNode = c.root.children?.[0]?.children?.[0] as MindNode;
  assert.deepEqual(caseNode.children?.map((x) => x.data.id), ['c2e', 'c2i'], 'the whole subtree, the nested case included');
  // A nested case belongs to the outermost one: single-case copies exist only for outermost cases.
  assert.deepEqual(outerCaseIdsOf(tree), ['c1', 'c2', 'c3']);
});

test('withoutCategory drops exactly the cases whose single-case copy has X, keeping the others', () => {
  const tree = doc(group('r', '根', group('g', '组', kase('c1', '甲', '成功'), kase('c2', '乙', '成功'), kase('c3', '丙', '成功'))));
  const misses = new Map([['c1', new Set(['k-perf'])], ['c2', new Set<string>()], ['c3', new Set(['k-perf', 'negative'])]]);
  const d = withoutCategory(tree, misses, 'k-perf', 'sd');
  assert.deepEqual(outerCaseIdsOf(d), ['c1', 'c3'], 'c2 alone shows k-perf (its missing set is empty) and goes');
  const nothing = withoutCategory(tree, new Map([['c1', new Set(['functional'])]]), 'functional', 'sd2');
  assert.deepEqual(outerCaseIdsOf(nothing), ['c1', 'c2', 'c3'], 'a case with an unknown answer is never dropped (c1 lacks functional, c2 and c3 unknown)');
});

test('withRestored puts the case back under its original parent, in place', () => {
  const tree = doc(group('r', '根', group('g', '组', kase('c1', '甲', '成功'), kase('c2', '乙', '成功'))));
  const misses = new Map([['c1', new Set<string>()], ['c2', new Set(['k-perf'])]]);
  const d = withoutCategory(tree, misses, 'k-perf', 'sd');
  const e = withRestored(d, ['c1'], 'c1', tree, 'se');
  assert.deepEqual(outerCaseIdsOf(e), ['c2', 'c1']);
  assert.deepEqual(e.root.children?.[0]?.children?.map((x) => x.data.id), ['c2', 'c1'], 'back under the same group');
});

test('withJoined hangs B\'s chain under A\'s root last, B\'s root an ordinary node with a new id', () => {
  const a = doc(group('ra', 'A', group('ga', '组甲', kase('a1', '甲用例', '成功'))));
  const b = doc(group('rb', 'B', group('gb', '组乙', kase('b1', '乙用例', '成功', 'stress'))));
  const f = withJoined(a, b, 'negative', new Map([['b1', new Set<string>()]]), 'sf');
  const hung = f.root.children?.at(-1) as MindNode;
  assert.equal(hung.data.id, `gap-joined-sf`);
  assert.equal(hung.data.resource, undefined, 'B\'s root arrives as an ordinary node');
  assert.deepEqual(hung.children?.map((x) => x.data.id), ['gb']);
  assert.deepEqual(hung.children?.[0]?.children?.map((x) => x.data.id), ['b1']);
  assert.deepEqual(outerCaseIdsOf(f), ['a1', 'b1'], 'A\'s cases and B\'s case both count');
});

test('a tagged group that became a case after deletion breaks the premise and is detected by premiseOf', () => {
  // The group carries a tag and priority 1 with cases below: a group. Delete every case and it becomes a case
  // (deviation 5): the copy's case count no longer equals the sum of its single-case counts.
  const tree = doc(group('r', '根', { data: { id: 'g', text: '带标签的组', resource: ['configuration'], priority: 1 }, children: [kase('c1', '甲', '成功'), kase('c2', '乙', '成功')] }));
  assert.deepEqual(outerCaseIdsOf(tree), ['c1', 'c2'], 'g is a group while it holds cases');
  const misses = new Map([['c1', new Set<string>()], ['c2', new Set<string>()]]);
  const d = withoutCategory(tree, misses, 'k-perf', 'sd');
  const premise = premiseOf(d, []);
  assert.equal(premise.ok, false);
  assert.equal(premise.actual, 1, 'the emptied group became one case');
});

test('planCopies skips X on every case and X nobody shows, and records the reason', () => {
  const tree = doc(group('r', '根', group('g', '组', kase('c1', '甲', '成功'), kase('c2', '乙', '成功'))));
  // Every case shows everything except k-reli: k-perf is on every case (skip), nothing shows k-reli (not present in a).
  const misses = new Map([['c1', new Set(['k-reli'])], ['c2', new Set(['k-reli'])]]);
  const plan = planCopies(tree, 's', { categories: CATEGORIES, singleMisses: misses });
  const dPerf = plan.d.find((entry) => entry.category === 'k-perf');
  assert.equal(dPerf && 'skipped' in dPerf && dPerf.skipped.reason, 'X 在每个最外层用例上都有');
  assert.ok(!plan.d.some((entry) => entry.category === 'k-reli'), 'a category absent in the original gets no d copy');
  const withUnknown = planCopies(tree, 's2', { categories: CATEGORIES, singleMisses: new Map([['c1', new Set(['k-reli'])]]) });
  assert.ok(withUnknown.d.every((entry) => 'skipped' in entry && entry.skipped.reason === '单用例副本答案未知') || withUnknown.d.some((entry) => 'copy' in entry), 'an unknown answer is recorded, never guessed');
  assert.equal(withUnknown.undecided.length, 1);
});

test('expectedMissing intersects and typeNamePresent names the six type names case-insensitively', () => {
  const sets = [new Set(['a', 'b']), new Set(['b', 'c']), new Set(['b'])];
  assert.deepEqual([...expectedMissing(sets)].sort(), ['b']);
  assert.deepEqual([...expectedMissing([])], []);
  const tree = doc(group('r', '根', group('g', '组', { data: { id: 'c1', text: '甲', resource: ['FUNCTIONAL'], priority: 2 }, children: [leaf('c1e', '成功')] }, kase('c2', '乙', '成功', 'Stress'))));
  const present = typeNamePresent(tree, CATEGORIES);
  assert.deepEqual([...(present.get(keyOf(tree, 'c1')) ?? [])], ['functional']);
  assert.deepEqual([...(present.get(keyOf(tree, 'c2')) ?? [])], ['stress']);
  assert.equal(TYPE_NAMES.length, 6);
});

test('the whole plan on a two-document join: f copies exist for A-missing categories B shows', () => {
  const a = doc(group('ra', 'A', group('ga', '组甲', kase('a1', '甲用例', '成功'))));
  const b = doc(group('rb', 'B', group('gb', '组乙', kase('b1', '乙用例', '成功', 'stress'))));
  const aMisses = new Map([['a1', new Set(['negative', 'k-perf'])]]);
  const bMisses = new Map([['b1', new Set(['k-perf'])]]);
  const plan = planCopies(a, 'sa', { categories: CATEGORIES, singleMisses: aMisses, other: { tree: b, singleMisses: bMisses } });
  const fNegative = plan.f.find((entry) => entry.category === 'negative');
  assert.ok(fNegative !== undefined && 'copy' in fNegative, 'negative is missing in A and shown by B');
  const fPerf = plan.f.find((entry) => entry.category === 'k-perf');
  assert.equal(fPerf && 'skipped' in fPerf && fPerf.skipped.reason, '没有单用例副本显示 X');
  assert.ok(!plan.f.some((entry) => entry.category === 'functional'), 'a category A already has gets no f copy');
});

test('outerCases follows the independent rule: tagged nodes and marked cases, outermost only', () => {
  const marked = { data: { id: 'm1', text: '标记用例', priority: 2 }, children: [leaf('m1e', '成功')] };
  const tree = doc(group('r', '根', group('g', '组', kase('c1', '甲', '成功'), marked)));
  assert.deepEqual(outerCases(tree).map((n) => n.data.id), ['c1', 'm1']);
  const tagged = caseNodesOf(parseMindMap(tree), { caseRule: 'tagged' });
  assert.deepEqual(tagged.map((n) => n.id), ['c1'], 'under tagged the marked case is not a case');
});

test('review 3: a renewed root never reuses an id already present in the original tree', () => {
  const tree = doc(group('r', '合成', kase('gap-doc1-a', '合成用例', '合成期望')));
  const plan = planCopies(tree, 'doc1', { categories: CATEGORIES, singleMisses: new Map() });
  assert.notEqual(plan.a.root.data.id, 'gap-doc1-a');
});

test('review 4: presence is the complement of the intersection, including heterogeneous donor cases', () => {
  const categories = [{ id: 'configuration', label: '配置', group: 'test_type' }, { id: 'security', label: '安全', group: 'other' }, { id: 'database', label: '数据库', group: 'other' }];
  const a = doc(group('ra', '合成甲', group('ga', '组', kase('a1', '甲一', '成功'), kase('a2', '甲二', '成功'))));
  const b = doc(group('rb', '合成乙', group('gb', '组', kase('b1', '乙一', '成功'), kase('b2', '乙二', '成功'))));
  const plan = planCopies(a, 'review4', { categories, singleMisses: new Map([['a1', new Set(['database'])], ['a2', new Set(['database', 'security'])]]), other: { tree: b, singleMisses: new Map([['b1', new Set(['security'])], ['b2', new Set(['security', 'database'])]]) } });
  assert.ok(plan.d.some(entry => entry.category === 'security' && 'copy' in entry));
  assert.ok(plan.f.some(entry => entry.category === 'database' && 'copy' in entry));
  assert.ok(!plan.f.some(entry => entry.category === 'security'));
});

test('review 12: a root child is restored after the copy root is renewed', () => {
  const original = doc(group('private-root', '合成根', kase('c1', '甲', '成功'), kase('c2', '乙', '成功')));
  const d = withoutCategory(original, new Map([['c1', new Set<string>()], ['c2', new Set(['security'])]]), 'security', 'review12-d');
  const e = withRestored(d, ['c1'], 'c1', original, 'review12-e');
  assert.deepEqual(outerCaseIdsOf(e), ['c2', 'c1']);
});

test('review 13: duplicate and missing node ids produce four distinct single-case copies', () => {
  const tree = doc(group('r', '合成', kase('dup', '第一', '成功'), kase('dup', '第二', '成功'), kase('', '第三', '成功'), kase('', '第四', '成功')));
  const plan = planCopies(tree, 'review13', { categories: CATEGORIES, singleMisses: new Map() });
  assert.deepEqual(plan.c.map(copy => outerCases(copy)[0]?.data.text), ['第一', '第二', '第三', '第四']);
});

test('review 8: joining is skipped if any base-document single-case answer is unknown', () => {
  const a = doc(group('ra', '甲', kase('a1', '甲一', '成功'), kase('a2', '甲二', '成功')));
  const b = doc(group('rb', '乙', kase('b1', '乙一', '成功')));
  const plan = planCopies(a, 'review8', { categories: CATEGORIES, singleMisses: new Map([['a1', new Set(['negative'])]]), other: { tree: b, singleMisses: new Map([['b1', new Set<string>()]]) } });
  const candidate = plan.f.find(entry => entry.category === 'negative');
  assert.ok(candidate && 'skipped' in candidate && candidate.skipped.reason === '单用例副本答案未知');
});

test('review 11: transformation errors never echo a supplied node identifier', () => {
  const tree = doc(group('r', '合成', kase('c1', '合成用例', '成功')));
  assert.throws(() => singleByKey(tree, 'PRIVATE-SYNTHETIC-NODE', 'review11'), (error: unknown) => error instanceof Error && !error.message.includes('PRIVATE-SYNTHETIC-NODE'));
});
