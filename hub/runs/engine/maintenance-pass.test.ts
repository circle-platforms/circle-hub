// One maintenance pass over a store with an expired run and an overdue request: the account list is read once per pass,
// an escalation that exists already is not looked up and written again, and a pass asked to stop (the service shutting
// down) returns before its next run and leaves the work to the next pass.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip, type Harness } from './testing/harness.ts';
import { openRetryHarness as openHarness } from './testing/retry-harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';

let pg: TemporaryPostgres; let h: Harness; const skip = await sandboxSkip();
before(async () => { pg = await startPostgres(); if (!skip) h = await openHarness(pg); });
after(async () => { await h?.close(); await pg?.stop(); });

/** A run without an accepted submission whose deadline has passed: its default finite deadline, then the clock past it. */
async function expiredRun(): Promise<{ run: string; items: number }> {
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '10.6.1', build: 'Rel_MEADOW_10_6_1_7', inputs: { map: { reference: map } } }, h.call());
  const run = started.run!;
  h.advance(Date.parse(run.submission_due!) - Date.parse(run.started_at) + 120000);
  return { run: run.run, items: run.items.length };
}

/** Counts, during one call, the account-list reads and the request writes' duplicate lookups. */
async function counting<T>(work: () => Promise<T>): Promise<{ value: T; lists: number; keyLookups: number }> {
  const principals = h.kit.principals, store = h.kit.store;
  const list = principals.list, find = store.find;
  let lists = 0, keyLookups = 0;
  principals.list = async (...args: Parameters<typeof list>) => { lists++; return list.apply(principals, args); };
  store.find = (async (query: { key?: string }, tx?: unknown) => { if (query.key === 'runs.request.key') keyLookups++; return (find as (...args: unknown[]) => unknown).call(store, query, tx); }) as typeof store.find;
  try { return { value: await work(), lists, keyLookups }; }
  finally { principals.list = list; store.find = find; }
}

test('a pass reads the account list once and does not look up an escalation that exists', { skip }, async () => {
  const { run } = await expiredRun();
  await h.service.maintain();
  const expired = (await h.service.getRun(h.alice, run))!;
  assert.ok(expired.requests!.some((r) => r.kind === 'disposition' && r.answered_by === null), 'the expired run has an open disposition request');
  h.advance(2 * 86400000);
  const escalating = await counting(() => h.service.maintain());
  assert.equal(escalating.lists, 1, 'one account list for the whole pass');
  const listed = await h.service.listRequests!(h.admin);
  assert.ok(listed.some((r) => r.kind === 'clarification' && r.audience === h.admin.id && r.code === 'awaiting_step'), 'the overdue request was escalated to the administrator');
  const again = await counting(() => h.service.maintain());
  assert.equal(again.keyLookups, 0, 'the escalation exists: it is neither looked up nor written again');
  assert.equal((await h.service.listRequests!(h.admin)).length, listed.length, 'no request was added');
});

test('a pass asked to stop returns before its next run, and the next pass does the work', { skip }, async () => {
  const { run, items } = await expiredRun();
  const pass = h.service.maintain();
  await h.service.stopMaintenance({ abort: true });
  await pass;
  assert.ok(!(await h.service.getRun(h.alice, run))!.latest, 'the stopped pass did not reach the run');
  await h.service.maintain();
  const done = (await h.service.getRun(h.alice, run))!;
  assert.equal(done.latest!.result.partitions.incomplete.length, items, 'the next pass delivered the expired run');
});
