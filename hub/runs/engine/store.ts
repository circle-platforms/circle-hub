// The records the engine writes and reads: run@1, submission@1 (or submission-received@1), validation@1 and action@1, with
// the index entries that find them. Every body is checked against its contract shape before it is written: an engine that
// builds an invalid record fails loudly instead of storing it.
import { RunRecord } from '../../../contracts/src/run.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import { IntegrityError, recordDigest, type ActionBody, type IndexEntry, type Page, type RecordStore, type StoredRecord, type Transaction } from '../../records/api.ts';
import { ENGINE_COMPONENT } from './deps.ts';
import { isObject } from './util.ts';

export const INDEX = {
  runId: 'runs.id',
  runUser: 'runs.user',
  runPack: 'runs.pack',
  runUserPack: 'runs.user_pack',
  runPredecessor: 'runs.predecessor',
  runClientKey: 'runs.client_key',
  runConfigurer: 'runs.configurer',
  submissionRun: 'runs.submission.run',
  submissionDigest: 'runs.submission.digest',
  resultRun: 'runs.result.run',
  resultSystemInput: 'runs.result.system_input',
  resultSubmission: 'runs.result.submission',
  actionRun: 'runs.action.run',
  actionSubmission: 'runs.action.submission',
} as const;

export const SCHEMAS = {
  run: 'run@1',
  submission: 'submission@1',
  received: 'submission-received@1',
  result: 'validation@1',
  action: 'action@1',
} as const;

async function all<B>(page: (cursor: string | null) => Promise<Page<StoredRecord<B>>>): Promise<StoredRecord<B>[]> {
  const out: StoredRecord<B>[] = [];
  let cursor: string | null = null;
  const seen=new Set<string>();
  do {
    const next: Page<StoredRecord<B>> = await page(cursor);
    out.push(...next.items);
    cursor = next.next;
    if(cursor!==null){if(seen.has(cursor))throw new IntegrityError('记录分页游标重复，不能形成完整范围',{fix:'管理员修复记录索引后重试，不截断已有结果'});seen.add(cursor);}
  } while (cursor !== null);
  return out;
}

/** Owner of a client key: the runner, or the configurer of a run the Hub executes. */
export function keyOwner(run: Pick<RunRecord, 'runner' | 'configurer'>): string {
  return run.runner ?? `hub:${run.configurer ?? ''}`;
}

export async function putRun(store: RecordStore, body: RunRecord, createdAt: string): Promise<StoredRecord<RunRecord>> {
  const record = RunRecord.parse(body);
  const index: IndexEntry[] = [
    { key: INDEX.runId, value: record.run },
    { key: INDEX.runPack, value: record.pack.slice(0, record.pack.indexOf('@')) },
  ];
  if (record.runner !== undefined) {
    index.push({ key: INDEX.runUser, value: record.runner });
    index.push({ key: INDEX.runUserPack, value: `${record.runner}:${record.pack.slice(0, record.pack.indexOf('@'))}` });
  }
  if (record.configurer !== undefined) index.push({ key: INDEX.runConfigurer, value: record.configurer });
  if (record.predecessor !== undefined) index.push({ key: INDEX.runPredecessor, value: record.predecessor });
  if (record.client_key !== undefined) index.push({ key: INDEX.runClientKey, value: `${keyOwner(record)}:${record.client_key}` });
  return store.put<RunRecord>({ kind: 'run', schema: SCHEMAS.run, provenance: 'observed', body: record, created_at: createdAt, index });
}

export async function runById(store: RecordStore, id: string): Promise<StoredRecord<RunRecord> | null> {
  if (typeof id !== 'string' || !/^run_[0-9a-hjkmnp-tv-z]{26}$/.test(id)) return null;
  const page = await store.find<RunRecord>({ key: INDEX.runId, value: id, kind: 'run', limit: 1 });
  return page.items[0] ?? null;
}

/** Runs started with this run as predecessor, oldest first. */
export async function successorsOf(store: RecordStore, id: string): Promise<StoredRecord<RunRecord>[]> {
  return all((cursor) => store.find<RunRecord>({ key: INDEX.runPredecessor, value: id, kind: 'run', limit: 500, cursor }));
}

/** The newest run bound to this owner's client key. */
export async function runByClientKey(store: RecordStore, owner: string, key: string): Promise<StoredRecord<RunRecord> | null> {
  const page = await store.find<RunRecord>({ key: INDEX.runClientKey, value: `${owner}:${key}`, kind: 'run', limit: 1, newestFirst: true });
  return page.items[0] ?? null;
}

export async function listRunRecords(
  store: RecordStore,
  filter: { user?: string; pack?: string },
  page: { limit?: number; cursor?: string | null },
): Promise<Page<StoredRecord<RunRecord>>> {
  const base = { kind: 'run' as const, limit: page.limit, cursor: page.cursor ?? null, newestFirst: true };
  if (filter.user !== undefined && filter.pack !== undefined) return store.find<RunRecord>({ ...base, key: INDEX.runUserPack, value: `${filter.user}:${filter.pack}` });
  if (filter.user !== undefined) return store.find<RunRecord>({ ...base, key: INDEX.runUser, value: filter.user });
  if (filter.pack !== undefined) return store.find<RunRecord>({ ...base, key: INDEX.runPack, value: filter.pack });
  return store.list<RunRecord>({ kind: 'run', limit: page.limit, cursor: page.cursor ?? null, newestFirst: true });
}

/**
 * Body of a submission record whose arguments the records cannot hold as checked JSON (a lone surrogate, nesting past the
 * canonical limit, a body over the record limit): their JSON text is an object (`object`, absent when the object store refused
 * it too), with its SHA-256 and size, the path canonical JSON refused ('' when it was the size) and the run. It never has a
 * top-level `run`, which raw arguments stored by the engine always have.
 */
export interface VerbatimObjectBody {
  received: { object?: string; sha256: string; size: number; non_canonical_path: string; run: string };
}

/** Whether a stored submission is the engine's wrapper of VerbatimObjectBody rather than the raw arguments. */
export function isVerbatimObject(record: { schema: string; body: unknown }): boolean {
  const body = record.body;
  return record.schema === SCHEMAS.received && isObject(body) && typeof body.run !== 'string' && isObject(body.received);
}

/** The digest the record of this run body gets when stored at `createdAt` (putRun): a production result names it before it is stored. */
export function runRecordDigest(body: RunRecord, createdAt: string): string {
  return recordDigest({ kind: 'run', schema: SCHEMAS.run, provenance: 'observed', created_at: createdAt, body: RunRecord.parse(body) });
}

export async function putSubmission(
  store: RecordStore,
  input: { run: string; digest: string; body: unknown; parses: boolean; createdAt: string },
): Promise<StoredRecord<unknown>> {
  return store.put<unknown>({
    kind: 'submission',
    schema: input.parses ? SCHEMAS.submission : SCHEMAS.received,
    provenance: 'declared',
    body: input.body,
    created_at: input.createdAt,
    index: [
      { key: INDEX.submissionRun, value: input.run },
      { key: INDEX.submissionDigest, value: `${input.run}:${input.digest}` },
    ],
  });
}

export async function submissionByDigest(store: RecordStore, run: string, digest: string): Promise<StoredRecord<unknown> | null> {
  const page = await store.find<unknown>({ key: INDEX.submissionDigest, value: `${run}:${digest}`, kind: 'submission', limit: 1 });
  return page.items[0] ?? null;
}

export async function submissionsOf(store: RecordStore, run: string): Promise<StoredRecord<unknown>[]> {
  return all((cursor) => store.find<unknown>({ key: INDEX.submissionRun, value: run, kind: 'submission', limit: 500, cursor }));
}

export async function putResult(store: RecordStore, result: ValidationResult, createdAt: string, tx?: Transaction): Promise<StoredRecord<ValidationResult>> {
  const body = ValidationResult.parse(result);
  return store.put<ValidationResult>({
    kind: 'validation_result',
    schema: SCHEMAS.result,
    provenance: 'projected',
    body,
    created_at: createdAt,
    index: [
      {key:INDEX.resultRun,value:body.run},
      ...(body.system_input?[{key:INDEX.resultSystemInput,value:body.system_input}]:[{ key: INDEX.resultSubmission, value: `${body.run}:${body.submission}` }]),
    ],
  }, tx);
}

export async function resultFor(store: RecordStore, run: string, submission: string): Promise<StoredRecord<ValidationResult> | null> {
  const page = await store.find<ValidationResult>({ key: INDEX.resultSubmission, value: `${run}:${submission}`, kind: 'validation_result', limit: 1, newestFirst:true });
  return page.items[0] ?? null;
}

/** Every validation result of a run, in record sequence. */
export async function resultsOf(store:RecordStore,run:string):Promise<StoredRecord<ValidationResult>[]>{return all(cursor=>store.find<ValidationResult>({key:INDEX.resultRun,value:run,kind:'validation_result',limit:500,cursor}));}

/** The latest accepted validation result of a run (an accepted submission or a production result). */
export async function latestAccepted(store: RecordStore, run: string): Promise<StoredRecord<ValidationResult> | null> {
  let cursor: string | null = null;
  do {
    const page: Page<StoredRecord<ValidationResult>> = await store.find<ValidationResult>({ key: INDEX.resultRun, value: run, kind: 'validation_result', limit: 100, cursor, newestFirst: true });
    const found = page.items.find((r) => r.body.acceptance === 'accepted');
    if (found) return found;
    cursor = page.next;
  } while (cursor !== null);
  return null;
}

/** What the engine records in the detail of its validate actions. */
export interface ValidateDetail {
  /** Digest of the submission as received (or of the run record for a production result). */
  submission: string;
  /** Client session observed at this call (Circle-Session-Id). */
  session: string | null;
  /** Model the submission declares; null for a production result or a submission that does not parse. */
  model: string | null;
  /** Requirements that had a problem counted as a repair round in this submission. */
  repair: string[];
  /** Digest of the validation_result record, when one was written. */
  result: string | null;
  production?: boolean;
  [key: string]: unknown;
}

export async function putAction(
  store: RecordStore,
  input: {
    action: ActionBody['action'];
    run: string;
    inputs: string[];
    startedAt: string;
    endedAt: string;
    result?: ActionBody['result'];
    errorCode?: string | null;
    acceptance: ActionBody['acceptance'];
    codes: string[];
    detail: Record<string, unknown>;
    component?: string;
    submissionRecord?: string;
  },
): Promise<StoredRecord<ActionBody>> {
  const body: ActionBody = {
    action: input.action,
    run: input.run,
    item: null,
    inputs: input.inputs,
    component: input.component ?? ENGINE_COMPONENT,
    lease: null,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    result: input.result ?? 'completed',
    error_code: input.errorCode ?? null,
    acceptance: input.acceptance,
    codes: input.codes,
    detail: input.detail,
  };
  const index: IndexEntry[] = [
    { key: 'action.kind', value: input.action },
    { key: 'action.run', value: input.run },
    { key: INDEX.actionRun, value: input.run },
  ];
  if (input.submissionRecord !== undefined) index.push({ key: INDEX.actionSubmission, value: input.submissionRecord });
  return store.put<ActionBody>({ kind: 'action', schema: SCHEMAS.action, provenance: 'observed', body, created_at: input.endedAt, index });
}

/** The engine's actions of a run, oldest first. */
export async function actionsOf(store: RecordStore, run: string): Promise<StoredRecord<ActionBody>[]> {
  return all((cursor) => store.find<ActionBody>({ key: INDEX.actionRun, value: run, kind: 'action', limit: 500, cursor }));
}

export async function actionOfSubmission(store: RecordStore, submissionRecord: string): Promise<StoredRecord<ActionBody> | null> {
  const page = await store.find<ActionBody>({ key: INDEX.actionSubmission, value: submissionRecord, kind: 'action', limit: 1, newestFirst: true });
  return page.items[0] ?? null;
}
