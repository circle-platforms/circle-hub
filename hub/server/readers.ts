import {isMemoryRecord} from '../../contracts/src/memory.ts';
import {RunRecord} from '../../contracts/src/run.ts';
import {parseReference} from '../refs/api.ts';
import type { ProducerKind } from '../../contracts/generated/vocabulary.ts';
import { isKnowledgeContributionSchema } from '../../contracts/src/contributions.ts';
import type { ContributionLayer } from '../knowledge/api.ts';
// The readers hub/refs resolves references with, built on the records kit for one caller (B02 R[3], R02). Absent and
// forbidden are the same null everywhere; the real reason goes to the admin note through `note`.
import { canSeeRun } from '../runs/engine/api.ts';
import type { RunsService } from '../ports.ts';
import { IntegrityError, disclosedExistence, recordExistence } from '../records/api.ts';
import type { Principal, RecordKind, RecordsKit, SourceArtifact, StoredRecord } from '../records/api.ts';
import type { RecordRead, RecordReader, SourceRead, SourceReader } from '../refs/api.ts';
import { step } from '../telemetry/api.ts';

/**
 * A source read of stored bytes for refs: only what the read tier lets through. A withheld source (retain_only) is read
 * with null bytes, so refs answers it with its note (B02 R[4]) by its own rule; absent and forbidden are null, and `exists`
 * tells the two apart.
 */
export function sourceReaderFor(
  records: RecordsKit,
  principal: Principal,
  consumer: Extract<ProducerKind, 'function' | 'model'> = 'function',
  note: (reason: string) => void = () => {},
): SourceReader {
  return {
    read:(sha256, reader): Promise<SourceRead | null> => step('read-source',async()=>{
      const run=reader?.run?(await records.store.find({key:'runs.id',value:reader.run,kind:'run',limit:1})).items[0]:null;const parsed=run?RunRecord.safeParse(run.body):null;const pins=parsed?.success?parsed.data.sources.filter(binding=>{const ref=parseReference(binding.reference);return ref.scheme==='src'&&ref.sha256===sha256&&binding.artifact;}):[];
      const source = pins.length?await records.artifacts.source(principal,sha256,{consumer,record:pins[0].artifact})??(reader?.run?await records.artifacts.sourceForRun(principal,sha256,reader.run,{consumer,record:pins[0].artifact}):null):await records.artifacts.source(principal, sha256, { consumer }) ?? (reader?.run ? await records.artifacts.sourceForRun(principal,sha256,reader.run,{consumer}) : null);
      if (source === null) {
        note(`source ${sha256} is absent or not readable by ${principal.id}`);
        return null;
      }
      if (source.bytes === null && source.readTier !== 'retain_only') {
        note(`source ${sha256} withholds its bytes from consumer ${consumer} (${source.readTier})`);
        throw new IntegrityError('有权来源未返回原件字节');
      }
      return { bytes: source.bytes, mediaType: source.mediaType, size: source.size, readTier: source.readTier };
    },{type:'retriever'}),
    // Whether the Hub holds the source at all, so refs tells absent from forbidden (D05 R[3], decision 112).
    async exists(sha256): Promise<boolean | null> {
      const existence = disclosedExistence(principal.id, await records.artifacts.records(sha256));
      return existence === 'neutral' ? null : existence === 'exists';
    },
  };
}

/** Record kinds that belong to a run: the runs engine's rule (hub/runs/engine/readers.ts). */
const RUN_KINDS: ReadonlySet<string> = new Set<RecordKind>(['run', 'submission', 'validation_result', 'action', 'request']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The run a run-scoped record belongs to. A run, validation result or action names it as `run`; a submission is stored
 * as the arguments received (`run` among them) or, when they are not canonical JSON, as `{received: {object, size,
 * non_canonical_path, run}}` (hub/runs submit.ts). `run` is taken first: a canonical submission's arguments may carry a
 * member named `received` of their own.
 */
export function runOfRecord(kind: string, body: unknown, schema?: string): string | null {
  if (!(kind==='claim'&&schema==='hypothesis-set@1')&&!RUN_KINDS.has(kind) || !isObject(body)) return null;
  if (typeof body.run === 'string') return body.run;
  if (kind === 'submission' && isObject(body.received) && typeof body.received.run === 'string') return body.received.run;
  return null;
}

/**
 * Records by digest for one caller. Records decides source artifacts for everyone, admins included (a read with a
 * person's own credential is theirs alone, B02 R[3]). Contributions pass the product reader before the admin
 * branch. Admins read the remaining records. A user reads the run, submission, validation result and
 * action records of a run the runs service lets them read (RunsService.getRun); never call logs, authorizations or any
 * other kind (the console and the tools give those views where they are allowed).
 */
export function recordReaderFor(records: RecordsKit, runs: RunsService, principal: Principal, note: (reason: string) => void = () => {}, contributions?: Pick<ContributionLayer, 'read'>): RecordReader {
  const mayRead = async (record: StoredRecord): Promise<boolean> => {
    const account = await records.principals.get(principal.id);
    if (account === null || account.disabled) return false;
    // Space manifests may contain directories outside a partial grant; use the path-filtered space API instead.
    if (record.kind==='member_deletion'||record.kind==='knowledge_team_source_attribution'||record.kind==='knowledge_source_attribution'||isMemoryRecord(record)||record.kind.startsWith('knowledge_space_')||record.kind==='knowledge_share'||record.kind.startsWith('personal_pack_')) return false;
    if (record.kind === 'claim' && (isKnowledgeContributionSchema(record.schema)||record.schema==='claim@1'&&isObject(record.body)&&isObject(record.body.statement)&&isObject(record.body.statement.data)&&record.body.statement.data.feeding!==undefined)) return (await contributions?.read(record.digest, account)) != null;
    if (record.kind === 'source_artifact') return records.artifacts.canRead(principal, record as SourceArtifact);
    const run = runOfRecord(record.kind, record.body, record.schema);
    if (run === null) return account.role==='admin';
    const detail = await runs.getRun(account, run);
    if (detail === null) return false;
    if(record.kind==='request'&&runs.requestReadable&&!await runs.requestReadable(account,record.body as import('../requests/api.ts').RequestBody))return false;
    if(record.kind==='validation_result'&&runs.resultState&&!(await runs.resultState(account,record.body as import('../../contracts/src/validation.ts').ValidationResult)).readable)return false;
    if(record.kind==='submission'&&detail.run.runner!==account.id&&!detail.submissions.some(row=>row.record===record.digest&&row.result!==null))return false;
    if(!canSeeRun(account,detail.run)&&(record.kind==='request'||record.kind==='claim'&&record.schema==='hypothesis-set@1'))return false;
    return canSeeRun(account, detail.run) || record.kind !== 'validation_result' || isObject(record.body) && record.body.acceptance === 'accepted';
  };
  return {
    async read(digest): Promise<RecordRead | null> {
      const record = await records.store.get(digest);
      if (record === null) {
        note(`record ${digest} does not exist`);
        return null;
      }
      if (!(await mayRead(record))) {
        note(`record ${digest} (${record.kind}) is not readable by ${principal.id}`);
        return null;
      }
      return { kind: record.kind, schema: record.schema, provenance: record.provenance, created_at: record.created_at, body: record.body };
    },
    async exists(digest): Promise<boolean | null> {
      const stored = await records.store.get(digest);
      const existence = await recordExistence(records.store, principal.id, stored);
      return existence === 'neutral' ? null : existence === 'exists';
    },
  };
}
