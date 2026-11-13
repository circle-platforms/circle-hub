// Generic record reads use one policy registry; domain readers supply their own boundary checks.
import { isKnowledgeContributionSchema } from '../../contracts/src/contributions.ts';
import { isMemoryRecord } from '../../contracts/src/memory.ts';
import type { RunRecord } from '../../contracts/src/run.ts';
import type { RecordKind } from '../../contracts/generated/protocol.ts';
import type { Principal, SourceArtifact, StoredRecord, User } from './api.ts';
import { canSeeRun, isAdmin } from './permissions.ts';

import { RECORD_ACCESS } from './record-kinds.ts';
export { RECORD_ACCESS, type RecordAccess } from './record-kinds.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
type RecordHeader = Pick<StoredRecord, 'kind' | 'schema' | 'body'>;

/** Both existing reader call shapes resolve through the same implementation. */
export function runOfRecord(record: RecordHeader): string | null;
export function runOfRecord(kind: string, body: unknown, schema?: string): string | null;
export function runOfRecord(record: RecordHeader | string, body?: unknown, schema?: string): string | null {
  const kind = typeof record === 'string' ? record : record.kind;
  if (typeof record !== 'string') { body = record.body; schema = record.schema; }
  const runScoped = Object.hasOwn(RECORD_ACCESS, kind) && RECORD_ACCESS[kind as RecordKind].visibility === 'run';
  if (!runScoped && !(kind === 'claim' && schema === 'hypothesis-set@1') || !object(body)) return null;
  if (typeof body.run === 'string') return body.run;
  if (kind === 'submission' && schema === 'submission-received@1' && object(body.received) && typeof body.received.run === 'string') return body.received.run;
  return null;
}

export interface RecordVisibilityPorts {
  account(id: string): Promise<User | null>;
  /** A header only when this caller may read the run, including an explicit read-only share. */
  run(by: Principal, id: string): Promise<RunRecord | null>;
  source(by: Principal, record: SourceArtifact): Promise<boolean>;
  contribution(by: Principal, record: StoredRecord): Promise<boolean>;
  request(by: Principal, run: RunRecord, record: StoredRecord): Promise<boolean>;
  result(by: Principal, run: RunRecord, record: StoredRecord): Promise<boolean>;
  /** A non-runner's submission must have its verified acceptance receipt and readable grounds. */
  submission(by: Principal, run: RunRecord, record: StoredRecord): Promise<boolean>;
}

export async function mayReadRecord(by: Principal, record: StoredRecord, ports: RecordVisibilityPorts): Promise<boolean> {
  const account = await ports.account(by.id);
  if (!account || account.disabled || account.deleted_at) return false;
  const access = RECORD_ACCESS[record.kind].visibility;
  if (access === 'dedicated' || isMemoryRecord(record)) return false;
  if (record.kind === 'claim' && (isKnowledgeContributionSchema(record.schema) || record.schema === 'claim@1' && object(record.body) && object(record.body.statement) && object(record.body.statement.data) && record.body.statement.data.feeding !== undefined)) return ports.contribution(account, record);
  if (access === 'source') return ports.source(account, record as SourceArtifact);
  const id = runOfRecord(record);
  if (id === null) return isAdmin(account);
  const run = await ports.run(account, id);
  if (run === null) return false;
  const owner = canSeeRun(account, run);
  if ((record.kind === 'request' || record.kind === 'claim' && record.schema === 'hypothesis-set@1') && !owner) return false;
  if (record.kind === 'request' && !await ports.request(account, run, record)) return false;
  if (record.kind === 'validation_result') {
    if (!owner && (!object(record.body) || record.body.acceptance !== 'accepted')) return false;
    if (!await ports.result(account, run, record)) return false;
  }
  if (record.kind === 'submission' && run.runner !== account.id && !await ports.submission(account, run, record)) return false;
  return true;
}
