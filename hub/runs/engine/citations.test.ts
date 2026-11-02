// The knowledge an accepted submission cites, indexed when it is stored: every tree reference among its strings, by node
// (root and path) and by pinned entry, bounded; a submission that does not parse cites nothing. Counted by window. The
// submissions stored before that are indexed by the backfill, which resumes after a stop and then marks the index complete.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres } from '../../testing/postgres.ts';
import type { TemporaryPostgres } from '../../testing/postgres.ts';
import { openTestRecords } from '../../testing/records.ts';
import type { RecordStore } from '../../records/api.ts';
import {
  INDEX,
  MAX_CITED_ENTRIES,
  MAX_CITED_NODES,
  SCHEMAS,
  backfillCitations,
  citationIndex,
  citationsComplete,
  citationsIndexedSince,
  citedNodeKey,
  countCitations,
  putSubmission,
  personalCitedEntryKey,
} from './store.ts';

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
  assert.deepEqual(citationIndex(body, 'backfilled')[0], { key: INDEX.citesIndexed, value: 'backfilled' }, 'the marker of a backfilled one');
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

test('submissions stored before citations were indexed are indexed by the backfill, which resumes after a stop', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const store = kit.store;
  assert.deepEqual(await backfillCitations(store), { examined: 0, indexed: 0, complete: false }, 'no submission to mark the end on yet');
  // Stored as before the index existed: the same records putSubmission writes, without what they cite.
  const older = (n: number, at: string, grounds: string[], schema: string = SCHEMAS.submission) =>
    store.put({
      kind: 'submission',
      schema,
      provenance: 'declared',
      body: { n, grounds },
      created_at: at,
      index: [
        { key: INDEX.submissionRun, value: RUN },
        { key: INDEX.submissionDigest, value: `${RUN}:${n.toString(16).padStart(64, '0')}` },
      ],
    });
  await older(1, '2026-10-02T00:00:00.000Z', [`tree:${ROOT}/catalog/alpha@${ENTRY}`]);
  await older(2, '2026-10-03T00:00:00.000Z', [`tree:${ROOT}/catalog/alpha`], SCHEMAS.received);
  await older(3, '2026-10-04T00:00:00.000Z', [`tree:${ROOT}/catalog/alpha`]);
  await putSubmission(store, { run: RUN, digest: '4'.padStart(64, '0'), body: { n: 4, grounds: [`tree:${ROOT}/catalog/alpha`] }, parses: true, createdAt: '2026-10-20T00:00:00.000Z' });
  const alpha = { nodes: [{ root: ROOT, path: '/catalog/alpha' }], entries: [ENTRY], since: '2026-10-01T00:00:00.000Z' };
  assert.deepEqual(await countCitations(store, alpha), { count: 1, capped: false }, 'only the one indexed as it was stored');

  // A pass stopped after its first page leaves the rest to the next one.
  const stop = new AbortController();
  let pages = 0;
  const stopping: Pick<RecordStore, 'list' | 'find' | 'addIndex' | 'getMany'> = {
    list: ((query, tx) => {
      pages += 1;
      if (pages > 1) stop.abort();
      return store.list(query, tx);
    }) as RecordStore['list'],
    find: store.find.bind(store),
    getMany: store.getMany.bind(store),
    addIndex: store.addIndex!.bind(store),
  };
  await assert.rejects(backfillCitations(stopping, { batch: 1, signal: stop.signal }), { name: 'AbortError' });
  assert.deepEqual(await countCitations(store, alpha), { count: 2, capped: false });
  assert.equal(await citationsComplete(store), false);

  const resumed = await backfillCitations(store);
  assert.deepEqual(resumed, { examined: 3, indexed: 1, complete: true }, 'up to the one indexed as it was stored; the first was done, the second did not parse');
  assert.deepEqual(await countCitations(store, alpha), { count: 3, capped: false });
  assert.equal(await citationsComplete(store), true);
  assert.equal(await citationsIndexedSince(store), '2026-10-20T00:00:00.000Z', 'where indexing as stored began does not move');
  assert.deepEqual(await backfillCitations(store), { examined: 0, indexed: 0, complete: true }, 'a later pass does nothing');
  const marked = await store.find({ key: INDEX.citesIndexed, value: 'backfilled', kind: 'submission' });
  assert.deepEqual(marked.items.map((item) => (item.body as { n: number }).n), [1, 3]);
});

test('before any submission is indexed as stored, a finished backfill marks its end on the newest one', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const store = kit.store;
  await store.put({ kind: 'submission', schema: SCHEMAS.submission, provenance: 'declared', body: { grounds: [`tree:${ROOT}/catalog/beta`] }, created_at: '2026-10-05T00:00:00.000Z', index: [{ key: INDEX.submissionRun, value: RUN }] });
  assert.deepEqual(await backfillCitations(store), { examined: 1, indexed: 1, complete: true });
  assert.equal(await citationsIndexedSince(store), null, 'none was indexed as it was stored');
  assert.deepEqual(await countCitations(store, { nodes: [{ root: ROOT, path: '/catalog/beta' }], entries: [], since: '2026-10-01T00:00:00.000Z' }), { count: 1, capped: false });
});

test('identical personal content never enters the team entry count, including citation backfill', async t => {
  const kit = await openTestRecords({ postgres }); t.after(() => kit.close());
  const store = kit.store, owner = 'usr_' + '0'.repeat(26);
  const privateRoot = await store.put({ kind: 'knowledge_space_version', schema: 'knowledge-space-version@1', provenance: 'projected', body: { space: owner } });
  const privateBody = { grounds: [`tree:${privateRoot.digest}/notes@${ENTRY}`] };
  await store.put({ kind: 'submission', schema: SCHEMAS.submission, provenance: 'declared', body: { ...privateBody, before: true } });
  await putSubmission(store, { run: RUN, digest: '1'.repeat(64), body: privateBody, parses: true, createdAt: '2026-11-02T00:00:00.000Z' });
  assert.equal((await countCitations(store, { nodes: [], entries: [ENTRY], since: '2026-01-01T00:00:00.000Z' }))?.count, 0);
  await backfillCitations(store);
  assert.equal((await store.find({ key: INDEX.citesPersonalEntry, value: personalCitedEntryKey(owner, ENTRY), kind: 'submission' })).items.length, 2);
  assert.equal((await countCitations(store, { nodes: [], entries: [ENTRY], since: '2026-01-01T00:00:00.000Z' }))?.count, 0);
  await putSubmission(store, { run: RUN, digest: '2'.repeat(64), body: { grounds: [`tree:${ROOT}/notes@${ENTRY}`] }, parses: true, createdAt: '2026-11-02T00:00:01.000Z' });
  assert.equal((await countCitations(store, { nodes: [], entries: [ENTRY], since: '2026-01-01T00:00:00.000Z' }))?.count, 1);
});
