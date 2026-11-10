// B07 R[10] (decision 150): when an accepted submission issues its requests, the requests the run's earlier submissions
// issued and nobody answered are void. Before this rule a run submitted 56 times listed 3,920 waiting requests.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { draft, finding, resultOf, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s59-supersede');
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

test('an accepted resubmission voids the waiting requests of the earlier submission and leaves one set waiting', async () => {
  const run = await startReview(client, { product: bed.product.names[1], version: bed.site.LINE, parameters: { stories: ['31057'], bugs: ['31057'] }, inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } } });
  const requests = () => bed.hub.hub.runs.listRequests!(bed.reviewer.principal, run.run);

  const first = resultOf(await client.call('submit_result', draft(run)));
  assert.equal(first.acceptance, 'accepted');
  const afterFirst = await requests();
  assert.ok(afterFirst.length > 0, 'the first submission leaves requests');
  assert.ok(afterFirst.every((request) => request.answered_by === null && request.superseded === undefined && request.source === first.submission), 'all of them wait and name the first submission');

  // A different submission of the same run: one finding more, the same gaps otherwise.
  const second = resultOf(await client.call('submit_result', draft(run, new Map([[run.items[0].id, [finding(run.items[0], { text: '合成发现：期望结果没有写出可核对的数值' })]]]))));
  assert.equal(second.acceptance, 'accepted');
  assert.notEqual(second.submission, first.submission);
  const afterSecond = await requests();
  const earlier = afterSecond.filter((request) => request.source === first.submission);
  assert.equal(earlier.length, afterFirst.length, 'the earlier requests stay on record');
  assert.ok(earlier.every((request) => request.superseded === true && request.answered_by !== null), 'and every one of them is void');
  assert.equal(new Set(earlier.map((request) => request.answered_by)).size, 1, 'voided by the one later result');
  const waiting = afterSecond.filter((request) => request.answered_by === null);
  assert.ok(waiting.length > 0 && waiting.every((request) => request.source === second.submission), 'only the requests of the newest submission wait');
  assert.equal(afterSecond.length, earlier.length + waiting.length, 'nothing else was closed or added');

  // The same bytes again are the same submission: no new set and nothing more to void.
  await client.call('submit_result', draft(run, new Map([[run.items[0].id, [finding(run.items[0], { text: '合成发现：期望结果没有写出可核对的数值' })]]])));
  assert.equal((await requests()).filter((request) => request.answered_by === null).length, waiting.length);

  // The first content again, after another submission, is evaluated anew and is the run's result once more. Its requests
  // were voided and are deduplicated by key, so they wait again instead of being written anew, and the second set is void.
  const again = resultOf(await client.call('submit_result', draft(run)));
  assert.equal(again.acceptance, 'accepted');
  assert.equal(again.submission, first.submission);
  const afterRepeat = await requests();
  assert.equal(afterRepeat.length, afterSecond.length, 'no request was written anew');
  assert.deepEqual(afterRepeat.filter((request) => request.answered_by === null).map((request) => request.record).sort(), afterFirst.map((request) => request.record).sort(), 'the first set waits again');
  assert.ok(afterRepeat.filter((request) => request.source === second.submission).every((request) => request.superseded === true), 'and the second set is void');
});
