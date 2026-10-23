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
