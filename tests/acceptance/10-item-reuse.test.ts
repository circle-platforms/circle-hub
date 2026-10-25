// Scenario 10 (brief section 9): Changing one case re-judges one case
// (items unchanged by content digest are reused).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { draft, itemResult, level, resultOf, sha256, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s10-reuse');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

const node = (id: string, text: string, children: unknown[] = [], data: Record<string, unknown> = {}) => ({
  data: { id, text, ...data },
  children,
});

function makeMap(c2Text = 'widget health retries pool1 3') {
  return {
    root: node('r1', '合成脑图', [
      node('g1', '模块一', [
        node('c1', 'widget health interval pool1 5', [node('e1', '正常设置')], { priority: 2, resource: ['Functional'] }),
        node('c2', c2Text, [node('e2', '重试次数为 3')], { priority: 2, resource: ['Functional'] }),
      ], { priority: 1 }),
    ]),
    template: 'right',
    theme: 'classic',
    version: '1.4.43',
  };
}

describe('scenario 10: item reuse and carry-over', () => {
  let r1: RunSummary;
  let r2: RunSummary;

  test('run 1: draft submission with context digests accepts and delivers both items', async () => {
    const v1 = await client.upload(Buffer.from(JSON.stringify(makeMap())), 'map-v1.km.json');
    r1 = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { reference: v1 } },
    });
    assert.equal(r1.items.length, 2);

    // Provide context digest so items are eligible for carry-over (not marked no_reuse)
    const submission1 = draft(r1, new Map(), { context: true });
    const answer1 = await client.call('submit_result', submission1);
    assert.equal(answer1.isError, false, answer1.text);
    assert.equal(answer1.out.acceptance, 'accepted');

    const res1 = resultOf(answer1);
    assert.equal(res1.partitions.delivered.length, 2);
  });

  test('run 2 on revised document: unchanged item gets reuse offer, changed item must be re-judged', async () => {
    // Only c2 changes in map-v2
    const v2 = await client.upload(Buffer.from(JSON.stringify(makeMap('widget health retries pool1 5'))), 'map-v2.km.json');
    r2 = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { reference: v2 } },
      predecessor: r1.run,
    });
    assert.equal(r2.items.length, 2);

    const c1 = r2.items.find((i) => i.label.includes('interval'))!;
    const c2 = r2.items.find((i) => i.label.includes('retries'))!;

    // Unchanged item c1 has reuse offer; changed item c2 does not
    assert.ok(c1.reuse && c1.reuse.startsWith('rec:'), 'unchanged item c1 has reuse offer');
    assert.equal(c2.reuse, undefined, 'changed item c2 has no reuse offer');

    // Submit run 2: c1 carries over using reuse offer, c2 is freshly judged
    const submission2 = {
      run: r2.run,
      model: 'scripted-model-v2',
      items: [
        { item: c1.id, handling: 'handled', reuse: c1.reuse },
        {
          item: c2.id,
          handling: 'handled',
          context: sha256(`context of ${c2.id}`),
          slots: { findings: [], expected_quality: [] },
        },
      ],
      cross_item: [level('P3')],
    };

    const answer2 = await client.call('submit_result', submission2);
    assert.equal(answer2.isError, false, answer2.text);
    assert.equal(answer2.out.acceptance, 'accepted');

    const res2 = resultOf(answer2);
    assert.equal(res2.partitions.delivered.length, 2);

    // c1's delivered item carried over predecessor's judgment
    const c1Res = itemResult(res2, c1.id);
    assert.equal(c1Res.partition, 'delivered');
    const c2Res = itemResult(res2, c2.id);
    assert.equal(c2Res.partition, 'delivered');

    // Real effects: stored validation result record in database
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: r2.run });
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].schema, 'validation@1');

    // Call log records the reuse submission
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: r2.run });
    const lastSubmit = logs.items.find((l) => l.tool === 'submit_result');
    assert.ok(lastSubmit);
    assert.equal(lastSubmit.acceptance, 'accepted');

    // Console HTML check
    const page = await consoleClient.get(`/console/runs/${r2.run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(r2.run));
  });
});
