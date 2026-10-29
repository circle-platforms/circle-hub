import type { ContributionLayer } from '../../knowledge/api.ts';
import { isKnowledgeContributionSchema } from '../../../contracts/src/contributions.ts';
// Visibility (R02) and the readers hub/refs resolves references with. A user sees their own runs; an admin sees every run;
// a run the Hub executes itself is shown to admins only (W06 R[3]). Records reach a reader only through the run they belong
// to; absent and forbidden give the same null.
import type { ProducerKind } from '../../../contracts/generated/vocabulary.ts';
import {parseReference} from '../../refs/api.ts';
import type {SourceBinding} from '../../../contracts/src/run.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { requestRead, runIsSharedWith } from '../../records/api.ts';
import type { Artifacts, Principal, RecordStore } from '../../records/api.ts';
import type { ReaderIdentity, RecordReader, SourceReader } from '../../refs/api.ts';
import { SCHEMAS, runById } from './store.ts';
import { isObject } from './util.ts';

export function canSeeRun(user: Principal, run: Pick<RunRecord, 'runner' | 'host'>): boolean {
  if (user.role === 'admin') return true;
  if (run.host === 'hub') return false;
  return run.runner !== undefined && run.runner === user.id;
}

/** Read-only sharing never changes canSeeRun, the submission and lineage guard. */
export async function canViewRun(user: Principal, run: RunRecord, store: RecordStore): Promise<boolean> {
  return canSeeRun(user, run) || await runIsSharedWith(store, user.id, run);
}

export function identityOf(user: Principal, run?: string): ReaderIdentity {
  return run === undefined ? { user: user.id, role: user.role } : { user: user.id, role: user.role, run };
}

export function principalOf(reader: ReaderIdentity): Principal {
  return { id: reader.user, name: reader.user, role: reader.role };
}

/** Preserve retained metadata and unexpected function-read failures; model-only byte withholding stays neutral. */
export function sourceReader(artifacts: Artifacts, consumer: ProducerKind,bindings?:readonly SourceBinding[]): SourceReader {
  return {
    async read(sha256, reader) {
      const pins=[...new Set((bindings??[]).flatMap(binding=>{const ref=parseReference(binding.reference);return ref.scheme==='src'&&ref.sha256===sha256&&binding.artifact?[binding.artifact]:[];}))];
      return requestRead(reader.user,JSON.stringify([consumer,sha256,reader.role,reader.run??null,pins[0]??null]),async()=>{
        const source = pins.length?await artifacts.source(principalOf(reader),sha256,{consumer,record:pins[0]})??(reader.run?await artifacts.sourceForRun(principalOf(reader),sha256,reader.run,{consumer,record:pins[0]}):null):await artifacts.source(principalOf(reader), sha256, { consumer }) ?? (reader.run ? await artifacts.sourceForRun(principalOf(reader),sha256,reader.run,{consumer}) : null);
        if (source === null || consumer === 'model' && source.bytes === null && source.readTier !== 'retain_only') return null;
        const scan=source.artifact?.body?.scan;
        // Accepted findings can come from a different capture of the same bytes, so never cache them as clean.
        const cacheable=source.acceptance===undefined&&scan?.inspected===true&&!scan.truncated&&scan.findings.length===0;
        return { bytes: source.bytes, mediaType: source.mediaType, size: source.size, readTier: source.readTier, cacheable };
      },source=>source?.cacheable ? source.bytes?.byteLength??0 : -1);
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
  if (!(kind==='claim'&&schema==='hypothesis-set@1') && kind !== 'run' && kind !== 'validation_result' && kind !== 'submission' && kind !== 'action' && kind !== 'request') return null;
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
      if (record.kind === 'claim' && (isKnowledgeContributionSchema(record.schema)||record.schema==='claim@1'&&isObject(record.body)&&isObject(record.body.statement)&&isObject(record.body.statement.data)&&record.body.statement.data.feeding!==undefined)) {
        if ((await contributions?.read(digest, principalOf(reader))) == null) return null;
      } else if (reader.role !== 'admin') {
        const run = runOfRecord(record);
        if (run === null) return null;
        const owner = record.kind === 'run' ? (record.body as RunRecord) : (await runById(store, run))?.body;
        if (owner === undefined || !await canViewRun(principalOf(reader), owner, store)) return null;
        if (!canSeeRun(principalOf(reader),owner)&&(record.kind==='request'||record.kind==='claim'&&record.schema==='hypothesis-set@1'))return null;
        if (!canSeeRun(principalOf(reader), owner) && record.kind === 'validation_result' && (!isObject(record.body) || record.body.acceptance !== 'accepted')) return null;
      }
      return { kind: record.kind, schema: record.schema, provenance: record.provenance, created_at: record.created_at, body: record.body };
    },
  };
}
