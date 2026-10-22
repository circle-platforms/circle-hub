// Scenario 15 (brief section 9 & task acceptance.md):
// APV and NSAE aliasing end to end: a run started with the product name NSAE and one started with APV
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

describe('scenario 15: APV and NSAE aliasing end to end', () => {
  let runAPV: RunSummary;
  let runNSAE: RunSummary;

  test('start_run with product APV locks line, root, and command catalog', async () => {
    runAPV = await startReview(client, {
      product: 'APV',
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.equal(runAPV.product, 'apv');
    assert.equal(runAPV.version, bed.site.LINE);
    assert.ok(runAPV.root);
    assert.match(runAPV.root, /^[0-9a-f]{64}$/);
  });

  test('start_run with product NSAE locks the same line, root, and catalog', async () => {
    runNSAE = await startReview(client, {
      product: 'NSAE',
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.equal(runNSAE.product, 'apv');
    assert.equal(runNSAE.version, bed.site.LINE);
    assert.ok(runAPV.root && runNSAE.root);
    assert.equal(runNSAE.root, runAPV.root, 'NSAE run locks the exact same root as APV run');

    // Both lock the same catalog
    const catalogAPV = await bed.hub.hub.knowledge.catalog(runAPV.root, 'commands@1');
    const catalogNSAE = await bed.hub.hub.knowledge.catalog(runNSAE.root, 'commands@1');
    assert.ok(catalogAPV && catalogNSAE);
    assert.equal(catalogNSAE.reference, catalogAPV.reference, 'both runs share the identical command catalog reference');
    assert.deepEqual(catalogNSAE.entries(), catalogAPV.entries(), 'both runs share identical entries');
  });

  test('both runs submit results cleanly against the shared catalog', async () => {
    // Submit APV run
    const answerAPV = await client.call('submit_result', draft(runAPV));
    assert.equal(answerAPV.isError, false);
    assert.equal(answerAPV.out.acceptance, 'accepted');
    const resAPV = resultOf(answerAPV);
    assert.equal(resAPV.locks.root, runAPV.root);

    // Submit NSAE run
    const answerNSAE = await client.call('submit_result', draft(runNSAE));
    assert.equal(answerNSAE.isError, false);
    assert.equal(answerNSAE.out.acceptance, 'accepted');
    const resNSAE = resultOf(answerNSAE);
    assert.equal(resNSAE.locks.root, runNSAE.root);

    // Stored records exist for both runs in database
    const apvRec = await bed.hub.records.store.find({ key: 'runs.result.run', value: runAPV.run });
    const nsaeRec = await bed.hub.records.store.find({ key: 'runs.result.run', value: runNSAE.run });
    assert.equal(apvRec.items.length, 1);
    assert.equal(nsaeRec.items.length, 1);

    // Console HTML check
    const pageAPV = await consoleClient.get(`/console/runs/${runAPV.run}`);
    const pageNSAE = await consoleClient.get(`/console/runs/${runNSAE.run}`);
    assert.equal(pageAPV.status, 200);
    assert.equal(pageNSAE.status, 200);
    assert.ok(runAPV.root && runNSAE.root);
    assert.ok(pageAPV.body.includes(runAPV.root.slice(0, 16)));
    assert.ok(pageNSAE.body.includes(runNSAE.root.slice(0, 16)));
  });
});
