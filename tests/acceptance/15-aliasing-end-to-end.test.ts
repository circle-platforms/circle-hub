// Scenario 15 (brief section 9 & task acceptance.md):
// FAMX and FAMY aliasing end to end: a run started with the product name FAMY and one started with FAMX
// lock the same line and the same catalog.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { draft, resultOf, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s15-alias');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 15: FAMX and FAMY aliasing end to end', () => {
  let runFAMX: RunSummary;
  let runFAMY: RunSummary;

  test('start_run with product FAMX locks line, root, and command catalog', async () => {
    runFAMX = await startReview(client, {
      product: 'FAMX',
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.equal(runFAMX.product, 'famx');
    assert.equal(runFAMX.version, bed.site.LINE);
    assert.ok(runFAMX.root);
    assert.match(runFAMX.root, /^[0-9a-f]{64}$/);
  });

  test('start_run with product FAMY locks the same line, root, and catalog', async () => {
    runFAMY = await startReview(client, {
      product: 'FAMY',
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.equal(runFAMY.product, 'famx');
    assert.equal(runFAMY.version, bed.site.LINE);
    assert.ok(runFAMX.root && runFAMY.root);
    assert.equal(runFAMY.root, runFAMX.root, 'FAMY run locks the exact same root as FAMX run');

    // Both lock the same catalog
    const catalogFAMX = await bed.hub.hub.knowledge.catalog(runFAMX.root, 'commands@1');
    const catalogFAMY = await bed.hub.hub.knowledge.catalog(runFAMY.root, 'commands@1');
    assert.ok(catalogFAMX && catalogFAMY);
    assert.equal(catalogFAMY.reference, catalogFAMX.reference, 'both runs share the identical command catalog reference');
    assert.deepEqual(catalogFAMY.entries(), catalogFAMX.entries(), 'both runs share identical entries');
  });

  test('both runs submit results cleanly against the shared catalog', async () => {
    // Submit FAMX run
    const answerFAMX = await client.call('submit_result', draft(runFAMX));
    assert.equal(answerFAMX.isError, false);
    assert.equal(answerFAMX.out.acceptance, 'accepted');
    const resFAMX = resultOf(answerFAMX);
    assert.equal(resFAMX.locks.root, runFAMX.root);

    // Submit FAMY run
    const answerFAMY = await client.call('submit_result', draft(runFAMY));
    assert.equal(answerFAMY.isError, false);
    assert.equal(answerFAMY.out.acceptance, 'accepted');
    const resFAMY = resultOf(answerFAMY);
    assert.equal(resFAMY.locks.root, runFAMY.root);

    // Stored records exist for both runs in database
    const famxRec = await bed.hub.records.store.find({ key: 'runs.result.run', value: runFAMX.run });
    const famyRec = await bed.hub.records.store.find({ key: 'runs.result.run', value: runFAMY.run });
    assert.equal(famxRec.items.length, 1);
    assert.equal(famyRec.items.length, 1);

    // Console HTML check
    const pageFAMX = await consoleClient.get(`/console/runs/${runFAMX.run}`);
    const pageFAMY = await consoleClient.get(`/console/runs/${runFAMY.run}`);
    assert.equal(pageFAMX.status, 200);
    assert.equal(pageFAMY.status, 200);
    assert.ok(runFAMX.root && runFAMY.root);
    assert.ok(pageFAMX.body.includes(runFAMX.root.slice(0, 16)));
    assert.ok(pageFAMY.body.includes(runFAMY.root.slice(0, 16)));
  });
});
