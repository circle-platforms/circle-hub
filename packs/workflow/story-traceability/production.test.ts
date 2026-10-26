import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { caseEntry, indexViewOf } from '../traceability/functions/test-support.ts';
import { openHub, call, BUILD, type Hub } from './test-hub.ts';
const skip = (await osIsolationAvailable()) ? false : 'OS network isolation unavailable';
let pg: TemporaryPostgres;
let hub: Hub;
before(async () => { if (!skip) { pg = await startPostgres(); hub = await openHub(pg); } });
after(async () => { await hub?.close(); await pg?.stop(); });
describe('synthetic story production run', { skip }, () => {
  test('publishes and verifies story facts with fake PLM and knowledge at start_run', async () => {
    const casesId = `knowledge:index:famx:${BUILD.name}?kind=case&key=stories&fields=document,node,title`;
    hub.views.put('plm:stories:21+22', { stories: [{ id: '21', status: 'synthetic', stage: 'synthetic-stage', title: '合成需求' }], unread: ['22'] });
    hub.views.put(casesId, indexViewOf('case', 'stories', [caseEntry({ defects: ['22'], stories: ['21'], case: 'c1' })], {}, ['document', 'node', 'title']));
    const result = await hub.service.startRunDetailed(hub.alice, { pack: 'story-traceability', inputs: { stories: [{ external: 'plm:stories:21+22' }], cases: { external: casesId } } }, call());
    assert.equal(result.answer.call_result, 'ok', JSON.stringify(result.answer.errors));
    assert.deepEqual(result.answer.run?.items.map(i => i.id), ['21', '22']);
    assert.ok(result.production);
    assert.equal(result.production.result.acceptance, 'accepted');
    assert.deepEqual(result.production.counts, { delivered: 2, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
    const count = result.production.result.cross_item.find(c => c.requirement === 'counts')!;
    assert.deepEqual([count.statement.data?.stories, count.statement.data?.traced, count.statement.data?.plm_unread], [2, 1, 1]);
    const unknown = result.production.result.partitions.delivered.find(i => i.item === '22')!;
    assert.equal(unknown.requirements[0].claims[0].statement.verdict, 'support');
    assert.match(unknown.requirements[0].claims[0].statement.text, /完整需求号键列表覆盖的索引视图/);
  });
  test('build-derived scope reads details automatically and records its origin', async () => {
    const casesId = `knowledge:index:famx:${BUILD.name}?kind=case&key=stories&fields=document,node,title`;
    hub.views.put('plm:builds:5', { builds: [{ id: '7', name: BUILD.name, stories: ['21', '22'], scope_note: '需求范围取自构建记录' }] });
    const result = await hub.service.startRunDetailed(hub.alice, { pack: 'story-traceability', inputs: { build: { external: 'plm:builds:5' }, cases: { external: casesId } }, parameters: { build_id: '7' } }, call());
    assert.equal(result.answer.call_result, 'ok', JSON.stringify(result.answer.errors));
    assert.ok(result.production);
    assert.match(result.answer.run!.items[0].summary!, /需求范围依据：观察/);
    const total = result.production.result.cross_item.find(c => c.requirement === 'counts')!;
    assert.equal(total.statement.data?.plm_unread, 1);
  });

  test('an expected batch read failure is counted as unavailable rather than as a missing id', async () => {
    const casesId = `knowledge:index:famx:${BUILD.name}?kind=case&key=stories&fields=document,node,title`;
    hub.views.put('plm:builds:5', { builds: [{ id: '7', name: BUILD.name, stories: ['31', '32'] }] });
    const result = await hub.service.startRunDetailed(hub.alice, { pack: 'story-traceability', inputs: { build: { external: 'plm:builds:5' }, cases: { external: casesId } }, parameters: { build_id: '7' } }, call());
    assert.equal(result.answer.call_result, 'ok', JSON.stringify(result.answer.errors));
    const total = result.production!.result.cross_item.find(c => c.requirement === 'counts')!;
    assert.equal(total.statement.data?.plm_unread, 0); assert.equal(total.statement.data?.plm_unavailable, 2);
    assert.equal(result.production!.counts.unknown, 0);
    assert.ok(hub.views.reads.includes('plm:stories:31+32'));
  });

  test('rejects a neighboring build before production and names the selected record on an exact matching name', async () => {
    const casesId = `knowledge:index:famx:${BUILD.name}?kind=case&key=stories&fields=document,node,title`;
    hub.views.put(casesId, indexViewOf('case', 'stories', [caseEntry({ defects: [], stories: ['21'], case: 'identity-case' })], {}, ['document', 'node', 'title']));
    hub.views.put('plm:stories:21', { stories: [{ id: '21', stage: 'synthetic-stage', fields_absent: ['status'] }], unread: [] });
    const start = () => hub.service.startRunDetailed(hub.alice, { pack: 'story-traceability', inputs: { build: { external: 'plm:builds:5' }, cases: { external: casesId } }, parameters: { build_id: '007' } }, call());
    hub.views.put('plm:builds:5', { builds: [{ id: '7', name: 'Synthetic_10_7_B', stories: ['21'] }] });
    const reads = hub.views.reads.length;
    const wrong = await start();
    assert.equal(wrong.answer.call_result, 'error'); assert.equal(wrong.production, null);
    const refusal = wrong.answer.errors.find((e) => e.code === 'story-traceability.invalid_input');
    assert.ok(refusal, JSON.stringify(wrong.answer.errors));
    assert.ok(refusal.message.includes('Synthetic_10_7_B') && refusal.message.includes(BUILD.name));
    assert.ok(typeof refusal.fix === 'string' && refusal.fix.includes('重绑'));
    assert.ok(!hub.views.reads.slice(reads).some((id) => id.startsWith('plm:stories:')));
    hub.views.put('plm:builds:5', { builds: [{ id: '7', name: BUILD.name, stories: ['21'], fields: { id: 7, name: BUILD.name, custom: false } }] });
    const right = await start(); assert.equal(right.answer.call_result, 'ok', JSON.stringify(right.answer.errors));
    assert.ok(right.production);
    const item = Object.values(right.production.result.partitions).flat().find((i) => i.item === '21')!;
    const claim = item.requirements.find((r) => r.requirement === 'traced')!.claims[0];
    const selection = claim.statement.data!.selected_build as { id: string; name: string };
    assert.equal(selection.id, '7'); assert.equal(selection.name, BUILD.name);
    assert.deepEqual(selection, { id: '7', name: BUILD.name });
    assert.match(claim.statement.text, /PLM 构建记录 7/); assert.ok(!claim.statement.text.includes('/json@1/p/builds/0')); assert.ok(claim.grounds.some(reference => reference.endsWith('/json@1/p/builds/0')));
  });

});

test('projection refusals preserve their detail while partial views refuse at the Hub binding boundary', { skip }, async () => {
  const { default: project } = await import('./functions/project.ts');
  const { boundView } = await import('../traceability/functions/test-support.ts');
  const casesId = `knowledge:index:famx:${BUILD.name}?kind=case&key=stories&fields=document,node,title`;
  const view = indexViewOf('case', 'stories', [], { skipped: 1, truncated: false }, ['document', 'node', 'title']);
  const stories = { stories: [{ id: '23', status: 'synthetic', stage: null }], unread: [] };
  const expected = project({ inputs: [boundView('stories', stories, 'plm:stories:23'), boundView('cases', view)] }) as any;
  hub.views.put(casesId, view); hub.views.put('plm:stories:23', stories);
  const result = await hub.service.startRun(hub.alice, { pack: 'story-traceability', inputs: { stories: [{ external: 'plm:stories:23' }], cases: { external: casesId } } }, call());
  assert.equal(result.call_result, 'error');
  const refusal = result.errors[0];
  assert.deepEqual([refusal.code, refusal.message, refusal.fix], [expected.error.code, expected.error.message, expected.error.fix]);
  assert.notEqual(refusal.message, '任务包的投影函数给出的结果不符合 projection-output@1');
  hub.views.put(casesId,{...view,truncated:true});
  const partial=await hub.service.startRun(hub.alice,{pack:'story-traceability',inputs:{stories:[{external:'plm:stories:23'}],cases:{external:casesId}}},call());
  assert.equal(partial.call_result,'error');assert.equal(partial.errors[0].code,'SUBMISSION_SCHEMA_VIOLATION');
  assert.match(partial.errors[0].message,/未交付.*不能作为完整绑定/);assert.ok(partial.errors[0].fix);
});
