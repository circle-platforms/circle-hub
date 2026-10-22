// Scenario 13 (brief section 9): Idempotence: repeating submit_result for the same (run, submission digest)
// returns the stored result without re-running anything; repeating start_run with the same client key inside its
// window returns the same run; an expired key starts a new run.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { draft, resultOf } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;
let simulatedNow = new Date('2026-10-22T08:00:00Z');

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres, now: () => simulatedNow });
  client = await bed.connect(bed.reviewer, 'sess-s13-idemp');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 13: idempotence of start_run and submit_result', () => {
  let run1: RunSummary;
  const clientKey = 'test-client-key-s13';

  test('start_run with a client_key returns a run; repeating inside window returns the same run', async () => {
    const input = {
      pack: 'case-review',
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      client_key: clientKey,
    };

    const first = await client.call('start_run', input);
    assert.equal(first.isError, false);
    run1 = first.out.run!;
    assert.ok(run1.run);

    // Repeating with identical key inside window returns the same run
    const repeat = await client.call('start_run', input);
    assert.equal(repeat.isError, false);
    assert.equal(repeat.out.run?.run, run1.run, 'same client_key returns same run inside window');

    // Same client_key with different inputs triggers IDEMPOTENCY_MISMATCH
    const mismatch = await client.call('start_run', {
      ...input,
      parameters: { strict: true },
    });
    assert.equal(mismatch.isError, true);
    assert.equal(mismatch.out.errors[0]?.code, 'IDEMPOTENCY_MISMATCH');
  });

  test('repeating submit_result for the same (run, submission digest) returns stored result without re-running', async () => {
    const submission = draft(run1);

    // First submission
    const firstSubmit = await client.call('submit_result', submission);
    assert.equal(firstSubmit.isError, false);
    assert.equal(firstSubmit.out.acceptance, 'accepted');
    const firstResult = resultOf(firstSubmit);

    // Count stored validation results and actions before repeat
    const resultsBefore = (await bed.hub.records.store.find({ key: 'runs.result.run', value: run1.run })).items.length;
    const actionsBefore = (await bed.hub.records.store.find({ key: 'runs.action.run', value: run1.run })).items.length;

    // Repeat submission with exact same arguments
    const repeatSubmit = await client.call('submit_result', submission);
    assert.equal(repeatSubmit.isError, false);
    assert.equal(repeatSubmit.out.acceptance, 'accepted');
    const repeatResult = resultOf(repeatSubmit);

    // Results match
    assert.deepEqual(repeatResult, firstResult);

    // No new records were written to database
    const resultsAfter = (await bed.hub.records.store.find({ key: 'runs.result.run', value: run1.run })).items.length;
    const actionsAfter = (await bed.hub.records.store.find({ key: 'runs.action.run', value: run1.run })).items.length;
    assert.equal(resultsAfter, resultsBefore, 'no new validation_result stored on idempotent repeat');
    assert.equal(actionsAfter, actionsBefore, 'no new action stored on idempotent repeat');
  });

  test('an expired client_key starts a new run', async () => {
    // Advance simulated time past the 24h client_key expiration window
    simulatedNow = new Date(simulatedNow.getTime() + 25 * 60 * 60 * 1000);

    const expiredCall = await client.call('start_run', {
      pack: 'case-review',
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      client_key: clientKey,
    });

    assert.equal(expiredCall.isError, false);
    const newRun = expiredCall.out.run!;
    assert.notEqual(newRun.run, run1.run, 'expired client_key starts a fresh run with new id');

    // Console session expired due to 25h time advance; re-login to check the new run
    consoleClient = await openConsole(bed.hub, bed.reviewer.token);
    const page = await consoleClient.get(`/console/runs/${newRun.run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(newRun.run));
  });
});
