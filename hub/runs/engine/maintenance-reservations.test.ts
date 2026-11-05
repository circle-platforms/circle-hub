// A pass over many runs reads the reservations of all runs once: read per run they were three quarters of what a pass read.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import type { RunReservations } from '../../dispatch/api.ts';
import type { EngineContext } from './deps.ts';
import { maintainRuns } from './maintenance.ts';
import { openHarness, type Harness } from './testing/harness.ts';
import { engineOn, storeQuietRun } from './testing/maintenance.ts';

let pg: TemporaryPostgres; let h: Harness;
before(async () => { pg = await startPostgres(); h = await openHarness(pg); for (let at = 0; at < 3; at++) await storeQuietRun(h); });
after(async () => { await h?.close(); await pg?.stop(); });

/** The engine with a dispatch port that counts; `reservations` says whether the port offers the one reading. */
function counted(offers: boolean) {
  const reading: RunReservations = new Map();
  const seen = { reads: 0, given: [] as (RunReservations | undefined)[] };
  const dispatch = {
    jobs: async (_by: unknown, _run: string, reservations?: RunReservations) => { seen.given.push(reservations); return []; },
    reconcile: async () => { throw new Error('nothing to reconcile'); },
    ...(offers ? { reservations: async () => { seen.reads++; return reading; } } : {}),
  } as unknown as NonNullable<EngineContext['deps']['dispatch']>;
  const ctx = engineOn(h, () => new Date());
  return { ctx: { ...ctx, deps: { ...ctx.deps, dispatch } }, reading, seen };
}

test('a pass reads the reservations of all runs once and hands that reading to every run it visits', async () => {
  const { ctx, reading, seen } = counted(true);
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
