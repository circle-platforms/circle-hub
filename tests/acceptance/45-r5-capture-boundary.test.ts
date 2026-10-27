import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureText } from '../fixtures/mindmaps/index.ts';
import { startPostgres } from '../../hub/testing/postgres.ts';
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
