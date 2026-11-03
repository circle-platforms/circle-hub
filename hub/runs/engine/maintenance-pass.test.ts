// One maintenance pass over a store with an expired run and an overdue request: the account list is read once per pass,
// an escalation that exists already is not looked up and written again, and a pass asked to stop (the service shutting
// down) returns before its next run and leaves the work to the next pass; scheduled passes visit only the runs something
// happened to (a new record, a passed deadline) and every run every half hour.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip, type Harness } from './testing/harness.ts';
import { openRetryHarness as openHarness } from './testing/retry-harness.ts';
import { FULL_PASS_MS } from './maintenance.ts';
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

/** The runs whose actions a call reads (the first lookup of every visited run reads them). */
async function visited<T>(work: () => Promise<T>): Promise<Set<string>> {
  const store = h.kit.store, find = store.find;
  const runs = new Set<string>();
  store.find = (async (query: { key?: string; value?: string }, tx?: unknown) => { if (query.key === 'runs.action.run' && query.value) runs.add(query.value); return (find as (...args: unknown[]) => unknown).call(store, query, tx); }) as typeof store.find;
  try { await work(); return runs; } finally { store.find = find; }
}

test('scheduled passes visit only the runs something happened to, a passed deadline, and every run every half hour', { skip }, async () => {
  const a = await expiredRun(), b = await expiredRun();
  // The first scheduled pass visits every run. A visit remembers the position it found, so the run's own new records (the
  // expiry delivery, then the requests restored from it) bring it back once more each: the passes settle, then go quiet.
  assert.ok((await visited(() => h.service.maintain({ incremental: true }))).has(a.run));
  await h.service.maintain({ incremental: true });
  await h.service.maintain({ incremental: true });
  const quiet = await visited(() => h.service.maintain({ incremental: true }));
  assert.ok(!quiet.has(a.run) && !quiet.has(b.run), 'nothing happened to either run');
  // A record of one run: only that run is visited.
  const at = new Date().toISOString();
  await h.kit.store.put({ kind: 'action', schema: 'action@1', provenance: 'observed', created_at: at, body: { action: 'validate', run: a.run, item: null, inputs: [], component: 'synthetic-maintenance@1', lease: null, started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [], detail: { synthetic: true } }, index: [{ key: 'runs.action.run', value: a.run }] });
  const touched = await visited(() => h.service.maintain({ incremental: true }));
  assert.ok(touched.has(a.run) && !touched.has(b.run), 'only the run with a new record');
  // A run due in ten minutes (within the half hour, so no full pass decides it): skipped while its deadline is ahead,
  // visited once it has passed.
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  const start = (due?: string) => h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '10.6.1', build: 'Rel_MEADOW_10_6_1_7', ...(due ? { submission_due: due } : {}), inputs: { map: { reference: map } } }, h.call());
  const now = Date.parse((await start()).run!.started_at);
  const fresh = (await start(new Date(now + 10 * 60000).toISOString())).run!;
  await h.service.maintain({ incremental: true });
  await h.service.maintain({ incremental: true });
  assert.ok(!(await visited(() => h.service.maintain({ incremental: true }))).has(fresh.run), 'the deadline is still ahead');
  h.advance(9 * 60000);
  assert.ok(!(await visited(() => h.service.maintain({ incremental: true }))).has(fresh.run), 'still ahead nine minutes on');
  h.advance(2 * 60000);
  assert.ok((await visited(() => h.service.maintain({ incremental: true }))).has(fresh.run), 'the deadline passed since the last visit');
  assert.equal((await h.service.getRun(h.alice, fresh.run))!.latest!.result.partitions.incomplete.length, fresh.items.length, 'and the run was delivered as expired');
  // Half an hour on, a scheduled pass visits every run again.
  h.advance(FULL_PASS_MS);
  const full = await visited(() => h.service.maintain({ incremental: true }));
  assert.ok(full.has(a.run) && full.has(b.run) && full.has(fresh.run), 'a full pass');
  // An explicit pass without the option still visits every run.
  const explicit = await visited(() => h.service.maintain());
  assert.ok(explicit.has(a.run) && explicit.has(b.run));
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
