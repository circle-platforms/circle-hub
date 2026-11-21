// Decision 182 (W06 R[8]): the earlier target verifications of the subject a run judges, as a client tool reads them before it
// writes for the same subject again. Recorded facts only: which runs carried jobs that took effect, the build each run locked,
// when each job's journal ended and each report row's verdict, from the same checked projection GET /run-export/<run>/jobs
// serves at the reader's tier. Nothing is judged, stored or sent, and no model is called.
//
// The runs are found by a bounded scan, not by an index: the reservations of the dispatch journal name every run a job was
// reserved for (one reading, the same the jobs export does), the newest are looked at first, and their run records are read in
// batches until `limit` runs are found. A run record carries no index of its subject, and records are append-only.
import { RUN_HISTORY_MAX_RUNS, type RunHistoryExport, type RunRecord } from '../../../contracts/src/run.ts';
import type { Principal, StoredRecord } from '../../records/api.ts';
import type { EngineContext } from './deps.ts';
import { exportedJobsWithEnd } from './dispatch-results.ts';
import { runReadableBy } from './grounds.ts';
import { INDEX } from './store.ts';

/** Dispatched runs one answer looks at, newest first; when that is not all of them and fewer than `limit` matched, the answer says so. */
export const HISTORY_SCAN_RUNS = 512;
/** Run records read in one query. */
export const HISTORY_SCAN_BATCH = 32;

/** The export rule of every run-export route beside the run's own visibility: its runner, or an administrator. */
export function mayExport(user: Pick<Principal, 'id' | 'role'>, run: Pick<RunRecord, 'runner'>): boolean {
  return user.role === 'admin' || run.runner === user.id;
}

/**
 * What names the subject of a run across runs: for each source bound with the role subject, its external object identity
 * without the revision (another revision of the same object is the same subject), or the reference of bytes bound directly.
 */
export function subjectIdentities(run: Pick<RunRecord, 'sources'>): string[] {
  const identities = new Set<string>();
  for (const source of run.sources ?? []) if (source.role === 'subject') identities.add(source.external === undefined ? source.reference : source.external.split('@')[0]);
  return [...identities].sort();
}

/** The whole number a `limit` asks for, within 1..RUN_HISTORY_MAX_RUNS; the most when absent. */
export function historyLimit(limit: number | undefined): number {
  return limit === undefined || !Number.isInteger(limit) ? RUN_HISTORY_MAX_RUNS : Math.max(1, Math.min(RUN_HISTORY_MAX_RUNS, limit));
}

/** `stored` is a run the caller has already found exportable by `user`. */
export async function exportHistoryOf(ctx: EngineContext, user: Principal, stored: StoredRecord<RunRecord>, options: { limit?: number } = {}): Promise<RunHistoryExport> {
  const limit = historyLimit(options.limit), subjects = subjectIdentities(stored.body);
  const answer = (runs: RunHistoryExport['runs'], complete: boolean): RunHistoryExport => ({ schema: 'run-history@1', run: stored.body.run, subjects, limit, complete, runs });
  const reservations = subjects.length > 0 ? await ctx.deps.dispatch?.reservations?.() : undefined;
  if (!reservations) return answer([], true);
  // The runs a job was reserved for, in the order the journal first names them; the map is filled as the reservations were written.
  const dispatched: string[] = [];
  for (const [run, bindings] of reservations) if (run !== stored.body.run && bindings.some((binding) => binding.input?.run === run)) dispatched.push(run);
  dispatched.reverse();
  const within = dispatched.slice(0, HISTORY_SCAN_RUNS), store = ctx.deps.records.store;
  const runs: Array<RunHistoryExport['runs'][number] & { ended: string }> = [];
  scan: for (let at = 0; at < within.length; at += HISTORY_SCAN_BATCH) {
    const ids = within.slice(at, at + HISTORY_SCAN_BATCH);
    const read = new Map((await store.findMany<RunRecord>({ kind: 'run', key: INDEX.runId, values: ids })).map((record) => [record.body.run, record.body]));
    for (const id of ids) {
      const candidate = read.get(id);
      // The cheap questions first: who may export it and what it judged are in the record just read.
      if (!candidate || !mayExport(user, candidate) || !subjectIdentities(candidate).some((identity) => subjects.includes(identity))) continue;
      if (!await runReadableBy(ctx, user, candidate)) continue;
      const jobs = (await exportedJobsWithEnd(ctx, id, user, reservations)).filter(({ exported: job }) => job.verification_run === id && job.ended === 'done' && job.outcome === 'effective');
      if (!jobs.length) continue;
      runs.push({
        run: id, started_at: candidate.started_at, build: candidate.build ?? null,
        jobs: jobs.map(({ exported: job, ended_at }) => ({ job: job.job, plan_run: job.plan_run || null, ended_at, outcome: 'effective' as const, rows: job.rows ? job.rows.map((row) => ({ item: row.item, dynamic_terminal: row.dynamic_terminal })) : null })),
        ended: jobs.map(({ ended_at }) => ended_at ?? '').sort().at(-1) || candidate.started_at,
      });
      if (runs.length >= limit) break scan;
    }
  }
  runs.sort((a, b) => a.ended < b.ended ? 1 : a.ended > b.ended ? -1 : a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0);
  return answer(runs.map(({ ended: _ended, ...run }) => run), runs.length >= limit || dispatched.length <= HISTORY_SCAN_RUNS);
}
