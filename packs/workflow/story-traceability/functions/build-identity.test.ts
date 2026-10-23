import assert from 'node:assert/strict';
import { test } from 'node:test';
import project from './project.ts';
import check from './check.ts';
import { boundView, indexViewOf } from '../../traceability/functions/test-support.ts';
const root = 'a'.repeat(64), otherRoot = 'd'.repeat(64), buildName = 'Synthetic_10_7_A';
function input(name: unknown, context: Record<string, unknown> = {}) {
  const view = indexViewOf('case', 'stories', []);
  view.build = { build: buildName, root };
  const record = { id: '7', name, stories: ['21'], fields: { id: 7, name, stamp: 'synthetic-scalar', released: false } };
  return { inputs: [boundView('cases', view), boundView('build', { builds: [record] }, 'plm:builds:5')], parameters: { build_id: '007' }, context };
}
test('build_id cannot select another or unnamed build under this case view', () => {
  for (const name of ['Synthetic_10_7_B', undefined, null, 7]) {
    const out = project(input(name)) as any;
    assert.ok(out.error, JSON.stringify(out)); assert.match(out.error.message, /构建记录 7/); assert.match(out.error.fix, /cases|用例视图/);
  }
  assert.ok((project(input(buildName, { root: otherRoot })) as any).error);
});
test('raw PLM record identity and scalar facts are frozen in each row and named in the claim', () => {
  const rawName = '  Ｓｙｎｔｈｅｔｉｃ_10_7_A  ';
  const p = project(input(rawName)) as any; assert.ok(!p.error, JSON.stringify(p));
  const selected = p.items[0].fields.selected_build;
  assert.equal(selected.id, '7'); assert.equal(selected.name, rawName);
  assert.deepEqual(selected.fields, { id: 7, name: rawName, stamp: 'synthetic-scalar', released: false });
  assert.match(selected.reference, /\/json@1\/p\/builds\/0$/);
  const [out] = check({ subject: { items: p.items, context: { groups: p.groups } } }) as any[];
  assert.deepEqual(out.data.selected_build, selected);
  assert.match(out.statement, /PLM 构建记录 7/); assert.ok(out.statement.includes(selected.reference)); assert.ok(out.statement.includes('Ｓｙｎｔｈｅｔｉｃ'));
});
test('cross-family names remain refused until an actual read-only alias interface is available', () => {
  const alias = 'Alternate_10_7_A';
  const context = { product: 'apv', root, build: buildName, builds: [{ name: buildName, base: buildName, has_root: true }, { name: alias, base: buildName, has_root: true }] };
  assert.ok((project(input(alias, context)) as any).error);
  for (const patch of [{ product: 'other' }, { root: otherRoot }, { builds: [{ name: buildName, base: buildName, has_root: true }, { name: alias, base: 'Different_10_7_A', has_root: true }] }, { builds: [] }]) assert.ok((project(input(alias, { ...context, ...patch })) as any).error);
});

test('a build_id must select one record and raw name contradictions cannot be hidden by the top-level name', () => {
  const duplicate = input(buildName) as any;
  duplicate.inputs[1].model.builds.push({ id: '007', name: buildName, stories: ['22'] });
  assert.ok((project(duplicate) as any).error);
  const inconsistent = input(buildName) as any;
  inconsistent.inputs[1].model.builds[0].fields.name = 'Synthetic_10_7_B';
  assert.ok((project(inconsistent) as any).error);
});

test('an unresolved product is a missing product identity, not proof that its build record is absent', () => {
  const value = input(buildName) as any;
  value.inputs[1].model = { product: null, product_resolution: 'ambiguous', builds: [] };
  const out = project(value) as any;
  assert.ok(out.error); assert.match(out.error.message, /产品/); assert.doesNotMatch(out.error.message, /未包含.*编号/);
});

test('a wrong-build refusal conforms to the producer failure schema so the engine can keep its explanation', async () => {
  const { ProjectionOutput } = await import('../../../../contracts/src/pack.ts');
  assert.equal(ProjectionOutput.safeParse(project(input('Synthetic_10_7_B'))).success, true);
});
