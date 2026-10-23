// Synthetic run through the registry and engine: the missing-manual warning must reach the caller's result.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from '../../../hub/testing/postgres.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { BUILD, call, openHub } from './testing/hub.ts';

test('fix-only start_run returns the version-line manual gap and source restriction', async t => {
  if (!await osIsolationAvailable()) return t.skip('sandbox-exec is unavailable');
  const postgres = await startPostgres(); t.after(() => postgres.stop());
  const hub = await openHub(postgres); t.after(() => hub.close());
  const index = [...hub.external.objects.keys()].find(id => id.startsWith('knowledge:index:')); assert.ok(index);
  const id = '990001';
  hub.external.put(`plm:bug:${id}`, { bytes: Buffer.from(JSON.stringify({ id, title: '合成缺陷', fix_field: 'repair_notes', fields: { repair_notes: '合成修复说明', status: 'closed' } })), mediaType: 'application/json', meta: { title: '合成缺陷', status: 'closed' } });
  const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'defect-to-case', product: BUILD.family, build: BUILD.name, inputs: { defects: [{ external: `plm:bug:${id}` }], indexed_cases: { external: index } } }, call('manual-gap'));
  assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
  const gap = detail.gaps?.find(g => g.code === 'defect-to-case.manual_missing');
  assert.ok(gap, JSON.stringify(detail.gaps));
  assert.ok(gap.message.includes(BUILD.line)); assert.ok(gap.message.includes(`manual:cli:${BUILD.line}`));
  assert.match(gap.message, /repair_notes/); assert.match(gap.message, /仅|只能/); assert.match(gap.message, /重开|重跑/);
  assert.match(detail.answer.run!.items[0]!.summary!, /未绑定手册/);
});
