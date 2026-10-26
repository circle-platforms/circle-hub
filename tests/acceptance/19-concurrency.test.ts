// Scenario 19 (brief section 9 & task acceptance.md):
// Concurrency: ten parallel submit_result calls for different runs and two for the same (run, digest).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import { type McpClient } from './support/mcp.ts';
import { draft, resultOf, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s19-concurrency');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});

after(async () => {
  await bed?.close().catch(() => {});
  await postgres?.stop().catch(() => {});
});

describe('scenario 19: concurrency with parallel submissions', () => {
  test('ten parallel submit_result calls for different runs all succeed without conflict', async () => {
    const runCount = 10;
    const runs: RunSummary[] = [];

    // Start 10 runs sequentially or in small batches
    for (let i = 0; i < runCount; i++) {
      const run = await startReview(client, {
        product: bed.product.names[0],
        version: bed.site.LINE,
        inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      });
      assert.ok(run.run);
      runs.push(run);
    }
    assert.equal(runs.length, 10);

    // Prepare draft submissions for each run
    const submissions = runs.map((r) => draft(r));

    // Submit all 10 concurrently
    const answers = await Promise.all(submissions.map((sub) => client.call('submit_result', sub)));

    // Verify all 10 succeeded
    for (let i = 0; i < runCount; i++) {
      const ans = answers[i];
      assert.equal(ans.isError, false, ans.text);
      assert.equal(ans.out.call_result, 'ok');
      assert.equal(ans.out.acceptance, 'accepted');

      const result = resultOf(ans);
      assert.equal(result.run, runs[i].run);
      assert.equal(result.partitions.delivered.length, runs[i].items.length);

      // Record stored in database for each run
      const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: runs[i].run });
      assert.equal(stored.items.length, 1);
    }
  });

  test('parallel transitional repeats keep one original and append serialized current results', async () => {
    // Start a new run
    const run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.ok(run.run);

    const submission = draft(run);

    // Fire two identical submit_result calls simultaneously
    const [ans1, ans2] = await Promise.all([
      client.call('submit_result', submission),
      client.call('submit_result', submission),
    ]);

    // Both succeed without concurrency errors or deadlock
    assert.equal(ans1.isError, false, ans1.text);
    assert.equal(ans2.isError, false, ans2.text);
    assert.equal(ans1.out.call_result, 'ok');
    assert.equal(ans2.out.call_result, 'ok');
    assert.equal(ans1.out.acceptance, 'accepted');
    assert.equal(ans2.out.acceptance, 'accepted');

    const result1 = resultOf(ans1);
    const result2 = resultOf(ans2);

    // Both return identical result structures
    assert.equal(result1.run, run.run);
    assert.equal(result2.run, run.run);
    assert.equal(result1.partitions.delivered.length, run.items.length);
    assert.equal(result2.partitions.delivered.length, run.items.length);

    // Each unresolved validation is current; only the original and repair charge are deduplicated.
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: run.run });
    assert.ok(ans1.out.counts!.unknown>0&&ans2.out.counts!.unknown>0);
    assert.equal(stored.items.length,2);
    assert.equal((await bed.hub.records.store.find({key:'runs.submission.run',value:run.run})).items.length,1);
    const third=await client.call('submit_result',submission);
    assert.equal(resultOf(third).rounds.used,Math.max(result1.rounds.used,result2.rounds.used));

    // Both calls are recorded in the call log
    const logPage = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: run.run });
    const submitLogs = logPage.items.filter((l) => l.tool === 'submit_result');
    assert.ok(submitLogs.length >= 2, `expected at least 2 submit_result logs, got ${submitLogs.length}`);

    // Console page for the run renders cleanly
    const page = await consoleClient.get(`/console/runs/${run.run}`);
    assert.equal(page.status, 200);
    assert.match(page.body, new RegExp(run.run));
  });
});
