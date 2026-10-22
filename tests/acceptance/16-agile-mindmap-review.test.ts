// Scenario 16 (brief section 9 & task acceptance.md):
// The whole review of a ~150-node mind-map fixture fetched through the stubbed agile system pack
// by external id agile:mindmap:<id> with linked story and bug text bound as expected sources.
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
  client = await bed.connect(bed.reviewer, 'sess-s16-whole');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 16: whole review of ~150-node agile mind map with linked expected sources', () => {
  let run: RunSummary;

  test('start_run fetches mindmap by agile:mindmap:<id> and binds linked story and bug sources', async () => {
    run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });

    // 1. The ~150-node mindmap yields 64 case items under the tagged rule
    assert.equal(run.items.length, 64, 'the ~150-node mind map yields 64 case items');

    // 2. Bound sources: subject plus expected sources (linked story and bug from PLM, spec from manual)
    const subject = run.sources.find((s) => s.role === 'subject');
    assert.ok(subject && subject.external?.startsWith(`agile:mindmap:${DOCUMENTS.review}`));

    const expectedSources = run.sources.filter((s) => s.role === 'expected');
    assert.ok(expectedSources.length >= 2, 'has linked expected sources');

    const storySource = expectedSources.find((s) => s.external?.startsWith('plm:story:'));
    const bugSource = expectedSources.find((s) => s.external?.startsWith('plm:bug:'));
    assert.ok(storySource, 'linked story from PLM bound as expected source');
    assert.ok(bugSource, 'linked bug from PLM bound as expected source');

    // 3. Stored artifacts: verify the fetched sources are stored in records
    for (const source of [subject, storySource, bugSource]) {
      const sha256 = source.reference.replace(/^src:/, '').split('/')[0];
      const obj = await bed.hub.records.objects.get(sha256);
      assert.ok(obj !== null, `source artifact ${source.reference} exists in object store`);
    }
  });

  test('submit_result delivers all ~150 items and stores complete validation result', async () => {
    const submission = draft(run);
    const answer = await client.call('submit_result', submission);
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.out.call_result, 'ok');
    assert.equal(answer.out.acceptance, 'accepted');

    const result = resultOf(answer);
    assert.equal(result.partitions.delivered.length, run.items.length);
    assert.equal(answer.out.counts?.delivered, run.items.length);

    // Stored records: validation_result
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: run.run });
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].schema, 'validation@1');

    // Call log reflects completion
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: run.run });
    const submitCall = logs.items.find((l) => l.tool === 'submit_result');
    assert.ok(submitCall);
    assert.equal(submitCall.acceptance, 'accepted');

    // Console HTML displays the ~150 items and delivered count
    const page = await consoleClient.get(`/console/runs/${run.run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(String(run.items.length)));
    assert.ok(page.body.includes(run.run));
  });
});
