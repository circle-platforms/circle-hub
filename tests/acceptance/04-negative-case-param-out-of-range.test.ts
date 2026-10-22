// Scenario 4 (brief section 9): A negative case with an out-of-range parameter:
// the catalog check refutes as expected, shown at advisory tier.
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
  client = await bed.connect(bed.reviewer, 'sess-s04-neg');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 4: negative case with out-of-range parameter', () => {
  let run: RunSummary;

  test('start_run identifies negative cases in the mindmap', async () => {
    run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    const negatives = run.items.filter((i) => i.fields.negative === true);
    assert.ok(negatives.length > 0, 'the mind map fixture contains negative cases');
  });

  test('the catalog check refutes an out-of-range parameter as expected, satisfied at advisory tier', async () => {
    // Find the negative case targeting interval with 61 (valid range is 1 - 60 in widgetTree)
    const negativeItem = run.items.find((i) => i.fields.negative === true && i.label.includes('interval') && i.label.includes('61'))
      ?? run.items.find((i) => i.fields.negative === true)!;

    // Citing the command line with out-of-range parameter 61
    const commandClaim = 'widget health interval pool1 61';
    const findingWithCmd = finding(negativeItem, {
      quotes: [{ reference: negativeItem.location, text: negativeItem.label }],
      commands: [{ command: commandClaim }],
    });

    const submission = draft(run, new Map([[negativeItem.id, [findingWithCmd]]]));
    const answer = await client.call('submit_result', submission);
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.out.acceptance, 'accepted');

    const result = resultOf(answer);
    const itemRes = itemResult(result, negativeItem.id);
    assert.equal(itemRes.partition, 'delivered');

    const catalogReq = requirementOf(result, negativeItem.id, 'catalog');
    assert.equal(catalogReq.status, 'satisfied', 'negative case expecting this violation is satisfied');

    const staticLayer = catalogReq.layers.find((l) => l.layer === 'static');
    assert.ok(staticLayer);
    assert.equal(staticLayer.terminal, 'violation');
    assert.equal(staticLayer.code, 'core.catalog.param_out_of_range');
    assert.equal(staticLayer.tier, 'advisory', 'refutation is shown at advisory tier');

    // Real effects: stored validation record in database
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: run.run });
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].schema, 'validation@1');

    // Call log records the successful submit_result
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: run.run });
    const lastSubmit = logs.items.find((l) => l.tool === 'submit_result');
    assert.ok(lastSubmit);
    assert.equal(lastSubmit.acceptance, 'accepted');

    // Console HTML renders the run
    const page = await consoleClient.get(`/console/runs/${run.run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(run.run));
  });
});
