// Scenario 2 (brief section 9): A quotation that does not match: the whole submission is not accepted,
// stored verbatim, the receipt carries the fix and the rounds left; a corrected resubmission is accepted
// and the first cause stays visible.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { draft, finding, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s02-quote');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 2: quote mismatch', () => {
  let run: RunSummary;

  test('start_run initializes the review run', async () => {
    run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.ok(run.items.length > 0);
  });

  test('a quotation that does not match is not accepted, stored verbatim, receipt carries fix and rounds left', async () => {
    const item0 = run.items[0];
    const badFinding = finding(item0, {
      quotes: [{ reference: item0.location, text: '这一句肯定不是脑图节点里的原文内容' }],
    });
    const badSubmission = draft(run, new Map([[item0.id, [badFinding]]]));

    const answer = await client.call('submit_result', badSubmission);
    assert.equal(answer.isError, true, 'answer has isError = true');
    assert.equal(answer.out.call_result, 'error');
    assert.equal(answer.out.acceptance, 'not_accepted');

    const err = answer.out.errors.find((e) => e.code === 'QUOTE_MISMATCH');
    assert.ok(err, 'returns QUOTE_MISMATCH error');
    assert.match(err.path ?? '', /quotes\/0\/text/);
    assert.equal(err.requirement, 'findings');
    assert.equal(err.rounds_left, 2, '2 repair rounds remaining');
    assert.ok(answer.text.includes('QUOTE_MISMATCH'), 'receipt text mentions QUOTE_MISMATCH');
    assert.ok(answer.text.includes('按原文逐字引用，或先调用 resolve_reference'), 'receipt text contains fix');

    // Real effects: stored verbatim in records store
    const submissions = await bed.hub.records.store.find({ key: 'runs.submission.run', value: run.run });
    assert.equal(submissions.items.length, 1);
    assert.equal(submissions.items[0].schema, 'submission@1');
    const storedBody = submissions.items[0].body as typeof badSubmission;
    assert.deepEqual(storedBody.items[0], badSubmission.items[0], 'submission is stored verbatim');

    // Call log records the refusal
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: run.run });
    const lastCall = logs.items.find((l) => l.tool === 'submit_result');
    assert.ok(lastCall);
    assert.equal(lastCall.call_result, 'error');
    assert.equal(lastCall.acceptance, 'not_accepted');
    assert.equal(lastCall.error_code, 'QUOTE_MISMATCH');
  });

  test('a corrected resubmission is accepted and the first cause stays visible', async () => {
    const item0 = run.items[0];
    const fixedFinding = finding(item0, {
      quotes: [{ reference: item0.location, text: item0.label }],
    });
    const fixedSubmission = draft(run, new Map([[item0.id, [fixedFinding]]]));

    const answer = await client.call('submit_result', fixedSubmission);
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.out.call_result, 'ok');
    assert.equal(answer.out.acceptance, 'accepted');

    // Both submissions are stored in records store
    const submissions = await bed.hub.records.store.find({ key: 'runs.submission.run', value: run.run });
    assert.equal(submissions.items.length, 2, 'two submissions are stored');

    // Query runs engine: previous submission/cause stays visible in history
    const runDetail = await bed.hub.hub.runs.getRun(bed.reviewer.principal, run.run);
    assert.ok(runDetail);
    assert.equal(runDetail.submissions.length, 2);
    assert.equal(runDetail.submissions[0].acceptance, 'not_accepted');
    assert.equal(runDetail.submissions[0].errors[0]?.code, 'QUOTE_MISMATCH');
    assert.equal(runDetail.submissions[1].acceptance, 'accepted');
    assert.ok(runDetail.submissions[1].result, 'second submission has a stored result');

    // Console HTML displays the run
    const page = await consoleClient.get(`/console/runs/${run.run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(run.run));
  });
});
