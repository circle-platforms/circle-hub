import {RunRecord} from '../../contracts/src/run.ts';
import {parseReference} from '../refs/api.ts';
import type { ProducerKind } from '../../contracts/generated/vocabulary.ts';
import { isKnowledgeContributionSchema } from '../../contracts/src/contributions.ts';
import type { ContributionLayer } from '../knowledge/api.ts';
// The readers hub/refs resolves references with, built on the records kit for one caller (B02 R[3], R02). Absent and
// forbidden are the same null everywhere; the real reason goes to the admin note through `note`.
import { canSeeRun } from '../runs/engine/api.ts';
import type { RunsService } from '../ports.ts';
import { IntegrityError } from '../records/api.ts';
import type { Principal, RecordKind, RecordsKit, SourceArtifact, StoredRecord } from '../records/api.ts';
import type { RecordRead, RecordReader, SourceRead, SourceReader } from '../refs/api.ts';

/**
 * A source read of stored bytes for refs: only what the read tier lets through. A withheld source (retain_only) is read
 * with null bytes, so refs answers it with its note (B02 R[4]) by its own rule; absent and forbidden are null.
 */
export function sourceReaderFor(
  records: RecordsKit,
  principal: Principal,
  consumer: Extract<ProducerKind, 'function' | 'model'> = 'function',
  note: (reason: string) => void = () => {},
): SourceReader {
  return {
    async read(sha256, reader): Promise<SourceRead | null> {
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
    if (record.kind === 'claim' && (isKnowledgeContributionSchema(record.schema)||record.schema==='claim@1'&&isObject(record.body)&&isObject(record.body.statement)&&isObject(record.body.statement.data)&&record.body.statement.data.feeding!==undefined)) return (await contributions?.read(record.digest, account)) != null;
    if (record.kind === 'source_artifact') return records.artifacts.canRead(principal, record as SourceArtifact);
    if (account.role === 'admin') return true;
    const run = runOfRecord(record.kind, record.body, record.schema);
    if (run === null) return false;
    const detail = await runs.getRun(account, run);
    if (detail === null) return false;
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
  };
}
