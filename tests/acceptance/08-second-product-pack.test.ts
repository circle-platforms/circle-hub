// Scenario 8 (brief section 9): A second, non-FAMX synthetic product pack reviews
// with the same workflow pack and the core code does not change.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { draft, itemResult, resultOf, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s08-second-prod');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 8: second product pack reviews with same workflow pack', () => {
  let run: RunSummary;
  let uploadRef: string;

  test('upload_file uploads the second product mind map fixture', async () => {
    uploadRef = await client.upload(bed.store.reviewMindmap(), 'lumen-review.km.json');
    assert.match(uploadRef, /^src:[0-9a-f]{64}$/);
  });

  test('start_run starts a review on the second product (Lumen API) with case-review workflow pack', async () => {
    run = await startReview(client, {
      product: 'Lumen API',
      version: '2.1',
      inputs: { subject: { reference: uploadRef } },
    });

    assert.equal(run.product, 'lumen-api');
    assert.match(run.pack, /^case-review@/);
    assert.equal(run.version, '2.1');
    assert.ok(run.items.length > 0);
    // Locked root comes from lumen-api knowledge sync
    assert.ok(bed.syncs.one && bed.syncs.one.builds.length > 0);
    const lumenBuild = bed.syncs.one.builds.find((b) => b.name === run.build);
    assert.ok(lumenBuild && lumenBuild.root);
    assert.equal(run.root, lumenBuild.root);
  });

  test('submit_result completes the review on the second product without core code changes', async () => {
    const submission = draft(run);
    const answer = await client.call('submit_result', submission);
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.out.call_result, 'ok');
    assert.equal(answer.out.acceptance, 'accepted');

    const result = resultOf(answer);
    assert.equal(result.partitions.delivered.length, run.items.length);

    for (const item of run.items) {
      const res = itemResult(result, item.id);
      assert.equal(res.partition, 'delivered');
      assert.deepEqual(res.item.requirements.map((r) => r.requirement), ['literal', 'catalog', 'findings', 'expected_quality']);
    }

    // Real effects: stored validation result record in database
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: run.run });
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].schema, 'validation@1');

    // Call log reflects acceptance
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: run.run });
    const submitLog = logs.items.find((l) => l.tool === 'submit_result');
    assert.ok(submitLog);
    assert.equal(submitLog.acceptance, 'accepted');

    // Console page shows lumen review
    const page = await consoleClient.get(`/console/runs/${run.run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(run.run));
  });
});
