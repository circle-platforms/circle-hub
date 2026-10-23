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
for (const n of [0, 3]) test(`unplaced ${n} is a definite disclosure and never changes sweep`, () => {
  const out = project(n); assert.ok(!out.error);
  assert.deepEqual(out.items, project(0).items);
  assert.deepEqual(out.groups[0].details, project(0).groups[0].details);
  const claims = checkOutcomes('command_exists', { items: out.items, note: out.groups[0] });
  const disclosure = claims.find((c) => c.data?.unplaced === n)!;
  assert.equal(disclosure.verdict, 'support'); assert.match(disclosure.statement, new RegExp(`${n} 个用例没有解析出命令`));
  assert.ok(!JSON.stringify(out.groups[0]).includes('"rows"'));
});
test('missing required facets refuses instead of ending in unknown', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: impact }] }) as { error: { code: string; fix: string } };
  assert.equal(out.error.code, 'maintenance-sweep.facets_view'); assert.match(out.error.fix, /knowledge:facets/);
});
test('truncated facets refuse with missing fact and recovery action', () => {
  const out = project(0, (v) => { v.model.truncated = true; });
  assert.equal(out.error?.code, 'maintenance-sweep.facets_view'); assert.match(out.error?.message ?? '', /缺少完整/); assert.match(out.error?.fix ?? '', /重新读取/);
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
