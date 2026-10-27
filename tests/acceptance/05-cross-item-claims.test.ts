// Scenario 5 (brief section 9): A cross-item fact plus a judgment that rests on it:
// listed separately, not counted in partitions.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { PARTITION } from '../../contracts/generated/vocabulary.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { draft, itemResult, level, resultOf, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s05-cross');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 5: cross-item fact and judgment resting on it', () => {
  let run: RunSummary;

  test('start_run starts the review run', async () => {
    run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.ok(run.items.length > 0);
  });

  test('cross-item fact and dependent judgment are listed separately, not counted in partitions', async () => {
    const crossClaims = [
      { nature: 'fact', statement: '跨条目事实：多个用例共享前置条件配置', grounds: [run.items[0].location] },
      { nature: 'judgment', statement: '跨条目判断：前置条件缺少容灾分支覆盖', grounds: [], premises: ['/cross_item/0'] },
      level('P3'),
    ];

    const submission = draft(run, new Map(), { cross: crossClaims });
    const answer = await client.call('submit_result', submission);
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.out.call_result, 'ok');
    assert.equal(answer.out.acceptance, 'accepted');

    const result = resultOf(answer);

    // 1. Listed separately in cross_item
    assert.equal(result.cross_item.length, 3 + 2);
    const [levelConsistencyFact, reviewScopeFact, factClaim, judgmentClaim, levelClaim] = result.cross_item;
    // A4 #13 adds two mechanical facts before the original cross-item claims.
    assert.deepEqual([levelConsistencyFact, reviewScopeFact].map((c) => [c.requirement, c.statement.code, c.statement.rank, c.qualifier.nature]), [
      ['level', undefined, undefined, 'fact'],
      ['level', undefined, undefined, 'fact'],
    ]);
    assert.equal(factClaim.statement.text, '跨条目事实：多个用例共享前置条件配置');
    assert.equal(judgmentClaim.statement.text, '跨条目判断：前置条件缺少容灾分支覆盖');
    assert.deepEqual(judgmentClaim.validity.premises, ['/cross_item/0']);
    assert.equal(levelClaim.requirement, 'level');

    // Cross-item claims are bound to the digests of all items (V05 F[4])
    for (const item of run.items) {
      if (item.digest) {
        assert.ok(levelClaim.validity.bound.includes(item.digest), `level claim bound to item ${item.id}`);
      }
    }

    // 2. Not counted in partitions: partitions contain only items
    const partitionItemsCount = Object.values(result.partitions).reduce((sum, list) => sum + list.length, 0);
    assert.equal(partitionItemsCount, run.items.length, 'partitions hold exactly the items, never cross-item claims');
    assert.equal(result.partitions.delivered.length, run.items.length);
    for (const p of PARTITION) {
      if (p !== 'delivered') assert.equal(result.partitions[p].length, 0);
    }

    // Partition union strictly equals run items, and partitions are mutually disjoint
    const seenPartitionItems = new Set<string>();
    for (const p of PARTITION) {
      for (const it of result.partitions[p]) {
        assert.ok(!seenPartitionItems.has(it.item), `item ${it.item} must not appear in multiple partitions`);
        seenPartitionItems.add(it.item);
      }
    }
    assert.deepEqual(
      Array.from(seenPartitionItems).sort(),
      run.items.map((it) => it.id).sort(),
      'disjoint union of all partitions strictly equals the set of run items',
    );

    // Counts equal partition items counts
    const counts = answer.out.counts!;
    assert.equal(counts.delivered, run.items.length);
    assert.equal(counts.rejected, 0);
    assert.equal(counts.quarantined, 0);
    assert.equal(counts.incomplete, 0);

    // 3. Stored records: validation@1 contains cross_item
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: run.run });
    assert.equal(stored.items.length, 1);
    const storedResult = stored.items[0].body as typeof result;
    assert.equal(storedResult.cross_item.length, 3 + 2);

    // 4. Call log & Console HTML
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: run.run });
    const submitLog = logs.items.find((l) => l.tool === 'submit_result');
    assert.ok(submitLog);
    assert.equal(submitLog.acceptance, 'accepted');

    const page = await consoleClient.get(`/console/runs/${run.run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(run.run));
  });
});
