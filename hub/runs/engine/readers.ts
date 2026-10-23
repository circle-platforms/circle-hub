import type { ContributionLayer } from '../../knowledge/api.ts';
import { isKnowledgeContributionSchema } from '../../../contracts/src/contributions.ts';
// Visibility (R02) and the readers hub/refs resolves references with. A user sees their own runs; an admin sees every run;
// a run the Hub executes itself is shown to admins only (W06 R[3]). Records reach a reader only through the run they belong
// to; absent and forbidden give the same null.
import type { ProducerKind } from '../../../contracts/generated/vocabulary.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { Artifacts, Principal, RecordStore } from '../../records/api.ts';
import type { ReaderIdentity, RecordReader, SourceReader } from '../../refs/api.ts';
import { SCHEMAS, runById } from './store.ts';
import { isObject } from './util.ts';

export function canSeeRun(user: Principal, run: Pick<RunRecord, 'runner' | 'host'>): boolean {
  if (user.role === 'admin') return true;
  if (run.host === 'hub') return false;
  return run.runner !== undefined && run.runner === user.id;
}

export function identityOf(user: Principal, run?: string): ReaderIdentity {
  return run === undefined ? { user: user.id, role: user.role } : { user: user.id, role: user.role, run };
}

export function principalOf(reader: ReaderIdentity): Principal {
  return { id: reader.user, name: reader.user, role: reader.role };
}

/** Preserve retain-only metadata so refs can disclose the credential restriction without bytes. */
export function sourceReader(artifacts: Artifacts, consumer: ProducerKind): SourceReader {
  return {
    async read(sha256, reader) {
      const source = await artifacts.source(principalOf(reader), sha256, { consumer });
      if (source === null || (source.bytes === null && source.readTier !== 'retain_only')) return null;
      return { bytes: source.bytes, mediaType: source.mediaType, size: source.size, readTier: source.readTier };
    },
  };
}

/**
 * The run a stored record belongs to, when it is one of the engine's kinds. A submission names the run it was stored for at
 * its top level: the engine stores arguments only after finding the run their `run` names, so raw arguments always carry it
 * there, whatever else they hold. Only the engine's own wrapper of arguments canonical JSON cannot carry (store.ts,
 * VerbatimObjectBody) has no top-level `run`; it names the run inside `received`.
 */
export function runOfRecord(record: { kind: string; schema: string; body: unknown }): string | null {
  const { kind, schema, body } = record;
  if (!isObject(body)) return null;
  if (kind !== 'run' && kind !== 'validation_result' && kind !== 'submission' && kind !== 'action') return null;
  if (typeof body.run === 'string') return body.run;
  if (kind === 'submission' && schema === SCHEMAS.received && isObject(body.received) && typeof body.received.run === 'string') return body.received.run;
  return null;
}

/** Records for reference resolution: run, submission, validation result and action records through their run; contributions through their product. */
export function recordReader(store: RecordStore, contributions?: Pick<ContributionLayer, 'read'>): RecordReader {
  return {
    async read(digest, reader) {
      const record = await store.get(digest);
      if (record === null) return null;
      if (record.kind === 'claim' && isKnowledgeContributionSchema(record.schema)) {
        if ((await contributions?.read(digest, principalOf(reader))) == null) return null;
      } else if (reader.role !== 'admin') {
        const run = runOfRecord(record);
        if (run === null) return null;
        const owner = record.kind === 'run' ? (record.body as RunRecord) : (await runById(store, run))?.body;
        if (owner === undefined || !canSeeRun(principalOf(reader), owner)) return null;
      }
      return { kind: record.kind, schema: record.schema, provenance: record.provenance, created_at: record.created_at, body: record.body };
    },
  };
}
