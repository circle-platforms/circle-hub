import assert from 'node:assert/strict';
import { test } from 'node:test';
import project from './project.ts';
import check from './check.ts';
import { boundView, caseEntry, indexViewOf } from '../../traceability/functions/test-support.ts';
const root = 'a'.repeat(64), otherRoot = 'd'.repeat(64), buildName = 'Synthetic_10_7_A';
function input(name: unknown, context: Record<string, unknown> = {}) {
  const view = indexViewOf('case', 'stories', []);
  view.key_space_complete = true;
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
test('raw build identity is frozen once and compact identity is named in each claim', () => {
  const rawName = '  Ｓｙｎｔｈｅｔｉｃ_10_7_A  ';
  const p = project(input(rawName)) as any; assert.ok(!p.error, JSON.stringify(p));
  const selected = p.groups[0].selected_build;
  assert.equal(selected.id, '7'); assert.equal(selected.name, rawName);
  assert.equal(selected.fields, undefined);
  assert.deepEqual(p.items[0].fields.selected_build, { id: '7', name: rawName });
  assert.match(selected.reference, /\/json@1\/p\/builds\/0$/);
  const [out] = check({ subject: { items: p.items, context: { groups: p.groups } } }) as any[];
  assert.deepEqual(out.data.selected_build, { id: '7', name: rawName });
  assert.match(out.statement, /PLM 构建记录 7/); assert.ok(out.grounds.includes(selected.reference)); assert.ok(!out.statement.includes(selected.reference)); assert.ok(out.statement.includes('Ｓｙｎｔｈｅｔｉｃ'));
});
test('cross-family names remain refused until an actual read-only alias interface is available', () => {
  const alias = 'Alternate_10_7_A';
  const context = { product: 'famx', root, build: buildName, builds: [{ name: buildName, base: buildName, has_root: true }, { name: alias, base: buildName, has_root: true }] };
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

test('a long raw build scalar is retained only in its source, not copied into 1500 story rows', () => {
  const value = input(buildName) as any; const build = value.inputs[1].model.builds[0];
  build.fields.description = 'synthetic-description-'.repeat(600);
  build.stories = Array.from({ length: 1500 }, (_, index) => String(index + 1));
  const out = project(value) as any;
  assert.equal(out.error, undefined); assert.equal(out.items.length, 1500);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) < 5 * 1024 * 1024);
  const selected = out.groups[0].selected_build;
  assert.equal(selected.id, '7'); assert.equal(selected.name, buildName); assert.ok(selected.reference);
  assert.ok(!Object.hasOwn(selected, 'fields'));
  for (const item of out.items) assert.deepEqual(item.fields.selected_build, { id: '7', name: buildName });
  assert.ok(!JSON.stringify(out).includes(build.fields.description));
  assert.ok(build.fields.description.length > 12000, 'the original content has not been pruned');
});
test('six case links cannot clip the unavailable-details next action behind a build reference', () => {
  const value = input(buildName) as any;
  const view = indexViewOf('case', 'stories', Array.from({ length: 6 }, (_, index) => caseEntry({ stories: ['21'], defects: [],
    case: `synthetic-case-${index}-long-node-identifier`, document: 'synthetic-document-long-identifier', title: '合成回归测试用例的较长标题用于验证信息截断' })));
  view.build = { build: buildName, root }; value.inputs[0] = boundView('cases', view);
  const out = project(value) as any; assert.equal(out.error, undefined);
  const [claim] = check({ subject: { items: out.items, context: { groups: out.groups } }, sources: {} }) as any[];
  assert.ok(!claim.statement.includes(out.groups[0].selected_build.reference));
  assert.match(claim.statement, /PLM 构建记录 7/);
  assert.match(claim.statement, /修复来源后重新读取并重跑/);
  assert.deepEqual(claim.data.selected_build, { id: '7', name: buildName });
});

test('an oversized build scope names its source and never advises splitting an implicit scope', () => {
  const value = input(buildName) as any;
  const view = indexViewOf('case', 'stories', [caseEntry({ stories: ['21'], defects: [], title: 'x'.repeat(6 * 1024 * 1024) })]);
  view.build = { build: buildName, root }; value.inputs[0] = boundView('cases', view);
  const out = project(value) as any;
  assert.match(out.error.message, /PLM 构建记录 7.*5 MiB/);
  assert.match(out.error.fix, /同一构建来源.*或由用户明确/);
  assert.notEqual(out.error.fix, '把需求编号列表分成更小的批次');
});

test('the row cap names an oversized build record and offers an executable scoped alternative',()=>{
  const value=input(buildName) as any;
  value.parameters.build_id='81001';
  Object.assign(value.inputs[1].model.builds[0],{id:'81001',stories:Array.from({length:8001},(_,i)=>String(i+1))});
  const out=project(value) as any;
  assert.match(out.error.message,/PLM 构建记录 81001.*8001.*8000/);
  assert.doesNotMatch(out.error.message,/为空/);
  assert.match(out.error.fix,/同一构建来源.*或由用户明确/);
  assert.doesNotMatch(out.error.fix,/超限则分批运行/);
});
test('the declared row cap states the actual size and limit',()=>{
  const value=input(buildName) as any;
  value.inputs=value.inputs.filter((source:any)=>source.slot==='cases');
  for(let from=1;from<=8001;from+=50){
    const ids=Array.from({length:Math.min(50,8002-from)},(_,i)=>String(from+i));
    value.inputs.push(boundView('stories',{stories:ids.map(id=>({id,status:null,stage:null})),unread:[]},`plm:stories:${ids.join('+')}`));
  }
  const out=project(value) as any;
  assert.match(out.error.message,/8001.*8000/);assert.match(out.error.fix,/分批/);
});
