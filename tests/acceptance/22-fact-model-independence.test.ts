// Scenario 22 (brief section 9 & task acceptance.md):
// The Hub-computed answers do not depend on the model:
// two different scripted submissions of the same items give the same fact-requirement terminals.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { fixtureText } from '../fixtures/mindmaps/index.ts';
import { oracleCases } from './support/review.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import { type McpClient } from './support/mcp.ts';
import { DRAFTER, OTHER_MODEL, OTHER_IDENTITY, draft, finding, level, requirementOf, resultOf, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s22-independence');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});

after(async () => {
  await bed?.close().catch(() => {});
  await postgres?.stop().catch(() => {});
});

const document = JSON.parse(fixtureText('review-150.km.json'));

describe('scenario 22: fact-requirement model independence', () => {
  let runA: RunSummary;
  let runB: RunSummary;
  let resultA: ReturnType<typeof resultOf>;
  let resultB: ReturnType<typeof resultOf>;

  test('start two runs with identical target items', async () => {
    runA = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    runB = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });

    assert.ok(runA.run);
    assert.ok(runB.run);
    assert.notEqual(runA.run, runB.run);
    // The item count comes from the independent oracle under the default (marked) rule, not a written-down number.
    assert.equal(runA.items.length, oracleCases(document).length);
    assert.equal(runB.items.length, oracleCases(document).length);
    assert.deepEqual(
      runA.items.map((i) => i.id),
      runB.items.map((i) => i.id),
      'both runs project the exact same items in the exact same order',
    );
  });

  test('Model A submits minimal clean draft (no findings, P4 level)', async () => {
    const subA = draft(runA, new Map(), { model: DRAFTER, cross: [level('P4')] });

    const answerA = await client.call('submit_result', subA);
    assert.equal(answerA.isError, false, answerA.text);
    assert.equal(answerA.out.acceptance, 'accepted');
    resultA = resultOf(answerA);
    assert.equal(resultA.run, runA.run);
  });

  test('Model B submits different findings and P2 level on the exact same items', async () => {
    const item0 = runB.items[0];
    const probe = runB.items.find((i) => i.label === 'widget health probe pool1 tcp') ?? runB.items[1];

    const findingsMap = new Map([
      [
        item0.id,
        [
          finding(item0, {
            text: '发现 1：用例缺少前置条件',
            code: 'edge_case_gap',
            rank: 'minor',
          }),
        ],
      ],
      [
        probe.id,
        [
          finding(probe, {
            text: '发现 2：自相矛盾的协议配置',
            code: 'self_contradiction',
            rank: 'major',
          }),
        ],
      ],
    ]);

    const subB = draft(runB, findingsMap, { model: OTHER_MODEL, model_identity:OTHER_IDENTITY, cross: [level('P2')] });

    const answerB = await client.call('submit_result', subB);
    assert.equal(answerB.isError, false, answerB.text);
    assert.equal(answerB.out.acceptance, 'accepted');
    resultB = resultOf(answerB);
    assert.equal(resultB.run, runB.run);
  });

  test('fact requirements (literal and catalog) produce 100% identical terminals between Model A and Model B', () => {
    assert.ok(resultA);
    assert.ok(resultB);

    for (let i = 0; i < runA.items.length; i++) {
      const idA = runA.items[i].id;
      const idB = runB.items[i].id;
      assert.equal(idA, idB);

      // Fact Requirement 1: literal (structure, node_ids, tags)
      const litA = requirementOf(resultA, idA, 'literal');
      const litB = requirementOf(resultB, idB, 'literal');
      const staticLitA = litA.layers.find((l) => l.layer === 'static')!;
      const staticLitB = litB.layers.find((l) => l.layer === 'static')!;

      assert.equal(
        staticLitA.terminal,
        staticLitB.terminal,
        `literal terminal mismatch for item ${idA}: Model A=${staticLitA.terminal}, Model B=${staticLitB.terminal}`,
      );
      assert.equal(
        staticLitA.code,
        staticLitB.code,
        `literal violation code mismatch for item ${idA}`,
      );
      assert.equal(
        staticLitA.reason,
        staticLitB.reason,
        `literal reason mismatch for item ${idA}`,
      );

      // Fact Requirement 2: catalog (cited_commands, command_claims)
      const catA = requirementOf(resultA, idA, 'catalog');
      const catB = requirementOf(resultB, idB, 'catalog');
      const staticCatA = catA.layers.find((l) => l.layer === 'static')!;
      const staticCatB = catB.layers.find((l) => l.layer === 'static')!;

      assert.equal(
        staticCatA.terminal,
        staticCatB.terminal,
        `catalog terminal mismatch for item ${idA}`,
      );
      assert.equal(
        staticCatA.reason,
        staticCatB.reason,
        `catalog reason mismatch for item ${idA}`,
      );
    }

    // Meanwhile, judgment requirements differ according to model output
    const probe = runA.items.find((i) => i.label === 'widget health probe pool1 tcp') ?? runA.items[1];
    const findA = requirementOf(resultA, probe.id, 'findings');
    const findB = requirementOf(resultB, probe.id, 'findings');
    assert.equal(findB.claims.length, findA.claims.length + 1, 'Model B has 1 more finding claim on probe item');

    // Cross-item judgment levels differ
    assert.equal(resultA.cross_item[0]?.statement.rank, 'P4');
    assert.equal(resultB.cross_item[0]?.statement.rank, 'P2');
  });

  test('both runs are cleanly persisted and inspectable in the database and console', async () => {
    // Both validation results stored in DB
    const storedA = await bed.hub.records.store.find({ key: 'runs.result.run', value: runA.run });
    const storedB = await bed.hub.records.store.find({ key: 'runs.result.run', value: runB.run });
    assert.equal(storedA.items.length, 1);
    assert.equal(storedB.items.length, 1);

    // Call logs exist for both
    const logsA = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: runA.run });
    const logsB = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: runB.run });
    assert.ok(logsA.items.some((l) => l.tool === 'submit_result'));
    assert.ok(logsB.items.some((l) => l.tool === 'submit_result'));

    // Console pages for both runs render 200 OK
    const pageA = await consoleClient.get(`/console/runs/${runA.run}`);
    const pageB = await consoleClient.get(`/console/runs/${runB.run}`);
    assert.equal(pageA.status, 200);
    assert.equal(pageB.status, 200);
    assert.match(pageA.body, new RegExp(runA.run));
    assert.match(pageB.body, new RegExp(runB.run));
  });
});
