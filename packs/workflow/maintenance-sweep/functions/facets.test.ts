import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectItems } from './project.ts';
import { checkOutcomes } from './check.ts';
import { buildImpact, facetInput, reviewSweep, SOURCE, unknownNote } from './test-support.ts';
const impact = buildImpact([{ path: '/commands/widget/add', change: 'added', after: [{ name: 'add' }], to: [{ document: 'synthetic-doc', node: 'case' }] }]);
function project(count: number, mutate?: (v: Record<string, any>) => void) {
  const facets = facetInput(impact, count); mutate?.(facets);
  return projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: impact }, facets] }) as { items: unknown[]; groups: Record<string, unknown>[]; error?: { code: string; fix: string; message: string } };
}
for (const n of [0, 3]) test(`unplaced ${n} is a hint disclosure and never changes sweep`, () => {
  const out = project(n); assert.ok(!out.error);
  assert.deepEqual(out.items, project(0).items);
  assert.deepEqual(out.groups[0].details, project(0).groups[0].details);
  const claims = checkOutcomes('command_exists', { items: out.items, note: out.groups[0] });
  assert.ok(claims.every((c) => !c.statement.includes('个用例没有解析出命令')));
  assert.equal(out.groups[0].unplaced, n);
  assert.match(String(out.groups[0].message), new RegExp(`${n} 个用例没有解析出命令`));
  assert.ok(!JSON.stringify(out.groups[0]).includes('"rows"'));
});
test('missing required facets refuses instead of ending in unknown', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: impact }] }) as { error: { code: string; fix: string } };
  assert.equal(out.error.code, 'maintenance-sweep.facets_view'); assert.match(out.error.fix, /knowledge:facets/);
});
test('truncated facets refuse with missing fact and recovery action', () => {
  const out = project(0, (v) => { v.model.truncated = true; });
  assert.equal(out.error?.code, 'maintenance-sweep.facets_view'); assert.match(out.error?.message ?? '', /缺少完整/); assert.match(out.error?.fix ?? '', /不自动重试/);
});
for (const [name, mutate] of Object.entries({
  root: (v: any) => { v.model.build.root = 'f'.repeat(64); }, product: (v: any) => { v.model.product = 'other'; }, kind: (v: any) => { v.model.kind = 'definition'; }, by: (v: any) => { v.model.by.push('module'); }, schema: (v: any) => { v.model.schema = 'wrong'; }, count: (v: any) => { v.model.rows[0].count = -1; }, duplicate: (v: any) => { v.model.rows.push(v.model.rows[0]); }, digest: (v: any) => { v.sha256 = 'bad'; },
})) test(`reject wrong facets ${name}`, () => assert.equal(project(3, mutate).error?.code, 'maintenance-sweep.facets_view'));
test('more than one facet view refuses', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: impact }, facetInput(impact), facetInput(impact)] }) as { error: { code: string } };
  assert.equal(out.error.code, 'maintenance-sweep.facets_view');
});

test('a clean projection has no fabricated check error for its empty item set', () => {
  const view = buildImpact([]);
  const result = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view }, facetInput(view)] }) as { items: unknown[]; groups: unknown[] };
  const claims = checkOutcomes('command_unchanged', { items: result.items, note: result.groups[0] });
  assert.ok(claims.length > 0); assert.ok(claims.every((c) => c.verdict === 'support'));
});

test('hint disclosure changes no check claims at zero or a positive count', () => {
  const zero = project(0); const positive = project(3);
  for (const check of ['command_exists', 'command_unchanged']) assert.deepEqual(checkOutcomes(check, { items: zero.items, note: zero.groups[0] }), checkOutcomes(check, { items: positive.items, note: positive.groups[0] }));
});

test('index-coverage unknown is identical with and without the facets hint metadata', () => {
  const out = project(3); const withHint = out.groups[0];
  const { unplaced: _count, unplaced_build: _build, ...withoutHint } = withHint;
  for (const check of ['command_exists', 'command_unchanged']) assert.deepEqual(checkOutcomes(check, { items: out.items, note: withHint }), checkOutcomes(check, { items: out.items, note: withoutHint }));
  const unknown = checkOutcomes('command_exists', { items: out.items, note: withHint }).find((v) => v.verdict === 'unknown');
  assert.equal(unknown, undefined, JSON.stringify(unknown));
});

test('skipped facet sources refuse rather than disclose a false zero', () => {
  const out = project(0, (v) => { v.model.skipped = 3; });
  assert.equal(out.error?.code, 'maintenance-sweep.facets_view'); assert.match(out.error?.message ?? '', /skipped 不一致/); assert.ok(!out.error?.message.includes('0 个用例'));
});

test('deterministic truncation names notes and requests a real repair instead of a retry loop', () => {
  const result = project(0, (v) => { v.model.truncated = true; v.model.notes = ['合成字节预算截断']; });
  assert.match(result.error?.message ?? '', /合成字节预算截断/); assert.match(result.error?.fix ?? '', /不自动重试/); assert.match(result.error?.fix ?? '', /集成者/);
});

test('closure 01 skipped sources remain a disclosed lower bound when both views agree',()=>{const view=buildImpact([],{skipped:{from:3,to:0}});const facet=facetInput(view,2) as any;facet.model.skipped=3;const out=projectItems({inputs:[{slot:'impact',sha256:SOURCE,model:view},facet]}) as any;assert.ok(!out.error,JSON.stringify(out.error));assert.match(out.groups[0].message,/至少 2 个用例没有解析出命令/);assert.match(out.groups[0].message,/3 份来源未读/);});

// 1.8.9: a facet view truncated only because some cases' command attribution is unknown (unknown_only) is bound; those
// cases are unknown, never zero, never unplaced and never a failure, and no claim calls the sweep empty or whole while
// they could sit on a removed or modified path. Every other truncation is refused as before.
type Projected = { items: unknown[]; groups: Record<string, unknown>[]; warnings: Array<{ code: string; message: string }>; error?: { code: string; fix: string; message: string } };
const review = buildImpact(reviewSweep());
const projectView = (view: Record<string, unknown>, facets: Record<string, unknown>, parameters: Record<string, unknown> = {}) => projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view }, facets], parameters }) as Projected;
const outcomesOf = (out: Projected, check: string) => checkOutcomes(check, { items: out.items, note: out.groups[0] });

test('a complete view says exactly what 1.8.8 said and carries no unknown fields', () => {
  const zero = project(0); const three = project(3);
  assert.equal(zero.groups[0].message, '比较 Rel_W_1_0_1 与 Rel_W_1_0_2。没有需要维护的用例。 构建 Rel_W_1_0_1 的较早构建用例索引里有 0 个用例没有解析出命令（未归位），没算进巡检范围。索引中没有未归位的用例。');
  assert.equal(three.groups[0].message, '比较 Rel_W_1_0_1 与 Rel_W_1_0_2。没有需要维护的用例。 构建 Rel_W_1_0_1 的较早构建用例索引里有 3 个用例没有解析出命令（未归位），没算进巡检范围。客户端下一步自动提取最多一页用例样例及继续引用，供人工查看；它们的命令是否删除或修改，需要查看用例取得命令归属事实。');
  for (const out of [zero, three]) {
    assert.ok(!Object.hasOwn(out.groups[0], 'unknown_entries') && !Object.hasOwn(out.groups[0], 'facet_notes'));
    assert.ok(!(out as unknown as Projected).warnings.some((warning) => warning.code === 'maintenance-sweep.unknown_entries'));
  }
});

test('a facet view truncated only by unknown entries is bound and says those cases as unknown, never zero or unplaced', () => {
  const complete = projectView(review, facetInput(review, 2));
  const out = projectView(review, facetInput(review, 2, { unknown: 40 }));
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  assert.deepEqual(out.items, complete.items, 'the unknown cases never change the items');
  assert.deepEqual(out.groups[0].details, complete.groups[0].details);
  assert.deepEqual(out.groups[0].diff, complete.groups[0].diff);
  const note = out.groups[0];
  assert.deepEqual([note.unplaced, note.unknown_entries, note.facet_notes], [2, 40, [unknownNote(40)]]);
  const message = String(note.message);
  assert.match(message, /命令归属已知的用例里有 4 条需要维护/);
  assert.match(message, /已知 2 个用例没有解析出命令（未归位）/);
  assert.match(message, /另有 40 个用例的命令归属未知：分面视图看不出它们用到哪些命令，不是 0 个，也不算未归位/);
  assert.match(message, /巡检可能漏了其中需要维护的用例/);
  assert.ok(message.includes(`视图说明：${unknownNote(40)}`), 'the next step quotes the view note');
  const warning = out.warnings.find((row) => row.code === 'maintenance-sweep.unknown_entries');
  assert.ok(warning, JSON.stringify(out.warnings));
  assert.match(warning.message, /^较早构建有 40 个用例的命令归属未知/);
});

test('command_exists says the unknown cases with the next step, next to the item verdicts, like skipped documents', () => {
  const out = projectView(review, facetInput(review, 0, { unknown: 3 }));
  const complete = projectView(review, facetInput(review));
  const exists = outcomesOf(out, 'command_exists');
  const said = exists.filter((outcome) => outcome.data?.unknown_entries === 3);
  assert.equal(said.length, 1, JSON.stringify(exists));
  assert.deepEqual([said[0].verdict, said[0].reason, said[0].tier, said[0].item], ['unknown', 'missing_input', 'blocking', undefined]);
  assert.match(said[0].statement, /^较早构建有 3 个用例的命令归属未知/);
  assert.match(said[0].statement, /不是 0 个，也不算未归位/);
  assert.match(said[0].statement, /下一步照分面视图的说明补齐它们的命令归属，再重新开始运行/);
  assert.ok(said[0].statement.includes(unknownNote(3)));
  assert.match(said[0].missing ?? '', /^尚未取得本检查所需的事实：/);
  assert.deepEqual(exists.filter((outcome) => outcome !== said[0]), outcomesOf(complete, 'command_exists'), 'the item verdicts are those of a complete view');
  assert.deepEqual(outcomesOf(out, 'command_unchanged'), outcomesOf(complete, 'command_unchanged'));
  assert.ok(exists.every((outcome) => outcome.verdict !== 'refute' || outcome.code === 'maintenance-sweep.case.command_removed'), 'unknown is never a failure');
});

test('an empty sweep on a removed or modified path is unknown in both checks and in the clean warning', () => {
  const dropped = buildImpact([{ path: '/commands/drop', change: 'removed', before: [{ name: 'drop' }] }]);
  for (const check of ['command_exists', 'command_unchanged']) assert.ok(outcomesOf(projectView(dropped, facetInput(dropped)), check).some((outcome) => outcome.verdict === 'support' && outcome.statement.includes('巡检范围是空的')), check);
  const out = projectView(dropped, facetInput(dropped, 0, { unknown: 2 }));
  assert.deepEqual(out.items, []);
  const exists = outcomesOf(out, 'command_exists');
  assert.deepEqual(exists.map((outcome) => [outcome.verdict, outcome.reason, outcome.tier]), [['unknown', 'missing_input', 'blocking']]);
  const unchanged = outcomesOf(out, 'command_unchanged');
  assert.deepEqual(unchanged.map((outcome) => outcome.verdict), ['support', 'unknown']);
  assert.ok(unchanged[0].statement.startsWith('命令差共 1 条'));
  assert.match(unchanged[1].statement, /^已读来源里命令归属已知的用例没有需要维护的，但不能据此说巡检范围是空的：较早构建有 2 个用例的命令归属未知/);
  assert.ok(![...exists, ...unchanged].some((outcome) => outcome.statement.includes('巡检范围是空的。')), 'no claim calls the sweep empty');
  const clean = out.warnings.find((warning) => warning.code === 'maintenance-sweep.clean')!;
  assert.equal(clean.message, '比较 Rel_W_1_0_1 与 Rel_W_1_0_2。命令归属已知的用例里没有需要维护的。');
});

test('unknown cases cannot change a sweep without a removed or modified path: the supports stay and the note still says them', () => {
  const addedOnly = buildImpact([{ path: '/commands/add', change: 'added', after: [{ name: 'add' }], from: [{ document: 'doc-6', node: 'n1', title: '新增路径上的旧用例', priority: 1 }] }]);
  for (const view of [buildImpact([]), addedOnly]) {
    const complete = projectView(view, facetInput(view));
    const out = projectView(view, facetInput(view, 0, { unknown: 7 }));
    for (const check of ['command_exists', 'command_unchanged']) assert.deepEqual(outcomesOf(out, check), outcomesOf(complete, check), check);
    assert.equal(out.groups[0].unknown_entries, 7);
    const message = String(out.groups[0].message);
    assert.match(message, /没有需要维护的用例/);
    assert.match(message, /另有 7 个用例的命令归属未知/);
    assert.ok(!message.includes('巡检可能漏了') && !message.includes('重新开始运行'), message);
    assert.ok(out.warnings.some((warning) => warning.code === 'maintenance-sweep.unknown_entries'));
  }
});

test('skipped documents and unknown cases are two unknowns, each with its own missing fact', () => {
  const view = buildImpact(reviewSweep(), { skipped: { from: 3, to: 0 } });
  const facets = facetInput(view, 1, { unknown: 2 });
  const out = projectView(view, facets);
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  assert.match(String(out.groups[0].message), /至少 1 个用例没有解析出命令/);
  assert.match(String(out.groups[0].message), /另有 3 份来源未读/);
  assert.match(String(out.groups[0].message), /另有 2 个用例的命令归属未知/);
  const unknown = outcomesOf(out, 'command_exists').filter((outcome) => outcome.verdict === 'unknown');
  assert.equal(unknown.length, 2);
  assert.match(unknown[0].statement, /较早构建的索引缺少 3 份列出的文档/);
  assert.match(unknown[1].statement, /较早构建有 2 个用例的命令归属未知/);
});

test('unknown entries next to other truncation, and a truncated view with neither field, refuse as before', () => {
  for (const options of [{ unknown: 4, undelivered: true }, { undelivered: true }]) {
    const out = projectView(review, facetInput(review, 0, options));
    assert.equal(out.error?.code, 'maintenance-sweep.facets_view', JSON.stringify(options));
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
    assert.equal(out.error?.code, 'maintenance-sweep.facets_view', name);
    assert.match(out.error?.message ?? '', /unknown_(entries|only) 不合式/, name);
  }
});

test('long view notes are clipped so a statement stays under the answer clip', () => {
  const notes = Array.from({ length: 12 }, (_, i) => `${'合成的很长视图说明'.repeat(40)}${i}`);
  const out = projectView(review, facetInput(review, 0, { unknown: 9, notes }));
  assert.deepEqual(out.groups[0].facet_notes, notes, 'the note keeps the notes as the view gave them');
  for (const outcome of outcomesOf(out, 'command_exists')) assert.ok(outcome.statement.length <= 1400, `${outcome.statement.length}`);
});
