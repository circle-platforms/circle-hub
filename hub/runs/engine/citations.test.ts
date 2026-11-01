// The knowledge an accepted submission cites, indexed when it is stored: every tree reference among its strings, by node
// (root and path) and by pinned entry, bounded; a submission that does not parse cites nothing. Counted by window.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres } from '../../testing/postgres.ts';
import type { TemporaryPostgres } from '../../testing/postgres.ts';
import { openTestRecords } from '../../testing/records.ts';
import { INDEX, MAX_CITED_ENTRIES, MAX_CITED_NODES, citationIndex, citationsIndexedSince, citedNodeKey, countCitations, putSubmission } from './store.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

const ROOT = 'a'.repeat(64);
const OTHER_ROOT = 'c'.repeat(64);
const ENTRY = 'b'.repeat(64);
const RUN = `run_${'0'.repeat(26)}`;

test('every tree reference in a body is indexed by node and pinned entry, once each and bounded', () => {
  const body = {
    items: [
      { slots: { findings: [{ text: '期望结果缺失', grounds: [`tree:${ROOT}/catalog/alpha@${ENTRY}`, `tree:${ROOT}/catalog/alpha`] }] } },
      { quote: { reference: `tree:${OTHER_ROOT}/catalog/beta`, text: 'x' }, other: 'src:' + 'd'.repeat(64) },
      { broken: 'tree:not-a-root/x', plain: 'tree is a word' },
    ],
  };
  const index = citationIndex(body);
  assert.deepEqual(index[0], { key: INDEX.citesIndexed, value: '1' });
  assert.deepEqual(
    index.filter((entry) => entry.key === INDEX.citesNode).map((entry) => entry.value).sort(),
    [citedNodeKey(ROOT, '/catalog/alpha'), citedNodeKey(OTHER_ROOT, '/catalog/beta')].sort(),
  );
  assert.deepEqual(index.filter((entry) => entry.key === INDEX.citesEntry).map((entry) => entry.value), [ENTRY]);

  const many = { grounds: Array.from({ length: 300 }, (_, i) => `tree:${ROOT}/n${i}@${i.toString(16).padStart(64, '0')}`) };
  const bounded = citationIndex(many);
  assert.equal(bounded.filter((entry) => entry.key === INDEX.citesNode).length, MAX_CITED_NODES);
  assert.equal(bounded.filter((entry) => entry.key === INDEX.citesEntry).length, MAX_CITED_ENTRIES);
  assert.ok(bounded.length + 2 <= 200, 'with the run\'s two entries, within the 200 a record takes');
  assert.deepEqual(citationIndex('plain text'), [{ key: INDEX.citesIndexed, value: '1' }]);
});

test('accepted submissions are counted by window, by node or entry; one that does not parse cites nothing', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const store = kit.store;
  assert.equal(await citationsIndexedSince(store), null, 'nothing indexed yet');
  const submit = (n: number, at: string, grounds: string[], parses = true) =>
    putSubmission(store, { run: RUN, digest: n.toString(16).padStart(64, '0'), body: { n, grounds }, parses, createdAt: at });
  await submit(1, '2026-09-20T00:00:00.000Z', [`tree:${ROOT}/catalog/alpha@${ENTRY}`]);
  await submit(2, '2026-10-20T00:00:00.000Z', [`tree:${ROOT}/catalog/alpha`]);
  await submit(3, '2026-10-25T00:00:00.000Z', [`tree:${OTHER_ROOT}/catalog/alpha@${ENTRY}`]);
  await submit(4, '2026-10-26T00:00:00.000Z', [`tree:${ROOT}/catalog/alpha@${ENTRY}`], false);
  await submit(5, '2026-10-27T00:00:00.000Z', [`tree:${ROOT}/catalog/gamma`]);
  const since = '2026-10-01T00:00:00.000Z';
  // The node in its root, or its entry from any root: submissions 2 and 3 (1 is outside the window, 4 did not parse).
  assert.deepEqual(await countCitations(store, { nodes: [{ root: ROOT, path: '/catalog/alpha' }], entries: [ENTRY], since }), { count: 2, capped: false });
  assert.deepEqual(await countCitations(store, { nodes: [], entries: [ENTRY], since }), { count: 1, capped: false });
  assert.deepEqual(await countCitations(store, { nodes: [{ root: ROOT, path: '/catalog/alpha' }], entries: [ENTRY], since: '2026-09-01T00:00:00.000Z', cap: 2 }), { count: 2, capped: true });
  assert.equal(await citationsIndexedSince(store), '2026-09-20T00:00:00.000Z');
});
