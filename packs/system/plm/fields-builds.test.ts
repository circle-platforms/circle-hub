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
    assert.deepEqual(old, { id: '910001', kind: 'bug', title: '合成缺陷', fields: { id: '910001', title: '合成缺陷', fix: '不能当默认字段', repair_notes: '合成修复说明' }, html_fields: ['repair_notes'], fix_notes: null, fix_notes_note: '缺少设置 settings.bug_fix_actions' });
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
  assert.match(out.note, /没有对照产品列表/);
  assert.deepEqual(out, { note: out.note, product: { id: '410', name: null }, product_resolution: 'resolved', builds: [
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
    const out = buildsProject(input) as any; const data = content(out);
    assert.equal(data.product, null); assert.equal(data.product_resolution, resolution); assert.equal(data.builds, null);
    assert.equal(out.complete, false); assert.match(out.note, /下一步/); assert.equal(data.candidates.length, items.length);
  }
});
test('malformed keys or responses refuse without guessing names or empty build lists', () => {
  for (const key of ['', 'Synthetic+', '%ZZ', '1234567890']) assert.deepEqual(buildsPlan(request(key)).requests, []);
  const malformed = buildsProject({ ...request(), responses: { products: { json: {} } }, original: 'products' }) as any;
  assert.equal(malformed.error.code, 'plm.no_products'); assert.match(malformed.error.message, /data.*数组.*plm:builds:/);
  const missingName = buildsProject({ ...request(), responses: productResponse([{ id: 410, name: null as unknown as string }]), original: 'products' }) as any;
  assert.equal(missingName.error.code, 'plm.no_products'); assert.match(missingName.error.message, /第 1.*410.*name/);
  const badBuilds = buildsProject({ ...request('410'), responses: { builds: { json: {} } }, original: 'builds' }) as any;
  assert.equal(badBuilds.error.code, 'plm.no_records'); assert.match(badBuilds.error.message, /构建列表不是数组.*重新读取/);
});
test('fix notes keep only exact declared action codes and non-empty comments, in order', () => {
  const actions = [
    { id: 1, actor: 'synthetic-opener', action: 'opened', date: '2026-04-01 00:00:00', comment: '', extra: '' },
    { id: 2, actor: 'synthetic-dev', action: 'assigned', date: '2026-04-02 00:00:00', comment: '<p>合成分配说明</p>', extra: '' },
    { id: 3, actor: 'synthetic-dev', action: 'svncommited', date: '2026-04-03 00:00:00', comment: '合成提交说明', extra: '' },
    { id: 4, actor: 'synthetic-dev', action: 'resolved', date: '2026-04-04 00:00:00', comment: '', extra: 'fixed' },
    { id: 5, actor: 'synthetic-dev', action: 'edited', date: '2026-04-05 00:00:00', comment: '  合成编辑说明  ', extra: '' },
    { id: 6, actor: 'synthetic-dev', action: 'Assigned', date: '2026-04-06 00:00:00', comment: '大小写不同不能收入', extra: '' },
    { id: 7, actor: 'synthetic-dev', action: 'closed', date: '2026-04-07 00:00:00', comment: '未声明的动作不收入', extra: '' },
  ];
  const input = { external: { type: 'bug', key: '910001' }, original: 'detail', settings: { bug_fix_actions: '["assigned","svncommited","edited"]' }, responses: { detail: { ok: true, json: { data: [{ id: 910001, title: '合成缺陷', actions }] } } } };
  const result = content(detailProject(input));
  assert.equal(result.fix_notes_note, undefined);
  assert.deepEqual(result.fix_notes, [
    { action: 'assigned', date: '2026-04-02 00:00:00', actor: 'synthetic-dev', comment: '合成分配说明', index: 1 },
    { action: 'svncommited', date: '2026-04-03 00:00:00', actor: 'synthetic-dev', comment: '合成提交说明', index: 2 },
    { action: 'edited', date: '2026-04-05 00:00:00', actor: 'synthetic-dev', comment: '  合成编辑说明  ', index: 4 },
  ]);
  assert.deepEqual(result.fields.actions, actions);
  assert.deepEqual(content(detailProject({ ...input, settings: { bug_fix_actions: '[]' } })).fix_notes, []);
  for (const setting of ['not-json', '["assigned", 1]', { codes: ['assigned'] }]) {
    const out = content(detailProject({ ...input, settings: { bug_fix_actions: setting } }));
    assert.equal(out.fix_notes, null);
    assert.match(out.fix_notes_note, /settings\.bug_fix_actions/);
  }
});
test('profile declares the fix setting and the two-request build planner', () => {
  const profile = JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8'));
  assert.match(profile.reads.find((r: { name: string }) => r.name === 'bug').description, /settings\.bug_fix_field/);
  assert.match(profile.reads.find((r: { name: string }) => r.name === 'bug').description, /settings\.bug_fix_actions/);
  const builds = profile.reads.find((r: { name: string }) => r.name === 'builds');
  assert.equal(builds.max_requests, 2); assert.equal(builds.request, undefined);
  assert.deepEqual(builds.plan, { module: 'functions/plm.ts', export: 'buildsPlan' });
});

test('percent-encoded literal pluses and Unicode aliases remain separate names', () => {
  const key = encodeURIComponent('Gamma+Delta') + '+' + encodeURIComponent('合成族');
  const input = { ...request(key), responses: productResponse([{ id: 410, name: 'ＧＡＭＭＡ+ＤＥＬＴＡ／合成族' }]) };
  assert.deepEqual(buildsPlan(input).requests, [{ key: 'builds', route: 'builds', query: { product: '410' } }]);
});
