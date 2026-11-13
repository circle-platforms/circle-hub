import {RunRecord} from '../../contracts/src/run.ts';
import {parseReference} from '../refs/api.ts';
import type { ProducerKind } from '../../contracts/generated/vocabulary.ts';
import type { ContributionLayer } from '../knowledge/api.ts';
// The readers hub/refs resolves references with, built on the records kit for one caller (B02 R[3], R02). Absent and
// forbidden are the same null everywhere; the real reason goes to the admin note through `note`.
import type { RunsService } from '../ports.ts';
import { IntegrityError, disclosedExistence, recordExistence, mayReadRecord, type RecordVisibilityPorts } from '../records/api.ts';
import type { Principal, RecordsKit } from '../records/api.ts';
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

export { runOfRecord } from '../records/api.ts';

/**
 * Records by digest for one caller. Records decides source artifacts for everyone, admins included (a read with a
 * person's own credential is theirs alone, B02 R[3]). Contributions pass the product reader before the admin
 * branch. Admins read the remaining records. A user reads the run, submission, validation result and
 * action records of a run the runs service lets them read (RunsService.getRun); never call logs, authorizations or any
 * other kind (the console and the tools give those views where they are allowed).
 */
export function recordReaderFor(records: RecordsKit, runs: RunsService, principal: Principal, note: (reason: string) => void = () => {}, contributions?: Pick<ContributionLayer, 'read'>): RecordReader {
  const visibility: RecordVisibilityPorts = {
    account: id => records.principals.get(id),
    run: async (by, id) => runs.runHeader !== undefined ? runs.runHeader(by, id) : (await runs.getRun(by, id))?.run ?? null,
    source: (by, record) => records.artifacts.canRead(by, record),
    contribution: async (by, record) => (await contributions?.read(record.digest, by)) != null,
    request: async (by, _run, record) => !runs.requestReadable || await runs.requestReadable(by, record.body as import('../requests/api.ts').RequestBody),
    result: async (by, _run, record) => !runs.resultState || (await runs.resultState(by, record.body as import('../../contracts/src/validation.ts').ValidationResult)).readable,
    submission: async (by, run, record) => {
      const detail = await runs.getRun(by, run.run);
      return detail !== null && detail.submissions.some(row => row.record === record.digest && row.result !== null);
    },
  };
  return {
    async read(digest): Promise<RecordRead | null> {
      const record = await records.store.get(digest);
      if (record === null) {
        note(`record ${digest} does not exist`);
        return null;
      }
      if (!(await mayReadRecord(principal, record, visibility))) {
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
