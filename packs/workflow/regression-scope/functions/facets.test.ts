import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectItems } from './project.ts';
import { checkOutcomes } from './check.ts';
import { buildImpact, facetInput, reviewChanges, reviewOptions, SOURCE, unknownNote } from './test-support.ts';
const impact = buildImpact([{ path: '/commands/widget/add', change: 'added', after: [{ name: 'add' }], to: [{ document: 'synthetic-doc', node: 'case' }] }]);
function project(count: number, mutate?: (v: Record<string, any>) => void) {
  const facets = facetInput(impact, count); mutate?.(facets);
  return projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: impact }, facets] }) as { items: unknown[]; groups: Record<string, unknown>[]; error?: { code: string; fix: string; message: string } };
}
for (const n of [0, 3]) test(`unplaced ${n} is a hint disclosure and never changes scope`, () => {
  const out = project(n); assert.ok(!out.error);
  assert.deepEqual(out.items, project(0).items);
  assert.deepEqual(out.groups[0].details, project(0).groups[0].details);
  const claims = checkOutcomes('uncovered_changes', { items: out.items, note: out.groups[0] });
  assert.ok(claims.every((c) => !c.statement.includes('个用例没有解析出命令')));
  assert.equal(out.groups[0].unplaced, n);
  assert.match(String(out.groups[0].message), new RegExp(`${n} 个用例没有解析出命令`));
  assert.ok(!JSON.stringify(out.groups[0]).includes('"rows"'));
});
test('missing required facets refuses instead of ending in unknown', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: impact }] }) as { error: { code: string; fix: string } };
  assert.equal(out.error.code, 'regression-scope.facets_view'); assert.match(out.error.fix, /knowledge:facets/);
});
test('truncated facets refuse with missing fact and recovery action', () => {
  const out = project(0, (v) => { v.model.truncated = true; });
  assert.equal(out.error?.code, 'regression-scope.facets_view'); assert.match(out.error?.message ?? '', /缺少完整/); assert.match(out.error?.fix ?? '', /不自动重试/);
});
for (const [name, mutate] of Object.entries({
  root: (v: any) => { v.model.build.root = 'f'.repeat(64); }, product: (v: any) => { v.model.product = 'other'; }, kind: (v: any) => { v.model.kind = 'definition'; }, by: (v: any) => { v.model.by.push('module'); }, schema: (v: any) => { v.model.schema = 'wrong'; }, count: (v: any) => { v.model.rows[0].count = -1; }, duplicate: (v: any) => { v.model.rows.push(v.model.rows[0]); }, digest: (v: any) => { v.sha256 = 'bad'; },
})) test(`reject wrong facets ${name}`, () => assert.equal(project(3, mutate).error?.code, 'regression-scope.facets_view'));
test('more than one facet view refuses', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: impact }, facetInput(impact), facetInput(impact)] }) as { error: { code: string } };
  assert.equal(out.error.code, 'regression-scope.facets_view');
});

test('hint disclosure changes no check claims at zero or a positive count', () => {
  const zero = project(0); const positive = project(3);
  for (const check of ['in_scope', 'uncovered_changes']) assert.deepEqual(checkOutcomes(check, { items: zero.items, note: zero.groups[0] }), checkOutcomes(check, { items: positive.items, note: positive.groups[0] }));
});

test('a projected empty scope does not fabricate a check error', () => {
  const view = buildImpact([]);
  const result = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view }, facetInput(view)] }) as { items: unknown[]; groups: unknown[] };
  const outcomes = checkOutcomes('in_scope', { items: result.items, note: result.groups[0] });
  assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes[0].verdict, 'support');
  assert.match(outcomes[0].statement, /回归范围是空的/);
});

test('skipped facet sources refuse rather than disclose a false zero', () => {
  const out = project(0, (v) => { v.model.skipped = 3; });
  assert.equal(out.error?.code, 'regression-scope.facets_view'); assert.match(out.error?.message ?? '', /skipped 不一致/); assert.ok(!out.error?.message.includes('0 个用例'));
});

test('deterministic truncation names notes and requests a real repair instead of a retry loop', () => {
  const result = project(0, (v) => { v.model.truncated = true; v.model.notes = ['合成字节预算截断']; });
  assert.match(result.error?.message ?? '', /合成字节预算截断/); assert.match(result.error?.fix ?? '', /不自动重试/); assert.match(result.error?.fix ?? '', /集成者/);
});

test('closure 01 skipped sources remain a disclosed lower bound when both views agree',()=>{const view=buildImpact([],{skipped:{from:0,to:4}});const facet=facetInput(view,2) as any;facet.model.skipped=4;const out=projectItems({inputs:[{slot:'impact',sha256:SOURCE,model:view},facet]}) as any;assert.ok(!out.error,JSON.stringify(out.error));assert.match(out.groups[0].message,/至少 2 个用例没有解析出命令/);assert.match(out.groups[0].message,/4 份来源未读/);});

// 1.8.9: a facet view truncated only because some cases' command attribution is unknown (unknown_only) is bound; those
// cases are unknown, never zero, never unplaced and never a failure, and no claim calls the scope empty or whole while
// they could sit on a considered path. Every other truncation is refused as before.
type Projected = { items: unknown[]; groups: Record<string, unknown>[]; warnings: Array<{ code: string; message: string }>; error?: { code: string; fix: string; message: string } };
const review = buildImpact(reviewChanges(), reviewOptions());
const projectView = (view: Record<string, unknown>, facets: Record<string, unknown>, parameters: Record<string, unknown> = {}) => projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view }, facets], parameters }) as Projected;
const outcomesOf = (out: Projected, check: string) => checkOutcomes(check, { items: out.items, note: out.groups[0] });

test('a complete view says exactly what 1.8.8 said and carries no unknown fields', () => {
  const zero = project(0); const three = project(3);
  assert.equal(zero.groups[0].message, '比较 Rel_W_1_0_1 与 Rel_W_1_0_2。回归范围共 1 条用例。 构建 Rel_W_1_0_2 的后一构建用例索引里有 0 个用例没有解析出命令（未归位），没算进回归范围。索引中没有未归位的用例。');
  assert.equal(three.groups[0].message, '比较 Rel_W_1_0_1 与 Rel_W_1_0_2。回归范围共 1 条用例。 构建 Rel_W_1_0_2 的后一构建用例索引里有 3 个用例没有解析出命令（未归位），没算进回归范围。客户端下一步自动提取最多一页用例样例及继续引用，供人工查看；是否受本次变更影响，需要查看用例取得命令归属事实。');
  for (const out of [zero, three]) {
    assert.ok(!Object.hasOwn(out.groups[0], 'unknown_entries') && !Object.hasOwn(out.groups[0], 'facet_notes'));
    assert.ok(!(out as unknown as Projected).warnings.some((warning) => warning.code === 'regression-scope.unknown_entries'));
  }
});

test('a facet view truncated only by unknown entries is bound and says those cases as unknown, never zero or unplaced', () => {
  const complete = projectView(review, facetInput(review, 2));
  const out = projectView(review, facetInput(review, 2, { unknown: 40 }));
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  assert.deepEqual(out.items, complete.items, 'the unknown cases never change the items');
  assert.deepEqual(out.groups[0].details, complete.groups[0].details);
  const note = out.groups[0];
  assert.deepEqual([note.unplaced, note.unknown_entries, note.facet_notes], [2, 40, [unknownNote(40)]]);
  const message = String(note.message);
  assert.match(message, /命令归属已知的用例里有 4 条在回归范围内/);
  assert.ok(!message.includes('回归范围共'), 'the scope is not called whole');
  assert.match(message, /已知 2 个用例没有解析出命令（未归位）/);
  assert.match(message, /另有 40 个用例的命令归属未知：分面视图看不出它们用到哪些命令，不是 0 个，也不算未归位/);
  assert.match(message, /完整性无法证明/);
  assert.ok(message.includes(`视图说明：${unknownNote(40)}`), 'the next step quotes the view note');
  const warning = out.warnings.find((row) => row.code === 'regression-scope.unknown_entries');
  assert.ok(warning, JSON.stringify(out.warnings));
  assert.match(warning.message, /^后一构建有 40 个用例的命令归属未知/);
});

test('the checks say the unknown cases with the next step and support no complete scope', () => {
  const out = projectView(review, facetInput(review, 0, { unknown: 3 }));
  const uncovered = outcomesOf(out, 'uncovered_changes');
  const said = uncovered.filter((outcome) => outcome.data?.unknown_entries === 3);
  assert.equal(said.length, 1, JSON.stringify(uncovered));
  assert.deepEqual([said[0].verdict, said[0].reason, said[0].tier], ['unknown', 'missing_input', 'advisory']);
  assert.match(said[0].statement, /^后一构建有 3 个用例的命令归属未知/);
  assert.match(said[0].statement, /不是 0 个，也不算未归位/);
  assert.match(said[0].statement, /下一步照分面视图的说明补齐它们的命令归属，再重新开始运行/);
  assert.ok(said[0].statement.includes(unknownNote(3)));
  assert.match(said[0].missing ?? '', /^尚未取得本检查所需的事实：/);
  const bare = uncovered.find((outcome) => outcome.statement.includes('/commands/bare（新增）'))!;
  assert.equal(bare.verdict, 'unknown');
  assert.match(bare.statement, /另有 3 个用例的命令归属未知，这条路径上可能有其中的用例/);
  assert.ok(uncovered.filter((outcome) => outcome.verdict === 'support').every((outcome) => outcome.statement.startsWith('命令差共')), 'only the command diff is a fact');
  assert.ok(uncovered.every((outcome) => outcome.verdict !== 'refute'), 'unknown is never a failure');
  assert.deepEqual(outcomesOf(out, 'in_scope'), outcomesOf(projectView(review, facetInput(review)), 'in_scope'), 'the cases in scope stay supported');
});

test('every changed path covered is no longer a support while unknown cases could sit on one', () => {
  const covered = buildImpact([{ path: '/commands/show', change: 'modified', before: [{ name: 'show', help: '旧' }], after: [{ name: 'show', help: '新' }], to: [{ document: 'doc-1', node: 'n1', title: '查看', priority: 1 }] }]);
  assert.ok(outcomesOf(projectView(covered, facetInput(covered)), 'uncovered_changes').some((outcome) => outcome.verdict === 'support' && outcome.statement.includes('都有用例')));
  const open = outcomesOf(projectView(covered, facetInput(covered, 0, { unknown: 5 })), 'uncovered_changes');
  assert.ok(!open.some((outcome) => outcome.statement.includes('都有用例')), JSON.stringify(open));
  assert.deepEqual(open.filter((outcome) => outcome.verdict === 'unknown').map((outcome) => outcome.data?.unknown_entries), [5]);
});

test('an empty scope on a considered path is unknown in both checks and in the empty-scope warning', () => {
  const bare = buildImpact([{ path: '/commands/bare', change: 'added', after: [{ name: 'bare' }] }]);
  assert.equal(outcomesOf(projectView(bare, facetInput(bare)), 'in_scope')[0].verdict, 'support');
  const out = projectView(bare, facetInput(bare, 0, { unknown: 2 }));
  assert.deepEqual(out.items, []);
  const inScope = outcomesOf(out, 'in_scope');
  assert.deepEqual(inScope.map((outcome) => [outcome.verdict, outcome.reason, outcome.data?.unknown_entries]), [['unknown', 'missing_input', 2]]);
  assert.match(inScope[0].statement, /^投影给出的回归范围里没有用例，但不能据此说回归范围是空的：后一构建有 2 个用例的命令归属未知/);
  const empty = out.warnings.find((warning) => warning.code === 'regression-scope.empty_scope')!;
  assert.equal(empty.message, '比较 Rel_W_1_0_1 与 Rel_W_1_0_2。变更路径上没有命令归属已知的后一构建用例。');
  const filtered = projectView(review, facetInput(review, 0, { unknown: 2 }), { priorities: [9] });
  assert.match(String(filtered.groups[0].message), /按优先级筛选后没有命令归属已知的用例留在回归范围内/);
  assert.equal(outcomesOf(filtered, 'in_scope')[0].verdict, 'unknown');
});

test('unknown cases cannot change a scope without a considered path: the supports stay and the note still says them', () => {
  const addedOnly = buildImpact([{ path: '/commands/add', change: 'added', after: [{ name: 'add' }], to: [{ document: 'doc-1', node: 'n1', title: '新增', priority: 1 }] }]);
  for (const [view, parameters] of [[buildImpact([]), {}], [addedOnly, { include_added: false }]] as const) {
    const complete = projectView(view, facetInput(view), parameters);
    const out = projectView(view, facetInput(view, 0, { unknown: 7 }), parameters);
    for (const check of ['in_scope', 'uncovered_changes']) assert.deepEqual(outcomesOf(out, check), outcomesOf(complete, check), check);
    assert.equal(out.groups[0].unknown_entries, 7);
    const message = String(out.groups[0].message);
    assert.match(message, /两个构建之间没有纳入范围的变更路径，回归范围是空的/);
    assert.match(message, /另有 7 个用例的命令归属未知/);
    assert.ok(!message.includes('完整性无法证明') && !message.includes('重新开始运行'), message);
    assert.ok(out.warnings.some((warning) => warning.code === 'regression-scope.unknown_entries'));
  }
});

test('unknown entries next to other truncation, and a truncated view with neither field, refuse as before', () => {
  for (const options of [{ unknown: 4, undelivered: true }, { undelivered: true }]) {
    const out = projectView(review, facetInput(review, 0, options));
    assert.equal(out.error?.code, 'regression-scope.facets_view', JSON.stringify(options));
    assert.match(out.error?.message ?? '', /分面视图被截断，缺少完整的未归位用例计数/);
    assert.match(out.error?.fix ?? '', /不自动重试/);
  }
});

test('malformed unknown-entry fields are a shape problem, never unknown entries', () => {
  for (const [name, change] of Object.entries({
    zero: (m: Record<string, unknown>) => { m.truncated = true; m.unknown_entries = 0; m.unknown_only = true; },
    negative: (m: Record<string, unknown>) => { m.truncated = true; m.unknown_entries = -2; m.unknown_only = true; },
    fraction: (m: Record<string, unknown>) => { m.truncated = true; m.unknown_entries = 1.5; m.unknown_only = true; },
    text: (m: Record<string, unknown>) => { m.truncated = true; m.unknown_entries = '3'; m.unknown_only = true; },
    untruncated: (m: Record<string, unknown>) => { m.unknown_entries = 3; },
    onlyFalse: (m: Record<string, unknown>) => { m.truncated = true; m.unknown_entries = 3; m.unknown_only = false; },
    onlyWithoutCount: (m: Record<string, unknown>) => { m.truncated = true; m.unknown_only = true; },
  })) {
    const facets = facetInput(review) as { model: Record<string, unknown> };
    change(facets.model);
    const out = projectView(review, facets);
    assert.equal(out.error?.code, 'regression-scope.facets_view', name);
    assert.match(out.error?.message ?? '', /unknown_(entries|only) 不合式/, name);
  }
});

test('long view notes are clipped so a statement stays under the answer clip', () => {
  const notes = Array.from({ length: 12 }, (_, i) => `${'合成的很长视图说明'.repeat(40)}${i}`);
  const out = projectView(review, facetInput(review, 0, { unknown: 9, notes }));
  assert.deepEqual(out.groups[0].facet_notes, notes, 'the note keeps the notes as the view gave them');
  for (const outcome of outcomesOf(out, 'uncovered_changes')) assert.ok(outcome.statement.length <= 1400, `${outcome.statement.length}`);
});
