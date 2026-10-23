// Tests of the review scoring (task gold-review step 3). Fixtures are synthetic run results; the mind maps behind
// the literal answers are synthetic too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GoldEntry, MindNode, MindTree } from './inject.ts';
import { aggregate, detail, render, score, type ItemLike, type ResultLike } from './score.ts';
import { literalGold } from '../gold/literal.ts';

const leaf = (id: string, text: string): MindNode => ({ data: { id, text }, children: [] });
const kase = (id: string, text: string, expected: string, tag = 'configuration'): MindNode => ({ data: { id, text, resource: [tag], priority: 2 }, children: [leaf(`${id}e`, expected)] });
const group = (id: string, text: string, ...children: MindNode[]): MindNode => ({ data: { id, text }, children });
const doc = (root: MindNode): MindTree => ({ root });

interface Req {
  requirement: string;
  layers: Array<{ terminal: string; code?: string; tier?: string; attribution?: string }>;
  claims: Array<{ statement: { code?: string; verdict?: string; data?: { probe?: string } }; qualifier?: { nature?: string } }>;
}

const req = (requirement: string, claims: Req['claims'], layer: Partial<Req['layers'][number]> = {}): Req => ({
  requirement,
  layers: [{ terminal: layer.terminal ?? 'pass', ...(layer.code === undefined ? {} : { code: layer.code }), ...(layer.attribution === undefined ? {} : { attribution: layer.attribution }) }],
  claims,
});

const item = (id: string, ...requirements: Req[]): ItemLike => ({ item: `run:x:case:${id}`, requirements });
const result = (delivered: ItemLike[], incomplete: ItemLike[] = []): ResultLike => ({ partitions: { delivered, rejected: [], quarantined: [], incomplete } });

const refute = (code: string): Req['claims'][number] => ({ statement: { verdict: 'refute', code }, qualifier: { nature: 'fact' } });
const judgment = (code: string): Req['claims'][number] => ({ statement: { code }, qualifier: { nature: 'judgment' } });

const entry = (over: Partial<GoldEntry>): GoldEntry => ({ label: '缺陷', seen_by: 'judgment', kind: 'replace_expected', node: 'c1', note: '', ...over });

test('a Hub refute inside the findings requirement is not a model finding; only judgment claims are', () => {
  const gold: GoldEntry[] = [entry({ node: 'c1' })];
  const hubRefuteOnly = score(gold, result([item('c1', req('findings', [{ statement: { code: 'core.structure.required_empty' }, qualifier: { nature: 'fact' } }]))]));
  assert.equal(hubRefuteOnly.detections[0]?.draft, false, 'a refuted fact claim is the Hub\'s, not a model finding');
  const withJudgment = score(gold, result([item('c1', req('findings', [{ statement: { code: 'core.structure.required_empty' }, qualifier: { nature: 'fact' } }, judgment('case-review.vague')]))]));
  assert.equal(withJudgment.detections[0]?.draft, true, 'a judgment claim with a code is the model\'s finding');
});

test('two refutes on one case both count; an expected refutation (unattributed) never marks', () => {
  const gold: GoldEntry[] = [entry({ seen_by: 'mechanical', kind: 'delete_expected', node: 'c1' })];
  const two = score(gold, result([item('c1',
    req('literal', [refute('core.structure.required_empty'), refute('core.structure.type_mismatch')], { terminal: 'violation', attribution: 'subject' }),
  )]));
  assert.deepEqual(two.detections[0]?.seen.marks.sort(), ['core.structure.required_empty', 'core.structure.type_mismatch']);
  const expected = score(gold, result([item('c1', req('literal', [refute('core.structure.required_empty')], { terminal: 'violation' }))]));
  assert.deepEqual(expected.detections[0]?.seen.marks, [], 'an expected refutation carries no attribution and is not a mark');
  assert.deepEqual(expected.detections[0]?.seen.unattributedRefutes, ['core.structure.required_empty']);
  assert.equal(expected.detections[0]?.mechanical, false);
});

test('structure marks on untouched cases: supported, false positive and missed, each against the independent answer', () => {
  const map = doc(group('r', '文档', group('g', '组',
    kase('a1', '甲', '  '),
    kase('b2', '', '成功'),
    kase('touched', '注入用例', '成功'),
  )));
  const answer = literalGold(map);
  const gold: GoldEntry[] = [entry({ node: 'touched', kind: 'replace_expected', seen_by: 'judgment' })];
  // The answer has a1 required_empty (its expectation is blank) and b2 required_empty (blank title).
  // Hub marks a1 required_empty (supported) and a1 duplicate_key (the answer does not have it: false positive);
  // Hub marks b2 type_mismatch (the answer does not have it: false positive) and misses b2 required_empty.
  const scored = score(gold, result([item('a1', req('literal', [refute('core.structure.required_empty'), refute('core.structure.duplicate_key')], { terminal: 'violation', attribution: 'subject' })), item('b2', req('literal', [refute('core.structure.type_mismatch')], { terminal: 'violation', attribution: 'subject' })), item('touched', req('literal', [], { terminal: 'violation', attribution: 'subject' }))]), { literal: answer });
  assert.deepEqual(scored.structure.supported, [{ node: 'a1', code: 'core.structure.required_empty' }]);
  assert.deepEqual(scored.structure.falsePositives, [{ node: 'a1', code: 'core.structure.duplicate_key' }, { node: 'b2', code: 'core.structure.type_mismatch' }]);
  assert.deepEqual(scored.structure.missed, [{ node: 'b2', code: 'core.structure.required_empty' }]);
});

test('a literal static layer that is neither pass nor violation is counted apart, never scored', () => {
  const scored = score([entry({ node: 'c1' })], result([item('c2', req('literal', [], { terminal: 'skipped' })), item('c1', req('findings', [judgment('case-review.vague')]))]));
  assert.equal(scored.literalUnscored, 1);
});

test('marks with no independent answer (tag_variant, catalog) are counted with their fresh ones', () => {
  const gold: GoldEntry[] = [entry({ node: 'c1' })];
  const base = result([item('c2', req('catalog', [refute('core.catalog.not_member')], { terminal: 'violation', attribution: 'subject' }))]);
  const now = result([item('c1', req('findings', [judgment('case-review.vague')])), item('c2', req('catalog', [refute('core.catalog.not_member')], { terminal: 'violation', attribution: 'subject' })), item('c3', req('literal', [refute('case-review.tag_variant')], { terminal: 'violation', attribution: 'subject' }))]);
  const scored = score(gold, now, { baseline: base });
  assert.equal(scored.otherMarks.total, 2);
  assert.equal(scored.otherMarks.fresh, 1, 'the baseline already had c2\'s catalog mark');
});

test('verify: a new finding is the verify\'s own, verified or partial confirms the draft, only refuted confirms nothing', () => {
  const gold: GoldEntry[] = [entry({ node: 'c1' }), entry({ node: 'c2', kind: 'replace_expected' }), entry({ node: 'c3', kind: 'replace_expected' })];
  const draft = result([
    item('c1', req('findings', [judgment('case-review.vague')])),
    item('c2', req('findings', [judgment('case-review.vague')])),
    item('c3', req('findings', [judgment('case-review.vague')])),
  ]);
  const verify = result([
    item('c1', req('verification', [{ statement: { code: 'refuted' } }])),
    item('c2', req('verification', [{ statement: { code: 'verified' } }])),
    item('c3', req('verification', [])),
  ]);
  const scored = score(gold, draft, { verify });
  const byNode = new Map(scored.detections.map((d) => [d.entry.node, d]));
  assert.equal(byNode.get('c1')?.draft, true);
  assert.equal(byNode.get('c1')?.combined, false, 'a finding only refuted does not survive');
  assert.equal(byNode.get('c2')?.confirmed, true);
  assert.equal(byNode.get('c2')?.combined, true);
  assert.equal(byNode.get('c3')?.combined, false, 'no disposition, no confirmation');

  const verifyNew = result([item('c3', req('verification', [{ statement: { code: 'new_finding', data: { probe: 'level_challenge' } } }]))]);
  const withNew = score(gold, draft, { verify: verifyNew });
  assert.equal(new Map(withNew.detections.map((d) => [d.entry.node, d])).get('c3')?.verify, true);
  assert.equal(new Map(withNew.detections.map((d) => [d.entry.node, d])).get('c3')?.combined, true);
});

test('a deleted negative group is found by a verify negative-gap or coverage-gap probe too', () => {
  const gold: GoldEntry[] = [entry({ kind: 'delete_negative_group', node: 'g', deletedCases: ['n1'] })];
  const draft = result([item('elsewhere', req('findings', [judgment('other')]))]);
  const verify = result([item('elsewhere', req('verification', [{ statement: { code: 'new_finding', data: { probe: 'negative_gap' } } }]))]);
  const scored = score(gold, draft, { verify });
  assert.equal(scored.detections[0]?.verify, true);
  assert.equal(scored.detections[0]?.detected, true);
});

test('gold without kind is refused with the re-inject hint', () => {
  const legacy = { label: '旧答案', seen_by: 'mechanical', node: 'c1', note: '' } as unknown as GoldEntry;
  assert.throws(() => score([legacy], result([])), /重新注入/);
});

test('aggregate: injections × valid runs per kind, four channels, one invalid run counted, unstable structure marks flagged', () => {
  const gold: GoldEntry[] = [
    entry({ seen_by: 'mechanical', kind: 'delete_expected', node: 'a' }),
    entry({ seen_by: 'judgment', kind: 'contradict_manual', node: 'b' }),
  ];
  const runA = result([
    item('a', req('literal', [refute('core.structure.required_empty')], { terminal: 'violation', attribution: 'subject' })),
    item('b', req('findings', [judgment('case-review.wrong_value')])),
    item('u', req('literal', [refute('core.structure.required_empty')], { terminal: 'violation', attribution: 'subject' })),
  ]);
  const runB = result([
    item('a', req('literal', [refute('core.structure.required_empty')], { terminal: 'violation', attribution: 'subject' })),
    item('b', req('findings', [])),
    item('u', req('literal', [refute('core.structure.duplicate_key')], { terminal: 'violation', attribution: 'subject' })),
  ]);
  const verifyB = result([item('b', req('verification', [{ statement: { code: 'new_finding', data: { probe: 'manual_check' } } }]))]);
  const runs = [
    { result: runA, valid: true },
    { result: runB, verify: verifyB, valid: true },
    { result: runA, valid: false },
  ];
  const totals = aggregate(gold, runs);
  assert.equal(totals.runs.valid, 2);
  assert.equal(totals.runs.total, 3);
  const byKind = new Map(totals.kinds.map((k) => [k.kind, k]));
  assert.deepEqual([byKind.get('delete_expected')?.injected, byKind.get('delete_expected')?.validRuns, byKind.get('delete_expected')?.mechanical], [1, 2, 2]);
  assert.deepEqual([byKind.get('contradict_manual')?.draft, byKind.get('contradict_manual')?.verify, byKind.get('contradict_manual')?.combined], [1, 1, 2]);
  assert.equal(totals.structureStable, false, 'the untouched case\'s mark differed between the two valid runs');
  const stable = aggregate(gold, [runs[0]!, runs[0]!]);
  assert.equal(stable.structureStable, true);
});

test('the screen lines carry no node ids, titles or texts; the detail file does', () => {
  const map = doc(group('r', '文档', group('g', '组', kase('c1', '标题甲', '成功'), kase('u9', '标题乙', '成功'))));
  const gold: GoldEntry[] = [entry({ node: 'c1' })];
  const scored = score(gold, result([
    item('c1', req('findings', [judgment('case-review.vague')])),
    item('u9', req('findings', [judgment('case-review.vague')]), req('literal', [refute('core.structure.required_empty')], { terminal: 'violation', attribution: 'subject' })),
  ]), { literal: literalGold(map) });
  const screen = render(scored).join('\n');
  for (const secret of ['c1', 'u9', '标题甲', '标题乙', 'run:x']) assert.ok(!screen.includes(secret), `the screen leaks ${secret}`);
  const file = detail(scored);
  assert.ok(file.includes('c1') && file.includes('u9'), 'the detail file names the nodes');
});
