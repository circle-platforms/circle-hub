// Scenario 20 (brief section 9 & task acceptance.md):
// Injected defects: take synthetic ~150-node mind-map fixture, inject known defects with scripts/real/benchmark/inject.ts,
// run case-review on untouched and mutated, assert the difference between the two results.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { injectDefects, type MindMap } from '../../scripts/real/benchmark/inject.ts';
import { fixtureText } from '../fixtures/mindmaps/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import { type McpClient } from './support/mcp.ts';
import { draft, oracleCases, refutationCodes, requirementOf, resultOf, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s20-inject');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});

after(async () => {
  await bed?.close().catch(() => {});
  await postgres?.stop().catch(() => {});
});

describe('scenario 20: injected defects benchmark verification', () => {
  let untouchedRef: string;
  let untouchedRun: RunSummary;
  const untouchedViolations = new Map<string,string[]>();

  test('upload untouched fixture and record baseline literal violations', async () => {
    const untouchedMap = JSON.parse(fixtureText('review-150.km.json')) as MindMap;
    untouchedRef = await client.upload(Buffer.from(JSON.stringify(untouchedMap)), 'review-untouched.km.json');
    assert.match(untouchedRef, /^src:[0-9a-f]{64}$/);

    untouchedRun = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { reference: untouchedRef } },
    });
    // The baseline count comes from the independent oracle under the default (marked) rule, not a written-down number.
    assert.equal(untouchedRun.items.length, oracleCases(untouchedMap).length);

    const submission = draft(untouchedRun);
    const answer = await client.call('submit_result', submission);
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.out.acceptance, 'accepted');

    const result = resultOf(answer);
    for (const item of untouchedRun.items) {
      const req = requirementOf(result, item.id, 'literal');
      const staticLayer = req.layers.find((l) => l.layer === 'static')!;
      if (staticLayer.terminal === 'violation') {
        untouchedViolations.set(item.id,refutationCodes(result,item.id,'literal'));
      }
    }
    // Baseline variants are advisory violations under R2; later injection compares individual codes.
    assert.ok(untouchedViolations.size > 0);
  });

  test('injected structural defects (duplicate_title, empty_title, bad_priority, no_expected, empty_expected) are newly flagged and attributed', async () => {
    const rawMap = JSON.parse(fixtureText('review-150.km.json')) as MindMap;
    const documentId = String(rawMap.root?.data?.id ?? 'document');

    // Using seed 8 places defects on cases that do not have baseline tag or id collisions
    const injectResult = injectDefects(rawMap, {
      documentId,
      seed: 8,
      counts: {
        duplicate_title: 1,
        empty_title: 1,
        bad_priority: 1,
        no_expected: 1,
        empty_expected: 1,
      },
    });

    assert.equal(injectResult.shortfalls.length, 0, 'all defect kinds should be placed');
    const truth = injectResult.truth;
    assert.equal(truth.length, 5);

    // Upload mutated map
    const mutatedRef = await client.upload(Buffer.from(JSON.stringify(injectResult.map)), 'review-mutated-5.km.json');
    const mutatedRun = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { reference: mutatedRef } },
    });
    // duplicate_title duplicates one case, so the mutated document holds one case more than the untouched one
    // (both counted by the same oracle under the marked rule; the mutation only adds a copy, it moves no node).
    assert.equal(mutatedRun.items.length, oracleCases(injectResult.map).length);
    assert.equal(mutatedRun.items.length, untouchedRun.items.length + 1);

    const submission = draft(mutatedRun);
    const answer = await client.call('submit_result', submission);
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.out.acceptance, 'accepted');

    const result = resultOf(answer);

    // Find items newly flagged by the Hub's literal requirement
    const newlyFlaggedItems = new Set<string>();
    for (const item of mutatedRun.items) {
      const req = requirementOf(result, item.id, 'literal');
      const staticLayer = req.layers.find((l) => l.layer === 'static')!;
      if (staticLayer.terminal === 'violation' && refutationCodes(result,item.id,'literal').some(code=>!(untouchedViolations.get(item.id)??[]).includes(code))) {
        newlyFlaggedItems.add(item.id);
      }
    }

    // Injected defects are newly flagged (duplicate_title flags both the copy and the original twin)
    const expectedIds = truth.map((t) => t.item as string);
    assert.ok(newlyFlaggedItems.size >= expectedIds.length);
    for (const expectedId of expectedIds) {
      assert.ok(newlyFlaggedItems.has(expectedId), `expected injected defect item ${expectedId} to be newly flagged`);
    }

    // Each newly flagged item defect is attributed to that item and requirement 'literal'
    for (const expectedId of expectedIds) {
      const req = requirementOf(result, expectedId, 'literal');
      assert.equal(req.requirement, 'literal');
      const staticLayer = req.layers.find((l) => l.layer === 'static')!;
      assert.equal(staticLayer.terminal, 'violation');
      assert.ok(staticLayer.attribution, 'must have attribution');
    }

    // Stored records in DB confirm the validation result
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: mutatedRun.run });
    assert.equal(stored.items.length, 1);

    // Call log line exists
    const logPage = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: mutatedRun.run });
    assert.ok(logPage.items.some((l) => l.tool === 'submit_result'));

    // Console page renders properly
    const page = await consoleClient.get(`/console/runs/${mutatedRun.run}`);
    assert.equal(page.status, 200);
    assert.match(page.body, new RegExp(mutatedRun.run));
  });

  test('document-level defect remove_negative removes only the exact declared negative cases', async () => {
    const rawMap = JSON.parse(fixtureText('review-150.km.json')) as MindMap;
    const documentId = String(rawMap.root?.data?.id ?? 'document');

    const injectResult = injectDefects(rawMap, {
      documentId,
      seed: 1,
      counts: { remove_negative: 1 },
    });

    assert.equal(injectResult.shortfalls.length, 0);
    assert.equal(injectResult.truth.length, 1);
    assert.equal(injectResult.truth[0].kind, 'remove_negative');
    assert.equal(injectResult.truth[0].item, null);

    const mutatedRef = await client.upload(Buffer.from(JSON.stringify(injectResult.map)), 'review-mutated-neg.km.json');
    const mutatedRun = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { reference: mutatedRef } },
    });

    // R2: only exact negative declarations are negative; variants remain as structural repair evidence.
    const declaredNegatives=oracleCases(rawMap).filter(item=>item.tags.includes('negative')).length;
    assert.equal(mutatedRun.items.length, oracleCases(injectResult.map).length);
    assert.equal(mutatedRun.items.length, untouchedRun.items.length - declaredNegatives);

    const remainingNegatives = mutatedRun.items.filter((item) => item.fields.negative === true);
    assert.equal(remainingNegatives.length, 0);
  });

  test('two_expected defect behavior: case-review structure.json allows multiple expected results', async () => {
    const rawMap = JSON.parse(fixtureText('review-150.km.json')) as MindMap;
    const documentId = String(rawMap.root?.data?.id ?? 'document');

    const injectResult = injectDefects(rawMap, {
      documentId,
      seed: 22,
      counts: { two_expected: 1 },
    });

    assert.equal(injectResult.shortfalls.length, 0);
    const truth = injectResult.truth[0];
    assert.equal(truth.kind, 'two_expected');

    const mutatedRef = await client.upload(Buffer.from(JSON.stringify(injectResult.map)), 'review-mutated-two-exp.km.json');
    const mutatedRun = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { reference: mutatedRef } },
    });

    const item = mutatedRun.items.find((i) => i.id === truth.item);
    assert.ok(item);
    assert.equal((item.fields.expected as unknown[]).length, 2);

    const submission = draft(mutatedRun);
    const answer = await client.call('submit_result', submission);
    assert.equal(answer.isError, false);

    const result = resultOf(answer);
    const req = requirementOf(result, item.id, 'literal');
    // Note: tables/structure.json declares minItems: 1 without maxItems ("条数不限"),
    // so two_expected is accepted by case-review structure check.
    // This operation changes expected cardinality, not the retained advisory tag violations.
    assert.deepEqual(refutationCodes(result,item.id,'literal'),untouchedViolations.get(item.id)??[]);
  });
});
