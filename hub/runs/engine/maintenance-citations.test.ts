// The engine's maintenance indexes, in the background, the citations of submissions stored before citations were
// indexed (backfillCitations): a pass starts with the maintenance, and stopping the maintenance waits for it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip, type Harness } from './testing/harness.ts';
import { openRetryHarness as openHarness } from './testing/retry-harness.ts';
import { INDEX, SCHEMAS, citationsComplete, countCitations } from './store.ts';

let pg: TemporaryPostgres;
let h: Harness;
const skip = await sandboxSkip();
before(async () => {
  pg = await startPostgres();
  if (!skip) h = await openHarness(pg);
});
after(async () => {
  await h?.close();
  await pg?.stop();
});

test('the maintenance indexes an older submission by what it cites, in the background', { skip }, async () => {
  const store = h.kit.store;
  const root = 'a'.repeat(64);
  await store.put({
    kind: 'submission',
    schema: SCHEMAS.submission,
    provenance: 'declared',
    body: { grounds: [`tree:${root}/catalog/alpha`] },
    created_at: '2026-10-01T00:00:00.000Z',
    index: [{ key: INDEX.submissionRun, value: `run_${'0'.repeat(26)}` }],
  });
  await h.service.startMaintenance();
  for (let i = 0; i < 400 && !(await citationsComplete(store)); i++) await delay(25);
  await h.service.stopMaintenance();
  assert.equal(await citationsComplete(store), true);
  assert.deepEqual(await countCitations(store, { nodes: [{ root, path: '/catalog/alpha' }], entries: [], since: '2026-09-01T00:00:00.000Z' }), { count: 1, capped: false });
});
