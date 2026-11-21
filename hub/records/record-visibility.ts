import { isKnowledgeContributionSchema } from '../../contracts/src/contributions.ts';
import { isMemoryRecord } from '../../contracts/src/memory.ts';
import type { RunRecord } from '../../contracts/src/run.ts';
import type { RecordKind } from '../../contracts/generated/protocol.ts';
import type { Principal, SourceArtifact, StoredRecord, User } from './api.ts';
import { canSeeRun, isAdmin } from './permissions.ts';

type Access = 'admin' | 'run' | 'source' | 'dedicated';
export const RECORD_ACCESS = {
  claim: 'admin', source_artifact: 'source', authorization: 'admin', action: 'run', effect: 'admin',
  request: 'run', call_log: 'admin', run: 'run', submission: 'run', validation_result: 'run',
  pack_version: 'admin', tree_node: 'admin', tree_root: 'admin', root_pointer: 'admin',
  knowledge_space_version: 'dedicated', knowledge_space_entry: 'dedicated', knowledge_space_grant: 'dedicated',
  knowledge_space_source: 'dedicated', knowledge_space_quota: 'dedicated', knowledge_share: 'dedicated',
  personal_pack_version: 'dedicated', personal_pack_grant: 'dedicated', personal_pack_retirement: 'dedicated',
  personal_pack_transfer: 'dedicated', memory_document: 'dedicated', memory_version: 'dedicated',
  memory_grant: 'dedicated', memory_share: 'dedicated', knowledge_source_attribution: 'dedicated',
  member_deletion: 'dedicated', knowledge_team_source_attribution: 'dedicated', token_issuance: 'admin', result_summary: 'admin',
} as const satisfies Record<RecordKind, Access>;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
type RecordHeader = Pick<StoredRecord, 'kind' | 'schema' | 'body'>;

export function runOfRecord(record: RecordHeader): string | null {
  const { kind, schema, body } = record;
  const runScoped = Object.hasOwn(RECORD_ACCESS, kind) && RECORD_ACCESS[kind as RecordKind] === 'run';
  if (!runScoped && !(kind === 'claim' && schema === 'hypothesis-set@1') || !object(body)) return null;
  if (typeof body.run === 'string') return body.run;
  if (kind === 'submission' && schema === 'submission-received@1' && object(body.received) && typeof body.received.run === 'string') return body.received.run;
  return null;
}

export interface RecordVisibilityPorts {
  account(id: string): Promise<User | null>;
  run(by: Principal, id: string): Promise<RunRecord | null>;
  source(by: Principal, record: SourceArtifact): Promise<boolean>;
  contribution(by: Principal, record: StoredRecord): Promise<boolean>;
  request(by: Principal, run: RunRecord, record: StoredRecord): Promise<boolean>;
  result(by: Principal, run: RunRecord, record: StoredRecord): Promise<boolean>;
  submission(by: Principal, run: RunRecord, record: StoredRecord): Promise<boolean>;
}

export async function mayReadRecord(by: Principal, record: StoredRecord, ports: RecordVisibilityPorts): Promise<boolean> {
  const account = await ports.account(by.id);
  if (!account || account.disabled || account.deleted_at) return false;
  const access = RECORD_ACCESS[record.kind];
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
