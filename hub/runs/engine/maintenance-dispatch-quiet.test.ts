import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { accepted, runRecord } from '../../../contracts/src/fixtures.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import type { ActionBody } from '../../records/api.ts';
import type { RunJob } from '../../dispatch/api.ts';
import { createPool, Database } from '../../records/db.ts';
import type { EngineContext } from './deps.ts';
import { maintainRuns } from './maintenance.ts';
import { newMaintenanceMemory } from './maintenance-memory.ts';
import { actionsOf, putResult, resultsOf } from './store.ts';
import { openHarness, type Harness } from './testing/harness.ts';
import { engineOn, storeQuietRun } from './testing/maintenance.ts';

let pg: TemporaryPostgres; let h: Harness; let sql: Database;
before(async () => { pg = await startPostgres(); h = await openHarness(pg); sql = new Database(createPool(h.kit.database, 1)); });
after(async () => { await sql?.end(); await h?.close(); await pg?.stop(); });

const JOB = 'a'.repeat(64);
const recordCount = async (): Promise<number> => Number((await sql.query('SELECT count(*)::int AS n FROM records')).rows[0]!.n);

interface Moving { events: number; outcome: string; ended: 'done' | null; result?: string }
const jobOf = (run: string, now: Moving): RunJob => ({
  job: JOB, verification_run: run, plan_run: run, verification_item: 'case-a', items: ['case-a'], sha256: 'b'.repeat(64),
  status: { job: JOB, phase: 'observe', outcome: now.outcome, frozen: false, events: now.events, ...(now.result ? { result: now.result } : {}) },
  ended: now.ended, boundary_refused: false,
} as unknown as RunJob);

let lines = 0;
async function journalLine(): Promise<void> {
  const at = new Date().toISOString();
  await h.kit.store.put<ActionBody>({ kind: 'action', schema: 'action@1', provenance: 'observed', created_at: at, index: [{ key: 'dispatch.job', value: JOB }],
    body: { action: 'validate', run: null, item: null, inputs: [], component: 'dispatch@1', lease: null, started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [], detail: { phase: 'observe', line: ++lines } } });
}

async function observed() {
  const items = (Object.values(accepted.partitions) as { item: string }[][]).flat().map(({ item }) => ({ ...runRecord.items[0]!, id: item }));
  const stored = await storeQuietRun(h, { items });
  const run = stored.body.run;
  await putResult(h.kit.store, ValidationResult.parse({ ...accepted, run }), new Date().toISOString());
  const now: Moving = { events: 5, outcome: 'issued', ended: null };
  const reconciled: number[] = [];
  const dispatch = {
    jobs: async (_by: unknown, asked: string) => asked === run ? [jobOf(run, now)] : [],
    reconcile: async () => { reconciled.push(now.events); return { events: now.events }; },
    runs: async (jobs: readonly string[]) => new Map(jobs.includes(JOB) ? [[run, [JOB]]] : []),
  } as unknown as NonNullable<EngineContext['deps']['dispatch']>;
  const ctx = engineOn(h, () => new Date());
  const engine: EngineContext = { ...ctx, deps: { ...ctx.deps, dispatch } };
  const memory = newMaintenanceMemory();
  const round = async (written = 0) => {
    for (let n = 0; n < written; n++) await journalLine();
    if (memory.fullAt !== null) memory.fullAt = Date.now();
    await maintainRuns(engine, undefined, memory);
  };
  return { run, now, reconciled, round };
}

test('rounds over a job in flight whose journal only grows write no record once the first rounds have seen it', async () => {
  const { run, now, reconciled, round } = await observed();
  await round(); await round(); await round();
  const results = (await resultsOf(h.kit.store, run)).length, actions = (await actionsOf(h.kit.store, run)).length;
  for (let n = 0; n < 4; n++) {
    const before = await recordCount();
    now.events += 6;
    await round(1);
    assert.equal(await recordCount(), before + 1, 'the line the observer wrote and nothing else');
  }
  assert.equal((await resultsOf(h.kit.store, run)).length, results, 'no result, and so no summary of one, for a journal that only grew');
  assert.equal((await actionsOf(h.kit.store, run)).length, actions, 'no action about the job either');
  assert.deepEqual(reconciled, [5], 'the job was asked about once, while its journal stood still, and not again while the observer wrote it');
});

test('what the result depends on changing in the job writes its records once, and the rounds after that write none', async () => {
  const { run, now, round } = await observed();
  await round(); await round();
  const before = (await resultsOf(h.kit.store, run)).length;
  Object.assign(now, { events: 40, outcome: 'effective', ended: 'done', result: `src:${'c'.repeat(64)}` } satisfies Moving);
  await round(1);
  assert.equal((await resultsOf(h.kit.store, run)).length, before + 1, 'the job ended: one new result');
  await round();
  const records = await recordCount();
  for (let n = 0; n < 3; n++) { now.events += 4; await round(1); }
  assert.equal(await recordCount(), records + 3, 'the rounds after the end write nothing but the lines they were given');
});

test('a job whose journal stands still is taken over once for each length it stands at, one round after it moved', async () => {
  const { now, reconciled, round } = await observed();
  await round(); await round(1);
  assert.deepEqual(reconciled, [5], 'asked once at the length the journal has');
  await round(1); await round(1);
  assert.deepEqual(reconciled, [5], 'and not again while it stands there');
  now.events = 9;
  await round(1);
  assert.deepEqual(reconciled, [5], 'the round the journal moved leaves the job alone');
  await round(1);
  assert.deepEqual(reconciled, [5, 9], 'the next one finds it standing still at a new length and asks once more');
  await round(1);
  assert.deepEqual(reconciled, [5, 9]);
});
