// What scheduled maintenance rounds remember, and how one learns what to do: the cost of a round follows what changed, not the
// history (decision 146). Everything a round acts on comes from one of four sources, and an idle round reads only the first
// two: the account list, the end of the append log, what the log gained since the last round, and the schedules below, which
// are in memory. A round then reads, with verified reads, the runs and requests those name, and nothing else. A pass that
// visits every run fills the schedules, so a process knows them from its first pass on.
import { openAppendCursor, readAppended, type AppendCursor, type AppendedEntry, type RecordKind, type RecordStore } from '../../records/api.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { EngineContext } from './deps.ts';
import type { RequestBody, RequestView } from './requests.ts';
import { INDEX } from './store.ts';

/** The requests the next sweeps look at; what is here stays until the sweeps have finished. */
export interface RequestWork {
  /** Look at every request: a pass that visited every run, or an account list that changed. */
  all: boolean;
  /** The requests of the runs something happened to and of the packs named by a request bound to no run. */
  runs: Set<string>;
  packs: Set<string>;
  /** Requests with a new answer, and pack versions a new run was started on: all a repaired pack can newly affect. */
  answered: Set<string>;
  versions: Set<string>;
}

export interface MaintenanceMemory {
  /** When the last pass that visited every run started (null: none yet). */
  fullAt: number | null;
  /** Where this process is in the append log (null: not started), and what it read there and has not taken in yet. */
  log: AppendCursor | null;
  arrived: AppendedEntry[];
  /** What of the accounts decides a request's next step, as last read. */
  accounts: string | null;
  /** The runs still to visit, by id, and those of them that are new. */
  visits: Set<string>;
  started: Set<string>;
  requests: RequestWork;
  /** Submission deadlines still ahead, by run: passing one is work no record shows. */
  deadlines: Map<string, number>;
  /** Request deadlines no round has taken in yet, by request, with where the request is found. */
  due: Map<string, { at: number; run?: string; pack?: string }>;
  /** Unanswered source dispositions, by request, with their run: a new source or authorization may let them proceed. */
  sources: Map<string, string>;
  /** Pack versions a repair request of which is answered: a run newly started on one is told about its repair. */
  repaired: Set<string>;
}

export function newMaintenanceMemory(): MaintenanceMemory {
  return {
    fullAt: null, log: null, arrived: [], accounts: null, visits: new Set(), started: new Set(),
    requests: { all: false, runs: new Set(), packs: new Set(), answered: new Set(), versions: new Set() },
    deadlines: new Map(), due: new Map(), sources: new Map(), repaired: new Set(),
  };
}

export const requestsAwaitWork = ({ all, runs, packs, answered, versions }: RequestWork): boolean => all || runs.size + packs.size + answered.size + versions.size > 0;

export function clearRequestWork(work: RequestWork): void {
  work.all = false;
  for (const set of [work.runs, work.packs, work.answered, work.versions]) set.clear();
}

type Followed = RecordStore & Required<Pick<RecordStore, 'appendHorizon' | 'appended'>>;

/** Without these parts a round cannot know what changed, and every pass visits every run. */
export function canFollow(ctx: EngineContext): boolean {
  const { store, principals } = ctx.deps.records;
  return store.appendHorizon !== undefined && store.appended !== undefined && principals?.list !== undefined && (ctx.deps.dispatch === undefined || ctx.deps.dispatch.runs !== undefined);
}

/** The index keys whose value is a run id: its actions, submissions, results, requests and successors. */
const RUN_KEYS = new Set<string>([INDEX.actionRun, INDEX.submissionRun, INDEX.resultRun, INDEX.runPredecessor, 'runs.request.run']);
const WATCHED: { keys: readonly string[]; kinds: readonly RecordKind[] } = {
  keys: [INDEX.runId, ...RUN_KEYS, 'dispatch.job', 'runs.request.pack', 'runs.request.answer'],
  // What a source's availability is decided from: its records, its lineage's, and the acceptances and grants over them.
  kinds: ['authorization', 'source_artifact'],
};
const LOOKUP_BATCH = 128;

/**
 * The accounts as far as a request's next step depends on them, in the list's order (the first active administrator is the one
 * escalated to): who is an administrator and who cannot act. A new ordinary account changes nothing for any request.
 */
const accountsKey = (accounts: readonly { id: string; role: string; disabled: boolean; deleted_at?: string | null }[]): string =>
  JSON.stringify(accounts.filter((account) => account.role === 'admin' || account.disabled || account.deleted_at).map((account) => [account.id, account.role, account.disabled, account.deleted_at ?? null]));

/**
 * Takes in what changed since the last call: what the log gained and whether the accounts moved. A run a record names is visited
 * and its requests are looked at, as are the runs following it, since a successor answers its predecessor's requests.
 */
export async function noteChanges(ctx: EngineContext, memory: MaintenanceMemory): Promise<void> {
  const store = ctx.deps.records.store as Followed, work = memory.requests;
  // No record shows an account change, and every request's next step depends on the active administrators.
  const accounts = accountsKey(await ctx.deps.records.principals!.list!());
  if (accounts !== memory.accounts) { memory.accounts = accounts; work.all = true; }
  memory.log ??= await openAppendCursor(store);
  // The cursor has moved on from these rows: they stay here until they are taken in whole, so a lookup that fails loses nothing.
  const rows = memory.arrived = memory.arrived.concat(await readAppended(store, memory.log, WATCHED));
  const touched = new Set<string>(), jobs = new Set<string>(), answered = new Set<string>(), boundToRun = new Set<number>();
  for (const row of rows) {
    if (row.value === null) continue;
    if (row.key === INDEX.runId) { memory.visits.add(row.value); memory.started.add(row.value); }
    else if (row.key === 'dispatch.job') jobs.add(row.value);
    else if (row.key === 'runs.request.answer') answered.add(row.value);
    else if (row.key !== null && RUN_KEYS.has(row.key)) { touched.add(row.value); if (row.key === 'runs.request.run') boundToRun.add(row.position); }
  }
  for (const row of rows) if (row.key === 'runs.request.pack' && row.value !== null && !boundToRun.has(row.position)) work.packs.add(row.value);
  const named = [...touched];
  for (const run of named) { memory.visits.add(run); work.runs.add(run); }
  for (let at = 0; at < named.length; at += LOOKUP_BATCH) for (const successor of await store.findMany<RunRecord>({ key: INDEX.runPredecessor, values: named.slice(at, at + LOOKUP_BATCH), kind: 'run' })) memory.visits.add(successor.body.run);
  if (jobs.size > 0 && ctx.deps.dispatch?.runs) for (const [run, bound] of await ctx.deps.dispatch.runs([...jobs])) if (bound.some((job) => jobs.has(job))) { memory.visits.add(run); work.runs.add(run); }
  if (answered.size > 0) for (const record of (await store.getMany<RequestBody>([...answered])).values()) {
    if (record.kind !== 'request') continue;
    work.answered.add(record.digest);
    if (record.body.run) work.runs.add(record.body.run); else if (record.body.pack_digest) work.packs.add(record.body.pack_digest);
  }
  if (rows.some((row) => WATCHED.kinds.includes(row.kind))) for (const run of memory.sources.values()) work.runs.add(run);
  memory.arrived = [];
}

/** Moves what fell due by `now` into the work of this round: this is the work no record announces. */
export function noteDeadlines(memory: MaintenanceMemory, now: number): void {
  for (const [run, at] of memory.deadlines) if (at <= now) { memory.deadlines.delete(run); memory.visits.add(run); }
  for (const [request, { at, run, pack }] of memory.due) if (at <= now) {
    memory.due.delete(request);
    if (run !== undefined) memory.requests.runs.add(run); else if (pack !== undefined) memory.requests.packs.add(pack);
  }
}

/** What a visit to this run schedules; before the visit, so that a visit that fails is not retried until something happens. */
export function noteVisit(memory: MaintenanceMemory, run: RunRecord, at: number): void {
  const due = run.submission_due ? Date.parse(run.submission_due) : Number.NaN;
  // A deadline that passes after this visit is work no record shows.
  if (Number.isFinite(due) && due > at) memory.deadlines.set(run.run, due); else memory.deadlines.delete(run.run);
  if (memory.started.delete(run.run) && memory.repaired.has(run.pack_digest)) memory.requests.versions.add(run.pack_digest);
}

/** Keeps the request schedules current from any list of requests a round reads. */
export function noteRequests(memory: MaintenanceMemory, requests: readonly RequestView[], now: number): void {
  for (const request of requests) {
    const open = request.answered_by === null, due = Date.parse(request.due);
    // A deadline that has passed is left to noteDeadlines: this list may be one the escalation sweep does not read.
    if (!open) memory.due.delete(request.record); else if (due > now) memory.due.set(request.record, { at: due, run: request.run, pack: request.pack_digest });
    if (open && request.run && request.kind === 'disposition' && request.sources?.length) memory.sources.set(request.record, request.run); else memory.sources.delete(request.record);
    if (!open && request.kind === 'repair' && request.pack_digest) memory.repaired.add(request.pack_digest);
  }
}
