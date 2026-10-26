import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectItems } from './project.ts';
import { checkOutcomes } from './check.ts';
import { buildImpact, facetInput, SOURCE } from './test-support.ts';
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
