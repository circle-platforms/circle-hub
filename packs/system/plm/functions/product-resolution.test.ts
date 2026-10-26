import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildsPlan, buildsProject } from './plm.ts';
const request = (rows: unknown[]) => ({ external: { type: 'builds', key: 'Alpha+Beta' }, original: 'products', responses: { products: { ok: true, json: { code: 1000, data: rows } } } });
test('unresolved and ambiguous products leave builds unread, carry candidates and actionable incomplete coverage', () => {
  for (const [rows, resolution, candidates] of [
    [[], 'unresolved', []],
    [[{ id: 410, name: 'Alpha/Beta' }, { id: 411, name: 'Beta/Alpha' }], 'ambiguous', [{ id: '410', name: 'Alpha/Beta' }, { id: '411', name: 'Beta/Alpha' }]],
  ] as const) {
    const input = request([...rows]); const out = buildsProject(input) as any;
    assert.equal(out.complete, false); assert.match(out.note, /下一步.*plm:builds:/);
    const data = out.artifacts[0].json;
    assert.equal(data.builds, null); assert.equal(data.product_resolution, resolution);
    assert.deepEqual(data.candidates, candidates); assert.deepEqual(data.requested_names, ['alpha', 'beta']);
    assert.equal(data.note, out.note); assert.deepEqual(buildsPlan(input).requests, []);
  }
});
test('repeated rows for one product id do not create an ambiguous product', () => {
  const out = buildsPlan(request([{ id: 410, name: 'Alpha/Beta' }, { id: '410', name: 'Alpha/Beta' }]));
  assert.deepEqual(out.requests, [{ key: 'builds', route: 'builds', query: { product: '410' } }]);
});

test('whole product names normalize before slash splitting, while requested aliases may not contain either slash spelling', () => {
  for (const name of ['Alpha/Beta', 'Ａｌｐｈａ／Ｂｅｔａ']) assert.equal(buildsPlan(request([{ id: 410, name }])).requests[0]?.route, 'builds');
  for (const key of ['A%2FB', encodeURIComponent('A／B')]) {
    const input = { external: { type: 'builds', key }, responses: {}, original: 'products' };
    assert.deepEqual(buildsPlan(input).requests, []);
    const out = buildsProject(input) as any; assert.equal(out.error.code, 'plm.invalid_key'); assert.match(out.error.message, /不能有.*\//);
  }
});

test('numeric keys disclose declared identity separately from a verified product lookup', () => {
  const out = buildsProject({ external: { type: 'builds', key: '999999999' }, original: 'builds', responses: { builds: { ok: true, json: [] } } }) as any;
  assert.match(out.note, /编号取自读取键/); assert.match(out.note, /没有对照产品列表/); assert.match(out.note, /为空不证明产品存在/);
  assert.equal(out.artifacts[0].json.note, out.note);
  assert.deepEqual(buildsPlan({ external: { type: 'builds', key: '999999999' } }).requests, [{ key: 'builds', route: 'builds', query: { product: '999999999' } }]);
});

test('key and product failures identify the actual rule and offending row with a usable fallback', () => {
  for (const [key, rule] of [['1234567890', /9 位/], ['Alpha+', /第 2.*为空/], ['Alpha+%ZZ', /第 2.*百分号/]] as const) {
    const out = buildsProject({ external: { type: 'builds', key }, responses: {}, original: 'products' }) as any;
    assert.equal(out.error.code, 'plm.invalid_key'); assert.match(out.error.message, rule);
  }
  for (const [rows, expected] of [[[{ id: 410, name: 'Alpha/Beta' }, { id: 411 }], /第 2.*411.*name/], [[{ id: '1234567890', name: 'Alpha/Beta' }], /第 1.*1.*9.*位/]] as const) {
    const out = buildsProject(request([...rows])) as any;
    assert.equal(out.error.code, 'plm.no_products'); assert.match(out.error.message, expected); assert.match(out.error.message, /plm:builds:/);
  }
});
