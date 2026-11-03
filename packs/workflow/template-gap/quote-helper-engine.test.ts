import assert from 'node:assert/strict';
import { test } from 'node:test';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres } from '../../../hub/testing/postgres.ts';
import { parseModel } from '../../skill/mindmap-format/tools/parse-model.ts';
import { locateCandidates } from '../../skill/mindmap-format/tools/locate-quotes.ts';
import { openBed } from './testing/bed.ts';
import { BUILD, LOCK } from './testing/index.ts';

test('a local quotation candidate is accepted by the real run boundary', async t => {
  if (!(await osIsolationAvailable())) return t.skip('operating-system isolation unavailable');
  const postgres = await startPostgres(); const bed = await openBed(postgres);
  try {
    const doc = { root: { data: { id: 'root', text: '合成脑图', priority: 1 }, children: [{ data: { id: 'case', text: '合成用例', priority: 2, resource: ['Functional'] }, children: [{ data: { id: 'step', text: '检查合成“记录”' }, children: [] }] }] } };
    const raw = JSON.stringify(doc), bytes = Buffer.from(raw), parsed = parseModel(bytes);
    bed.agile.put('1001', { bytes, title: '合成脑图', folders: ['合成产品线', '030：合成测试项目', '101：10.8.1', '201: 10.8.1-R1-2026/1', '探测'] });
    const started = await bed.service.startRunDetailed(bed.runner, { pack: 'template-gap', product: LOCK.names[0], build: BUILD, inputs: { documents: [{ external: 'agile:mindmap:1001' }] } }, bed.call());
    assert.equal(started.answer.call_result, 'ok', JSON.stringify(started.answer.errors));
    const run = started.answer.run!;
    const [candidate] = locateCandidates(raw, parsed, [{ item: '1001:case', selector: 'n/step', text: '检查合成“记录”' }]);
    assert.equal(candidate.quotes.length, 1);
    const claim = { text: '合成模型类别判断', data: { item: '1001:case', category_id: 'audit_log', quote: candidate.quotes[0], producer: { model_id: 'synthetic-model', model_family_id: 'synthetic-family' } } };
    const answer = await bed.service.submitResult(bed.runner, { run: run.run, model: 'synthetic-model', items: [{ item: run.items[0].id, handling: 'handled', slots: { coverage: [claim] } }] }, bed.call());
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const claims = Object.values(answer.result!.partitions).flatMap(items => items.flatMap(item => item.requirements.flatMap(requirement => requirement.claims)));
    assert.ok(claims.some(row => JSON.stringify(row.statement.data).includes('audit_log')), 'the accepted result contains the submitted category');
  } finally { await bed.close(); await postgres.stop(); }
});
