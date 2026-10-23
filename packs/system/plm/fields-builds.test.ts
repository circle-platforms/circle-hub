import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { detailProject, buildsPlan, buildsProject } from './functions/plm.ts';

const bugInput = { external: { type: 'bug', key: '910001' }, original: 'detail', responses: { detail: { ok: true, json: { data: [{ id: 910001, title: '合成缺陷', fix: '不能当默认字段', repair_notes: '<p>合成修复说明</p>' }] } } } };
const content = (out: unknown): any => (out as { artifacts: Array<{ name: string; json: unknown }> }).artifacts.find((a) => a.name === 'content')!.json;

test('bug content echoes only the configured fix field name, with no existence check or fallback', () => {
  for (const setting of ['repair_notes', 'a-field-not-in-record']) {
    const result = content(detailProject({ ...bugInput, settings: { bug_fix_field: setting } }));
    assert.equal(result.fix_field, setting);
    const { fix_field, ...old } = result;
    assert.deepEqual(old, { id: '910001', kind: 'bug', title: '合成缺陷', fields: { id: '910001', title: '合成缺陷', fix: '不能当默认字段', repair_notes: '合成修复说明' }, html_fields: ['repair_notes'] });
  }
  for (const setting of [undefined, '', '   ', null, 3]) assert.equal(content(detailProject({ ...bugInput, settings: { bug_fix_field: setting } })).fix_field, null);
  const result = detailProject({ ...bugInput, settings: { bug_fix_field: 'repair_notes' } }) as { artifacts: Array<{ name: string; json: Record<string, unknown> }> };
  assert.equal(Object.hasOwn(result.artifacts.find((a) => a.name === 'meta')!.json, 'fix_field'), false);
  const story = content(detailProject({ ...bugInput, external: { type: 'story', key: '910001' }, settings: { bug_fix_field: 'repair_notes' } }));
  assert.equal(Object.hasOwn(story, 'fix_field'), false);
});

const names = encodeURIComponent(' ＳＹＮＴＨＥＴＩＣ ') + '+' + encodeURIComponent('Alternate');
const products = [{ id: 410, name: ' Synthetic / Alternate / Extra ' }, { id: 411, name: 'Other' }];
const request = (key = names) => ({ external: { type: 'builds', key } });
const productResponse = (items = products) => ({ products: { ok: true, json: { code: 1000, data: items } } });
const builds = [{ id: 8, name: 'Synthetic_10_7_A', synthetic_links: [21, '00022'] }, { id: '9', name: 'Synthetic_10_7_B' }];

test('numeric build keys retain one request and merge all story-trace content fields', () => {
  assert.deepEqual(buildsPlan(request('410')), { requests: [{ key: 'builds', route: 'builds', query: { product: '410' } }], original: 'builds', done: true });
  const out = content(buildsProject({ ...request('410'), original: 'builds', settings: { build_story_field: 'synthetic_links' }, responses: { builds: { ok: true, json: builds } } }));
  assert.deepEqual(out, { product: { id: '410', name: null }, product_resolution: 'resolved', builds: [
    { id: '8', name: 'Synthetic_10_7_A', fields: { id: 8, name: 'Synthetic_10_7_A' }, stories: ['21', '22'], scope_note: '需求范围取自构建记录' },
    { id: '9', name: 'Synthetic_10_7_B', fields: { id: '9', name: 'Synthetic_10_7_B' }, stories: null, scope_note: '构建记录里没有需求字段，请给出需求编号；字段 synthetic_links 缺失或不是需求编号数组' },
  ] });
});
test('names require every normalized slash-separated alias on exactly one product', () => {
  assert.deepEqual(buildsPlan(request()), { requests: [{ key: 'products', route: 'products' }], done: false });
  assert.deepEqual(buildsPlan({ ...request(), responses: productResponse() }), { requests: [{ key: 'builds', route: 'builds', query: { product: '410' } }], original: 'builds', done: true });
  const out = content(buildsProject({ ...request(), responses: { ...productResponse(), builds: { ok: true, json: [] } }, original: 'builds' }));
  assert.deepEqual(out, { product: { id: '410', name: products[0].name }, product_resolution: 'resolved', builds: [] });
  // A substring and a partial set of aliases prove no match.
  for (const key of ['Synthe+Alternate', 'Synthetic+Absent']) assert.equal(content(buildsProject({ ...request(key), responses: productResponse(), original: 'products' })).product_resolution, 'unresolved');
});
test('zero or multiple matches never issue a build request or invent an empty resolved product', () => {
  for (const [items, resolution] of [[[], 'unresolved'], [[products[0], { id: 412, name: 'Alternate / Synthetic' }], 'ambiguous']] as const) {
    const input = { ...request(), responses: productResponse([...items]), original: 'products' };
    assert.deepEqual(buildsPlan(input), { requests: [], original: 'products', done: true });
    assert.deepEqual(content(buildsProject(input)), { product: null, product_resolution: resolution, builds: [] });
  }
});
test('malformed keys or responses refuse without guessing names or empty build lists', () => {
  for (const key of ['', 'Synthetic+', '%ZZ', '1234567890']) assert.deepEqual(buildsPlan(request(key)).requests, []);
  assert.ok('error' in (buildsProject({ ...request(), responses: { products: { json: {} } }, original: 'products' }) as object));
  assert.ok('error' in (buildsProject({ ...request(), responses: productResponse([{ id: 410, name: null as unknown as string }]), original: 'products' }) as object));
  assert.ok('error' in (buildsProject({ ...request('410'), responses: { builds: { json: {} } }, original: 'builds' }) as object));
});
test('profile declares the fix setting and the two-request build planner', () => {
  const profile = JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8'));
  assert.match(profile.reads.find((r: { name: string }) => r.name === 'bug').description, /settings\.bug_fix_field/);
  const builds = profile.reads.find((r: { name: string }) => r.name === 'builds');
  assert.equal(builds.max_requests, 2); assert.equal(builds.request, undefined);
  assert.deepEqual(builds.plan, { module: 'functions/plm.ts', export: 'buildsPlan' });
});

test('percent-encoded literal pluses and Unicode aliases remain separate names', () => {
  const key = encodeURIComponent('Gamma+Delta') + '+' + encodeURIComponent('合成族');
  const input = { ...request(key), responses: productResponse([{ id: 410, name: 'ＧＡＭＭＡ+ＤＥＬＴＡ／合成族' }]) };
  assert.deepEqual(buildsPlan(input).requests, [{ key: 'builds', route: 'builds', query: { product: '410' } }]);
});
