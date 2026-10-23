import type { ContributionLayer } from '../knowledge/api.ts';
// The readers hub/refs resolves references with, built on the records kit for one caller (B02 R[3], R02). Absent and
// forbidden are the same null everywhere; the real reason goes to the admin note through `note`.
import type { RunsService } from '../ports.ts';
import type { Principal, RecordKind, RecordsKit, SourceArtifact, StoredRecord } from '../records/api.ts';
import type { RecordRead, RecordReader, SourceRead, SourceReader } from '../refs/api.ts';

/**
 * A source read of stored bytes for refs: only what the read tier lets through. A withheld source (retain_only) is read
 * with null bytes, so refs answers it with its note (B02 R[4]) by its own rule; absent and forbidden are null.
 */
export function sourceReaderFor(
  records: RecordsKit,
  principal: Principal,
  consumer: 'function' | 'model' = 'function',
  note: (reason: string) => void = () => {},
): SourceReader {
  return {
    async read(sha256): Promise<SourceRead | null> {
      const source = await records.artifacts.source(principal, sha256, { consumer });
      if (source === null) {
        note(`source ${sha256} is absent or not readable by ${principal.id}`);
        return null;
      }
      if (source.bytes === null && source.readTier !== 'retain_only') {
        note(`source ${sha256} withholds its bytes from consumer ${consumer} (${source.readTier})`);
        return null;
      }
      return { bytes: source.bytes, mediaType: source.mediaType, size: source.size, readTier: source.readTier };
    },
  };
}

/**
 * Historical candidate claims stay owner-private. There is no candidate writer in the current Hub;
 * this guard preserves confidentiality of append-only records from the earlier format.
 */
export const CANDIDATE_SCHEMA = 'knowledge-candidate@1';

/** Record kinds that belong to a run: the runs engine's rule (hub/runs/engine/readers.ts). */
const RUN_KINDS: ReadonlySet<string> = new Set<RecordKind>(['run', 'submission', 'validation_result', 'action']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The run a run-scoped record belongs to. A run, validation result or action names it as `run`; a submission is stored
 * as the arguments received (`run` among them) or, when they are not canonical JSON, as `{received: {object, size,
 * non_canonical_path, run}}` (hub/runs submit.ts). `run` is taken first: a canonical submission's arguments may carry a
 * member named `received` of their own.
 */
export function runOfRecord(kind: string, body: unknown): string | null {
  if (!RUN_KINDS.has(kind) || !isObject(body)) return null;
  if (typeof body.run === 'string') return body.run;
  if (kind === 'submission' && isObject(body.received) && typeof body.received.run === 'string') return body.received.run;
  return null;
}

/**
 * Records by digest for one caller. Records decides source artifacts for everyone, admins included (a read with a
 * person's own credential is theirs alone, B02 R[3]); a candidate of the knowledge candidate layer is its owner's alone,
 * admins included (historical R02, K03 R[4]). Contributions pass the product reader before the admin
 * branch. Admins read the remaining records. A user reads the run, submission, validation result and
 * action records of a run the runs service lets them read (RunsService.getRun); never call logs, authorizations or any
 * other kind (the console and the tools give those views where they are allowed).
 */
export function recordReaderFor(records: RecordsKit, runs: RunsService, principal: Principal, note: (reason: string) => void = () => {}, contributions?: Pick<ContributionLayer, 'read'>): RecordReader {
  const mayRead = async (record: StoredRecord): Promise<boolean> => {
    const account = await records.principals.get(principal.id);
    if (account === null || account.disabled) return false;
    if (record.kind === 'claim' && record.schema === 'knowledge-contribution@1') return (await contributions?.read(record.digest, account)) != null;
    if (record.kind === 'source_artifact') return records.artifacts.canRead(principal, record as SourceArtifact);
    if (record.kind === 'claim' && record.schema === CANDIDATE_SCHEMA) {
      return isObject(record.body) && typeof record.body.owner === 'string' && record.body.owner === account.id;
    }
    if (account.role === 'admin') return true;
    const run = runOfRecord(record.kind, record.body);
    return run !== null && (await runs.getRun(principal, run)) !== null;
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
