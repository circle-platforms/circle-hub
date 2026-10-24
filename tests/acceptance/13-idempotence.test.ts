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
import { draft, finding, resultOf, startReview } from './support/review.ts';

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

  test('repeated transitional submissions are rechecked without duplicating the original or repair charge', async () => {
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

    assert.ok(firstSubmit.out.counts!.unknown>0,'this fixture contains unresolved catalog facts');
    assert.equal(repeatResult.submission,firstResult.submission);
    assert.deepEqual(repeatResult.partitions,firstResult.partitions,'unchanged facts retain their raw terminals and exits');
    assert.notEqual(repeatResult.trace,firstResult.trace,'the repeat has an actual new validation trace');
    const third=await client.call('submit_result',submission),thirdResult=resultOf(third);
    assert.equal(thirdResult.rounds.used,repeatResult.rounds.used,'the same body never consumes another round');
    assert.equal((await bed.hub.records.store.find({key:'runs.submission.run',value:run1.run})).items.length,1);

    // No new records were written to database
    const resultsAfter = (await bed.hub.records.store.find({ key: 'runs.result.run', value: run1.run })).items.length;
    const actionsAfter = (await bed.hub.records.store.find({ key: 'runs.action.run', value: run1.run })).items.length;
    assert.equal(resultsAfter,resultsBefore+2,'each transitional recheck appends its own result');
    assert.equal(actionsAfter,actionsBefore+2,'each actual recheck has its own validation action');
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

  test('repair rounds deduplicate multiple actions of the same submission', async () => {
    const runRepair = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    const item0 = runRepair.items[0];

    // 1. Submit draft with a repairable QUOTE_MISMATCH on findings (findings has max_rounds: 2)
    const badFinding1 = finding(item0, {
      quotes: [{ reference: item0.location, text: '不匹配的引文 1' }],
    });
    const sub1 = draft(runRepair, new Map([[item0.id, [badFinding1]]]));
    const ans1 = await client.call('submit_result', sub1);
    assert.equal(ans1.out.acceptance, 'not_accepted');
    const err1 = ans1.out.errors.find((e) => e.code === 'QUOTE_MISMATCH');
    assert.ok(err1);
    assert.equal(err1.rounds_left, 2, 'initial submission sees 2 rounds left before consumption');

    // Retrieve the action record written for sub1
    const actions = await bed.hub.records.store.find({ key: 'runs.action.run', value: runRepair.run });
    const action1 = actions.items.find((a) => (a.body as { action?: string }).action === 'validate');
    assert.ok(action1);
    const sub1Digest = (action1.body as { detail?: { submission?: string } }).detail?.submission;
    assert.ok(typeof sub1Digest === 'string');

    // Insert a duplicate action record for the exact same submission digest
    await bed.hub.records.store.put({
      kind: 'action',
      schema: 'action@1',
      provenance: 'projected',
      body: {
        action: 'validate',
        run: runRepair.run,
        inputs: [],
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        acceptance: 'not_accepted',
        codes: ['QUOTE_MISMATCH'],
        detail: { submission: sub1Digest, repair: ['findings'], result: null },
      },
      index: [{ key: 'runs.action.run', value: runRepair.run }],
    });

    // 2. Submit a distinct second submission sub2 with another repairable error
    const badFinding2 = finding(item0, {
      quotes: [{ reference: item0.location, text: '不匹配的引文 2（不同的文字）' }],
    });
    const sub2 = draft(runRepair, new Map([[item0.id, [badFinding2]]]));
    const ans2 = await client.call('submit_result', sub2);
    assert.equal(ans2.out.acceptance, 'not_accepted');
    const err2 = ans2.out.errors.find((e) => e.code === 'QUOTE_MISMATCH');
    assert.ok(err2, 'error is still routed to repair, not exhausted prematurely');
    assert.equal(err2.rounds_left, 1, 'duplicate action for same submission counted once; 1 round left');
    // Ensure findings is not marked repair_exhausted
    assert.ok(!ans2.out.errors.some((e) => e.code === 'repair_exhausted'));
  });

  test('validatePartial deduplicates repeated items in partial submission without invariant failure', async () => {
    const runPartial = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    const item0 = runPartial.items[0];

    // Construct a submission that fails Submission schema parse (triggering validatePartial)
    // with a type error on a primitive property (notes: 123) so Zod aborts before superRefine,
    // leaving badItems empty. The second entry for item0 carries a bad quotation.
    // validatePartial's seen set must deduplicate item0, discarding the second entry so its
    // QUOTE_MISMATCH error is never evaluated or reported.
    const badFinding = finding(item0, {
      quotes: [{ reference: item0.location, text: '这一句绝对不是脑图里的原文' }],
    });
    const partialSubWithDuplicates = {
      run: runPartial.run,
      notes: 123,
      items: [
        { item: item0.id, handling: 'handled', slots: { findings: [] } },
        { item: item0.id, handling: 'handled', slots: { findings: [badFinding] } }, // duplicate entry for item0
      ],
    };

    const answer = await client.call('submit_result', partialSubWithDuplicates);
    // Deduplication ensures normal not_accepted receipt returned with SUBMISSION_SCHEMA_VIOLATION
    assert.equal(answer.isError, true);
    assert.equal(answer.out.call_result, 'error');
    assert.equal(answer.out.acceptance, 'not_accepted');
    assert.ok(answer.out.errors.some((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION'));

    // Discarded duplicate entry must not be checked or report QUOTE_MISMATCH
    assert.equal(
      answer.out.errors.some((e) => e.code === 'QUOTE_MISMATCH'),
      false,
      'discarded duplicate item entry must not be checked or report QUOTE_MISMATCH',
    );
  });
});
