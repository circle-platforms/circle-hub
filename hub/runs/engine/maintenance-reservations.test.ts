// A pass over many runs reads the reservations of all runs once: read per run they were four fifths of what a pass read.
// Only the reconciliation of dispatch uses that reading, and what it writes goes by a reading of that moment.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { accepted, runRecord } from '../../../contracts/src/fixtures.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import type { RunJob, RunReservations } from '../../dispatch/api.ts';
import type { EngineContext } from './deps.ts';
import { maintainRuns } from './maintenance.ts';
import { actionsOf, putResult } from './store.ts';
import { openHarness, type Harness } from './testing/harness.ts';
import { engineOn, storeQuietRun } from './testing/maintenance.ts';

let pg: TemporaryPostgres; let h: Harness;
before(async () => { pg = await startPostgres(); h = await openHarness(pg); for (let at = 0; at < 3; at++) await storeQuietRun(h); });
after(async () => { await h?.close(); await pg?.stop(); });

const jobOf = (job: string, run: string): RunJob => ({ job, verification_run: run, plan_run: run, verification_item: 'case-a', items: ['case-a'], sha256: 'b'.repeat(64), status: { job, phase: 'result', outcome: 'effective', frozen: false, events: 1 }, ended: 'done', boundary_refused: false } as unknown as RunJob);

/** The engine with a dispatch port that counts; `offers` says whether it has the one reading, `jobs` answers for a run. */
function counted(offers: boolean, jobs: (run: string, reservations?: RunReservations) => RunJob[] = () => [], reservations: () => Promise<RunReservations> = async () => new Map()) {
  const seen = { reads: 0, given: [] as (RunReservations | undefined)[] };
  const dispatch = {
    jobs: async (_by: unknown, run: string, given?: RunReservations) => { seen.given.push(given); return jobs(run, given); },
    reconcile: async () => { throw new Error('nothing to reconcile'); },
    ...(offers ? { reservations: () => { seen.reads++; return reservations(); } } : {}),
  } as unknown as NonNullable<EngineContext['deps']['dispatch']>;
  const ctx = engineOn(h, () => new Date());
  return { ctx: { ...ctx, deps: { ...ctx.deps, dispatch } }, seen };
}

test('a pass reads the reservations of all runs once and hands that reading to every run it visits', async () => {
  const reading: RunReservations = new Map();
  const { ctx, seen } = counted(true, () => [], async () => reading);
  await maintainRuns(ctx);
  assert.equal(seen.reads, 1);
  assert.ok(seen.given.length >= 3, 'every run was asked about');
  assert.ok(seen.given.every((given) => given === reading));
});

test('the next pass reads them again, so a reservation written since is seen', async () => {
  const { ctx, seen } = counted(true);
  await maintainRuns(ctx);
  await maintainRuns(ctx);
  assert.equal(seen.reads, 2);
});

test('a dispatch port without the one reading still answers for each run', async () => {
  const { ctx, seen } = counted(false);
  await maintainRuns(ctx);
  assert.ok(seen.given.length >= 3);
  assert.ok(seen.given.every((given) => given === undefined));
});

test('a failed reading is not kept: the pass stops there and the next asks again', async () => {
  let fail = true;
  const { ctx, seen } = counted(true, () => [], async () => { if (fail) throw new Error('synthetic lost connection'); return new Map(); });
  await assert.rejects(maintainRuns(ctx), /synthetic lost connection/);
  fail = false;
  await maintainRuns(ctx);
  assert.equal(seen.reads, 2);
});

/** One pass over a run with an accepted result whose jobs the pass's reading lists as one job and `fresh` lists at that moment: the results it wrote. */
async function resultsWritten(fresh: (run: string, old: RunJob) => RunJob[]): Promise<number> {
  const items = (Object.values(accepted.partitions) as { item: string }[][]).flat().map(({ item }) => ({ ...runRecord.items[0]!, id: item }));
  const stored = await storeQuietRun(h, { items });
  const run = stored.body.run, old = jobOf('a'.repeat(64), run);
  await putResult(h.kit.store, ValidationResult.parse({ ...accepted, run }), new Date().toISOString());
  const { ctx } = counted(true, (asked, given) => asked !== run ? [] : given === undefined ? fresh(run, old) : [old]);
  await maintainRuns(ctx);
  return (await actionsOf(h.kit.store, run)).filter((action) => action.body.detail.dispatch_snapshot !== undefined).length;
}

test('a new result goes by the jobs of that moment: a job reserved since the reading waits for the next pass', async () => {
  assert.equal(await resultsWritten((_run, old) => [old]), 1, 'the same jobs: the result is written');
  assert.equal(await resultsWritten((run, old) => [old, jobOf('c'.repeat(64), run)]), 0, 'a job reserved since: nothing goes by the older list');
});
