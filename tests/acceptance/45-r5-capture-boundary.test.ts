import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureText } from '../fixtures/mindmaps/index.ts';
import { startPostgres } from '../../hub/testing/postgres.ts';
import { newId } from '../../hub/records/api.ts';
import { putRun } from '../../hub/runs/engine/store.ts';
import { RunRecord } from '../../contracts/src/run.ts';
import { openBed } from './support/hub.ts';
import { draft, finding, startReview } from './support/review.ts';

test('a client_captured original cannot become the ground of another workflow', async t => {
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const bed = await openBed({ postgres, syncOneName: false });
  t.after(() => bed.close());
  const client = await bed.connect(bed.reviewer, 'sess-capture-boundary');
  const text = fixtureText('review-150.km.json');
  const uploaded = await client.call('upload_file', {
    file_path: Buffer.from(text).toString('base64'), name: 'capture-boundary.json', media_type: 'application/json', provenance_type: 'client_captured',
  });
  assert.equal(uploaded.isError, false, uploaded.text);
  const sha = String(uploaded.out.sha256);
  const started = await client.call('start_run', {
    pack: 'case-review', product: bed.product.names[1], version: bed.site.LINE,
    inputs: { subject: { reference: `src:${sha}` } },
  });
  if (started.isError) {
    assert.match(started.text, /client_captured|决定 73|客户端捕获/);
    return;
  }
  const run = started.out.run;
  assert.ok(run);
  const item = run.items[0];
  assert.ok(item);
  const claim = finding(item);
  const answer = await client.call('submit_result', draft(run, new Map([[item.id, [claim]]])));
  assert.equal(answer.out.acceptance, 'not_accepted', answer.text);
  assert.match(JSON.stringify(answer.out.errors), /client_captured|决定 73|客户端捕获/);
});

test('a persisted ordinary run with a captured input keeps the declaration-grade refusal', async t => {
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const bed = await openBed({ postgres, syncOneName: false });
  t.after(() => bed.close());
  const client = await bed.connect(bed.reviewer, 'sess-legacy-capture-boundary');
  const text = fixtureText('review-150.km.json');
  const file_path = Buffer.from(text).toString('base64');
  const declared = await client.call('upload_file', { file_path, name: 'legacy-declared.json', media_type: 'application/json', provenance_type: 'declared' });
  const captured = await client.call('upload_file', { file_path, name: 'legacy-captured.json', media_type: 'application/json', provenance_type: 'client_captured' });
  assert.equal(declared.isError, false, declared.text);
  assert.equal(captured.isError, false, captured.text);
  assert.equal(declared.out.sha256, captured.out.sha256);
  const started = await client.call('start_run', {
    pack: 'case-review', product: bed.product.names[1], version: bed.site.LINE,
    inputs: { subject: { reference: `src:${declared.out.sha256}`, artifact: declared.out.artifact } },
  });
  assert.equal(started.isError, false, started.text);
  const template = started.out.run;
  assert.ok(template);
  const persisted = await bed.hub.hub.runs.getRun(bed.reviewer.principal, template.run);
  assert.ok(persisted);
  const {feeding_offset:_feedingOffset, ...historical} = persisted.run;
  for (const artifact of [captured.out.artifact, undefined]) {
    const old = RunRecord.parse({
      ...historical, run: newId('run'), started_at: '2026-01-01T00:00:00.000Z',
      sources: persisted.run.sources.map(source => source.slot === 'subject' ? { ...source, artifact } : source),
    });
    assert.equal(old.sources.find(source => source.slot === 'subject')?.artifact, artifact);
    await putRun(bed.hub.records.store, old, '2026-01-01T00:00:00.000Z');
    const item = old.items[0];
    assert.ok(item);
    const answer: Awaited<ReturnType<typeof client.call>> = await client.call('submit_result', draft({...template, run:old.run}, new Map([[item.id, [finding(item)]]])));
    assert.equal(answer.out.acceptance, 'not_accepted', answer.text);
    assert.match(JSON.stringify(answer.out.errors), /client_captured|决定 73|客户端捕获/);
  }
});
