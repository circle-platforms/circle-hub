import type { Attribution, StaticTerminal, Reason, CheckTier } from '../../../contracts/generated/vocabulary.ts';
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
  layers: Array<{ terminal: StaticTerminal; code?: string; tier?: CheckTier; attribution?: Attribution; reason?: Reason }>;
  claims: ItemLike['requirements'][number]['claims'];
}

const req = (requirement: string, claims: Req['claims'], layer: Partial<Req['layers'][number]> = {}): Req => ({
  requirement,
  layers: [{ terminal: layer.terminal ?? 'pass', ...(layer.code === undefined ? {} : { code: layer.code }), ...(layer.attribution === undefined ? {} : { attribution: layer.attribution }), ...(layer.reason === undefined ? {} : { reason: layer.reason }) }],
  claims,
});

const item = (id: string, ...requirements: Req[]): ItemLike => ({ item: `run:x:case:${id}`, requirements });
const result = (delivered: ItemLike[], incomplete: ItemLike[] = []): ResultLike => ({ partitions: { delivered, rejected: [], quarantined: [], incomplete } });

const refute = (code: string): Req['claims'][number] => ({ statement: { verdict: 'refute', code }, qualifier: { nature: 'fact', source_role: 'subject' } });
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
    req('literal', [refute('core.structure.required_empty'), refute('core.structure.type_mismatch')], { terminal: 'violation', attribution: 'author_input' }),
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
  const scored = score(gold, result([item('a1', req('literal', [refute('core.structure.required_empty'), refute('core.structure.duplicate_key')], { terminal: 'violation', attribution: 'author_input' })), item('b2', req('literal', [refute('core.structure.type_mismatch')], { terminal: 'violation', attribution: 'author_input' })), item('touched', req('literal', [], { terminal: 'violation', attribution: 'author_input' }))]), { literal: answer });
  assert.deepEqual(scored.structure.supported, [{ node: 'a1', code: 'core.structure.required_empty' }]);
  assert.deepEqual(scored.structure.falsePositives, [{ node: 'a1', code: 'core.structure.duplicate_key' }, { node: 'b2', code: 'core.structure.type_mismatch' }]);
  assert.deepEqual(scored.structure.missed, [{ node: 'b2', code: 'core.structure.required_empty' }]);
});

test('a literal static layer that is neither pass nor violation is counted apart, never scored', () => {
  const scored = score([entry({ node: 'c1' })], result([item('c2', req('literal', [], { terminal: 'incomplete', reason: 'declared_skip' })), item('c1', req('findings', [judgment('case-review.vague')]))]));
  assert.equal(scored.literalUnscored, 1);
});

test('marks with no independent answer (tag_variant, catalog) are counted with their fresh ones', () => {
  const gold: GoldEntry[] = [entry({ node: 'c1' })];
  const base = result([item('c2', req('catalog', [refute('core.catalog.not_member')], { terminal: 'violation', attribution: 'author_input' }))]);
  const now = result([item('c1', req('findings', [judgment('case-review.vague')])), item('c2', req('catalog', [refute('core.catalog.not_member')], { terminal: 'violation', attribution: 'author_input' })), item('c3', req('literal', [refute('case-review.tag_variant')], { terminal: 'violation', attribution: 'author_input' }))]);
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
    item('a', req('literal', [refute('core.structure.required_empty')], { terminal: 'violation', attribution: 'author_input' })),
    item('b', req('findings', [judgment('case-review.wrong_value')])),
    item('u', req('literal', [refute('core.structure.required_empty')], { terminal: 'violation', attribution: 'author_input' })),
  ]);
  const runB = result([
    item('a', req('literal', [refute('core.structure.required_empty')], { terminal: 'violation', attribution: 'author_input' })),
    item('b', req('findings', [])),
    item('u', req('literal', [refute('core.structure.duplicate_key')], { terminal: 'violation', attribution: 'author_input' })),
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
    item('u9', req('findings', [judgment('case-review.vague')]), req('literal', [refute('core.structure.required_empty')], { terminal: 'violation', attribution: 'author_input' })),
  ]), { literal: literalGold(map) });
  const screen = render(scored).join('\n');
  for (const secret of ['c1', 'u9', '标题甲', '标题乙', 'run:x']) assert.ok(!screen.includes(secret), `the screen leaks ${secret}`);
  const file = detail(scored);
  assert.ok(file.includes('c1') && file.includes('u9'), 'the detail file names the nodes');
});


test('catalog refutations of model command statements stay separate from subject marks', () => {
  const commandClaim: Req['claims'][number] = { statement: { verdict: 'refute', code: 'core.catalog.not_member' }, qualifier: { nature: 'fact', source_role: 'artifact_under_verification' } };
  const subjectClaim: Req['claims'][number] = { statement: { verdict: 'refute', code: 'core.catalog.param_out_of_range' }, qualifier: { nature: 'fact', source_role: 'subject' } };
  const layer: Req['layers'][number] = { terminal: 'violation', attribution: 'author_input' };
  const gold = [entry({ node: 'c1', seen_by: 'mechanical', kind: 'replace_command_word' })];
  const onlyModel = score(gold, result([item('c1', req('catalog', [commandClaim], layer))]));
  assert.equal(onlyModel.detections[0]!.mechanical, false);
  assert.deepEqual(onlyModel.detections[0]!.seen.marks, []);
  assert.deepEqual(onlyModel.detections[0]!.seen.modelStatementRefutes, ['core.catalog.not_member']);
  const mixed = score(gold, result([item('c1', req('catalog', [commandClaim, subjectClaim,
    { statement: { verdict: 'refute', code: 'synthetic.judgment' }, qualifier: { nature: 'judgment', source_role: 'subject' } },
    { statement: { verdict: 'refute', code: 'synthetic.no_role' }, qualifier: { nature: 'fact' } },
  ], layer))]));
  assert.deepEqual(mixed.detections[0]!.seen.marks, ['core.catalog.param_out_of_range']);
  assert.equal(mixed.detections[0]!.draft, false);
});

test('missing and duplicate raw node ids are excluded despite Hub positional and suffixed identities', () => {
  const tree = doc(group('r', '合成文档', group('g', '合成分组',
    kase('same', '第一份', '期望甲'), kase('same', '第二份', '期望乙'),
    { data: { text: '缺少编号', priority: 2, resource: ['configuration'] }, children: [leaf('missing-e', '期望丙')] },
    kase('healthy', '健康用例', '期望丁'),
  )));
  const answer = literalGold(tree);
  const judged = result(['same#1', 'same#2', '@6'].map(id => item(id,
    req('literal', [refute(id.startsWith('@') ? 'core.structure.required_empty' : 'core.structure.duplicate_key')], { terminal: 'violation', attribution: 'author_input' }),
    req('catalog', [refute('core.catalog.not_member')], { terminal: 'violation', attribution: 'author_input' }),
    req('findings', [judgment('synthetic.finding')]),
  )).concat(item('healthy', req('literal', [], { terminal: 'pass' }))));
  const scored = score([], judged, { literal: answer });
  assert.equal(scored.noUniqueId, 3);
  assert.deepEqual(scored.structure, { supported: [], falsePositives: [], missed: [] });
  assert.equal(scored.otherMarks.total, 0);
  assert.deepEqual(scored.extras, []);
  assert.match(render(scored).join('\n'), /data.id 缺失或重复/);
  assert.match(detail(scored), /same.*data.id 重复/);
  assert.match(detail(scored), /@6.*data.id 缺失/);
});

test('unidentifiable injected nodes are excluded from recall and repeated aggregate denominators', () => {
  const answer = literalGold(doc(group('r', '合成文档', group('g', '合成分组', kase('same', '甲', '期望甲'), kase('same', '乙', '期望乙')))));
  const gold = [entry({ node: 'same', kind: 'delete_expected', seen_by: 'mechanical' })];
  const judged = result([item('same#1', req('literal', [refute('core.structure.required_empty')], { terminal: 'violation', attribution: 'author_input' }))]);
  assert.deepEqual(score(gold, judged, { literal: answer }).recall.mechanical, [0, 0]);
  assert.equal(aggregate(gold, [{ result: judged, valid: true }], answer).kinds[0]!.injected, 0);
});

test('untouched catalog marks are counted per claim and explicitly have no independent answer', () => {
  const base = result([item('catalog-case', req('catalog', [refute('core.catalog.not_member')], { terminal: 'violation', attribution: 'author_input' }))]);
  const judged = result([
    item('catalog-case', req('catalog', [refute('core.catalog.not_member'), refute('core.catalog.param_out_of_range')], { terminal: 'violation', attribution: 'author_input' })),
    item('tag-case', req('literal', [refute('case-review.tag_variant')], { terminal: 'violation', attribution: 'author_input' })),
  ]);
  const scored = score([], judged, { baseline: base, literal: { cases: [{ id: 'catalog-case', codes: [] }, { id: 'tag-case', codes: [] }], noUniqueId: [] } });
  assert.deepEqual(scored.otherMarks.catalog, { total: 2, fresh: 1 });
  assert.equal(scored.otherMarks.total, 3);
  assert.equal(scored.otherMarks.fresh, 2);
  assert.deepEqual(scored.structure, { supported: [], falsePositives: [], missed: [] });
  assert.match(render(scored).join('\n'), /目录类标记还没有独立答案 2 条（未改动评审里没有的 1 条）/);
  const file = detail(scored);
  assert.match(file, /catalog-case.*core.catalog.param_out_of_range.*还没有独立答案/);
  assert.match(file, /另行解析命令树并核对被引用的命令行和参数/);
  const screen = render(scored).join('\n');
  assert.doesNotMatch(screen, /catalog-case|tag-case|core.catalog/);
  assert.match(render(score([], judged, { baseline: base })).join('\n'), /目录类标记还没有独立答案 2 条/);
});

test('review 2: an unrelated mark cannot detect a mechanical injection and judgment kinds receive no Hub credit', () => {
  const gold = [entry({ seen_by: 'mechanical', kind: 'delete_expected' })];
  const unrelated = result([item('c1', req('literal', [refute('case-review.tag_variant')], { terminal: 'violation', attribution: 'author_input' }))]);
  assert.equal(score(gold, unrelated).detections[0].mechanical, false);
  const duplicated = entry({ seen_by: 'mechanical', kind: 'duplicate', copy: 'copy' });
  const half = result([item('c1', req('literal', [refute('core.structure.duplicate_key')], { terminal: 'violation', attribution: 'author_input' }))]);
  assert.equal(score([duplicated], half).detections[0].mechanical, false);
  assert.equal(score([entry({ kind: 'vague_expected' })], half).detections[0].mechanical, false);
});

test('review 3: a delivered document-wide gap finds a deleted negative group on another case', () => {
  const gold = [entry({ kind: 'delete_negative_group', node: 'gone-group', deletedCases: ['gone-case'] })];
  const scored = score(gold, result([item('remaining', req('findings', [judgment('negative_gap')]))]), { literal: { cases: [{ id: 'remaining', codes: [] }], noUniqueId: [] } });
  assert.equal(scored.detections[0].draft, true); assert.equal(scored.detections[0].combined, true); assert.equal(scored.detections[0].detected, true);
});

test('review 4: incomplete literal entries are counted but never supported falsely or missed', () => {
  const answer = { cases: [{ id: 'c1', codes: ['core.structure.required_empty'] }], noUniqueId: [] };
  const scored = score([], result([], [item('c1', req('literal', [refute('core.structure.required_empty')], { terminal: 'incomplete', attribution: 'unattributed' }))]), { literal: answer });
  assert.equal(scored.literalUnscored, 1); assert.deepEqual(scored.structure, { supported: [], falsePositives: [], missed: [] });
});

test('review 9: structure is scored once per case and code while raw claims remain available', () => {
  const answer = { cases: [{ id: 'c1', codes: ['core.structure.required_empty'] }], noUniqueId: [] };
  const scored = score([], result([item('c1', req('literal', [refute('core.structure.required_empty'), refute('core.structure.required_empty')], { terminal: 'violation', attribution: 'author_input' }))]), { literal: answer });
  assert.equal(scored.structure.supported.length, 1);
});

test('review 16: draft recall and combined recall remain separately labeled after verification refutes a finding', () => {
  const gold = [entry({ kind: 'vague_expected' })];
  const scored = score(gold, result([item('c1', req('findings', [judgment('vague')]))]), { verify: result([item('c1', req('verification', [judgment('refuted')]))]) });
  assert.deepEqual(scored.recall.judgment, [1, 1]);
  assert.ok(render(scored).some(line => line.includes('初评发现 1/1') && line.includes('合起来 0/1')));
});

// Compile-time negative fixtures ensure future handwritten values are rejected.
const invalidFixtures = () => {
  // @ts-expect-error Subject is a source role, not an attribution.
  req('literal', [], { attribution: 'subject' });
  // @ts-expect-error A declared skip is incomplete with a reason, not a terminal.
  req('literal', [], { terminal: 'skipped' });
};
void invalidFixtures;

test('closure deleted groups combine only confirmed draft gaps and all document-wide new probes', () => {
 const gold=[entry({kind:'delete_negative_group',node:'gone',deletedCases:['gone-case']})];
 const draft=result([item('remaining',req('findings',[judgment('negative_gap')]))]);
 for(const disposition of ['refuted','verified','partial']) {
  const scored=score(gold,draft,{verify:result([item('remaining',req('verification',[judgment(disposition)]))])});
  assert.equal(scored.detections[0].combined,disposition!=='refuted');
  assert.equal(scored.detections[0].detected,disposition!=='refuted');
  assert.match(detail(scored), disposition === 'refuted' ? /漏掉/ : /查出/);
  assert.equal(scored.detections[0].confirmed,disposition!=='refuted');
 }
 const answer={cases:[{id:'healthy',codes:[]}],noUniqueId:[{id:'same',count:2,reason:'duplicate'}]};
 const probe=result([item('same#1',req('verification',[{statement:{code:'new_finding',data:{probe:'negative_gap'}}}]))]);
 const scored=score(gold,result([]),{verify:probe,literal:answer});
 assert.equal(scored.detections[0].verify,true); assert.equal(scored.detections[0].combined,true);
});
