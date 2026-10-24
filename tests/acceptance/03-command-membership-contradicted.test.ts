// Scenario 3 (brief section 9): A statement that a command does not exist while the catalog has it:
// that finding is a violation routed through the error table into repair, not a whole-submission rejection.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { draft, finding, itemResult, requirementOf, resultOf, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s03-cmd');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 3: command membership contradicted', () => {
  let run: RunSummary;

  test('start_run on the review pack locks the product catalog', async () => {
    run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.ok(run.items.length > 0);
  });

  test('claiming a command is absent when the catalog has it is a violation routed into repair, not a whole rejection', async () => {
    const item0 = run.items[0];
    // 'show health' exists in the widgetTree catalog. Claiming present: false contradicts the catalog.
    const contradictedFinding = finding(item0, {
      text: '认为命令 show health 不存在',
      code: 'edge_case_gap',
      commands: [{ command: 'show health', present: false }],
    });
    const submission = draft(run, new Map([[item0.id, [contradictedFinding]]]));

    const answer = await client.call('submit_result', submission);
    assert.equal(answer.isError, false, 'not a whole-submission rejection: isError is false');
    assert.equal(answer.out.call_result, 'ok');
    assert.equal(answer.out.acceptance, 'accepted');

    const result = resultOf(answer);
    // The violation is routed into repair via the error table
    const error = answer.out.errors.find((e) => e.code === 'core.catalog.membership_contradicted');
    assert.ok(error, 'returns core.catalog.membership_contradicted error');
    assert.equal(error.item, item0.id);
    assert.equal(error.requirement, 'findings');
    assert.equal(error.rounds_left, 2, '2 repair rounds remaining');

    // Settled facts and the known violation remain unchanged; only unsettled layers may wait for repairs.
    const itemRes = itemResult(result, item0.id);
    assert.equal(itemRes.partition,'delivered');
    const waiting=itemRes.item.requirements.flatMap(requirement=>requirement.layers).filter(layer=>layer.reason==='awaiting_step');
    assert.equal(waiting.length,0,'settled facts do not become incomplete because of another repair');

    const findingsReq = requirementOf(result, item0.id, 'findings');
    const staticLayer = findingsReq.layers.find((l) => l.layer === 'static');
    assert.ok(staticLayer);
    assert.equal(staticLayer.terminal, 'violation');
    assert.equal(staticLayer.code, 'core.catalog.membership_contradicted');
    assert.equal(staticLayer.tier, 'blocking');
    assert.equal(staticLayer.attribution, 'producer_error');

    // Real effects: stored in database
    const storedResults = await bed.hub.records.store.find({ key: 'runs.result.run', value: run.run });
    assert.equal(storedResults.items.length, 1);
    assert.equal(storedResults.items[0].schema, 'validation@1');

    // Call log reflects acceptance with ok
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: run.run });
    const submitLog = logs.items.find((l) => l.tool === 'submit_result');
    assert.ok(submitLog);
    assert.equal(submitLog.call_result, 'ok');
    assert.equal(submitLog.acceptance, 'accepted');

    // Console HTML shows the run and error
    const page = await consoleClient.get(`/console/runs/${run.run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('core.catalog.membership_contradicted') || page.body.includes(run.run));
  });
});
