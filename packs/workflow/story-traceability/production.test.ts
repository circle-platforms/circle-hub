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
    const casesId = `knowledge:index:apv:${BUILD.name}?kind=case&key=stories&fields=document,node,title`;
    hub.views.put('plm:stories:21+22', { stories: [{ id: '21', status: 'synthetic', stage: 'synthetic-stage', title: '合成需求' }], unread: ['22'] });
    hub.views.put(casesId, indexViewOf('case', 'stories', [caseEntry({ defects: ['22'], stories: ['21'], case: 'c1' })], {}, ['document', 'node', 'title']));
    const result = await hub.service.startRunDetailed(hub.alice, { pack: 'story-traceability', inputs: { stories: [{ external: 'plm:stories:21+22' }], cases: { external: casesId } } }, call());
    assert.equal(result.answer.call_result, 'ok', JSON.stringify(result.answer.errors));
    assert.deepEqual(result.answer.run?.items.map(i => i.id), ['21', '22']);
    assert.ok(result.production);
    assert.equal(result.production.result.acceptance, 'accepted');
    assert.deepEqual(result.production.counts, { delivered: 2, rejected: 0, quarantined: 0, incomplete: 0, unknown: 1 });
    const count = result.production.result.cross_item.find(c => c.requirement === 'counts')!;
    assert.deepEqual([count.statement.data?.stories, count.statement.data?.traced, count.statement.data?.plm_unread], [2, 1, 1]);
    const unknown = result.production.result.partitions.delivered.find(i => i.item === '22')!;
    assert.equal(unknown.requirements[0].claims[0].statement.verdict, 'unknown');
    assert.match(unknown.requirements[0].claims[0].statement.text, /请管理员运行知识同步，完成后重跑/);
  });
  test('build-derived scope reads details automatically and records its origin', async () => {
    const casesId = `knowledge:index:apv:${BUILD.name}?kind=case&key=stories&fields=document,node,title`;
    hub.views.put('plm:builds:5', { builds: [{ id: '7', stories: ['21', '22'], scope_note: '需求范围取自构建记录' }] });
    const result = await hub.service.startRunDetailed(hub.alice, { pack: 'story-traceability', inputs: { build: { external: 'plm:builds:5' }, cases: { external: casesId } }, parameters: { build_id: '7' } }, call());
    assert.equal(result.answer.call_result, 'ok', JSON.stringify(result.answer.errors));
    assert.ok(result.production);
    assert.match(result.answer.run!.items[0].summary!, /需求范围取自构建记录/);
    const total = result.production.result.cross_item.find(c => c.requirement === 'counts')!;
    assert.equal(total.statement.data?.plm_unread, 1);
  });

});
